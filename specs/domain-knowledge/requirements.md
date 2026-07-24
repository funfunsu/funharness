# 需求文档

## 简介

本需求面向 Fun Harness 流水线的「领域知识库构建（Domain Capability Baseline）」能力。目标是在现有「Delta 事件账本（`.harness/spec-delta/ledger.jsonl`）」与「单迭代变更摘要（`specs/<iteration>/delta/*.md`）」之外，新增一类**人类可读、跨迭代持续演进**的「领域能力基线」活文档，落盘于 `docs/domains/<domain>.md`，随迭代累积成长为整个项目的**领域能力地图**，与机器账本双轨并存、互不污染。

方案已在 `docs/proposals/domain-capability-baseline.md`（v 已定稿，2026-07-23）中达成一致。本需求文档据此收敛「做什么」与「验收标准」，不约束具体代码实现细节。

核心约束（源自提案决议）：

- 领域命名唯一：同类领域禁止多名（如已有 `auth` 不得再出现 `UserAuth`），以**领域注册表**为规范名唯一来源。
- 能力清单由**结构化数据（Req-*、API 契约、不变量）**驱动，杜绝 AI 幻觉；能力主键复用 **Req-ID**。
- 人机分区：机器仅写 `AUTO:*` 标记块，人工仅写 `HUMAN:*` 标记块，互不覆盖。
- 单写者聚合：worktree 只做**确定性抽取（零 AI）**，`docs/domains/` 的更新只允许在**主面板**执行。

## 术语表

| 术语 | 说明 |
| --- | --- |
| Delta 账本 | `.harness/spec-delta/ledger.jsonl`，append-only 机器事件流，回答「发生过什么变更」，运行时可重建 |
| Domain Digest | `specs/<iteration>/delta/*.md`，单迭代变更摘要快照，作为溯源保留 |
| 领域能力基线 | `docs/domains/<domain>.md`，人类可读、跨迭代就地更新的活文档，回答「这个领域现在具备什么能力」 |
| 领域注册表 | `docs/domains/registry.yaml`，规范名（canonical）与别名（aliases）的唯一来源，纳入 git，主面板维护 |
| 规范名（canonical） | 领域的唯一小写 slug 标识，是 requirement `domain` 字段的合法取值集合 |
| 别名（aliases） | 同义变体到规范名的归一化映射（如 `UserAuth` → `auth`） |
| 人机分区标记块 | `<!-- AUTO:*:start/end -->`（机器托管区）与 `<!-- HUMAN:*:start/end -->`（人工编辑区） |
| Upsert | 以稳定 ID 为主键的「有则就地更新、无则新增」语义，区别于盲目 append |
| capability-delta.json | `specs/<iteration>/delta/capability-delta.json`，worktree 抽取器与主面板聚合器之间的稳定中间产物（两段式交接契约） |
| 领域基线聚合 | 主面板单写者动作：读 `capability-delta.json` → upsert `docs/domains/` |
| 疑似新领域 | 注册表中查无此名且无法自动归属的领域名，需人工裁决 |
| 幂等键 | 迭代名 + delta 内容 hash，用于跳过已入库迭代，防止重复聚合 |

## 需求清单

### 需求-1：领域注册表作为规范名唯一来源

**用户故事：** 作为流水线治理者，我希望所有领域名都来自一份受控的领域注册表，以便于杜绝同类领域多名发散，保证 `docs/domains/` 沉淀的是可信资产而非垃圾文档。

#### 验收标准

1. GIVEN 仓库位于当前仓库根目录下，WHEN 领域知识库能力初始化，THEN 系统必须能读取/创建 `docs/domains/registry.yaml`，且其结构包含 `domains[]`，每项含 `canonical`（唯一小写 slug）、`displayName`、`aliases[]`、`status`。
2. GIVEN 一个领域名（原始值）需要归类，WHEN 执行归一化，THEN 系统必须先按 `canonical` 精确匹配、再按 `aliases` 匹配，命中则归一化为对应 `canonical`（如 `UserAuth` → `auth`）。
3. GIVEN 两条领域记录出现重复的 `canonical` 或某别名同时映射到多个 `canonical`，WHEN 校验注册表，THEN 系统必须判定为非法并阻断，返回冲突明细。
4. GIVEN 注册表路径解析，WHEN 处于 monoRepo 或 multiRepo 拓扑，THEN 路径必须按当前仓库根目录解析，禁止硬编码 workspace 根路径。

