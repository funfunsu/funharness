# 任务拆解文档

## 迭代信息

- 功能名称：domain-knowledge
- 任务拆分模式：compact
- 需求来源：`specs/domain-knowledge/requirements.md`（Req-dk-1 ~ Req-dk-12）
- 设计来源：`specs/domain-knowledge/design.md`（API-DK-1 ~ API-DK-12，INV-DK-1 ~ INV-DK-15）
- 目标：为领域知识库构建落地一条“两段式”执行链路，先在 worktree 生成 `capability-delta.json`，再由主面板单写者聚合到 `docs/domains/`，并补齐注册表、疑似新领域裁决、幂等状态、索引和验证闭环。
- 可选测试输入：`specs/domain-knowledge/testcase.md` 缺失；`tests/test-manifest.json` 缺失；本次按 `design -> tasks` 直接规划，不将其视为阻塞项。

## 既有资源声明（如有）

- 已有 `specDeltaService.ts`：可复用对 requirements/design/delta 产物的读取与解析能力。
- 已有 `workspaceRoot.ts`：可复用当前仓库根目录解析，满足 monoRepo / multiRepo 路径约束。
- 已有 `fileOps.ts`：可复用文件读写与标记块更新工具，避免重复实现文件操作细节。
- 已有 `promptService.ts`：可承接主面板可选 AI 润色提示词构建。
- 已有 `harnessMessageController.ts`、`extension.ts`、`harnessActionsService.ts`：可扩展命令、消息与人工裁决交互入口。

## 任务清单（严格按依赖顺序执行）

- [x] 1.1 建立领域注册表模型与校验服务
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#3.2`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/models.ts`、`apps/src/services/domainRegistryService.ts`
	- 验收: 能加载/初始化 `docs/domains/registry.yaml`；能校验重复 `canonical` 与 alias 冲突；按当前仓库根目录解析路径
	- 追踪: Req-dk-1 + INV-DK-1, INV-DK-15

- [x] 1.2 实现领域归一化与疑似新领域判定
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/services/domainRegistryService.ts`
	- 验收: 归一化顺序满足 `explicit -> canonical -> alias -> fallback`；未命中时返回 `isSuspectedNew=true`；不自动创建新领域
	- 追踪: Req-dk-2 + Req-dk-7 + INV-DK-2, INV-DK-9

- [x] 1.3 ✅ 检查点：注册表与归类契约完成
	- Owner: Backend
	- 输入: 任务 1.1 ~ 1.2 产出
	- 输出: 领域注册表服务可被抽取器与聚合器共同消费
	- 验收: registry 初始化、冲突阻断、归一化三类契约可独立验证
	- 追踪: Req-dk-1 + Req-dk-2 + Req-dk-7

- [x] 2.1 实现 capability-delta 数据模型与 schema 校验
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#3.2`
	- 输出: `apps/src/models.ts`、`apps/src/services/capabilityDeltaService.ts`
	- 验收: `CapabilityDelta`、`DomainDelta`、`contentHash`、稳定排序规则落地；缺失必填字段时校验失败
	- 追踪: Req-dk-5 + Req-dk-8 + INV-DK-10

- [x] 2.2 实现 worktree 侧确定性抽取器
	- Owner: Backend
	- 输入: `specs/domain-knowledge/requirements.md`、`specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/services/capabilityDeltaService.ts`
	- 验收: 仅从当前迭代 requirements/design 抽取 capabilities/contracts/invariants；零 AI 调用；输出写入 `specs/<iteration>/delta/capability-delta.json`
	- 追踪: Req-dk-5 + Req-dk-12 + INV-DK-7, INV-DK-13, INV-DK-14

- [x] 2.3 接入 worktree 消息路由并限制变更边界
	- Owner: FullStack
	- 输入: `specs/domain-knowledge/design.md#2.3`、`specs/domain-knowledge/design.md#3.3`
	- 输出: `apps/src/harnessMessages.ts`、`apps/src/harnessMessageController.ts`、`apps/src/extension.ts`
	- 验收: worktree 仅暴露 `generateCapabilityDelta`；不注册主面板聚合入口；只读或无迭代上下文时禁用
	- 追踪: Req-dk-5 + INV-DK-7

- [x] 2.4 ✅ 检查点：worktree 抽取链路完成
	- Owner: Backend
	- 输入: 任务 2.1 ~ 2.3 产出
	- 输出: worktree 可稳定生成并校验 `capability-delta.json`
	- 验收: 相同输入重复生成 `contentHash` 一致；无能力直接写入 `docs/domains/`
	- 追踪: Req-dk-5 + Req-dk-12

