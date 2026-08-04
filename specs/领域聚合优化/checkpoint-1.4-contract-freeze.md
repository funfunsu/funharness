# 检查点：契约冻结与变更边界确认（Task 1.4）

- taskId: 1.4
- taskName: 检查点：契约冻结与变更边界确认
- stage: 开发阶段前置检查（阶段内记录）
- workspace: c:/Users/cnu07hws/fun-harness/worktrees/领域聚合优化
- basedOn: tasks 1.1 / 1.2 / 1.3 产物

---

## 一、契约字段核查（来自 Task 1.1）

### 已冻结模型（apps/src/models.ts）

| 模型 | 关键字段 | 绑定需求 | 状态 |
|------|----------|----------|------|
| `DomainRegistrySnapshot` | `domains: DomainRegistryEntry[]` | Req-4, Req-7 | ✅ 已冻结 |
| `RegistryValidationIssue` | `code: 'duplicate-canonical'\|'duplicate-alias'\|'invalid-slug'` | Req-4, Req-7, INV-9 | ✅ 已冻结 |
| `DomainRevisionSet` | `registryRevision`, `indexRevision`, `domainDocRevisions` | Req-4, Req-8 | ✅ 已冻结 |
| `DomainChangeSet` | `iterationId`, `basedOnBaselineVersion`, `sourceRevisionSet`, `domainChanges` | Req-2, Req-3, Req-6, Req-8 | ✅ 已冻结 |
| `DomainChange` | `reqId`（能力主键）, `changeType`, `status`, `contracts`, `invariants` | Req-4, Req-6 | ✅ 已冻结 |
| `DomainBaselineSnapshot` | `canonicalDomain`, `version`, `capabilities`, `contracts`, `invariants` | Req-2, Req-4, Req-8 | ✅ 已冻结 |
| `ProjectedDomainDocument` | `canonicalDomain`, `markdownContent` | Req-2, Req-4, Req-8 | ✅ 已冻结 |
| `DomainProjectionResult` | `baselineVersion`, `projectedDomains`, `conflicts`, `warnings` | Req-2, Req-8 | ✅ 已冻结 |
| `DomainConflict` | `id`, `type`, `severity`, `reqIds`, `conflictingSections?` | Req-4, Req-5 | ✅ 已冻结 |
| `ConflictDecision` | 联合类型，含 6 种 action | Req-5 | ✅ 已冻结 |
| `CommitSummary` | `processedDomains`, `processedCapabilities`, `skippedAsNoChange`, `writtenFiles` | Req-3, Req-8 | ✅ 已冻结 |
| `DomainKnowledgeContext` | `baselineVersion`, `registry`, `baselineSnapshot`, `draftChangeSet` | Req-1, Req-2, Req-7 | ✅ 已冻结 |
| `BaselineSyncState` | `stale`, `rebaseInProgress`, `latestBaselineVersion`, `latestRevisions` | Req-4, Req-8 | ✅ 已冻结 |

### 已冻结消息契约（apps/src/harnessMessages.ts）

| 消息类型 | 方向 | 绑定 API | 绑定需求 | 状态 |
|----------|------|----------|----------|------|
| `openDomainKnowledgeWorkspace` | 子面板 → Extension | API-1 | Req-1 | ✅ 已冻结 |
| `loadDomainKnowledgeContext` | 子面板 → Controller | API-2 | Req-1, Req-2, Req-7 | ✅ 已冻结 |
| `updateDomainChangeSet` | 子面板 → Controller | API-3 | Req-2, Req-6 | ✅ 已冻结 |
| `previewDomainProjection` | 子面板 → Controller | API-4 | Req-2, Req-4, Req-8 | ✅ 已冻结 |
| `detectDomainConflicts` | 子面板 → Controller | API-5 | Req-4, Req-5, Req-8 | ✅ 已冻结 |
| `resolveDomainConflict` | 子面板 → Controller | API-6 | Req-4, Req-5 | ✅ 已冻结 |
| `commitDomainKnowledgeChanges` | 子面板 → Controller | API-7 | Req-3, Req-6, Req-8 | ✅ 已冻结 |
| `refreshBaselineAndReproject` | 子面板 → Controller | API-11 | Req-4, Req-5, Req-8 | ✅ 已冻结 |
| `detectDocumentMergeConflicts` | 子面板 → Controller | API-12 | Req-4, Req-5, Req-8 | ✅ 已冻结 |

**遗留消息已移除确认：**
- ❌ `runDomainBaselineAggregation` — 已删除
- ❌ `reviewSuspectedDomains` — 已删除
- ❌ `applyDomainAdjudication` — 已删除
- ❌ `commitDomainBaseline` — 已删除
- ❌ `previewDomainBaselineSummary` — 已删除