### 需求-2：requirements 机器块显式声明受约束的 domain 字段

**用户故事：** 作为需求作者/Requirement Agent，我希望每条需求在机器块中显式声明所属领域，且取值只能来自注册表规范名，以便于领域归类准确、不依赖关键词猜测。

#### 验收标准

1. GIVEN Requirement Agent 生成需求机器块，WHEN 为需求填写领域，THEN 每条需求的机器块必须包含 `domain` 字段，且取值必须是注册表中已存在的 `canonical` 值之一。
2. GIVEN 某需求 `domain` 取值不在注册表 `canonical` 集合中，WHEN 门禁校验需求产物，THEN 系统必须将其标记为 `uncategorized` 或阻断，并在报告中提示「疑似新领域：X」，不得静默通过为一个新领域。
3. GIVEN 存在显式 `domain` 字段，WHEN 领域归类解析执行，THEN 显式字段的优先级必须高于 Req-ID 前缀、路径、契约与关键词匹配（关键词/路径匹配仅作兜底）。
4. GIVEN 向 AI（Requirement Agent 或聚合润色）注入提示词，WHEN 需要选择领域，THEN 提示词必须注入当前注册表规范名清单并明确「只能复用以下规范名、不得自造同义词」。

### 需求-3：领域能力基线文档模板与人机分区

**用户故事：** 作为文档维护者，我希望领域文档采用固定模板并物理隔离机器区与人工区，以便于机器更新时永不覆盖人工补充的设计说明，让文档长期可维护。

#### 验收标准

1. GIVEN 需要新建某领域文档，WHEN 领域文档不存在，THEN 系统必须按统一模板创建 `docs/domains/<domain>.md`，且包含 front matter（`domain`/`displayName`/`lastUpdatedAt`/`contributingIterations`）与「领域概述、能力清单、API 契约、关键规则与不变量、补充说明、变更历史」各区块。
2. GIVEN 模板已定义区块归属，WHEN 机器执行更新，THEN 机器只能修改 `AUTO:*`（capabilities/contracts/invariants/changelog）标记块内部，`HUMAN:*`（overview/notes）标记块内容必须原样保留。
3. GIVEN 文档已被人工在 `HUMAN:*` 区编辑过，WHEN 再次触发机器更新，THEN `HUMAN:*` 区内容必须与更新前逐字节一致（不被覆盖、删除或重排）。
4. GIVEN 能力清单区块，WHEN 渲染能力行，THEN 每条能力必须绑定可溯源的 `Req-ID`（能力主键即 Req-ID），且不得出现无 Req 来源的能力行。

### 需求-4：领域文档 Upsert 就地更新语义

**用户故事：** 作为文档维护者，我希望重复评审与多次迭代都以稳定 ID 为主键做就地更新而非追加，以便于文档始终反映「当前基线」而不是历史堆积。

#### 验收标准

1. GIVEN 某能力（以 `Req-ID` 为主键）已存在于能力清单，WHEN 本迭代再次涉及该能力，THEN 系统必须就地更新该行的「最近变更」等列，而不得新增重复行。
2. GIVEN 某能力对应的 `Req-ID` 在清单中不存在，WHEN 聚合本迭代能力，THEN 系统必须追加一行新能力，并记录「首次引入」迭代。
3. GIVEN API 契约以 `method + path` 为主键，WHEN 聚合契约，THEN 相同 `method + path` 必须 upsert（不重复），不同则新增。
4. GIVEN 不变量以文本指纹为去重键，WHEN 聚合不变量，THEN 文本指纹相同的不变量必须去重，不得重复出现。
5. GIVEN 变更历史区块，WHEN 本次迭代聚合完成，THEN 系统必须在其中 append 恰好一条本迭代摘要（该区块是唯一 append-only 区），且其余 `AUTO:*` 区均为 upsert 语义。

### 需求-5：worktree 侧确定性抽取产出 capability-delta.json

**用户故事：** 作为迭代执行者，我希望 worktree 内只做确定性的代码/规格抽取并输出稳定中间产物，以便于主面板聚合时无需回读迭代代码，从根上避免多处读代码的复杂度回潮。

#### 验收标准

