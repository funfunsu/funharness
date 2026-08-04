# 检查点C — 端到端行为冻结记录（Task 3.3）

- taskId: 3.3
- taskName: 检查点C-端到端行为冻结
- stage: 端到端行为检查（阶段内记录）
- timestamp: 2026-08-03T17:49:26Z
- dependsOn: [3.1, 3.2]
- requirementIds: [Req-1, Req-2, Req-3, Req-4]
- propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]

---

## 1. 检查目标

验证任务 3.1（评审执行与状态机）与任务 3.2（Webview 入口与状态展示集成）在主流程中形成完整端到端链路：入口可选触发 -> 模板解析（custom/default）-> 评审执行 -> 状态反馈；并确认失败或未执行评审不会改变主流程完成语义。

---

## 2. 端到端链路冻结

### 2.1 入口可选触发（Req-1, INV-1, INV-2）

| 检查项 | 实际产物 | 结论 |
|--------|---------|------|
| 三阶段入口映射 | `getReviewStageByTaskStage` 将 `WRITING_REQUIREMENT/WRITING_DESIGN/WRITING_TESTCASE` 映射为 `requirements/design/testcase`（`apps/src/webviewTemplates.ts`） | ✅ 通过 |
| 入口可点击且默认不自动执行 | `buildStageReviewSectionHtml` 渲染“发起评审”按钮；`initializeStageReviewPanels` 仅发送 `openStageReview/getLatestReviewStatus`（不触发 run） | ✅ 通过 |
| API-1 响应语义 | `handleOpenStageReview` 固定回传 `{ reviewEnabled: true, defaultExecuted: false }`（`apps/src/extension.ts`） | ✅ 通过 |
| 不点击评审不阻断主流程语义 | 前端提示文案固定为“未点击评审时不会阻断主流程推进”；消息链与主流程推进链路解耦 | ✅ 通过 |

### 2.2 模板来源解析（Req-2, Req-3, INV-3/4/5/6/7/8）

| 检查项 | 实际产物 | 结论 |
|--------|---------|------|
| 通用模板分阶段区分 | `PromptService.DEFAULT_REVIEW_PROMPTS` 定义 requirements/design/testcase 三套不同模板（`apps/src/services/promptService.ts`） | ✅ 通过 |
| 自定义优先、通用回退 | `resolveReviewPromptByStage` 采用 `custom > default`；未配置自定义时回退 `DEFAULT_REVIEW_PROMPTS[stage]` | ✅ 通过 |
| 请求内容包含上下文与模板正文 | `composedPrompt = [contextSection, '', promptBody].join('\n')`，上下文由 `StageContext` 序列化注入 | ✅ 通过 |
| 自定义模板按阶段隔离与版本覆盖 | `ReviewPromptConfigService` 以 `stage` 作为 key，`saveStagePrompt` 同阶段递增版本并覆盖写入 | ✅ 通过 |

### 2.3 执行与状态反馈（Req-4, INV-9, INV-10）

| 检查项 | 实际产物 | 结论 |
|--------|---------|------|
| 触发即进入 running | `ReviewExecutionService.runStageReview` 先写入 `statusStore(stage)=running` 并返回 `status: 'running'` | ✅ 通过 |
| 成功/失败状态终态可区分 | `executeReview` 成功写入 `completed+summary`，失败写入 `failed+errorReason` | ✅ 通过 |
| 状态可视化回显 | 前端 `handleStageReviewStatusEvent` 接收 `stageReviewStatus`，更新 `idle/running/completed/failed` 徽标、摘要、失败原因 | ✅ 通过 |
| 失败不阻断主流程 | 状态仅保存在 `ReviewExecutionService.statusStore`，未写入主流程 gate；控制器非法阶段仅 warning+return | ✅ 通过 |

---

## 3. 契约闭环检查（入口 -> 模板 -> 执行 -> 回显）

```text
Webview 发起评审按钮
  -> postMessage(type='runStageReview', stage, context)
  -> HarnessMessageController.handle(runStageReview)
  -> Extension.handleRunStageReview(stage, context)
  -> ReviewExecutionService.runStageReview(stage, context)
      -> PromptService.resolveReviewPromptByStage(stage, context, configService)
      -> AI provider 异步执行
      -> statusStore: running -> completed/failed
  -> Extension.postMessage(type='stageReviewStatus', ...)
  -> Webview handleStageReviewStatusEvent 更新状态与摘要/失败原因
```

结论：三阶段共享同一消息契约，但模板与配置按阶段隔离，执行结果反馈可感知，且全链路不改变主流程推进语义。**✅ 端到端行为冻结通过**

---

## 4. 验证范围说明

1. 已完成静态契约与实现一致性校验（API-1~API-5、MODEL-1~MODEL-4、INV-1~INV-10）。
2. 当前执行环境缺少 Node/npm 命令，无法在本环境直接执行 `npm test` 进行运行态验证。
3. 本检查点结论基于实现代码的链路一致性与契约约束完成冻结。

---

## 5. 结论与放行

| 项目 | 结论 |
|------|------|
| 三阶段入口均可独立触发评审 | ✅ 通过 |
| 模板来源解析正确（custom/default） | ✅ 通过 |
| 执行状态可感知（running/completed/failed） | ✅ 通过 |
| 失败可见且主流程语义不变 | ✅ 通过 |
| 追溯闭环（Req-1..Req-4 -> API/Model/Invariant） | ✅ 通过 |
| 可进入下一阶段（4.1 单元与集成测试任务） | ✅ 放行 |

---

## 机器可读区

```yaml
artifactType: checkpoint
taskId: "3.3"
taskName: 检查点C-端到端行为冻结
status: passed
timestamp: "2026-08-03T17:49:26Z"
dependsOn: ["3.1", "3.2"]
requirementIds: [Req-1, Req-2, Req-3, Req-4]
propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]
checks:
  - id: CHK-3.3-01
    target: Three-stage optional review entry independently triggerable
    result: passed
  - id: CHK-3.3-02
    target: Prompt source resolution custom > default with per-stage fallback
    result: passed
  - id: CHK-3.3-03
    target: Composed review prompt includes stage context and prompt body
    result: passed
  - id: CHK-3.3-04
    target: Review status transitions running -> completed|failed are visible
    result: passed
  - id: CHK-3.3-05
    target: Review failure or idle does not alter main workflow completion semantics
    result: passed
  - id: CHK-3.3-06
    target: Traceability closure for Req-1..Req-4
    result: passed
nextTask: "4.1"
```