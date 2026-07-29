---
version: 2.1.0
ratifiedAt: 2026-07-22
source: bundled-default
repoMode: mono|multi
amendments:
  - 1.0.0 (2026-07-22): 初始内置默认宪法
---

# 工程宪法（Constitution）

> 本文件是 Fun Harness 流水线最高治理层，仅次于运行时指令（Runtime Instruction）。
> 所有阶段 Agent 必须遵守；不满足红线时必须阻断并返回失败。

## 一、不可违背的红线（Hard Constraints）

1. **HC-01 可追溯性**：每条需求必须有唯一 `Req-*` ID；设计（API/Model/不变量）、测试用例、开发任务必须绑定 `Req-*`；禁止无来源实现。
2. **HC-02 可测试性**：每条需求必须可独立验证；验收标准必须使用 GIVEN/WHEN/THEN。
3. **HC-03 安全底线**：所有外部输入必须在边界校验；禁止硬编码密钥/凭证；不得引入 OWASP Top 10 漏洞。
4. **HC-04 变更边界**：每个 Agent 仅可修改其阶段/任务声明的目标文件；禁止顺手改无关模块。
5. **HC-05 契约稳定**：下游不得单方面变更上游已确认契约（路径、字段名、方法签名）；需回到对应阶段修订并传播。

## 二、流程契约（Process Contract）

1. **阶段顺序**：需求 → 设计 → （可选）测试用例 → 任务拆解 → 开发 → **spec 评审** → 完成。
2. 每个阶段产出固定结构 Markdown，并包含机器可读 YAML 区供门禁校验。
3. 合并基线前必须通过机器门禁（结构合法 + 追溯闭环）；`spec 评审` 阶段必须通过机器门禁 + 人工 sign-off。
4. 幂等：Agent 重跑不得产生冲突 ID、重复初始化或矛盾产物。

## 三、Repo 拓扑约束（monoRepo / multiRepo）

1. 同一套治理规则同时支持 `monoRepo` 与 `multiRepo`。
2. 所有 spec 读取与写入都必须按**当前仓库根目录**解析路径，禁止硬编码 workspace 根路径。
3. `multiRepo` 模式下，每个 repo 保留自己的 `.spec/constitution.md`；共享规则可引用治理仓库版本，但不得弱化本宪法红线。

## 五、质量基线（Quality Bar）

1. 代码遵守 `.github/instructions/` 规范；冲突时以本宪法红线优先。
2. 优先最小实现，不新增未被需求驱动能力。
3. 失败要显式：硬约束不满足时必须按 FAILURE PROTOCOL 阻断，禁止伪造完成信号。

## 六、修订

宪法修订必须通过 PR 评审，并在文件头 `amendments` 记录版本号、日期、摘要。
