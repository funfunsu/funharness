# 检查点B — 模板解析契约冻结记录（Task 2.3）

- taskId: 2.3
- taskName: 检查点B-模板解析契约冻结
- stage: 模板层检查（阶段内记录）
- timestamp: 2026-08-03T17:41:02Z
- dependsOn: [2.1, 2.2]
- requirementIds: [Req-2, Req-3]
- propertyIds: [INV-3, INV-5, INV-6, INV-7, INV-8]

---

## 1. 检查目标

验证任务 2.1（通用模板分阶段解析与回退）和任务 2.2（自定义模板配置与版本覆盖）的实现产物是否与设计文档中 API-2、API-3、MODEL-1、MODEL-2 的契约声明完全一致；确认 custom > default 优先级稳定；确认阶段间隔离稳定；确认可进入阶段 3（评审执行与状态机）。

---

## 2. 模板解析契约一致性检查

### 2.1 API-2：PromptService#resolveReviewPromptByStage

| 检查项 | 设计要求 | 实际产物 | 结论 |
|--------|---------|---------|------|
| 方法签名 | `resolveReviewPromptByStage(stage: ReviewStage, context: StageContext): StageReviewPromptResult` | `resolveReviewPromptByStage(stage, context, configService?)` 在 `apps/src/services/promptService.ts:469` | ✅ 一致 |
| 返回字段 `source` | `'custom' \| 'default'` | `const source = hasCustom ? 'custom' : 'default'` | ✅ 一致 |
| 返回字段 `promptBody` | `string`（自定义或通用模板正文） | `hasCustom ? customPrompt! : PromptService.DEFAULT_REVIEW_PROMPTS[stage]` | ✅ 一致 |
| 返回字段 `composedPrompt` | 包含阶段上下文与模板正文 | `[contextSection, '', promptBody].join('\n')` | ✅ 一致（INV-4） |
| 无自定义时回退 default | 必须回退该阶段通用模板 | `const hasCustom = ... && customPrompt.trim().length > 0`；为 false 时使用 `DEFAULT_REVIEW_PROMPTS[stage]` | ✅ 满足 INV-3 |
| 有自定义时不回退 default | `promptSource === 'custom'`，请求不得回退 | `hasCustom` 为 true 时 `source = 'custom'`，`promptBody = customPrompt` | ✅ 满足 INV-6 |
| configService 可选参数 | 未传入时行为等价于无自定义配置 | `configService?.getStagePrompt(stage)` 使用可选链；未传入时 `customPrompt = undefined`，回退 default | ✅ 健壮性满足 INV-3 |

### 2.2 API-3：ReviewPromptConfigService#saveStagePrompt

| 检查项 | 设计要求 | 实际产物 | 结论 |
|--------|---------|---------|------|
| 方法签名 | `saveStagePrompt(stage: ReviewStage, promptBody: string): StageReviewSaveResult` | `saveStagePrompt(stage, promptBody): StageReviewSaveResult` 在 `apps/src/services/reviewPromptConfigService.ts:65` | ✅ 一致 |
| 返回字段 `savedVersion` | `number` | `const version = existing ? existing.version + 1 : 1` | ✅ 一致 |
| 返回字段 `updatedAt` | `string`（ISO 时间戳） | `new Date().toISOString()` | ✅ 一致 |
| 同阶段覆盖写入（last-write-wins） | 新保存版本覆盖旧版本 | `this.store.set(stage, { ..., version, updatedAt })` 覆盖写入 | ✅ 满足 INV-7 |
| 版本号单调递增 | `savedVersion` 递增 | `existing ? existing.version + 1 : 1` | ✅ 满足 INV-7 |
| 仅影响目标阶段 | 其他阶段配置不受影响 | store 以 `stage` 为键，仅调用 `this.store.set(stage, ...)` | ✅ 满足 INV-8 |

### 2.3 读取契约：ReviewPromptConfigService#getStagePrompt

