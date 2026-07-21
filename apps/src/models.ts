import * as fs from 'fs';
import * as path from 'path';

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
    INITIALIZING: 'initializing',
    WRITING_REQUIREMENT: 'writing_requirement',
    WRITING_DESIGN: 'writing_design',
    WRITING_TESTCASE: 'writing_testcase',
    WRITING_TASKS: 'writing_tasks',
    DEVELOPING: 'developing',
    READY_FOR_REVIEW: 'ready_for_review',
    DONE: 'done'
} as const;

export type Stage = typeof STAGE[keyof typeof STAGE];

/** Display labels for stages — used only in UI rendering, never persisted. */
export const STAGE_LABEL: Record<Stage, string> = {
    [STAGE.INITIALIZING]: '⌛ 初始化中',
    [STAGE.WRITING_REQUIREMENT]: '📝 撰写需求',
    [STAGE.WRITING_DESIGN]: '📘 技术设计',
    [STAGE.WRITING_TESTCASE]: '🧪 测试用例',
    [STAGE.WRITING_TASKS]: '📋 任务拆解',
    [STAGE.DEVELOPING]: '⚙️ 开发中',
    [STAGE.READY_FOR_REVIEW]: '⏳ 待审核',
    [STAGE.DONE]: '✅ 已完成',
};

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
 * Where a custom button's script file physically lives. This decouples buttons from the
 * old single hardcoded `<masterRoot>/script/` dir so scripts can be co-located with code:
 * - 'master':   `<masterRoot>/script/` — shared, NOT committed to git (legacy default).
 * - 'worktree': the committed scripts dir inside THIS task's iteration worktree (per-iteration).
 *               For 'main'-placement buttons (no worktree) this falls back to the main clone.
 *
 * The legacy 'repo' source has been folded into 'worktree' (committed scripts are the same set);
 * old configs are migrated to 'worktree' on load.
 */
export type CustomButtonScriptSource = 'master' | 'worktree';

/**
 * A user-defined button shown on task cards or the main panel. Clicking it opens a terminal
 * whose cwd is the task's worktree iteration dir (iteration buttons) or the master workspace
 * root (main buttons), then runs the resolved script. The script itself is responsible for
 * navigating to any subdirectory it needs (e.g. `cd frontend`).
 */
export interface CustomButton {
    id: string;
    name: string;
    /** Where the script file lives. Defaults to 'master' for legacy/undefined buttons. */
    scriptSource?: CustomButtonScriptSource;
    /** Script file name (no path), resolved against the scriptSource directory. */
    script?: string;
    /** Optional extra CLI arguments appended after the script invocation. */
    args?: string;
    /**
     * @deprecated Legacy single-field form `"<scriptFile> [args]"` resolved under
     * `<masterRoot>/script/`. Retained only so old configs migrate to `script`/`args` on load.
     */
    command?: string;
    /**
     * Where the button is rendered:
     * - 'iteration' (default): on each task card (worktree subview always; main panel when an
     *   iteration worktree exists). Runs against that task's worktree iteration dir.
     * - 'main': in a dedicated area on the main panel that belongs to no task iteration. Runs
     *   against the master workspace root.
     */
    placement?: 'iteration' | 'main';
}

/**
 * Inventory of discovered scripts per source, built on the extension side and handed to the
 * settings webview so each button row can offer OS-appropriate scripts in a dropdown.
 */
export interface ScriptInventory {
    mode: 'mono' | 'multi';
    /** Committed scripts subfolder name (from monorepoDirs.scripts). */
    scriptsSubdir: string;
    /** Scripts under `<masterRoot>/script/`. */
    master: string[];
    /** Committed scripts under `repos/mono-main/<scriptsSubdir>/` (monorepo mode). */
    repoMono: string[];
    /** Committed scripts under `repos/frontend-main/<scriptsSubdir>/` (multi-repo mode). */
    repoFrontend: string[];
    /** Committed scripts under `repos/backend-main/<scriptsSubdir>/` (multi-repo mode). */
    repoBackend: string[];
    /** Absolute directories backing each list (for "open dir" and hints). */
    dirs: {
        master: string;
        repoMono?: string;
        repoFrontend?: string;
        repoBackend?: string;
    };
}

