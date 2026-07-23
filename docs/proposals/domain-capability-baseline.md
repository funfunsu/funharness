# 提案：领域能力基线文档（Domain Capability Baseline）

> 状态：已定稿（顾虑全部达成一致，可进入落地）
> 日期：2026-07-23
> 范围：只讨论设计与规范，不涉及代码实现改动。

## 决议摘要（2026-07-23）

经讨论达成的关键决策：

1. **领域命名唯一**：同类领域禁止多名（如已有 `auth` 就不能再出现 `UserAuth`）。
   需要一个**领域注册表**作为规范名唯一来源，AI 只能复用已有规范名或走
   受控的新建流程，不得自由发散。（见 §5 顾虑一 + §8 领域注册表）
2. **人机分区标记块**：确认必要，采纳。
3. **能力清单结构化驱动**：确认，杜绝 AI 幻觉。
4. **单写者聚合**：worktree 迭代内只写 `specs/<iteration>/delta/`；`docs/domains/`
   的更新（"领域基线聚合"）**只允许在主面板操作**，worktree 子视图不提供该动作。
5. **AI 使用边界**：worktree 下只做**确定性的代码聚合**（零 AI）；只有主面板
   "领域基线聚合"里需要自然语言概括时才调用 AI。
6. **能力主键用 Req-ID**：先用 Req-ID 跑通，暂不引入 CAP-*。

## 0. 背景与问题

当前 `specs/<iteration>/delta/domain-digest.latest.md` 是**账本快照**（append-only 事件流），
它回答的是"发生过什么变更"：

```
- [2026-07-22T10:25:24Z] [des] [medium] DES snapshot updated
- [2026-07-22T10:29:01Z] [dev] [high] Development drift gate blocked
  - DEV-DRIFT-002: 检测到契约敏感代码变更...
```

问题：

1. **面向机器，不面向人**：它是给门禁/追溯用的运行记录，不是给人读的知识文档。
2. **只增不整合**：同一领域的信息随时间线性堆积，读者无法一眼看出"这个领域现在到底能做什么"。
3. **全是 `uncategorized`**：领域归类没有生效（见 §5 顾虑一），导致沉淀无意义。

**核心洞察**：需要区分两类文档，它们生命周期完全不同。

| 类别 | 回答的问题 | 形态 | 位置 | 生命周期 |
| --- | --- | --- | --- | --- |
| Delta Ledger（已有） | "发生过什么变更" | append-only 事件流 | `.harness/spec-delta/ledger.jsonl` | 运行时，可重建 |
| Domain Digest（已有） | "本次评审的变更摘要" | 单次快照 | `specs/<iteration>/delta/*.md` | 单迭代 |
| **Domain Capability（新增）** | **"这个领域现在具备什么能力"** | **活文档（就地更新）** | **`docs/domains/<domain>.md`** | **跨迭代、长期维护** |

---

## 1. 目标

1. 在 `docs/domains/` 下，为每个领域维护一份**人类可读、持续演进**的能力基线文档。
2. 每次迭代评审后，把本次涉及的领域能力**就地更新**进对应文档：已有则改/增，没有则新建。
3. 随迭代累积，`docs/domains/` 自动成长为整个项目的**领域能力地图**。
4. 机器账本与人类文档**双轨并存**，各司其职，互不污染。

---

## 2. 目标布局

```
docs/
├── domains/                      # ✅ 新增：领域能力基线（人类可读，进 git，长期维护）
│   ├── _index.md                 # 领域总览（各领域一行摘要 + 链接）
│   ├── auth.md                   # 认证域能力基线
│   ├── order.md                  # 订单域能力基线
│   └── payment.md                # 计费域能力基线
├── proposals/                    # 已有
└── project-structure.md          # 已有

specs/<iteration>/delta/          # 已有：单迭代变更摘要（保留，作为溯源）
.harness/spec-delta/ledger.jsonl  # 已有：机器账本（保留，作为数据源）
```

---

## 3. 单个领域文档结构（模板）

关键设计：**人机分区**。用标记块把"机器托管区"和"人工编辑区"物理隔离，
机器只更新标记块内部，标记块之外的人工内容永不被覆盖。