- [x] 3.1 实现领域文档模板解析与标记块 upsert 引擎
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#3.2`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/services/domainKnowledgeAggregateService.ts`、`apps/src/services/fileOps.ts`
	- 验收: 能创建 `docs/domains/<domain>.md` 模板；仅更新 `AUTO:*`；`HUMAN:*` 逐字节保留；能力/契约/不变量分别按主键 upsert
	- 追踪: Req-dk-3 + Req-dk-4 + Req-dk-9 + INV-DK-3, INV-DK-4, INV-DK-5, INV-DK-6, INV-DK-11

- [x] 3.2 实现主面板聚合器与幂等状态跟踪
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#3.4`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/services/domainKnowledgeAggregateService.ts`、`apps/src/services/domainRegistryService.ts`
	- 验收: 仅消费 `capability-delta.json`；按 `iteration + contentHash` 跳过已入库项；已变更 hash 可重新聚合；状态持久化更新
	- 追踪: Req-dk-6 + Req-dk-8 + INV-DK-8, INV-DK-10, INV-DK-15

- [x] 3.3 实现疑似新领域收集与人工裁决写回
	- Owner: FullStack
	- 输入: `specs/domain-knowledge/design.md#2.3`、`specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#3.4`
	- 输出: `apps/src/services/domainKnowledgeAggregateService.ts`、`apps/src/services/domainRegistryService.ts`、`apps/src/services/harnessActionsService.ts`、`apps/src/extension.ts`
	- 验收: 未命中注册表的领域进入待确认清单；主面板支持合并现有领域/创建 canonical/追加 alias；未裁决项不写正式领域文档
	- 追踪: Req-dk-7 + INV-DK-9

- [x] 3.4 实现 `_index.md` 总览与说明更新
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/services/domainKnowledgeAggregateService.ts`
	- 验收: `_index.md` 可自动创建；顶部写明人工仅编辑 `HUMAN:*`；每个 `canonical` 仅一行摘要并按 upsert 更新
	- 追踪: Req-dk-10 + INV-DK-12

- [x] 3.5 ✅ 检查点：主面板聚合主链完成
	- Owner: Backend
	- 输入: 任务 3.1 ~ 3.4 产出
	- 输出: 主面板可从 delta 聚合到 registry、domain docs 和 index
	- 验收: 已知领域正常入库；未知领域进入待裁决；重复聚合不产生重复 changelog
	- 追踪: Req-dk-3 + Req-dk-4 + Req-dk-6 + Req-dk-7 + Req-dk-8 + Req-dk-10

- [x] 4.1 接入主面板命令、按钮与交互状态
	- Owner: FullStack
	- 输入: `specs/domain-knowledge/design.md#2.3`、`specs/domain-knowledge/design.md#3.3`、宪法按钮样式基线
	- 输出: `apps/src/extension.ts`、`apps/src/harnessMessageController.ts`、`apps/src/webviewTemplates.ts`、相关 UI 组件模板
	- 验收: 主面板仅提供 `Aggregate domain baselines`、`Review suspected domains`、`Preview domain index`；按钮样式满足 token/尺寸/变体/focus/disabled/loading 约束
	- 追踪: Req-dk-6 + Req-dk-7 + Req-dk-10

- [x] 4.2 接入可选 AI 润色提示词边界
	- Owner: FullStack
	- 输入: `specs/domain-knowledge/design.md#3.1`、`specs/domain-knowledge/design.md#3.3`、`specs/domain-knowledge/design.md#4`
	- 输出: `apps/src/services/promptService.ts`、`apps/src/services/domainKnowledgeAggregateService.ts`
	- 验收: 仅主面板可选启用；提示词注入 registry canonical 列表；AI 只能润色已有结构化能力摘要；失败时回退纯结构化输出
	- 追踪: Req-dk-2 + Req-dk-11 + INV-DK-13

- [x] 4.3 ✅ 检查点：治理交互与 AI 边界完成
	- Owner: FullStack
	- 输入: 任务 4.1 ~ 4.2 产出
	- 输出: 主面板治理操作闭环
	- 验收: UI 入口与 AI 边界符合设计，worktree 与主面板职责不串位
	- 追踪: Req-dk-6 + Req-dk-7 + Req-dk-11

