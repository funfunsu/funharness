# 测试用例文档

## 概述

本用例集覆盖“评审植入”能力的当前实现，重点验证四阶段入口可见性、模板解析优先级、自定义模板覆盖与隔离、评审执行状态反馈，以及评审失败不改变主流程完成语义。

## 用例清单

### TC-RI-001 四阶段入口可见且默认未执行

- requirementIds: Req-1
- 前置条件：评审执行服务已初始化，尚未对任一阶段触发评审。
- GIVEN 用户进入 requirements 阶段 WHEN 页面加载完成且未触发评审 THEN `getLatestReviewStatus('requirements')` 返回 `idle`，且 summary/errorReason 为空。
- GIVEN 用户进入 design 阶段 WHEN 页面加载完成且未触发评审 THEN `getLatestReviewStatus('design')` 返回 `idle`。
- GIVEN 用户进入 testcase 阶段 WHEN 页面加载完成且未触发评审 THEN `getLatestReviewStatus('testcase')` 返回 `idle`。
- GIVEN 用户进入 tasks 阶段 WHEN 页面加载完成且未触发评审 THEN `getLatestReviewStatus('tasks')` 返回 `idle`。

### TC-RI-002 未触发评审不阻断主流程

- requirementIds: Req-1, Req-4
- 前置条件：评审状态未启动，主流程仍按既有规则运行。
- GIVEN 用户未点击任一阶段评审入口 WHEN 查询各阶段最新状态 THEN 状态均为 `idle`，且结果不包含阻断字段。
- GIVEN 用户未点击任一阶段评审入口 WHEN 后续执行主流程保存或推进操作 THEN 操作不应因评审缺失而新增阻断语义。

### TC-RI-003 通用模板回退

- requirementIds: Req-2
- 前置条件：任一阶段未保存自定义 Prompt。
- GIVEN requirements 阶段未配置自定义 Prompt WHEN 解析模板 THEN `source=default`。
- GIVEN design 阶段未配置自定义 Prompt WHEN 解析模板 THEN `source=default`。
- GIVEN testcase 阶段未配置自定义 Prompt WHEN 解析模板 THEN `source=default`。
- GIVEN tasks 阶段未配置自定义 Prompt WHEN 解析模板 THEN `source=default`。
- GIVEN 未向 `resolveReviewPromptByStage` 传入 `configService` WHEN 解析 requirements 阶段模板 THEN 系统仍回退 `source=default`，且 `promptBody` 非空。

### TC-RI-004 composedPrompt 包含阶段上下文与模板正文

- requirementIds: Req-2
- 前置条件：可调用模板解析服务并传入阶段上下文。
- GIVEN 上下文包含 `featureId` 与 `title` WHEN 解析 requirements 阶段模板 THEN `composedPrompt` 同时包含上下文字段和值，以及模板正文。
- GIVEN 上下文为空对象 WHEN 解析 design 阶段模板 THEN `composedPrompt` 仍包含上下文区与模板正文。

### TC-RI-005 四阶段通用模板内容可区分

- requirementIds: Req-2
- 前置条件：未配置任何阶段自定义 Prompt。
- GIVEN 分别在 requirements、design、testcase、tasks 四阶段解析默认模板 WHEN 比较返回的 `promptBody` THEN 四者内容互不相同。
- GIVEN 任一阶段解析默认模板 WHEN 检查模板长度 THEN `promptBody` 不得为空且应可读。

### TC-RI-006 自定义模板覆盖默认模板

- requirementIds: Req-3
- 前置条件：已能按阶段保存自定义 Prompt。
- GIVEN requirements 阶段已保存自定义 Prompt WHEN 重新解析模板 THEN `source=custom` 且 `promptBody` 等于自定义内容。
- GIVEN design 阶段已保存自定义 Prompt WHEN 重新解析模板 THEN `source=custom`。

### TC-RI-007 自定义模板更新后使用最新版本

