# 智能迭代 Multi-Agent 使用说明

本项目采用多智能体（Multi-Agent）协作开发模式，核心包括 Orchestrator、Frontend、Backend、QA 等 Agent，自动驱动需求、设计、任务拆分、开发、测试与交付流程。

## 目录结构
- `.agents/`：各 Agent 的系统提示与工作流规则
- `docs/iterations/<version_name>/`：每次迭代的需求、设计、任务、QA报告等
- `ui-of-intelligent-risk-control/`：前端源代码与 README
- `risk-management-center-core/`：后端源代码

## 工作流简述
1. **Orchestrator Agent**：负责流程编排，按 State Machine 指导用户/Agent逐步完成需求、设计、任务拆分、开发、测试。
2. **Frontend Agent**：自动扫描任务，按设计与需求实现前端功能，严格更新路由与菜单，完成后主动交接 QA Agent。
3. **QA Agent**：自动发现“Ready for QA”任务，生成并执行测试，验证 Mock 注册、Store/API集成、边界条件，输出 QA 报告并更新任务状态。

## 使用方法
1. 启动 Orchestrator Agent，指定当前迭代版本（如 `v1.0-whitelist`），所有文档存于 `docs/iterations/<version_name>/`。
2. 按 Orchestrator 指令依次唤醒 Requirements、Design、Task Planning、Frontend、Backend、QA Agent。
3. 各 Agent 按自身 prompt 自动执行任务、更新状态、交接下一 Agent。
4. QA Agent 验证通过后，所有任务状态变为 Done。

## 关键规则
- 所有任务、文档、代码均需严格按迭代目录与 Owner 分配。
- Agent 间交接需显式 [Handover] 标记。
- QA Agent 必须验证 Mock 注册、Store/API集成、边界条件。
- Frontend Agent 必须同步更新路由与菜单。

## 前端启动
详见 `ui-of-intelligent-risk-control/README.md`，推荐用 `start.ps1` 或 `npm run dev`。

## 典型流程示例
1. Orchestrator Agent："请指定当前迭代版本名"
2. Requirements Agent：生成 `docs/requirements.md`
3. Design Agent：生成 `docs/design.md`
4. Task Planning Agent：生成 `doc/task.md`（历史迭代兼容 `docs/tasks.md`）
5. Frontend/Backend Agent：自动执行任务，更新状态
6. QA Agent：自动测试，输出 QA 报告，更新任务为 Done

---
如需详细 Agent prompt 或工作流规则，请参考 `.agents/` 目录下各 Agent 的说明。

## Orchestrator Agent 唤起示例
迭代起点建议使用如下提示词：

```
@workspace Read .agents/orchestrator-agent.prompt.md
请启动你的 Core Workflow，当前迭代为 v1.0-whitelist
```

请将 <version_name> 替换为实际迭代名（如 v1.0-whitelist），以确保所有文档与任务归档到正确目录。
