# 任务拆解文档

## 迭代信息

- 功能名称：领域聚合优化
- 任务拆分模式：standard
- 约束声明：本任务清单仅基于需求与设计产物规划，不将 `.harness/*.json` 作为规划事实源。
- canonical domain：domain-knowledge

## 既有资源声明（如有）

- 已使用输入：
	- `specs/领域聚合优化/requirements.md`
	- `specs/领域聚合优化/design.md`
- 可选输入缺失但不阻断：
	- `specs/领域聚合优化/testcase.md`
	- `tests/test-manifest.json`

## 任务清单（严格按依赖顺序执行）

- [x] 1.1 领域契约与模型对齐基线
	- Owner: Backend
	- 输入: design §3.1 API-1..API-12；design §3.2 Model-1..Model-6
	- 输出: `apps/src/models.ts`、`apps/src/harnessMessages.ts` 中的契约与类型对齐清单
	- 验收: API/Model 字段与命名完全对齐设计；不新增新领域名；仅使用 `domain-knowledge`
	- 追踪: Req-1, Req-2, Req-4, Req-5, Req-6, Req-8 + INV-3, INV-6, INV-7, INV-8, INV-11

- [x] 1.2 子面板唯一入口与遗留入口移除
	- Owner: FullStack
	- 输入: design §2.3 ROUTE-1/ROUTE-7；design §4.2 INV-1/INV-2
	- 输出: `apps/src/extension.ts`、`apps/src/harnessMessageController.ts` 的入口改造任务项
	- 验收: 主面板领域治理入口不可见不可触发；子面板可独立进入领域工作区
	- 追踪: Req-1 + INV-1, INV-2

- [x] 1.3 边界校验与安全前置
	- Owner: Backend
	- 输入: requirements Req-7；design §5 错误处理；design §4.2 INV-9/INV-10
	- 输出: `apps/src/services/workspaceRoot.ts`、`apps/src/services/domainRegistryService.ts`、`apps/src/services/domainKnowledgeAggregateService.ts` 的校验改造任务项
	- 验收: 所有外部输入在入库前校验；越界路径阻断；非法输入不落盘
	- 追踪: Req-7 + INV-9, INV-10

- [x] 1.4 检查点：契约冻结与变更边界确认
	- Owner: FullStack
	- 输入: 1.1-1.3 产物
	- 输出: 任务执行检查记录（契约字段、路径边界、入口边界）
	- 验收: 无跨阶段无关改动；下游实现不改上游已确认字段名与方法签名
	- 追踪: Req-1, Req-7 + INV-1, INV-10

- [x] 2.1 子面板上下文加载与草稿态初始化
	- Owner: Backend
	- 输入: design §3.1 API-2；design §3.4 Store
	- 输出: `apps/src/harnessMessageController.ts`、`apps/src/services/domainKnowledgeAggregateService.ts` 的上下文加载任务项
	- 验收: 可加载 registry、baselineSnapshot、draftChangeSet；初始化失败返回明确错误
	- 追踪: Req-1, Req-2, Req-7 + INV-2, INV-9

- [x] 2.2 变更集编辑与实时投影链路
	- Owner: FullStack
	- 输入: design §2.3 ROUTE-3/ROUTE-4；design §3.1 API-3/API-4；design §3.3 UI-2/UI-3
	- 输出: `apps/src/harnessMessageController.ts`、`apps/src/services/domainKnowledgeAggregateService.ts`、`apps/src/webviewTemplates.ts`
	- 验收: 编辑后可实时预览投影；同输入重复预览结果一致；无写文件副作用
	- 追踪: Req-2, Req-6, Req-8 + INV-3, INV-8, INV-11

- [x] 2.3 冲突检测服务实现
	- Owner: Backend
	- 输入: design §3.1 API-5/API-12；design §5 冲突错误策略
	- 输出: `apps/src/services/domainKnowledgeAggregateService.ts`、`apps/src/services/mergeConflictService.ts`
	- 验收: 能识别 domain-name、baseline-version、capability-key、document-merge 冲突；blocking 冲突可阻断提交
	- 追踪: Req-4, Req-5, Req-8 + INV-5, INV-6, INV-13

