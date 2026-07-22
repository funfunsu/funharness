# Fun Harness 改进方案：Spec 产物治理、Constitution 管理与门禁分层模型

> 状态：提案（Draft）
> 日期：2026-07-22
> 范围：本文档只讨论设计与规范，不涉及任何代码实现改动。

本方案针对三个已确认的问题给出结论与落地设计：

1. Spec 相关产物当前全部落在 `docs/` 下是否合适，应该如何组织；
2. Constitution（工程宪法/原则层）放在哪里、如何管理；
3. 门禁（Gate）力度如何设计，才能既严格又不把流程做重。

---

## 0. 现状快照（事实基线）

- 迭代内 spec 产物落位（见 `apps/src/models.ts` 的 `getSpecDocsDir`）：
  - 多仓模式：`<worktree>/docs/{requirements,design,testcase,tasks}.md`
  - 单仓（mono）模式：`<worktree>/docs/<iteration>/{...}.md`（用任务名子目录避免合并冲突）
- 归档（见 `apps/src/services/harnessActionsService.ts` 的 `syncTaskDocsToMaster`）：
  - 多仓模式合并/推送后回灌主仓 `docs/requirements/requirements-<name>.md`、`docs/designs/designs-<name>.md`，并维护 `docs/artifacts-index.json`
- 项目结构文档：`docs/project-structure.md`
- 校验（`validateStageArtifact`）：仅结构/正则级，不解析机器可读 YAML 做交叉校验
- 完成判定（`taskScheduler.handleSignal`）：只校验输出文件是否存在，不自动跑测试/编译
- 并行：`maxConcurrentAutoTasks` 控制的是**迭代级**并行槽位，非单迭代内 dev 子任务并行

结论：结构规范已具备，但**命名空间语义、宪法层、门禁分层**三处需要治理。

---

## 1. 问题一：Spec 产物目录治理

### 1.1 为什么 `docs/` 不合适

`docs/` 的通用语义是**面向人的、长期维护的产品与工程文档**（README、架构说明、使用手册、ADR）。把 AI 流水线的阶段产物塞进来会带来三个问题：

- **语义混淆**：读者无法区分"权威产品文档"与"某次迭代的中间产物"。
- **主仓污染**：mono 模式下迭代分支合并会把 `docs/<iteration>/` 持续灌入主仓，多迭代累积后 `docs/` 变成垃圾场。
- **治理困难**：真正需要长期维护的文档（架构决策、运维手册）与一次性产物混杂，无法独立管理生命周期。

业界对照：

| 方案 | Spec 存放位置 | 宪法/原则层 |
| --- | --- | --- |
| GitHub spec-kit | `.specify/specs/<feature>/` | `.specify/memory/constitution.md` |
| Kiro | `.kiro/specs/<feature>/` | `.kiro/steering/` |
| 通用 Agent 约定 | — | `AGENTS.md` / `.github/instructions/` |

共同点：**spec 产物与人类文档物理分离，放进工具专属命名空间**。

### 1.2 目标布局（推荐）

关键区分三类产物，按"是否进 git"与"作用域"分层：

| 类别 | 是否进 git | 作用域 | 位置 |
| --- | --- | --- | --- |
| Constitution（宪法） | ✅ 是 | 全局、跨迭代、随项目走 | 目标 repo 内 `.spec/`（源头），同步进 worktree |
| Spec 产物（需求/设计/…） | ✅ 是 | 单迭代 | `specs/<iteration>/` |
| 运行时状态（signals/logs） | ❌ 否（gitignore） | 单迭代运行期 | `.harness/` |

```
目标项目 repo（git 跟踪，团队共享，随项目走）
<project-repo>/
├── .spec/                        # ✅ 全局治理命名空间（git 跟踪）
│   └── constitution.md           # 宪法：源头在此，见问题二
├── .github/
│   └── instructions/*.md         # 编码规范（已有）
└── ...(项目源码)

Harness 工作区
<harness-root>/
├── docs/                         # 纯人类文档（回归本职）
│   ├── project-structure.md      # 项目结构（长期维护，保留）
│   ├── proposals/                # 方案/提案（如本文件）
│   └── adr/                      # 架构决策记录（可选）
│
├── specs/                        # ✅ 可评审的 spec 产物（进版本库、可 diff、可 review）
│   ├── <iteration>/
│   │   ├── requirements.md
│   │   ├── design.md
│   │   ├── testcase.md
│   │   └── tasks.md
│   └── artifacts-index.json      # 归档索引（从 docs/ 迁移过来）
│
└── .harness/                     # ✅ 纯运行时状态（.gitignore，不进主仓）
    ├── signals/                  # done-* 信号文件
    ├── logs/                     # 每任务日志
    ├── constitution.md           # ⬅ 仅为从 repo 同步来的只读副本（非源头）
    └── iteration-state.json      # 迭代状态机
```

