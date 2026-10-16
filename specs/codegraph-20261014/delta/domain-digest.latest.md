# Spec Delta Domain Digest

- generatedAt: 2026-10-16T03:42:27.729Z
- taskId: task_1791946269103
- taskName: CodeGraph
- gateLevel: standard
- totalChanges: 4
- blockedByGate: 1

## Executive Summary

- highRiskChanges: 1
- mediumRiskChanges: 3
- lowRiskChanges: 0

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| uncategorized | 4 | 1 | 3 | 0 | 1 |

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

