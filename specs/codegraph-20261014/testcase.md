# 测试用例文档

## 概述

本用例集覆盖 CodeGraph 在主流程接入、补偿初始化、配置治理、证据注入与降级回退的关键行为，并与现有自动化回归脚本保持一致。

## 用例清单

### TC-CG-001 首次真实创建触发一致性

- requirementIds: Req-1
- 前置条件：任务可通过 openFolder 与 customButton 两入口触发 worktree 初始化。
- GIVEN 用户分别通过 `openFolderLocationByFeatureId` 与 `runCustomButtonByFeatureId` 触发首次真实创建，WHEN 初始化完成，THEN 两入口都必须触发同一 CodeGraph 初始化编排，并带各自 entryPoint。

### TC-CG-002 已存在 .codegraph 的重开行为

- requirementIds: Req-1, Req-4
- 前置条件：worktree 已存在且目录下已有 `.codegraph`。
- GIVEN 用户通过 openFolder 打开该 worktree，WHEN 打开流程继续，THEN 不应再次触发初始化编排，且主流程保持可继续。

### TC-CG-003 手动同步前置补偿初始化

- requirementIds: Req-1, Req-4
- 前置条件：任务已存在 worktree，但 `.codegraph` 缺失。
- GIVEN 用户点击 `syncCodeGraphByFeatureId`，WHEN 同步启动，THEN 系统必须先触发一次补偿初始化；若初始化后仍缺失 `.codegraph`，则告警并终止同步。

### TC-CG-004 CLI 自动安装失败的非阻断策略

- requirementIds: Req-3, Req-4
- 前置条件：运行环境缺少 codegraph CLI，且自动安装策略开启。
- GIVEN 编排器执行初始化，WHEN 自动安装失败，THEN 返回 warning，写入过程记录，且不抛出阻断主流程的异常。

### TC-CG-005 已初始化场景的去重与快照刷新

- requirementIds: Req-4
- 前置条件：worktree 下已存在 `.codegraph`。
- GIVEN 编排器执行 runOnce，WHEN 检测到已初始化，THEN 状态应为 deduped，并刷新证据快照，且不调用安装/构建分支。

### TC-CG-006 五阶段证据注入

- requirementIds: Req-5
- 前置条件：证据提供器返回 usable=true 且含 anchors/seams/impactSet。
- GIVEN 阶段分别为 req/des/tcs/tsk/dev，WHEN 渲染阶段 Prompt，THEN 每个阶段都应注入 `CodeGraph 证据注入`区块，包含锚点、接缝与影响集。

### TC-CG-007 stale/missing 降级回退

- requirementIds: Req-5
- 前置条件：证据提供器返回 freshness=stale 或 missing。
- GIVEN 渲染阶段 Prompt，WHEN 注入证据区块，THEN 必须包含 usable=false 与 downgradePolicy 告警语义，且明确禁止“未查询到节点=不存在业务关系”的否定性推断。

### TC-CG-008 配置默认值与联动归一化

- requirementIds: Req-2
- 前置条件：存在缺省配置与保存后重载场景。
- GIVEN 首次加载缺省配置，WHEN 读取配置，THEN `autoCodeGraphEnabled` 与 `autoInstallEnabled` 默认为 true。
- GIVEN 保存关闭 `autoCodeGraphEnabled`，WHEN 重载配置，THEN `autoInstallEnabled` 需与其同向为 false；重新开启后同向恢复为 true。

## 执行记录

- 自动化测试：`apps/test/harnessActionsDomainPreflight.test.js`
- 自动化测试：`apps/test/domainKnowledgeFlow.test.js`
- 自动化测试：`apps/test/codeGraphInstallProbe.test.js`
- 自动化测试：`apps/test/promptService.test.js`
- 回归门禁：`npm run test`

## 机器可读区

```yaml
artifactType: testcase
taskName: CodeGraph
testCases:
  - id: TC-CG-001
    requirementIds: [Req-1]
    title: 首次真实创建触发一致性
    type: integration
    automated: true
    script: apps/test/harnessActionsDomainPreflight.test.js
  - id: TC-CG-002
    requirementIds: [Req-1, Req-4]
    title: 已存在 .codegraph 的重开行为
    type: integration
    automated: true
    script: apps/test/harnessActionsDomainPreflight.test.js
  - id: TC-CG-003
    requirementIds: [Req-1, Req-4]
    title: 手动同步前置补偿初始化
    type: integration
    automated: true
    script: apps/test/harnessActionsDomainPreflight.test.js
  - id: TC-CG-004
    requirementIds: [Req-3, Req-4]
    title: CLI 自动安装失败的非阻断策略
    type: integration
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-CG-005
    requirementIds: [Req-4]
    title: 已初始化场景的去重与快照刷新
    type: integration
    automated: true
    script: apps/test/domainKnowledgeFlow.test.js
  - id: TC-CG-006
    requirementIds: [Req-5]
    title: 五阶段证据注入
    type: contract
    automated: true
    script: apps/test/promptService.test.js
  - id: TC-CG-007
    requirementIds: [Req-5]
    title: stale 或 missing 的降级回退
    type: contract
    automated: true
    script: apps/test/promptService.test.js
  - id: TC-CG-008
    requirementIds: [Req-2]
    title: 配置默认值与联动归一化
    type: contract
    automated: true
    script: apps/test/featureStoreService.test.js
```