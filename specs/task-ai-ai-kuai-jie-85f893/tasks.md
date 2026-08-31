# 任务拆解文档

## 迭代信息
- 功能名称: AI快捷对话
- 迭代目录: specs/task-ai-ai-kuai-jie-85f893/
- 规划模式: standard
- canonical domain: ai-quick-chat

## 既有资源声明（如有）
- 已有需求文档: specs/task-ai-ai-kuai-jie-85f893/requirements.md
- 已有设计文档: specs/task-ai-ai-kuai-jie-85f893/design.md
- 可复用实现参考: apps/src/webviewTemplates.ts, apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts, apps/src/models.ts, apps/src/services/featureStoreService.ts, apps/src/services/harnessActionsService.ts, apps/src/services/aiDispatchService.ts, apps/src/extension.ts
- 可选测试上下文: specs/task-ai-ai-kuai-jie-85f893/testcase.md, tests/test-manifest.json（缺失不阻断本阶段）

## 任务清单（按依赖顺序执行）

### 并行执行说明
- 阶段 3 中，3.2 与 3.3 允许并行推进：3.2 聚焦按钮渲染与无效过滤，3.3 聚焦初始化注入与只读联动；3.4 作为汇合检查点依赖 3.2 与 3.3 均完成。
- 阶段 5 中，5.2 保持依赖 5.1，以确保主从同步链路完成后再执行 Req-5 相关一致性回归。
- [x] 1.1 建立需求-设计追溯基线（1h）
	- Owner: FullStack
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-1, specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-2, specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-3, specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-4, specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-5, specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性]
	- 输出: [.harness/process/traceability-baseline.md]
	- 验收: GIVEN Req-1..Req-5 与 INV-1..INV-9 已输入 WHEN 完成基线整理 THEN 每个 Req 至少映射 1 个后续任务且每个任务标注对应不变量
	- 追踪: Req-1,Req-2,Req-3,Req-4,Req-5 + INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7,INV-8,INV-9

- [x] 1.2 检查点-需求与设计冻结（1h）
	- Owner: FullStack
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/requirements.md, specs/task-ai-ai-kuai-jie-85f893/design.md, .harness/process/traceability-baseline.md]
	- 输出: [.harness/process/checkpoint-1.2-requirements-design-freeze.md]
	- 验收: GIVEN 追溯基线已完成 WHEN 执行检查点冻结 THEN 冻结记录包含范围、依赖顺序、风险与阻断条件
	- 追踪: Req-1,Req-2,Req-3,Req-4,Req-5 + INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7,INV-8,INV-9

- [x] 2.1 扩展消息契约与类型模型（1h）
	- Owner: Backend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.1-API-契约, specs/task-ai-ai-kuai-jie-85f893/design.md#3.3-数据模型]
	- 输出: [apps/src/harnessMessages.ts, apps/src/models.ts]
	- 验收: GIVEN saveAiQuickChatButtons 与 runAiQuickChatButton 契约已定义 WHEN 更新消息与类型声明 THEN 字段、枚举与约束边界可被调用方静态识别
	- 追踪: Req-1,Req-2,Req-3,Req-4,Req-5 + INV-1,INV-2,INV-3,INV-5

- [x] 2.2 实现配置归一化与持久化合并（1h）
	- Owner: Backend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.5-Store-设计, specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性]
	- 输出: [apps/src/models.ts, apps/src/services/featureStoreService.ts]
	- 验收: GIVEN 保存输入包含空白/超长/缺省字段 WHEN 执行归一化与持久化 THEN 无效项被拒绝且 aiQuickChatButtons 写入不影响其他配置字段
	- 追踪: Req-1,Req-2 + INV-1,INV-2,INV-3

