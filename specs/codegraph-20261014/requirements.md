# 需求文档
## 简介
本需求面向 Fun Harness 的项目初始化主流程，目标是在首次真实创建 worktree 时自动构建本地 CodeGraph，并通过可配置开关、非阻断失败策略与图谱证据注入，提升需求-设计-任务-开发全链路中 AI 对代码结构的理解质量与交付稳定性。

## 术语表
- CodeGraph：本地代码语义图谱能力，基于 MCP CodeGraph CLI 在项目目录生成与维护图谱索引。
- worktree 首次真实创建：由主流程入口触发，代码目录首次完成实际创建（非仅任务元数据创建）。
- 高级设置开关：Fun Harness 设置页中的可持久化布尔配置项，用于控制是否启用自动 CodeGraph。
- 图谱证据包：由 CodeGraph 产出的轻量化结构化摘要，供需求、设计、任务、开发阶段 prompt 使用。
- 非阻断失败：构建 CodeGraph 失败时仅告警并记录，不中断主流程继续执行。

## 用户旅程
产品负责人-在高级设置中确认启用自动 CodeGraph-确保后续迭代默认获得代码语义上下文 → 开发者-通过主流程入口首次打开某任务 worktree-触发本地 CodeGraph 自动构建并收到结果反馈 → 需求/设计/任务/开发 Agent-消费图谱证据包中的调用链与影响面-生成更准确的规格与实现方案 → 研发团队-基于可观测日志与产物追踪构建质量-持续优化门禁与回归策略。

## 需求清单
### Req-1：在 worktree 首次真实创建时自动触发 CodeGraph 构建，并在缺图场景补偿触发
**用户故事：** 作为开发者，我希望在主流程入口首次真实创建 worktree 后自动触发本地 CodeGraph 构建，并在已有 worktree 但图谱缺失时进行补偿触发，以便于 AI 在后续阶段直接获取结构化代码上下文。
#### 验收标准
1. GIVEN 用户通过主流程入口 [openFolderLocationByFeatureId] 触发某任务目录首次真实创建 WHEN 系统确认 worktree 创建成功 THEN 系统必须在该 worktree 根目录自动执行一次 CodeGraph 初始化构建流程。
2. GIVEN 用户通过主流程入口 [runCustomButtonByFeatureId] 触发某任务目录首次真实创建 WHEN worktree 创建成功 THEN 系统必须复用同一自动构建流程，且不会因为入口不同而跳过构建。
3. GIVEN 用户通过主流程入口 [openFolderLocationByFeatureId] 打开一个已存在的 worktree 且配置开启自动 CodeGraph WHEN 系统检测到可执行初始化窗口 THEN 系统可以执行一次补偿初始化尝试，并保持失败不阻断。
4. GIVEN 用户触发 [syncCodeGraphByFeatureId] 且目标 worktree 下不存在 .codegraph WHEN 同步流程启动 THEN 系统必须执行一次 CodeGraph 初始化补偿构建。
5. GIVEN CodeGraph 构建成功 WHEN 开发者在 VS Code 中进入该 worktree THEN 在该 worktree 下可观测到 CodeGraph 初始化结果（例如存在 .codegraph 目录且可通过状态查询得到可用索引）。

### Req-2：提供默认开启的高级设置开关控制自动 CodeGraph
**用户故事：** 作为产品管理员，我希望在高级设置中有一个默认开启的 CodeGraph 开关，以便于按项目策略统一控制自动构建行为。
#### 验收标准
1. GIVEN 用户首次使用或配置文件缺少该字段 WHEN 打开高级设置页面 THEN 自动 CodeGraph 开关默认显示为开启并按开启策略生效。
2. GIVEN 用户在高级设置中关闭自动 CodeGraph 并保存 WHEN 系统持久化并归一化配置 THEN autoInstallEnabled 必须与 autoCodeGraphEnabled 同步为关闭。
3. GIVEN 用户在高级设置中关闭自动 CodeGraph 并保存 WHEN 后续通过主流程入口首次真实创建新 worktree THEN 系统不得触发 CodeGraph 构建流程。
4. GIVEN 用户在高级设置中重新开启并保存 WHEN 系统持久化并归一化配置 THEN autoInstallEnabled 必须与 autoCodeGraphEnabled 同步为开启。
5. GIVEN 用户在高级设置中重新开启并保存 WHEN 再次首次真实创建新 worktree THEN 系统必须恢复自动触发 CodeGraph 构建。
6. GIVEN 用户完成一次开关保存 WHEN 重新打开设置页面 THEN 页面展示状态与持久化配置一致（端到端可观测为 UI 状态与配置文件值一致）。