- [x] 2.4 冲突裁决交互与回写
	- Owner: Frontend
	- 输入: design §3.1 API-6；design §3.3 UI-4；design §4.1 状态机
	- 输出: `apps/src/webviewTemplates.ts`、`apps/src/harnessMessageController.ts`
	- 验收: 命名冲突支持三类裁决；document-merge 支持逐段裁决；未解冲突不能提交
	- 追踪: Req-5, Req-4 + INV-5, INV-6, INV-13

- [x] 2.5 按钮与提示文案中文化落地
	- Owner: Frontend
	- 输入: design §3.3 中文按钮约束
	- 输出: `apps/src/webviewTemplates.ts`
	- 验收: 子面板按钮显示“新增变更/预览投影/写入沉淀/无变更/最近摘要/同步基线并重投影”
	- 追踪: Req-1, Req-2, Req-3, Req-4 + INV-2

- [x] 2.6 检查点：子面板闭环演示
	- Owner: FullStack
	- 输入: 2.1-2.5 产物
	- 输出: 子面板闭环验证记录（编辑→预览→冲突→裁决）
	- 验收: 无需切换主面板即可完成到可提交状态
	- 追踪: Req-1, Req-2, Req-4, Req-5 + INV-2, INV-3

- [x] 3.1 原子写入与回滚实现
	- Owner: Backend
	- 输入: design §3.1 API-7；design §5 DOMAIN_COMMIT_ROLLED_BACK
	- 输出: `apps/src/services/fileOps.ts`、`apps/src/services/domainKnowledgeAggregateService.ts`
	- 验收: `domain-change-set.yaml`、`docs/domains/<domain>.md`、`docs/domains/_index.md` 要么全成要么全回滚
	- 追踪: Req-3, Req-7 + INV-4, INV-10

- [x] 3.2 幂等提交与无变更判定
	- Owner: Backend
	- 输入: design §3.2 CommitSummary；design §4.2 INV-11/INV-14
	- 输出: `apps/src/services/domainKnowledgeAggregateService.ts`
	- 验收: 等价提交返回幂等结果；无变更返回 NO_DOMAIN_CHANGE；生成稳定 canonicalSerializationHash
	- 追踪: Req-3, Req-8 + INV-11, INV-14

- [x] 3.3 提交门禁编排
	- Owner: FullStack
	- 输入: design §2.3 ROUTE-6/ROUTE-8/ROUTE-9；design §4.1 状态机
	- 输出: `apps/src/harnessMessageController.ts`、`apps/src/services/domainKnowledgeAggregateService.ts`
	- 验收: 提交前必经“重投影+冲突检查”；blocking 冲突或漂移未处理时禁提
	- 追踪: Req-3, Req-4, Req-5, Req-8 + INV-5, INV-12, INV-13

- [x] 3.4 检查点：沉淀写入正确性签核
	- Owner: Backend
	- 输入: 3.1-3.3 产物
	- 输出: 提交结果核验记录（处理领域数、能力数、阻断项、写入文件）
	- 验收: 提交摘要可回显且字段完整；失败显式可见
	- 追踪: Req-3, Req-6 + INV-4, INV-8

- [x] 4.1 单元测试补齐（服务层）
	- Owner: Backend
	- 输入: design §6 单元测试策略
	- 输出: `apps/test/domainKnowledgeAggregateService.test.js`、`apps/test/domainRegistryService.test.js`、`apps/test/capabilityDeltaService.test.js`
	- 验收: 覆盖投影确定性、冲突检测、冲突裁决、原子回滚、输入校验、幂等
	- 追踪: Req-2, Req-3, Req-4, Req-5, Req-6, Req-7, Req-8 + INV-3, INV-4, INV-5, INV-9, INV-11

- [x] 4.2 集成测试补齐（子面板流程）
	- Owner: FullStack
	- 输入: design §6 集成测试策略
	- 输出: `apps/test/domainKnowledgeFlow.test.js`、`apps/test/domainKnowledgeAggregateService.test.js`
	- 验收: 覆盖加载→编辑→预览→裁决→写入沉淀全链路与并行分支汇合场景
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5, Req-8 + INV-2, INV-3, INV-5, INV-11, INV-13

