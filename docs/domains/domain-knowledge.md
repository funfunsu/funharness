---
domain: domain-knowledge
version: v0
---

<!-- AUTO:capabilities:start -->
| 能力 | 状态 | 关联接口 | 关联需求 |
|------|------|----------|----------|
| 图谱证据包注入能力 | active | API-3 | Req-5 |
<!-- AUTO:capabilities:end -->

<!-- AUTO:contracts:start -->
| Key | Req-ID | Method | Path |
|-----|--------|--------|------|
| API-3 | Req-5 | EVENT | /internal/codegraph/evidence/get-stage-evidence |
<!-- AUTO:contracts:end -->

<!-- AUTO:invariants:start -->
- [INV-6](Req-5) 证据缺失或过期时必须告警降级，禁止将未查询到节点推断为不存在业务关系。
<!-- AUTO:invariants:end -->

<!-- HUMAN:overview:start -->
<!-- HUMAN:overview:end -->

<!-- HUMAN:notes:start -->
<!-- HUMAN:notes:end -->

<!-- AUTO:changelog:start -->
<!-- AUTO:changelog:end -->
