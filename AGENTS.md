# Fun Harness — Agent 全局指令

本文件对所有 AI Agent（Copilot、Claude Code 等）在本仓库内的工作行为生效。

---

## 项目定位

**Fun Harness** 是一个 VS Code 扩展（`apps/`），将 AI 编程组织为可控的研发流水线：
**需求 → 设计 → 测试用例 → 任务拆解 → 开发 → 待审 → 完成**，每阶段产出固定 Markdown 产物，并通过 Git Worktree 为每个迭代隔离工作区。

---

## 目录约定

```
apps/src/                    # 插件主源码（TypeScript）
  services/                  # 各功能服务类
  harnessMessages.ts         # 消息契约（Webview ↔ 扩展）
  harnessMessageController.ts# 消息路由与阶段动作分发
  webviewTemplates.ts        # Webview HTML 模板
  models.ts                  # 公共类型与常量
apps/scripts/
  validate-webview.js        # Webview 内联脚本语法校验
apps/test/                   # Node test runner 测试文件（*.test.js）
specs/                       # 各迭代的需求/设计/任务/测试用例产物
docs/                        # 项目级文档
```

---

## 构建与验证命令

> **重要**：本机 `npm` / `node` 由 [fnm](https://github.com/Schniz/fnm) 管理，**不能直接在终端调用 `npm`**。
> 所有涉及 npm 的命令必须在 PowerShell 中先初始化 fnm 环境，再执行：
>
> ```powershell
> Invoke-Expression (fnm env --shell powershell | Out-String)
> ```

### 本地打包（推荐方式）

直接运行仓库根目录的打包脚本，它会自动完成 fnm 初始化 → 清理旧 vsix → 编译 → 打包：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/package-local.ps1
```

输出的 `.vsix` 文件位于 worktree 上一级目录。

### 单独执行 npm 命令

如需单独执行构建/测试，需先初始化 fnm，再切到 `apps/` 目录执行：

```powershell
Invoke-Expression (fnm env --shell powershell | Out-String)
Set-Location apps
npm run compile:guard   # 编译 + Webview 脚本校验
npm run test            # 编译 + 运行所有单元测试
node scripts/validate-webview.js  # 单独验证 Webview 内联脚本
```

| 命令 | 用途 |
|------|------|
| `npm run compile:guard` | 编译 + 自动执行 Webview 脚本校验（postcompile 钩子） |
| `npm run test` | 编译 + 运行所有单元测试 |
| `node scripts/validate-webview.js` | 单独验证 Webview 内联脚本（输出"passed"且 exit 0 才算通过） |

> 修改任何代码后，**优先运行 `npm run compile:guard`** 验证编译无误。

---

## 强制规范（MUST）

### 1. 路径处理

- 所有路径解析、匹配逻辑必须支持**中文及非 ASCII 路径**（本项目 worktree 目录本身含中文）。
- 读取 Git 变更路径时必须使用：
  ```
  git -c core.quotepath=false status --porcelain=v1 --untracked-files=all
  ```
  并对 porcelain 路径执行引号与八进制转义解码（`\\ddd` 格式）。
- 路径比较前统一归一化分隔符与大小写策略。
- `docs/domains/registry.yaml` 可能为空——需求阶段若无法取到合规 canonical domain，必须触发 FAILURE PROTOCOL 阻断报告，不得静默跳过。

### 2. Prompt 落盘约定

所有阶段（包括评审阶段）遵循统一的 Prompt 两层结构：

#### 2a. 通用 System Prompt（内置默认层）

放置于 `apps/system-prompts/`，所有文件均随插件分发：

| 阶段 | 文件名 |
|------|--------|
| 需求 Agent | `requirement_system_prompt.md` |
| 设计 Agent | `design_system_prompt.md` |
| 测试用例 Agent | `testcase_system_prompt.md` |
| 任务拆解 Agent | `task_system_prompt.md` |
| 开发 Agent | `dev_system_prompt.md` |
| 需求评审 | `review_requirements_system_prompt.md` |
| 设计评审 | `review_design_system_prompt.md` |
| 测试用例评审 | `review_testcase_system_prompt.md` |
| 宪法默认 | `constitution_default.md` |

- 不得将 prompt 内容硬编码在 TypeScript 源文件中；源码只保存文件路径引用和加载逻辑。

#### 2b. 用户自定义层（项目级覆盖）

用户可在项目的 git-tracked specs 目录（如 `specs/`）下放置同名自定义文件，**优先级高于内置默认**：

| 阶段 | 自定义文件名（放于 `specs/` 或项目 prompts 目录） |
|------|------|
| 需求 Agent | `requirements_custom_prompt.md` |
| 设计 Agent | `design_custom_prompt.md` |
| 测试用例 Agent | `testcase_custom_prompt.md` |
| 任务拆解 Agent | `tasks_custom_prompt.md` |
| 开发 Agent | `dev_custom_prompt.md` |
| 需求评审 | `review_requirements_custom_prompt.md` |
| 设计评审 | `review_design_custom_prompt.md` |
| 测试用例评审 | `review_testcase_custom_prompt.md` |

- 对于 Agent 类（需求/设计等），自定义文件内容作为**补充追加**，与 system prompt 合并渲染。
- 对于评审类，自定义文件内容**完整替换**默认 system prompt（`source: 'custom'`）。
- Webview 侧面板各阶段旁路操作区均有「⚙️ ×× 评审 Prompt」按钮，点击后在编辑器中打开对应自定义文件（文件不存在时自动创建空文件）。

#### 2c. 加载优先级（评审 Prompt 完整链路）

```
文件自定义 (review_*_custom_prompt.md in specs/)
  > JSON 自定义 (reviewPromptConfigService, 旧版向后兼容)
  > 内置 system-prompt 文件 (apps/system-prompts/review_*_system_prompt.md)
  > 代码内兜底字符串
```

### 3. Webview 脚本

- 凡修改 `apps/src/webviewTemplates.ts` 或任何 Webview 相关文件，提交前**必须**执行：
  ```
  node apps/scripts/validate-webview.js
  ```
  仅当输出 `Webview script validation passed` 且进程退出码为 0 时，变更才视为安全。

---

## 推荐规范（SHOULD）

- 修改 `services/` 下的服务类前，先阅读对应测试文件（`apps/test/*.test.js`）以了解不变量。
- 提交描述使用中文，格式：`<类型>: <简短描述>`（类型：feat / fix / refactor / test / docs）。
- 每次修改后检查 `tsc-errors.txt`（根目录）是否有遗留错误。
- 服务类构造函数依赖通过参数注入，不在服务内部直接 `import` 全局单例。

---

## 注意事项

-  worktree 目录名含中文，终端命令中涉及路径时需注意编码。
- `apps/` 是 VS Code 扩展根，`package.json` 中 `"main": "./out/extension.js"`，编译产物在 `apps/out/`。
- 测试框架为 Node 原生 `node:test`（Node 18+），测试文件为 `.test.js`，不使用 Jest/Mocha。
- `specs/<迭代名>/delta/` 记录 SpecDelta 漂移门控产物，不要手动删除。
