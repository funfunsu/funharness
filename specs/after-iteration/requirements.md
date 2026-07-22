# 需求文档

## 简介

本需求描述 Fun Harness 迭代状态管理的一项增强能力：**当一个迭代（Iteration/Task）完成后，将其从活跃状态文件 `iteration-state.json` 中移除，并归档到独立的归档文件中**。

当前实现中，迭代到达 `done` 阶段（`STAGE.DONE`，通过 `passByTaskId` 合并成功后设置）后仍保留在 `<masterRoot>/.harness/iteration-state.json` 的活跃任务数组里，随时间累积会使活跃列表越来越长、活跃状态与历史记录混杂。本需求要求把“已完成迭代”从活跃状态中剥离并持久化到归档文件（形如 `.harness/iteration-state-archive.json`），从而保持活跃状态精简、且保留完整的历史可追溯记录。

本需求沿用工作区待办已有的归档范式（`workspace-todos-archive.json`：带 `schemaVersion`、`archivedAt`、`archiveReason` 的追加式归档文档），以保持仓库内一致性。

## 术语表

| 术语 | 定义 |
| --- | --- |
| 迭代 / 任务（Iteration / Task） | `models.ts` 中的 `Task` 实体，表示一个开发迭代，含 `id`、`name`、`stage` 等字段。 |
| 活跃状态文件 | `HARNESS_STATE_FILE`，即 `<root>/.harness/iteration-state.json`，持久化当前活跃迭代的数组。 |
| 归档文件 | 新增的归档产物（如 `<root>/.harness/iteration-state-archive.json`），持久化已完成并被移出活跃状态的迭代。 |
| 完成（Done） | 迭代阶段到达 `STAGE.DONE`（值为 `'done'`），通常由 `passByTaskId` 合并成功后置位。 |
| 归档（Archive） | 将迭代从活跃状态文件移除并写入归档文件的原子操作。 |
| 主工作区 / 子工作区快照 | `HarnessConfigMeta.origin` 为 `master` 或 `worktreeSnapshot`，决定状态文件的权威来源与传播方向。 |
| 幂等 | 同一迭代被重复触发归档时，不产生重复归档项，也不破坏已有数据。 |

## 需求清单

### 需求-1：完成即触发归档

**用户故事：** 作为流水线使用者，我希望迭代一旦完成就自动从活跃状态中移出，以便活跃列表只反映进行中的工作。

#### 验收标准
1. GIVEN 一个迭代在 `iteration-state.json` 活跃数组中且其 `stage` 不为 `done`，WHEN 该迭代通过 `passByTaskId` 合并成功并被置为 `STAGE.DONE`，THEN 系统必须触发对该迭代的归档流程。
2. GIVEN 一个迭代的 `stage` 已经是 `done`，WHEN 保存活跃状态（`saveTasks`）执行，THEN 系统必须确保该已完成迭代不再保留在活跃状态文件的数组中。
3. GIVEN 一个迭代的 `stage` 为非 `done` 的任意阶段（`initializing`/`writing_*`/`developing`/`ready_for_review`），WHEN 保存活跃状态执行，THEN 该迭代必须继续保留在活跃状态文件中，不得被归档。

### 需求-2：从活跃状态文件移除已完成迭代

**用户故事：** 作为流水线使用者，我希望已完成迭代不再出现在 `iteration-state.json`，以便活跃状态文件保持精简。

#### 验收标准
1. GIVEN 一个已完成迭代被归档，WHEN 归档流程结束，THEN `<root>/.harness/iteration-state.json` 中不得再包含该迭代对应 `id` 的条目。
2. GIVEN 活跃状态文件中同时存在已完成与未完成迭代，WHEN 归档流程执行，THEN 未完成迭代必须原样保留、其字段不被改动，仅移除已完成迭代。
3. GIVEN 归档流程完成后重新调用 `loadTasks`，WHEN 读取活跃状态，THEN 返回的任务列表中不得包含已归档迭代的 `id`。

