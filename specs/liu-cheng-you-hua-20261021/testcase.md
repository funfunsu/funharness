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

### TC-LCYH-005 saveGit 消息优先读取 mr 并兼容 gmg（mg 可缺省）
- requirementIds: Req-3
- 前置条件：Webview 可发送 `saveGit` 消息。
- GIVEN 消息同时或分别携带 `mr/gmg`，WHEN 控制器转发保存，THEN 系统必须按 `mr ?? gmg` 解析镜像远端。
- GIVEN 消息未携带 `mg` 或 `mg` 为空，WHEN 扩展侧执行保存，THEN 系统必须进入 Monorepo 必填失败分支并阻断初始化。
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

### TC-LCYH-008 syncMainMonoRepo 消息路由到主仓同步动作
- requirementIds: Req-5
- 前置条件：主面板可触发“更新 mono-main”。
- GIVEN 用户触发该按钮，WHEN Webview 发送消息，THEN 控制器必须接收 `syncMainMonoRepo` 并调用 `HarnessActionsService.syncMainMonoRepo`。
- 自动化映射：`apps/src/harnessMessageController.ts`（契约路径）

### TC-LCYH-009 mono-main 同步执行 Monorepo 必填校验
- requirementIds: Req-5
- 前置条件：调用 `GitService.syncMainMonoRepo`。
- GIVEN 未配置 `monorepoGit`，WHEN 执行同步，THEN 返回失败并提示“仅支持 Monorepo”。
- GIVEN 已配置 `monorepoGit` 且主仓可达，WHEN 执行同步，THEN 返回成功并包含“本地 mono-main 已更新”。
- 自动化映射：`apps/src/services/gitService.ts`（行为路径）

### TC-LCYH-010 双门禁使用当前迭代领域上下文
- requirementIds: Req-1, Req-2
- 前置条件：迭代工作区与 mono-main 的注册表、草稿内容不同。
- GIVEN 用户分别推进评审和执行完成，WHEN 加载领域上下文，THEN 两个门禁均以 `resolveDomainBaselineRepoRoot(getIterationDir(task))` 为根，使用当前迭代目录名加载草稿；`domain-gate` 日志可核对 repoRoot、registry 和 changeSet 路径，不读取 mono-main 领域上下文。
- 验证方式：待自动化；通过门禁调用跟踪与日志检查验证，现有最终门禁测试将门禁方法整体替换，未覆盖该内部路径。

### TC-LCYH-011 可写门禁自动重基后仍检查冲突
- requirementIds: Req-1
- 前置条件：草稿基线版本与当前上下文版本不同。
- GIVEN 用户推进评审，WHEN 可写门禁检测到版本漂移，THEN 按刷新重投影、保存草稿、重新加载上下文的顺序执行，将 latestBaselineVersion 和 latestRevisions 写入对应草稿字段并保留其余字段，记录重基前后版本后再投影和检测冲突。
- GIVEN 重基后仍有阻断冲突，WHEN 检测完成，THEN 不调用领域提交或远程提交；无阻断且领域提交成功才允许后续提交。
- 验证方式：待自动化；检查 `runDomainSedimentationWritable` 的调用顺序与草稿落盘，聚合服务单测仅覆盖刷新重投影组件，不代表完整门禁覆盖。

### TC-LCYH-012 只读复核允许保存重基草稿但不提交基线
- requirementIds: Req-2
- 前置条件：任务阶段为 READY_FOR_REVIEW，草稿与上下文基线版本不同。
- GIVEN 用户执行完成动作，WHEN 只读门禁检测到漂移，THEN 刷新重投影、保存最新版本和修订集并重新加载后执行投影及冲突检测，允许种子初始化、草稿与日志写入，但不得调用 commitChangeSet 或 commitDomainBaseline。
- GIVEN 重基后仍有阻断冲突，WHEN 复核返回，THEN 阻断清理且不进入 DONE。
- 验证方式：待自动化；跟踪 `verifyDomainSedimentationReadOnly` 调用和文件变化。

### TC-LCYH-013 归一化版本相同时不触发自动重基
- requirementIds: Req-1, Req-2
- 前置条件：分别运行两类门禁，覆盖版本完全相同、仅首尾空白不同、缺省与空字符串的组合。
- GIVEN 草稿与上下文版本经缺省为空及 trim 后相同，WHEN 门禁比较版本，THEN 不调用 refreshBaselineAndReproject 或 saveDraftChangeSet，直接执行后续投影和冲突检测。
- 验证方式：待自动化；检查两类门禁的调用次数。

### TC-LCYH-014 自动重基异常阻断阶段推进
- requirementIds: Req-1, Req-2
- 前置条件：分别在刷新重投影、保存草稿、重新加载上下文时注入异常。
- GIVEN 用户推进评审或执行完成，WHEN 自动重基过程发生异常，THEN 门禁返回 passed=false 和错误摘要，分别阻断远程提交或清理完结，不推进任务阶段。
- 验证方式：待自动化；对两类门禁逐项注入异常并检查返回值及后续动作。

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
    title: saveGit 消息优先读取 mr 并兼容 gmg（mg 可缺省）
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
  - id: TC-LCYH-008
    requirementIds: [Req-5]
    title: syncMainMonoRepo 消息路由到主仓同步动作
    type: contract
    automated: false
    script: apps/src/harnessMessageController.ts
  - id: TC-LCYH-009
    requirementIds: [Req-5]
    title: mono-main 同步执行 Monorepo 必填校验
    type: contract
    automated: false
    script: apps/src/services/gitService.ts
  - id: TC-LCYH-010
    requirementIds: [Req-1, Req-2]
    title: 双门禁使用当前迭代领域上下文
    type: integration
    automated: false
  - id: TC-LCYH-011
    requirementIds: [Req-1]
    title: 可写门禁自动重基后仍检查冲突
    type: integration
    automated: false
  - id: TC-LCYH-012
    requirementIds: [Req-2]
    title: 只读复核允许保存重基草稿但不提交基线
    type: integration
    automated: false
  - id: TC-LCYH-013
    requirementIds: [Req-1, Req-2]
    title: 归一化版本相同时不触发自动重基
    type: unit
    automated: false
  - id: TC-LCYH-014
    requirementIds: [Req-1, Req-2]
    title: 自动重基异常阻断阶段推进
    type: integration
    automated: false
```