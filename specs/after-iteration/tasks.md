# 任务拆解文档

## 迭代信息

- 功能名称：after-iteration
- 任务拆分模式：standard
- 需求文档：specs/after-iteration/requirements.md
- 设计文档：specs/after-iteration/design.md
- 测试用例文档：不存在（可选，不作为阻断条件）
- 测试清单：不存在（可选，不作为阻断条件）

## 既有资源声明（如有）

| 资源 | 说明 |
| --- | --- |
| `apps/src/services/taskStoreService.ts` | 已控制 `loadTasks`、`saveTasks`、`saveLocalTasks`、`propagateTasksToMaster`，是本需求的主实现边界 |
| `apps/src/models.ts` | 已定义 `HARNESS_STATE_FILE`、`Task`、`STAGE`，适合新增归档常量与归档文档类型 |
| `apps/src/services/harnessActionsService.ts` | `passByTaskId` 已是任务置为 `STAGE.DONE` 的完成触发点，应保持调用 `saveTasks` 的契约稳定 |
| `apps/src/services/workspaceTodoStoreService.ts` | 已有 `workspace-todos-archive.json` 的 schema、归档元数据和失败回滚模式，可复用为归档范式参考 |
| `.harness/*.json` | 运行时状态文件，仅作为实现目标，不作为本阶段规划真相来源 |

## 任务清单（严格按依赖顺序执行）

- [x] 1.1 定义迭代归档常量与文档类型
	- Owner: FullStack
	- 依赖: 无
	- 输入: specs/after-iteration/design.md §3.2
	- 输出: apps/src/models.ts
	- 验收: 新增 `HARNESS_STATE_ARCHIVE_FILE`、归档 schema 版本常量、`IterationArchiveItem`、`IterationArchiveDocument` 类型；现有 `Task` 字段与语义不变
	- 追踪: Req-3, Req-4, Req-7 | M-1, M-2, M-3, INV-8

- [x] 1.2 实现归档文档读写与幂等 Upsert
	- Owner: FullStack
	- 依赖: 1.1
	- 输入: specs/after-iteration/design.md §3.1 API-3；specs/after-iteration/design.md §5；apps/src/services/workspaceTodoStoreService.ts
	- 输出: apps/src/services/taskStoreService.ts
	- 验收: 新增归档文件读取、空文档初始化、合法 JSON 写入、按 `task.id` 去重 Upsert、补充 `archivedAt` 和 `archiveReason=completed`；归档文件损坏时不抛未捕获异常且记录日志
	- 追踪: Req-3, Req-4, Req-5 | API-3, INV-3, INV-4, INV-5, INV-6

- [x] 1.3 改造本地保存流程以先归档后移除活跃任务
	- Owner: FullStack
	- 依赖: 1.2
	- 输入: specs/after-iteration/design.md §3.1 API-1/API-2；specs/after-iteration/design.md §3.4；apps/src/services/taskStoreService.ts
	- 输出: apps/src/services/taskStoreService.ts
	- 验收: `saveTasks`/`saveLocalTasks` 在保存前剥离全部 `stage=done` 任务；仅在归档写入成功后写回过滤后的 `iteration-state.json`；非 `done` 任务字段保持原样；`loadTasks` 读回结果不再包含已归档任务
	- 追踪: Req-1, Req-2, Req-5, Req-7 | API-1, API-2, INV-1, INV-2, INV-6, INV-8

- [x] 1.4 检查点：本地归档主链路验证
	- Owner: FullStack
	- 依赖: 1.3
	- 输入: apps/src/models.ts；apps/src/services/taskStoreService.ts
	- 输出: 无新增文件
	- 验收: 能以聚焦测试或最小可执行校验覆盖“首次归档创建文件”“重复归档不重复”“归档失败不删活跃项”三类场景；如缺少现成测试框架，至少完成相关 TypeScript 编译或诊断验证并记录未覆盖项
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5 | INV-1, INV-3, INV-5, INV-6

- [x] 1.5 改造 worktree 快照向主工作区的传播逻辑
	- Owner: FullStack
	- 依赖: 1.3
	- 输入: specs/after-iteration/design.md §3.1 API-4；specs/after-iteration/design.md §3.4；apps/src/services/taskStoreService.ts
	- 输出: apps/src/services/taskStoreService.ts
	- 验收: `origin === 'worktreeSnapshot'` 时，传播到主工作区的活跃状态不包含已完成任务，且主工作区归档文件获得相同任务的幂等归档结果；传播失败不阻断子工作区保存但会记录日志
	- 追踪: Req-5, Req-6 | API-4, INV-6, INV-7

- [x] 1.6 校准完成触发点与调用契约稳定性
	- Owner: FullStack
	- 依赖: 1.5
	- 输入: specs/after-iteration/requirements.md 追踪矩阵；specs/after-iteration/design.md §2.3；apps/src/services/harnessActionsService.ts
	- 输出: apps/src/services/harnessActionsService.ts；如无需改动则输出为“已验证无需改动”结论
	- 验收: `passByTaskId` 置 `STAGE.DONE` 后仍通过既有 `saveTasks` 路径触发归档；若当前链路已满足则不引入额外入口；不得单方面改变现有方法签名、字段名或路径契约
	- 追踪: Req-1, Req-7 | API-1, ROUTE-1, INV-8

