# 最小测试任务集执行记录（Task 6.1）

- taskId: 6.1
- taskName: 构建最小测试任务集（按需求逻辑）并执行自检
- stage: Self-check
- workspace: c:/Users/cnu07hws/funHarness/worktrees/better-project-structure
- executionMode: compiled-output node self-check

## 执行范围
- TS-1（Req-1）样例注入测试
- TS-2（Req-2）颗粒度边界测试
- TS-3（Req-3）提示词契约完整性测试
- TS-4（Req-4）门禁阻断测试
- TS-5（Req-5）追溯闭环测试

## 执行说明
- 自检直接基于 `apps/out/` 已编译产物执行，避免新增测试基建。
- 由于当前迭代未提供可选 `testcase.md`，TS-5 使用内联 synthetic testcase machine block 覆盖 Req-1 ~ Req-5。
- 由于当前迭代未提供显式样例文件，TS-1 使用 `root-structure` 回退样例源验证样例块注入与三段式组装行为。

## 执行命令
```powershell
@'
const fs = require('fs');
const path = require('path');
const root = path.resolve('..');
const appsRoot = process.cwd();
const { ProjectStructureService } = require('./out/services/projectStructureService');
const { PromptService } = require('./out/services/promptService');
const { buildTraceMatrixSnapshot } = require('./out/specTrace');
// ...省略中间构造，实际执行已覆盖 TS-1 ~ TS-5
'@ | node
```

## 检查项与结果
1. TS-1 样例注入测试（Req-1）
- 结果：通过
- 依据：提示词组装结果包含 `Sample Standard`、样例 `id` 与 `Sample Exemplar`；样例源为 `root-structure` 回退链路。

2. TS-2 颗粒度边界测试（Req-2）
- 结果：通过
- 依据：`concise` 颗粒度规则集成功加载，`maxDepth=3`，`mustExpandDomains` 包含 `src`，`collapsePatterns` 包含 `node_modules`；检测输出未出现 `node_modules/` 噪声节点。

3. TS-3 提示词契约完整性测试（Req-3）
- 结果：通过
- 依据：提示词结果稳定包含 `Rule Constraints`、`Output Contract`，并保留 `requiredFields: title, sections, domainNodes` 与 `requiredSections: 项目结构树, 关键模块说明`。

4. TS-4 门禁阻断测试（Req-4）
- 结果：通过
- 依据：有效结构样例返回 `gateStatus=passed`；缺失字段结构返回 `gateStatus=failed`，且 violations 中包含 `SG-REQ-SECTION`、`SG-REQ-FIELD`，并带有 `location` 与 `suggestion`。

5. TS-5 追溯闭环测试（Req-5）
- 结果：通过
- 依据：`buildTraceMatrixSnapshot` 基于 requirements / design / tasks / synthetic testcase 生成 `traceMatrixCount=5`，`orphanChanges=[]`，全部需求均具备 design/task/test 映射。

## 自检结果摘要
```json
{
  "ts1": true,
  "ts2": true,
  "ts3": true,
  "ts4": true,
  "ts5": true,
  "details": {
    "sampleProfileSource": "root-structure",
    "sampleProfileId": "default",
    "granularityProfileId": "concise",
    "traceMatrixCount": 5,
    "orphanChanges": [],
    "detectedSummary": "未检测到前后端项目，已回退默认结构"
  }
}
```

## 结论
- 最小测试任务集已完成执行，TS-1 ~ TS-5 全部通过。
- 当前能力满足进入 6.2 阶段完成评审所需的最小可验证证据。