- requirementIds: Req-3
- 前置条件：同一阶段可连续保存多次自定义 Prompt。
- GIVEN requirements 阶段先保存版本一再保存版本二 WHEN 查询保存结果 THEN `savedVersion` 递增。
- GIVEN requirements 阶段已保存多个版本 WHEN 再次解析模板 THEN 返回最新保存的 `promptBody`。
- GIVEN design 阶段连续保存多次 WHEN 查询保存结果 THEN 版本号单调递增。

### TC-RI-008 阶段间配置隔离

- requirementIds: Req-3
- 前置条件：不同阶段可分别配置自定义 Prompt。
- GIVEN requirements 阶段已保存自定义 Prompt 且 design 阶段未配置 WHEN 分别解析 THEN requirements 返回 `custom`，design 回退 `default`。
- GIVEN requirements 与 design 分别保存不同自定义 Prompt WHEN 分别解析 THEN 两阶段返回各自内容，不得互相污染。
- GIVEN testcase 阶段保存自定义 Prompt WHEN 解析 requirements 阶段模板 THEN requirements 不受 testcase 配置影响。

### TC-RI-009 评审执行状态可感知

- requirementIds: Req-4
- 前置条件：可调用评审执行服务并注入 AI Provider mock。
- GIVEN 用户点击评审 WHEN `runStageReview('requirements', context)` 开始执行 THEN 调用应立即返回 `running`，且返回 `reviewId`。
- GIVEN AI 执行成功 WHEN 通过 `getLatestReviewStatus('design')` 轮询或查询最新状态 THEN 最终状态变为 `completed` 且包含摘要。
- GIVEN AI 执行失败 WHEN 通过 `getLatestReviewStatus('testcase')` 轮询或查询最新状态 THEN 最终状态变为 `failed` 且包含失败原因。

### TC-RI-010 评审失败不改变主流程完成语义

- requirementIds: Req-4
- 前置条件：评审执行失败或尚未执行。
- GIVEN 评审执行失败 WHEN 查询最终状态 THEN 结果不包含 `blocked` 或 `required` 字段。
- GIVEN 评审尚未执行 WHEN 查询最新状态 THEN 返回 `idle` 且不包含阻断字段。
- GIVEN 某阶段评审失败 WHEN 用户继续阶段保存或推进 THEN 主流程仍按既有规则判定，不新增“必须评审后才能继续”的强制约束。
- GIVEN 仅使用合法阶段值 WHEN 分别解析 `requirements`、`design`、`testcase`、`tasks` 模板 THEN 四个阶段均返回非空 `promptBody`（阶段边界基线）。

## 执行记录

- 参考自动化测试：`apps/test/reviewStageInjection.test.js`
- 回归门禁：`npm test`

## 机器可读区

```yaml
artifactType: testcase
taskName: 评审植入
testCases:
  - id: TC-RI-001
    requirementIds: [Req-1]
    title: 四阶段入口可见且默认未执行
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-002
    requirementIds: [Req-1, Req-4]
    title: 未触发评审不阻断主流程
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-003
    requirementIds: [Req-2]
    title: 通用模板回退
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-004
    requirementIds: [Req-2]
    title: composedPrompt 包含阶段上下文与模板正文
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-005
    requirementIds: [Req-2]
    title: 四阶段通用模板内容可区分
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-006
    requirementIds: [Req-3]
    title: 自定义模板覆盖默认模板
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-007
    requirementIds: [Req-3]
    title: 自定义模板更新后使用最新版本
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-008
    requirementIds: [Req-3]
    title: 阶段间配置隔离
    type: contract
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-009
    requirementIds: [Req-4]
    title: 评审执行状态可感知
    type: integration
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-RI-010
    requirementIds: [Req-4]
    title: 评审失败不改变主流程完成语义
    type: integration
    automated: true
    script: apps/test/reviewStageInjection.test.js
```