| 检查项 | 设计要求 | 实际产物 | 结论 |
|--------|---------|---------|------|
| 无配置时返回 `undefined` | 回退到 default | `return this.store.get(stage)?.customPrompt` | ✅ 未配置返回 `undefined` |
| 配置存在时返回最新版本 | 返回上次 `saveStagePrompt` 的值 | 读取 `this.store.get(stage)?.customPrompt`，store 内已是最新 | ✅ 满足 INV-7 |
| 按阶段独立读取 | 阶段 A 配置不影响阶段 B | 以 `stage` 为键查找，无跨阶段引用 | ✅ 满足 INV-8 |

---

## 3. 数据模型契约检查

### 3.1 MODEL-1：StageReviewPromptConfig（Req-3）

| 字段 | 设计要求 | 实际产物（reviewPromptConfigService.ts） | 结论 |
|------|---------|----------------------------------------|------|
| `stage` | `enum(requirements\|design\|testcase)` | `stage: ReviewStage` | ✅ 类型绑定 |
| `customPrompt` | `string` | `customPrompt: string` | ✅ 一致 |
| `version` | `number` | `version: number` | ✅ 一致 |
| `updatedAt` | `string` | `updatedAt: string` | ✅ 一致 |
| 跨阶段复用禁止 | `stage` 必须为三枚举值之一 | `ReviewStage` 类型约束；store 键为 `ReviewStage` | ✅ 结构防止跨阶段复用 |

### 3.2 MODEL-2：StageReviewTemplateSet（Req-2）

| 字段 | 设计要求 | 实际产物（promptService.ts） | 结论 |
|------|---------|------------------------------|------|
| `stage` | `enum(requirements\|design\|testcase)` | `DEFAULT_REVIEW_PROMPTS` 以 `Record<ReviewStage, string>` 定义 | ✅ 一致 |
| `defaultPrompt` | `string`，按阶段区分 | `requirements`/`design`/`testcase` 各有独立模板内容 | ✅ 一致 |
| 三阶段模板可区分（INV-5） | 三者内容不同，不共用同一未分阶段模板 | `requirements`：以"需求评审模板"为标题；`design`：以"设计评审模板"为标题；`testcase`：以"测试用例评审模板"为标题 | ✅ 满足 INV-5 |

---

## 4. 模板优先级与回退规则检查

### 4.1 优先级链路（custom > default）

```
resolveReviewPromptByStage(stage, context, configService)
  │
  ├─ configService.getStagePrompt(stage) → customPrompt: string | undefined
  │
  ├─ hasCustom = customPrompt?.trim().length > 0
  │
  ├─ YES → source='custom',  promptBody=customPrompt         [INV-6]
  └─ NO  → source='default', promptBody=DEFAULT_REVIEW_PROMPTS[stage] [INV-3]
```

- 优先级规则：custom > default，无跳级，无模糊判断。**✅ 稳定**

### 4.2 阶段隔离链路

```
saveStagePrompt(stageA, body)  →  store.set(stageA, config)
getStagePrompt(stageA)         →  store.get(stageA)?.customPrompt
getStagePrompt(stageB)         →  store.get(stageB)?.customPrompt  ← 独立，不受 stageA 影响
```

- 阶段间无共享状态，store 键严格按 `ReviewStage` 隔离。**✅ 稳定（INV-8）**

### 4.3 版本覆盖规则

```
saveStagePrompt(stage, bodyV1)  →  version=1
saveStagePrompt(stage, bodyV2)  →  version=2  (last-write-wins, 覆盖 V1)
getStagePrompt(stage)           →  bodyV2     (使用最新版本)
```

- 同阶段多次保存，版本单调递增，最新版本生效。**✅ 稳定（INV-7）**

---

## 5. 无需求外新增能力检查

