# 需求文档

## 简介

为 Fun Harness 流水线的关键生命周期节点增加 Hook 执行能力。用户可为指定节点（如 Worktree 首次初始化打开）配置一段可执行脚本（Shell/PowerShell/JS），Harness 在对应节点触发时自动执行该脚本，从而支持"打开 Worktree 时自动运行 npm install"等自动化初始化场景，无需人工介入。

## 术语表

| 术语 | 解释 |
|------|------|
| Hook | 在特定生命周期节点自动触发的用户自定义脚本执行钩子 |
| Hook 节点 | 触发 Hook 的具名生命周期点，当前阶段仅支持 `worktree-open`（Worktree 首次初始化打开） |
| Hook 脚本 | 用户在配置中填写的可执行脚本文件名或命令，格式与 CustomButton 脚本一致 |
| Worktree 初始化 | `openFolderLocationByTaskId` 调用中，检测到代码目录缺失、执行 `createIterationBranches` 后，首次打开对应目录的完整流程 |
| 幂等执行 | 同一 Hook 在同一 Worktree 上仅在"初次初始化完成后"执行一次；后续重复点击不重复触发 |
| masterRoot | Fun Harness 主工作区根目录，已有概念，Hook 脚本路径以此为解析基点（`master` 来源）或以 Worktree 目录为解析基点（`worktree` 来源） |

## 需求清单

### 需求-1：全局 Hook 配置项

**用户故事：** 作为团队管理员，我希望在 Fun Harness 的全局设置中为关键节点配置 Hook 脚本列表，以便于在不修改代码的情况下为所有迭代任务的 Worktree 初始化添加自动化步骤。

#### 验收标准

1. GIVEN 用户进入 Fun Harness 设置界面，WHEN 查看 Hook 配置区域，THEN 应展示"Worktree 初始化后 Hook"（`worktree-open`）节点的脚本列表配置项，支持填写脚本文件名（格式与 CustomButton 的 `script` 字段一致）及可选的额外参数（`args`）。
2. GIVEN 用户填写了至少一条有效 Hook 配置并保存，WHEN 重新打开设置界面，THEN 配置项应正确持久化，不丢失。
3. GIVEN 用户未填写任何 Hook 配置，WHEN Harness 执行 Hook 流程，THEN 应静默跳过，不报错、不弹窗。

---

### 需求-2：Worktree 初始化后触发 Hook

**用户故事：** 作为开发者，我希望在点击"📁 Worktree"按钮成功完成 Worktree 初始化（代码检出）之后，自动执行 `worktree-open` Hook 脚本（如 `npm install`），以便于进入 Worktree 子面板时代码依赖已就绪。

#### 验收标准

1. GIVEN 配置了至少一条 `worktree-open` Hook 脚本，WHEN 用户点击任意任务的"📁 Worktree"按钮且该任务为**首次初始化**（代码目录缺失，`ensureIterationCodeBeforeOpen` 完成代码检出），THEN Harness 应在打开新窗口前，在 Worktree 目录下依次执行所有配置的 Hook 脚本，并在 harness.log 中记录每个 Hook 的执行结果（stdout/stderr 摘要与退出码）。
2. GIVEN Hook 脚本执行失败（非零退出码），WHEN Harness 捕获到该错误，THEN 应通过 `vscode.window.showWarningMessage` 显示含脚本名称和退出码的警告，但仍继续打开 Worktree 窗口（非阻塞）；失败详情写入 harness.log。
3. GIVEN 代码目录**已存在**（非首次初始化），WHEN 用户再次点击"📁 Worktree"按钮，THEN `worktree-open` Hook **不**重复执行（幂等保证）。
4. GIVEN Hook 脚本路径为 `master` 来源，WHEN 执行时，THEN 脚本文件从 `<masterRoot>/script/<scriptFile>` 解析；若路径为 `worktree` 来源，THEN 从 Worktree 目录下的 scripts 子目录解析，与 CustomButton 解析规则一致。

---

### 需求-3：Hook 执行进度反馈

**用户故事：** 作为开发者，我希望在 Hook 脚本执行期间能看到进度提示，以便于了解当前是否还在等待初始化完成。

#### 验收标准

1. GIVEN `worktree-open` Hook 脚本开始执行，WHEN Harness 调用脚本进程，THEN 应显示 VS Code 进度通知（`vscode.window.withProgress`，位置 `Notification`），标题含任务名称与正在执行的脚本名称，直到所有 Hook 脚本执行完毕或失败。
2. GIVEN 所有 Hook 脚本执行成功，WHEN 进度通知关闭，THEN 继续正常的 `vscode.openFolder` 流程打开 Worktree 窗口。