- [x] 4.3 门禁规则与追溯校验
	- Owner: Backend
	- 输入: design §6 门禁测试；requirements 全量 Req-1..Req-8
	- 输出: `apps/scripts/` 下门禁脚本任务项与 CI 校验任务项（模块级）
	- 验收: Req→API/Model/UI/Test/Task 追溯完整；发现主面板遗留入口或无来源能力即失败
	- 追踪: Req-1, Req-6, Req-8 + INV-1, INV-8, INV-11

- [x] 4.4 检查点：spec 评审与人工 sign-off
	- Owner: FullStack
	- 输入: 4.1-4.3 产物
	- 输出: `specs/after-iteration/` 下评审记录任务项
	- 验收: 机器门禁通过 + 人工 sign-off 完成后方可标记完成
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7, Req-8 + INV-1, INV-4, INV-5, INV-8, INV-11

## 机器可读区

```yaml
artifactType: tasks
taskName: 领域聚合优化
tasks:
	- id: 1.1
		name: 领域契约与模型对齐基线
		owner: Backend
		domain: domain-knowledge
		dependsOn: []
		inputs: [specs/领域聚合优化/design.md#3.1, specs/领域聚合优化/design.md#3.2]
		outputs: [apps/src/models.ts, apps/src/harnessMessages.ts]
		requirementIds: [Req-1, Req-2, Req-4, Req-5, Req-6, Req-8]
		propertyIds: [INV-3, INV-6, INV-7, INV-8, INV-11]

	- id: 1.2
		name: 子面板唯一入口与遗留入口移除
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [1.1]
		inputs: [specs/领域聚合优化/design.md#2.3, specs/领域聚合优化/design.md#4.2]
		outputs: [apps/src/extension.ts, apps/src/harnessMessageController.ts]
		requirementIds: [Req-1]
		propertyIds: [INV-1, INV-2]

	- id: 1.3
		name: 边界校验与安全前置
		owner: Backend
		domain: domain-knowledge
		dependsOn: [1.1]
		inputs: [specs/领域聚合优化/requirements.md#需求-7, specs/领域聚合优化/design.md#5]
		outputs: [apps/src/services/workspaceRoot.ts, apps/src/services/domainRegistryService.ts, apps/src/services/domainKnowledgeAggregateService.ts]
		requirementIds: [Req-7]
		propertyIds: [INV-9, INV-10]

	- id: 1.4
		name: 检查点-契约冻结与边界确认
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [1.2, 1.3]
		inputs: [specs/领域聚合优化/design.md#3.1]
		outputs: [specs/领域聚合优化/tasks.md]
		requirementIds: [Req-1, Req-7]
		propertyIds: [INV-1, INV-10]

	- id: 2.1
		name: 子面板上下文加载与草稿态初始化
		owner: Backend
		domain: domain-knowledge
		dependsOn: [1.4]
		inputs: [specs/领域聚合优化/design.md#3.1, specs/领域聚合优化/design.md#3.4]
		outputs: [apps/src/harnessMessageController.ts, apps/src/services/domainKnowledgeAggregateService.ts]
		requirementIds: [Req-1, Req-2, Req-7]
		propertyIds: [INV-2, INV-9]

	- id: 2.2
		name: 变更集编辑与实时投影链路
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [2.1]
		inputs: [specs/领域聚合优化/design.md#2.3, specs/领域聚合优化/design.md#3.3]
		outputs: [apps/src/harnessMessageController.ts, apps/src/services/domainKnowledgeAggregateService.ts, apps/src/webviewTemplates.ts]
		requirementIds: [Req-2, Req-6, Req-8]
		propertyIds: [INV-3, INV-8, INV-11]

	- id: 2.3
		name: 冲突检测服务实现
		owner: Backend
		domain: domain-knowledge
		dependsOn: [2.2]
		inputs: [specs/领域聚合优化/design.md#3.1, specs/领域聚合优化/design.md#5]
		outputs: [apps/src/services/domainKnowledgeAggregateService.ts, apps/src/services/mergeConflictService.ts]
		requirementIds: [Req-4, Req-5, Req-8]
		propertyIds: [INV-5, INV-6, INV-13]

	- id: 2.4
		name: 冲突裁决交互与回写
		owner: Frontend
		domain: domain-knowledge
		dependsOn: [2.3]
		inputs: [specs/领域聚合优化/design.md#3.1, specs/领域聚合优化/design.md#4.1]
		outputs: [apps/src/webviewTemplates.ts, apps/src/harnessMessageController.ts]
		requirementIds: [Req-5, Req-4]
		propertyIds: [INV-5, INV-6, INV-13]

	- id: 2.5
		name: 中文按钮与提示文案落地
		owner: Frontend
		domain: domain-knowledge
		dependsOn: [2.4]
		inputs: [specs/领域聚合优化/design.md#3.3]
		outputs: [apps/src/webviewTemplates.ts]
		requirementIds: [Req-1, Req-2, Req-3, Req-4]
		propertyIds: [INV-2]

	- id: 2.6
		name: 检查点-子面板闭环演示
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [2.5]
		inputs: [specs/领域聚合优化/design.md#4.1]
		outputs: [specs/领域聚合优化/tasks.md]
		requirementIds: [Req-1, Req-2, Req-4, Req-5]
		propertyIds: [INV-2, INV-3]

	- id: 3.1
		name: 原子写入与回滚实现
		owner: Backend
		domain: domain-knowledge
		dependsOn: [2.6]
		inputs: [specs/领域聚合优化/design.md#3.1, specs/领域聚合优化/design.md#5]
		outputs: [apps/src/services/fileOps.ts, apps/src/services/domainKnowledgeAggregateService.ts]
		requirementIds: [Req-3, Req-7]
		propertyIds: [INV-4, INV-10]

	- id: 3.2
		name: 幂等提交与无变更判定
		owner: Backend
		domain: domain-knowledge
		dependsOn: [3.1]
		inputs: [specs/领域聚合优化/design.md#3.2, specs/领域聚合优化/design.md#4.2]
		outputs: [apps/src/services/domainKnowledgeAggregateService.ts]
		requirementIds: [Req-3, Req-8]
		propertyIds: [INV-11, INV-14]

	- id: 3.3
		name: 提交门禁编排
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [3.2]
		inputs: [specs/领域聚合优化/design.md#2.3, specs/领域聚合优化/design.md#4.1]
		outputs: [apps/src/harnessMessageController.ts, apps/src/services/domainKnowledgeAggregateService.ts]
		requirementIds: [Req-3, Req-4, Req-5, Req-8]
		propertyIds: [INV-5, INV-12, INV-13]

	- id: 3.4
		name: 检查点-沉淀写入正确性签核
		owner: Backend
		domain: domain-knowledge
		dependsOn: [3.3]
		inputs: [specs/领域聚合优化/design.md#5]
		outputs: [specs/领域聚合优化/tasks.md]
		requirementIds: [Req-3, Req-6]
		propertyIds: [INV-4, INV-8]

	- id: 4.1
		name: 单元测试补齐-服务层
		owner: Backend
		domain: domain-knowledge
		dependsOn: [3.4]
		inputs: [specs/领域聚合优化/design.md#6]
		outputs: [apps/test/domainKnowledgeAggregateService.test.js, apps/test/domainRegistryService.test.js, apps/test/capabilityDeltaService.test.js]
		requirementIds: [Req-2, Req-3, Req-4, Req-5, Req-6, Req-7, Req-8]
		propertyIds: [INV-3, INV-4, INV-5, INV-9, INV-11]

	- id: 4.2
		name: 集成测试补齐-子面板流程
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [4.1]
		inputs: [specs/领域聚合优化/design.md#6]
		outputs: [apps/test/domainKnowledgeFlow.test.js, apps/test/domainKnowledgeAggregateService.test.js]
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-8]
		propertyIds: [INV-2, INV-3, INV-5, INV-11, INV-13]

	- id: 4.3
		name: 门禁规则与追溯校验
		owner: Backend
		domain: domain-knowledge
		dependsOn: [4.2]
		inputs: [specs/领域聚合优化/design.md#6, specs/领域聚合优化/requirements.md]
		outputs: [apps/scripts/traceability-gate.js, apps/scripts/domain-governance-gate.js]
		requirementIds: [Req-1, Req-6, Req-8]
		propertyIds: [INV-1, INV-8, INV-11]

	- id: 4.4
		name: 检查点-spec评审与人工签核
		owner: FullStack
		domain: domain-knowledge
		dependsOn: [4.3]
		inputs: [specs/领域聚合优化/design.md#6]
		outputs: [specs/after-iteration/tasks.md]
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7, Req-8]
		propertyIds: [INV-1, INV-4, INV-5, INV-8, INV-11]
```