设计原则：

- **Constitution 源头在目标 repo 的 `.spec/`（git 跟踪）**：与 `.github/instructions` 同属"随项目走、团队共享"的治理文件，进版本库、走 PR 评审。详见问题二。
- **`specs/`（可见、可评审、进 git）**：spec 的核心价值之一就是"让人和机器都能 review 与 diff"，所以不能藏进隐藏目录或 gitignore。放在顶层 `specs/`，与 `docs/` 平级，语义清晰。
- **`.harness/`（纯运行时、可忽略）**：只放 signals / logs / state 等机器运行产物，默认 gitignore。其中 `constitution.md` 若出现，只是从 repo 同步来的**只读工作副本**，不是源头，不应手工编辑。
- **`docs/` 回归纯人类文档**：`project-structure.md` 属于长期维护文档，保留在 `docs/`。

### 1.3 迁移与兼容策略

- 新增配置项（示意）：`specRootDir`（默认 `specs`），替代硬编码的 `docs`；`getSpecDocsDir` 改为读取该配置。
- **向后兼容**：保留现有 `resolveSpecFile` 的 legacy 回退链（`docs/<file>`、`docs/<task>/<file>`、`doc/task.md`），旧迭代不受影响。
- 归档目标从 `docs/requirements/`、`docs/designs/` 迁移到 `specs/<iteration>/` 或 `specs/_archive/`，`artifacts-index.json` 同步移动。
- mono 模式下依旧用 `specs/<iteration>/` 子目录隔离，避免合并冲突（沿用现有子目录思路，只是换根目录）。

> 落地成本低：本质是把"根目录名 `docs` → `specs`"参数化 + 归档路径调整，核心状态机与校验逻辑不变。

---

## 2. 问题二：Constitution 的存放与管理

### 2.1 Constitution 是什么，不是什么

- **是**：跨迭代、长期稳定、全局生效的**不可违背工程原则与流程契约**。例如：
  - 技术栈与架构红线（"禁止绕过 Service 层直接查库"）
  - 安全底线（"所有外部输入必须校验"，对齐 OWASP）
  - 流程契约（"每个需求必须可独立测试"、"合并前必须通过机器门禁"）
  - 追溯要求（"所有 API/Model 必须绑定 Req-* ID"）
- **不是**：某次迭代的需求、某个模块的代码风格细节。

因此，**Constitution 绝不能放进 per-iteration 的 spec 目录**——它不属于任何单次迭代。

### 2.2 存放位置：git 跟踪、源头在 repo、随项目走

核心约束（来自团队协作诉求）：**Constitution 必须被 git 跟踪**，这样才能团队共享、走评审、随项目版本演进。因此：

- ❌ **不放 `.harness/`**：该目录定位是运行时产物、默认 gitignore，与"需要 git 跟踪"矛盾。
- ✅ **源头（source of truth）放在目标项目 repo 内的 `.spec/constitution.md`**：与 `.github/instructions` 同属"随代码走、团队共享"的治理文件。它随 repo 一起被 clone、被分支继承、被 PR 评审。
- ✅ **通过同步进入每个 worktree**：复用现有 `worktreeSyncPaths` 机制（当前已用于同步 instructions），把 `.spec/` 从 repo 同步进 worktree；若需要，`.harness/constitution.md` 只作为**只读工作副本**供运行时读取，绝不作为编辑源头。

> 位置备选：若不想新增 `.spec/`，可直接复用 `.github/`（如 `.github/constitution.md`），好处是完全复用 instructions 现有的 git 跟踪 + 同步链路；代价是治理文件与 GitHub 元数据混放。推荐独立的 `.spec/`，语义更清晰。

多仓（multi-repo）模式的源头选择：
- **mono 模式**：唯一 repo，`.spec/constitution.md` 位置明确。
- **multi-repo 模式**：指定一个"治理主 repo"（如后端）承载唯一源头，其余 repo 通过同步获得只读副本；避免多份源头各自漂移。

与现有各层的关系（职责分层，避免重叠）：

