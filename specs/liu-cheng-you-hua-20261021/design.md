# 设计文档
## 1. 概述
本设计对应“流程优化”迭代的已实现代码行为，覆盖四类变更：
- 开发与完成阶段新增领域沉淀双门禁。
- Git 设置契约从 `githubMirrorGit` 迁移到 `mirrorRemotes`，并在消息层支持 `mr`。
- CodeGraph 初始化判定统一使用真实状态判定函数，避免占位目录误判。
- 主面板新增 `syncMainMonoRepo` 消息链路，用于一键更新本地 mono-main。

说明：当前工作区存在 `.harness/process/codegraph-evidence.json` 快照，但 `seams/impactSet` 为空；以下接缝基于代码与测试推导并与现有快照状态对齐。

## 2. 架构设计
### 2.1 路由与接缝
1. 领域沉淀可写门禁（Req-1）
- 路由：`HarnessActionsService.passByFeatureId`（DEVELOPING 分支）
- 行为：在提交前调用 `runDomainSedimentationWritable`，失败即阻断。
- 关键调用：`CapabilityDeltaService.generateForIteration`、`DomainKnowledgeAggregateService.commitChangeSet`、`GitService.commitDomainBaseline`。

2. 领域沉淀只读门禁（Req-2）
- 路由：`HarnessActionsService.passByFeatureId`（READY_FOR_REVIEW 分支）
- 行为：在完成前调用 `verifyDomainSedimentationReadOnly`，失败阻断 DONE。

3. Git 配置消息契约（Req-3）
- 路由：Webview `saveGit()` -> `HarnessMessageController.handle('saveGit')` -> `Harness.handleSaveGit`。
- 行为：控制器优先转发 `mr`，并兼容回落 `gmg`。

4. CodeGraph 初始化判定（Req-4）
- 路由：`HarnessActionsService.syncCodeGraphByFeatureId`、`Harness.tryRunCodeGraphInitForCurrentWorktree`。
- 行为：以 `isCodeGraphInitialized` 取代仅判断 `.codegraph` 目录存在。

5. mono-main 一键更新（Req-5）
- 路由：Webview `syncMainMonoRepo()` -> `HarnessMessageController.handle('syncMainMonoRepo')` -> `HarnessActionsService.syncMainMonoRepo` -> `GitService.syncMainMonoRepo`。
- 行为：未配置 Monorepo 时按单仓约束失败；已配置时执行主仓更新并返回基线分支提示。

### 2.2 数据与配置模型
1. Feature 模型精简
- `Feature.taskSplitMode` 已移除，不再作为流程运行参数。

2. Config 模型迁移
- 新主字段：`mirrorRemotes`。
- 兼容字段：`githubMirrorGit`（仅兼容读取）。
- `FeatureStoreService` 在保存时执行一次性迁移标记，稳态不再写回旧字段。

### 2.3 关键不变量
1. INV-1（Req-1）
- DEVELOPING -> READY_FOR_REVIEW 推进前，可写门禁失败必须阻断提交。

2. INV-2（Req-2）
- READY_FOR_REVIEW -> DONE 前，只读复核失败必须阻断完成。

3. INV-3（Req-3）
- Git 设置仅承认 Monorepo 主地址；`saveGit` 契约必须接受 `mr` 并兼容 `gmg`。

4. INV-4（Req-4）
- CodeGraph 可用性判定不得仅依赖目录存在，必须走统一状态判定函数。

5. INV-5（Req-5）
- 主面板触发 `syncMainMonoRepo` 时，必须仅针对 Monorepo 主仓执行同步，配置缺失即失败返回。

## 3. API 契约
### 3.1 人工可读
1. API-1：推进评审门禁
- 入口：`HarnessActionsService.passByFeatureId(featureId, directComplete?)`
- 阶段：DEVELOPING
- 规则：先执行 `runDomainSedimentationWritable(task)`；`passed=false` 时阻断提交。

2. API-2：完成门禁
- 入口：`HarnessActionsService.passByFeatureId(featureId, directComplete?)`
- 阶段：READY_FOR_REVIEW（以及 directComplete 收尾路径）
- 规则：完成前执行 `verifyDomainSedimentationReadOnly(task)`；失败阻断 DONE。

3. API-3：Git 配置保存消息
- 入口：`HarnessMessageController.handle('saveGit')`
- 请求字段：`bb`、`mg?`、`mr?`、`gmg?`
- 转发规则：`mirrorRemotes = mr ?? gmg`。
- 失败规则：当 `mg` 缺省或为空字符串时，`handleSaveGit` 必须按 Monorepo 必填策略阻断初始化。

4. API-4：CodeGraph 同步前置检查
- 入口：`HarnessActionsService.syncCodeGraphByFeatureId(featureId)`
- 规则：若 `isCodeGraphInitialized(iterDir)=false`，先尝试初始化；仍失败则告警并终止同步。

5. API-5：mono-main 一键更新
- 入口：`HarnessMessageController.handle('syncMainMonoRepo')`
- 请求字段：无
- 转发规则：调用 `syncMainMonoRepo()`，由 `GitService.syncMainMonoRepo()` 统一执行 Monorepo 描述符解析与主仓同步。

## 4. 机器可读区
```yaml
artifactType: design
taskName: 流程优化
apiContracts:
  - id: API-1
    requirementIds: [Req-1]
    method: EVENT
    path: /internal/harness/pass-by-feature/developing-gate
    request:
      featureId: string
      directComplete: boolean?
    response:
      passed: boolean
      summary: string
      submitTriggered: boolean
  - id: API-2
    requirementIds: [Req-2]
    method: EVENT
    path: /internal/harness/pass-by-feature/review-gate
    request:
      featureId: string
      directComplete: boolean?
    response:
      passed: boolean
      summary: string
      doneTransition: boolean
  - id: API-3
    requirementIds: [Req-3]
    method: MESSAGE
    path: /webview/saveGit
    request:
      bb: string
      mg: string?
      mr: string?
      gmg: string?
    response:
      saved: boolean
      normalizedMirrorRemotes: string
      blockedByMonorepoRequired: boolean
  - id: API-4
    requirementIds: [Req-4]
    method: EVENT
    path: /internal/codegraph/sync
    request:
      featureId: string
    response:
      initialized: boolean
      initializedByCompensation: boolean
      syncExecuted: boolean
      warning: string?
  - id: API-5
    requirementIds: [Req-5]
    method: MESSAGE
    path: /webview/syncMainMonoRepo
    request: {}
    response:
      success: boolean
      message: string
```