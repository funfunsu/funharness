# AI 调用计量与本地过程任务

## 计量产物

每个迭代的 `.harness/process/ai-calls.jsonl` 保存调用明细，`ai-usage-summary.json` 在每次记录完成后重新汇总。记录包含唯一调用 ID、时间、阶段、任务、provider、逻辑会话 scope、尝试序号、Prompt 快照路径、输入字符/UTF-8 字节、按一级/二级标题分区的大小及耗时。汇总按阶段、任务和 provider 分组，并累加上下文分区大小。

- `dispatched`：仅说明请求已交给聊天面板或 CLI，不代表模型完成或任务验收成功。
- `prepared`：手工方式或降级到手工，只准备 Prompt，不能认为已产生模型用量。
- `completed`：同步润色返回或本地过程执行完成。
- `failed`：派发、润色或本地执行失败。

汇总区分 `aiCalls`、`dispatchCalls`、`localCalls` 和 `localCompleted`。字符/字节不等于 token；当前 provider 入口不返回账单用量，实际 token、缓存/推理用量和费用不可获取，因此 `usage=null`、`actualTokens=null`、`cost=null`。本地执行标记 `usageStatus=not-applicable`。耗时是派发返回/本地执行耗时，不是面板内 AI 完成耗时。逻辑 scope 不是 provider 的真实 session ID。尝试序号按同迭代、阶段、任务、provider、scope 的已记录调用递增，不能用于推算模型内部调用次数。

计量为尽力记录，落盘失败不阻断派发；汇总忽略损坏的 JSONL 行。记录不复制 Prompt 正文，正文沿用已有快照。润色走 CLI 或 LM API 时也记录调用，但 provider 内部工具读取和隐藏的模型请求仍不在统计范围内。

## 本地任务契约

缺省 `execution` 为 `ai`。只对确定性任务显式选择 `local`，不会根据任务名猜测或自动转换既有清单。

```markdown
- [ ] 2.1 编译与测试验证
  - Owner: FullStack
  - 执行方式: local
  - 本地操作: verify
  - 检查项: [compile, webview, tests]
  - 依赖: [1.1]
  - 输出: [.harness/process/verification-2.1.md]
  - 验收:
    - 固定检查全部退出码为 0
  - 追踪: [Req-1] + [INV-1]
```

相应机器区字段为 `execution: local`、`localAction: verify`、`checks: [compile, webview, tests]`。任务 ID 和依赖 ID 应使用引号，例如 `id: "2.1"`、`dependsOn: ["1.1"]`。Markdown 和 YAML 声明必须一致。

支持的操作：

| 操作 | 确定性行为 |
| --- | --- |
| `checkpoint` | 确认依赖完成，保存需求、设计、任务文档 SHA-256；不是审查或人工批准 |
| `traceability` | 从需求 YAML 生成需求与非 local 实现任务映射；未映射需求阻断，不执行语义覆盖评审 |
| `verify` | 顺序运行选定白名单检查并记录退出码与输出尾部 |

固定检查工具链：`compile` 执行 `npm run compile:guard`；`webview` 执行 `node scripts/validate-webview.js`；`tests` 执行 `node --test` 并枚举 `test/` 下的 `.test.js`。声明 tests 时，无论列表顺序如何均先执行一次 compile，防止测试读取旧编译产物。优先在迭代的 `apps/` 执行，否则使用迭代根目录。Windows 通过 PowerShell 初始化 fnm。每项检查最多运行五分钟，保留最多 16,000 字符输出。工具链不匹配的项目应保留 AI 任务或另行开发适配，不通过任务文本执行任意命令。

本地任务仅在可信工作区执行，输出必须位于 `.harness/process/` 且为 Markdown 文件，禁止父目录跳转和符号链接路径。所有依赖需完成、所有检查需成功；先写记录，再写 `signals/done-*`，由原调度器输出校验和批次边界决定继续。失败标记 `failed`，符合以下条件时进入有界自动修复，否则暂停。日志及调用记录保留原因，显式重试仍走本地执行。运行中的本地任务不能提前标记完成或重复派发。

## 本地验证自动修复

自动执行过程中，local verify 默认支持“本地验证失败 → AI 差量修复 → 本地重新验证”。Markdown 可用 `自动修复: false`，YAML 可用 `autoRepair: false` 关闭，两个声明必须一致。手工重试不会自行启动新的自动修复链；用户可在修复代码后重试本地检查。

当前允许触发的代码诊断包括 TypeScript `error TS...`、`SyntaxError`、`ERR_ASSERTION`/`AssertionError` 和 Node TAP 的 `not ok`。工具缺失、MODULE_NOT_FOUND、权限错误、命令不可用、检查超时、无测试文件以及不明失败不自动修复。checkpoint 和 traceability 失败也不会转成编码修复。

修复范围从验证任务直接及间接依赖的实现任务输出推导，不包含规范、过程状态、信号、编译产物、依赖清单或校验脚本；没有明确实现范围就暂停。修复 Prompt 要求只处理失败证据，不重做已完成任务，不放宽测试、不改验证命令。聊天 provider 执行代码修改不受文件系统沙箱强制限制，范围由 Prompt 约束；最终本地检查仍是通过依据。

每个未解决修复链最多派发两次；同一诊断在修复后再次出现会立即停止。每次请求保存到 `.harness/process/local-repair-<taskId>.json`，包括尝试数、诊断指纹、验证契约签名、修复范围及是否续跑。AI 必须在修复完成后写入唯一的 `signals/repair-<taskId>-<requestId>` JSON 信号，不得写 `done-*`。

只有请求 ID、任务 ID 和 `status: repaired` 匹配的信号才触发原检查重跑。修复信号或 AI 的通过声明都不能直接完成任务。重验成功后才写 done、标记完成并按原批次边界继续；重验失败仍走分类、去重和预算判断。

等待修复期间禁止重复派发、重试或提前完成。用户暂停会取消自动续跑；请求仍可结束并触发本地重验，但不会自动进入下游。重载后点击开始自动执行会恢复已有请求，不重复派发。验证契约改变、信号不匹配、派发异常、超出两轮或十分钟未收到有效信号时停止自动修复。手工 provider 不触发此链。新增修复调用以 `stage: local-repair` 进入调用计量。

中断在 verifying 状态时，重载后恢复原本地检查；持久化状态损坏则显式阻断，不重置修复预算。人工重试并验证成功后才能恢复。旧 verified 状态在再次检查开始时失效，旧报告、done 信号或手工完成标记不能绕过未通过的修复链。超时不会强制终止聊天 provider 中的 Agent，请确认其停止后再人工重试。

新规划默认使用 `compact`，实现、接线及局部测试按独立可验收行为合并；必要的独立确定性门禁使用 local。主观设计评审、领域判断及失败诊断仍需 AI 或人工，不得用快照任务替代。