- [x] 1.7 补充归档与传播回归测试
	- Owner: FullStack
	- 依赖: 1.5, 1.6
	- 输入: specs/after-iteration/design.md §6；现有测试目录和测试框架
	- 输出: 相关测试文件（限迭代状态存储与完成动作链路）
	- 验收: 覆盖本地归档、损坏归档文件安全处理、主/子工作区传播一致性、自愈去重四类回归；测试命名与断言可直接映射到对应 `Req-*`
	- 追踪: Req-2, Req-4, Req-5, Req-6, Req-7 | INV-2, INV-4, INV-5, INV-6, INV-7, INV-8

- [x] 1.8 检查点：全链路验证与变更边界复核
	- Owner: FullStack
	- 依赖: 1.4, 1.7
	- 输入: 全部上游任务产出
	- 输出: 无新增文件
	- 验收: 通过聚焦测试或最小编译校验确认归档主链路和传播链路可执行；复核改动仅落在 `taskStoreService.ts`、`models.ts`、`harnessActionsService.ts` 及必要测试文件；无无关模块重构
	- 追踪: Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7 | INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8

## 机器可读区

```yaml
artifactType: tasks
taskName: after-iteration
tasks:
	- id: "1.1"
		name: 定义迭代归档常量与文档类型
		owner: FullStack
		dependsOn: []
		inputs:
			- specs/after-iteration/design.md#3.2
			- apps/src/models.ts
		outputs:
			- apps/src/models.ts
		requirementIds: [Req-3, Req-4, Req-7]
		designRefs: [M-1, M-2, M-3, INV-8]

	- id: "1.2"
		name: 实现归档文档读写与幂等 Upsert
		owner: FullStack
		dependsOn: ["1.1"]
		inputs:
			- specs/after-iteration/design.md#3.1
			- specs/after-iteration/design.md#5
			- apps/src/services/workspaceTodoStoreService.ts
			- apps/src/services/taskStoreService.ts
		outputs:
			- apps/src/services/taskStoreService.ts
		requirementIds: [Req-3, Req-4, Req-5]
		designRefs: [API-3, INV-3, INV-4, INV-5, INV-6]

	- id: "1.3"
		name: 改造本地保存流程以先归档后移除活跃任务
		owner: FullStack
		dependsOn: ["1.2"]
		inputs:
			- specs/after-iteration/design.md#3.1
			- specs/after-iteration/design.md#3.4
			- apps/src/services/taskStoreService.ts
		outputs:
			- apps/src/services/taskStoreService.ts
		requirementIds: [Req-1, Req-2, Req-5, Req-7]
		designRefs: [API-1, API-2, INV-1, INV-2, INV-6, INV-8]

	- id: "1.4"
		name: 检查点：本地归档主链路验证
		owner: FullStack
		dependsOn: ["1.3"]
		inputs:
			- apps/src/models.ts
			- apps/src/services/taskStoreService.ts
		outputs: []
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5]
		designRefs: [INV-1, INV-3, INV-5, INV-6]

	- id: "1.5"
		name: 改造 worktree 快照向主工作区的传播逻辑
		owner: FullStack
		dependsOn: ["1.3"]
		inputs:
			- specs/after-iteration/design.md#3.1
			- specs/after-iteration/design.md#3.4
			- apps/src/services/taskStoreService.ts
		outputs:
			- apps/src/services/taskStoreService.ts
		requirementIds: [Req-5, Req-6]
		designRefs: [API-4, INV-6, INV-7]

	- id: "1.6"
		name: 校准完成触发点与调用契约稳定性
		owner: FullStack
		dependsOn: ["1.5"]
		inputs:
			- specs/after-iteration/requirements.md
			- specs/after-iteration/design.md#2.3
			- apps/src/services/harnessActionsService.ts
		outputs:
			- apps/src/services/harnessActionsService.ts
		requirementIds: [Req-1, Req-7]
		designRefs: [API-1, ROUTE-1, INV-8]

	- id: "1.7"
		name: 补充归档与传播回归测试
		owner: FullStack
		dependsOn: ["1.5", "1.6"]
		inputs:
			- specs/after-iteration/design.md#6
			- apps/src/services/taskStoreService.ts
			- apps/src/services/harnessActionsService.ts
		outputs:
			- tests or existing test files for iteration state storage
		requirementIds: [Req-2, Req-4, Req-5, Req-6, Req-7]
		designRefs: [INV-2, INV-4, INV-5, INV-6, INV-7, INV-8]

	- id: "1.8"
		name: 检查点：全链路验证与变更边界复核
		owner: FullStack
		dependsOn: ["1.4", "1.7"]
		inputs:
			- apps/src/models.ts
			- apps/src/services/taskStoreService.ts
			- apps/src/services/harnessActionsService.ts
		outputs: []
		requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7]
		designRefs: [INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8]
```
