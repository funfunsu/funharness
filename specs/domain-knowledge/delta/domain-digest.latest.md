# Spec Delta Domain Digest

- generatedAt: 2026-07-31T07:23:07.086Z
- taskId: task_1784774141609
- taskName: domain-knowledge
- gateLevel: standard
- totalChanges: 26
- blockedByGate: 8

## Executive Summary

- highRiskChanges: 8
- mediumRiskChanges: 12
- lowRiskChanges: 6

## Domain Index

| domain | total | high | medium | low | blocked |
| --- | --- | --- | --- | --- | --- |
| domain-knowledge | 2 | 1 | 0 | 1 | 1 |
| uncategorized | 24 | 7 | 12 | 5 | 7 |

## Domain Sections

### Domain: domain-knowledge

- [2026-07-29T08:24:45.782Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=21
- [2026-07-29T09:14:59.982Z] [dev] [low] Development drift gate passed
  - changedFiles=24

### Domain: uncategorized

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
- [2026-07-23T04:13:14.463Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=3
- [2026-07-23T04:14:28.636Z] [req] [medium] REQ snapshot updated
  - gwt-count:81->85
- [2026-07-23T04:14:28.642Z] [des] [medium] DES snapshot updated
  - des:no-semantic-diff
- [2026-07-23T04:14:28.647Z] [tcs] [medium] TCS snapshot updated
  - references-added:Req-dk-8
  - gwt-count:7->9
- [2026-07-23T04:14:28.784Z] [dev] [low] Development drift gate passed
  - changedFiles=7
- [2026-07-24T03:14:14.843Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新
  - DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新
  - DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新
  - changedFiles=18

