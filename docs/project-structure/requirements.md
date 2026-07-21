# 需求文档

## 简介

本需求面向 funHarness 插件的「项目结构文档（`docs/project-structure.md`）」生成能力。当前实现存在的问题是：初始化阶段调用 `ensureProjectStructureBaseline` → `ProjectStructureService.ensureBaseline()` 时，仅按「自定义 > 已存在 > 静态默认模板」的顺序落盘，**并不会**读取仓库真实代码目录结构；真正基于真实目录的探测逻辑 `detectStructureFromWorkspace()` 只在用户手动点击「初始化项目结构」按钮（`handleInitProjectStructure`）时才触发。因此用户在初始化后拿到的往往是与项目实际不符的通用默认模板。

本次需求的目标：**让 `docs/project-structure.md` 在初始化时（而非仅手动触发时）优先根据项目实际的代码目录结构生成**，并定义清楚探测、预览、确认、应用、回退的交互、流程与时机，同时保持幂等与既有优先级约定不被破坏。

本需求文档仅定义「做什么」与「验收标准」，不约束具体代码实现细节。

## 术语表

| 术语 | 说明 |
| --- | --- |
| 正式文档 | 落盘于 `docs/project-structure.md`（monorepo 模式下位于 `repos/mono-main/docs/project-structure.md`）的最终项目结构文档，供 Design/Dev Agent 使用 |
| 预览文档 | 落盘于 `docs/project-structure.preview.md` 的候选内容，供用户检查/编辑后再应用到正式文档 |
| 结构探测 | `detectStructureFromWorkspace()`：扫描前端（Vue3/React）与后端（Java-DDD/分层/多模块、Node.js）真实目录并生成精简目录树 |
| 自定义结构 | 用户在设置中提供的 `customProjectStructure` 文本 |
| 默认模板 | 内置静态兜底结构（`getDefaultStructure()` / `DEFAULT_PROJECT_STRUCTURE`） |
| 基线初始化 | 插件激活/任务开始时自动执行的 `ensureProjectStructureBaseline()` 流程 |
| 优先级链 | 决定正式文档内容来源的选择顺序 |
| 幂等 | 在同一仓库状态下重复执行初始化/生成，产出内容与文件位置一致，不产生重复或冲突 |

## 需求清单

### 需求-1：初始化时基于真实代码目录生成结构

**用户故事：** 作为使用 funHarness 的开发者，我希望在项目初始化时系统就根据我仓库中真实的代码目录结构生成 `docs/project-structure.md`，以便于后续 Design/Dev Agent 能基于真实结构定位改动，而不是拿到与项目无关的默认模板。

#### 验收标准

1. GIVEN 仓库存在可识别的前端或后端代码目录且用户未提供自定义结构、正式文档尚不存在，WHEN 基线初始化流程执行，THEN 系统应调用结构探测并以探测结果作为正式文档（或预览文档）的内容来源，而不得直接写入静态默认模板。
2. GIVEN 结构探测成功返回 `detected=true`，WHEN 生成结构内容，THEN 正式/预览文档中的目录树必须来源于真实扫描到的目录（如真实存在的 `src/` 子目录、真实 Java 包路径），而非硬编码示例目录。
3. GIVEN 仓库为 monorepo 模式，WHEN 初始化生成结构，THEN 探测的根目录与文档落盘位置必须遵循 monorepo 约定（`repos/mono-main`），确保文档位于受 git 管理的目录内。

### 需求-2：结构来源优先级与冲突解决

**用户故事：** 作为开发者，我希望结构来源有清晰、可预测的优先级，以便于我用自定义结构或已存在文档时不会被自动探测覆盖。

#### 验收标准