---

### 需求-4：Hook 脚本来源与格式兼容

**用户故事：** 作为开发者，我希望 Hook 脚本的配置格式和来源规则与现有 CustomButton 保持一致，以便于复用已有脚本而无需额外学习新格式。

#### 验收标准

1. GIVEN Hook 配置中的 `scriptSource` 为 `master`，WHEN 解析脚本路径，THEN 行为与 `CustomButton` 的 `master` 来源完全一致（从 `<masterRoot>/script/` 查找文件）。
2. GIVEN Hook 配置中的 `scriptSource` 为 `worktree`，WHEN 解析脚本路径，THEN 行为与 `CustomButton` 的 `worktree` 来源完全一致（从 Worktree 迭代目录的 scripts 子目录查找）。
3. GIVEN `isOsScriptFile` 判断文件名不适配当前 OS，WHEN Harness 尝试执行该 Hook，THEN 应跳过并在 harness.log 中记录"跳过非当前 OS 脚本"日志，不报错。

---

## 需求追踪矩阵

| Req-ID | 关联代码区域（参考） | 状态 |
|--------|---------------------|------|
| Req-1  | `Config` 接口（models.ts）、设置页面 `buildSettingsPageHtml`（webviewTemplates.ts）| 待实现 |
| Req-2  | `openFolderLocationByTaskId` / `ensureIterationCodeBeforeOpen`（harnessActionsService.ts）| 待实现 |
| Req-3  | `vscode.window.withProgress`（harnessActionsService.ts）| 待实现 |
| Req-4  | `normalizeCustomButton`、`isOsScriptFile`、`getScriptsSubdir`（models.ts）| 待实现 |

---

## 机器可读区

```yaml
artifactType: requirements
taskName: initial-hook
requirements:
  - id: Req-1
    title: 全局 Hook 配置项
    userStory: 作为团队管理员，我希望在 Fun Harness 的全局设置中为关键节点配置 Hook 脚本列表，以便于在不修改代码的情况下为所有迭代任务的 Worktree 初始化添加自动化步骤。
    acceptanceCriteria:
      - GIVEN 用户进入设置界面 WHEN 查看 Hook 配置区域 THEN 展示 worktree-open 节点的脚本列表配置项，支持脚本文件名与可选 args
      - GIVEN 用户填写有效 Hook 配置并保存 WHEN 重新打开设置 THEN 配置正确持久化
      - GIVEN 未填写任何 Hook 配置 WHEN Harness 执行 Hook 流程 THEN 静默跳过，不报错

  - id: Req-2
    title: Worktree 初始化后触发 Hook
    userStory: 作为开发者，我希望在点击"📁 Worktree"按钮成功完成 Worktree 初始化之后，自动执行 worktree-open Hook 脚本，以便于进入 Worktree 子面板时代码依赖已就绪。
    acceptanceCriteria:
      - GIVEN 配置了 worktree-open Hook WHEN 首次初始化完成 THEN 依次执行所有 Hook 脚本并记录到 harness.log
      - GIVEN Hook 脚本退出码非零 WHEN Harness 捕获错误 THEN 显示 showWarningMessage 警告但仍打开窗口（非阻塞）
      - GIVEN 代码目录已存在 WHEN 再次点击 Worktree 按钮 THEN Hook 不重复执行（幂等）
      - GIVEN scriptSource 为 master WHEN 执行 THEN 从 masterRoot/script/ 解析；worktree 来源从 Worktree scripts 子目录解析

  - id: Req-3
    title: Hook 执行进度反馈
    userStory: 作为开发者，我希望在 Hook 脚本执行期间能看到进度提示，以便于了解当前是否还在等待初始化完成。
    acceptanceCriteria:
      - GIVEN Hook 脚本开始执行 WHEN Harness 调用进程 THEN 显示 withProgress 通知含任务名和脚本名，直到所有 Hook 执行完毕
      - GIVEN 所有 Hook 执行成功 WHEN 进度通知关闭 THEN 继续正常 openFolder 流程

  - id: Req-4
    title: Hook 脚本来源与格式兼容
    userStory: 作为开发者，我希望 Hook 脚本的配置格式和来源规则与现有 CustomButton 保持一致，以便于复用已有脚本。
    acceptanceCriteria:
      - GIVEN scriptSource 为 master WHEN 解析路径 THEN 与 CustomButton master 来源行为完全一致
      - GIVEN scriptSource 为 worktree WHEN 解析路径 THEN 与 CustomButton worktree 来源行为完全一致
      - GIVEN isOsScriptFile 判断不适配当前 OS WHEN 执行 Hook THEN 跳过并记录日志，不报错
```
