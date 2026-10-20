# Spec Delta Domain Digest

- generatedAt: 2026-10-20T10:05:49.382Z
- taskId: task_1791946269103
- taskName: CodeGraph
- gateLevel: standard
- totalChanges: 6
- blockedByGate: 2

## Executive Summary

- highRiskChanges: 2
- mediumRiskChanges: 3
- lowRiskChanges: 1

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| uncategorized | 6 | 2 | 3 | 1 | 2 |

## Domain Sections

### Domain: uncategorized

- [2026-10-14T03:35:02.042Z] [tsk] [medium] TSK snapshot updated
  - tsk:initial-snapshot
- [2026-10-15T10:59:55.233Z] [dev] [medium] Development drift gate passed
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=27
- [2026-10-16T03:15:48.768Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=7
- [2026-10-16T03:42:27.726Z] [dev] [medium] Development drift gate passed
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=10
- [2026-10-20T09:54:38.198Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=11
- [2026-10-20T10:05:49.380Z] [dev] [low] Development drift gate passed
  - changedFiles=17

