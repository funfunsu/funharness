# 检查点：沉淀写入正确性签核（Task 3.4）

- taskId: 3.4
- taskName: 检查点：沉淀写入正确性签核
- stage: 开发阶段提交链路检查（阶段内记录）
- workspace: c:/Users/cnu07hws/fun-harness/worktrees/领域聚合优化
- basedOn: tasks 3.1 / 3.2 / 3.3 产物

---

## 一、CommitSummary 字段核验（来自 Task 3.1/3.2）

| 字段 | 含义 | 实现位置 | 状态 |
|------|------|----------|------|
| `processedDomains` | 处理的领域数 | `commitChangeSet` 统计 `projection.projectedDomains.length` | ✅ |
| `processedCapabilities` | 处理的能力数 | 各域 `capabilities.length` 加总 | ✅ |
| `skippedAsNoChange` | 无变更标志 | Fast path (`domainChanges.length===0`) + 幂等哈希比较 | ✅ |
| `canonicalSerializationHash` | 确定性序列化哈希 | `computeChangeSetHash`（排除 volatile 字段，INV-14） | ✅ |
| `commitId` | 提交标识 | 等于 `canonicalSerializationHash`（幂等，INV-11） | ✅ |
| `writtenFiles` | 写入文件列表 | `writeTextAtomicMulti` 返回值（限 `specs/<iter>/delta/` 与 `docs/domains/`，INV-7） | ✅ |
| `rebased` | 是否发生基线 rebase | `refreshBaselineAndReproject` 输出（INV-12） | ✅ |

---

## 二、原子写入与回滚核验（来自 Task 3.1）

### fileOps.ts 变更

| 能力 | 实现 | 约束满足 |
|------|------|----------|
| `writeTextAtomicMulti(entries)` — 三阶段原子写入 | ①内存备份 ②逐文件 temp-swap ③失败时恢复备份/删除新建文件 | INV-4, Req-3 ✅ |
| `AtomicWriteRollbackError` — 携带 `failedFile`, `rolledBackFiles` | 抛出 `DOMAIN_COMMIT_ROLLED_BACK` | 设计 §5 错误处理 ✅ |

### 写入计划完整性

| 目标文件 | 路径模式 | 路径边界校验 | 状态 |
|----------|----------|--------------|------|
| 迭代增量 | `specs/<iterationId>/delta/domain-change-set.json` | `assertPathInRepoRoot` | ✅ |
| 领域基线文档 | `docs/domains/<domain>.md` | `assertPathInRepoRoot` | ✅ |
| 领域总览索引 | `docs/domains/_index.md` | `assertPathInRepoRoot` | ✅ |

所有三类文件在 `writeEntries` 数组中一次性传入 `writeTextAtomicMulti`，任一失败整体回滚。满足 INV-4、Req-3。

---

## 三、幂等提交核验（来自 Task 3.2）

| 场景 | 预期行为 | 实现 | 状态 |
|------|----------|------|------|
| `domainChanges.length === 0` | 立即返回 `skippedAsNoChange=true`，不写任何文件 | Fast path | ✅ |
| 语义哈希一致 + 磁盘域文档已匹配 | 返回 `skippedAsNoChange=true`（INV-11） | `computeChangeSetHash` + `isDomainDocsContentEqual` | ✅ |
| 等价内容重复提交 | `commitId` 相同，不产生新的写入（INV-11） | `commitId = changeHash`（确定性） | ✅ |
| `updatedAt`/`sourceRevisionSet` 变化但语义相同 | 哈希不变，仍触发 no-change（INV-14） | volatile 字段排除 | ✅ |

---

## 四、提交门禁编排核验（来自 Task 3.3）

### ROUTE-6 commitDomainKnowledgeChanges 执行顺序