| 层 | 位置 | 是否 git 跟踪 | 职责 | 变更频率 |
| --- | --- | --- | --- | --- |
| Constitution | 目标 repo `.spec/constitution.md` | ✅ | 高阶原则、流程契约、红线（不可违背） | 极低 |
| 项目编码规范 | `.github/instructions/*.md` | ✅ | 代码风格、命名、框架用法 | 低 |
| Custom Prompt | Harness `prompts/*_custom_prompt.md` | 视配置 | 单项目对某 Agent 的定制 | 中 |
| Runtime Instruction | 运行时注入 | ❌ | 单次派发的具体指令 | 每次 |

> 现有各 Agent 的 **Precedence Rule** 已有 4 层（Runtime > System > Custom > Repository conventions）。建议把 Constitution 明确插入为**仅次于 Runtime 的硬约束层**，高于 System Prompt 之外的一切定制，让它真正"宪法化"。

### 2.3 管理规范

1. **git 跟踪 + 团队协作**：源头 `.spec/constitution.md` 随目标 repo 进版本库，任何修订走 PR + review，团队所有人共享同一份、可追溯历史。
2. **修订元数据**：文件头部维护版本号、批准日期、修订历史（对齐 spec-kit constitution 惯例）：
   ```markdown
   ---
   version: 1.2.0
   ratifiedAt: 2026-07-22
   amendments:
     - 1.2.0 (2026-07-22): 新增"合并前必须通过机器门禁"
     - 1.1.0 (2026-06-10): 增加安全底线条款
   ---
   ```
3. **同步进 worktree（单向、只读）**：worktree 是独立分支，Constitution 不应随迭代分支分叉。由 Harness 在创建/同步 worktree 时，把治理主 repo 的 `.spec/` 单向同步进 worktree（复用 `worktreeSyncPaths`）。worktree 内的副本只读，修订永远回到源头 repo 走 PR。
4. **变更传播**：宪法在源头更新后，通过现有"从基线分支同步代码"能力刷新到已存在的 worktree，避免旧迭代用到过期宪法。
5. **注入所有 Agent**：在每个阶段提示词的 INPUT CONTEXT 注入 constitution 内容或路径。
6. **纳入门禁**：机器门禁增加"是否违反 Constitution 硬约束"检查项（见问题三）。

---

## 3. 问题三：门禁（Gate）分层模型

### 3.1 核心澄清：门禁 ≠ 人工确认

你的顾虑"每步都要人工卡会很繁重"来自一个隐含前提：**把门禁等同于人工确认**。真正高效的 spec coding 把两者解耦：

- **机器门禁（自动）**：结构校验、语义追溯、编译、测试执行——**全自动、零人工成本**。通过则静默放行，失败才打断。它不增加负担，反而替你发现"AI 写错了自己却声称完成"，是**减负**。
- **人工门禁（人工）**：只保留在机器判断不了的**语义决策点**——需求是否符合业务意图、架构取舍是否合理。

一句话原则：**"信任但验证"（Trust but Verify）——默认自动推进，机器门禁守门，人只在高价值决策点介入。**

### 3.2 三级门禁模型

| 级别 | 名称 | 性质 | 失败行为 | 谁执行 |
| --- | --- | --- | --- | --- |
| Hard Gate | 硬门禁 | 必过 | **阻断**，触发自动回修，超限升级人工 | 机器 |
| Soft Gate | 软门禁 | 建议 | **告警不阻断**，记录 | 机器 |
| Human Gate | 人工门禁 | 决策 | 等待人工确认 | 人 |

**Hard Gate（机器，必过）**：
- 结构合法（现有正则校验）
- 语义追溯闭环：解析机器可读 YAML，校验 `Req → API/INV → TC → Task` 无孤儿、无悬空引用
- 无违反 Constitution 硬约束
- 开发阶段额外：编译通过 + acceptance 脚本 / 测试 PASS（把现有"仅检查文件存在"升级为"检查执行结果"）

**Soft Gate（机器，告警）**：
- 测试覆盖率、圈复杂度、代码风格
- 记录到日志/面板，不挡路

**Human Gate（人工，少而精）**：
- 需求验收、设计评审、合并上线

### 3.3 对当前 4 个人工确认点的优化

当前人工确认点：需求 / 设计 / 任务 / 开发结束。优化建议：

| 阶段 | 现状 | 建议 | 理由 |
| --- | --- | --- | --- |
| 需求 | 人工确认 | **保留人工门禁** | 业务意图机器判断不了 |
| 设计 | 人工确认 | **保留人工门禁** | 架构取舍需要人 |
| 任务 | 人工确认 | **降级为默认自动**（追溯闭环 Hard Gate 通过即推进） | 任务拆解很少需要人工深看，机器可验证完整性 |
| 开发结束 | 人工确认 | **叠加机器门禁后再人工**（编译+测试先跑，通过后人做最终 review） | 合并前需要人，但有机器背书，review 更轻松 |