满足 INV-1，Req-1。

---

## 二、路径边界核查（来自 Task 1.3）

### services/workspaceRoot.ts 实现清单

| 函数 | 约束 | 绑定 | 状态 |
|------|------|------|------|
| `normalizeAndValidateRepoRoot(rawRepoRoot)` | 空值抛出 `DOMAIN_WORKSPACE_LOAD_FAILED` | INV-10, Req-7 | ✅ 已实现 |
| `assertPathInRepoRoot(repoRoot, targetPath)` | 越界抛出 `DomainPathOutOfScopeError` | INV-10, Req-7 | ✅ 已实现 |
| `collectOutOfScopePaths(repoRoot, paths)` | 批量收集越界路径 | INV-10, Req-7 | ✅ 已实现 |

### 路径边界调用点确认

| 调用位置 | 调用函数 | 保护目标 | 状态 |
|----------|----------|----------|------|
| `DomainRegistryService.loadRegistry` | `normalizeAndValidateRepoRoot` | registry.yaml 读取 | ✅ |
| `DomainRegistryService.saveRegistry` | `normalizeAndValidateRepoRoot` | registry.yaml 写入 | ✅ |
| `DomainRegistryService.resolveRegistryPath` | `normalizeAndValidateRepoRoot` + `assertPathInRepoRoot` | 注册表路径解析 | ✅ |
| `DomainKnowledgeAggregateService.upsertDomainIndex` | `normalizeAndValidateRepoRoot` + `assertPathInRepoRoot` | `docs/domains/_index.md` 写入 | ✅ |
| `DomainKnowledgeAggregateService.upsertDomainDocument` | `normalizeAndValidateRepoRoot` + `assertPathInRepoRoot` | `docs/domains/<domain>.md` 写入 | ✅ |
| `DomainKnowledgeAggregateService.aggregatePendingDeltas` | `normalizeAndValidateRepoRoot` | Delta 聚合 repoRoot | ✅ |

### 违规情况

无越界调用，无硬编码绝对路径。满足 INV-10。

---

## 三、入口边界核查（来自 Task 1.2）

### extension.ts 命令注册清单

| 命令 ID | 绑定需求 | 是否保留 | 状态 |
|---------|----------|----------|------|
| `fun-harness.openDomainKnowledgeWorkspace` | Req-1, ROUTE-1 | ✅ 已注册 | ✅ |
| `fun-harness.reviewSuspectedDomains` | — | ❌ 已移除 | ✅ |
| `fun-harness.runDomainBaselineAggregation` | — | ❌ 已移除 | ✅ |
| `fun-harness.previewDomainBaselineSummary` | — | ❌ 已移除 | ✅ |
| `fun-harness.applyDomainAdjudication` | — | ❌ 已移除 | ✅ |
| `fun-harness.commitDomainBaseline` | — | ❌ 已移除 | ✅ |

`unregisterLegacyDomainActions()` 在扩展启动时执行，记录日志确保旧入口不可触发（ROUTE-7，INV-1）。

### harnessMessageController.ts 路由边界

| 变更项 | 约束 | 状态 |
|--------|------|------|
| 遗留领域 deps 已移除（5 项） | INV-1, Req-1 | ✅ |
| 9 个领域知识消息在 `ensureWorktreeAllowed` 中允许通过 | Req-1, INV-2 | ✅ |
| `handle()` 中遗留 case 已替换为新域消息路由 | HC-04 | ✅ |

---

## 四、HC 红线自查

| 约束 | 检查结论 |
|------|----------|
| HC-01 可追溯性：所有模型/消息/方法均绑定 Req-* | ✅ 通过 |
| HC-03 安全底线：所有外部输入经 `validateDomainChangeSetInput` 校验 | ✅ 通过 |
| HC-04 变更边界：仅修改声明的目标文件 | ✅ 通过 |
| HC-05 契约稳定：下游模型不单方面变更上游消息签名 | ✅ 通过 |

---

## 五、编译验证

- TypeScript 编译：`apps/src/` 全量无错误（通过 get_errors 工具验证）
- 无新增外部依赖

---

## 六、结论

1.1–1.3 各产物契约字段、路径边界、入口边界均符合设计规范，可冻结为后续任务（1.5+）的上游依赖基线。

后续任务必须保持以下稳定性：
- `models.ts` 中已冻结类型的字段名与类型不得单方面修改
- `harnessMessages.ts` 中已冻结消息类型的字段签名不得修改
- `services/workspaceRoot.ts` 的函数签名不得修改
- 遗留领域命令/消息不得重新注册或路由
