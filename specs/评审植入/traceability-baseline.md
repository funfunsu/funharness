# 需求-设计追溯基线

> 任务 ID：1.1  
> 功能：评审植入  
> 产出：Req-1..Req-4 全量追溯映射清单（API / MODEL / INV / TEST / STORE / COMP / ROUTE）  
> domain：project-structure-init

---

## 追溯映射清单

### Req-1 关键阶段提供可选评审入口

| 类型 | ID | 说明 |
|------|----|------|
| API | API-1 | `HarnessMessageController#openStageReview` — 评审入口消息，返回 `reviewEnabled:true, defaultExecuted:false` |
| ROUTE | ROUTE-1 | `openStageReview` 消息路由 → `ReviewEntryController.open(stage)` |
| ROUTE | ROUTE-3 | `runStageReview` 消息路由，仅在三关键阶段生效 |
| COMP | COMP-1 | `StageReviewEntryButton`：props `stage, visible, latestStatus`；event `onClickReview(stage)` |
| INV | INV-1 | 三阶段页面加载完成后，评审入口必须可见且默认不触发评审执行 |
| INV | INV-2 | 用户未点击评审时，主流程推进链路的可达性与无评审场景等价 |
| TEST | TEST-1 | 三阶段入口可见且默认未执行（status=idle） |
| TEST | TEST-2 | 不点击评审不阻断流程 |

---

### Req-2 评审提示词支持通用模板

| 类型 | ID | 说明 |
|------|----|------|
| API | API-2 | `PromptService#resolveReviewPromptByStage` — 解析阶段评审模板，优先 custom，回退 default |
| API | API-4 | `ReviewExecutionService#runStageReview` — 请求内容必须包含阶段上下文与模板正文 |
| MODEL | MODEL-2 | `StageReviewTemplateSet`：字段 `stage, defaultPrompt, defaultTemplateId` |
| MODEL | MODEL-3 | `StageReviewRequest`：字段 `reviewId, stage, promptSource, composedPrompt, contextSnapshot` |
| ROUTE | ROUTE-3 | `runStageReview` 内必须先做模板解析再创建评审请求 |
| INV | INV-3 | 无自定义模板时，`resolveReviewPromptByStage(stage)` 必须返回该阶段 `defaultPrompt` |
| INV | INV-4 | 评审请求创建时，`composedPrompt` 必须同时包含阶段上下文与模板正文 |
| INV | INV-5 | 任意两个不同阶段 `s1 != s2`，`defaultPrompt(s1)` 与 `defaultPrompt(s2)` 必须可区分 |
| TEST | TEST-3 | 通用模板回退：未配置自定义时使用当前阶段通用模板 |
| TEST | TEST-4 | 模板含阶段上下文：`composedPrompt` 含阶段上下文与模板正文 |
| TEST | TEST-5 | 三阶段通用模板区分：分别构造请求时三阶段模板内容可区分 |

---

### Req-3 评审提示词支持用户自定义并可覆盖通用模板

| 类型 | ID | 说明 |
|------|----|------|
| API | API-2 | `PromptService#resolveReviewPromptByStage` — custom 优先逻辑 |
| API | API-3 | `ReviewPromptConfigService#saveStagePrompt` — 按阶段保存，返回 `savedVersion, updatedAt` |
| API | API-4 | `ReviewExecutionService#runStageReview` — 按解析结果携带 `promptSource` |
| MODEL | MODEL-1 | `StageReviewPromptConfig`：字段 `stage, customPrompt, version, updatedAt` |
| MODEL | MODEL-3 | `StageReviewRequest`：字段 `promptSource` 反映 custom/default |
| STORE | STORE-1 | `reviewPromptConfigStore`：key=stage，按阶段覆盖写入，保留版本号 |
| ROUTE | ROUTE-2 | `saveStageCustomReviewPrompt` 消息路由 → `ReviewPromptConfigService.save(stage, prompt)` |
| COMP | COMP-2 | `StageReviewPromptEditor`：props `stage, customPrompt, defaultPromptPreview`；event `onSaveCustomPrompt(stage,prompt)` |
| INV | INV-6 | 当阶段存在自定义模板时，`promptSource` 必须为 `custom`，请求不得回退 `default` |
| INV | INV-7 | 自定义模板更新后，下一次同阶段评审请求必须使用最新保存版本 |
| INV | INV-8 | 阶段 A 的自定义模板不得影响阶段 B 的模板解析结果（A != B） |
| TEST | TEST-6 | 自定义覆盖生效：`promptSource=custom` 且使用该阶段自定义模板 |
| TEST | TEST-7 | 自定义更新后生效：再次评审使用最新保存版本 |
| TEST | TEST-8 | 阶段间隔离：需求有自定义走 custom，设计无自定义走 default |