1. GIVEN Spec 评审通过或任务完成归档，WHEN 在 worktree 内执行抽取，THEN 系统必须从本迭代 requirements/design 抽取领域实体（`Req-*` 能力、API 契约、不变量及其 `domain` 归属），并写入 `specs/<iteration>/delta/capability-delta.json`。
2. GIVEN 抽取过程，WHEN 生成 `capability-delta.json`，THEN 抽取过程必须是确定性的、零 AI 调用（相同输入产出相同结果）。
3. GIVEN `capability-delta.json` 的结构，WHEN 校验其 schema，THEN 必须包含 `iteration`、`generatedAt`、`contentHash`（幂等键）、`domains[]`，且每个 domain 含 `canonical`（已归一化，查无此名时为 `null`）、`rawDomain`（原始值）、`isSuspectedNew`、`capabilities[]`、`contracts[]`、`invariants[]`。
4. GIVEN worktree 子视图，WHEN 用户查看可用动作，THEN 子视图**不得**提供「领域基线聚合」动作（该动作仅属主面板）。

### 需求-6：主面板单写者「领域基线聚合」

**用户故事：** 作为主干维护者，我希望 `docs/domains/` 永远只有一个写入者（主面板），以便于并行迭代不会在合并回主干时产生并发写冲突。

#### 验收标准

1. GIVEN 主面板执行「领域基线聚合」，WHEN 聚合运行，THEN 系统必须只读取 `capability-delta.json` 作为输入来源，不得回读迭代源代码。
2. GIVEN 聚合读入若干领域的 delta，WHEN 写入基线，THEN 系统必须按领域分组对 `docs/domains/<domain>.md` 执行需求-4 定义的 upsert，并同步更新 `docs/domains/_index.md` 对应行。
3. GIVEN 聚合动作的入口，WHEN 在 worktree 子视图查询，THEN 该动作必须仅在主面板出现，worktree 子视图不可触发。
4. GIVEN 聚合涉及领域文档写入，WHEN 处于 multiRepo 拓扑，THEN 写入路径必须按当前仓库根目录解析，且各 repo 的写入互不越界。
5. GIVEN 当前迭代未产出 `testcase.md`，WHEN 主面板评估任务健康状态，THEN 系统不得仅因 testcase 缺失而给出阻塞或告警。

### 需求-7：新领域发散防护与人工裁决门

**用户故事：** 作为治理者，我希望只有在领域归属存在歧义时才拦截人工确认，以便于既防止领域集合失控膨胀，又不在无歧义时打扰人。

#### 验收标准

1. GIVEN 某领域名能通过 `canonical` 或 `aliases` 明确命中，WHEN 聚合归类，THEN 系统必须直接归一化放行，不得进入待确认清单。
2. GIVEN 某领域名在注册表中查无此名且无法确定归属，WHEN 聚合归类，THEN 系统必须将其标记为 `isSuspectedNew=true`、暂归 `uncategorized`，并汇总进主面板「待确认清单」，不得自动新建领域。
3. GIVEN 待确认清单存在条目，WHEN 人在主面板裁决，THEN 系统必须支持三种结果——合并进已有领域 / 建为新领域（写入注册表 `canonical`）/ 标为某已有领域别名（写入 `aliases`）。
4. GIVEN 未经人工裁决，WHEN 聚合运行，THEN 系统不得把疑似新领域的能力写入任何正式 `docs/domains/<domain>.md`（除 `uncategorized` 暂存外）。

### 需求-8：聚合幂等与已入库迭代跟踪

**用户故事：** 作为主面板操作者，我希望重复点击聚合或积压多个已合并迭代时不会重复写入，以便于变更历史不出现重复条目、基线保持一致。

#### 验收标准

1. GIVEN 系统记录已入库迭代（`lastAggregated`：迭代名 + delta `contentHash`），WHEN 聚合启动，THEN 系统必须只处理未入库的 delta，跳过已入库项。
2. GIVEN 同一 `capability-delta.json`（`contentHash` 未变）被再次聚合，WHEN 聚合执行，THEN 结果必须与首次一致，变更历史不得新增重复条目（幂等）。
3. GIVEN 某迭代 delta 内容发生变化（`contentHash` 改变），WHEN 再次聚合，THEN 系统必须将其视为未入库项重新处理，并按 upsert 更新基线。
4. GIVEN 聚合完成，WHEN 写回状态，THEN 系统必须持久化更新后的 `lastAggregated` 记录（如 `registry.yaml` 或独立 state），保证下次聚合可据此跳过。

