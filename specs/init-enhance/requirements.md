# 需求文档

## 简介

本文档描述 **init-enhance** 功能的需求，目标是修复项目结构初始化流程中的两类问题：

1. **不必要的 AI 任务触发**：在 `project-structure.md` 已存在（非空）的情况下，`handleInitProjectStructure` 仍会执行完整检测流程并向 AI 派发"为项目结构目录树补充简要说明"任务。
2. **重复对话发起**：初始化动作可在短时间内被多次触发（并发点击或多路径同时激活），导致多条 AI 对话被创建。

优化目标：使初始化流程幂等、可感知现有状态、具备并发互斥保护，并保证 AI 审阅任务仅在真正需要时触发一次。

---

## 术语表

| 术语 | 说明 |
|------|------|
| `project-structure.md` | 工作区根目录下 `docs/project-structure.md`，记录项目目录结构与模块说明 |
| `project-structure.preview.md` | 检测生成的预览文档，待用户确认后方可应用 |
| `handleInitProjectStructure` | `extension.ts` 中执行完整初始化流程的私有方法 |
| `ensureProjectStructureBaseline` | 仅保障基线文件存在的轻量方法，不触发 AI |
| AI 审阅任务 | 由 `aiDispatchService.dispatch()` 发起的"为项目结构目录树补充简要说明"对话 |
| 并发保护 | 防止同一初始化流程被并发或重复触发的互斥机制 |

---

## 需求清单

### 需求-1：初始化前检测已有文档并请求确认

**用户故事：** 作为开发者，我希望在 `project-structure.md` 已存在且非空时触发初始化操作后，系统向我展示确认对话框，以便我有机会阻止不必要的重新检测与 AI 任务。

#### 验收标准

1. GIVEN `docs/project-structure.md`（或 monorepo 模式下对应路径）存在且内容非空 WHEN 用户在 Webview 面板中触发 `initProjectStructure` 动作 THEN 系统在执行任何检测逻辑之前弹出确认对话框，包含选项「重新初始化」与「取消」。
2. GIVEN 出现上述确认对话框 WHEN 用户选择「取消」 THEN `handleInitProjectStructure` 立即返回，不执行目录树检测，不写入预览文件，不打开任何编辑器标签，不派发 AI 审阅任务。
3. GIVEN 出现上述确认对话框 WHEN 用户选择「重新初始化」 THEN 流程正常继续（与现有检测 + AI 审阅逻辑保持一致）。
4. GIVEN `docs/project-structure.md` 不存在或内容为空 WHEN 用户触发 `initProjectStructure` THEN 不弹出确认对话框，直接执行完整初始化流程（不影响现有行为）。

---

### 需求-2：初始化流程并发互斥保护

**用户故事：** 作为开发者，我希望同一时间最多只有一个初始化流程在运行，以便避免重复打开编辑器标签或发起多条 AI 对话。

#### 验收标准

1. GIVEN `handleInitProjectStructure` 正在执行（异步流程尚未完成）WHEN 同一动作再次被触发（例如重复点击或多路径同时激活）THEN 后续调用立即返回，不重复执行任何步骤，并以 `showInformationMessage` 提示用户「项目结构初始化正在进行中，请稍候」。
2. GIVEN 初始化流程因任意原因（正常完成、用户取消、异常中断）结束 WHEN 之后再次触发 `initProjectStructure` THEN 互斥锁已释放，流程可正常执行。
3. GIVEN 互斥锁已释放后用户触发初始化 WHEN `project-structure.md` 已存在且非空 THEN 仍触发 Req-1 确认对话框（两项机制正交，互不干扰）。

---

### 需求-3：AI 审阅任务仅在首次生成预览时派发

**用户故事：** 作为开发者，我希望 AI 审阅任务只在初始化流程真正生成了新预览内容时才被触发，以便避免对已有文件执行无意义的 AI 对话。

#### 验收标准

1. GIVEN 初始化流程运行并成功生成预览（`detected.detected === true`）且 `projectStructureRefineMode !== 'local'` WHEN 流程首次到达派发点 THEN `aiDispatchService.dispatch()` 被调用一次且仅一次。
2. GIVEN 同一预览文件（`project-structure.preview.md`）内容与上一次派发时完全相同（内容哈希一致）WHEN 初始化流程再次到达派发点 THEN 跳过 AI 派发，以 `showInformationMessage` 提示「预览内容未变更，已跳过 AI 审阅」。
3. GIVEN 用户通过 Req-1 确认对话框选择「取消」 THEN `aiDispatchService.dispatch()` 不被调用（已由 Req-1 覆盖，此处为补充确认）。
4. GIVEN `projectStructureRefineMode === 'local'` 或 `detected.detected === false` WHEN 初始化流程执行 THEN AI 审阅任务不被派发（维持现有行为，不得退化）。

---

### 需求-4：`ensureProjectStructureBaseline` 不得触发 AI 任务或 UI 对话框

**用户故事：** 作为开发者，我希望 `ensureProjectStructureBaseline` 保持纯粹的静默基线保障语义，以便它在配置保存、窗口加载等多个调用点上都不会产生副作用。

#### 验收标准

