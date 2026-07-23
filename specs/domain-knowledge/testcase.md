# 测试用例文档

## 概述

本用例集覆盖 domain-knowledge 能力在契约敏感变更后的主链行为，重点验证主面板治理路由、worktree 约束、聚合输入边界与可选 testcase 产物策略。

## 用例清单

### TC-DK-001 主面板治理入口与 worktree 隔离

- requirementIds: Req-dk-6, Req-dk-7, Req-dk-10
- 前置条件：主面板与 worktree 子视图都可打开。
- GIVEN 主面板加载完成，WHEN 渲染治理区，THEN 页面应包含 `领域基线聚合`、`疑似领域裁决`、`领域总览预览` 三个入口。
- GIVEN worktree 子视图加载完成，WHEN 渲染页面，THEN 不应出现上述三个治理入口。

### TC-DK-006 领域基线聚合结果提示语义

- requirementIds: Req-dk-6, Req-dk-8
- 前置条件：主面板可执行聚合，且存在/不存在可处理迭代两种场景。
- GIVEN 执行领域基线聚合后无待裁决领域且本次存在处理项，WHEN 聚合结束，THEN 提示应明确返回已处理迭代数量。
- GIVEN 执行领域基线聚合后无待裁决领域且本次无处理项，WHEN 聚合结束，THEN 提示应为聚合预检查完成，不应误导为处理失败。

### TC-DK-002 路由契约覆盖与 allowlist 约束

- requirementIds: Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-10
- 前置条件：源码存在 `harnessMessages.ts`、`harnessMessageController.ts`、`extension.ts`。
- GIVEN 控制器路由定义，WHEN 检查消息分发，THEN 必须存在 `runDomainBaselineAggregation`、`reviewSuspectedDomains`、`previewDomainBaselineSummary` 的路由分支。
- GIVEN worktree allowlist，WHEN 检查子视图允许消息集合，THEN 不得包含上述三个治理路由。
- GIVEN 扩展命令注册，WHEN 检查命令定义，THEN 必须存在 `fun-harness.runDomainBaselineAggregation`、`fun-harness.reviewSuspectedDomains`、`fun-harness.previewDomainBaselineSummary`。

### TC-DK-003 聚合输入边界（仅 delta）

- requirementIds: Req-dk-6
- 前置条件：仓库内有随机源码文件但不存在 `specs/<iteration>/delta/capability-delta.json`。
- GIVEN 触发聚合，WHEN 执行 `aggregatePendingDeltas`，THEN `processed/skipped/suspectedDomains` 均为空，且不得生成任何 `docs/domains/<domain>.md`。

### TC-DK-004 可选 testcase 策略回归

- requirementIds: Req-dk-6
- 前置条件：任务已进入非需求/设计阶段，且缺少 `testcase.md`。
- GIVEN 主面板健康评估，WHEN 汇总告警原因，THEN 不得出现 `缺少 testcase 产物`。

### TC-DK-005 AI 润色失败回退

- requirementIds: Req-dk-11
- 前置条件：已存在合法 delta，且 AI 润色调用抛错。
- GIVEN 启用可选 AI 润色，WHEN 润色失败，THEN 聚合过程不得失败，必须回退到纯结构化输出并完成落盘。

## 执行记录

- 参考自动化测试：`apps/test/domainKnowledgeFlow.test.js`
- 回归门禁：`npm test`

## 机器可读区

```yaml
artifactType: testcase
taskName: domain-knowledge
testCases:
  - id: TC-DK-001
    requirementIds: [Req-dk-6, Req-dk-7, Req-dk-10]
    title: 主面板治理入口与 worktree 隔离
    type: integration
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-DK-002
    requirementIds: [Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-10]
    title: 路由契约覆盖与 allowlist 约束
    type: contract
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-DK-003
    requirementIds: [Req-dk-6]
    title: 聚合输入边界仅消费 delta
    type: integration
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-DK-004
    requirementIds: [Req-dk-6]
    title: 可选 testcase 策略回归
    type: contract
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-DK-005
    requirementIds: [Req-dk-11]
    title: AI 润色失败回退
    type: integration
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-DK-006
    requirementIds: [Req-dk-6, Req-dk-8]
    title: 领域基线聚合结果提示语义
    type: contract
    automated: false
    script: manual
```
