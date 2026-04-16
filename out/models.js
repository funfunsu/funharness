"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.PROMPT_CONFIGS = exports.STAGE = exports.HARNESS_STATE_FILE_LEGACY = exports.HARNESS_STATE_FILE = exports.TASK_PLAN_LEGACY_REL_PATH = exports.TASK_PLAN_PRIMARY_REL_PATH = exports.AGENT_DIR = exports.PROMPTS_DIR = exports.BASE = void 0;
exports.BASE = '.harness';
exports.PROMPTS_DIR = 'prompts';
exports.AGENT_DIR = '.github/agents';
exports.TASK_PLAN_PRIMARY_REL_PATH = 'docs/tasks.md';
exports.TASK_PLAN_LEGACY_REL_PATH = 'doc/task.md';
exports.HARNESS_STATE_FILE = 'iteration-state.json';
exports.HARNESS_STATE_FILE_LEGACY = 'tasks.json';
exports.STAGE = {
    INITIALIZING: '⌛ 初始化中',
    WRITING_REQUIREMENT: '📝 撰写需求',
    WRITING_DESIGN: '📘 技术设计',
    WRITING_TESTCASE: '🧪 测试用例',
    WRITING_TASKS: '📋 任务拆解',
    DEVELOPING: '⚙️ 开发中',
    READY_FOR_REVIEW: '⏳ 待审核',
    DONE: '✅ 已完成'
};
exports.PROMPT_CONFIGS = [
    { key: 'req', name: '需求生成 Agent', file: 'requirements_agent.md' },
    { key: 'des', name: '技术设计 Agent', file: 'design_agent.md' },
    { key: 'tcs', name: '测试用例 Agent', file: 'testcase_agent.md' },
    { key: 'tsk', name: '任务拆解 Agent', file: 'tasks_agent.md' },
    { key: 'dev', name: '全栈开发 Agent', file: 'dev_agent.md' }
];
exports.DEFAULT_CONFIG = {
    frontendGit: '',
    backendGit: '',
    mergeTargetBranch: '',
    baseSyncBranch: '',
    mergeDryRunEnabled: true,
    backendStartCmd: '',
    backendPort: 8080,
    frontendStartCmd: '',
    techStack: '',
    codingStandards: '',
    maxConcurrentAutoTasks: 2,
    autoAdvanceEnabled: false,
    autoRepairEnabled: false,
    autoContinueAfterManualDone: true,
    compactTaskDecomposition: false,
    autoDetectTaskSplitMode: true,
    simpleTaskKeywords: 'blacklist,whitelist,crud,toggle,config,list,search,管理,增删改查,配置,名单',
    complexTaskKeywords: 'workflow,state machine,multi-tenant,distributed,transaction,integration,migration,权限,审批,多角色,并发,分布式,跨系统,联调,多模块,复杂',
    aiProvider: 'copilot-chat',
    claudeCliCommandTemplate: '',
    aiFallbackToManual: true,
    worktreeSyncPaths: 'worktree/.github/instructions',
};
//# sourceMappingURL=models.js.map