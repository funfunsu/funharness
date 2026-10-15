# 任务拆解文档
## 迭代信息
- 功能名称: CodeGraph
- 任务拆分模式: standard
- 需求文档: c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\requirements.md
- 设计文档: c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md

## 既有资源声明（如有）
- 已存在需求与设计产物，可直接执行 design -> tasks 规划。
- 测试用例文档与测试清单作为可选输入，不作为阻断条件。
- 本次任务拆解仅使用 canonical domain: project-structure-init, domain-knowledge。

## 任务清单（严格按依赖顺序执行）
- [x] 1.1 建立需求-设计-任务追溯基线与接缝映射检查点
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\requirements.md#需求追踪矩阵]
	- 输出: [.harness/process/traceability-baseline.md, .harness/process/integration-points-baseline.md]
	- 新建输出: [.harness/process/traceability-baseline.md, .harness/process/integration-points-baseline.md]
	- 改造输出: [无]
	- 验收: 基线文件覆盖 Req-1 到 Req-5 与 Integration Points 全量条目，且明确后续任务 ID 占位。
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5 + INV-1, INV-2, INV-3, INV-4, INV-5, INV-6

- [x] 1.2 扩展配置模型与默认策略
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.2, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.4]
	- 输出: [apps/src/models.ts, apps/src/services/featureStoreService.ts, apps/src/extension.ts]
	- 新建输出: [无]
	- 改造输出: [apps/src/models.ts, apps/src/services/featureStoreService.ts, apps/src/extension.ts]
	- 验收: 缺省配置满足 autoCodeGraphEnabled=true 与 autoInstallEnabled=false，且加载历史配置保持兼容。
	- 追踪: Req-2 + INV-2

- [x] 1.3 接入高级设置开关与保存链路
	- Owner: Frontend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.3, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.3]
	- 输出: [apps/src/webviewTemplates.ts, apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts, apps/src/extension.ts]
	- 新建输出: [无]
	- 改造输出: [apps/src/webviewTemplates.ts, apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts, apps/src/extension.ts]
	- 验收: 设置页可展示并保存两个开关，重开页面状态与持久化值一致。
	- 追踪: Req-2 + INV-2

- [x] 1.4 配置治理检查点冻结
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1]
	- 输出: [.harness/process/checkpoint-1.4-config-policy-freeze.md]
	- 新建输出: [.harness/process/checkpoint-1.4-config-policy-freeze.md]
	- 改造输出: [无]
	- 验收: 冻结记录包含默认值、保存行为、回读一致性与回滚策略。
	- 追踪: Req-2 + INV-2

- [x] 2.1 新建初始化编排器与去重守卫
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#4]
	- 输出: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts, apps/src/services/codegraph/codeGraphDedupeGuard.ts, apps/src/extension.ts]
	- 新建输出: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts, apps/src/services/codegraph/codeGraphDedupeGuard.ts]
	- 改造输出: [apps/src/extension.ts]
	- 验收: 对同一 sessionId + worktreePath 初始化窗口内最多单活跃执行，重复触发返回 deduped。
	- 追踪: Req-1, Req-4 + INV-1, INV-5

- [x] 2.2 新建 CLI 探测安装与构建执行组件
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#5]
	- 输出: [apps/src/services/codegraph/codeGraphInstallProbe.ts, apps/src/services/codegraph/codeGraphBuildRunner.ts, apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
	- 新建输出: [apps/src/services/codegraph/codeGraphInstallProbe.ts, apps/src/services/codegraph/codeGraphBuildRunner.ts]
	- 改造输出: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
	- 验收: CLI 缺失时按策略执行一次非交互安装尝试并记录结果，安装失败不阻断主流程。
	- 追踪: Req-1, Req-3, Req-4 + INV-1, INV-3, INV-4

- [x] 2.3 新建过程记录账本并接入执行链路
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.4]
	- 输出: [apps/src/services/codegraph/codeGraphRunLedger.ts, apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
	- 新建输出: [apps/src/services/codegraph/codeGraphRunLedger.ts]
	- 改造输出: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
	- 验收: success, warning, deduped 三类尝试均写入统一记录，字段包含入口、时间、状态、摘要。
	- 追踪: Req-4 + INV-4

- [x] 2.4 在首次真实创建入口接入自动初始化主流程
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.3, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4]
	- 输出: [apps/src/services/harnessActionsService.ts, apps/src/extension.ts]
	- 新建输出: [无]
	- 改造输出: [apps/src/services/harnessActionsService.ts, apps/src/extension.ts]
	- 验收: openFolderLocationByFeatureId 与 runCustomButtonByFeatureId 两入口在 wasNewlyCreated=true 时触发同一编排流程。
	- 追踪: Req-1, Req-3, Req-4 + INV-1, INV-3, INV-5