1. GIVEN 用户提供了非空自定义结构，WHEN 初始化执行，THEN 系统必须以自定义结构为正式文档内容，且不得触发或应用结构探测结果。
2. GIVEN 用户未提供自定义结构但正式文档已存在且内容非空，WHEN 初始化执行，THEN 系统必须保留已存在正式文档内容，且不得用探测结果覆盖它。
3. GIVEN 用户未提供自定义结构、正式文档不存在、且结构探测失败（`detected=false`），WHEN 初始化执行，THEN 系统必须回退到默认模板并保证正式文档非空。
4. GIVEN 上述任一分支执行完成，WHEN 检查结果，THEN 最终选择来源必须可判定为「custom / existing / detected / default」之一且唯一，不得同时应用多个来源。

### 需求-3：结构探测覆盖真实前后端形态

**用户故事：** 作为使用不同技术栈的开发者，我希望探测能正确识别我项目的前后端形态，以便于生成的结构与真实技术栈匹配。

#### 验收标准

1. GIVEN 仓库前端为 Vue3（存在 `.vue` 文件）或 React（存在 react 依赖或 `.jsx/.tsx` 文件），WHEN 执行探测，THEN 系统必须识别对应前端类型并输出带真实 `src/` 子目录的前端目录树。
2. GIVEN 仓库后端为 Java 项目（存在 `src/main/java` 且有 Maven/Gradle 构建文件，含多模块 `<module>` 场景），WHEN 执行探测，THEN 系统必须识别真实基础包名并按 DDD/分层/混合风格输出后端目录树。
3. GIVEN 仓库后端为 Node.js 服务（`package.json` 含 express/koa/fastify/nestjs 等提示），WHEN 执行探测，THEN 系统必须识别为 Node.js 后端并输出对应目录树。
4. GIVEN 仓库既无可识别前端也无可识别后端，WHEN 执行探测，THEN 探测结果 `detected` 必须为 false 并携带可展示的回退摘要说明。

### 需求-4：预览—确认—应用交互流程

**用户故事：** 作为开发者，我希望在探测结果被写入正式文档之前能够先检查甚至手动编辑预览，以便于我在结果不完美时进行修正后再应用。

#### 验收标准

1. GIVEN 结构探测成功，WHEN 生成候选内容，THEN 系统必须先写入预览文档（`docs/project-structure.preview.md`）并向用户提供「应用预览到正式文档」「改用默认结构」等明确的可操作选项。
2. GIVEN 用户对预览文档进行了手动编辑，WHEN 用户选择「应用预览结构」，THEN 系统必须以预览文档的当前内容（含用户编辑）写入正式文档。
3. GIVEN 用户选择「改用默认结构」，WHEN 该动作执行，THEN 系统必须以默认模板写入正式文档并覆盖此前预览来源。
4. GIVEN 预览文档不存在或内容为空，WHEN 用户触发「应用预览」，THEN 系统不得清空或损坏正式文档，并应给出可感知的失败/无操作反馈。

### 需求-5：探测失败与回退提示

**用户故事：** 作为开发者，我希望在系统无法从真实目录提炼结构时能明确告知我已回退默认模板，以便于我知道当前文档来源并决定是否手动完善。

#### 验收标准

1. GIVEN 结构探测返回 `detected=false`，WHEN 初始化/生成流程结束，THEN 系统必须写入默认模板作为正式文档，并向用户展示「未检测到可提炼结构，已使用默认模板」类提示。
2. GIVEN 探测过程中读取某些目录/文件失败，WHEN 探测继续执行，THEN 单个读取失败不得导致整个生成流程中断，系统应尽力返回已成功探测部分或回退默认。

### 需求-6：生成过程幂等且可重复执行

**用户故事：** 作为开发者，我希望重复初始化或重新生成不会产生重复内容或结构冲突，以便于我可以安全地多次触发。

#### 验收标准

1. GIVEN 同一仓库状态未变化，WHEN 重复执行初始化基线流程，THEN 正式文档的最终内容与落盘位置必须保持一致，不得产生重复目录块或冲突内容。
2. GIVEN 正式文档已由本流程生成，WHEN 再次执行初始化且来源仍为「existing」，THEN 系统不得因重复写入而改变既有内容。
3. GIVEN 用户重新触发「初始化项目结构」手动命令，WHEN 流程执行，THEN 预览文档应被最新探测结果覆盖，而正式文档仅在用户显式应用或选择默认后才变化。