### 需求-3：将已完成迭代写入归档文件

**用户故事：** 作为流水线使用者，我希望已完成迭代被完整保存到归档文件，以便后续审计和追溯历史。

#### 验收标准
1. GIVEN 一个已完成迭代被归档，WHEN 归档流程执行，THEN 系统必须在 `<root>/.harness/` 下的归档文件中新增一条包含该迭代原始字段（至少 `id`、`name`、`stage`）的归档项。
2. GIVEN 归档文件尚不存在，WHEN 首个迭代被归档，THEN 系统必须创建该归档文件及其所在目录，并写入合法 JSON。
3. GIVEN 一条被归档的迭代记录，WHEN 写入归档文件，THEN 该记录必须附加归档元数据 `archivedAt`（ISO-8601 时间戳字符串）与 `archiveReason`（取值 `completed`）。
4. GIVEN 归档文件已存在且已含既有归档项，WHEN 新迭代被归档，THEN 系统必须以追加方式保留既有归档项，不得覆盖或截断历史记录。

### 需求-4：归档文件结构稳定且机器可读

**用户故事：** 作为下游工具/门禁，我希望归档文件具有稳定、可版本化的结构，以便可靠解析历史记录。

#### 验收标准
1. GIVEN 归档文件被创建或更新，WHEN 写入完成，THEN 文件内容必须是合法 JSON，且顶层包含 `schemaVersion`（数字）与归档条目数组两个字段。
2. GIVEN 归档文件的顶层 schema，WHEN 后续版本演进，THEN 现有 `id`、`archivedAt`、`archiveReason` 字段名与语义不得被单方面变更（契约稳定）。
3. GIVEN 归档文件已损坏或非合法 JSON，WHEN 系统读取归档文件以执行追加，THEN 系统必须以安全方式处理（视为空归档或阻断本次归档并记录日志），不得抛出未捕获异常导致活跃状态保存中断。

### 需求-5：归档操作原子且幂等

**用户故事：** 作为流水线使用者，我希望归档在任何重复或中断场景下都不丢数据、不产生重复项，以便状态始终一致。

#### 验收标准
1. GIVEN 同一已完成迭代被重复触发归档（重跑），WHEN 归档流程再次执行，THEN 归档文件中该迭代 `id` 的归档项不得重复出现（去重或以 `id` 幂等更新）。
2. GIVEN 归档需要“从活跃文件移除”与“写入归档文件”两步，WHEN 写入归档文件失败，THEN 系统必须不从活跃状态文件移除该迭代（保证不丢失记录），并记录失败原因到 harness 日志。
3. GIVEN 归档写入成功但活跃文件移除因故失败，WHEN 下次归档流程重跑，THEN 系统必须能自愈：再次尝试从活跃文件移除且不在归档文件中产生重复项。

### 需求-6：主/子工作区状态传播一致

**用户故事：** 作为在子工作区（worktree 快照）操作的使用者，我希望完成迭代后主工作区的活跃状态与归档同样被正确更新，以便两侧视图一致。

#### 验收标准
1. GIVEN 在子工作区快照（`origin === 'worktreeSnapshot'`）中完成迭代并保存，WHEN 状态向主工作区传播（`propagateTasksToMaster`），THEN 主工作区 `iteration-state.json` 也必须移除该已完成迭代。
2. GIVEN 迭代在子工作区被归档，WHEN 传播到主工作区，THEN 归档记录必须最终体现在主工作区的归档文件中，且不产生重复归档项。
3. GIVEN 子工作区快照被标记为只读（`readOnly === true`）的既有约束，WHEN 归档流程运行，THEN 归档写入的目标与只读语义必须与现有存储规则保持一致，不得破坏既有主/子传播不变量。

### 需求-7：变更边界最小化

**用户故事：** 作为维护者，我希望本次改动仅限于迭代状态存储与归档路径，以便不影响无关模块。

