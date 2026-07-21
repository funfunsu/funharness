# 任务拆解文档

## 迭代信息

- 功能名称：project-structure
- 任务拆分模式：standard（细粒度、小时级可执行任务）
- 需求来源：[docs/project-structure/requirements.md](docs/project-structure/requirements.md)（Req-1 ~ Req-7）
- 设计来源：[docs/project-structure/design.md](docs/project-structure/design.md)（API-1~8 / INV-1~9）
- 目标：让 `docs/project-structure.md` 在初始化时机优先按真实代码目录生成，并对齐探测→预览→确认→应用→回退的交互与时机。
- 可选测试输入：`docs/project-structure/testcase.md`、`tests/test-manifest.json` 均不存在 → 按 `design -> tasks` 直接规划，仅在需求/设计逻辑要求处补充测试任务。
- 测试运行约定：`apps/package.json` 的 `test` 脚本为 `npm run compile && node --test test`（Node 内置测试运行器，用例位于 `apps/test/`）。

## 既有资源声明（如有）

以下能力已存在，本次仅需复用/增强，不重复造轮子：

| 既有资源 | 位置 | 现状 | 本次处理 |
| --- | --- | --- | --- |
| `detectStructureFromWorkspace()` | `apps/src/services/projectStructureService.ts` | 已实现前端(Vue3/React)/后端(Java 单/多模块、Node)探测 | 复用（Req-3 无需新写探测） |
| `writePreviewStructure()` / `applyPreviewToRoot()` | 同上 | 已实现预览写入与应用 | 复用 + 空值防护校验 |
| `writeRootStructure()` / `readRootStructure()` | 同上 | 已幂等落盘 | 复用 |
| `ensureBaseline()` | 同上，行 100 | **仅 `custom > existing > default`，缺 `detected` 分支**，返回类型缺 `'detected'` | 核心改造点 |
| `handleInitProjectStructure()` / `handleApplyProjectStructurePreview()` | `apps/src/extension.ts` | 手动交互路径已实现预览/AI 审阅/应用 | 校验对齐需求，补空值/只读防护 |
| `ensureProjectStructureBaseline()` | `apps/src/extension.ts` 行 838 | 自动基线，仅调用 `ensureBaseline`，无 detected 提示 | 增强非阻塞提示 |

## 任务清单（严格按依赖顺序执行）

