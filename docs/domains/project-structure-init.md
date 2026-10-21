---
domain: project-structure-init
version: v0
---

<!-- AUTO:capabilities:start -->
| 能力 | 状态 | 关联接口 | 关联需求 |
|------|------|----------|----------|
| CodeGraph 失败处理与追踪能力 | active | API-5 | Req-4 |
| CodeGraph 安装与流程持续能力 | active | - | Req-3 |
| CodeGraph 自动构建能力 | active | API-1, API-4 | Req-1 |
| 自动 CodeGraph 控制能力 | active | API-2 | Req-2 |
<!-- AUTO:capabilities:end -->

<!-- AUTO:contracts:start -->
| Key | Req-ID | Method | Path |
|-----|--------|--------|------|
| API-1 | Req-1 | EVENT | /internal/codegraph/init/run-once |
| API-2 | Req-2 | EVENT | /internal/codegraph/config/normalize-policy |
| API-4 | Req-1 | EVENT | /internal/codegraph/sync/manual |
| API-5 | Req-4 | EVENT | /internal/codegraph/process/append-run-record |
<!-- AUTO:contracts:end -->

<!-- AUTO:invariants:start -->
- [INV-1](Req-1) wasNewlyCreated=true 且 autoCodeGraphEnabled=true 时，必须触发一次初始化编排；已有 worktree/缺图场景允许补偿触发。
- [INV-2](Req-2) 配置缺省时自动构建开关为开启；关闭后禁止触发；重开后恢复触发。
- [INV-3](Req-3) CLI 缺失且自动安装策略开启时必须尝试一次安装并记录，不得阻断主流程。
- [INV-4](Req-4) 成功/告警/去重等常规分支必须写入一条完整过程记录；异常抛出分支需额外兜底保障。
- [INV-5](Req-4) 同一 sessionId+worktreePath 初始化窗口内活跃构建并发数不得超过 1。
<!-- AUTO:invariants:end -->

<!-- HUMAN:overview:start -->
<!-- HUMAN:overview:end -->

<!-- HUMAN:notes:start -->
<!-- HUMAN:notes:end -->

<!-- AUTO:changelog:start -->
<!-- AUTO:changelog:end -->