- [x] 2.3 接入保存路由与只读拒绝分支（1h）
	- Owner: Backend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#2.3-路由设计, specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理]
	- 输出: [apps/src/harnessMessageController.ts, apps/src/extension.ts]
	- 验收: GIVEN 快照窗口发起保存 WHEN 执行保存路由 THEN 返回只读拒绝并且不发生配置写入
	- 追踪: Req-1,Req-2,Req-5 + INV-1,INV-3,INV-7

- [x] 2.4 检查点-配置契约与只读门禁（1h）
	- Owner: FullStack
	- 输入: [apps/src/harnessMessages.ts, apps/src/models.ts, apps/src/services/featureStoreService.ts, apps/src/harnessMessageController.ts, apps/src/extension.ts]
	- 输出: [.harness/process/checkpoint-2.4-config-contract-readonly-gate.md]
	- 验收: GIVEN 阶段 2 任务完成 WHEN 执行门禁核对 THEN 记录包含保存契约、只读拒绝、字段兼容与回退行为
	- 追踪: Req-1,Req-2,Req-5 + INV-1,INV-2,INV-3,INV-7

- [x] 3.1 构建设置区编辑与校验交互（1h）
	- Owner: Frontend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.4-组件-Props-Events, specs/task-ai-ai-kuai-jie-85f893/design.md#6-安全基线]
	- 输出: [apps/src/webviewTemplates.ts]
	- 验收: GIVEN 用户新增编辑删除快捷对话按钮 WHEN 触发保存 THEN 名称与内容空白/超长被明确提示且不提交非法数据
	- 追踪: Req-1 + INV-1

- [x] 3.2 渲染旁路按钮并过滤无效项（1h）
	- Owner: Frontend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.4-组件-Props-Events, specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性]
	- 输出: [apps/src/webviewTemplates.ts]
  - 验收: GIVEN 存在有效与无效混合配置 WHEN 渲染任务卡片旁路区 THEN 仅有效按钮显示且与自定义按钮并列复用相同样式容器；GIVEN 未配置任何 AI 快捷对话按钮 WHEN 渲染任务卡片 THEN 旁路操作区不输出 AI 快捷对话按钮节点且无报错
	- 追踪: Req-3 + INV-4,INV-9

- [x] 3.3 接入初始化注入与只读提示联动（1h）
	- Owner: FullStack
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#2.3-路由设计, specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理]
	- 输出: [apps/src/webviewTemplates.ts, apps/src/harnessMessageController.ts]
	- 验收: GIVEN configBootstrap 返回 aiQuickChatButtons 与 readonly 状态 WHEN Webview 初始化 THEN 配置回显正确且只读提示与保存行为一致
	- 追踪: Req-2,Req-5 + INV-3,INV-7

- [x] 3.4 检查点-Webview 渲染与交互冻结（1h）
	- Owner: FullStack
	- 输入: [apps/src/webviewTemplates.ts, apps/src/harnessMessageController.ts]
	- 输出: [.harness/process/checkpoint-3.4-webview-render-interaction-freeze.md]
	- 验收: GIVEN 阶段 3 完成 WHEN 执行检查点 THEN 冻结记录覆盖渲染一致性、只读提示、输入校验与容器复用
	- 追踪: Req-1,Req-2,Req-3,Req-5 + INV-1,INV-3,INV-4,INV-7,INV-9

- [x] 4.1 实现点击路由到按钮解析（1h）
	- Owner: Backend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.2-派发适配契约, specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理]
	- 输出: [apps/src/harnessMessageController.ts, apps/src/services/harnessActionsService.ts]
	- 验收: GIVEN 用户点击 runAiQuickChatButton WHEN 根据 taskId 与 buttonId 解析上下文 THEN 能定位按钮并给出 accepted 或失败原因
	- 追踪: Req-4 + INV-5,INV-6

- [x] 4.2 接入 AI 派发映射与原文发送（1h）
	- Owner: Backend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.2-派发适配契约, specs/task-ai-ai-kuai-jie-85f893/design.md#3.1-API-契约]
	- 输出: [apps/src/services/harnessActionsService.ts, apps/src/services/aiDispatchService.ts]
	- 验收: GIVEN 按钮 content 含换行与 Unicode WHEN 执行 dispatch THEN query 与保存 content 逐字符一致且 source 标记为 quick-chat-button
	- 追踪: Req-4 + INV-5

