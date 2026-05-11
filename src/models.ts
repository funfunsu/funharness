export const BASE = '.harness';
export const PROMPTS_DIR = 'prompts';
export const AGENT_DIR = '.github/agents';
export const TASK_PLAN_PRIMARY_REL_PATH = 'docs/tasks.md';
export const TASK_PLAN_LEGACY_REL_PATH = 'doc/task.md';
export const HARNESS_STATE_FILE = 'iteration-state.json';
export const HARNESS_STATE_FILE_LEGACY = 'tasks.json';

export const STAGE = {
    INITIALIZING: '⌛ 初始化中',
    WRITING_REQUIREMENT: '📝 撰写需求',
    WRITING_DESIGN: '📘 技术设计',
    WRITING_TESTCASE: '🧪 测试用例',
    WRITING_TASKS: '📋 任务拆解',
    DEVELOPING: '⚙️ 开发中',
    READY_FOR_REVIEW: '⏳ 待审核',
    DONE: '✅ 已完成'
} as const;

export type Stage = typeof STAGE[keyof typeof STAGE];

export interface PromptConfig {
    key: string;
    name: string;
    file: string;
}

export interface Task {
    id: string;
    name: string;
    desc: string;
    taskSplitMode?: 'standard' | 'compact';
    stage: Stage;
    worktreePath?: string;
    iterationBranch?: string;
    baseBranchUsed?: string;
    /** @deprecated Use baseBranchUsed */
    mergeTargetBranchUsed?: string;
    /** @deprecated Use baseBranchUsed */
    baseSyncBranchUsed?: string;
    autoAdvanceEnabled?: boolean;
    autoRepairEnabled?: boolean;
    aiProvider?: string;
}

// ── AI Provider Registry ───────────────────────────────────────────

export type AiProviderKind = 'vscode-chat' | 'panel' | 'cli' | 'manual';

export interface AiProviderDefinition {
    id: string;
    label: string;
    kind: AiProviderKind;
    chatCommand?: string;
    /** Command to open the provider's own panel (for 'panel' kind) */
    panelCommand?: string;
    defaultCliTemplate?: string;
    detectHint?: string;
}

export const AI_PROVIDERS: AiProviderDefinition[] = [
    {
        id: 'copilot-chat',
        label: 'GitHub Copilot',
        kind: 'vscode-chat',
        chatCommand: 'workbench.action.chat.open',
        detectHint: 'workbench.action.chat.open',
    },
    {
        id: 'claude-code',
        label: 'Claude Code (面板)',
        kind: 'panel',
        panelCommand: 'claude-vscode.sidebar.open',
        detectHint: 'claude-vscode.sidebar.open',
    },
    {
        id: 'claude-code-cli',
        label: 'Claude Code (CLI 终端)',
        kind: 'cli',
        detectHint: 'claude --version',
    },
    {
        id: 'trae',
        label: 'Trae AI',
        kind: 'vscode-chat',
        chatCommand: 'workbench.action.chat.open',
        detectHint: 'workbench.action.chat.open',
    },
    {
        id: 'qodo',
        label: 'Qodo Gen',
        kind: 'vscode-chat',
        chatCommand: 'workbench.action.chat.open',
        detectHint: 'workbench.action.chat.open',
    },
    {
        id: 'manual',
        label: '手工模式（仅生成提示词）',
        kind: 'manual',
    },
];

export type AiProviderId = typeof AI_PROVIDERS[number]['id'];

export function getAiProvider(id: string): AiProviderDefinition {
    return AI_PROVIDERS.find(p => p.id === id) || AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

// ── Config ─────────────────────────────────────────────────────────

export interface Config {
    frontendGit: string;
    backendGit: string;
    baseBranch: string;
    /** @deprecated Use baseBranch */
    mergeTargetBranch?: string;
    /** @deprecated Use baseBranch */
    baseSyncBranch?: string;
    mergeDryRunEnabled: boolean;
    backendStartCmd: string;
    backendPort: number;
    frontendStartCmd: string;
    startupChainMode: 'light' | 'full';
    javaRuntimeProfile: string;
    frontendStartupTemplate: string;
    backendStartupTemplate: string;
    techStack: string;
    codingStandards: string;
    projectConventions: string;
    maxConcurrentAutoTasks: number;
    autoAdvanceEnabled: boolean;
    autoRepairEnabled: boolean;
    autoContinueAfterManualDone: boolean;
    compactTaskDecomposition: boolean;
    autoDetectTaskSplitMode: boolean;
    simpleTaskKeywords: string;
    complexTaskKeywords: string;
    aiProvider: string;
    cliCommandTemplate: string;
    /** @deprecated Use cliCommandTemplate instead */
    claudeCliCommandTemplate?: string;
    aiFallbackToManual: boolean;
    worktreeSyncPaths: string;
    customProjectStructure: string;
    projectStructureRefineMode: 'local' | 'local+ai';
}

export interface TaskStats {
    total: number;
    todo: number;
    doing: number;
    done: number;
    failed: number;
}

export interface SubTask {
    id: string;
    name: string;
    owner: string;
    depends: string[];
    input: string;
    output: string[];
    acceptance: string[];
    requirementIds: string[];
    propertyIds: string[];
    status: 'todo' | 'doing' | 'done' | 'failed';
    rawLine: string;
}

export const PROMPT_CONFIGS: PromptConfig[] = [
    { key: 'req', name: '需求生成 Agent', file: 'requirements_agent.md' },
    { key: 'des', name: '技术设计 Agent', file: 'design_agent.md' },
    { key: 'tcs', name: '测试用例 Agent', file: 'testcase_agent.md' },
    { key: 'tsk', name: '任务拆解 Agent', file: 'tasks_agent.md' },
    { key: 'dev', name: '全栈开发 Agent', file: 'dev_agent.md' }
];

export const DEFAULT_CONFIG: Config = {
    frontendGit: '',
    backendGit: '',
    baseBranch: '',
    mergeDryRunEnabled: true,
    backendStartCmd: '',
    backendPort: 8080,
    frontendStartCmd: '',
    startupChainMode: 'full',
    javaRuntimeProfile: 'dev',
    frontendStartupTemplate: '{install} && {run}',
    backendStartupTemplate: '{install} && {offline} && {clean} && {run}',
    techStack: '',
    codingStandards: '',
    projectConventions: '',
    maxConcurrentAutoTasks: 2,
    autoAdvanceEnabled: false,
    autoRepairEnabled: false,
    autoContinueAfterManualDone: true,
    compactTaskDecomposition: false,
    autoDetectTaskSplitMode: true,
    simpleTaskKeywords: 'blacklist,whitelist,crud,toggle,config,list,search,管理,增删改查,配置,名单',
    complexTaskKeywords: 'workflow,state machine,multi-tenant,distributed,transaction,integration,migration,权限,审批,多角色,并发,分布式,跨系统,联调,多模块,复杂',
    aiProvider: 'copilot-chat',
    cliCommandTemplate: '',
    aiFallbackToManual: true,
    worktreeSyncPaths: 'worktree/.github/instructions',
    customProjectStructure: '',
    projectStructureRefineMode: 'local+ai',
};
