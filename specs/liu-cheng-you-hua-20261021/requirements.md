# 需求文档
## 简介
本迭代聚焦“流程优化”落地后的行为收敛，目标是将开发到完成阶段的门禁、Git 配置输入契约与 CodeGraph 初始化判定与当前实现保持一致。

## 需求清单
### Req-1：开发阶段推进评审前必须通过可写领域沉淀门禁
**用户故事：** 作为迭代负责人，我希望在开发阶段点击推进时先完成一次可写领域沉淀，以确保领域基线与迭代增量已落盘后再进入提交流程。
#### 验收标准
1. GIVEN 任务处于 DEVELOPING 阶段，WHEN 用户执行推进评审，THEN 系统必须先执行 `runDomainSedimentationWritable`。
2. GIVEN 可写领域沉淀返回 `passed=false`，WHEN 推进评审流程继续，THEN 系统必须阻断提交，不得调用提交远程分支流程。
3. GIVEN 可写领域沉淀返回 `passed=true`，WHEN 推进评审流程继续，THEN 系统才允许执行后续提交与阶段推进。

### Req-2：完成阶段前必须通过只读领域复核门禁
**用户故事：** 作为审核人员，我希望任务进入完成前再做一次只读领域复核，以避免未解决冲突或不一致进入 DONE。
#### 验收标准
1. GIVEN 任务处于 READY_FOR_REVIEW 且用户执行完成动作，WHEN 流程开始，THEN 系统必须执行 `verifyDomainSedimentationReadOnly`。
2. GIVEN 只读复核返回 `passed=false`，WHEN 完成流程继续，THEN 系统必须阻断清理与完结动作，任务阶段保持不变（不得进入 DONE）。
3. GIVEN 只读复核返回 `passed=true`，WHEN 完成流程继续，THEN 系统才允许执行后续清理并将任务置为 DONE。

### Req-3：Git 设置消息与存储契约统一为 Monorepo + mirrorRemotes
**用户故事：** 作为配置维护者，我希望 Git 设置只承认 Monorepo 主仓库并支持镜像远端列表，减少多仓分歧与旧字段混用。
#### 验收标准
1. GIVEN Webview 提交 Git 配置，WHEN 发送 `saveGit` 消息，THEN 消息体必须支持 `mr` 字段（镜像远端），并兼容读取旧字段 `gmg`。
2. GIVEN 用户保存 Git 配置，WHEN 扩展落盘配置，THEN 必须以 `mirrorRemotes` 作为镜像远端主字段，不再持续写回 `githubMirrorGit`。
3. GIVEN `monorepoGit` 为空，WHEN 执行 Git 初始化或提交相关流程，THEN 系统必须按“仅支持 Monorepo”规则返回失败提示。

### Req-4：CodeGraph 已初始化判定必须基于真实状态而非目录存在
**用户故事：** 作为开发者，我希望系统判断 CodeGraph 是否可用时基于真实初始化状态，避免仅有占位目录导致误判。
#### 验收标准
1. GIVEN 触发 CodeGraph 同步或启动补偿检查，WHEN 判定是否已初始化，THEN 系统必须通过 `isCodeGraphInitialized` 进行判定。
2. GIVEN `.codegraph` 目录存在但缺失有效数据库状态，WHEN 执行初始化判定，THEN 系统不得判定为已初始化。
3. GIVEN 判定为未初始化，WHEN 用户执行同步操作，THEN 系统必须先尝试初始化；初始化后仍未就绪则必须告警并终止同步。

## 机器可读区
```yaml
artifactType: requirements
taskName: 流程优化
requirements:
  - id: Req-1
    title: 开发阶段推进评审前必须通过可写领域沉淀门禁
    userStory: 作为迭代负责人，我希望在开发阶段点击推进时先完成一次可写领域沉淀，以确保领域基线与迭代增量已落盘后再进入提交流程。
    acceptanceCriteria:
      - GIVEN 任务处于 DEVELOPING 阶段 WHEN 用户执行推进评审 THEN 系统必须先执行 runDomainSedimentationWritable
      - GIVEN 可写领域沉淀返回 passed=false WHEN 推进评审流程继续 THEN 系统必须阻断提交且不得调用提交远程分支流程
      - GIVEN 可写领域沉淀返回 passed=true WHEN 推进评审流程继续 THEN 系统才允许执行后续提交与阶段推进
  - id: Req-2
    title: 完成阶段前必须通过只读领域复核门禁
    userStory: 作为审核人员，我希望任务进入完成前再做一次只读领域复核，以避免未解决冲突或不一致进入 DONE。
    acceptanceCriteria:
      - GIVEN 任务处于 READY_FOR_REVIEW 且用户执行完成动作 WHEN 流程开始 THEN 系统必须执行 verifyDomainSedimentationReadOnly
      - GIVEN 只读复核返回 passed=false WHEN 完成流程继续 THEN 系统必须阻断清理与完结动作且任务不得进入 DONE
      - GIVEN 只读复核返回 passed=true WHEN 完成流程继续 THEN 系统才允许执行后续清理并将任务置为 DONE
  - id: Req-3
    title: Git 设置消息与存储契约统一为 Monorepo + mirrorRemotes
    userStory: 作为配置维护者，我希望 Git 设置只承认 Monorepo 主仓库并支持镜像远端列表，减少多仓分歧与旧字段混用。
    acceptanceCriteria:
      - GIVEN Webview 提交 Git 配置 WHEN 发送 saveGit 消息 THEN 消息体必须支持 mr 字段并兼容旧字段 gmg
      - GIVEN 用户保存 Git 配置 WHEN 扩展落盘配置 THEN 必须以 mirrorRemotes 作为镜像远端主字段并避免持续写回 githubMirrorGit
      - GIVEN monorepoGit 为空 WHEN 执行 Git 初始化或提交相关流程 THEN 系统必须按仅支持 Monorepo 规则返回失败提示
  - id: Req-4
    title: CodeGraph 已初始化判定必须基于真实状态而非目录存在
    userStory: 作为开发者，我希望系统判断 CodeGraph 是否可用时基于真实初始化状态，避免仅有占位目录导致误判。
    acceptanceCriteria:
      - GIVEN 触发 CodeGraph 同步或启动补偿检查 WHEN 判定是否已初始化 THEN 系统必须通过 isCodeGraphInitialized 进行判定
      - GIVEN .codegraph 目录存在但缺失有效数据库状态 WHEN 执行初始化判定 THEN 系统不得判定为已初始化
      - GIVEN 判定为未初始化 WHEN 用户执行同步操作 THEN 系统必须先尝试初始化且失败时告警并终止同步
```