- [x] 5.1 编写注册表、抽取器与聚合器单元测试
	- Owner: Backend
	- 输入: `specs/domain-knowledge/design.md#6`
	- 输出: `apps/test/domainRegistryService.test.js`、`apps/test/capabilityDeltaService.test.js`、`apps/test/domainKnowledgeAggregateService.test.js`
	- 验收: 覆盖 registry 冲突、显式 domain 优先、delta schema、稳定 hash、领域文档 upsert、幂等跳过、removed/deprecated 保留
	- 追踪: Req-dk-1 + Req-dk-2 + Req-dk-3 + Req-dk-4 + Req-dk-5 + Req-dk-8 + Req-dk-9

- [x] 5.2 编写编排与界面约束测试
	- Owner: FullStack
	- 输入: `specs/domain-knowledge/design.md#6`
	- 输出: `apps/test/domainKnowledgeFlow.test.js`、相关消息/命令测试
	- 验收: worktree 不暴露聚合入口；主面板聚合仅消费 delta；疑似新领域进入待裁决；AI 失败不阻断；按钮状态与入口约束可验证
	- 追踪: Req-dk-5 + Req-dk-6 + Req-dk-7 + Req-dk-10 + Req-dk-11 + Req-dk-12

- [x] 5.3 执行编译、测试与门禁回归
	- Owner: Backend
	- 输入: 任务 5.1 ~ 5.2 产出
	- 输出: 编译与测试通过记录；必要的门禁修复清单
	- 验收: `apps` 范围编译通过；新增测试通过；需求/设计/任务追踪闭环可被机器校验
	- 追踪: Req-dk-1 ~ Req-dk-12

- [x] 5.4 ✅ 检查点：交付前验证完成
	- Owner: Backend
	- 输入: 任务 5.3 产出
	- 输出: 可进入开发阶段的任务基线
	- 验收: 任务依赖闭环、测试策略落地、未出现跨阶段越界修改要求
	- 追踪: Req-dk-1 ~ Req-dk-12

## 机器可读区

