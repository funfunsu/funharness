# 任务拆解文档
## 迭代信息
- 任务名: better-project-structure
- 拆分模式: standard
- 规划范围: 仅覆盖样例驱动结构提取、颗粒度控制、提示词契约、质量门禁、追溯闭环相关改造
- 规划原则: 小步可执行、按依赖顺序、每项任务可在小时级完成并可独立验收

## 既有资源声明（如有）
- 已存在输入: requirements.md、design.md
- 可选输入缺失且不阻断: testcase.md、tests/test-manifest.json
- 说明: 本次任务拆解采用 design -> tasks 直连模式，测试相关任务按需求/设计逻辑纳入，不依赖可选测试清单文件

## 任务清单（严格按依赖顺序执行）
- [x] 0.1 [Checkpoint] 基线对齐与任务边界确认（0.5h）
	- Owner: FullStack
	- 输入: 需求文档#需求清单，设计文档#1 概述
	- 输出: 任务边界确认记录（仅阶段内使用）
	- 验收: 能明确本迭代仅涉及结构提取链路改造，且 Req-1~Req-5 全部纳入计划
	- 追踪: Requirements[Req-1, Req-2, Req-3, Req-4, Req-5] + Properties[INV-1, INV-2, INV-3, INV-4, INV-5]

- [x] 1.1 定义样例配置契约与加载入口（1.5h）
	- Owner: Backend
	- 输入: 设计文档#3.1 API-1，设计文档#3.2 Model-1
	- 输出: 样例配置契约定义与加载入口方案（projectStructureService/promptService 相关模块）
	- 验收: 可唯一解析 sampleProfileId；样例内容可被提取流程读取
	- 追踪: Requirements[Req-1] + Properties[INV-1]

- [x] 1.2 实现样例缺失失败协议接入（1.0h）
	- Owner: Backend
	- 输入: 设计文档#5 E-1，设计文档#4 INV-1
	- 输出: SAMPLE_PROFILE_UNAVAILABLE 错误分支接入消息回传链路
	- 验收: 样例文件缺失/不可读时流程显式失败并返回路径与修复建议
	- 追踪: Requirements[Req-1] + Properties[INV-1]

- [x] 1.3 [Checkpoint] 样例驱动输入可用性评审（0.5h）
	- Owner: FullStack
	- 输入: 任务 1.1, 1.2 输出
	- 输出: 样例输入阶段检查结论
	- 验收: 样例可注入且失败协议可触发，无伪成功信号
	- 追踪: Requirements[Req-1] + Properties[INV-1]

- [x] 2.1 建立颗粒度规则集映射（1.5h）
	- Owner: Backend
	- 输入: 设计文档#3.2 Model-2，设计文档#2.2 项目目录结构
	- 输出: maxDepth/mustExpandDomains/collapsePatterns 到提取流程的规则映射
	- 验收: 提取流程可读取 granularityProfileId 并解析对应规则集
	- 追踪: Requirements[Req-2] + Properties[INV-2]

- [x] 2.2 接入目录归并与关键域展开策略（2.0h）
	- Owner: Backend
	- 输入: 设计文档#4 INV-2，设计文档#5 E-2
	- 输出: 重复目录归并与关键域强制展开处理链路
	- 验收: 满足深度约束且关键域可展开；规则冲突时返回 GRANULARITY_RULE_CONFLICT
	- 追踪: Requirements[Req-2] + Properties[INV-2]

- [x] 3.1 重构提示词装配为样例+规则+输出契约三段式（1.5h）
	- Owner: Backend
	- 输入: 设计文档#3.1 API-1，设计文档#4 INV-3
	- 输出: Prompt 组装策略更新（promptService/aiDispatchService 相关模块）
	- 验收: 请求体稳定包含样例块、规则块、输出契约块
	- 追踪: Requirements[Req-3] + Properties[INV-3]

- [x] 3.2 接入提示词契约缺失阻断机制（1.0h）
	- Owner: Backend
	- 输入: 设计文档#5 E-3，设计文档#4 INV-3
	- 输出: PROMPT_CONTRACT_INCOMPLETE 错误分支与阻断逻辑
	- 验收: 三段中任一缺失时不得发送 AI 请求
	- 追踪: Requirements[Req-3] + Properties[INV-3]

- [x] 3.3 [Checkpoint] 提取链路契约稳定性检查（0.5h）
	- Owner: FullStack
	- 输入: 任务 2.1, 2.2, 3.1, 3.2 输出
	- 输出: 契约字段稳定性检查记录
	- 验收: 输出契约字段未破坏既有约定，且样例驱动链路可端到端执行
	- 追踪: Requirements[Req-2, Req-3] + Properties[INV-2, INV-3]