### 需求-9：能力废弃/删除的状态语义

**用户故事：** 作为文档读者，我希望被删除或废弃的能力在基线中如实反映而非残留为幽灵能力，以便于基线始终真实且可追溯。

#### 验收标准

1. GIVEN 能力清单每一行，WHEN 渲染能力，THEN 每条能力必须带 `status` 列，取值范围为 `active` / `deprecated` / `removed`。
2. GIVEN 某能力被标为 `deprecated` 或 `removed`，WHEN 聚合更新，THEN 系统必须保留该能力行（不物理删除）、更新其 `status`，并在变更历史 append 一条状态变更记录。
3. GIVEN 首版能力范围，WHEN delta 无法识别「能力消失」，THEN 系统至少必须正确支持新增/修改，废弃识别可延后，但已存在的 `status` 字段与保留行为不得破坏可追溯性。

### 需求-10：领域总览 `_index.md` 与人机维护边界说明

**用户故事：** 作为文档读者，我希望有一份领域总览并清楚哪些内容由机器维护、哪些可人工编辑，以便于不会误改机器托管区、也知道该改哪里。

#### 验收标准

1. GIVEN 聚合更新了某领域文档，WHEN 聚合完成，THEN `docs/domains/_index.md` 必须包含该领域的一行摘要与指向 `docs/domains/<domain>.md` 的链接，并同步保持最新。
2. GIVEN `_index.md` 顶部，WHEN 渲染文档，THEN 必须写明「本目录由领域基线聚合自动维护，人工编辑请只改 `HUMAN:*` 标记块内」。
3. GIVEN 某领域文档被新建或状态变化，WHEN 更新 `_index.md`，THEN 更新必须以领域 `canonical` 为主键 upsert 对应行，不得产生重复行。

### 需求-11：AI 使用边界

**用户故事：** 作为成本与真实性负责人，我希望明确 AI 的使用边界，以便于控制成本、并杜绝 AI 编造代码中不存在的能力。

#### 验收标准

1. GIVEN worktree 侧的抽取与 delta 生成，WHEN 执行，THEN 全流程必须零 AI 调用（纯确定性代码聚合）。
2. GIVEN 结构化 upsert（能力清单/契约/不变量表格），WHEN 聚合执行，THEN 这些内容必须由纯代码生成，不依赖 AI。
3. GIVEN 仅「领域概述/变更摘要」等需要自然语言概括的场景，WHEN 在主面板聚合中启用可选 AI 润色，THEN AI 只能对已有结构化能力做润色描述、不得新增无 Req 来源的能力，且提示词中必须注入注册表约束以防造词。
4. GIVEN AI 润色为可选增强，WHEN 未开启润色开关，THEN 系统必须能仅凭确定性代码完成全部基线更新（默认全代码生成）。

### 需求-12：机器账本与人类文档双轨并存

**用户故事：** 作为架构治理者，我希望机器账本与人类领域文档双轨并存、互不污染，以便于各司其职：账本供门禁/追溯，文档供人阅读。

#### 验收标准

1. GIVEN 领域知识库能力运行，WHEN 写入产物，THEN 机器账本（`.harness/spec-delta/ledger.jsonl`）与单迭代摘要（`specs/<iteration>/delta/*.md`）必须保留原有职责，不被领域基线流程改写或删除。
2. GIVEN 领域基线写入，WHEN 更新文档，THEN 人类文档只写入 `docs/domains/`，不得把 append-only 事件流内容混入领域基线，也不得把领域基线内容写回机器账本。
3. GIVEN 两类产物同时存在，WHEN 追溯某能力，THEN 领域基线中的每条能力必须能通过 `Req-ID` 追溯回对应迭代的 requirements/design 与 delta 来源。

## 需求追踪矩阵（映射提案来源）

