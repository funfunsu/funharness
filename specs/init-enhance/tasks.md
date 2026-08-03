# 任务拆解文档

## 迭代信息

- **功能名称**：init-enhance
- **任务拆分模式**：standard
- **目标文件**：`apps/src/extension.ts`（唯一受影响文件）
- **关联需求**：Req-1、Req-2、Req-3、Req-4
- **关联设计**：`specs/init-enhance/design.md`

---

## 既有资源声明

| 资源 | 路径 | 状态 |
|------|------|------|
| 需求文档 | `specs/init-enhance/requirements.md` | ✅ 已确认 |
| 设计文档 | `specs/init-enhance/design.md` | ✅ 已确认 |
| 测试用例文档 | `specs/init-enhance/testcase.md` | ⬜ 不存在，跳过 |
| 测试清单 | `tests/test-manifest.json` | ⬜ 不存在，跳过 |
| 实现目标文件 | `apps/src/extension.ts` | ✅ 已存在，待修改 |

---

## 任务清单（严格按依赖顺序执行）

### 阶段一：状态字段引入

- [x] 1.1 在 `Harness` 类中添加 `isInitializingProjectStructure` 私有字段
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.2 Model-1
  - 输出: 修改 `apps/src/extension.ts`：在 `Harness` 类顶部声明 `private isInitializingProjectStructure: boolean = false`
  - 验收:
    - 字段类型为 `boolean`，初始值为 `false`
    - 未修改任何其他类或文件
  - 追踪: Req-2 / Model-1 / INV-1

- [x] 1.2 在 `Harness` 类中添加 `lastDispatchedPreviewHash` 私有字段
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.2 Model-2
  - 输出: 修改 `apps/src/extension.ts`：在 `Harness` 类顶部声明 `private lastDispatchedPreviewHash: string | undefined = undefined`
  - 验收:
    - 字段类型为 `string | undefined`，初始值为 `undefined`
    - 未修改任何其他类或文件
  - 追踪: Req-3 / Model-2 / INV-3

---

### 阶段二：并发互斥保护（Req-2）

- [x] 2.1 在 `handleInitProjectStructure` 入口添加互斥锁检测与加锁逻辑
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §2.1 架构图（互斥锁节点）、§3.1 API-1
  - 输出: 修改 `apps/src/extension.ts`：`handleInitProjectStructure` 方法起始处插入互斥检测块
    ```
    if (this.isInitializingProjectStructure) {
        vscode.window.showInformationMessage('项目结构初始化正在进行中，请稍候');
        return;
    }
    this.isInitializingProjectStructure = true;
    ```
  - 验收:
    - 当 `isInitializingProjectStructure === true` 时，调用立即返回，仅显示一条信息提示，不执行后续逻辑
    - 锁在方法入口（进入检测逻辑前）被设置为 `true`
  - 追踪: Req-2 / INV-1

- [x] 2.2 用 `try/finally` 包裹 `handleInitProjectStructure` 主体，确保锁释放
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §5 错误处理、§4 INV-1
  - 输出: 修改 `apps/src/extension.ts`：将方法主体（含 `readOnly` 检测之后的所有逻辑）包入 `try { ... } finally { this.isInitializingProjectStructure = false; }` 块
  - 验收:
    - 正常完成、用户取消、异常中断三条路径均可到达 `finally`
    - `isInitializingProjectStructure` 在方法返回后恢复为 `false`
    - `configMeta.readOnly` 早返回路径不加锁（该路径在加锁之前返回，无需 finally）
  - 追踪: Req-2 / INV-1

---

### 阶段三：文档存在性确认对话框（Req-1）