- [x] 2.5 初始化链路检查点与门禁记录
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#5]
	- 输出: [.harness/process/checkpoint-2.5-init-flow-freeze.md, .harness/process/codegraph-init-gate-checklist.md]
	- 新建输出: [.harness/process/checkpoint-2.5-init-flow-freeze.md, .harness/process/codegraph-init-gate-checklist.md]
	- 改造输出: [无]
	- 验收: 门禁记录明确触发条件、去重行为、失败降级与日志落位策略。
	- 追踪: Req-1, Req-3, Req-4 + INV-1, INV-3, INV-4, INV-5

- [x] 3.1 新建图谱证据提供器与缓存策略
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.4]
	- 输出: [apps/src/services/codegraph/codeGraphEvidenceProvider.ts, apps/src/extension.ts, apps/src/models.ts]
	- 新建输出: [apps/src/services/codegraph/codeGraphEvidenceProvider.ts]
	- 改造输出: [apps/src/extension.ts, apps/src/models.ts]
	- 验收: 可返回 usable, freshness, anchors, seams, impactSet, bundlePath 与 warning 字段并支持 stale 标记。
	- 追踪: Req-5 + INV-6

- [x] 3.2 在四阶段 Prompt 注入图谱证据与降级告警
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.3, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
	- 输出: [apps/src/services/promptService.ts, apps/src/services/harnessActionsService.ts]
	- 新建输出: [无]
	- 改造输出: [apps/src/services/promptService.ts, apps/src/services/harnessActionsService.ts]
	- 验收: req, des, tsk, dev 四阶段在证据可用时注入摘要，证据缺失或过期时仅告警降级且不输出否定性推断。
	- 追踪: Req-5 + INV-6

- [x] 3.3 证据注入检查点冻结
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#4]
	- 输出: [.harness/process/checkpoint-3.3-evidence-injection-freeze.md]
	- 新建输出: [.harness/process/checkpoint-3.3-evidence-injection-freeze.md]
	- 改造输出: [无]
	- 验收: 冻结记录明确四阶段注入字段、预算策略与降级条件。
	- 追踪: Req-5 + INV-6

- [x] 4.1 补齐自动构建与配置治理单元测试
	- Owner: Backend
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
	- 输出: [apps/test/harnessActionsDomainPreflight.test.js, apps/test/featureStoreService.test.js, apps/test/domainKnowledgeFlow.test.js]
	- 新建输出: [无]
	- 改造输出: [apps/test/harnessActionsDomainPreflight.test.js, apps/test/featureStoreService.test.js, apps/test/domainKnowledgeFlow.test.js]
	- 验收: 覆盖首次创建双入口触发、开关默认值与持久化一致性、安装失败不阻断场景。
	- 追踪: Req-1, Req-2, Req-3, Req-4 + INV-1, INV-2, INV-3, INV-4, INV-5

- [x] 4.2 补齐四阶段证据注入与降级回退测试
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
	- 输出: [apps/test/promptService.test.js, apps/test/reviewStageInjection.test.js]
	- 新建输出: [无]
	- 改造输出: [apps/test/promptService.test.js, apps/test/reviewStageInjection.test.js]
	- 验收: 覆盖证据可用注入、stale or missing 降级告警、禁止否定性推断三类行为。
	- 追踪: Req-5 + INV-6