```markdown
---
domain: auth
displayName: 认证与会话
lastUpdatedAt: 2026-07-23
contributingIterations:
  - better-project-structure (2026-07-22)
  - session-timeout (2026-07-23)
---

# 认证与会话（auth）

## 领域概述
<!-- HUMAN:overview:start -->
（人工维护：这个领域的业务定位、边界、与其他领域的关系。机器不动这里。）
<!-- HUMAN:overview:end -->

## 能力清单
<!-- AUTO:capabilities:start -->
| 能力 ID | 能力描述 | 关联需求 | 状态 | 首次引入 | 最近变更 |
| --- | --- | --- | --- | --- | --- |
| CAP-auth-login | 用户名密码登录 | Req-auth-1 | active | session-timeout | session-timeout |
| CAP-auth-session | 会话超时与续期 | Req-auth-3 | active | session-timeout | session-timeout |
<!-- AUTO:capabilities:end -->

## API 契约
<!-- AUTO:contracts:start -->
| 方法 | 路径 | 关联需求 | 引入迭代 |
| --- | --- | --- | --- |
| POST | /api/auth/login | Req-auth-1 | session-timeout |
<!-- AUTO:contracts:end -->

## 关键规则与不变量
<!-- AUTO:invariants:start -->
- 会话默认 24 小时过期（Req-auth-3）
<!-- AUTO:invariants:end -->

## 补充说明
<!-- HUMAN:notes:start -->
（人工维护：设计取舍、历史包袱、注意事项。机器不动这里。）
<!-- HUMAN:notes:end -->

## 变更历史
<!-- AUTO:changelog:start -->
- 2026-07-23 [session-timeout] 新增会话超时能力（CAP-auth-session）
- 2026-07-22 [better-project-structure] 初始化登录能力（CAP-auth-login）
<!-- AUTO:changelog:end -->
```

---

## 4. 更新流程（Upsert 语义）

触发时机：Spec 评审通过后 / 任务完成归档时。

```
Spec 评审 / 任务完成
        ↓
从本迭代 requirements/design 抽取领域实体
（Req-*、API 契约、不变量，并解析其 domain 归属）
        ↓
按领域分组
        ↓
对每个领域：
  ├─ docs/domains/<domain>.md 不存在 → 用模板新建
  └─ 已存在 → 就地更新（只改标记块内部）
        ├─ 能力清单：以能力 ID / Req-ID 为主键，update-in-place（不是盲目 append）
        │     ├─ 已有该能力 → 更新"最近变更"列
        │     └─ 新能力 → 追加一行
        ├─ API 契约：以 method+path 为主键 upsert
        ├─ 不变量：以文本指纹去重
        └─ 变更历史：append 一条本次迭代摘要（唯一 append-only 区）
        ↓
更新 docs/domains/_index.md 的对应行
```

**关键：以稳定 ID 为主键做 upsert，而不是 append**。这样重复评审、多次迭代
不会产生重复内容，文档始终是"当前基线"而非"历史堆积"。

---

## 5. 我的顾虑（务必先解决）

### 顾虑一：领域归类现在是失效的（最高优先级，阻塞项）

你贴的文档里 12 条全是 `uncategorized`。原因：`domain-classification-rules.yaml`
里的领域（auth/order/payment/notification）是**通用电商示例**，与你的真实项目
（`better-project-structure` 这类）完全不匹配，关键词/前缀都命不中。

**后果**：如果归类不准，`docs/domains/` 会长出一堆错误或全是 `uncategorized`
的垃圾文档，比没有更糟。

**前置条件（必须先做）**：让领域来源于**需求本身的显式声明**，而不是靠猜。
建议在 requirements 机器块里为每条需求加 `domain` 字段：

```yaml
requirements:
  - id: Req-1
    domain: project-structure   # ⬅ 显式声明
    title: ...
```

`domain-digest` 已支持读取显式 `domain` 字段（`extractRequirementDomainMap`），
所以只要 requirement Agent 产出这个字段，归类立刻就准了。关键词/路径匹配退化为
兜底。**这一步不做，本提案的价值无从谈起。**

**决议（新增约束）**：显式 `domain` 字段还不够——还要防止**领域命名发散**。
已有 `auth` 就不能再冒出 `UserAuth`、`authentication`、`认证域` 等同义变体。
因此需要一个**领域注册表**作为规范名的唯一来源（见 §8）。requirement Agent
填 `domain` 时必须从注册表现有规范名里选；确需新建领域时走受控流程（人工确认）。

### 顾虑二：AI 生成内容 vs 人工编辑的信任边界

如果整篇文档都由 AI 每次重写，人工补充的设计说明会被冲掉，文档就没人敢维护。

**对策**：§3 的人机分区标记块。机器只碰 `AUTO:*` 区，人只碰 `HUMAN:*` 区。
这是本方案能否长期存活的关键，不能省。

**决议**：采纳，人机分区标记块保留。

### 顾虑三：真实性 / 幻觉

如果让 AI"自由总结领域能力"，它可能编造代码里根本不存在的能力。

