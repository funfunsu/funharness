# 提取链路契约稳定性检查记录（Task 3.3）

- taskId: 3.3
- taskName: [Checkpoint] 提取链路契约稳定性检查
- stage: Checkpoint
- workspace: c:/Users/cnu07hws/funHarness/worktrees/better-project-structure

## 检查范围
- 任务 2.1 产出：颗粒度规则集映射（maxDepth / mustExpandDomains / collapsePatterns）
- 任务 2.2 产出：目录归并与关键域展开、规则冲突阻断
- 任务 3.1 产出：提示词三段式组装（样例标准/规则约束/输出契约）
- 任务 3.2 产出：契约缺失阻断（PROMPT_CONTRACT_INCOMPLETE）
- 对照约束：Req-2, Req-3；INV-2, INV-3

## 检查项与结果
1. 颗粒度规则字段稳定性（Req-2 / INV-2）
- 结果：通过
- 依据：提取输入包含 `granularityRuleSet`，且规则块固定输出 `id`、`maxDepth`、`mustExpandDomains`、`collapsePatterns`、`dedupeStrategy`，字段名与设计约定一致。

2. 规则冲突显式失败（Req-2 / INV-2）
- 结果：通过
- 依据：存在 `GRANULARITY_RULE_CONFLICT` 错误分支；规则冲突时阻断提取流程，不进入伪成功路径。

3. 三段式提示词契约完整性（Req-3 / INV-3）
- 结果：通过
- 依据：样例驱动模式下，组装内容固定包含 `Sample Standard`、`Rule Constraints`、`Output Contract` 三块，满足“三者缺一不可”。

4. 输出契约字段稳定性（Req-3）
- 结果：通过
- 依据：输出契约显式要求 `requiredFields: title, sections, domainNodes` 与 `requiredSections: 项目结构树, 关键模块说明`，未破坏既有约定字段。

5. 契约缺失阻断链路（Req-3 / INV-3）
- 结果：通过
- 依据：任一契约块缺失时抛出 `PROMPT_CONTRACT_INCOMPLETE`，并由消息链路回传“已阻断 AI 请求”的告警。

6. 提取链路端到端可执行性（Req-2, Req-3）
- 结果：通过
- 依据：初始化结构流程中，先构建 extractionInput（样例+规则），再组装三段式提示词，随后触发 AI 调度；在契约完整时链路可继续执行。

## 结论
- 本次检查确认：契约字段命名保持稳定，Req-2 与 Req-3 对应不变量 INV-2、INV-3 在当前链路内可被满足。
- 后续可进入 4.x 质量门禁实现阶段。