- [x] 4.3 实现失败可感知提示与异常兜底（1h）
	- Owner: FullStack
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理, specs/task-ai-ai-kuai-jie-85f893/design.md#6-安全基线]
	- 输出: [apps/src/harnessMessageController.ts, apps/src/webviewTemplates.ts]
	- 验收: GIVEN 按钮失效或派发失败 WHEN 执行点击流程 THEN 显示可感知失败提示且无未捕获异常
	- 追踪: Req-4 + INV-6

- [x] 4.4 检查点-派发链路冻结（1h）
	- Owner: FullStack
	- 输入: [apps/src/harnessMessageController.ts, apps/src/services/harnessActionsService.ts, apps/src/services/aiDispatchService.ts, apps/src/webviewTemplates.ts]
	- 输出: [.harness/process/checkpoint-4.4-dispatch-chain-freeze.md]
	- 验收: GIVEN 阶段 4 完成 WHEN 核对派发链路 THEN 记录包含上下文绑定、逐字符发送、失败提示与异常兜底
	- 追踪: Req-4 + INV-5,INV-6

- [x] 5.1 完成主从配置同步链路（1h）
	- Owner: Backend
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/design.md#3.1-API-契约, specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性]
	- 输出: [apps/src/services/featureStoreService.ts, apps/src/extension.ts]
	- 验收: GIVEN 主窗口保存 aiQuickChatButtons WHEN 同步到 worktree 快照 THEN 快照配置与主窗口最终一致
	- 追踪: Req-5 + INV-8