```
Step 1: [autoRebase=true] → refreshBaselineAndReproject → 获取 latestBaselineVersion / latestRevisions
Step 2: previewProjection(latestBaseline) + detectConflicts → blocking check
        → blocking=true: 抛 DOMAIN_COMMIT_BLOCKED，不写任何文件 (INV-5) ✅
Step 3: commitChangeSet(latestBaseline, latestRevisions) → 原子写入 ✅
Step 4: domainCommitResult 回调推送 CommitSummary 到 webview ✅
```

| 门禁规则 | 验证 |
|----------|------|
| 提交前必须先执行 refreshBaselineAndReproject（设计路由约束） | ✅ autoRebase=true 时强制执行 |
| blocking 冲突存在时不得落盘（INV-5） | ✅ blocking 时抛 DOMAIN_COMMIT_BLOCKED |
| 回显结果必须含处理领域数 / 能力数（Req-3） | ✅ CommitSummary.processedDomains + processedCapabilities |
| 阻断项判断（Req-3） | ✅ blocking 时 domainCommitResult 回调 errorCode |

### ROUTE-8 refreshBaselineAndReproject

| 验证项 | 实现 | 状态 |
|--------|------|------|
| 磁盘重新加载 registry + baseline snapshot | `loadRegistry` + `buildBaselineSnapshots` | ✅ |
| 检测 revision 漂移，设置 `rebased: boolean`（INV-12） | `latestBaselineVersion !== currentBaselineVersion` | ✅ |
| 重新执行确定性投影（INV-3） | `previewProjection(latestBaseline, latestSnapshot)` | ✅ |
| `baselineReprojectResult` 回调推送到 webview | extension.ts wiring | ✅ |

---

## 五、deterministic-v1 格式核验（INV-14）

| 规范要求 | 实现 |
|----------|------|
| capabilities 按 reqId 排序 | `serializeDomainDocDeterministicV1` 中 `sort((a,b) => a.reqId.localeCompare(b.reqId))` |
| contracts 按 id 排序 | `sort((a,b) => a.id.localeCompare(b.id))` |
| invariants 按 id 排序 | `sort((a,b) => a.id.localeCompare(b.id))` |
| domainChanges 按 reqId 排序 | `sortChangeSetDeterministic` |
| `canonicalSerializationHash` 与排序后内容绑定 | `computeChangeSetHash` 基于 stable 字段 |

✅ 等价内容始终序列化为相同文本。

---

## 六、HC 红线自查

| 约束 | 结论 |
|------|------|
| HC-01 所有方法绑定 Req-* | ✅ |
| HC-03 无硬编码密钥；路径边界全部受 `assertPathInRepoRoot` 保护 | ✅ |
| HC-04 变更边界：3.1 改 fileOps/service，3.2/3.3 改 service/controller，各自独立 | ✅ |
| INV-4 原子写入 = 全成功或全回滚 | ✅ |
| INV-5 blocking 冲突时不写任何产物 | ✅ |
| INV-11 等价内容幂等不重写 | ✅ |
| INV-12 revision 漂移时 rebase 优先 | ✅ |
| INV-14 deterministic-v1 序列化 | ✅ |

---

## 七、编译验证

- TypeScript 编译：`apps/src/` 全量无错误（通过 get_errors 工具确认）
- 无新增外部依赖

---

## 八、结论

Tasks 3.1–3.3 完整实现了沉淀写入链路：

- **3.1** — `writeTextAtomicMulti`（多文件原子回滚）+ `commitChangeSet`（一次写入三类产物）
- **3.2** — `computeChangeSetHash` volatile 字段排除 + 幂等 no-change 检测 + `refreshBaselineAndReproject` API-11
- **3.3** — ROUTE-6 提交门禁编排（refresh→conflict gate→atomic commit）+ ROUTE-8 基线同步路由

CommitSummary 的 `processedDomains`、`processedCapabilities`、`skippedAsNoChange`、`writtenFiles`、`canonicalSerializationHash` 字段均已正确填充，满足 Req-3 "明确告知处理领域数量、能力数量以及是否存在被阻断项"的验收要求。
