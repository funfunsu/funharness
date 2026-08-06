# Fun Harness · AI 研发流程

> 在 VS Code 内把"AI 编程"组织成一条可控的研发流水线：从需求到代码，每一步都有专属 Agent、独立 worktree、明确的产物文件和安全的 Git 合并保护。

Fun Harness 不是又一个 Chat 框，它把一个"迭代任务"按 **需求 → 设计 → 测试用例 → 任务拆解 → 开发 → 待审 → 完成** 七个阶段编排起来，每一步都对应一个专门调教过的 Agent 与一个固定的产物（Markdown 文件），并通过 Git Worktree 为每个迭代隔离出独立工作区，避免多个 AI 任务互相污染。每个规格阶段还配有可选的 **AI 评审**，支持"AI 生成产物 → AI 评审产物 → 工程师人工确认"的三步闭环。

> 📖 想了解完整流程与每个环节的核心步骤，见 [docs/fun-harness-流程全景.md](docs/fun-harness-流程全景.md)。

---

## ✨ 核心能力

### 1. 流水线化的研发工作流
为每个"迭代任务"自动驱动以下阶段，每个阶段都生成一份位于 `specs/` 下的规范产物（monorepo 模式下位于 `specs/<迭代>/`）：

| 阶段 | 产物文件 | 对应 Agent |
| --- | --- | --- |
| 📝 撰写需求 | `specs/requirements.md` | 需求生成 Agent |
| 📘 技术设计 | `specs/design.md` | 技术设计 Agent |
| 🧪 测试用例（可选） | `specs/testcase.md` | 测试用例 Agent |
| 📋 任务拆解 | `specs/tasks.md` | 任务拆解 Agent |
| ⚙️ 开发 | 源代码 | 全栈开发 Agent |
| ⏳ 待审核 / ✅ 完成 | — | — |

阶段间可手动推进，也可开启 **自动推进** 与 **自动修复**，让 Harness 在产物校验失败时自动调用对应 Agent 重新生成。

### 2. 阶段式 AI 评审（人工把关前的自动体检）
需求 / 设计 / 测试用例 / 任务拆解四个规格阶段均内置独立的 **AI 评审** 能力：

- 评审为**非阻塞**设计（失败不阻断流程），但实际项目中建议在每个环节常规启用
- 推荐三步闭环：**AI 生成产物 → AI 评审产物 → 工程师人工复核并确认**，先由 Agent 生成初稿，再由 AI 评审检出遗漏、歧义与风险，最后由人工拨正确认
- 评审 Prompt 支持项目级自定义覆盖（`review_*_custom_prompt.md`），优先于内置默认
- 开发阶段另提供 **🧭 Spec 评审**，按领域评估"规格 ↔ 实现"漂移风险，作为合并前的最终收口

### 3. 多 AI Provider 适配
不绑定单一模型，可在每个任务上独立切换：

- **GitHub Copilot** — 调用 VS Code 原生 Chat
- **Claude Code（面板）** — 调用 Claude VS Code 扩展侧边栏
- **Claude Code（CLI）** — 在终端跑 `claude` 命令
- **Trae AI / Qodo Gen** — 走 VS Code Chat
- **手工模式** — 只生成提示词，由开发者粘贴到任意工具

派发失败时可自动降级到手工模式，避免被某一家服务挂掉拖累。

### 4. Git Worktree 隔离
- 每个迭代任务自动创建独立分支与独立 worktree 目录
- 支持前端 + 后端**双仓库**并行处理
- 可一键 **从基线分支同步代码** 到当前 worktree（自动 fetch + merge）
- 可在 worktree 子窗口中打开任务，子面板只保留当前任务的操作，注意力不分散

### 5. 多阶段安全合并（关键保护）
"提交代码"与"完成任务并合并"按三阶段严格校验执行，**任何一步失败都立即中止，绝不破坏本地与远程状态**：

1. **备份阶段** — 自动 `git add -A` + commit 任何未提交改动，把迭代分支推到远程，并对比本地 / `origin` 的 SHA，确认远程真的拿到了
2. **合并阶段** — `git pull` 必须成功，本地合并完成后立刻 `merge-base --is-ancestor` 验证；推送后再 fetch + rev-parse 对比，确认 `origin/<基线>` 真的前移，且包含本次迭代提交
3. **清理阶段** —（只有"完成任务并合并"才走这步）再做一次祖先检查保护，移除 worktree 用 `git worktree remove`（**不** 用 `--force`），确保任何残留改动都会阻断删除

两种合并模式区别：
- **📤 提交代码**（侧边栏，所有阶段可用）— 完成 Phase 1+2，**保留 worktree 与迭代分支**，方便继续工作
- **🏁 完成任务并合并**（待审核阶段）— 完成 Phase 1+2+3，清理迭代分支

### 6. 任务拆解 + 并行子任务调度
- 任务拆解 Agent 输出结构化子任务（含依赖、输入、输出、验收标准）
- 内置调度器按依赖顺序并行执行子任务，可设置最大并发数
- 支持子任务失败重试、手动标记状态
- 可选 **简化拆解模式**（适合 CRUD/配置型任务）与基于关键字的自动判别