- [x] 4.3 回归验证与最终门禁检查点
	- Owner: FullStack
	- 输入: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
	- 输出: [.harness/process/verification-report-codegraph.md, .harness/process/final-gate-checklist-codegraph.md]
	- 新建输出: [.harness/process/verification-report-codegraph.md, .harness/process/final-gate-checklist-codegraph.md]
	- 改造输出: [无]
	- 验收: 记录 compile guard 与测试回归结论、需求覆盖率与接缝交付物完成度。
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5 + INV-1, INV-2, INV-3, INV-4, INV-5, INV-6

## 机器可读区
```yaml
artifactType: tasks
taskName: CodeGraph
tasks:
  - id: 1.1
    name: 建立需求设计任务追溯基线与接缝映射检查点
    owner: FullStack
    domain: project-structure-init
    dependsOn: []
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\requirements.md#需求追踪矩阵]
    outputs: [.harness/process/traceability-baseline.md, .harness/process/integration-points-baseline.md]
    newFiles: [.harness/process/traceability-baseline.md, .harness/process/integration-points-baseline.md]
    modifiedFiles: []
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    properties: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6]
  - id: 1.2
    name: 扩展配置模型与默认策略
    owner: Backend
    domain: project-structure-init
    dependsOn: [1.1]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.2, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.4]
    outputs: [apps/src/models.ts, apps/src/services/featureStoreService.ts, apps/src/extension.ts]
    newFiles: []
    modifiedFiles: [apps/src/models.ts, apps/src/services/featureStoreService.ts, apps/src/extension.ts]
    requirementIds: [Req-2]
    properties: [INV-2]
  - id: 1.3
    name: 接入高级设置开关与保存链路
    owner: Frontend
    domain: project-structure-init
    dependsOn: [1.2]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.3, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.3]
    outputs: [apps/src/webviewTemplates.ts, apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts, apps/src/extension.ts]
    newFiles: []
    modifiedFiles: [apps/src/webviewTemplates.ts, apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts, apps/src/extension.ts]
    requirementIds: [Req-2]
    properties: [INV-2]
  - id: 1.4
    name: 配置治理检查点冻结
    owner: FullStack
    domain: project-structure-init
    dependsOn: [1.3]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1]
    outputs: [.harness/process/checkpoint-1.4-config-policy-freeze.md]
    newFiles: [.harness/process/checkpoint-1.4-config-policy-freeze.md]
    modifiedFiles: []
    requirementIds: [Req-2]
    properties: [INV-2]
  - id: 2.1
    name: 新建初始化编排器与去重守卫
    owner: Backend
    domain: project-structure-init
    dependsOn: [1.4]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#4]
    outputs: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts, apps/src/services/codegraph/codeGraphDedupeGuard.ts, apps/src/extension.ts]
    newFiles: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts, apps/src/services/codegraph/codeGraphDedupeGuard.ts]
    modifiedFiles: [apps/src/extension.ts]
    requirementIds: [Req-1, Req-4]
    properties: [INV-1, INV-5]
  - id: 2.2
    name: 新建CLI探测安装与构建执行组件
    owner: Backend
    domain: project-structure-init
    dependsOn: [2.1]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#5]
    outputs: [apps/src/services/codegraph/codeGraphInstallProbe.ts, apps/src/services/codegraph/codeGraphBuildRunner.ts, apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
    newFiles: [apps/src/services/codegraph/codeGraphInstallProbe.ts, apps/src/services/codegraph/codeGraphBuildRunner.ts]
    modifiedFiles: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
    requirementIds: [Req-1, Req-3, Req-4]
    properties: [INV-1, INV-3, INV-4]
  - id: 2.3
    name: 新建过程记录账本并接入执行链路
    owner: Backend
    domain: project-structure-init
    dependsOn: [2.2]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.4]
    outputs: [apps/src/services/codegraph/codeGraphRunLedger.ts, apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
    newFiles: [apps/src/services/codegraph/codeGraphRunLedger.ts]
    modifiedFiles: [apps/src/services/codegraph/codeGraphInitOrchestrator.ts]
    requirementIds: [Req-4]
    properties: [INV-4]
  - id: 2.4
    name: 在首次真实创建入口接入自动初始化主流程
    owner: Backend
    domain: project-structure-init
    dependsOn: [2.3]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.3, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4]
    outputs: [apps/src/services/harnessActionsService.ts, apps/src/extension.ts]
    newFiles: []
    modifiedFiles: [apps/src/services/harnessActionsService.ts, apps/src/extension.ts]
    requirementIds: [Req-1, Req-3, Req-4]
    properties: [INV-1, INV-3, INV-5]
  - id: 2.5
    name: 初始化链路检查点与门禁记录
    owner: FullStack
    domain: project-structure-init
    dependsOn: [2.4]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#5]
    outputs: [.harness/process/checkpoint-2.5-init-flow-freeze.md, .harness/process/codegraph-init-gate-checklist.md]
    newFiles: [.harness/process/checkpoint-2.5-init-flow-freeze.md, .harness/process/codegraph-init-gate-checklist.md]
    modifiedFiles: []
    requirementIds: [Req-1, Req-3, Req-4]
    properties: [INV-1, INV-3, INV-4, INV-5]
  - id: 3.1
    name: 新建图谱证据提供器与缓存策略
    owner: Backend
    domain: domain-knowledge
    dependsOn: [2.5]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.1, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#3.4]
    outputs: [apps/src/services/codegraph/codeGraphEvidenceProvider.ts, apps/src/extension.ts, apps/src/models.ts]
    newFiles: [apps/src/services/codegraph/codeGraphEvidenceProvider.ts]
    modifiedFiles: [apps/src/extension.ts, apps/src/models.ts]
    requirementIds: [Req-5]
    properties: [INV-6]
  - id: 3.2
    name: 在四阶段Prompt注入图谱证据与降级告警
    owner: FullStack
    domain: domain-knowledge
    dependsOn: [3.1]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.3, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
    outputs: [apps/src/services/promptService.ts, apps/src/services/harnessActionsService.ts]
    newFiles: []
    modifiedFiles: [apps/src/services/promptService.ts, apps/src/services/harnessActionsService.ts]
    requirementIds: [Req-5]
    properties: [INV-6]
  - id: 3.3
    name: 证据注入检查点冻结
    owner: FullStack
    domain: domain-knowledge
    dependsOn: [3.2]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#2.4, c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#4]
    outputs: [.harness/process/checkpoint-3.3-evidence-injection-freeze.md]
    newFiles: [.harness/process/checkpoint-3.3-evidence-injection-freeze.md]
    modifiedFiles: []
    requirementIds: [Req-5]
    properties: [INV-6]
  - id: 4.1
    name: 补齐自动构建与配置治理单元测试
    owner: Backend
    domain: project-structure-init
    dependsOn: [3.3]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
    outputs: [apps/test/harnessActionsDomainPreflight.test.js, apps/test/featureStoreService.test.js, apps/test/domainKnowledgeFlow.test.js]
    newFiles: []
    modifiedFiles: [apps/test/harnessActionsDomainPreflight.test.js, apps/test/featureStoreService.test.js, apps/test/domainKnowledgeFlow.test.js]
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    properties: [INV-1, INV-2, INV-3, INV-4, INV-5]
  - id: 4.2
    name: 补齐四阶段证据注入与降级回退测试
    owner: FullStack
    domain: domain-knowledge
    dependsOn: [4.1]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
    outputs: [apps/test/promptService.test.js, apps/test/reviewStageInjection.test.js]
    newFiles: []
    modifiedFiles: [apps/test/promptService.test.js, apps/test/reviewStageInjection.test.js]
    requirementIds: [Req-5]
    properties: [INV-6]
  - id: 4.3
    name: 回归验证与最终门禁检查点
    owner: FullStack
    domain: project-structure-init
    dependsOn: [4.2]
    inputs: [c:\Users\cnu07hws\fun-harness\worktrees\codegraph-20261014\specs\codegraph-20261014\design.md#6]
    outputs: [.harness/process/verification-report-codegraph.md, .harness/process/final-gate-checklist-codegraph.md]
    newFiles: [.harness/process/verification-report-codegraph.md, .harness/process/final-gate-checklist-codegraph.md]
    modifiedFiles: []
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    properties: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6]
```