- [x] 4.1 实现结构质量校验器与门禁判定（2.0h）
	- Owner: Backend
	- 输入: 设计文档#3.1 API-2，设计文档#4 INV-4
	- 输出: requiredSections/requiredFields 校验器与 gateStatus 判定逻辑
	- 验收: 缺失必填结构时 gateStatus=failed 且阻断产物写入
	- 追踪: Requirements[Req-4] + Properties[INV-4]

- [x] 4.2 接入门禁失败日志规范（1.0h）
	- Owner: FullStack
	- 输入: 设计文档#5 E-4
	- 输出: 失败日志字段（gateId/violations/定位信息/修复建议）
	- 验收: 门禁失败日志可用于精确定位问题且可审计
	- 追踪: Requirements[Req-4] + Properties[INV-4]

- [x] 5.1 实现 Req-* 追溯矩阵刷新与断裂检测（1.5h）
	- Owner: Backend
	- 输入: 设计文档#3.1 API-3，设计文档#3.2 Model-4，设计文档#4 INV-5
	- 输出: traceMatrix 聚合与 orphanChanges 检测逻辑
	- 验收: 每个 Req-* 可输出映射；无映射时返回 TRACE_CLOSURE_BROKEN
	- 追踪: Requirements[Req-5] + Properties[INV-5]

- [x] 5.2 [Checkpoint] 追溯闭环与阶段门禁联调（1.0h）
	- Owner: FullStack
	- 输入: 任务 4.1, 4.2, 5.1 输出
	- 输出: 门禁联调记录与阻断场景清单
	- 验收: 门禁失败可阻断后续阶段，追溯断裂可被稳定识别
	- 追踪: Requirements[Req-4, Req-5] + Properties[INV-4, INV-5]

- [x] 6.1 构建最小测试任务集（按需求逻辑）并执行自检（1.5h）
	- Owner: FullStack
	- 输入: 设计文档#6 测试策略，任务 1.x-5.x 输出
	- 输出: 覆盖 TS-1~TS-5 的执行记录（不依赖可选 testcase 清单文件）
	- 验收: Req-1~Req-5 均有可验证测试证据，失败场景与成功场景均可复现
	- 追踪: Requirements[Req-1, Req-2, Req-3, Req-4, Req-5] + Properties[INV-1, INV-2, INV-3, INV-4, INV-5]

- [x] 6.2 [Checkpoint] 任务阶段完成评审（0.5h）
	- Owner: FullStack
	- 输入: 全部任务输出
	- 输出: 任务阶段签核结论（进入开发阶段的输入包）
	- 验收: 依赖顺序已闭环、Req 与不变量追踪完整、无越界改造项
	- 追踪: Requirements[Req-1, Req-2, Req-3, Req-4, Req-5] + Properties[INV-1, INV-2, INV-3, INV-4, INV-5]