**对策**：能力清单**必须由结构化数据驱动**（Req-*、API 契约、不变量都来自
机器可读 YAML），而不是自然语言总结。AI 最多做"把 Req 标题润色成能力描述"，
且每条能力都必须绑定 Req-ID 可溯源。宁可朴素，不可失真。

**决议**：采纳。

### 顾虑四：并行迭代的合并冲突

多个迭代在各自 worktree 里同时改同一个 `docs/domains/auth.md`，合并回主干会冲突。

**对策**：
- 表格行以 ID 排序，减少行级冲突面。
- `变更历史` 是唯一 append 区，冲突时按时间戳排序即可自动合并。
- 或者：迭代内只写 `specs/<iteration>/delta/`，**合并回主干后**由一个统一的
  "领域基线聚合"步骤更新 `docs/domains/`（单写者，无并发冲突）。推荐后者。

**决议**：采纳单写者聚合方案。**"领域基线聚合"动作只在主面板提供，worktree
子视图不出现**。这样 `docs/domains/` 永远只有一个写入者（主干），从根上消除并发冲突。

### 顾虑五：成本与时机

每次 Spec 评审都跑一遍 AI 润色会慢、会花钱。

**对策**：
- 结构化 upsert（表格/契约/不变量）用纯代码完成，零 AI 成本。
- 只有 `领域概述` 需要自然语言时才可选调用 AI，且做增量（仅新增能力时触发）。
- 默认全代码生成，AI 润色作为可选增强开关。

**决议**：采纳。明确 AI 使用边界——**worktree 下只做确定性代码聚合（零 AI）**；
只有主面板"领域基线聚合"中需要自然语言概括（领域概述/变更摘要）时才调用 AI。

### 顾虑六：能力 ID（CAP-*）从哪来

§3 模板用了 `CAP-auth-login` 这种能力 ID。它不是现有产物里的概念。

**待决策**：两个选择——
- A. 不引入 CAP-*，直接用 Req-ID 作为能力主键（简单，但一个 Req 可能对应多能力）。
- B. 引入 CAP-*，需要 requirement Agent 额外产出（更精确，但增加产物复杂度）。

建议先用 A（Req-ID 即能力键）跑通，未来再按需引入 CAP-*。

**决议**：采纳 A，能力主键用 Req-ID。

---

## 6. 落地优先级

| 优先级 | 事项 | 关联顾虑 |
| --- | --- | --- |
| P0 | 领域注册表 `docs/domains/registry.yaml` + 规范名/别名机制（§8） | 顾虑一、新顾虑 A |
| P0 | requirements 机器块新增 `domain` 字段，取值受注册表约束 | 顾虑一 |
| P0 | 领域文档模板 + 人机分区标记块规范 | 顾虑二 |
| P0 | 新建领域的人工确认门（防发散） | 顾虑一、新顾虑 A |
| P1 | worktree 侧确定性抽取器：写 `specs/<iteration>/delta/capability-delta.json` | 顾虑五、新顾虑 B |
| P1 | 主面板"领域基线聚合"动作（单写者，读 delta → upsert `docs/domains/`） | 顾虑四、五 |
| P1 | 聚合幂等：记录 `lastAggregated`，已聚合迭代自动跳过 | 新顾虑 C |
| P2 | 能力废弃语义（status: deprecated / removed） | 新顾虑 D |
| P2 | `_index.md` 总览自动生成 | — |
| P2 | 领域概述的可选 AI 润色（增量、受注册表约束） | 顾虑五 |

---

## 7. 一页纸总结

- **赞同**把 Spec Delta 从"事件账本"升级为"领域能力基线"。
- **但**先解决领域归类失效（顾虑一）——否则沉淀出来的是垃圾。
- **领域命名必须唯一**：靠 `registry.yaml` 规范名 + 别名表约束 AI，禁止 `auth`/`UserAuth` 并存。
- 领域文档放 `docs/domains/<domain>.md`，人机分区，机器只碰标记块。
- 能力清单由**结构化数据（Req/契约/不变量）**驱动，杜绝 AI 幻觉。
- upsert 以 Req-ID 为主键做就地更新，不是 append，保证文档是"当前基线"。
- **两段式**：worktree 侧只做确定性抽取（零 AI，写 delta 中间产物）；主面板"领域基线聚合"做单写者 upsert（需要时才用 AI）。
- 机器账本（`.harness`）与人类文档（`docs/domains`）双轨并存，不混用。

---

## 8. 领域注册表（Domain Registry）——防命名发散

规范名的**唯一来源**。放 `docs/domains/registry.yaml`，纳入 git，主面板维护。

