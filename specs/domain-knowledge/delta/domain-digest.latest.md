# Spec Delta Domain Digest

- generatedAt: 2026-07-23T03:57:22.814Z
- taskId: task_1784774141609
- taskName: domain-knowledge
- gateLevel: standard
- totalChanges: 18
- blockedByGate: 5

## Executive Summary

- highRiskChanges: 5
- mediumRiskChanges: 9
- lowRiskChanges: 4

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| uncategorized | 18 | 5 | 9 | 4 | 5 |

## Domain Sections

### Domain: uncategorized

- [2026-07-23T02:54:43.949Z] [tsk] [medium] TSK snapshot updated
  - tsk:initial-snapshot
- [2026-07-23T03:38:02.106Z] [req] [medium] REQ snapshot updated
  - req:initial-snapshot
- [2026-07-23T03:38:02.116Z] [des] [medium] DES snapshot updated
  - des:initial-snapshot
- [2026-07-23T03:38:02.123Z] [tsk] [medium] TSK snapshot updated
  - tsk:no-semantic-diff
- [2026-07-23T03:38:02.298Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=20
- [2026-07-23T03:42:25.165Z] [req] [medium] REQ snapshot updated
  - gwt-count:79->81
- [2026-07-23T03:42:25.172Z] [des] [medium] DES snapshot updated
  - des:no-semantic-diff
- [2026-07-23T03:42:25.371Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=20
- [2026-07-23T03:43:40.001Z] [des] [medium] DES snapshot updated
  - des:no-semantic-diff
- [2026-07-23T03:43:40.008Z] [tcs] [medium] TCS snapshot updated
  - tcs:initial-snapshot
- [2026-07-23T03:43:40.199Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=20
- [2026-07-23T03:44:59.058Z] [des] [medium] DES snapshot updated
  - des:no-semantic-diff
- [2026-07-23T03:44:59.504Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=20
- [2026-07-23T03:45:30.203Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=20
- [2026-07-23T03:51:02.874Z] [dev] [low] Development drift gate passed
  - changedFiles=26
- [2026-07-23T03:51:03.316Z] [dev] [low] Development drift gate passed
  - changedFiles=26
- [2026-07-23T03:51:03.633Z] [dev] [low] Development drift gate passed
  - changedFiles=26
- [2026-07-23T03:57:08.155Z] [dev] [low] Development drift gate passed
  - changedFiles=27