```yaml
artifactType: tasks
taskName: domain-knowledge
taskSplitMode: compact
existingResources:
	- apps/src/services/specDeltaService.ts
	- apps/src/services/workspaceRoot.ts
	- apps/src/services/fileOps.ts
	- apps/src/services/promptService.ts
	- apps/src/harnessMessageController.ts
	- apps/src/extension.ts
	- apps/src/services/harnessActionsService.ts
optionalInputs:
	testcaseDoc: missing
	testManifest: missing
tasks:
	- id: 1.1
		name: 建立领域注册表模型与校验服务
		owner: Backend
		dependsOn: []
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#32-数据模型, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/models.ts, apps/src/services/domainRegistryService.ts]
		requirementIds: [Req-dk-1]
	- id: 1.2
		name: 实现领域归一化与疑似新领域判定
		owner: Backend
		dependsOn: [1.1]
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/services/domainRegistryService.ts]
		requirementIds: [Req-dk-2, Req-dk-7]
	- id: 1.3
		name: 检查点-注册表与归类契约完成
		owner: Backend
		dependsOn: [1.1, 1.2]
		inputs: []
		outputs: [domainRegistryService]
		requirementIds: [Req-dk-1, Req-dk-2, Req-dk-7]
		checkpoint: true
	- id: 2.1
		name: 实现 capability-delta 数据模型与 schema 校验
		owner: Backend
		dependsOn: [1.3]
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#32-数据模型]
		outputs: [apps/src/models.ts, apps/src/services/capabilityDeltaService.ts]
		requirementIds: [Req-dk-5, Req-dk-8]
	- id: 2.2
		name: 实现 worktree 侧确定性抽取器
		owner: Backend
		dependsOn: [2.1]
		inputs: [specs/domain-knowledge/requirements.md, specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/services/capabilityDeltaService.ts, specs/<iteration>/delta/capability-delta.json]
		requirementIds: [Req-dk-5, Req-dk-12]
	- id: 2.3
		name: 接入 worktree 消息路由并限制变更边界
		owner: FullStack
		dependsOn: [2.2]
		inputs: [specs/domain-knowledge/design.md#23-路由设计, specs/domain-knowledge/design.md#33-组件-props--events]
		outputs: [apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts, apps/src/extension.ts]
		requirementIds: [Req-dk-5]
	- id: 2.4
		name: 检查点-worktree 抽取链路完成
		owner: Backend
		dependsOn: [2.1, 2.2, 2.3]
		inputs: []
		outputs: [capability-delta-flow]
		requirementIds: [Req-dk-5, Req-dk-12]
		checkpoint: true
	- id: 3.1
		name: 实现领域文档模板解析与标记块 upsert 引擎
		owner: Backend
		dependsOn: [2.4]
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#32-数据模型, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/services/domainKnowledgeAggregateService.ts, apps/src/services/fileOps.ts]
		requirementIds: [Req-dk-3, Req-dk-4, Req-dk-9]
	- id: 3.2
		name: 实现主面板聚合器与幂等状态跟踪
		owner: Backend
		dependsOn: [3.1]
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#34-store-设计, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/services/domainKnowledgeAggregateService.ts, apps/src/services/domainRegistryService.ts]
		requirementIds: [Req-dk-6, Req-dk-8]
	- id: 3.3
		name: 实现疑似新领域收集与人工裁决写回
		owner: FullStack
		dependsOn: [3.2]
		inputs: [specs/domain-knowledge/design.md#23-路由设计, specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#34-store-设计]
		outputs: [apps/src/services/domainKnowledgeAggregateService.ts, apps/src/services/domainRegistryService.ts, apps/src/services/harnessActionsService.ts, apps/src/extension.ts]
		requirementIds: [Req-dk-7]
	- id: 3.4
		name: 实现 _index.md 总览与说明更新
		owner: Backend
		dependsOn: [3.2]
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/services/domainKnowledgeAggregateService.ts, docs/domains/_index.md]
		requirementIds: [Req-dk-10]
	- id: 3.5
		name: 检查点-主面板聚合主链完成
		owner: Backend
		dependsOn: [3.1, 3.2, 3.3, 3.4]
		inputs: []
		outputs: [domain-baseline-aggregation]
		requirementIds: [Req-dk-3, Req-dk-4, Req-dk-6, Req-dk-7, Req-dk-8, Req-dk-10]
		checkpoint: true
	- id: 4.1
		name: 接入主面板命令、按钮与交互状态
		owner: FullStack
		dependsOn: [3.5]
		inputs: [specs/domain-knowledge/design.md#23-路由设计, specs/domain-knowledge/design.md#33-组件-props--events]
		outputs: [apps/src/extension.ts, apps/src/harnessMessageController.ts, apps/src/webviewTemplates.ts]
		requirementIds: [Req-dk-6, Req-dk-7, Req-dk-10]
	- id: 4.2
		name: 接入可选 AI 润色提示词边界
		owner: FullStack
		dependsOn: [3.5]
		inputs: [specs/domain-knowledge/design.md#31-api-契约, specs/domain-knowledge/design.md#33-组件-props--events, specs/domain-knowledge/design.md#4-正确性属性需求不变量]
		outputs: [apps/src/services/promptService.ts, apps/src/services/domainKnowledgeAggregateService.ts]
		requirementIds: [Req-dk-2, Req-dk-11]
	- id: 4.3
		name: 检查点-治理交互与 AI 边界完成
		owner: FullStack
		dependsOn: [4.1, 4.2]
		inputs: []
		outputs: [main-panel-governance-flow]
		requirementIds: [Req-dk-6, Req-dk-7, Req-dk-11]
		checkpoint: true
	- id: 5.1
		name: 编写注册表、抽取器与聚合器单元测试
		owner: Backend
		dependsOn: [4.3]
		inputs: [specs/domain-knowledge/design.md#6-测试策略]
		outputs: [apps/test/domainRegistryService.test.js, apps/test/capabilityDeltaService.test.js, apps/test/domainKnowledgeAggregateService.test.js]
		requirementIds: [Req-dk-1, Req-dk-2, Req-dk-3, Req-dk-4, Req-dk-5, Req-dk-8, Req-dk-9]
	- id: 5.2
		name: 编写编排与界面约束测试
		owner: FullStack
		dependsOn: [4.3]
		inputs: [specs/domain-knowledge/design.md#6-测试策略]
		outputs: [apps/test/domainKnowledgeFlow.test.js]
		requirementIds: [Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-10, Req-dk-11, Req-dk-12]
	- id: 5.3
		name: 执行编译、测试与门禁回归
		owner: Backend
		dependsOn: [5.1, 5.2]
		inputs: [apps/package.json, specs/domain-knowledge/requirements.md, specs/domain-knowledge/design.md, specs/domain-knowledge/tasks.md]
		outputs: [build-and-test-report]
		requirementIds: [Req-dk-1, Req-dk-2, Req-dk-3, Req-dk-4, Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-8, Req-dk-9, Req-dk-10, Req-dk-11, Req-dk-12]
	- id: 5.4
		name: 检查点-交付前验证完成
		owner: Backend
		dependsOn: [5.3]
		inputs: []
		outputs: [ready-for-development-baseline]
		requirementIds: [Req-dk-1, Req-dk-2, Req-dk-3, Req-dk-4, Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-8, Req-dk-9, Req-dk-10, Req-dk-11, Req-dk-12]
		checkpoint: true
```