### 需求-7：触发时机明确且不阻塞初始化

**用户故事：** 作为开发者，我希望结构生成的触发时机清晰（自动初始化 + 手动重生成），且不会阻塞或拖慢插件初始化主流程，以便于我获得可预期且流畅的体验。

#### 验收标准

1. GIVEN 插件在可写（非只读快照）工作区激活并进入基线初始化，WHEN 满足需求-1 触发条件，THEN 基于真实目录的结构生成必须在此自动时机被纳入执行路径。
2. GIVEN 当前窗口使用主窗口配置快照（只读），WHEN 初始化执行，THEN 系统不得在只读窗口执行会修改正式文档的生成/探测写入动作。
3. GIVEN 用户希望重新提炼结构，WHEN 用户手动触发「初始化项目结构」命令，THEN 系统必须执行完整的探测—预览—确认流程（需求-4）。
4. GIVEN 可选的 AI 二次审阅在非 `local` 模式下开启，WHEN 探测成功，THEN AI 审阅仅作为对预览的增强触发，其成功与否不得阻塞或回滚已生成的预览/正式文档。

## 需求追踪矩阵（如有已有设计/代码）

| 需求 | 关联现有代码/文件 | 说明 |
| --- | --- | --- |
| Req-1 | `apps/src/extension.ts` `ensureProjectStructureBaseline()`；`apps/src/services/projectStructureService.ts` `ensureBaseline()` / `detectStructureFromWorkspace()` | 需在基线初始化路径中引入探测，改变「直接默认模板」行为 |
| Req-2 | `projectStructureService.ts` `ensureBaseline()`（custom/existing/default 分支） | 需在既有优先级链中插入 detected 分支并保证唯一性 |
| Req-3 | `projectStructureService.ts` `findFrontendProject()` / `findBackendProject()` / `buildFrontendConciseTree()` / `buildJavaBackendTree()` / `buildNodeBackendTree()` | 探测能力已存在，需被初始化时机复用 |
| Req-4 | `extension.ts` `handleInitProjectStructure()` / `handleApplyProjectStructurePreview()`；`projectStructureService.ts` `writePreviewStructure()` / `applyPreviewToRoot()` | 预览—确认—应用交互已部分存在，需对齐初始化流程 |
| Req-5 | `projectStructureService.ts` `detectStructureFromWorkspace()`（`detected=false` 分支）；`extension.ts` 回退提示 | 回退提示与容错 |
| Req-6 | `projectStructureService.ts` `writeRootStructure()` / `readRootStructure()` / `ensureBaseline()` | 幂等落盘 |
| Req-7 | `extension.ts` `ensureProjectStructureBaseline()`（`configMeta.readOnly` 判断）、AI 审阅触发；`harnessMessageController.ts` `initProjectStructure` | 触发时机与只读保护 |

## 机器可读区