| 检查项 | 结论 |
|--------|------|
| `PromptService` 新增方法是否全部绑定 Req-* | ✅ `resolveReviewPromptByStage` 绑定 Req-2, Req-3；`DEFAULT_REVIEW_PROMPTS` 绑定 Req-2 |
| `ReviewPromptConfigService` 是否仅实现 API-3 要求的能力 | ✅ 仅含 `saveStagePrompt` / `getStagePrompt` / 持久化逻辑，无额外扩展 |
| MODEL-1、MODEL-2 字段是否均有对应 Req-* | ✅ 全部对应 Req-2、Req-3 |
| 既有服务是否被无关修改 | ✅ 未修改其他服务，向后兼容 |

**HC-04 变更边界：通过 ✅**

---

## 6. 不变量符合性确认

| 不变量 | 检查点 | 结论 |
|--------|--------|------|
| INV-3：无自定义时必须返回阶段 defaultPrompt | `hasCustom` 为 false 时 `promptBody = DEFAULT_REVIEW_PROMPTS[stage]` | ✅ |
| INV-5：三阶段 defaultPrompt 互相可区分 | 三者标题与评审维度均不同 | ✅ |
| INV-6：有自定义时 `promptSource` 必须为 `custom` | `hasCustom` 为 true 时 `source = 'custom'` | ✅ |
| INV-7：自定义更新后下次评审使用最新版本 | `saveStagePrompt` last-write-wins + `getStagePrompt` 读取最新 | ✅ |
| INV-8：阶段 A 自定义不影响阶段 B | store 以 `stage` 为键，读写均按 stage 隔离 | ✅ |

---

## 7. 阻断项

无阻断项。

---

## 8. 结论与放行

| 项目 | 结论 |
|------|------|
| API-2 契约一致性（PromptService#resolveReviewPromptByStage） | ✅ 通过 |
| API-3 契约一致性（ReviewPromptConfigService#saveStagePrompt） | ✅ 通过 |
| MODEL-1 字段完整性（StageReviewPromptConfig） | ✅ 通过 |
| MODEL-2 字段完整性与三阶段可区分（StageReviewTemplateSet） | ✅ 通过 |
| custom > default 优先级稳定（INV-6, INV-3） | ✅ 通过 |
| 阶段间隔离稳定（INV-8） | ✅ 通过 |
| 版本覆盖规则稳定（INV-7） | ✅ 通过 |
| 无需求外新增能力（HC-04） | ✅ 通过 |
| 追溯闭环（Req-2, Req-3 → API/MODEL/INV） | ✅ 通过 |
| 可进入下一阶段（3.1 评审执行与状态机） | ✅ **放行** |

---

## 机器可读区

```yaml
artifactType: checkpoint
taskId: "2.3"
taskName: 检查点B-模板解析契约冻结
status: passed
timestamp: "2026-08-03T17:41:02Z"
dependsOn: ["2.1", "2.2"]
requirementIds: [Req-2, Req-3]
propertyIds: [INV-3, INV-5, INV-6, INV-7, INV-8]
checks:
  - id: CHK-2.3-01
    target: API-2 contract consistency (PromptService#resolveReviewPromptByStage)
    result: passed
  - id: CHK-2.3-02
    target: API-3 contract consistency (ReviewPromptConfigService#saveStagePrompt)
    result: passed
  - id: CHK-2.3-03
    target: MODEL-1 field completeness (StageReviewPromptConfig)
    result: passed
  - id: CHK-2.3-04
    target: MODEL-2 field completeness and three-stage distinctness (StageReviewTemplateSet)
    result: passed
  - id: CHK-2.3-05
    target: custom > default priority stable (INV-6, INV-3)
    result: passed
  - id: CHK-2.3-06
    target: Stage isolation stable (INV-8)
    result: passed
  - id: CHK-2.3-07
    target: Version override stable (INV-7)
    result: passed
  - id: CHK-2.3-08
    target: No requirement-undriven capabilities (HC-04)
    result: passed
  - id: CHK-2.3-09
    target: Traceability closure (Req-2, Req-3)
    result: passed
nextTask: "3.1"
```