### 7. 启动 / 调试一体化
- 在侧边栏一键 **启动前端 / 启动后端**（基于配置的启动命令）
- 启动命令支持模板变量（`{install}`、`{run}`、`{offline}` 等）
- 启动按钮在 worktree 子面板**任何阶段**都常驻可见，调试更顺手

### 8. 项目结构自动识别
- 首次配置时自动扫描技术栈、依赖、目录约定
- 可纯本地推断或调用 AI 二次润色（`local` / `local+ai`）
- 结果会嵌入到所有 Agent 的提示词，让生成的代码贴合实际项目风格

---

## 🚀 快速上手

### 安装
- **VSIX 本地安装**：下载 `*.vsix` 文件，VS Code → 扩展面板 → ⋯ → 「从 VSIX 安装」
- **本地构建**：
  ```bash
  npm install
  npm run package:local
  ```
  生成的 `.vsix` 即可拖入 VS Code 安装。

### 首次使用
1. 点击活动栏的 **Fun Harness** 图标打开侧边栏
2. 在「高级设置」配置：
   - 前端 / 后端 Git 仓库地址（至少一个）
   - 基线分支（如 `develop` 或个人分支）
   - 前端 / 后端启动命令（可选）
   - AI Provider（默认 GitHub Copilot）
3. 点击「创建迭代」，输入英文名 + 中文需求描述
4. Harness 会自动 clone 仓库、创建 worktree、初始化分支，并进入需求阶段
5. 沿着流水线点击每个阶段的「执行 Agent」按钮，或开启 **自动执行** 让 Harness 自己跑

### 典型命令
```bash
npm run compile          # 编译 TS 到 out/
npm run watch            # 监听编译
npm run package:local    # 打包为带时间戳的 vsix
npm run publish:remote   # 编译后通过 vsce 发布到市场
```

---

## ⚙️ 配置一览

主要配置项（均通过侧边栏「高级设置」可视化编辑）：

| 配置 | 说明 |
| --- | --- |
| `frontendGit` / `backendGit` | 前端 / 后端 Git 仓库地址 |
| `baseBranch` | 基线分支（迭代分支从这里 fork，合并回这里） |
| `mergeDryRunEnabled` | 合并前先做无冲突干运行检测 |
| `frontendStartCmd` / `backendStartCmd` | 启动命令 |
| `aiProvider` | 默认 AI Provider（任务级别可覆盖） |
| `cliCommandTemplate` | CLI 模式下的命令模板 |
| `aiFallbackToManual` | 派发失败时是否自动降级到手工模式 |
| `autoAdvanceEnabled` | 阶段产物通过校验后是否自动进入下一阶段 |
| `autoRepairEnabled` | 产物校验失败时是否自动重新调用 Agent |
| `maxConcurrentAutoTasks` | 子任务调度的最大并发数 |
| `compactTaskDecomposition` | 启用简化任务拆解（适合简单需求） |
| `worktreeSyncPaths` | worktree 与主仓共享的目录（例如 instructions） |

---

## 🛠 开发者：发布流程

每次发布到 VS Code 市场前，按固定三步走，确保 marketplace 的 Changelog 页有内容：

1. **写更新日志** — 在 `CHANGELOG.md` **顶部**新增一节 `## [新版本号] - YYYY-MM-DD`，按 `新增 / 修复 / 变更` 分类描述本次改动（最新版本永远在最上面）。
2. **升版本号 + 打 tag** — 运行 `npm run release:patch`（或 `release:minor`）：
   - 先执行 `changelog:check`，校验 `CHANGELOG.md` 里确实有当前要发布版本号对应的小节，没有就直接报错中止；
   - 通过后用 `npm version` 升级 `package.json` 版本号、提交、打 git tag；
   - `version` / `postversion` 钩子会自动 `git add CHANGELOG.md package.json` 并 `git push --tags`。
3. **发布** — 运行 `npm run publish:remote`，编译后通过 `vsce publish` 推送到市场。

> ⚠️ Marketplace 的 Changelog 页只在**发布新版本时**才会刷新。光改 `CHANGELOG.md` 不发版是不会生效的；同一版本号也不能重复发布。

相关脚本：

```bash
npm run changelog:check  # 校验 CHANGELOG.md 是否含当前版本小节
npm run release:patch    # 补丁版本：x.y.Z+1，自动校验/升级/打 tag/推送
npm run release:minor    # 次要版本：x.Y+1.0
npm run publish:remote   # 编译 + vsce publish 发布到市场
```

---

## 🧩 适合谁

- 在公司里**有规范文档要求**、希望让 AI 不只是写代码而是参与全流程的开发者
- 多人协作的迭代场景：每个人有独立 worktree、独立分支、独立合并路径
- 希望摆脱"Chat 散乱、文档缺失、AI 输出无法追溯"的团队
- 想把 Claude Code、Copilot 等多种工具统一到一条流水线上的玩家

---

## 📄 许可证

本项目采用 **PolyForm Noncommercial 1.0.0** 许可证。简单说：
- ✅ 允许个人学习、研究、教学、内部评估等**非商业**用途，可自由阅读、修改、分发源码
- ❌ **禁止**以营利为目的的商业使用（包括但不限于：作为商业产品销售、内嵌商业 SaaS、商业咨询服务交付等）

完整条款见项目根目录 `LICENSE` 文件。如需商业授权，请联系作者另行洽谈。