---

### Req-4 评审执行结果与状态可感知且不改变主流程完成语义

| 类型 | ID | 说明 |
|------|----|------|
| API | API-1 | `HarnessMessageController#openStageReview` — 入口默认 `defaultExecuted:false` |
| API | API-4 | `ReviewExecutionService#runStageReview` — 执行并返回 `status, summary?, errorReason?` |
| API | API-5 | `ReviewExecutionService#getLatestReviewStatus` — 回显阶段最新状态，不引入阻断状态机 |
| MODEL | MODEL-4 | `StageReviewStatus`：字段 `reviewId, stage, status, summary, errorReason, updatedAt` |
| STORE | STORE-2 | `reviewStatusStore`：key=stage，异步更新，不写入阻断主流程的布尔门禁字段 |
| ROUTE | ROUTE-3 | `runStageReview` 失败不得阻断阶段保存/推进消息链 |
| ROUTE | ROUTE-4 | `getStageReviewStatus` 消息路由 → `ReviewExecutionService.getLatest(stage)` |
| COMP | COMP-1 | `StageReviewEntryButton`：props `latestStatus` 展示回显状态 |
| COMP | COMP-3 | `StageReviewStatusPanel`：props `stage, status, summary, errorReason`；event `onRefreshStatus(stage)` |
| INV | INV-9 | 执行开始后状态必须进入 `running`，成功后进入 `completed`+摘要，失败后进入 `failed`+原因 |
| INV | INV-10 | 即使评审为 `failed` 或 `idle`，阶段保存/推进操作仍按既有规则判定，不新增"必须评审"门禁 |
| TEST | TEST-9 | 状态可感知：执行中/成功/失败分别显示 running/completed/failed |
| TEST | TEST-10 | 失败不改变完成语义：评审失败后阶段保存/推进不新增强制评审门禁 |

---

## 悬空引用校验

| 检查项 | 结论 |
|--------|------|
| 所有 API ID（API-1..API-5）均绑定至少一条 Req | ✓ 通过 |
| 所有 MODEL ID（MODEL-1..MODEL-4）均绑定至少一条 Req | ✓ 通过 |
| 所有 INV ID（INV-1..INV-10）均绑定至少一条 Req | ✓ 通过 |
| 所有 TEST ID（TEST-1..TEST-10）均绑定至少一条 Req | ✓ 通过 |
| 所有 STORE ID（STORE-1..STORE-2）均绑定至少一条 Req | ✓ 通过 |
| 所有 COMP ID（COMP-1..COMP-3）均绑定至少一条 Req | ✓ 通过 |
| 所有 ROUTE ID（ROUTE-1..ROUTE-4）均绑定至少一条 Req | ✓ 通过 |
| Req-1..Req-4 全量覆盖（无遗漏 Req） | ✓ 通过 |
| domain 仅为 project-structure-init | ✓ 通过 |

---

## 机器可读区

```yaml
artifactType: traceability-baseline
taskId: "1.1"
taskName: 建立需求-设计追溯基线
domain: project-structure-init
requirements:
  - id: Req-1
    apis: [API-1]
    routes: [ROUTE-1, ROUTE-3]
    components: [COMP-1]
    invariants: [INV-1, INV-2]
    tests: [TEST-1, TEST-2]
  - id: Req-2
    apis: [API-2, API-4]
    models: [MODEL-2, MODEL-3]
    routes: [ROUTE-3]
    invariants: [INV-3, INV-4, INV-5]
    tests: [TEST-3, TEST-4, TEST-5]
  - id: Req-3
    apis: [API-2, API-3, API-4]
    models: [MODEL-1, MODEL-3]
    stores: [STORE-1]
    routes: [ROUTE-2]
    components: [COMP-2]
    invariants: [INV-6, INV-7, INV-8]
    tests: [TEST-6, TEST-7, TEST-8]
  - id: Req-4
    apis: [API-1, API-4, API-5]
    models: [MODEL-4]
    stores: [STORE-2]
    routes: [ROUTE-3, ROUTE-4]
    components: [COMP-1, COMP-3]
    invariants: [INV-9, INV-10]
    tests: [TEST-9, TEST-10]
dangling: none
```
