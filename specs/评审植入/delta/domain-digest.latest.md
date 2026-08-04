# Spec Delta Domain Digest

- generatedAt: 2026-08-04T02:18:00.739Z
- taskId: task_1785748071307
- taskName: 评审植入
- gateLevel: standard
- totalChanges: 8
- blockedByGate: 6

## Executive Summary

- highRiskChanges: 6
- mediumRiskChanges: 1
- lowRiskChanges: 1

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| uncategorized | 8 | 6 | 1 | 1 | 6 |

## Domain Sections

### Domain: uncategorized

- [2026-08-03T09:22:48.982Z] [tsk] [medium] TSK snapshot updated
  - tsk:initial-snapshot
- [2026-08-03T10:12:59.487Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=20
- [2026-08-03T10:15:10.927Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=21
- [2026-08-03T10:17:45.751Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=21
- [2026-08-03T10:20:09.831Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=21
- [2026-08-03T10:24:39.417Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=21
- [2026-08-04T01:56:49.064Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=21
- [2026-08-04T02:18:00.736Z] [dev] [low] Development drift gate passed
  - changedFiles=23

