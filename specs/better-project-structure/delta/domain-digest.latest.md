# Spec Delta Domain Digest

- generatedAt: 2026-07-24T03:09:49.665Z
- taskId: task_1784714102943
- taskName: better-project-structure
- gateLevel: standard
- totalChanges: 13
- blockedByGate: 4

## Executive Summary

- highRiskChanges: 4
- mediumRiskChanges: 6
- lowRiskChanges: 3

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| uncategorized | 13 | 4 | 6 | 3 | 4 |

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
- [2026-07-23T01:54:44.421Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - changedFiles=11
- [2026-07-23T01:57:32.336Z] [dev] [low] Development drift gate passed
  - changedFiles=20
- [2026-07-24T03:09:49.663Z] [dev] [low] Development drift gate passed
  - changedFiles=33