| 需求 ID | 标题 | 领域 | 提案来源（domain-capability-baseline.md） |
| --- | --- | --- | --- |
| Req-dk-1 | 领域注册表作为规范名唯一来源 | domain-knowledge | §5 顾虑一、§8、§6(P0) |
| Req-dk-2 | requirements 显式受约束 domain 字段 | domain-knowledge | §5 顾虑一、§8 规则 1/4、§6(P0) |
| Req-dk-3 | 领域文档模板与人机分区 | domain-knowledge | §3、§5 顾虑二、§6(P0) |
| Req-dk-4 | 领域文档 Upsert 就地更新语义 | domain-knowledge | §4、§7 |
| Req-dk-5 | worktree 侧确定性抽取 capability-delta.json | domain-knowledge | §4、§9 新顾虑 B、§6(P1) |
| Req-dk-6 | 主面板单写者领域基线聚合 | domain-knowledge | §5 顾虑四、§6(P1) |
| Req-dk-7 | 新领域发散防护与人工裁决门 | domain-knowledge | §8 规则 3、§9 新顾虑 A、§6(P0) |
| Req-dk-8 | 聚合幂等与已入库迭代跟踪 | domain-knowledge | §9 新顾虑 C、§6(P1) |
| Req-dk-9 | 能力废弃/删除状态语义 | domain-knowledge | §9 新顾虑 D、§6(P2) |
| Req-dk-10 | 领域总览 `_index.md` 与维护边界 | domain-knowledge | §9 新顾虑 E、§6(P2) |
| Req-dk-11 | AI 使用边界 | domain-knowledge | §5 顾虑三/五、决议 5、§6(P2) |
| Req-dk-12 | 机器账本与人类文档双轨并存 | domain-knowledge | §0、§1、§7 |

## 机器可读区