### Req-3：未安装 CodeGraph 时自动尝试安装并保持主流程可继续
**用户故事：** 作为开发者，我希望系统在检测到本机缺少 codegraph 命令时自动尝试安装，以便于减少手工准备步骤并提高初始化成功率。
#### 验收标准
1. GIVEN 主流程入口触发首次真实创建 worktree 且系统检测不到 codegraph 命令 WHEN 自动安装策略启用 THEN 系统必须自动发起一次非交互安装尝试并记录安装结果。
2. GIVEN 自动安装成功 WHEN 紧接着执行自动构建 THEN 系统必须继续执行 CodeGraph 初始化并产生可用索引。
3. GIVEN 自动安装失败 WHEN 主流程继续 THEN 系统必须以告警形式反馈失败原因与下一步建议，且不阻断 worktree 打开与后续阶段流转（端到端可观测为 worktree 仍可打开、流程仍可进入下一阶段）。

### Req-4：CodeGraph 失败策略为告警不阻断并具备可追踪过程记录
**用户故事：** 作为研发负责人，我希望 CodeGraph 构建失败时不阻断主流程但有完整可追踪记录，以便于在不影响开发推进的前提下持续修复环境问题。
#### 验收标准
1. GIVEN 首次真实创建 worktree 后触发 CodeGraph 构建 WHEN 构建过程超时或命令异常 THEN 系统必须仅发出告警并继续完成主流程动作。
2. GIVEN 任一 CodeGraph 构建尝试结束 WHEN 开发者查看运行时过程目录 THEN 必须可观测到对应过程记录（包含 worktree 标识、触发入口、执行时间、结果状态、错误摘要或成功摘要）。
3. GIVEN 同一 worktree 在并发或重复触发条件下 WHEN 仍处于同一轮初始化窗口 THEN 系统必须避免重复并发构建并输出可识别的去重记录。

### Req-5：将图谱证据包注入需求-设计-任务-开发阶段以提升 AI 产出质量
**用户故事：** 作为需求与开发协作团队，我希望 CodeGraph 结果被整理为可控体量的证据包并注入各阶段 prompt，以便于减少接缝遗漏与错误改动范围判断。
#### 验收标准
1. GIVEN 需求阶段生成需求文档 WHEN 该任务已有可用图谱 THEN 需求 prompt 必须包含主流程入口与关键模块归属的图谱锚点摘要。
2. GIVEN 设计阶段生成方案 WHEN 该任务已有可用图谱 THEN 设计 prompt 必须包含可验证集成接缝线索（调用方坐标、关键边类型或影响关系）。
3. GIVEN 测试用例阶段生成测试文档 WHEN 该任务已有可用图谱 THEN 测试用例 prompt 必须包含受预算控制的图谱证据摘要以辅助覆盖关键接缝。
4. GIVEN 任务拆解阶段生成任务清单 WHEN 该任务已有可用图谱 THEN 任务 prompt 必须包含接线提示，使新建输出与改造调用方形成可追踪映射。
5. GIVEN 开发阶段生成实现方案或代码 WHEN 该任务已有可用图谱 THEN 开发上下文必须包含受预算控制的图谱证据摘要及完整证据包路径。
6. GIVEN 某阶段图谱缺失或过期 WHEN 生成阶段产物 THEN 系统必须降级为告警并回退现有流程，不得将“未查询到节点”当作“不存在业务关系”的结论。
7. GIVEN 证据 freshness=\"fresh\" 但 seams 或 impactSet 为空 WHEN 生成阶段产物 THEN 系统必须保留不确定性告警语义并禁止输出否定性业务结论。

