## 应用 repos/mono-main/apps（VS Code 扩展）

# VS Code 扩展（TypeScript）
repos/mono-main/apps/
├── media/           # 静态资源与图标
├── scripts/         # 构建与校验脚本
├── src/             # 扩展源码
│   ├── services/        # 业务服务层
│   ├── extension.ts         # 扩展入口与主类
│   ├── harnessMessageController.ts  # Webview 消息路由
│   ├── harnessMessages.ts       # 消息协议定义
│   ├── masterArtifactWatcher.ts # 迭代产物回同步
│   ├── models.ts            # 常量类型与纯函数
│   ├── schedulerRegistry.ts     # 调度器实例管理
│   ├── taskScheduler.ts         # 单任务阶段调度
│   ├── webviewTemplates.ts      # 页面 HTML 生成
│   └── workspaceRoot.ts         # 工作区根解析
└── system-prompts/  # 各阶段 Agent 提示词
