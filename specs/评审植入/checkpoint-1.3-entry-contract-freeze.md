# 检查点A — 入口契约冻结记录（Task 1.3）

- taskId: 1.3
- taskName: 检查点A-入口契约冻结
- stage: 入口层检查（阶段内记录）
- timestamp: 2026-08-03T17:30:57Z
- dependsOn: [1.1, 1.2]
- requirementIds: [Req-1, Req-4]
- propertyIds: [INV-1, INV-2, INV-10]

---

## 1. 检查目标

验证任务 1.2 输出的消息契约与路由实现是否与设计文档中 API-1、ROUTE-1、ROUTE-3 的边界声明完全一致；确认无需求外新增能力；确认可进入阶段 2（模板解析与自定义配置）。

---

## 2. 入口契约一致性检查

### 2.1 消息类型定义（apps/src/harnessMessages.ts）

| 检查项 | 设计要求 | 实际产物 | 结论 |
|--------|---------|---------|------|
| `ReviewStage` 枚举 | `requirements \| design \| testcase` | `export type ReviewStage = 'requirements' \| 'design' \| 'testcase'` | ✅ 一致 |
| `ReviewPromptSource` 枚举 | `custom \| default` | `export type ReviewPromptSource = 'custom' \| 'default'` | ✅ 一致 |
| `ReviewExecutionStatus` 枚举 | `idle \| running \| completed \| failed` | `export type ReviewExecutionStatus = 'idle' \| 'running' \| 'completed' \| 'failed'` | ✅ 一致 |
| `StageReviewOpenResult` | `reviewEnabled: true; defaultExecuted: false` | `interface StageReviewOpenResult { reviewEnabled: true; defaultExecuted: false; }` | ✅ 一致（API-1 响应结构） |
| `ROUTE-1` 消息 `openStageReview` | `stage: ReviewStage` | `{ type: 'openStageReview'; stage: ReviewStage }` 已纳入 `HarnessMessage` union | ✅ 一致 |
| `ROUTE-3` 消息 `runStageReview` | `stage: ReviewStage; context: StageContext` | `{ type: 'runStageReview'; stage: ReviewStage; context: StageContext }` 已纳入 `HarnessMessage` union | ✅ 一致 |
| `ROUTE-2` 消息 `saveStagePrompt` | `stage: ReviewStage; promptBody: string` | `{ type: 'saveStagePrompt'; stage: ReviewStage; promptBody: string }` 已纳入 `HarnessMessage` union | ✅ 一致 |
| `ROUTE-4` 消息 `getLatestReviewStatus` | `stage: ReviewStage` | `{ type: 'getLatestReviewStatus'; stage: ReviewStage }` 已纳入 `HarnessMessage` union | ✅ 一致 |

### 2.2 控制器实现（apps/src/harnessMessageController.ts）

| 检查项 | 设计要求 | 实际产物 | 结论 |
|--------|---------|---------|------|
| `HarnessMessageControllerDeps#openStageReview` | 可选依赖注入 | `openStageReview?: (stage: ReviewStage) => Promise<void>` | ✅ 一致 |
| `HarnessMessageControllerDeps#runStageReview` | 可选依赖注入 | `runStageReview?: (stage: ReviewStage, context: ...) => Promise<void>` | ✅ 一致 |
| 非法阶段处理 | 拒绝执行，返回可理解失败，不阻断主流程 | `ensureReviewStage()` 返回 `false` + `showWarningMessage` + 提前 `return`（不 throw） | ✅ 满足 INV-10 / Req-4 |
| 入口默认不自动执行评审 | `defaultExecuted: false`，触发后仅分发，不自动 run | `openStageReview` handler 仅调用 `deps.openStageReview?.(msg.stage)`，不触发 `runStageReview` | ✅ 满足 INV-1 / Req-1 |
| worktree 白名单 | 四条评审消息均在子 worktree 允许列表中 | `case 'openStageReview': case 'saveStagePrompt': case 'runStageReview': case 'getLatestReviewStatus':` 均已加入 worktree allowlist | ✅ 一致 |

### 2.3 API-1 边界核查（Req-1）

- ROUTE-1 (`openStageReview`) 入口消息 → `HarnessMessageController#openStageReview` handler → 调用 `deps.openStageReview?.(stage)` 委托。
- 链路完整，入口消息字段 (`stage`) 与 API-1 request 完全一致。
- 响应结构 `StageReviewOpenResult` (`reviewEnabled: true, defaultExecuted: false`) 已在 `harnessMessages.ts` 冻结。
- **结论：API-1 / ROUTE-1 边界一致 ✅**

### 2.4 ROUTE-3 边界核查（Req-2, Req-3, Req-4）

- `runStageReview` 消息携带 `stage` 和 `context`，与 API-4 request 字段对齐。
- controller 在调用前先执行 `ensureReviewStage` 校验，非法阶段不下发到执行层。
- 失败时通过 `showWarningMessage` 反馈，不抛出异常，不阻断主流程消息链。
- **结论：ROUTE-3 边界一致 ✅**

---

## 3. 无需求外新增能力检查

| 检查项 | 结论 |
|--------|------|
| `harnessMessages.ts` 新增类型是否全部绑定 Req-* | ✅ 全部对应 Req-1..Req-4 |
| `HarnessMessage` union 新增成员是否均来自 ROUTE-1..ROUTE-4 | ✅ 仅 4 条评审消息，无额外扩展 |
| `harnessMessageController.ts` 新增方法是否全部绑定 Req-* | ✅ `isReviewStage`、`ensureReviewStage` 均服务于 Req-1/Req-4 边界校验 |
| 主流程既有消息/处理器是否被修改 | ✅ 未修改，保持向后兼容 |

**HC-04 变更边界：通过 ✅**

---

## 4. 不变量符合性确认

| 不变量 | 检查点 | 结论 |
|--------|--------|------|
| INV-1：三阶段入口可见且默认不触发执行 | `openStageReview` handler 不自动调用 `runStageReview` | ✅ |
| INV-2：未点击评审时主流程推进链路不受影响 | 评审消息处理独立，不写入阻断门禁 | ✅ |
| INV-10：评审状态不参与主流程推进门禁 | 非法阶段仅 warning + return，不 throw，不改变主流程可达性 | ✅ |

---

## 5. 阻断项

无阻断项。

---

## 6. 结论与放行

| 项目 | 结论 |
|------|------|
| API-1 / ROUTE-1 边界一致性 | ✅ 通过 |
| ROUTE-3 边界一致性 | ✅ 通过 |
| 无需求外新增能力（HC-04） | ✅ 通过 |
| 追溯闭环（Req-1, Req-4 → API/ROUTE/INV） | ✅ 通过 |
| 可进入下一阶段（2.1 通用模板分阶段解析） | ✅ **放行** |

---

## 机器可读区

```yaml
artifactType: checkpoint
taskId: "1.3"
taskName: 检查点A-入口契约冻结
status: passed
timestamp: "2026-08-03T17:30:57Z"
dependsOn: ["1.1", "1.2"]
requirementIds: [Req-1, Req-4]
propertyIds: [INV-1, INV-2, INV-10]
checks:
  - id: CHK-1.3-01
    target: API-1 / ROUTE-1 boundary consistency
    result: passed
  - id: CHK-1.3-02
    target: ROUTE-3 boundary consistency
    result: passed
  - id: CHK-1.3-03
    target: No requirement-undriven capabilities (HC-04)
    result: passed
  - id: CHK-1.3-04
    target: Traceability closure (Req-1, Req-4)
    result: passed
nextTask: "2.1"
```
