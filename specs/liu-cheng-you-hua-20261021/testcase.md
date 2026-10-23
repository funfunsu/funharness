# 测试用例文档

## 概述
本用例集对齐“流程优化”已落地实现，覆盖领域沉淀双门禁、Git 配置契约变更、CodeGraph 初始化判定收敛。

## 用例清单

### TC-LCYH-001 开发推进前可写领域沉淀门禁成功路径
- requirementIds: Req-1
- 前置条件：任务阶段为 DEVELOPING。
- GIVEN 用户执行推进评审，WHEN `runDomainSedimentationWritable` 返回 `passed=true`，THEN 系统允许执行提交流程。
- 自动化映射：`apps/test/harnessActionsFinalGate.test.js`

### TC-LCYH-002 开发推进前可写领域沉淀门禁失败阻断
- requirementIds: Req-1
- 前置条件：任务阶段为 DEVELOPING。
- GIVEN 用户执行推进评审，WHEN `runDomainSedimentationWritable` 返回 `passed=false`，THEN 系统必须阻断提交且阶段保持 DEVELOPING。
- 自动化映射：`apps/test/harnessActionsFinalGate.test.js`

### TC-LCYH-003 完成前只读领域复核成功路径
- requirementIds: Req-2
- 前置条件：任务阶段为 READY_FOR_REVIEW。
- GIVEN 用户执行完成动作，WHEN `verifyDomainSedimentationReadOnly` 返回 `passed=true`，THEN 系统允许执行清理并进入 DONE。
- 自动化映射：`apps/test/harnessActionsFinalGate.test.js`

### TC-LCYH-004 完成前只读领域复核失败阻断
- requirementIds: Req-2
- 前置条件：任务阶段为 READY_FOR_REVIEW。
- GIVEN 用户执行完成动作，WHEN `verifyDomainSedimentationReadOnly` 返回 `passed=false`，THEN 系统必须阻断完成且阶段保持 READY_FOR_REVIEW。
- 自动化映射：`apps/test/harnessActionsFinalGate.test.js`

### TC-LCYH-005 saveGit 消息优先读取 mr 并兼容 gmg
- requirementIds: Req-3
- 前置条件：Webview 可发送 `saveGit` 消息。
- GIVEN 消息同时或分别携带 `mr/gmg`，WHEN 控制器转发保存，THEN 系统必须按 `mr ?? gmg` 解析镜像远端。
- 自动化映射：`apps/src/harnessMessageController.ts`（契约路径）

### TC-LCYH-006 无 Monorepo 地址时 descriptor 为空
- requirementIds: Req-3
- 前置条件：`monorepoGit` 为空。
- GIVEN 解析仓库描述符，WHEN 执行 `resolveRepoDescriptors`，THEN 结果必须为空并进入 Monorepo 必填失败提示分支。
- 自动化映射：`apps/test/gitSettingsSingleRepo.test.js`

### TC-LCYH-007 CodeGraph 已初始化判定要求真实状态
- requirementIds: Req-4
- 前置条件：工作目录存在 `.codegraph`。
- GIVEN 仅存在占位目录无真实数据库，WHEN 判定初始化状态，THEN 不得视为已初始化。
- GIVEN 存在 `.codegraph/codegraph.db`，WHEN 判定初始化状态，THEN 视为可用并避免重复初始化。
- 自动化映射：`apps/test/harnessActionsDomainPreflight.test.js`

## 机器可读区
```yaml
artifactType: testcase
taskName: 流程优化
testCases:
  - id: TC-LCYH-001
    requirementIds: [Req-1]
    title: 开发推进前可写领域沉淀门禁成功路径
    type: integration
    automated: true
    script: apps/test/harnessActionsFinalGate.test.js
  - id: TC-LCYH-002
    requirementIds: [Req-1]
    title: 开发推进前可写领域沉淀门禁失败阻断
    type: integration
    automated: true
    script: apps/test/harnessActionsFinalGate.test.js
  - id: TC-LCYH-003
    requirementIds: [Req-2]
    title: 完成前只读领域复核成功路径
    type: integration
    automated: true
    script: apps/test/harnessActionsFinalGate.test.js
  - id: TC-LCYH-004
    requirementIds: [Req-2]
    title: 完成前只读领域复核失败阻断
    type: integration
    automated: true
    script: apps/test/harnessActionsFinalGate.test.js
  - id: TC-LCYH-005
    requirementIds: [Req-3]
    title: saveGit 消息优先读取 mr 并兼容 gmg
    type: contract
    automated: false
    script: apps/src/harnessMessageController.ts
  - id: TC-LCYH-006
    requirementIds: [Req-3]
    title: 无 Monorepo 地址时 descriptor 为空
    type: unit
    automated: true
    script: apps/test/gitSettingsSingleRepo.test.js
  - id: TC-LCYH-007
    requirementIds: [Req-4]
    title: CodeGraph 已初始化判定要求真实状态
    type: unit
    automated: true
    script: apps/test/harnessActionsDomainPreflight.test.js
```