/** True when a file name is a runnable script for the CURRENT OS (plus cross-platform .js). */
export function isOsScriptFile(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower.endsWith('.js')) {
        return true;
    }
    if (process.platform === 'win32') {
        return lower.endsWith('.ps1') || lower.endsWith('.bat') || lower.endsWith('.cmd');
    }
    return lower.endsWith('.sh') || lower.endsWith('.bash');
}

/**
 * Normalize a possibly-legacy custom button into the {scriptSource, script, args} form.
 * Legacy buttons carrying only `command` become 'master'-source buttons.
 */
export function normalizeCustomButton(b: CustomButton): CustomButton {
    const source: CustomButtonScriptSource =
        b.scriptSource === 'worktree' || (b.scriptSource as string) === 'repo' ? 'worktree' : 'master';
    let script = (b.script || '').trim();
    let args = (b.args || '').trim();
    if (!script && b.command) {
        const command = b.command.trim();
        const firstSpace = command.search(/\s/);
        script = (firstSpace === -1 ? command : command.slice(0, firstSpace)).replace(/^\.\//, '');
        args = firstSpace === -1 ? '' : command.slice(firstSpace).trim();
    }
    return {
        id: b.id,
        name: b.name,
        scriptSource: source,
        script,
        args,
        placement: b.placement === 'main' ? 'main' : 'iteration',
    };
}

// ── Config ─────────────────────────────────────────────────────────

export interface Config {
    frontendGit: string;
    backendGit: string;
    /**
     * Single-repository (monorepo) remote URL. When non-empty, the harness operates in monorepo
     * mode: it clones ONE repo whose iteration worktree is the iteration dir root, and
     * `frontendGit`/`backendGit` are ignored. Empty = multi-repo (separate frontend/backend) mode.
     */
    monorepoGit: string;
    /**
     * Subfolder names inside a monorepo checkout, used for "open folder" navigation and structure
     * detection only (NOT injected into AI prompts). Empty values fall back to the defaults.
     */
    monorepoDirs: {
        frontend: string;
        backend: string;
        docs: string;
        scripts: string;
    };
    /** The single configured baseline branch (e.g. main / yourname/integration). Iterations branch from it and merge back to it. */
    baseBranch: string;
    mergeDryRunEnabled: boolean;
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
    /** Master toggle for auto-poll config. When off, the detailed settings are collapsed. */
    autoPollEnabled: boolean;
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
    { key: 'req', name: '需求生成 Agent', file: 'requirements_custom_prompt.md' },
    { key: 'des', name: '技术设计 Agent', file: 'design_custom_prompt.md' },
    { key: 'tcs', name: '测试用例 Agent', file: 'testcase_custom_prompt.md' },
    { key: 'tsk', name: '任务拆解 Agent', file: 'tasks_custom_prompt.md' },
    { key: 'dev', name: '全栈开发 Agent', file: 'dev_custom_prompt.md' }
];

export const DEFAULT_MONOREPO_DIRS = {
    frontend: 'apps',
    backend: 'apps',
    docs: 'docs',
    scripts: 'scripts',
} as const;

/** The committed scripts subfolder name used by the 'worktree' button source. */
export function getScriptsSubdir(config: Pick<Config, 'monorepoDirs'>): string {
    const value = (config.monorepoDirs?.scripts || '').trim();
    return value || DEFAULT_MONOREPO_DIRS.scripts;
}

type SpecDocsConfig = Pick<Config, 'monorepoGit' | 'monorepoDirs'> | undefined;

/** Whether the harness operates in single-repository (monorepo) mode. */
export function isMonoMode(config: Pick<Config, 'monorepoGit'> | undefined): boolean {
    return Boolean(config?.monorepoGit?.trim());
}

/** The docs root folder name under the iteration root ('docs' in multi mode, monorepoDirs.docs in mono mode). */
export function getDocsRootDirName(config: SpecDocsConfig): string {
    if (isMonoMode(config)) {
        return (config?.monorepoDirs?.docs || '').trim() || DEFAULT_MONOREPO_DIRS.docs;
    }
    return 'docs';
}

/**
 * Relative path segments (from the iteration root) to the folder holding per-iteration spec
 * docs (requirements/design/testcase/tasks). In monorepo mode these live under a task-named
 * subfolder (docs/<task>/) so that merging the iteration branch back into the shared repo does
 * not collide with other iterations' docs; in multi-repo mode they stay directly under docs/.
 * The task-name subfolder is derived from the iteration directory's own name (worktrees/<task>).
 */
export function getSpecDocsRelSegments(iterDir: string, config: SpecDocsConfig): string[] {
    const root = getDocsRootDirName(config);
    if (isMonoMode(config)) {
        return [root, path.basename(iterDir)];
    }
    return [root];
}

/** Absolute directory holding per-iteration spec docs. */
export function getSpecDocsDir(iterDir: string, config: SpecDocsConfig): string {
    return path.join(iterDir, ...getSpecDocsRelSegments(iterDir, config));
}

/** Canonical absolute path to a per-iteration spec file (e.g. requirements.md). Use for write targets. */
export function getSpecFile(iterDir: string, config: SpecDocsConfig, fileName: string): string {
    return path.join(getSpecDocsDir(iterDir, config), fileName);
}

/** Canonical relative (from iterDir) path to a spec file, using OS separators. */
export function getSpecFileRel(iterDir: string, config: SpecDocsConfig, fileName: string): string {
    return path.join(...getSpecDocsRelSegments(iterDir, config), fileName);
}

/**
 * Resolve an existing spec file for reads/detection: prefer the canonical (mode-aware) location,
 * then fall back to the legacy flat location at the docs root (docs/<file>) for iterations created
 * before the task-named subfolder was introduced. Returns the canonical path when none exist.
 */
export function resolveSpecFile(iterDir: string, config: SpecDocsConfig, fileName: string): string {
    const canonical = getSpecFile(iterDir, config, fileName);
    if (fs.existsSync(canonical)) {
        return canonical;
    }
    // In monorepo mode, docs/<task>/ is the canonical and only supported location.
    // Do not fall back to docs/<file> because many repositories keep project-level
    // documents there and they are not iteration artifacts.
    if (isMonoMode(config)) {
        return canonical;
    }
    const legacyFlat = path.join(iterDir, getDocsRootDirName(config), fileName);
    if (legacyFlat !== canonical && fs.existsSync(legacyFlat)) {
        return legacyFlat;
    }
    return canonical;
}

/**
 * Resolve the tasks plan file, preferring the mode-aware canonical location, then falling back to
 * the legacy flat docs-root location (docs/tasks.md) and the very-legacy doc/task.md. Returns the
 * canonical path when none exist (for write targets).
 */
export function resolveTaskPlanFileForIteration(iterDir: string, config: SpecDocsConfig): string {
    const canonical = getSpecFile(iterDir, config, 'tasks.md');
    if (isMonoMode(config)) {
        return canonical;
    }
    const legacyFlat = path.join(iterDir, ...TASK_PLAN_PRIMARY_REL_PATH.split('/'));
    const legacyOld = path.join(iterDir, ...TASK_PLAN_LEGACY_REL_PATH.split('/'));
    for (const candidate of [canonical, legacyFlat, legacyOld]) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return canonical;
}

export const DEFAULT_CONFIG: Config = {
    frontendGit: '',
    backendGit: '',
    monorepoGit: '',
    monorepoDirs: { ...DEFAULT_MONOREPO_DIRS },
    baseBranch: '',
    mergeDryRunEnabled: true,
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
    autoPollEnabled: false,
    autoPollIntervalSec: 60,
    autoPollScript: DEFAULT_POLL_SCRIPT,
    autoPollPrompt: DEFAULT_AUTO_POLL_PROMPT,
    autoPollSkipMarkers: DEFAULT_AUTO_POLL_SKIP_MARKERS,
};