#### 验收标准
1. GIVEN 本需求的实现，WHEN 修改代码，THEN 改动范围必须限于迭代状态存储层（如 `taskStoreService.ts`、`models.ts` 常量、完成动作触发点 `harnessActionsService.passByTaskId` 相关）与归档产物，不得顺手重构无关模块。
2. GIVEN 现有活跃状态文件字段（`Task` 结构）与消费方，WHEN 引入归档能力，THEN 不得改变 `Task` 已确认字段的名称或语义（契约稳定）。

## 需求追踪矩阵（如有已有设计/代码）

| Req-ID | 关联现有产物 / 锚点 | 说明 |
| --- | --- | --- |
| Req-1 | `harnessActionsService.passByTaskId`（置 `STAGE.DONE`）、`taskStoreService.saveTasks` | 完成置位是归档触发点。 |
| Req-2 | `taskStoreService.loadTasks` / `saveLocalTasks` / `getTaskFile`（`<root>/.harness/iteration-state.json`） | 活跃状态文件读写权威路径。 |
| Req-3 | 参考 `workspaceTodoStoreService` 归档范式（`workspace-todos-archive.json`，`archivedAt`/`archiveReason`） | 归档文件格式与元数据参照。 |
| Req-4 | `WorkspaceTodoArchiveDocument`（`schemaVersion` + 数组） | 归档 schema 结构一致性。 |
| Req-5 | `safeRemovePath`、`appendTodoLog`/harness 日志 | 原子/幂等与失败日志。 |
| Req-6 | `taskStoreService.propagateTasksToMaster`、`getConfigMeta`（`origin`/`readOnly`） | 主/子工作区传播不变量。 |
| Req-7 | `models.ts`（`HARNESS_STATE_FILE`）、`Task` 接口 | 变更边界与契约稳定约束。 |

## 机器可读区