```yaml
domains:
  - canonical: auth              # 规范名（唯一，小写 slug）
    displayName: 认证与会话
    aliases: [UserAuth, authentication, 认证, 认证域]   # 同义变体 → 归一到 canonical
    status: active
  - canonical: order
    displayName: 订单
    aliases: [orders, 订单域]
    status: active
```

规则：

1. requirement Agent 填 `domain` 时，**只能取 `canonical` 值**。
2. 聚合/归类时，任何领域名先过一遍别名表做**归一化**（`UserAuth` → `auth`）。
3. 出现注册表里**没有**的领域名时——**不自动新建**，而是：
   - 归类为 `uncategorized` 并在聚合报告里标记"发现疑似新领域: X"；
   - 由人在主面板**确认**后才写入注册表（决定它是新领域，还是某个已有领域的别名）。
4. AI（requirement Agent / 聚合润色）拿到的提示词里**注入当前注册表**，
   明确指令"只能复用以下规范名，不得自造同义词"。

这一层是顾虑一"同类领域禁止多名"的落地机制。

---

## 9. 由决议衍生的新顾虑

### 新顾虑 A：新领域的判定与确认成本

有了注册表后，"这是新领域还是已有领域的别名"这个判断，机器给不出可靠答案
（`payment` vs `billing` 到底是不是一回事？只有人知道）。

**建议**：新领域一律**默认拦截**，聚合时汇总成一个待确认清单，人在主面板一次性
裁决（合并进已有 / 建为新领域 / 标为别名）。宁可慢一点，也不让领域集合失控膨胀。
这是"防发散"的必要代价，需要你接受"新领域需人工过一道"。

**决议**：采纳，但**仅在有歧义时才拦截确认**——能通过 `canonical`/`aliases`
明确命中的直接归一化放行；只有注册表里查无此名、且无法确定归属的才进待确认清单。
无歧义不打扰人，有歧义才人工裁决。

### 新顾虑 B：worktree → 主面板的数据交接格式

既然 worktree 只做确定性抽取、主面板才聚合，两者之间需要一个**稳定的中间产物**
（`specs/<iteration>/delta/capability-delta.json`），包含：规范化后的领域、
Req 能力项、API 契约、不变量、以及"疑似新领域"标记。主面板聚合器只吃这个 JSON，
**不再回读迭代代码**——否则单写者又变回多处读代码，复杂度回潮。

**决议**：采纳 `capability-delta.json` 作为两段式交接契约。schema 在实现前定稿。
初版建议字段：

```jsonc
{
  "iteration": "better-project-structure",
  "generatedAt": "2026-07-23T...",
  "contentHash": "sha1...",              // 幂等键（新顾虑 C）
  "domains": [
    {
      "canonical": "auth",               // 已归一化；查无此名时为 null
      "rawDomain": "UserAuth",           // 原始值，供人工裁决
      "isSuspectedNew": false,           // 疑似新领域标记（新顾虑 A）
      "capabilities": [
        { "reqId": "Req-auth-1", "title": "用户名密码登录", "status": "active" }
      ],
      "contracts": [
        { "method": "POST", "path": "/api/auth/login", "reqId": "Req-auth-1" }
      ],
      "invariants": [
        { "text": "会话默认 24 小时过期", "reqId": "Req-auth-3" }
      ]
    }
  ]
}
```

### 新顾虑 C：聚合的幂等与"哪些迭代已入库"

主面板聚合可能被重复点击，或多个已合并迭代积压。需要记录
`docs/domains/registry.yaml` 或独立 state 里的 `lastAggregated`（已入库的迭代列表），
聚合时**只处理未入库的 delta**，避免重复 append 变更历史。

**建议**：以迭代名 + delta 内容 hash 作为幂等键。

### 新顾虑 D：能力的废弃/删除怎么表达

upsert 只解决"新增/修改"。如果某次迭代**删掉**了一个能力，纯 upsert 不会把它从
基线里移除，文档会残留幽灵能力。

**建议**：能力行加 `status`（active / deprecated / removed），删除时不删行而是
标 `removed` 并在变更历史记一笔。保留可追溯性，同时基线如实反映现状。
但这需要 delta 能识别"能力消失"——**首版可以不做**，先只支持新增/修改，
把废弃留到 P2，避免一开始就过度复杂。

### 新顾虑 E（提醒，非阻塞）：docs/domains 与现有 docs 的关系

仓库已有 `docs/project-structure.md`、`docs/todo/` 等人工文档。`docs/domains/`
是新的一类"自动维护"文档，读者需要知道**哪些 docs 是人写的、哪些是机器维护的**。
建议 `docs/domains/_index.md` 顶部写明"本目录由领域基线聚合自动维护，人工编辑
请只改 `HUMAN:*` 标记块内"。