## 机器可读区
```yaml
artifactType: tasks
taskName: better-project-structure
tasks:
  - id: 0.1
    name: 基线对齐与任务边界确认
    owner: FullStack
    dependsOn: []
    inputs: [specs/better-project-structure/requirements.md#需求清单, specs/better-project-structure/design.md#1-概述]
    outputs: [阶段任务边界确认记录]
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5]
    checkpoint: true
    estimateHours: 0.5

  - id: 1.1
    name: 定义样例配置契约与加载入口
    owner: Backend
    dependsOn: [0.1]
    inputs: [specs/better-project-structure/design.md#3.1-API-契约, specs/better-project-structure/design.md#3.2-数据模型]
    outputs: [apps/src/services/projectStructureService.ts, apps/src/services/promptService.ts]
    requirementIds: [Req-1]
    propertyIds: [INV-1]
    checkpoint: false
    estimateHours: 1.5

  - id: 1.2
    name: 实现样例缺失失败协议接入
    owner: Backend
    dependsOn: [1.1]
    inputs: [specs/better-project-structure/design.md#5-错误处理, specs/better-project-structure/design.md#4-正确性属性]
    outputs: [apps/src/harnessMessageController.ts, apps/src/services/projectStructureService.ts]
    requirementIds: [Req-1]
    propertyIds: [INV-1]
    checkpoint: false
    estimateHours: 1.0

  - id: 1.3
    name: 样例驱动输入可用性评审
    owner: FullStack
    dependsOn: [1.2]
    inputs: [任务1.1输出, 任务1.2输出]
    outputs: [样例输入阶段检查结论]
    requirementIds: [Req-1]
    propertyIds: [INV-1]
    checkpoint: true
    estimateHours: 0.5

  - id: 2.1
    name: 建立颗粒度规则集映射
    owner: Backend
    dependsOn: [1.3]
    inputs: [specs/better-project-structure/design.md#3.2-数据模型, specs/better-project-structure/design.md#2.2-项目目录结构]
    outputs: [apps/src/services/projectStructureService.ts, spec-delta/domain-classification-rules.yaml]
    requirementIds: [Req-2]
    propertyIds: [INV-2]
    checkpoint: false
    estimateHours: 1.5

  - id: 2.2
    name: 接入目录归并与关键域展开策略
    owner: Backend
    dependsOn: [2.1]
    inputs: [specs/better-project-structure/design.md#4-正确性属性, specs/better-project-structure/design.md#5-错误处理]
    outputs: [apps/src/services/projectStructureService.ts]
    requirementIds: [Req-2]
    propertyIds: [INV-2]
    checkpoint: false
    estimateHours: 2.0

  - id: 3.1
    name: 重构提示词装配为三段式
    owner: Backend
    dependsOn: [2.2]
    inputs: [specs/better-project-structure/design.md#3.1-API-契约, specs/better-project-structure/design.md#4-正确性属性]
    outputs: [apps/src/services/promptService.ts, apps/src/services/aiDispatchService.ts]
    requirementIds: [Req-3]
    propertyIds: [INV-3]
    checkpoint: false
    estimateHours: 1.5

  - id: 3.2
    name: 接入提示词契约缺失阻断机制
    owner: Backend
    dependsOn: [3.1]
    inputs: [specs/better-project-structure/design.md#5-错误处理, specs/better-project-structure/design.md#4-正确性属性]
    outputs: [apps/src/services/promptService.ts, apps/src/harnessMessageController.ts]
    requirementIds: [Req-3]
    propertyIds: [INV-3]
    checkpoint: false
    estimateHours: 1.0

  - id: 3.3
    name: 提取链路契约稳定性检查
    owner: FullStack
    dependsOn: [3.2]
    inputs: [任务2.1输出, 任务2.2输出, 任务3.1输出, 任务3.2输出]
    outputs: [契约稳定性检查记录]
    requirementIds: [Req-2, Req-3]
    propertyIds: [INV-2, INV-3]
    checkpoint: true
    estimateHours: 0.5

  - id: 4.1
    name: 实现结构质量校验器与门禁判定
    owner: Backend
    dependsOn: [3.3]
    inputs: [specs/better-project-structure/design.md#3.1-API-契约, specs/better-project-structure/design.md#4-正确性属性]
    outputs: [apps/src/services/specDeltaService.ts, apps/src/services/projectStructureService.ts]
    requirementIds: [Req-4]
    propertyIds: [INV-4]
    checkpoint: false
    estimateHours: 2.0

  - id: 4.2
    name: 接入门禁失败日志规范
    owner: FullStack
    dependsOn: [4.1]
    inputs: [specs/better-project-structure/design.md#5-错误处理]
    outputs: [apps/src/harnessMessageController.ts, apps/src/services/harnessLog.ts]
    requirementIds: [Req-4]
    propertyIds: [INV-4]
    checkpoint: false
    estimateHours: 1.0

  - id: 5.1
    name: 实现Req追溯矩阵刷新与断裂检测
    owner: Backend
    dependsOn: [4.2]
    inputs: [specs/better-project-structure/design.md#3.1-API-契约, specs/better-project-structure/design.md#3.2-数据模型, specs/better-project-structure/design.md#4-正确性属性]
    outputs: [apps/src/specTrace.ts, apps/src/services/taskStoreService.ts]
    requirementIds: [Req-5]
    propertyIds: [INV-5]
    checkpoint: false
    estimateHours: 1.5

  - id: 5.2
    name: 追溯闭环与阶段门禁联调
    owner: FullStack
    dependsOn: [5.1]
    inputs: [任务4.1输出, 任务4.2输出, 任务5.1输出]
    outputs: [门禁联调记录与阻断场景清单]
    requirementIds: [Req-4, Req-5]
    propertyIds: [INV-4, INV-5]
    checkpoint: true
    estimateHours: 1.0

  - id: 6.1
    name: 构建最小测试任务集并执行自检
    owner: FullStack
    dependsOn: [5.2]
    inputs: [specs/better-project-structure/design.md#6-测试策略, 任务1.x至5.x输出]
    outputs: [TS-1至TS-5测试执行记录]
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5]
    checkpoint: false
    estimateHours: 1.5

  - id: 6.2
    name: 任务阶段完成评审
    owner: FullStack
    dependsOn: [6.1]
    inputs: [全部任务输出]
    outputs: [任务阶段签核结论]
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5]
    checkpoint: true
    estimateHours: 0.5
```
