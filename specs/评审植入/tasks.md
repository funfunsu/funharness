# 任务拆解文档
## 迭代信息
- 功能名称: 评审植入
- taskSplitMode: standard
- 回修轮次: 第 1 次自动回修
- 目标: 修复任务文档为空导致的门禁失败，补齐可执行任务与追溯闭环

## 既有资源声明（如有）
- 已存在并作为规划依据: specs/评审植入/requirements.md、specs/评审植入/design.md
- 可选输入缺失且不阻断本阶段: specs/评审植入/testcase.md、tests/test-manifest.json
- 规划约束: 仅输出任务拆解，不修改实现代码与领域注册文件

## 任务清单（严格按依赖顺序执行）
- [x] 1.1 建立需求-设计追溯基线
  Owner: FullStack
  输入: specs/评审植入/requirements.md#需求清单, specs/评审植入/design.md#3.1-API-契约, specs/评审植入/design.md#4.-正确性属性（需求不变量）
  输出: 追溯映射清单（Req-1..Req-4 -> API/MODEL/INV/测试点）
  验收: 生成唯一任务 ID；Req-1..Req-4 全量出现且无悬空引用；domain 仅使用 project-structure-init
  追踪: Requirements [Req-1, Req-2, Req-3, Req-4] + Properties [INV-1..INV-10]

- [x] 1.2 阶段评审入口与消息契约任务
  Owner: Backend
  输入: specs/评审植入/design.md#2.3-路由设计, specs/评审植入/design.md#3.1-API-契约
  输出: apps/src/harnessMessages.ts、apps/src/harnessMessageController.ts 的改造任务说明
  验收: 仅支持 requirements|design|testcase 三阶段；入口默认不自动执行评审；非法阶段返回可理解失败但不阻断主流程
  追踪: Requirements [Req-1, Req-4] + Properties [INV-1, INV-2, INV-9, INV-10]

- [x] 1.3 检查点A-入口契约冻结
  Owner: FullStack
  输入: 任务 1.1, 任务 1.2
  输出: 阶段入口与消息契约检查记录
  验收: API-1/ROUTE-1/ROUTE-3 边界一致；不存在新增未需求驱动能力；可进入下一阶段
  追踪: Requirements [Req-1, Req-4] + Properties [INV-1, INV-2, INV-10]

- [x] 2.1 通用模板分阶段解析与回退任务
  Owner: Backend
  输入: specs/评审植入/design.md#3.1-API-契约, specs/评审植入/design.md#3.2-数据模型
  输出: apps/src/services/promptService.ts 的扩展任务说明（新增 resolveReviewPromptByStage 语义）
  验收: 未配置自定义时按阶段回退 default；构造结果包含上下文与模板正文；三阶段 default 模板可区分
  追踪: Requirements [Req-2] + Properties [INV-3, INV-4, INV-5]

- [x] 2.2 自定义模板配置与版本覆盖任务
  Owner: Backend
  输入: specs/评审植入/design.md#3.1-API-契约, specs/评审植入/design.md#3.4-Store-设计
  输出: apps/src/services/reviewPromptConfigService.ts（新建或并入既有服务）与持久化键设计任务说明
  验收: 按阶段保存/读取；同阶段更新覆盖旧版本并返回新版本；阶段间配置隔离
  追踪: Requirements [Req-3] + Properties [INV-6, INV-7, INV-8]

- [x] 2.3 检查点B-模板解析契约冻结
  Owner: FullStack
  输入: 任务 2.1, 任务 2.2
  输出: 模板优先级与回退规则检查记录
  验收: custom > default 优先级稳定；阶段隔离稳定；与 API-2/API-3/MODEL-1/MODEL-2 一致
  追踪: Requirements [Req-2, Req-3] + Properties [INV-3, INV-5, INV-6, INV-8]

- [x] 3.1 评审执行与状态机任务
  Owner: Backend
  输入: specs/评审植入/design.md#3.1-API-契约, specs/评审植入/design.md#5.-错误处理
  输出: apps/src/services/reviewExecutionService.ts（新建或并入既有服务）任务说明
  验收: 触发后进入 running；成功 completed+summary；失败 failed+reason；任何状态不写入阻断主流程门禁
  追踪: Requirements [Req-2, Req-3, Req-4] + Properties [INV-4, INV-9, INV-10]

- [x] 3.2 Webview 入口与状态展示集成任务
  Owner: Frontend
  输入: specs/评审植入/design.md#3.3-组件-Props-/-Events, specs/评审植入/design.md#2.2-项目目录结构
  输出: apps/src/webviewTemplates.ts 的 UI 入口、状态面板、自定义模板编辑区改造任务说明
  验收: 三阶段入口可见；状态可见（idle/running/completed/failed）；失败原因可读；未评审/评审失败均不阻断阶段推进 UI 操作
  追踪: Requirements [Req-1, Req-3, Req-4] + Properties [INV-1, INV-8, INV-9, INV-10]

- [x] 3.3 检查点C-端到端行为冻结
  Owner: FullStack
  输入: 任务 3.1, 任务 3.2
  输出: 端到端行为检查记录（入口->模板解析->执行->状态反馈）
  验收: 三阶段均可独立触发评审；模板来源正确；失败可见且主流程语义不变
  追踪: Requirements [Req-1, Req-2, Req-3, Req-4] + Properties [INV-1..INV-10]

- [x] 4.1 单元与集成测试任务
  Owner: FullStack
  输入: specs/评审植入/design.md#6.-测试策略
  输出: apps/test/ 下评审植入相关测试文件改造任务说明
  验收: 覆盖 TEST-1..TEST-10；每个 Req 至少一条自动化验证；包含非法阶段与执行失败分支
  追踪: Requirements [Req-1, Req-2, Req-3, Req-4] + Properties [INV-1..INV-10]