```yaml
artifactType: requirements
taskName: domain-knowledge
sourceProposal: docs/proposals/domain-capability-baseline.md
requirements:
  - id: Req-dk-1
    domain: domain-knowledge
    title: 领域注册表作为规范名唯一来源
    userStory: 作为流水线治理者，我希望所有领域名都来自一份受控的领域注册表，以便于杜绝同类领域多名发散，保证沉淀的是可信资产而非垃圾文档
    acceptanceCriteria:
      - GIVEN 仓库位于当前仓库根目录下 WHEN 领域知识库能力初始化 THEN 必须能读取/创建 docs/domains/registry.yaml 且含 domains[]（canonical/displayName/aliases/status）
      - GIVEN 一个领域名需要归类 WHEN 执行归一化 THEN 先按 canonical 再按 aliases 匹配并归一化为对应 canonical
      - GIVEN 出现重复 canonical 或别名映射到多个 canonical WHEN 校验注册表 THEN 判定非法并阻断返回冲突明细
      - GIVEN 注册表路径解析 WHEN 处于 monoRepo 或 multiRepo THEN 按当前仓库根目录解析禁止硬编码 workspace 根路径
  - id: Req-dk-2
    domain: domain-knowledge
    title: requirements 机器块显式声明受约束的 domain 字段
    userStory: 作为需求作者/Requirement Agent，我希望每条需求显式声明所属领域且取值只能来自注册表规范名，以便于领域归类准确不依赖关键词猜测
    acceptanceCriteria:
      - GIVEN Requirement Agent 生成需求机器块 WHEN 填写领域 THEN 每条需求含 domain 字段且取值是注册表已存在的 canonical 之一
      - GIVEN domain 取值不在 canonical 集合 WHEN 门禁校验 THEN 标记 uncategorized 或阻断并提示疑似新领域不得静默新建
      - GIVEN 存在显式 domain 字段 WHEN 领域归类解析 THEN 显式字段优先级高于 ReqId 前缀/路径/契约/关键词匹配
      - GIVEN 向 AI 注入提示词 WHEN 需要选择领域 THEN 注入当前注册表规范名清单并明确只能复用不得自造同义词
  - id: Req-dk-3
    domain: domain-knowledge
    title: 领域能力基线文档模板与人机分区
    userStory: 作为文档维护者，我希望领域文档采用固定模板并物理隔离机器区与人工区，以便于机器更新时永不覆盖人工补充让文档长期可维护
    acceptanceCriteria:
      - GIVEN 需要新建某领域文档 WHEN 文档不存在 THEN 按统一模板创建 docs/domains/<domain>.md 含 front matter 与六个区块
      - GIVEN 模板已定义区块归属 WHEN 机器执行更新 THEN 只能改 AUTO:* 标记块内部 HUMAN:* 内容原样保留
      - GIVEN 文档被人工在 HUMAN:* 区编辑过 WHEN 再次机器更新 THEN HUMAN:* 区内容逐字节一致
      - GIVEN 能力清单区块 WHEN 渲染能力行 THEN 每条能力绑定可溯源 Req-ID 不得出现无来源能力行
  - id: Req-dk-4
    domain: domain-knowledge
    title: 领域文档 Upsert 就地更新语义
    userStory: 作为文档维护者，我希望重复评审与多次迭代以稳定 ID 主键就地更新而非追加，以便于文档始终反映当前基线而非历史堆积
    acceptanceCriteria:
      - GIVEN 某能力以 Req-ID 主键已存在 WHEN 本迭代再次涉及 THEN 就地更新最近变更列不新增重复行
      - GIVEN 某能力 Req-ID 不存在 WHEN 聚合能力 THEN 追加新能力行并记录首次引入迭代
      - GIVEN API 契约以 method+path 主键 WHEN 聚合契约 THEN 相同 method+path upsert 不重复不同则新增
      - GIVEN 不变量以文本指纹去重 WHEN 聚合不变量 THEN 文本指纹相同去重不重复
      - GIVEN 变更历史区块 WHEN 本次迭代聚合完成 THEN append 恰好一条本迭代摘要 其余 AUTO:* 区为 upsert
  - id: Req-dk-5
    domain: domain-knowledge
    title: worktree 侧确定性抽取产出 capability-delta.json
    userStory: 作为迭代执行者，我希望 worktree 内只做确定性抽取并输出稳定中间产物，以便于主面板聚合无需回读迭代代码避免复杂度回潮
    acceptanceCriteria:
      - GIVEN Spec 评审通过或任务完成归档 WHEN worktree 内执行抽取 THEN 从 requirements/design 抽取领域实体写入 specs/<iteration>/delta/capability-delta.json
      - GIVEN 抽取过程 WHEN 生成 capability-delta.json THEN 确定性零 AI 调用相同输入产出相同结果
      - GIVEN capability-delta.json 结构 WHEN 校验 schema THEN 含 iteration/generatedAt/contentHash/domains[] 且每 domain 含 canonical/rawDomain/isSuspectedNew/capabilities/contracts/invariants
      - GIVEN worktree 子视图 WHEN 查看可用动作 THEN 不得提供领域基线聚合动作
  - id: Req-dk-6
    domain: domain-knowledge
    title: 主面板单写者领域基线聚合
    userStory: 作为主干维护者，我希望 docs/domains 永远只有一个写入者主面板，以便于并行迭代合并回主干不产生并发写冲突
    acceptanceCriteria:
      - GIVEN 主面板执行领域基线聚合 WHEN 聚合运行 THEN 只读取 capability-delta.json 不回读迭代源代码
      - GIVEN 聚合读入若干领域 delta WHEN 写入基线 THEN 按领域分组对 docs/domains/<domain>.md 执行 upsert 并同步更新 _index.md
      - GIVEN 聚合动作入口 WHEN 在 worktree 子视图查询 THEN 仅主面板出现 worktree 不可触发
      - GIVEN 聚合涉及领域文档写入 WHEN 处于 multiRepo THEN 写入路径按当前仓库根目录解析各 repo 互不越界
      - GIVEN 当前迭代未产出 testcase.md WHEN 主面板评估任务健康状态 THEN 不得仅因 testcase 缺失给出阻塞或告警
  - id: Req-dk-7
    domain: domain-knowledge
    title: 新领域发散防护与人工裁决门
    userStory: 作为治理者，我希望只有在领域归属存在歧义时才拦截人工确认，以便于既防止领域集合膨胀又不在无歧义时打扰人
    acceptanceCriteria:
      - GIVEN 领域名能通过 canonical 或 aliases 明确命中 WHEN 聚合归类 THEN 直接归一化放行不进待确认清单
      - GIVEN 领域名查无此名且无法确定归属 WHEN 聚合归类 THEN 标记 isSuspectedNew 暂归 uncategorized 进待确认清单不自动新建
      - GIVEN 待确认清单存在条目 WHEN 人在主面板裁决 THEN 支持合并进已有/建为新领域/标为别名三种结果
      - GIVEN 未经人工裁决 WHEN 聚合运行 THEN 不得把疑似新领域能力写入正式 docs/domains/<domain>.md（uncategorized 暂存除外）
  - id: Req-dk-8
    domain: domain-knowledge
    title: 聚合幂等与已入库迭代跟踪
    userStory: 作为主面板操作者，我希望重复点击聚合或积压多迭代时不会重复写入，以便于变更历史不重复基线保持一致
    acceptanceCriteria:
      - GIVEN 系统记录已入库迭代 lastAggregated（迭代名+contentHash） WHEN 聚合启动 THEN 只处理未入库 delta 跳过已入库项
      - GIVEN 同一 capability-delta.json（contentHash 未变）再次聚合 WHEN 执行 THEN 结果与首次一致变更历史不新增重复条目
      - GIVEN 某迭代 delta contentHash 改变 WHEN 再次聚合 THEN 视为未入库项重新处理按 upsert 更新
      - GIVEN 聚合完成 WHEN 写回状态 THEN 持久化更新后的 lastAggregated 记录供下次跳过
  - id: Req-dk-9
    domain: domain-knowledge
    title: 能力废弃/删除的状态语义
    userStory: 作为文档读者，我希望被删除或废弃的能力如实反映而非残留幽灵能力，以便于基线始终真实可追溯
    acceptanceCriteria:
      - GIVEN 能力清单每一行 WHEN 渲染能力 THEN 每条能力带 status 列取值 active/deprecated/removed
      - GIVEN 能力被标 deprecated 或 removed WHEN 聚合更新 THEN 保留该行更新 status 并在变更历史 append 状态变更记录
      - GIVEN 首版能力范围 WHEN delta 无法识别能力消失 THEN 至少正确支持新增/修改 废弃识别可延后但 status 字段与保留行为不破坏可追溯性
  - id: Req-dk-10
    domain: domain-knowledge
    title: 领域总览 _index.md 与人机维护边界说明
    userStory: 作为文档读者，我希望有一份领域总览并清楚哪些由机器维护哪些可人工编辑，以便于不误改机器托管区也知道该改哪里
    acceptanceCriteria:
      - GIVEN 聚合更新了某领域文档 WHEN 聚合完成 THEN _index.md 含该领域一行摘要与链接并保持最新
      - GIVEN _index.md 顶部 WHEN 渲染文档 THEN 写明本目录由聚合自动维护人工编辑请只改 HUMAN:* 标记块内
      - GIVEN 某领域文档新建或状态变化 WHEN 更新 _index.md THEN 以 canonical 主键 upsert 对应行不产生重复行
  - id: Req-dk-11
    domain: domain-knowledge
    title: AI 使用边界
    userStory: 作为成本与真实性负责人，我希望明确 AI 使用边界，以便于控制成本并杜绝 AI 编造不存在的能力
    acceptanceCriteria:
      - GIVEN worktree 侧抽取与 delta 生成 WHEN 执行 THEN 全流程零 AI 调用纯确定性代码聚合
      - GIVEN 结构化 upsert 表格 WHEN 聚合执行 THEN 由纯代码生成不依赖 AI
      - GIVEN 仅领域概述/变更摘要需要自然语言 WHEN 启用可选 AI 润色 THEN AI 只对已有结构化能力润色不新增无 Req 来源能力且提示词注入注册表约束防造词
      - GIVEN AI 润色为可选增强 WHEN 未开启润色开关 THEN 仅凭确定性代码完成全部基线更新
  - id: Req-dk-12
    domain: domain-knowledge
    title: 机器账本与人类文档双轨并存
    userStory: 作为架构治理者，我希望机器账本与人类领域文档双轨并存互不污染，以便于各司其职账本供门禁追溯文档供人阅读
    acceptanceCriteria:
      - GIVEN 领域知识库能力运行 WHEN 写入产物 THEN 机器账本 ledger.jsonl 与单迭代摘要 specs/<iteration>/delta/*.md 保留原职责不被改写删除
      - GIVEN 领域基线写入 WHEN 更新文档 THEN 人类文档只写入 docs/domains 不混入事件流也不写回机器账本
      - GIVEN 两类产物同时存在 WHEN 追溯某能力 THEN 领域基线每条能力能通过 Req-ID 追溯回对应迭代 requirements/design 与 delta 来源
```