- [x] 3.1 在 `handleInitProjectStructure` 加锁后、检测逻辑前添加 `readRootStructure` 存在性检测
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.1 API-3、§2.1 架构图（存在性检测节点）
  - 输出: 修改 `apps/src/extension.ts`：加锁后读取 `this.projectStructureService.readRootStructure()`，若返回非空字符串则进入确认流程，否则跳过
  - 验收:
    - `readRootStructure()` 返回空串时，确认对话框不弹出，直接执行后续检测逻辑
    - `readRootStructure()` 返回非空字符串时，进入任务 3.2 确认逻辑
  - 追踪: Req-1 / INV-2

- [x] 3.2 实现确认对话框，处理「取消」与「重新初始化」两种选择
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.1 API-1、§4 INV-2、INV-5
  - 输出: 修改 `apps/src/extension.ts`：调用 `vscode.window.showInformationMessage('project-structure.md 已存在，是否重新初始化？', '重新初始化', '取消')` 并处理返回值
    - 返回 `'重新初始化'`：继续执行检测流程
    - 返回 `'取消'` 或 `undefined`（对话框被关闭）：立即返回（`finally` 自动释放锁）
  - 验收:
    - 用户选「取消」或关闭对话框：`writePreviewStructure`、`openTextDocument`、`aiDispatchService.dispatch()` 均未被调用
    - 用户选「重新初始化」：流程继续执行，行为与原有逻辑一致
    - `lastDispatchedPreviewHash` 在取消路径下不更新
  - 追踪: Req-1 / INV-2 / INV-5

---

### 阶段四：AI 派发哈希去重（Req-3）

- [x] 4.1 在 `aiDispatchService.dispatch()` 调用前计算预览内容 SHA-256 哈希并与缓存比对
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.2 Model-2、§4 INV-3
  - 输出: 修改 `apps/src/extension.ts`：在 `aiReviewMode` 为 `true` 的分支内，`dispatch()` 调用前插入哈希比对逻辑
    - 引入 Node.js 内置 `crypto` 模块（`import * as crypto from 'crypto'`，若尚未引入）
    - 计算：`const currentHash = crypto.createHash('sha256').update(detected.content).digest('hex')`
    - 若 `currentHash === this.lastDispatchedPreviewHash`：跳过 `dispatch()`，调用 `showInformationMessage('预览内容未变更，已跳过 AI 审阅')`
  - 验收:
    - 哈希相同时：`dispatch()` 不被调用，`lastDispatchedPreviewHash` 不更新，显示跳过提示
    - 哈希不同时：进入任务 4.2 派发流程
  - 追踪: Req-3 / INV-3

- [x] 4.2 在 `dispatch()` 成功后更新 `lastDispatchedPreviewHash`
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.2 Model-2、§4 INV-3
  - 输出: 修改 `apps/src/extension.ts`：`dispatch()` 调用成功后（`try` 块内、抛出异常之前）赋值 `this.lastDispatchedPreviewHash = currentHash`
  - 验收:
    - `dispatch()` 成功完成后，`lastDispatchedPreviewHash` 等于本次计算的哈希值
    - `dispatch()` 抛出异常时，`lastDispatchedPreviewHash` 不被更新
    - `projectStructureRefineMode === 'local'` 或 `detected.detected === false` 时，哈希计算与赋值均不执行
  - 追踪: Req-3 / INV-3

---

### 阶段五：确认 `ensureProjectStructureBaseline` 边界（Req-4）

- [x] 5.1 代码审查：确认 `ensureProjectStructureBaseline` 调用链无 AI 派发与 UI 副作用
  - Owner: FullStack
  - 输入: `specs/init-enhance/design.md` §3.1 API-2、§4 INV-4；`apps/src/extension.ts` 当前实现
  - 输出:
    - 若调用链（`handleSaveGitConfig`、`handleSaveAdvancedConfig`、扩展激活）干净：添加内联注释 `// Side-effect boundary: no AI dispatch, no UI dialogs, no openTextDocument` 至 `ensureProjectStructureBaseline` 方法体
    - 若发现违规调用：移除或隔离该调用，确保方法仅执行文件写入
  - 验收:
    - `ensureProjectStructureBaseline` 方法体及其所有同步调用链中不存在 `dispatch()`、`showInformationMessage`、`showWarningMessage`、`openTextDocument` 的调用
    - 方法签名不变
  - 追踪: Req-4 / INV-4

