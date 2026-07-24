# Spec Delta Domain Digest

- generatedAt: 2026-07-22T10:30:04.855Z
- taskId: task_1784714102943
- taskName: better-project-structure
- gateLevel: standard
- totalChanges: 10
- blockedByGate: 3

## Executive Summary

- highRiskChanges: 3
- mediumRiskChanges: 6
- lowRiskChanges: 1

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| uncategorized | 10 | 3 | 6 | 1 | 3 |

## Domain Sections

### Domain: uncategorized

- [2026-07-22T10:03:36.872Z] [tsk] [medium] TSK snapshot updated
  - tsk:initial-snapshot
- [2026-07-22T10:25:24.701Z] [req] [medium] REQ snapshot updated
  - req:initial-snapshot
- [2026-07-22T10:25:24.713Z] [des] [medium] DES snapshot updated
  - des:initial-snapshot
- [2026-07-22T10:25:24.724Z] [tsk] [medium] TSK snapshot updated
  - tsk:no-semantic-diff
- [2026-07-22T10:25:24.985Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - changedFiles=10
- [2026-07-22T10:28:37.270Z] [req] [medium] REQ snapshot updated
  - req:no-semantic-diff
- [2026-07-22T10:28:37.278Z] [des] [medium] DES snapshot updated
  - des:no-semantic-diff
- [2026-07-22T10:28:37.627Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - changedFiles=10
- [2026-07-22T10:29:01.843Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - changedFiles=10
- [2026-07-22T10:30:04.849Z] [dev] [low] Development drift gate passed
  - changedFiles=19