```yaml
artifactType: requirements
taskName: project-structure
requirements:
  - id: Req-1
    title: 初始化时基于真实代码目录生成结构
    userStory: 作为使用 funHarness 的开发者，我希望在项目初始化时系统根据仓库真实代码目录结构生成 docs/project-structure.md，以便于后续 Agent 基于真实结构定位改动
    acceptanceCriteria:
      - GIVEN 仓库存在可识别前后端代码且无自定义结构且正式文档不存在 WHEN 基线初始化执行 THEN 系统调用结构探测并以探测结果作为内容来源，不直接写默认模板
      - GIVEN 探测返回 detected=true WHEN 生成内容 THEN 目录树来源于真实扫描目录而非硬编码示例
      - GIVEN monorepo 模式 WHEN 初始化生成 THEN 探测根目录与落盘位置遵循 repos/mono-main 约定
  - id: Req-2
    title: 结构来源优先级与冲突解决
    userStory: 作为开发者，我希望结构来源有清晰可预测的优先级，以便于自定义或已存在文档不被自动探测覆盖
    acceptanceCriteria:
      - GIVEN 用户提供非空自定义结构 WHEN 初始化执行 THEN 以自定义结构为正式文档且不应用探测结果
      - GIVEN 无自定义结构但正式文档已存在且非空 WHEN 初始化执行 THEN 保留已存在内容且不被探测覆盖
      - GIVEN 无自定义、正式文档不存在、探测失败 WHEN 初始化执行 THEN 回退默认模板并保证正式文档非空
      - GIVEN 任一分支完成 WHEN 检查结果 THEN 来源唯一可判定为 custom/existing/detected/default 之一
  - id: Req-3
    title: 结构探测覆盖真实前后端形态
    userStory: 作为使用不同技术栈的开发者，我希望探测正确识别项目前后端形态，以便于生成结构与真实技术栈匹配
    acceptanceCriteria:
      - GIVEN 前端为 Vue3 或 React WHEN 执行探测 THEN 识别对应类型并输出真实 src 子目录树
      - GIVEN 后端为 Java 项目含多模块场景 WHEN 执行探测 THEN 识别真实基础包名并按 DDD/分层/混合风格输出目录树
      - GIVEN 后端为 Node.js 服务 WHEN 执行探测 THEN 识别为 Node.js 后端并输出对应目录树
      - GIVEN 既无可识别前端也无可识别后端 WHEN 执行探测 THEN detected 为 false 并携带回退摘要
  - id: Req-4
    title: 预览—确认—应用交互流程
    userStory: 作为开发者，我希望探测结果写入正式文档前能先检查甚至手动编辑预览，以便于修正后再应用
    acceptanceCriteria:
      - GIVEN 探测成功 WHEN 生成候选内容 THEN 先写入预览文档并提供应用/改用默认等明确可操作选项
      - GIVEN 用户手动编辑了预览 WHEN 用户选择应用预览 THEN 以预览当前内容写入正式文档
      - GIVEN 用户选择改用默认结构 WHEN 动作执行 THEN 以默认模板写入正式文档并覆盖预览来源
      - GIVEN 预览文档不存在或为空 WHEN 触发应用预览 THEN 不得清空或损坏正式文档并给出可感知反馈
  - id: Req-5
    title: 探测失败与回退提示
    userStory: 作为开发者，我希望系统无法提炼结构时明确告知已回退默认模板，以便于知晓来源并决定是否手动完善
    acceptanceCriteria:
      - GIVEN 探测返回 detected=false WHEN 流程结束 THEN 写入默认模板并展示已使用默认模板提示
      - GIVEN 探测中读取部分目录失败 WHEN 探测继续 THEN 单点失败不中断整体流程，尽力返回已探测部分或回退默认
  - id: Req-6
    title: 生成过程幂等且可重复执行
    userStory: 作为开发者，我希望重复初始化或重新生成不产生重复内容或冲突，以便于安全多次触发
    acceptanceCriteria:
      - GIVEN 仓库状态未变化 WHEN 重复执行初始化基线 THEN 正式文档内容与落盘位置保持一致且无重复目录块
      - GIVEN 正式文档已生成 WHEN 再次初始化且来源为 existing THEN 不因重复写入改变既有内容
      - GIVEN 用户重新触发初始化命令 WHEN 流程执行 THEN 预览被最新探测覆盖，正式文档仅在显式应用或选择默认后变化
  - id: Req-7
    title: 触发时机明确且不阻塞初始化
    userStory: 作为开发者，我希望结构生成触发时机清晰且不阻塞插件初始化，以便于获得可预期流畅体验
    acceptanceCriteria:
      - GIVEN 插件在可写工作区激活进入基线初始化 WHEN 满足触发条件 THEN 基于真实目录的生成被纳入自动执行路径
      - GIVEN 当前窗口为只读配置快照 WHEN 初始化执行 THEN 不执行会修改正式文档的写入动作
      - GIVEN 用户希望重新提炼 WHEN 手动触发初始化命令 THEN 执行完整探测—预览—确认流程
      - GIVEN 非 local 模式开启 AI 二次审阅 WHEN 探测成功 THEN AI 审阅仅增强预览且不阻塞或回滚已生成文档
```