净效果：**人工负担不增反降**（任务阶段可省一次人工），同时质量门禁显著变强（新增追溯闭环 + 真实执行验证）。

### 3.4 门禁力度可配置（解决"力度没想清楚"）

不要全局一刀切，按迭代风险分级：

```jsonc
// 迭代级 / 全局配置（示意）
{
  "gateLevel": "standard"   // relaxed | standard | strict
}
```

| gateLevel | Hard Gate | Human Gate | 适用场景 |
| --- | --- | --- | --- |
| relaxed | 结构 + 追溯 | 仅合并 | CRUD、配置、低风险 |
| standard | 结构 + 追溯 + 编译 + 测试 | 需求 + 设计 + 合并 | 默认，大多数迭代 |
| strict | standard + 覆盖率阈值 + Constitution 全项 | 需求 + 设计 + 任务 + 合并 | 核心链路、高风险 |

这样你不必现在就"想清楚唯一力度"——把力度做成**可选档位**，让用户按任务自己选，低风险任务走 `relaxed`（几乎全自动），核心任务走 `strict`。

### 3.5 回修与升级（配合门禁）

- Hard Gate 失败 → 自动回修，且**把具体失败原因作为定向修复指令注入重生成提示词**（现有 `tryAutoRepair` 未回传错误，需补齐）。
- 设**最大回修次数**（如 3 次），超限 → 升级为 Human Gate（人工介入），而非静默停手。

---

## 4. 并行说明（澄清与修正）

**修正上一轮评估的表述**：当前"并行"指的是**迭代级并行**——多个迭代任务各自在独立 worktree/分支中并行推进（由 `maxConcurrentAutoTasks` 控制槽位）。这是**正确的设计取舍**，原因：

- 不同 worktree 物理隔离（独立目录、独立分支），并行安全，无文件/编译状态争抢。
- 同一迭代内多个 dev 子任务若并行，会争抢同一工作区与编译状态，冲突风险高，且破坏依赖契约的稳定传递。

**结论**：迭代内 dev 子任务顺序执行是合理的，**单迭代内 DAG 并行属于可选的高级增强，而非缺陷**。收益有限、风险较高，不作为优先项。README 中"并行执行子任务"的措辞建议改为"按依赖顺序执行子任务；跨迭代任务可并行"，以免误解。

---

## 5. 落地优先级

| 优先级 | 事项 | 关联问题 |
| --- | --- | --- |
| P0 | 目录参数化：`docs → specs`，`.harness/` 收拢运行时状态 | 问题一 |
| P0 | 语义追溯 Hard Gate（解析 YAML 做 Req→API→TC→Task 闭环校验） | 问题三 |
| P0 | 真实执行 Hard Gate（开发阶段自动跑编译/测试，替代"仅文件存在"） | 问题三 |
| P1 | 建立 `.spec/constitution.md`（git 跟踪，repo 内）+ 单向同步进 worktree + 注入 Precedence | 问题二 |
| P1 | `gateLevel` 三档配置 + 任务阶段默认自动 | 问题三 |
| P1 | 定向回修（回传错误）+ 最大回修次数 + 超限升级人工 | 问题三 |
| P2 | 归档路径迁移、README 并行措辞修正、legacy 兼容清理 | 问题一/并行 |

---

## 6. 一页纸总结

- **Spec 产物**：搬出 `docs/`，进顶层 `specs/`（可评审、进 git）；运行时状态进 `.harness/`（可忽略）；`docs/` 回归纯人类文档。
- **Constitution**：**git 跟踪、随项目走**——源头在目标 repo 的 `.spec/constitution.md`（不放运行时的 `.harness/`），团队共享走 PR；由 Harness 单向同步进各 worktree（只读副本），注入为仅次于 Runtime 的硬约束层。
- **门禁**：门禁 ≠ 人工。机器门禁（结构/追溯/编译/测试）全自动、减负；人工门禁只留语义决策点；力度做成 `relaxed/standard/strict` 三档可选，按风险自选。
- **并行**：迭代级并行是正确取舍，迭代内并行非必需；修正文档措辞即可。



首批执行
Constitution 系统、语义追溯 Hard Gate、定向回修+回修上限+超限升级