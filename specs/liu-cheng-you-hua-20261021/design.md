# 设计文档
## 1. 概述
本设计对应“流程优化”迭代的已实现代码行为，覆盖四类变更：
- 开发与完成阶段新增领域沉淀双门禁。
- Git 设置契约从 `githubMirrorGit` 迁移到 `mirrorRemotes`，并在消息层支持 `mr`。
- CodeGraph 初始化判定统一使用真实状态判定函数，避免占位目录误判。
- 主面板新增 `syncMainMonoRepo` 消息链路，用于一键更新本地 mono-main。

说明：当前工作区存在 `.harness/process/codegraph-evidence.json` 快照，含当前 worktree 的 anchors，但 `seams/impactSet` 为空；本次 `codegraph sync -q` 因命令不可用未能刷新，证据时效性未确认。以下接缝降级依据源码与测试核对，不能据空图谱推断业务关系不存在；恢复 CLI 后应补充同步与接缝证据。

## 2. 架构设计
### 2.1 路由与接缝
1. 领域沉淀可写门禁（Req-1）
- 路由：`HarnessActionsService.passByFeatureId`（DEVELOPING 分支）
- 行为：在提交前调用 `runDomainSedimentationWritable`，失败即阻断。
- 关键调用：`CapabilityDeltaService.generateForIteration`、`DomainKnowledgeAggregateService.commitChangeSet`、`GitService.commitDomainBaseline`。
- 上下文：由 `getIterationDir(task)` 经 `resolveDomainBaselineRepoRoot(iterDir)` 解析领域仓库根，并以迭代目录名作为 iterationId；注册表种子也以 iterDir 为来源。能力增量生成仍使用 `generateForIteration(workspaceRoot, iterDir)`。
- 重基：加载上下文后比较归一化基线版本；不一致时依次调用 `refreshBaselineAndReproject`、`saveDraftChangeSet`、`loadDomainKnowledgeContext`，再执行原有投影、冲突检测和领域提交。

2. 领域沉淀只读门禁（Req-2）
- 路由：`HarnessActionsService.passByFeatureId`（READY_FOR_REVIEW 分支）
- 行为：在完成前调用 `verifyDomainSedimentationReadOnly`，失败阻断 DONE。
- 上下文与自动重基顺序同可写门禁，领域数据来自当前迭代而非 mono-main。名称中的“只读”不代表零写入：允许注册表种子初始化、重基草稿保存和日志写入，但不执行 `commitChangeSet` / `commitDomainBaseline`。

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
- 两类门禁均先将版本缺省值归一化为空字符串并 trim 后比较；不同才重基，使用返回的 `latestBaselineVersion` 和 `latestRevisions` 覆盖草稿的 `basedOnBaselineVersion`、`sourceRevisionSet`，保留其余字段，保存并重新加载后检查。重基不等于放行，仍受阻断冲突约束。

2. INV-2（Req-2）
- READY_FOR_REVIEW -> DONE 前，只读复核失败必须阻断完成。
- 两类门禁均在 `domain-gate` 日志记录 repoRoot、registry、changeSet（`<docsRepoRoot>/specs/<iterationId>/delta/domain-change-set.json`）路径；重基后记录版本变化。异常被捕获并返回 `passed=false` 及错误摘要。

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
- 内部门禁返回 `Promise<{ passed: boolean; summary: string }>`，签名不变；领域上下文改从当前迭代解析，基线漂移时先刷新、保存重基草稿并重新加载，再执行原有检查与提交。路径及重基版本写入 `domain-gate` 日志。

2. API-2：完成门禁
- 入口：`HarnessActionsService.passByFeatureId(featureId, directComplete?)`
- 阶段：READY_FOR_REVIEW（以及 directComplete 收尾路径）
- 规则：完成前执行 `verifyDomainSedimentationReadOnly(task)`；失败阻断 DONE。
- 内部门禁返回 `Promise<{ passed: boolean; summary: string }>`，签名不变；当前迭代上下文及自动重基规则同 API-1，允许种子初始化、草稿保存和日志写入，不提交领域基线。版本相同时不重基；异常返回失败摘要。

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
    gateBehavior:
      handler: runDomainSedimentationWritable
      contextRoot: resolveDomainBaselineRepoRoot(getIterationDir(task))
      baselineComparison: "(basedOnBaselineVersion || '').trim() !== (baselineVersion || '').trim()"
      onBaselineMismatch: [refreshBaselineAndReproject, saveDraftChangeSet, loadDomainKnowledgeContext]
      draftUpdates: { basedOnBaselineVersion: latestBaselineVersion, sourceRevisionSet: latestRevisions }
      afterReload: [previewProjection, detectConflicts, commitChangeSet, commitDomainBaseline]
      onBaselineMatch: 不执行自动重基及草稿保存
      onError: 返回 passed=false 及错误摘要并阻断提交
      logging: domain-gate 记录 repoRoot、registry、changeSet 路径和重基前后版本
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
    gateBehavior:
      handler: verifyDomainSedimentationReadOnly
      contextRoot: resolveDomainBaselineRepoRoot(getIterationDir(task))
      baselineComparison: "(basedOnBaselineVersion || '').trim() !== (baselineVersion || '').trim()"
      onBaselineMismatch: [refreshBaselineAndReproject, saveDraftChangeSet, loadDomainKnowledgeContext]
      draftUpdates: { basedOnBaselineVersion: latestBaselineVersion, sourceRevisionSet: latestRevisions }
      afterReload: [previewProjection, detectConflicts]
      allowedWrites: [registrySeed, rebasedDraft, domainGateLog]
      forbiddenCalls: [commitChangeSet, commitDomainBaseline]
      onBaselineMatch: 不执行自动重基及草稿保存
      onError: 返回 passed=false 及错误摘要并阻断完成
      logging: domain-gate 记录 repoRoot、registry、changeSet 路径和重基前后版本
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