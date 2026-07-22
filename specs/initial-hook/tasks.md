# 任务拆解文档

## 迭代信息

- 功能名称：initial-hook
- 任务拆分模式：compact
- 需求文档：specs/initial-hook/requirements.md
- 设计文档：specs/initial-hook/design.md
- 测试用例文档：不存在（不作为阻断条件）

## 既有资源声明（如有）

| 资源 | 说明 |
|------|------|
| `apps/src/models.ts` | 已有 `CustomButtonScriptSource`、`isOsScriptFile`、`getScriptsSubdir`，可直接复用 |
| `apps/src/services/harnessActionsService.ts` | 已有 `resolveScriptDir`、`launchCustomButton`、`buildCustomButtonCommand`、`appendHarnessLog`，Hook 执行逻辑在此基础上扩展 |
| `apps/src/services/taskStoreService.ts` | 已有 `loadConfig` 合并逻辑（`{ ...DEFAULT_CONFIG, ...loaded }`），`customButtons` 的合并模式可直接复制用于 `lifecycleHooks` |
| `apps/src/webviewTemplates.ts` | 已有 CustomButton 配置区块，Hook 配置区块紧随其后新增 |

---

## 任务清单（严格按依赖顺序执行）

---

- [failed] 1.1 数据模型：新增 HookEntry / LifecycleHooks 类型并扩展 Config
  - Owner: FullStack
  - 输入: design.md §3.2（MODEL-1、MODEL-2、MODEL-3）
  - 输出: `apps/src/models.ts`
    - 新增接口 `HookEntry { script, scriptSource?, args? }`
    - 新增接口 `LifecycleHooks { worktreeOpen: HookEntry[] }`
    - `Config` 接口末尾追加字段 `lifecycleHooks: LifecycleHooks`
    - `DEFAULT_CONFIG` 追加 `lifecycleHooks: { worktreeOpen: [] }`
  - 验收:
    - `HookEntry` 与 `LifecycleHooks` 类型导出正确，TypeScript 编译无错误
    - `DEFAULT_CONFIG` 包含 `lifecycleHooks: { worktreeOpen: [] }`
  - 追踪: Req-1, Req-4 | MODEL-1, MODEL-2, MODEL-3

---

- [failed] 1.2 配置持久化：taskStoreService 合并 lifecycleHooks
  - Owner: FullStack
  - 依赖: 1.1
  - 输入: design.md §2.2（taskStoreService.ts 说明）、现有 `loadConfig` 合并逻辑
  - 输出: `apps/src/services/taskStoreService.ts`
    - 在 `loadConfig` 的 `merged` 对象后追加：
      `merged.lifecycleHooks = { worktreeOpen: Array.isArray(loaded?.lifecycleHooks?.worktreeOpen) ? loaded.lifecycleHooks.worktreeOpen : [] }`
    - 确保旧配置文件（无 `lifecycleHooks` 字段）加载后自动补默认值
  - 验收:
    - 旧配置（无 `lifecycleHooks`）加载后 `config.lifecycleHooks.worktreeOpen === []`
    - 写入再读取后 `lifecycleHooks` 值不丢失
    - TypeScript 编译无错误
  - 追踪: Req-1 | MODEL-3

---

- [failed] 1.3 设置页面 UI：新增 Lifecycle Hooks 配置区块
  - Owner: FullStack
  - 依赖: 1.1
  - 输入: design.md §3.3（设置页面 UI 规格）
  - 输出: `apps/src/webviewTemplates.ts`
    - 在 CustomButton 配置区块之后新增"⚡ 生命周期 Hook"区块
    - 子区块标题：`Worktree 初始化后（worktree-open）`
    - 说明文字："脚本在 Worktree 首次初始化完成后自动执行（仅首次，不重复触发）"
    - 每条 `HookEntry` 渲染一行：`script` 文本框 + `scriptSource` 下拉（master/worktree）+ `args` 文本框 + 删除按钮
    - 底部"＋ 添加 Hook"按钮
    - 数据通过现有 `saveConfig` / `loadConfig` 消息传递，无新消息类型
  - 验收:
    - 设置页面可正常渲染，含 Hook 配置区块
    - 新增 / 删除 Hook 条目后保存，重载设置页面数据一致
    - 空列表时区块仍显示（显示"暂无配置"或直接显示添加按钮）
  - 追踪: Req-1 | IFACE-2（间接）