- [x] 1.1 契约对齐与来源枚举扩展
  - Owner: Backend
  - 输入: [docs/project-structure/design.md](docs/project-structure/design.md#31-api-契约)（API-1、MODEL-BaselineResult、INV-1）
  - 输出: `apps/src/services/projectStructureService.ts`（将 `ensureBaseline` 返回类型 `source` 扩展为 `'custom' | 'existing' | 'detected' | 'default'`）
  - 验收: 类型编译通过；调用方类型不报错；`source` 取值集合与设计一致
  - 追踪: Req-2 / INV-1

- [x] 1.2 `ensureBaseline` 插入 `detected` 分支
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#31-api-契约)（API-1、API-2、INV-2）
  - 输出: `apps/src/services/projectStructureService.ts`（在 `existing` 与 `default` 之间插入：调用 `detectStructureFromWorkspace()`，`detected=true` 时写正式文档 `source='detected'`）
  - 验收: 无 custom、正式文档不存在、探测成功时正式文档来源于探测内容，不落默认模板；单元测试覆盖
  - 追踪: Req-1(1) / Req-2(4) / INV-2

- [x] 1.3 detected 分支联动预览写入
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#31-api-契约)（API-3、Req-4 精修入口）
  - 输出: `apps/src/services/projectStructureService.ts`（detected 分支在写正式文档同时 `writePreviewStructure(content)` 供后续可选精修）
  - 验收: detected 命中后 `docs/project-structure.preview.md` 与正式文档均存在且内容一致
  - 追踪: Req-1(1) / Req-4(1)

- [x] 1.4 探测失败回退与容错确认
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#5-错误处理)（INV-7、API-2）
  - 输出: `apps/src/services/projectStructureService.ts`（确认 `detected=false` 时 `ensureBaseline` 落非空默认模板；核对探测内部单点读取失败已被 try/catch 吞掉不中断）
  - 验收: 空仓/无法识别仓库时正式文档为非空默认模板；构造读取异常目录时探测不抛出致命错误
  - 追踪: Req-2(3) / Req-5(2) / INV-7

- [x] 1.5 幂等落盘回归确认
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#4-正确性属性需求不变量)（INV-4、API-5）
  - 输出: `apps/src/services/projectStructureService.ts`（无需求变更则不改；补充幂等断言点）
  - 验收: 同仓库状态两次 `ensureBaseline` 内容与路径一致，无重复目录块；`existing` 分支不覆盖既有内容
  - 追踪: Req-6(1) / Req-6(2) / INV-4

- [x] 1.6 ✅ 检查点：核心服务层契约与来源链完成
  - Owner: Backend
  - 输入: 任务 1.1~1.5 产出
  - 输出: 阶段自检记录（编译通过 + 服务单测通过）
  - 验收: `custom>existing>detected>default` 唯一来源链在服务层可判定；`npm run compile` 通过
  - 追踪: Req-1 / Req-2 / Req-5 / Req-6

- [x] 2.1 自动基线时机接入 detected（编排）
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#23-路由设计)（API-6、Req-7(1)、INV-9）
  - 输出: `apps/src/extension.ts` `ensureProjectStructureBaseline()`（确认 monorepo `setMonorepoMainDir(repos/mono-main)` 后调用增强版 `ensureBaseline`；将结果 `source` 用于后续提示）
  - 验收: 可写工作区激活时，无 custom/无既有文档且探测成功 → 正式文档来源为 detected；monorepo 落盘位于 `repos/mono-main/docs`
  - 追踪: Req-1(3) / Req-7(1) / INV-9

- [x] 2.2 detected/default 非阻塞提示
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#33-组件-props--events)（Req-5(1)、Req-4(1)）
  - 输出: `apps/src/extension.ts`（`ensureProjectStructureBaseline` 根据 `source` 弹非阻塞 `showInformationMessage`：detected→提示已按真实结构生成并可精修/应用预览；default→提示已回退默认模板）
  - 验收: 两种来源分别出现对应非阻塞提示，且不打断激活主流程
  - 追踪: Req-4(1) / Req-5(1) / Req-7(1)

- [x] 2.3 只读窗口写保护确认
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#5-错误处理)（INV-3、Req-7(2)）
  - 输出: `apps/src/extension.ts`（核对 `ensureProjectStructureBaseline` / `handleInitProjectStructure` / `handleApplyProjectStructurePreview` 的 `configMeta.readOnly` 前置拦截完整）
  - 验收: `readOnly=true` 时三条路径均不写正式/预览文档
  - 追踪: Req-7(2) / INV-3

- [x] 2.4 ✅ 检查点：自动初始化时机接入完成
  - Owner: Backend
  - 输入: 任务 2.1~2.3 产出
  - 输出: 阶段自检记录
  - 验收: 激活→基线自动路径按真实目录生成且非阻塞、只读安全
  - 追踪: Req-1 / Req-7

- [x] 3.1 手动交互路径与需求对齐
  - Owner: FullStack
  - 输入: [design.md](docs/project-structure/design.md#31-api-契约)（API-7、Req-4(1)(3)）
  - 输出: `apps/src/extension.ts` `handleInitProjectStructure()`（核对：custom 直写；否则探测→写预览并打开→提供「立即应用预览 / 改用默认结构」选项）
  - 验收: 手动触发生成预览并展示可操作选项；「改用默认」写默认模板
  - 追踪: Req-4(1) / Req-4(3) / Req-7(3)

- [x] 3.2 应用预览空值/损坏防护
  - Owner: FullStack
  - 输入: [design.md](docs/project-structure/design.md#31-api-契约)（API-4、API-8、INV-6）
  - 输出: `apps/src/extension.ts` `handleApplyProjectStructurePreview()` + `applyPreviewToRoot()`（核对预览为空/不存在时返回 false、告警且不改正式文档）
  - 验收: 预览缺失/空内容时正式文档保持不变并出现可感知告警
  - 追踪: Req-4(2) / Req-4(4) / INV-6

- [x] 3.3 AI 二次审阅非阻塞确认
  - Owner: FullStack
  - 输入: [design.md](docs/project-structure/design.md#4-正确性属性需求不变量)（INV-8、Req-7(4)）
  - 输出: `apps/src/extension.ts`（核对非 `local` 模式 AI 审阅 try/catch 仅告警，不回滚已生成预览/正式文档）
  - 验收: 模拟 AI dispatch 失败时预览/正式文档保留，仅出现警告提示
  - 追踪: Req-7(4) / INV-8

- [x] 3.4 ✅ 检查点：交互路径对齐完成
  - Owner: FullStack
  - 输入: 任务 3.1~3.3 产出
  - 输出: 阶段自检记录
  - 验收: 预览→确认→应用→回退交互完整且健壮
  - 追踪: Req-4 / Req-7

- [x] 4.1 服务层单元测试
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#6-测试策略)；[requirements.md](docs/project-structure/requirements.md)（Req-1/2/3/5/6）
  - 输出: `apps/test/projectStructureService.test.ts`（node:test 用例：四来源分支、探测各技术栈夹具、detected 真实目录来源、失败回退、幂等、monorepo 落盘）
  - 验收: `npm run test` 中新增用例全部通过；覆盖 INV-1/2/4/5/7/9
  - 追踪: Req-1 / Req-2 / Req-3 / Req-5 / Req-6

- [x] 4.2 编排层测试
  - Owner: Backend
  - 输入: [design.md](docs/project-structure/design.md#6-测试策略)（INV-3、INV-8）
  - 输出: `apps/test/projectStructureBaseline.test.ts`（`ensureProjectStructureBaseline` 只读不写；手动路径 AI 失败不回滚的编排断言，必要时以最小 stub）
  - 验收: 只读与 AI 失败场景断言通过
  - 追踪: Req-7(2) / Req-7(4)

- [x] 4.3 ✅ 检查点：验证与回归完成
  - Owner: Backend
  - 输入: 任务 4.1~4.2 产出
  - 输出: `npm run compile` + `npm run test` 全绿记录
  - 验收: 全量编译与测试通过，既有 `existing`/monorepo 复制流程未回归
  - 追踪: Req-1 ~ Req-7

## 机器可读区

```yaml
artifactType: tasks
taskName: project-structure
taskSplitMode: standard
existingResources:
  - detectStructureFromWorkspace
  - writePreviewStructure
  - applyPreviewToRoot
  - writeRootStructure
  - readRootStructure
  - handleInitProjectStructure
  - handleApplyProjectStructurePreview
optionalInputs:
  testcaseDoc: missing
  testManifest: missing
tasks:
  - id: 1.1
    name: 契约对齐与来源枚举扩展
    owner: Backend
    dependsOn: []
    inputs: [docs/project-structure/design.md#31-api-契约]
    outputs: [apps/src/services/projectStructureService.ts]
    requirementIds: [Req-2]
  - id: 1.2
    name: ensureBaseline 插入 detected 分支
    owner: Backend
    dependsOn: [1.1]
    inputs: [docs/project-structure/design.md#31-api-契约]
    outputs: [apps/src/services/projectStructureService.ts]
    requirementIds: [Req-1, Req-2]
  - id: 1.3
    name: detected 分支联动预览写入
    owner: Backend
    dependsOn: [1.2]
    inputs: [docs/project-structure/design.md#31-api-契约]
    outputs: [apps/src/services/projectStructureService.ts]
    requirementIds: [Req-1, Req-4]
  - id: 1.4
    name: 探测失败回退与容错确认
    owner: Backend
    dependsOn: [1.2]
    inputs: [docs/project-structure/design.md#5-错误处理]
    outputs: [apps/src/services/projectStructureService.ts]
    requirementIds: [Req-2, Req-5]
  - id: 1.5
    name: 幂等落盘回归确认
    owner: Backend
    dependsOn: [1.2]
    inputs: [docs/project-structure/design.md#4-正确性属性需求不变量]
    outputs: [apps/src/services/projectStructureService.ts]
    requirementIds: [Req-6]
  - id: 1.6
    name: 检查点-核心服务层完成
    owner: Backend
    dependsOn: [1.1, 1.2, 1.3, 1.4, 1.5]
    inputs: []
    outputs: []
    requirementIds: [Req-1, Req-2, Req-5, Req-6]
    checkpoint: true
  - id: 2.1
    name: 自动基线时机接入 detected
    owner: Backend
    dependsOn: [1.6]
    inputs: [docs/project-structure/design.md#23-路由设计]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-1, Req-7]
  - id: 2.2
    name: detected/default 非阻塞提示
    owner: Backend
    dependsOn: [2.1]
    inputs: [docs/project-structure/design.md#33-组件-props--events]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-4, Req-5, Req-7]
  - id: 2.3
    name: 只读窗口写保护确认
    owner: Backend
    dependsOn: [2.1]
    inputs: [docs/project-structure/design.md#5-错误处理]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-7]
  - id: 2.4
    name: 检查点-自动初始化时机接入完成
    owner: Backend
    dependsOn: [2.1, 2.2, 2.3]
    inputs: []
    outputs: []
    requirementIds: [Req-1, Req-7]
    checkpoint: true
  - id: 3.1
    name: 手动交互路径与需求对齐
    owner: FullStack
    dependsOn: [1.6]
    inputs: [docs/project-structure/design.md#31-api-契约]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-4, Req-7]
  - id: 3.2
    name: 应用预览空值损坏防护
    owner: FullStack
    dependsOn: [3.1]
    inputs: [docs/project-structure/design.md#31-api-契约]
    outputs: [apps/src/extension.ts, apps/src/services/projectStructureService.ts]
    requirementIds: [Req-4]
  - id: 3.3
    name: AI 二次审阅非阻塞确认
    owner: FullStack
    dependsOn: [3.1]
    inputs: [docs/project-structure/design.md#4-正确性属性需求不变量]
    outputs: [apps/src/extension.ts]
    requirementIds: [Req-7]
  - id: 3.4
    name: 检查点-交互路径对齐完成
    owner: FullStack
    dependsOn: [3.1, 3.2, 3.3]
    inputs: []
    outputs: []
    requirementIds: [Req-4, Req-7]
    checkpoint: true
  - id: 4.1
    name: 服务层单元测试
    owner: Backend
    dependsOn: [1.6]
    inputs: [docs/project-structure/design.md#6-测试策略]
    outputs: [apps/test/projectStructureService.test.ts]
    requirementIds: [Req-1, Req-2, Req-3, Req-5, Req-6]
  - id: 4.2
    name: 编排层测试
    owner: Backend
    dependsOn: [2.4, 3.4]
    inputs: [docs/project-structure/design.md#6-测试策略]
    outputs: [apps/test/projectStructureBaseline.test.ts]
    requirementIds: [Req-7]
  - id: 4.3
    name: 检查点-验证与回归完成
    owner: Backend
    dependsOn: [4.1, 4.2]
    inputs: []
    outputs: []
    requirementIds: [Req-1, Req-2, Req-3, Req-4, Req-5, Req-6, Req-7]
    checkpoint: true
requirementCoverage:
  Req-1: [1.2, 1.3, 2.1, 4.1]
  Req-2: [1.1, 1.2, 1.4, 4.1]
  Req-3: [4.1]
  Req-4: [1.3, 2.2, 3.1, 3.2, 3.4]
  Req-5: [1.4, 2.2, 4.1]
  Req-6: [1.5, 4.1]
  Req-7: [2.1, 2.3, 3.1, 3.3, 4.2]
```