---

### 阶段六：检查点

- [x] 6.1 端到端验证：四条需求路径均满足验收标准
  - Owner: FullStack
  - 输入: `specs/init-enhance/requirements.md` 所有验收标准；任务 1.1 ~ 5.1 产出的 `apps/src/extension.ts`
  - 输出: 无新文件；确认 `apps/src/extension.ts` 中所有修改点一致，无遗漏
  - 验收:
    - Req-1：`project-structure.md` 非空时弹出确认框；取消时无文件写入、无 AI 派发
    - Req-2：并发触发时第二次立即返回并提示；流程结束后锁释放
    - Req-3：首次派发调用一次；相同哈希时跳过并提示；取消路径不派发
    - Req-4：`ensureProjectStructureBaseline` 无 AI 派发、无对话框、无编辑器打开
    - TypeScript 编译无新增错误（`tsc --noEmit`）
  - 追踪: Req-1 / Req-2 / Req-3 / Req-4

---

## 机器可读区

```yaml
artifactType: tasks
taskName: init-enhance
tasks:
  - id: "1.1"
    name: 添加 isInitializingProjectStructure 私有字段
    owner: FullStack
    domain: project-structure-init
    dependsOn: []
    inputs: [specs/init-enhance/design.md#3.2-Model-1]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-2]

  - id: "1.2"
    name: 添加 lastDispatchedPreviewHash 私有字段
    owner: FullStack
    domain: project-structure-init
    dependsOn: []
    inputs: [specs/init-enhance/design.md#3.2-Model-2]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-3]

  - id: "2.1"
    name: 添加互斥锁入口检测与加锁逻辑
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["1.1"]
    inputs: [specs/init-enhance/design.md#2.1, specs/init-enhance/design.md#3.1-API-1]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-2]

  - id: "2.2"
    name: try/finally 包裹主体确保锁释放
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["2.1"]
    inputs: [specs/init-enhance/design.md#4-INV-1, specs/init-enhance/design.md#5]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-2]

  - id: "3.1"
    name: 加锁后添加文档存在性检测
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["2.2"]
    inputs: [specs/init-enhance/design.md#3.1-API-3, specs/init-enhance/design.md#2.1]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-1]

  - id: "3.2"
    name: 实现确认对话框与取消/继续分支
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["3.1"]
    inputs: [specs/init-enhance/design.md#3.1-API-1, specs/init-enhance/design.md#4-INV-2, specs/init-enhance/design.md#4-INV-5]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-1]

  - id: "4.1"
    name: dispatch 前计算哈希并与缓存比对
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["1.2", "3.2"]
    inputs: [specs/init-enhance/design.md#3.2-Model-2, specs/init-enhance/design.md#4-INV-3]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-3]

  - id: "4.2"
    name: dispatch 成功后更新哈希缓存
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["4.1"]
    inputs: [specs/init-enhance/design.md#3.2-Model-2, specs/init-enhance/design.md#4-INV-3]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-3]

  - id: "5.1"
    name: 审查并标注 ensureProjectStructureBaseline 副作用边界
    owner: FullStack
    domain: project-structure-init
    dependsOn: []
    inputs: [specs/init-enhance/design.md#3.1-API-2, specs/init-enhance/design.md#4-INV-4]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-4]

  - id: "6.1"
    name: 端到端验收检查点
    owner: FullStack
    domain: project-structure-init
    dependsOn: ["2.2", "3.2", "4.2", "5.1"]
    inputs: [specs/init-enhance/requirements.md, apps/src/extension.ts]
    outputs: []
    requirementIds: [Req-1, Req-2, Req-3, Req-4]
```