---

- [failed] 1.4 Hook 执行引擎：新增 resolveHookScriptPath / spawnHookAsync / runWorktreeOpenHooks
  - Owner: FullStack
  - 依赖: 1.1
  - 输入: design.md §3.1（IFACE-2、IFACE-3、IFACE-4）、design.md §4（INV-3、INV-4、INV-6、INV-7）、design.md §5（错误处理表）
  - 输出: `apps/src/services/harnessActionsService.ts`（仅新增私有方法，不改动现有方法）
    - `resolveHookScriptPath(entry: HookEntry, iterDir: string): string`
      - `master` 来源 → `<masterRoot>/script/<entry.script>`
      - `worktree` 来源 → 复用 `resolveScriptDir` 路径逻辑（isIterationContext=true）
    - `spawnHookAsync(entry, iterDir, taskName, logDir): Promise<void>`
      - `isOsScriptFile` 为 false → 记录 `[hook] SKIP_OS` 日志，resolve
      - 脚本文件不存在 → `showWarningMessage` + 记录 `[hook] MISSING`，resolve
      - `child_process.spawn`（stdio: pipe，cwd: iterDir），捕获 stdout/stderr
      - exitCode=0 → 记录 `[hook] OK`，resolve
      - exitCode≠0 → `showWarningMessage`（含脚本名+exitCode）+ 记录 `[hook] FAILED`，resolve（非阻塞）
      - spawn error → `showWarningMessage` + 记录 `[hook] SPAWN_ERROR`，resolve
    - `runWorktreeOpenHooks(task: Task, iterDir: string): Promise<void>`
      - 读 `config.lifecycleHooks.worktreeOpen`；为空则静默返回（INV-6）
      - 包裹于 `vscode.window.withProgress({ location: ProgressLocation.Notification })` 内
      - 顺序 await 每条 `spawnHookAsync`，单条失败不中断后续（INV-3）
  - 验收:
    - 空 Hook 列表时 `runWorktreeOpenHooks` 不打开任何进程、不弹窗
    - `isOsScriptFile` 为 false 的条目仅写日志、无弹窗
    - 单条脚本 exitCode≠0 时弹 Warning，后续脚本仍执行
    - harness.log 含对应 `[hook]` 分类日志
    - TypeScript 编译无错误
  - 追踪: Req-2, Req-3, Req-4 | IFACE-2, IFACE-3, IFACE-4 | INV-3, INV-4, INV-6, INV-7

---

- [ ] 1.5 接入主流程：修改 ensureIterationCodeBeforeOpen 返回值并接入 openFolderLocationByTaskId
  - Owner: FullStack
  - 依赖: 1.4
  - 输入: design.md §3.1（IFACE-1）、design.md §4（INV-1、INV-2）
  - 输出: `apps/src/services/harnessActionsService.ts`
    - `ensureIterationCodeBeforeOpen` 返回类型改为 `Promise<{ ok: boolean; wasNewlyCreated: boolean }>`
      - 目录缺失且补偿成功 → `{ ok: true, wasNewlyCreated: true }`
      - 目录已存在 → `{ ok: true, wasNewlyCreated: false }`
      - 补偿失败 → `{ ok: false, wasNewlyCreated: false }`
    - 更新两处调用方：
      - `openFolderLocationByTaskId`：读取 `wasNewlyCreated`，为 true 时 `await runWorktreeOpenHooks(task, iterDir)`，随后继续 `syncConfiguredPathsForWorktree` → `seedWorktreeHarnessState` → `openFolder`
      - `runCustomButtonByTaskId`：仅判断 `ok`，`wasNewlyCreated` 忽略
  - 验收:
    - 首次点击 Worktree 按钮（代码目录不存在）：Hook 脚本被触发，完成后新窗口正常打开
    - 再次点击 Worktree 按钮（代码目录已存在）：Hook 脚本**不**触发
    - `runCustomButtonByTaskId` 行为与改动前一致（回归不破坏）
    - TypeScript 编译无错误，无类型错误
  - 追踪: Req-2, Req-3 | IFACE-1 | INV-1, INV-2

