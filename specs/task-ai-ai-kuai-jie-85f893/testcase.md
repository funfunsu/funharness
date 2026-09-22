# 测试用例文档

## 概述

本用例集覆盖“AI 快捷对话”能力（Req-1~Req-5）与后续新增的「镜像仓库地址推送」能力（Req-6，`Config.githubMirrorGit`）。

## 用例清单

### TC-AQC-001 按钮配置的增删改与保存校验

- requirementIds: Req-1
- GIVEN 保存请求包含空白或超长的名称/内容 WHEN 执行 `saveAiQuickChatButtons` THEN 保存被拒绝并返回字段级校验错误。
- 自动化脚本：`apps/test/featureStoreService.test.js`

### TC-AQC-002 配置持久化与其他字段隔离

- requirementIds: Req-2
- GIVEN 已存在其他配置字段 WHEN 保存 `aiQuickChatButtons` THEN 其余既有字段（含 `customButtons`）值保持不变，且写入结果为独立字段。
- 自动化脚本：`apps/test/featureStoreService.test.js`（`saveAiQuickChatButtons preserves other config values and writes field as a standalone list`）

### TC-AQC-003 主从快照同步一致

- requirementIds: Req-2, Req-5
- GIVEN 主窗口保存了按钮配置 WHEN 同步到 worktree 快照 THEN 快照配置中的 `aiQuickChatButtons` 与主窗口一致。
- 自动化脚本：`apps/test/featureStoreService.test.js`（`syncAiQuickChatButtonsToWorktrees writes valid rows into existing worktree snapshot configs`）、`apps/test/workspaceRoot.test.js`

### TC-AQC-004 旁路操作区渲染与无效过滤

- requirementIds: Req-3
- GIVEN 存在有效与无效混合按钮配置 WHEN 渲染任务卡片 THEN 仅有效按钮显示且与自定义按钮并列复用相同样式容器；GIVEN 未配置任何按钮 WHEN 渲染 THEN 不输出按钮节点。
- 自动化脚本：`apps/test/reviewStageInjection.test.js`

### TC-AQC-005 点击按钮逐字符派发到当前会话

- requirementIds: Req-4
- GIVEN 按钮内容含换行与 Unicode WHEN 点击触发 `runAiQuickChatButton` THEN 派发给 AI 的 `query` 与保存内容逐字符一致，且 `source` 标记为 `quick-chat-button`。
- 自动化脚本：`apps/test/harnessActionsDomainPreflight.test.js`（`AI 快捷对话按钮按原文内容派发且使用 quick-chat-button 源`）、`apps/test/harnessActionsFinalGate.test.js`、`apps/test/aiDispatchService.test.js`

### TC-AQC-006 快照窗口只读拒绝保存

- requirementIds: Req-5
- GIVEN 当前窗口为主窗口配置快照 WHEN 尝试保存 AI 快捷对话按钮配置 THEN 保存被拒绝并给出与自定义按钮一致的只读提示，配置不被写入。
- 自动化脚本：`apps/test/harnessActionsFinalGate.test.js`

### TC-AQC-007 镜像仓库地址持久化且不影响其他 Git 字段

- requirementIds: Req-6
- GIVEN 用户在 Git 配置区填写 `githubMirrorGit` 并保存 WHEN `saveGit` 执行完成 THEN 该字段被 `trim()` 后随现有 Git 配置一并持久化，其余 Git 字段（`frontendGit`/`backendGit`/`baseBranch`/`mergeDryRunEnabled` 等）值不受影响。

### TC-AQC-008 推送基线分支时尽力镜像推送

- requirementIds: Req-6
- GIVEN 已配置 `githubMirrorGit` WHEN 主远端（origin）push 已确认成功 THEN `gitService.pushToMirror` 尝试复用同 URL 的现有远端或新建 `mirror` 远端后执行 `git push`。
- GIVEN 镜像远端配置或 push 失败 WHEN 该失败发生 THEN 仅记录 git 日志，不影响或回滚已完成的主远端 push 结果，也不抛出未捕获异常。

### TC-AQC-009 未配置镜像地址时不执行镜像逻辑

- requirementIds: Req-6
- GIVEN `githubMirrorGit` 为空或未填写 WHEN 执行基线分支 push THEN `pushToMirror` 直接返回，不新建或修改任何远端。

## 执行记录

- 参考自动化测试：`apps/test/featureStoreService.test.js`、`apps/test/harnessActionsDomainPreflight.test.js`、`apps/test/harnessActionsFinalGate.test.js`、`apps/test/reviewStageInjection.test.js`、`apps/test/workspaceRoot.test.js`、`apps/test/aiDispatchService.test.js`
- 说明：TC-AQC-007~009（镜像仓库推送）当前以代码走查与手动验证为主，暂无独立自动化测试脚本覆盖 `gitService.pushToMirror`，后续如补充自动化用例需回填 `script` 字段。
- 回归门禁：`npm test`

## 机器可读区

```yaml
artifactType: testcase
taskName: AI快捷对话
testCases:
  - id: TC-AQC-001
    requirementIds: [Req-1]
    title: 按钮配置的增删改与保存校验
    type: contract
    automated: true
    script: apps/test/featureStoreService.test.js
  - id: TC-AQC-002
    requirementIds: [Req-2]
    title: 配置持久化与其他字段隔离
    type: contract
    automated: true
    script: apps/test/featureStoreService.test.js
  - id: TC-AQC-003
    requirementIds: [Req-2, Req-5]
    title: 主从快照同步一致
    type: contract
    automated: true
    script: apps/test/featureStoreService.test.js
  - id: TC-AQC-004
    requirementIds: [Req-3]
    title: 旁路操作区渲染与无效过滤
    type: render
    automated: true
    script: apps/test/reviewStageInjection.test.js
  - id: TC-AQC-005
    requirementIds: [Req-4]
    title: 点击按钮逐字符派发到当前会话
    type: contract
    automated: true
    script: apps/test/harnessActionsDomainPreflight.test.js
  - id: TC-AQC-006
    requirementIds: [Req-5]
    title: 快照窗口只读拒绝保存
    type: contract
    automated: true
    script: apps/test/harnessActionsFinalGate.test.js
  - id: TC-AQC-007
    requirementIds: [Req-6]
    title: 镜像仓库地址持久化且不影响其他 Git 字段
    type: contract
    automated: false
    script: null
  - id: TC-AQC-008
    requirementIds: [Req-6]
    title: 推送基线分支时尽力镜像推送
    type: contract
    automated: false
    script: null
  - id: TC-AQC-009
    requirementIds: [Req-6]
    title: 未配置镜像地址时不执行镜像逻辑
    type: contract
    automated: false
    script: null
```