- [x] 5.2 新增与更新自动化测试（2h）
	- Owner: FullStack
	- 输入: [specs/task-ai-ai-kuai-jie-85f893/requirements.md, specs/task-ai-ai-kuai-jie-85f893/design.md#7-测试策略]
	- 输出: [apps/test/featureStoreService.test.js, apps/test/harnessActionsDomainPreflight.test.js, apps/test/reviewStageInjection.test.js, apps/test/aiDispatchService.test.js, apps/test/harnessActionsFinalGate.test.js, apps/test/workspaceRoot.test.js]
  - 验收: GIVEN Req-1..Req-5 对应场景 WHEN 执行测试 THEN 校验覆盖保存校验、持久化加载、渲染过滤、点击派发、只读拒绝与同步一致性，并包含“未配置按钮时旁路区无占位且无报错”的独立断言
  - 测试文件-需求映射: apps/test/featureStoreService.test.js -> Req-1,Req-2,Req-5；apps/test/harnessActionsDomainPreflight.test.js -> Req-4；apps/test/reviewStageInjection.test.js -> Req-3；apps/test/aiDispatchService.test.js -> Req-4；apps/test/harnessActionsFinalGate.test.js -> Req-4,Req-5；apps/test/workspaceRoot.test.js -> Req-5
	- 追踪: Req-1,Req-2,Req-3,Req-4,Req-5 + INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7,INV-8,INV-9

- [x] 5.3 编译与脚本校验（1h）
	- Owner: FullStack
	- 输入: [apps/package.json, apps/scripts/validate-webview.js]
	- 输出: [.harness/process/verification-compile-guard.md, .harness/process/verification-webview-validation.md]
	- 验收: GIVEN 所有改动已完成 WHEN 运行 compile:guard 与 webview 校验 THEN 记录包含命令、结果与失败分支处理
	- 追踪: Req-1,Req-2,Req-3,Req-4,Req-5 + INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7,INV-8,INV-9

- [x] 5.4 最终检查点与交付清单（1h）
	- Owner: FullStack
	- 输入: [.harness/process/checkpoint-1.2-requirements-design-freeze.md, .harness/process/checkpoint-2.4-config-contract-readonly-gate.md, .harness/process/checkpoint-3.4-webview-render-interaction-freeze.md, .harness/process/checkpoint-4.4-dispatch-chain-freeze.md, .harness/process/verification-compile-guard.md, .harness/process/verification-webview-validation.md]
	- 输出: [.harness/process/final-gate-checklist.md]
	- 验收: GIVEN 所有阶段检查点与验证记录齐备 WHEN 形成交付清单 THEN 任务依赖闭环、追溯闭环、门禁状态可审计
	- 追踪: Req-1,Req-2,Req-3,Req-4,Req-5 + INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7,INV-8,INV-9

## 机器可读区
```yaml
artifactType: tasks
taskName: AI快捷对话
tasks:
  - id: 1.1
    name: 建立需求设计追溯基线
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: []
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-1
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-2
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-3
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-4
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md#Req-5
      - specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性
    outputs:
      - .harness/process/traceability-baseline.md
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9]
  - id: 1.2
    name: 冻结需求与设计检查点
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [1.1]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md
      - specs/task-ai-ai-kuai-jie-85f893/design.md
      - .harness/process/traceability-baseline.md
    outputs:
      - .harness/process/checkpoint-1.2-requirements-design-freeze.md
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9]
  - id: 2.1
    name: 扩展消息契约与类型模型
    owner: Backend
    domain: ai-quick-chat
    dependsOn: [1.2]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.1-API-契约
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.3-数据模型
    outputs:
      - apps/src/harnessMessages.ts
      - apps/src/models.ts
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-5]
  - id: 2.2
    name: 实现配置归一化与持久化合并
    owner: Backend
    domain: ai-quick-chat
    dependsOn: [2.1]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.5-Store-设计
      - specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性
    outputs:
      - apps/src/models.ts
      - apps/src/services/featureStoreService.ts
    requirementIds: [Req-1, Req-2]
    propertyIds: [INV-1, INV-2, INV-3]
  - id: 2.3
    name: 接入保存路由与只读拒绝分支
    owner: Backend
    domain: ai-quick-chat
    dependsOn: [2.2]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#2.3-路由设计
      - specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理
    outputs:
      - apps/src/harnessMessageController.ts
      - apps/src/extension.ts
    requirementIds: [Req-1, Req-2, Req-5]
    propertyIds: [INV-1, INV-3, INV-7]
  - id: 2.4
    name: 配置契约与只读门禁检查点
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [2.3]
    inputs:
      - apps/src/harnessMessages.ts
      - apps/src/models.ts
      - apps/src/services/featureStoreService.ts
      - apps/src/harnessMessageController.ts
      - apps/src/extension.ts
    outputs:
      - .harness/process/checkpoint-2.4-config-contract-readonly-gate.md
    requirementIds: [Req-1, Req-2, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-7]
  - id: 3.1
    name: 构建设置区编辑与校验交互
    owner: Frontend
    domain: ai-quick-chat
    dependsOn: [2.4]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.4-组件-Props-Events
      - specs/task-ai-ai-kuai-jie-85f893/design.md#6-安全基线
    outputs:
      - apps/src/webviewTemplates.ts
    requirementIds: [Req-1]
    propertyIds: [INV-1]
  - id: 3.2
    name: 渲染旁路按钮并过滤无效项
    owner: Frontend
    domain: ai-quick-chat
    dependsOn: [3.1]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.4-组件-Props-Events
      - specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性
    outputs:
      - apps/src/webviewTemplates.ts
    requirementIds: [Req-3]
    propertyIds: [INV-4, INV-9]
  - id: 3.3
    name: 接入初始化注入与只读提示联动
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [2.4]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#2.3-路由设计
      - specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理
    outputs:
      - apps/src/webviewTemplates.ts
      - apps/src/harnessMessageController.ts
    requirementIds: [Req-2, Req-5]
    propertyIds: [INV-3, INV-7]
  - id: 3.4
    name: Webview 渲染与交互检查点
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [3.2, 3.3]
    inputs:
      - apps/src/webviewTemplates.ts
      - apps/src/harnessMessageController.ts
    outputs:
      - .harness/process/checkpoint-3.4-webview-render-interaction-freeze.md
    requirementIds: [Req-1, Req-2, Req-3, Req-5]
    propertyIds: [INV-1, INV-3, INV-4, INV-7, INV-9]
  - id: 4.1
    name: 实现点击路由到按钮解析
    owner: Backend
    domain: ai-quick-chat
    dependsOn: [3.4]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.2-派发适配契约
      - specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理
    outputs:
      - apps/src/harnessMessageController.ts
      - apps/src/services/harnessActionsService.ts
    requirementIds: [Req-4]
    propertyIds: [INV-5, INV-6]
  - id: 4.2
    name: 接入 AI 派发映射与原文发送
    owner: Backend
    domain: ai-quick-chat
    dependsOn: [4.1]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.2-派发适配契约
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.1-API-契约
    outputs:
      - apps/src/services/harnessActionsService.ts
      - apps/src/services/aiDispatchService.ts
    requirementIds: [Req-4]
    propertyIds: [INV-5]
  - id: 4.3
    name: 实现失败可感知提示与异常兜底
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [4.2]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#5-错误处理
      - specs/task-ai-ai-kuai-jie-85f893/design.md#6-安全基线
    outputs:
      - apps/src/harnessMessageController.ts
      - apps/src/webviewTemplates.ts
    requirementIds: [Req-4]
    propertyIds: [INV-6]
  - id: 4.4
    name: 派发链路检查点
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [4.3]
    inputs:
      - apps/src/harnessMessageController.ts
      - apps/src/services/harnessActionsService.ts
      - apps/src/services/aiDispatchService.ts
      - apps/src/webviewTemplates.ts
    outputs:
      - .harness/process/checkpoint-4.4-dispatch-chain-freeze.md
    requirementIds: [Req-4]
    propertyIds: [INV-5, INV-6]
  - id: 5.1
    name: 完成主从配置同步链路
    owner: Backend
    domain: ai-quick-chat
    dependsOn: [4.4]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/design.md#3.1-API-契约
      - specs/task-ai-ai-kuai-jie-85f893/design.md#4-正确性属性
    outputs:
      - apps/src/services/featureStoreService.ts
      - apps/src/extension.ts
    requirementIds: [Req-5]
    propertyIds: [INV-8]
  - id: 5.2
    name: 新增与更新自动化测试
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [5.1]
    inputs:
      - specs/task-ai-ai-kuai-jie-85f893/requirements.md
      - specs/task-ai-ai-kuai-jie-85f893/design.md#7-测试策略
    outputs:
      - apps/test/featureStoreService.test.js
      - apps/test/harnessActionsDomainPreflight.test.js
      - apps/test/reviewStageInjection.test.js
      - apps/test/aiDispatchService.test.js
      - apps/test/harnessActionsFinalGate.test.js
      - apps/test/workspaceRoot.test.js
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9]
  - id: 5.3
    name: 编译与脚本校验
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [5.2]
    inputs:
      - apps/package.json
      - apps/scripts/validate-webview.js
    outputs:
      - .harness/process/verification-compile-guard.md
      - .harness/process/verification-webview-validation.md
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9]
  - id: 5.4
    name: 最终检查点与交付清单
    owner: FullStack
    domain: ai-quick-chat
    dependsOn: [5.3]
    inputs:
      - .harness/process/checkpoint-1.2-requirements-design-freeze.md
      - .harness/process/checkpoint-2.4-config-contract-readonly-gate.md
      - .harness/process/checkpoint-3.4-webview-render-interaction-freeze.md
      - .harness/process/checkpoint-4.4-dispatch-chain-freeze.md
      - .harness/process/verification-compile-guard.md
      - .harness/process/verification-webview-validation.md
    outputs:
      - .harness/process/final-gate-checklist.md
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9]
```