---

- [ ] 1.6 检查点：编译验证 & 功能走查
  - Owner: FullStack
  - 依赖: 1.2, 1.3, 1.5
  - 输入: 所有上游任务产出
  - 输出: 无新文件
  - 验收:
    - `cd apps && npm run compile`（或等效 TypeScript 编译命令）零错误通过
    - 设置页面可配置并持久化 Hook 脚本（Req-1）
    - 首次 Worktree 初始化触发 Hook，进度通知出现（Req-2、Req-3）
    - 非首次打开不重复触发（Req-2 幂等）
    - Hook 失败时弹 Warning 但窗口正常打开（Req-2 非阻塞）
    - `master`/`worktree` 来源路径解析正确（Req-4）
  - 追踪: Req-1, Req-2, Req-3, Req-4

---

## 机器可读区

```yaml
artifactType: tasks
taskName: initial-hook
tasks:
  - id: "1.1"
    name: 数据模型：新增 HookEntry / LifecycleHooks 类型并扩展 Config
    owner: FullStack
    dependsOn: []
    inputs:
      - specs/initial-hook/design.md#3.2
    outputs:
      - apps/src/models.ts
    requirementIds: [Req-1, Req-4]
    designRefs: [MODEL-1, MODEL-2, MODEL-3]

  - id: "1.2"
    name: 配置持久化：taskStoreService 合并 lifecycleHooks
    owner: FullStack
    dependsOn: ["1.1"]
    inputs:
      - specs/initial-hook/design.md#2.2
      - apps/src/services/taskStoreService.ts
    outputs:
      - apps/src/services/taskStoreService.ts
    requirementIds: [Req-1]
    designRefs: [MODEL-3]

  - id: "1.3"
    name: 设置页面 UI：新增 Lifecycle Hooks 配置区块
    owner: FullStack
    dependsOn: ["1.1"]
    inputs:
      - specs/initial-hook/design.md#3.3
      - apps/src/webviewTemplates.ts
    outputs:
      - apps/src/webviewTemplates.ts
    requirementIds: [Req-1]
    designRefs: []

  - id: "1.4"
    name: Hook 执行引擎：新增 resolveHookScriptPath / spawnHookAsync / runWorktreeOpenHooks
    owner: FullStack
    dependsOn: ["1.1"]
    inputs:
      - specs/initial-hook/design.md#3.1
      - specs/initial-hook/design.md#4
      - specs/initial-hook/design.md#5
      - apps/src/services/harnessActionsService.ts
    outputs:
      - apps/src/services/harnessActionsService.ts
    requirementIds: [Req-2, Req-3, Req-4]
    designRefs: [IFACE-2, IFACE-3, IFACE-4, INV-3, INV-4, INV-6, INV-7]

  - id: "1.5"
    name: 接入主流程：修改 ensureIterationCodeBeforeOpen 返回值并接入 openFolderLocationByTaskId
    owner: FullStack
    dependsOn: ["1.4"]
    inputs:
      - specs/initial-hook/design.md#3.1
      - specs/initial-hook/design.md#4
      - apps/src/services/harnessActionsService.ts
    outputs:
      - apps/src/services/harnessActionsService.ts
    requirementIds: [Req-2, Req-3]
    designRefs: [IFACE-1, INV-1, INV-2]

  - id: "1.6"
    name: 检查点：编译验证 & 功能走查
    owner: FullStack
    dependsOn: ["1.2", "1.3", "1.5"]
    inputs:
      - apps/src/
    outputs: []
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
    designRefs: []
```
