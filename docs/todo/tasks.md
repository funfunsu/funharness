# 任务拆解文档

## 迭代信息

- 功能名称：todo
- 任务拆分模式：standard
- 规划范围：基于工作区级 Todo 能力完成消息契约、存储、双面板交互、待办转迭代任务、错误处理与验证闭环
- 规划基线：以 docs/requirements.md 与 docs/design.md 为唯一规划输入，不使用 .harness/*.json 作为事实来源

## 既有资源声明（如有）

- 已有：docs/requirements.md（完整 Req-1 ~ Req-7）
- 已有：docs/design.md（含 API-1 ~ API-6、M-1 ~ M-3、C-1 ~ C-4、S-1 ~ S-2、INV-1 ~ INV-7）
- 缺失但非阻塞：docs/testcase.md（可选）
- 缺失但非阻塞：tests/test-manifest.json（可选）
- 本轮策略：生成缺失的可执行开发任务，不重复产出需求/设计文档任务

## 任务清单（严格按依赖顺序执行）

### Req/INV 到任务映射表（1.1 产出）

| 需求/不变量 | 覆盖任务 |
|---|---|
| Req-1 | 1.2, 2.2, 2.4, 3.1, 4.3, 4.4 |
| Req-2 | 1.2, 1.3, 2.4, 3.2, 3.3, 4.4 |
| Req-3 | 2.1, 2.3, 2.5, 4.3, 4.4 |
| Req-4 | 1.2, 2.2, 2.4, 3.1, 3.2, 4.3, 4.4 |
| Req-5 | 1.2, 2.4, 3.1, 3.2, 4.3, 4.4 |
| Req-6 | 1.2, 4.1, 4.2, 4.3, 4.4 |
| Req-7 | 1.2, 1.3, 2.1, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 4.3, 4.4 |
| INV-1 | 1.3, 3.2, 4.4 |
| INV-2 | 2.2, 3.1, 4.3, 4.4 |
| INV-3 | 2.1, 2.3, 2.5, 4.3, 4.4 |
| INV-4 | 2.2, 4.3, 4.4 |
| INV-5 | 2.4, 4.3, 4.4 |
| INV-6 | 1.3, 1.4, 2.1, 2.4, 2.5, 3.3, 3.4, 4.4 |
| INV-7 | 1.2, 4.1, 4.2, 4.3, 4.4 |

- [x] 1.1 [1h] 任务基线与追踪矩阵初始化
	- Owner: FullStack
	- 输入: docs/requirements.md#需求清单, docs/design.md#3.1, docs/design.md#4
	- 输出: docs/tasks.md 中 Req/INV 到任务映射表（本节内维护）
	- 验收: 所有 Req-1~Req-7 与 INV-1~INV-7 均至少映射到 1 个后续任务
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7 + INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7

- [x] 1.2 [2h] 定义 Todo 消息契约与事件类型
	- Owner: FullStack
	- 输入: docs/design.md#3.1 API 契约
	- 输出: apps/src/harnessMessages.ts（新增/扩展 todo.create, todo.update, todo.delete, todo.list, todo.promoteToTask, todo.changed）
	- 验收: 消息类型与字段与 API-1~API-6 一致；包含 promotionPolicy 与 sourcePanel
	- 追踪: Req-1, Req-2, Req-4, Req-5, Req-6, Req-7 + INV-7

- [x] 1.3 [2h] 扩展消息控制器路由与权限放行策略
	- Owner: FullStack
	- 输入: docs/design.md#2.3, docs/design.md#3.1
	- 输出: apps/src/harnessMessageController.ts（Todo 路由分发与 worktree 面板可执行白名单）
	- 验收: 主面板与 worktree 子面板均可执行 R-1~R-5；非 Todo 根级配置权限保持不变
	- 追踪: Req-2, Req-7 + INV-1, INV-6

- [x] 1.4 [1h] 检查点-消息与路由冻结
	- Owner: FullStack
	- 输入: 任务 1.2, 1.3
	- 输出: 路由清单冻结记录（docs/tasks.md 本节勾选）
	- 验收: API-1~API-6 全部可被路由识别，字段无歧义，依赖关系清晰
	- 追踪: Req-1, Req-2, Req-4, Req-5, Req-6, Req-7 + INV-6
	- 冻结记录:
	  - [x] API-1 todo.create：sourcePanel/title/description 字段已冻结
	  - [x] API-2 todo.update：id/title/description/status 字段已冻结
	  - [x] API-3 todo.delete：id 字段已冻结
	  - [x] API-4 todo.list：空请求结构已冻结
	  - [x] API-5 todo.promoteToTask：todoId/promotionPolicy 字段已冻结
	  - [x] API-6 todo.changed：reason/todos 事件负载已冻结
	  - [x] worktree 子面板白名单已放行 todo.create/todo.update/todo.delete/todo.list/todo.promoteToTask

- [x] 2.1 [3h] 建立工作区级 Todo 存储服务骨架
	- Owner: Backend
	- 输入: docs/design.md#2.2, docs/design.md#3.2, docs/design.md#3.4 S-1
	- 输出: apps/src/services/workspaceTodoStoreService.ts（load/list/create/update/remove/promoteToTask/subscribe 接口）
	- 验收: 提供单一权威状态与序列化写入入口；对外接口与 S-1 一致
	- 追踪: Req-3, Req-7 + INV-3, INV-6

- [x] 2.2 [2h] 实现 Todo 文档模型校验与标题约束
	- Owner: Backend
	- 输入: docs/design.md#3.2 M-1, M-2
	- 输出: apps/src/services/workspaceTodoStoreService.ts（模型校验、schemaVersion、空标题拦截）
	- 验收: title 为空时返回 TODO-VAL-001；更新时 id 不变；文档结构满足 M-1/M-2
	- 追踪: Req-1, Req-4 + INV-2, INV-4

- [x] 2.3 [2h] 落盘路径与 Git 忽略策略接入
	- Owner: Backend
	- 输入: docs/design.md#2.2, docs/design.md#4 INV-3, docs/design.md#5
	- 输出: apps/src/services/workspaceTodoStoreService.ts, apps/src/services/gitService.ts（如需忽略策略接入）
	- 验收: 待办存储文件仅位于工作区主目录 .harness/workspace-todos.json；不进入 git 跟踪
	- 追踪: Req-3 + INV-3

- [x] 2.4 [2h] 实现增改删查与变更广播触发点
	- Owner: Backend
	- 输入: docs/design.md#3.1 API-1~API-4, API-6, docs/design.md#5
	- 输出: apps/src/services/workspaceTodoStoreService.ts, apps/src/harnessMessageController.ts
	- 验收: create/update/delete/list 成功后可产出 todo.changed 事件负载；错误映射到 TODO-VAL/TODO-IO 分类
	- 追踪: Req-1, Req-2, Req-4, Req-5, Req-7 + INV-5, INV-6

- [x] 2.5 [1h] 检查点-存储与一致性冻结
	- Owner: Backend
	- 输入: 任务 2.1, 2.2, 2.3, 2.4
	- 输出: 存储一致性检查结论（docs/tasks.md 本节勾选）
	- 验收: 重启可恢复、ID 稳定、广播负载正确、非 git 约束成立
	- 追踪: Req-3, Req-7 + INV-3, INV-6
	- 一致性检查结论:
	  - [x] 重启可恢复：`load()` 从主目录 `.harness/workspace-todos.json` 读取并归一化文档
	  - [x] ID 稳定：`update()`/`remove()`/`promoteToTask()` 仅按既有 `id` 操作，不改写主键
	  - [x] 广播负载正确：`todo.create/update/delete/list` 均触发 `todo.changed`，且负载包含 `reason + todos`
	  - [x] 非 git 约束成立：写盘前自动确保 `/.harness/workspace-todos.json` 写入 `.git/info/exclude`

- [x] 3.1 [3h] 主面板 Todo 列表与编辑交互接入
	- Owner: Frontend
	- 输入: docs/design.md#3.3 C-1, C-3, C-4
	- 输出: apps/src/webviewTemplates.ts（主面板 Todo 区域：新增、编辑、删除、空状态）
	- 验收: 主面板支持完整 CRUD；空标题提示与设计一致；空列表时显示空状态
	- 追踪: Req-1, Req-4, Req-5, Req-7 + INV-2

- [x] 3.2 [2h] worktree 子面板 Todo 交互接入
	- Owner: Frontend
	- 输入: docs/design.md#3.3 C-2
	- 输出: apps/src/webviewTemplates.ts（worktree 子面板 Todo 区域）
	- 验收: 子面板可新增/修改/删除 Todo，且操作目标为工作区共享清单
	- 追踪: Req-2, Req-4, Req-5, Req-7 + INV-1

- [x] 3.3 [2h] 多面板同步与刷新机制接入
	- Owner: FullStack
	- 输入: docs/design.md#2.3 R-6, docs/design.md#3.4 S-2
	- 输出: apps/src/harnessMessageController.ts, apps/src/webviewTemplates.ts
	- 验收: 任一面板操作后，其它面板在下一次刷新/事件处理后展示一致列表
	- 追踪: Req-2, Req-7 + INV-6

- [x] 3.4 [1h] 检查点-双面板体验冻结
	- Owner: Frontend
	- 输入: 任务 3.1, 3.2, 3.3
	- 输出: 交互覆盖清单（docs/tasks.md 本节勾选）
	- 验收: 主面板与 worktree 子面板均覆盖增改删查与空状态，交互一致
	- 追踪: Req-1, Req-2, Req-4, Req-5, Req-7 + INV-6
	- 交互覆盖清单:
	  - [x] 主面板支持新增 Todo（标题必填、描述可选）
	  - [x] 主面板支持编辑 Todo（标题/描述/状态）
	  - [x] 主面板支持删除 Todo
	  - [x] 主面板空列表显示空状态提示
	  - [x] worktree 子面板支持新增 Todo（写入工作区共享清单）
	  - [x] worktree 子面板支持编辑 Todo（标题/描述/状态）
	  - [x] worktree 子面板支持删除 Todo
	  - [x] worktree 子面板空列表显示空状态提示
	  - [x] 任一面板变更后，其他面板在刷新/事件处理后可见一致列表

- [x] 4.1 [3h] 实现待办快速创建迭代任务链路
	- Owner: FullStack
	- 输入: docs/design.md#3.1 API-5, docs/design.md#3.2 M-3
	- 输出: apps/src/services/harnessActionsService.ts, apps/src/harnessMessageController.ts, apps/src/webviewTemplates.ts
	- 验收: 可从单条 Todo 触发创建迭代任务；任务 name/desc 分别预填 title/description
	- 追踪: Req-6 + INV-7

- [x] 4.2 [2h] 实现转任务后的待办存续策略
	- Owner: Backend
	- 输入: docs/design.md#3.2 M-3, docs/design.md#4 INV-7
	- 输出: apps/src/services/workspaceTodoStoreService.ts
	- 验收: 仅支持 keep 或 mark-promoted；策略非法返回 TODO-POLICY-001；行为全入口一致
	- 追踪: Req-6 + INV-7

- [x] 4.3 [2h] 错误处理与日志对齐
	- Owner: FullStack
	- 输入: docs/design.md#5
	- 输出: apps/src/harnessMessageController.ts, apps/src/services/workspaceTodoStoreService.ts, apps/src/services/harnessLog.ts
	- 验收: TODO-VAL-001/002、TODO-IO-001/002、TODO-SYNC-001、TODO-PROMOTE-001、TODO-POLICY-001 均可被识别并回传
	- 追踪: Req-1, Req-3, Req-4, Req-5, Req-6, Req-7 + INV-2, INV-3, INV-4, INV-5, INV-7

- [x] 4.4 [2h] 验证任务编排与回归测试任务
	- Owner: FullStack
	- 输入: docs/design.md#6
	- 输出: tests/todo/contract.todo.spec.ts, tests/todo/store.todo.spec.ts, tests/todo/panel-sync.todo.spec.ts, tests/todo/promotion.todo.spec.ts
	- 验收: 覆盖合同、持久化、多面板一致性、转任务链路与负向校验；缺失 testcase.md 不阻塞执行
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7 + INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7

- [x] 4.5 [1h] 检查点-端到端可交付签收
	- Owner: FullStack
	- 输入: 任务 4.1, 4.2, 4.3, 4.4
	- 输出: 签收记录（docs/tasks.md 本节勾选）
	- 验收: Req-1~Req-7 与 INV-1~INV-7 全量覆盖，依赖顺序闭环，无未解析阻塞项
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7 + INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7
	- 签收记录:
	  - [x] Req-1~Req-7 全量覆盖：映射表与任务 1.2~4.4 产出闭环可追踪
	  - [x] INV-1~INV-7 全量覆盖：设计不变量均在任务映射与回归测试中落地
	  - [x] 依赖顺序闭环：4.5 依赖 4.4，前置 4.1/4.2/4.3/4.4 已完成并产出信号
	  - [x] 无未解析阻塞项：缺失 docs/testcase.md 与 tests/test-manifest.json 为非阻塞项且不影响验收

## 机器可读区

```yaml
artifactType: tasks
taskName: todo
tasks:
	- id: 1.1
		name: 任务基线与追踪矩阵初始化
		owner: FullStack
		dependsOn: []
		estimateHours: 1
		inputs: [docs/requirements.md#需求清单, docs/design.md#3.1, docs/design.md#4]
		outputs: [docs/tasks.md#任务清单]
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7]
		propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7]
	- id: 1.2
		name: 定义 Todo 消息契约与事件类型
		owner: FullStack
		dependsOn: [1.1]
		estimateHours: 2
		inputs: [docs/design.md#3.1]
		outputs: [apps/src/harnessMessages.ts]
		requirementIds: [Req-1, Req-2, Req-4, Req-5, Req-6, Req-7]
		propertyIds: [INV-7]
	- id: 1.3
		name: 扩展消息控制器路由与权限放行策略
		owner: FullStack
		dependsOn: [1.2]
		estimateHours: 2
		inputs: [docs/design.md#2.3, docs/design.md#3.1]
		outputs: [apps/src/harnessMessageController.ts]
		requirementIds: [Req-2, Req-7]
		propertyIds: [INV-1, INV-6]
	- id: 1.4
		name: 检查点-消息与路由冻结
		owner: FullStack
		dependsOn: [1.3]
		estimateHours: 1
		inputs: [apps/src/harnessMessages.ts, apps/src/harnessMessageController.ts]
		outputs: [docs/tasks.md#任务清单]
		requirementIds: [Req-1, Req-2, Req-4, Req-5, Req-6, Req-7]
		propertyIds: [INV-6]
	- id: 2.1
		name: 建立工作区级 Todo 存储服务骨架
		owner: Backend
		dependsOn: [1.4]
		estimateHours: 3
		inputs: [docs/design.md#2.2, docs/design.md#3.2, docs/design.md#3.4]
		outputs: [apps/src/services/workspaceTodoStoreService.ts]
		requirementIds: [Req-3, Req-7]
		propertyIds: [INV-3, INV-6]
	- id: 2.2
		name: 实现 Todo 文档模型校验与标题约束
		owner: Backend
		dependsOn: [2.1]
		estimateHours: 2
		inputs: [docs/design.md#3.2]
		outputs: [apps/src/services/workspaceTodoStoreService.ts]
		requirementIds: [Req-1, Req-4]
		propertyIds: [INV-2, INV-4]
	- id: 2.3
		name: 落盘路径与 Git 忽略策略接入
		owner: Backend
		dependsOn: [2.2]
		estimateHours: 2
		inputs: [docs/design.md#2.2, docs/design.md#4]
		outputs: [apps/src/services/workspaceTodoStoreService.ts, apps/src/services/gitService.ts]
		requirementIds: [Req-3]
		propertyIds: [INV-3]
	- id: 2.4
		name: 实现增改删查与变更广播触发点
		owner: Backend
		dependsOn: [2.3]
		estimateHours: 2
		inputs: [docs/design.md#3.1, docs/design.md#5]
		outputs: [apps/src/services/workspaceTodoStoreService.ts, apps/src/harnessMessageController.ts]
		requirementIds: [Req-1, Req-2, Req-4, Req-5, Req-7]
		propertyIds: [INV-5, INV-6]
	- id: 2.5
		name: 检查点-存储与一致性冻结
		owner: Backend
		dependsOn: [2.4]
		estimateHours: 1
		inputs: [apps/src/services/workspaceTodoStoreService.ts]
		outputs: [docs/tasks.md#任务清单]
		requirementIds: [Req-3, Req-7]
		propertyIds: [INV-3, INV-6]
	- id: 3.1
		name: 主面板 Todo 列表与编辑交互接入
		owner: Frontend
		dependsOn: [2.5]
		estimateHours: 3
		inputs: [docs/design.md#3.3]
		outputs: [apps/src/webviewTemplates.ts]
		requirementIds: [Req-1, Req-4, Req-5, Req-7]
		propertyIds: [INV-2]
	- id: 3.2
		name: worktree 子面板 Todo 交互接入
		owner: Frontend
		dependsOn: [3.1]
		estimateHours: 2
		inputs: [docs/design.md#3.3]
		outputs: [apps/src/webviewTemplates.ts]
		requirementIds: [Req-2, Req-4, Req-5, Req-7]
		propertyIds: [INV-1]
	- id: 3.3
		name: 多面板同步与刷新机制接入
		owner: FullStack
		dependsOn: [3.2]
		estimateHours: 2
		inputs: [docs/design.md#2.3, docs/design.md#3.4]
		outputs: [apps/src/harnessMessageController.ts, apps/src/webviewTemplates.ts]
		requirementIds: [Req-2, Req-7]
		propertyIds: [INV-6]
	- id: 3.4
		name: 检查点-双面板体验冻结
		owner: Frontend
		dependsOn: [3.3]
		estimateHours: 1
		inputs: [apps/src/webviewTemplates.ts]
		outputs: [docs/tasks.md#任务清单]
		requirementIds: [Req-1, Req-2, Req-4, Req-5, Req-7]
		propertyIds: [INV-6]
	- id: 4.1
		name: 实现待办快速创建迭代任务链路
		owner: FullStack
		dependsOn: [3.4]
		estimateHours: 3
		inputs: [docs/design.md#3.1, docs/design.md#3.2]
		outputs: [apps/src/services/harnessActionsService.ts, apps/src/harnessMessageController.ts, apps/src/webviewTemplates.ts]
		requirementIds: [Req-6]
		propertyIds: [INV-7]
	- id: 4.2
		name: 实现转任务后的待办存续策略
		owner: Backend
		dependsOn: [4.1]
		estimateHours: 2
		inputs: [docs/design.md#3.2, docs/design.md#4]
		outputs: [apps/src/services/workspaceTodoStoreService.ts]
		requirementIds: [Req-6]
		propertyIds: [INV-7]
	- id: 4.3
		name: 错误处理与日志对齐
		owner: FullStack
		dependsOn: [4.2]
		estimateHours: 2
		inputs: [docs/design.md#5]
		outputs: [apps/src/harnessMessageController.ts, apps/src/services/workspaceTodoStoreService.ts, apps/src/services/harnessLog.ts]
		requirementIds: [Req-1, Req-3, Req-4, Req-5, Req-6, Req-7]
		propertyIds: [INV-2, INV-3, INV-4, INV-5, INV-7]
	- id: 4.4
		name: 验证任务编排与回归测试任务
		owner: FullStack
		dependsOn: [4.3]
		estimateHours: 2
		inputs: [docs/design.md#6]
		outputs: [tests/todo/contract.todo.spec.ts, tests/todo/store.todo.spec.ts, tests/todo/panel-sync.todo.spec.ts, tests/todo/promotion.todo.spec.ts]
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7]
		propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7]
	- id: 4.5
		name: 检查点-端到端可交付签收
		owner: FullStack
		dependsOn: [4.4]
		estimateHours: 1
		inputs: [docs/requirements.md, docs/design.md, docs/tasks.md#任务清单]
		outputs: [docs/tasks.md#任务清单]
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7]
		propertyIds: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7]
```