## 需求追踪矩阵（如有已有设计/代码）
| 需求ID | 触发主流程/入口 | 关键可观测结果 | 后续设计关注点 |
| --- | --- | --- | --- |
| Req-1 | openFolderLocationByFeatureId / runCustomButtonByFeatureId / syncCodeGraphByFeatureId | 首次创建后自动触发构建，缺图场景可补偿触发并产出可用图谱索引 | 生命周期接入点、触发去重、补偿触发边界 |
| Req-2 | 高级设置保存入口（saveAdvancedConfig） | 开关默认开启、关闭后不触发、重开后恢复，且安装开关与主开关联动归一 | 配置模型、持久化兼容、归一化策略 |
| Req-3 | 首次创建触发链路中的命令探测分支 | 未安装时自动尝试安装、失败不阻断 | 安装命令策略、失败提示 |
| Req-4 | 自动构建执行器 | 异常仅告警、过程记录可查、并发去重生效 | 观测字段、日志落位 |
| Req-5 | requirement/design/testcase/task/dev 阶段上下文组装入口 | 各阶段消费证据包并在缺失/过期或低结构化证据时保留降级告警语义 | 注入预算、降级策略、证据一致性 |

## 机器可读区
```yaml
artifactType: requirements
taskName: CodeGraph
requirements:
  - id: Req-1
    domain: project-structure-init
    title: 在 worktree 首次真实创建时自动触发 CodeGraph 构建，并在缺图场景补偿触发
    userStory: 作为开发者，我希望在主流程入口首次真实创建 worktree 后自动触发本地 CodeGraph 构建，并在已有 worktree 但图谱缺失时进行补偿触发，以便于 AI 在后续阶段直接获取结构化代码上下文。
    acceptanceCriteria:
      - GIVEN 用户通过主流程入口 [openFolderLocationByFeatureId] 触发某任务目录首次真实创建 WHEN 系统确认 worktree 创建成功 THEN 系统必须在该 worktree 根目录自动执行一次 CodeGraph 初始化构建流程。
      - GIVEN 用户通过主流程入口 [runCustomButtonByFeatureId] 触发某任务目录首次真实创建 WHEN worktree 创建成功 THEN 系统必须复用同一自动构建流程，且不会因为入口不同而跳过构建。
      - GIVEN 用户通过主流程入口 [openFolderLocationByFeatureId] 打开一个已存在的 worktree 且配置开启自动 CodeGraph WHEN 系统检测到可执行初始化窗口 THEN 系统可以执行一次补偿初始化尝试，并保持失败不阻断。
      - GIVEN 用户触发 [syncCodeGraphByFeatureId] 且目标 worktree 下不存在 .codegraph WHEN 同步流程启动 THEN 系统必须执行一次 CodeGraph 初始化补偿构建。
      - GIVEN CodeGraph 构建成功 WHEN 开发者在 VS Code 中进入该 worktree THEN 在该 worktree 下可观测到 CodeGraph 初始化结果（例如存在 .codegraph 目录且可通过状态查询得到可用索引）。
  - id: Req-2
    domain: project-structure-init
    title: 提供默认开启的高级设置开关控制自动 CodeGraph
    userStory: 作为产品管理员，我希望在高级设置中有一个默认开启的 CodeGraph 开关，以便于按项目策略统一控制自动构建行为。
    acceptanceCriteria:
      - GIVEN 用户首次使用或配置文件缺少该字段 WHEN 打开高级设置页面 THEN 自动 CodeGraph 开关默认显示为开启并按开启策略生效。
      - GIVEN 用户在高级设置中关闭自动 CodeGraph 并保存 WHEN 系统持久化并归一化配置 THEN autoInstallEnabled 必须与 autoCodeGraphEnabled 同步为关闭。
      - GIVEN 用户在高级设置中关闭自动 CodeGraph 并保存 WHEN 后续通过主流程入口首次真实创建新 worktree THEN 系统不得触发 CodeGraph 构建流程。
      - GIVEN 用户在高级设置中重新开启并保存 WHEN 系统持久化并归一化配置 THEN autoInstallEnabled 必须与 autoCodeGraphEnabled 同步为开启。
      - GIVEN 用户在高级设置中重新开启并保存 WHEN 再次首次真实创建新 worktree THEN 系统必须恢复自动触发 CodeGraph 构建。
      - GIVEN 用户完成一次开关保存 WHEN 重新打开设置页面 THEN 页面展示状态与持久化配置一致（端到端可观测为 UI 状态与配置文件值一致）。
  - id: Req-3
    domain: project-structure-init
    title: 未安装 CodeGraph 时自动尝试安装并保持主流程可继续
    userStory: 作为开发者，我希望系统在检测到本机缺少 codegraph 命令时自动尝试安装，以便于减少手工准备步骤并提高初始化成功率。
    acceptanceCriteria:
      - GIVEN 主流程入口触发首次真实创建 worktree 且系统检测不到 codegraph 命令 WHEN 自动安装策略启用 THEN 系统必须自动发起一次非交互安装尝试并记录安装结果。
      - GIVEN 自动安装成功 WHEN 紧接着执行自动构建 THEN 系统必须继续执行 CodeGraph 初始化并产生可用索引。
      - GIVEN 自动安装失败 WHEN 主流程继续 THEN 系统必须以告警形式反馈失败原因与下一步建议，且不阻断 worktree 打开与后续阶段流转（端到端可观测为 worktree 仍可打开、流程仍可进入下一阶段）。
  - id: Req-4
    domain: project-structure-init
    title: CodeGraph 失败策略为告警不阻断并具备可追踪过程记录
    userStory: 作为研发负责人，我希望 CodeGraph 构建失败时不阻断主流程但有完整可追踪记录，以便于在不影响开发推进的前提下持续修复环境问题。
    acceptanceCriteria:
      - GIVEN 首次真实创建 worktree 后触发 CodeGraph 构建 WHEN 构建过程超时或命令异常 THEN 系统必须仅发出告警并继续完成主流程动作。
      - GIVEN 任一 CodeGraph 构建尝试结束 WHEN 开发者查看运行时过程目录 THEN 必须可观测到对应过程记录（包含 worktree 标识、触发入口、执行时间、结果状态、错误摘要或成功摘要）。
      - GIVEN 同一 worktree 在并发或重复触发条件下 WHEN 仍处于同一轮初始化窗口 THEN 系统必须避免重复并发构建并输出可识别的去重记录。
  - id: Req-5
    domain: domain-knowledge
    title: 将图谱证据包注入需求-设计-任务-开发阶段以提升 AI 产出质量
    userStory: 作为需求与开发协作团队，我希望 CodeGraph 结果被整理为可控体量的证据包并注入各阶段 prompt，以便于减少接缝遗漏与错误改动范围判断。
    acceptanceCriteria:
      - GIVEN 需求阶段生成需求文档 WHEN 该任务已有可用图谱 THEN 需求 prompt 必须包含主流程入口与关键模块归属的图谱锚点摘要。
      - GIVEN 设计阶段生成方案 WHEN 该任务已有可用图谱 THEN 设计 prompt 必须包含可验证集成接缝线索（调用方坐标、关键边类型或影响关系）。
      - GIVEN 测试用例阶段生成测试文档 WHEN 该任务已有可用图谱 THEN 测试用例 prompt 必须包含受预算控制的图谱证据摘要以辅助覆盖关键接缝。
      - GIVEN 任务拆解阶段生成任务清单 WHEN 该任务已有可用图谱 THEN 任务 prompt 必须包含接线提示，使新建输出与改造调用方形成可追踪映射。
      - GIVEN 开发阶段生成实现方案或代码 WHEN 该任务已有可用图谱 THEN 开发上下文必须包含受预算控制的图谱证据摘要及完整证据包路径。
      - GIVEN 某阶段图谱缺失或过期 WHEN 生成阶段产物 THEN 系统必须降级为告警并回退现有流程，不得将“未查询到节点”当作“不存在业务关系”的结论。
      - GIVEN 证据 freshness=\"fresh\" 但 seams 或 impactSet 为空 WHEN 生成阶段产物 THEN 系统必须保留不确定性告警语义并禁止输出否定性业务结论。
```