- [x] 4.2 门禁与追溯闭环校验任务
  Owner: FullStack
  输入: 任务 1.1, 任务 4.1
  输出: 追溯闭环校验记录（Req/API/Model/Invariant/Test/Task）
  验收: 无未覆盖 Req；无悬空引用；任务依赖无环；重跑不产生冲突任务 ID
  追踪: Requirements [Req-1, Req-2, Req-3, Req-4] + Properties [INV-1..INV-10]

- [x] 4.3 检查点D-评审阶段提交准备
  Owner: FullStack
  输入: 任务 4.2
  输出: spec 评审阶段提交清单
  验收: 满足结构合法+追溯闭环；可进入机器门禁与人工 sign-off
  追踪: Requirements [Req-1, Req-2, Req-3, Req-4] + Properties [INV-1..INV-10]

## 机器可读区
```yaml
artifactType: tasks
taskName: 评审植入
tasks:
  - id: 1.1
    name: 建立需求-设计追溯基线
    owner: FullStack
    domain: project-structure-init
    dependsOn: []
    inputs:
      - specs/评审植入/requirements.md#需求清单
      - specs/评审植入/design.md#3.1-API-契约
      - specs/评审植入/design.md#4.-正确性属性（需求不变量）
    outputs:
      - Traceability matrix for Req/API/Model/Invariant/Test/Task
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]

  - id: 1.2
    name: 阶段评审入口与消息契约任务
    owner: Backend
    domain: project-structure-init
    dependsOn: [1.1]
    inputs:
      - specs/评审植入/design.md#2.3-路由设计
      - specs/评审植入/design.md#3.1-API-契约
    outputs:
      - apps/src/harnessMessages.ts
      - apps/src/harnessMessageController.ts
    requirementIds: [Req-1, Req-4]
    propertyIds: [INV-1, INV-2, INV-9, INV-10]

  - id: 1.3
    name: 检查点A-入口契约冻结
    owner: FullStack
    domain: project-structure-init
    dependsOn: [1.2]
    inputs:
      - task:1.1
      - task:1.2
    outputs:
      - Entry contract checkpoint note
    requirementIds: [Req-1, Req-4]
    propertyIds: [INV-1, INV-2, INV-10]

  - id: 2.1
    name: 通用模板分阶段解析与回退任务
    owner: Backend
    domain: project-structure-init
    dependsOn: [1.3]
    inputs:
      - specs/评审植入/design.md#3.1-API-契约
      - specs/评审植入/design.md#3.2-数据模型
    outputs:
      - apps/src/services/promptService.ts
    requirementIds: [Req-2]
    propertyIds: [INV-3, INV-4, INV-5]

  - id: 2.2
    name: 自定义模板配置与版本覆盖任务
    owner: Backend
    domain: project-structure-init
    dependsOn: [1.3]
    inputs:
      - specs/评审植入/design.md#3.1-API-契约
      - specs/评审植入/design.md#3.4-Store-设计
    outputs:
      - apps/src/services/reviewPromptConfigService.ts
    requirementIds: [Req-3]
    propertyIds: [INV-6, INV-7, INV-8]

  - id: 2.3
    name: 检查点B-模板解析契约冻结
    owner: FullStack
    domain: project-structure-init
    dependsOn: [2.1, 2.2]
    inputs:
      - task:2.1
      - task:2.2
    outputs:
      - Prompt resolution checkpoint note
    requirementIds: [Req-2, Req-3]
    propertyIds: [INV-3, INV-5, INV-6, INV-8]

  - id: 3.1
    name: 评审执行与状态机任务
    owner: Backend
    domain: project-structure-init
    dependsOn: [2.3]
    inputs:
      - specs/评审植入/design.md#3.1-API-契约
      - specs/评审植入/design.md#5.-错误处理
    outputs:
      - apps/src/services/reviewExecutionService.ts
    requirementIds: [Req-2, Req-3, Req-4]
    propertyIds: [INV-4, INV-9, INV-10]

  - id: 3.2
    name: Webview 入口与状态展示集成任务
    owner: Frontend
    domain: project-structure-init
    dependsOn: [1.3, 3.1]
    inputs:
      - specs/评审植入/design.md#3.3-组件-Props-/-Events
      - specs/评审植入/design.md#2.2-项目目录结构
    outputs:
      - apps/src/webviewTemplates.ts
    requirementIds: [Req-1, Req-3, Req-4]
    propertyIds: [INV-1, INV-8, INV-9, INV-10]

  - id: 3.3
    name: 检查点C-端到端行为冻结
    owner: FullStack
    domain: project-structure-init
    dependsOn: [3.1, 3.2]
    inputs:
      - task:3.1
      - task:3.2
    outputs:
      - End-to-end behavior checkpoint note
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]

  - id: 4.1
    name: 单元与集成测试任务
    owner: FullStack
    domain: project-structure-init
    dependsOn: [3.3]
    inputs:
      - specs/评审植入/design.md#6.-测试策略
    outputs:
      - apps/test/reviewInjection*.test.js
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]

  - id: 4.2
    name: 门禁与追溯闭环校验任务
    owner: FullStack
    domain: project-structure-init
    dependsOn: [4.1]
    inputs:
      - task:1.1
      - task:4.1
    outputs:
      - Gate checklist for structural validity and traceability
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]

  - id: 4.3
    name: 检查点D-评审阶段提交准备
    owner: FullStack
    domain: project-structure-init
    dependsOn: [4.2]
    inputs:
      - task:4.2
    outputs:
      - Spec review submission pack
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10]
```