```yaml
artifactType: requirements
taskName: after-iteration
requirements:
  - id: Req-1
    title: 完成即触发归档
    userStory: 作为流水线使用者，我希望迭代一旦完成就自动从活跃状态中移出，以便活跃列表只反映进行中的工作
    acceptanceCriteria:
      - GIVEN 一个迭代在 iteration-state.json 活跃数组中且 stage 不为 done WHEN 该迭代通过 passByTaskId 合并成功并被置为 STAGE.DONE THEN 系统必须触发对该迭代的归档流程
      - GIVEN 一个迭代 stage 已是 done WHEN 保存活跃状态 saveTasks 执行 THEN 该已完成迭代不再保留在活跃状态文件数组中
      - GIVEN 一个迭代 stage 为非 done 的任意阶段 WHEN 保存活跃状态执行 THEN 该迭代必须继续保留在活跃状态文件中不得被归档
  - id: Req-2
    title: 从活跃状态文件移除已完成迭代
    userStory: 作为流水线使用者，我希望已完成迭代不再出现在 iteration-state.json，以便活跃状态文件保持精简
    acceptanceCriteria:
      - GIVEN 一个已完成迭代被归档 WHEN 归档流程结束 THEN iteration-state.json 中不得再包含该迭代对应 id 的条目
      - GIVEN 活跃状态文件同时存在已完成与未完成迭代 WHEN 归档流程执行 THEN 未完成迭代必须原样保留且字段不被改动仅移除已完成迭代
      - GIVEN 归档流程完成后重新调用 loadTasks WHEN 读取活跃状态 THEN 返回的任务列表不得包含已归档迭代的 id
  - id: Req-3
    title: 将已完成迭代写入归档文件
    userStory: 作为流水线使用者，我希望已完成迭代被完整保存到归档文件，以便后续审计和追溯历史
    acceptanceCriteria:
      - GIVEN 一个已完成迭代被归档 WHEN 归档流程执行 THEN 系统必须在 .harness 下归档文件中新增包含原始字段 id name stage 的归档项
      - GIVEN 归档文件尚不存在 WHEN 首个迭代被归档 THEN 系统必须创建该归档文件及所在目录并写入合法 JSON
      - GIVEN 一条被归档记录 WHEN 写入归档文件 THEN 必须附加 archivedAt ISO-8601 时间戳与 archiveReason 取值 completed
      - GIVEN 归档文件已存在且含既有归档项 WHEN 新迭代被归档 THEN 必须以追加方式保留既有归档项不得覆盖或截断
  - id: Req-4
    title: 归档文件结构稳定且机器可读
    userStory: 作为下游工具或门禁，我希望归档文件具有稳定可版本化结构，以便可靠解析历史记录
    acceptanceCriteria:
      - GIVEN 归档文件被创建或更新 WHEN 写入完成 THEN 文件内容必须是合法 JSON 且顶层包含 schemaVersion 数字与归档条目数组
      - GIVEN 归档文件顶层 schema WHEN 后续版本演进 THEN 现有 id archivedAt archiveReason 字段名与语义不得被单方面变更
      - GIVEN 归档文件已损坏或非合法 JSON WHEN 系统读取归档文件执行追加 THEN 必须以安全方式处理不得抛出未捕获异常导致活跃状态保存中断
  - id: Req-5
    title: 归档操作原子且幂等
    userStory: 作为流水线使用者，我希望归档在重复或中断场景下都不丢数据不产生重复项，以便状态始终一致
    acceptanceCriteria:
      - GIVEN 同一已完成迭代被重复触发归档 WHEN 归档流程再次执行 THEN 归档文件中该 id 的归档项不得重复出现
      - GIVEN 归档需要移除与写入两步 WHEN 写入归档文件失败 THEN 系统必须不从活跃状态文件移除该迭代并记录失败原因到日志
      - GIVEN 归档写入成功但活跃文件移除失败 WHEN 下次归档流程重跑 THEN 系统必须能自愈再次移除且不在归档文件产生重复项
  - id: Req-6
    title: 主子工作区状态传播一致
    userStory: 作为在子工作区操作的使用者，我希望完成迭代后主工作区活跃状态与归档同样被正确更新，以便两侧视图一致
    acceptanceCriteria:
      - GIVEN 在子工作区快照中完成迭代并保存 WHEN 状态向主工作区传播 propagateTasksToMaster THEN 主工作区 iteration-state.json 也必须移除该已完成迭代
      - GIVEN 迭代在子工作区被归档 WHEN 传播到主工作区 THEN 归档记录必须最终体现在主工作区归档文件中且不产生重复归档项
      - GIVEN 子工作区快照被标记为只读的既有约束 WHEN 归档流程运行 THEN 归档写入目标与只读语义必须与现有存储规则一致不破坏主子传播不变量
  - id: Req-7
    title: 变更边界最小化
    userStory: 作为维护者，我希望本次改动仅限迭代状态存储与归档路径，以便不影响无关模块
    acceptanceCriteria:
      - GIVEN 本需求的实现 WHEN 修改代码 THEN 改动范围必须限于迭代状态存储层与归档产物不得顺手重构无关模块
      - GIVEN 现有活跃状态文件字段 Task 结构与消费方 WHEN 引入归档能力 THEN 不得改变 Task 已确认字段的名称或语义
traceability:
  - reqId: Req-1
    anchors:
      - harnessActionsService.passByTaskId
      - taskStoreService.saveTasks
  - reqId: Req-2
    anchors:
      - taskStoreService.loadTasks
      - taskStoreService.saveLocalTasks
      - taskStoreService.getTaskFile
  - reqId: Req-3
    anchors:
      - workspaceTodoStoreService(archive-pattern)
  - reqId: Req-4
    anchors:
      - WorkspaceTodoArchiveDocument
  - reqId: Req-5
    anchors:
      - safeRemovePath
      - harnessLog
  - reqId: Req-6
    anchors:
      - taskStoreService.propagateTasksToMaster
      - taskStoreService.getConfigMeta
  - reqId: Req-7
    anchors:
      - models.HARNESS_STATE_FILE
      - models.Task
```