1. GIVEN `ensureProjectStructureBaseline` 被调用（无论 `project-structure.md` 是否存在）WHEN 调用结束 THEN 不调用 `aiDispatchService.dispatch()`，不弹出任何 VS Code 信息/警告对话框，不打开编辑器标签。
2. GIVEN `project-structure.md` 不存在 WHEN `ensureProjectStructureBaseline` 被调用 THEN 写入默认模板（维持现有行为），且不触发 Req-1 确认对话框。
3. GIVEN 任意调用路径（`handleSaveGitConfig`、`handleSaveAdvancedConfig`、扩展激活）WHEN 其调用链包含 `ensureProjectStructureBaseline` THEN 仅该方法自身的文件写入行为被执行，不级联触发 `handleInitProjectStructure`。

---

## 需求追踪矩阵

| 需求 ID | 关联代码位置 | 说明 |
|---------|-------------|------|
| Req-1 | `extension.ts` → `handleInitProjectStructure()` 入口 | 在方法顶部增加存在性检测与确认逻辑 |
| Req-2 | `extension.ts` → `handleInitProjectStructure()` | 增加 `isInitializingProjectStructure` 互斥标志 |
| Req-3 | `extension.ts` → `handleInitProjectStructure()` AI 派发段 | 增加内容哈希比对与去重逻辑 |
| Req-4 | `extension.ts` → `ensureProjectStructureBaseline()` | 确认该方法调用链中无 AI 派发，必要时添加注释边界说明 |

---

## 机器可读区

```yaml
artifactType: requirements
taskName: init-enhance
requirements:
  - id: Req-1
    domain: project-structure-init
    rawDomain: project structure initialization existence check
    title: 初始化前检测已有文档并请求确认
    userStory: 作为开发者，我希望在 project-structure.md 已存在且非空时触发初始化操作后，系统向我展示确认对话框，以便我有机会阻止不必要的重新检测与 AI 任务。
    acceptanceCriteria:
      - GIVEN docs/project-structure.md 存在且内容非空 WHEN 用户触发 initProjectStructure 动作 THEN 系统在执行任何检测逻辑之前弹出确认对话框，包含「重新初始化」与「取消」。
      - GIVEN 确认对话框出现 WHEN 用户选择「取消」 THEN handleInitProjectStructure 立即返回，不执行检测，不写入预览，不打开编辑器，不派发 AI 任务。
      - GIVEN 确认对话框出现 WHEN 用户选择「重新初始化」 THEN 流程正常继续，与现有逻辑一致。
      - GIVEN project-structure.md 不存在或内容为空 WHEN 用户触发 initProjectStructure THEN 不弹出确认对话框，直接执行完整初始化流程。

  - id: Req-2
    domain: project-structure-init
    rawDomain: project structure initialization concurrent guard
    title: 初始化流程并发互斥保护
    userStory: 作为开发者，我希望同一时间最多只有一个初始化流程在运行，以便避免重复打开编辑器标签或发起多条 AI 对话。
    acceptanceCriteria:
      - GIVEN handleInitProjectStructure 正在执行 WHEN 同一动作再次被触发 THEN 后续调用立即返回，提示「项目结构初始化正在进行中，请稍候」，不重复执行任何步骤。
      - GIVEN 初始化流程因任意原因结束 WHEN 之后再次触发 initProjectStructure THEN 互斥锁已释放，流程可正常执行。
      - GIVEN 互斥锁释放后 WHEN project-structure.md 已存在且非空且用户触发初始化 THEN 仍触发 Req-1 确认对话框。

  - id: Req-3
    domain: project-structure-init
    rawDomain: project structure AI review dispatch deduplication
    title: AI 审阅任务仅在首次生成预览时派发
    userStory: 作为开发者，我希望 AI 审阅任务只在初始化流程真正生成了新预览内容时才被触发，以便避免对已有文件执行无意义的 AI 对话。
    acceptanceCriteria:
      - GIVEN 初始化成功生成预览且 projectStructureRefineMode !== 'local' WHEN 流程首次到达派发点 THEN aiDispatchService.dispatch() 被调用一次且仅一次。
      - GIVEN 同一预览文件内容与上一次派发时完全相同（内容哈希一致）WHEN 流程再次到达派发点 THEN 跳过 AI 派发，提示「预览内容未变更，已跳过 AI 审阅」。
      - GIVEN 用户通过 Req-1 选择「取消」 THEN aiDispatchService.dispatch() 不被调用。
      - GIVEN projectStructureRefineMode === 'local' 或 detected.detected === false WHEN 初始化执行 THEN AI 审阅任务不被派发。

  - id: Req-4
    domain: project-structure-init
    rawDomain: ensure project structure baseline side-effect boundary
    title: ensureProjectStructureBaseline 不得触发 AI 任务或 UI 对话框
    userStory: 作为开发者，我希望 ensureProjectStructureBaseline 保持纯粹的静默基线保障语义，以便它在多个调用点上都不会产生副作用。
    acceptanceCriteria:
      - GIVEN ensureProjectStructureBaseline 被调用（无论文件是否存在）WHEN 调用结束 THEN 不调用 aiDispatchService.dispatch()，不弹出任何对话框，不打开编辑器标签。
      - GIVEN project-structure.md 不存在 WHEN ensureProjectStructureBaseline 被调用 THEN 写入默认模板，且不触发 Req-1 确认对话框。
      - GIVEN 任意调用路径（handleSaveGitConfig、handleSaveAdvancedConfig、扩展激活）WHEN 调用链包含 ensureProjectStructureBaseline THEN 仅执行文件写入，不级联触发 handleInitProjectStructure。
```
