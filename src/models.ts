export const BASE = '.harness';
/** Directory under the master workspace root where shared custom-button scripts live. */
export const CUSTOM_SCRIPT_DIR = 'script';
/** File written into each worktree holding the latest pulled remote-task content. */
export const TODO_FILE = 'todo.md';
/** Default pull-task script name (under <masterRoot>/script/). */
export const DEFAULT_POLL_SCRIPT = 'pullTask.js';
/**
 * Default prompt prepended to the pulled todo.md content when auto-poll dispatches to the AI
 * executor. The final query sent to the executor is `${autoPollPrompt}\n\n${todo.md content}`.
 */
export const DEFAULT_AUTO_POLL_PROMPT =
    '远程任务清单（todo.md）已更新，请阅读下面的任务清单并执行其中尚未完成的任务；每完成一项，请在 todo.md 对应条目上标注完成。若任务描述不充分，按最小可用实现推进，并在完成说明中标注所做假设。';
/**
 * Newline-separated markers that mean "no pending task". When a pull's whole trimmed output
 * (case-insensitively) equals any of these, it is treated exactly like an empty pull: todo.md is
 * not overwritten and the AI executor is NOT dispatched. Lets upstreams that print a human sentinel
 * (e.g. get_next_todo_task → "没有未完成的待办任务") avoid triggering a needless run.
 */
export const DEFAULT_AUTO_POLL_SKIP_MARKERS =
    '没有未完成的待办任务\n当前无待办任务\n无待办任务\n暂无待办任务\n没有新任务\nno pending tasks\nno tasks\nnull';
/**
 * Lock file under <masterRoot>/.harness/ used to enforce that auto-polling runs in
 * at most one worktree at a time, even across separate VS Code windows.
 */
export const AUTO_POLL_LOCK_FILE = 'auto-poll-lock.json';
/**
 * Unified per-task log file under <iterationDir>/.harness/. All subsystems (git, auto-poll,
 * AI dispatch, …) append here so each task has a single chronological log. Non-task operations
 * (e.g. repo init) fall back to the master root's copy.
 */
export const HARNESS_LOG_FILE = 'harness.log';
export const PROMPTS_DIR = 'prompts';
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
    /** The single baseline branch this iteration was created from and merges back into. */
    baseBranchUsed?: string;
    autoAdvanceEnabled?: boolean;
    autoRepairEnabled?: boolean;
    aiProvider?: string;
    /** When true, the task skips requirements/design/testcase/task-split and goes directly to DEVELOPING. */
    quickMode?: boolean;
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
    /**
     * Command that opens the provider's panel with a pre-filled prompt, invoked as
     * `executeCommand(cmd, sessionId, prompt)` (for 'panel' kind). Preferred over `openUriTemplate`
     * — passes the full prompt as an argument with no URI length/encoding limits.
     */
    panelPromptCommand?: string;
    /**
     * Deep-link URI that opens the provider's panel with a pre-filled prompt (for 'panel' kind).
     * `{prompt}` is replaced with the URI-encoded prompt. Used as a fallback when the command fails.
     */
    openUriTemplate?: string;
    /**
     * For 'panel' kind opened via `openUriTemplate`: the deep link pre-fills the prompt but does
     * not submit it. When true, after opening the URI we simulate pressing Return (macOS only,
     * via `osascript`/System Events) to auto-send. Gated by the user's `aiPanelAutoSubmit` config.
     */
    autoSubmit?: boolean;
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
        panelPromptCommand: 'claude-vscode.primaryEditor.open',
        openUriTemplate: 'vscode://anthropic.claude-code/open?prompt={prompt}',
        autoSubmit: true,
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

// ── Custom action buttons ──────────────────────────────────────────

/**
 * A user-defined button shown on task cards. Clicking it opens a terminal
 * whose cwd is the task's iteration worktree directory (optionally a `workdir`
 * subfolder such as `frontend`/`backend`) and runs `command` (e.g. `./deploy.sh`).
 */
export interface CustomButton {
    id: string;
    name: string;
    command: string;
    /**
     * Subfolder to run the script in (e.g. 'frontend' | 'backend'). Empty/undefined = root.
     * For 'iteration' buttons the root is the task's worktree dir; for 'main' buttons it is
     * the master workspace root.
     */
    workdir?: string;
    /**
     * Where the button is rendered:
     * - 'iteration' (default): on each task card (worktree subview always; main panel when an
     *   iteration worktree exists). Runs against that task's worktree iteration dir.
     * - 'main': in a dedicated area on the main panel that belongs to no task iteration. Runs
     *   against the master workspace root.
     */
    placement?: 'iteration' | 'main';
}

// ── Config ─────────────────────────────────────────────────────────

export interface Config {
    frontendGit: string;
    backendGit: string;
    /** The single configured baseline branch (e.g. main / yourname/integration). Iterations branch from it and merge back to it. */
    baseBranch: string;
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
    /** Auto-submit (press Return) after a 'panel' executor pre-fills its prompt via deep link (macOS only). */
    aiPanelAutoSubmit: boolean;
    worktreeSyncPaths: string;
    customProjectStructure: string;
    projectStructureRefineMode: 'local' | 'local+ai';
    /** User-defined buttons rendered on task cards (main panel + worktree subview). */
    customButtons: CustomButton[];
    /** Interval (seconds) between remote-task pulls when auto-polling is enabled in a worktree. */
    autoPollIntervalSec: number;
    /** Pull-task script file name, resolved under <masterRoot>/script/. */
    autoPollScript: string;
    /** Prompt prepended to the pulled todo.md content when auto-poll dispatches to the AI executor. */
    autoPollPrompt: string;
    /** Newline-separated "no pending task" markers; a matching pull is treated like an empty pull (no overwrite, no dispatch). */
    autoPollSkipMarkers: string;
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
    aiPanelAutoSubmit: true,
    worktreeSyncPaths: 'worktree/.github/instructions',
    customProjectStructure: '',
    projectStructureRefineMode: 'local+ai',
    customButtons: [],
    autoPollIntervalSec: 60,
    autoPollScript: DEFAULT_POLL_SCRIPT,
    autoPollPrompt: DEFAULT_AUTO_POLL_PROMPT,
    autoPollSkipMarkers: DEFAULT_AUTO_POLL_SKIP_MARKERS,
};
