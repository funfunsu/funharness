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
/** Git-tracked specs directory name used for shared constitution/custom prompts. */
export const TRACKED_SPECS_DIR = 'specs';
export const FEATURE_PLAN_PRIMARY_REL_PATH = 'docs/tasks.md';
export const FEATURE_PLAN_LEGACY_REL_PATH = 'doc/task.md';
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

export interface DevRollbackSnapshot {
    createdAt: string;
    /** Task plan path relative to the iteration directory. */
    taskPlanRelPath: string;
    /** Full tasks.md content captured when entering developing stage. */
    taskPlanContent: string;
    /** Per-repository HEAD commit captured when entering developing stage. */
    repoHeadByKind?: Partial<Record<'frontend' | 'backend' | 'mono', string>>;
}

export interface Feature {
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
    /** Transient UI override: allow one explicit manual stage rollback to persist across snapshot sync. */
    allowStageRegressionOnce?: boolean;
    /** Development-stage rollback checkpoint captured right after task decomposition confirmation. */
    devRollbackSnapshot?: DevRollbackSnapshot;
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

// ── Lifecycle hooks ───────────────────────────────────────────────

/**
 * A single lifecycle hook entry. Format mirrors CustomButton script fields so
 * existing scripts can be reused without learning a new configuration schema.
 */
export interface HookEntry {
    /** Script file name (no path), resolved against the scriptSource directory. */
    script: string;
    /**
     * Where the script file lives.
     * - 'master' (default): `<masterRoot>/script/` — shared, not committed to git.
     * - 'worktree': committed scripts dir inside the task's iteration worktree.
     */
    scriptSource?: CustomButtonScriptSource;
    /** Optional extra CLI arguments appended after the script invocation. */
    args?: string;
}

/**
 * Container for per-lifecycle-node hook lists.
 * New hook nodes should be added here as optional arrays.
 */
export interface LifecycleHooks {
    /** Scripts executed after a Worktree is first initialised (code checkout complete). */
    worktreeOpen: HookEntry[];
}

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
     * Where the button is rendered: 'iteration' (default) — on each task card (worktree subview
     * always; main panel when an iteration worktree exists). Runs against that task's worktree
     * iteration dir.
     */
    placement?: 'iteration';
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

/** API-1: A single AI quick-chat button configured by the user. */
export interface AiQuickChatButton {
    id: string;
    label: string;
    content: string;
    order: number;
}

/** API-2: Unsaved UI input for a single AI quick-chat button row. */
export interface AiQuickChatButtonInput {
    label: string;
    content: string;
}

/** API-3: Persisted AI quick-chat button shape written to the harness config file. */
export interface PersistedAiQuickChatButton extends AiQuickChatButton {
}

export const AI_QUICK_CHAT_LABEL_MAX_LENGTH = 64;
export const AI_QUICK_CHAT_CONTENT_MAX_LENGTH = 4000;

/** API-4: Validation issue emitted when a quick-chat button fails the blank/length rules. */
export interface AiQuickChatValidationIssue {
    index: number;
    field: 'label' | 'content';
    code: 'blank' | 'too_long';
    limit?: number;
}

/** API-5: Context needed to resolve the current session when dispatching a quick-chat prompt. */
export interface AiQuickChatDispatchContext {
    taskId: string;
    iterationDir: string;
    provider: string;
}

/** Result returned when persisting a full quick-chat button set. */
export type AiQuickChatButtonsSaveResult =
    | { ok: true; buttons: AiQuickChatButton[] }
    | { ok: false; validationErrors: AiQuickChatValidationIssue[] };

/** Normalize one quick-chat button while preserving the user-entered label/content text. */
export function normalizeAiQuickChatButton(
    button: Partial<AiQuickChatButtonInput & PersistedAiQuickChatButton> | null | undefined,
    index: number,
): AiQuickChatButton {
    const rawId = typeof button?.id === 'string' ? button.id.trim() : '';
    const label = typeof button?.label === 'string' ? button.label : '';
    const content = typeof button?.content === 'string' ? button.content : '';
    return {
        id: rawId || `aqc_${index}`,
        label,
        content,
        order: index,
    };
}

/** Normalize a quick-chat button list into a stable persisted order. */
export function normalizeAiQuickChatButtons(
    buttons: readonly (Partial<AiQuickChatButtonInput & PersistedAiQuickChatButton> | null | undefined)[],
): AiQuickChatButton[] {
    return Array.isArray(buttons)
        ? buttons.map((button, index) => normalizeAiQuickChatButton(button, index))
        : [];
}

/** Check whether a normalized quick-chat button satisfies the blank/length rules. */
export function isAiQuickChatButtonValid(button: Pick<AiQuickChatButton, 'label' | 'content'>): boolean {
    const trimmedLabel = (button.label || '').trim();
    const trimmedContent = (button.content || '').trim();
    return trimmedLabel.length >= 1
        && trimmedLabel.length <= AI_QUICK_CHAT_LABEL_MAX_LENGTH
        && trimmedContent.length >= 1
        && trimmedContent.length <= AI_QUICK_CHAT_CONTENT_MAX_LENGTH;
}

/** Collect field-level validation issues for a quick-chat button list. */
export function validateAiQuickChatButtons(
    buttons: readonly (Partial<AiQuickChatButtonInput & PersistedAiQuickChatButton> | null | undefined)[],
): AiQuickChatValidationIssue[] {
    return normalizeAiQuickChatButtons(buttons).flatMap((button, index) => {
        const issues: AiQuickChatValidationIssue[] = [];
        const trimmedLabel = button.label.trim();
        const trimmedContent = button.content.trim();

        if (!trimmedLabel) {
            issues.push({ index, field: 'label', code: 'blank' });
        } else if (trimmedLabel.length > AI_QUICK_CHAT_LABEL_MAX_LENGTH) {
            issues.push({ index, field: 'label', code: 'too_long', limit: AI_QUICK_CHAT_LABEL_MAX_LENGTH });
        }

        if (!trimmedContent) {
            issues.push({ index, field: 'content', code: 'blank' });
        } else if (trimmedContent.length > AI_QUICK_CHAT_CONTENT_MAX_LENGTH) {
            issues.push({ index, field: 'content', code: 'too_long', limit: AI_QUICK_CHAT_CONTENT_MAX_LENGTH });
        }

        return issues;
    });
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
        placement: 'iteration',
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
    /** Development conversation scope mode: one session per batch (1.x/2.x) or one session for all subtasks. */
    devConversationMode: 'batch' | 'single';
    compactTaskDecomposition: boolean;
    autoDetectTaskSplitMode: boolean;
    /** Prefix for generated iteration branch names (ASCII only), e.g. task/foo-bar. */
    iterationBranchPrefix: string;
    /** Prefix for generated iteration worktree directory names (ASCII only). */
    iterationWorktreePrefix: string;
    /** Whether generated branch/worktree names should keep semantic transliteration hints. */
    iterationNamingSemantic: boolean;
    /** Max length for generated iteration worktree directory names. */
    iterationWorktreeNameMaxLength: number;
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
    /**
     * Root folder name (under the iteration root) holding per-iteration spec artifacts
     * (requirements/design/testcase/tasks). Default 'specs'. Human docs like
     * project-structure.md stay under 'docs'. Legacy 'docs'-based iterations are still
     * read via fallback and auto-migrated on the next agent/validation run.
     */
    specRootDir: string;
    /**
     * Machine-gate strictness for auto-advance / auto-repair paths.
        * - relaxed: 追溯只校验悬空引用（不强制覆盖闭环）；任务阶段需人工确认。
        * - standard: 追溯全量（悬空 + 未覆盖需求）；任务阶段需人工确认。(默认)
          * - strict: 追溯全量；并在最终通过/合并前启用更严格执行门禁。
     */
    gateLevel: 'relaxed' | 'standard' | 'strict';
    /** User-defined buttons rendered on task cards (main panel + worktree subview). */
    customButtons: CustomButton[];
    /** AI quick-chat buttons persisted alongside config and rendered in the task side-action rail. */
    aiQuickChatButtons: AiQuickChatButton[];
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
    /** Lifecycle hook scripts executed at key pipeline nodes (e.g. worktree first-open). */
    lifecycleHooks: LifecycleHooks;
}

export interface FeatureStats {
    total: number;
    todo: number;
    doing: number;
    done: number;
    failed: number;
}

export interface DomainRegistryEntry {
    canonical: string;
    displayName: string;
    aliases: string[];
    status: 'active' | 'deprecated';
}

export interface DomainRegistryAggregationRecord {
    iteration: string;
    contentHash: string;
    aggregatedAt: string;
}

export interface DomainRegistry {
    domains: DomainRegistryEntry[];
    lastAggregated?: DomainRegistryAggregationRecord[];
}

export interface DomainRegistryConflict {
    code: 'duplicate-canonical' | 'duplicate-alias';
    message: string;
    canonical?: string;
    alias?: string;
    entryIndexes: number[];
}

export interface DomainRegistryLoadResult {
    registry: DomainRegistry;
    validationErrors: DomainRegistryConflict[];
    created: boolean;
    filePath: string;
}

export type CapabilityStatus = 'active' | 'deprecated' | 'removed';

export interface CapabilityDeltaItem {
    reqId: string;
    title: string;
    userStory: string;
    status: CapabilityStatus;
}

export interface ContractDeltaItem {
    id: string;
    reqId: string;
    method: string;
    path: string;
    requestShape: Record<string, unknown>;
    responseShape: Record<string, unknown>;
}

export interface InvariantDeltaItem {
    id: string;
    reqId: string;
    text: string;
}

export interface DomainDelta {
    canonical: string | null;
    rawDomain: string | null;
    isSuspectedNew: boolean;
    capabilities: CapabilityDeltaItem[];
    contracts: ContractDeltaItem[];
    invariants: InvariantDeltaItem[];
}

export interface CapabilityDelta {
    iteration: string;
    generatedAt: string;
    contentHash: string;
    domains: DomainDelta[];
}

export interface CapabilityDeltaValidationError {
    field: string;
    message: string;
}

export interface CapabilityDeltaValidationResult {
    valid: boolean;
    errors: CapabilityDeltaValidationError[];
    contentHash: string;
}

export interface SubFeature {
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

export type GateLevel = 'relaxed' | 'standard' | 'strict';

/** Normalize the configured gate level, defaulting to 'standard'. */
export function resolveGateLevel(config: Pick<Config, 'gateLevel'> | undefined): GateLevel {
    const value = config?.gateLevel;
    return value === 'relaxed' || value === 'strict' ? value : 'standard';
}

type SpecDocsConfig = Pick<Config, 'monorepoGit' | 'monorepoDirs' | 'specRootDir'> | undefined;

/**
 * Derive master root from a worktree path. For non-worktree paths returns itself.
 */
export function deriveMasterRoot(workspaceRoot: string): string {
    const normalized = workspaceRoot.replace(/\\/g, '/');
    const marker = '/worktrees/';
    const idx = normalized.indexOf(marker);
    if (idx > 0) {
        return workspaceRoot.slice(0, idx);
    }
    return workspaceRoot;
}

/**
 * Ordered candidates for git-tracked specs directories used by shared governance assets.
 * Priority intentionally prefers monorepo main clone when present in the workspace layout.
 */
export function getTrackedSpecsDirCandidates(workspaceRoot: string): string[] {
    const masterRoot = deriveMasterRoot(workspaceRoot);
    const candidates = [
        path.join(masterRoot, 'repos', 'mono-main', TRACKED_SPECS_DIR),
        path.join(masterRoot, 'repos', 'backend-main', TRACKED_SPECS_DIR),
        path.join(masterRoot, 'repos', 'frontend-main', TRACKED_SPECS_DIR),
        path.join(workspaceRoot, TRACKED_SPECS_DIR),
        path.join(masterRoot, TRACKED_SPECS_DIR),
    ];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const candidate of candidates) {
        if (!seen.has(candidate)) {
            seen.add(candidate);
            result.push(candidate);
        }
    }
    return result;
}

/** Preferred git-tracked specs directory for writes/seeding. */
export function getPrimaryTrackedSpecsDir(workspaceRoot: string): string {
    const candidates = getTrackedSpecsDirCandidates(workspaceRoot);
    return candidates[0] || path.join(workspaceRoot, TRACKED_SPECS_DIR);
}

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

/** The spec-artifacts root folder name under the iteration root (configurable, default 'specs'). */
export function getSpecRootDirName(config: SpecDocsConfig): string {
    return (config?.specRootDir || '').trim() || 'specs';
}

/**
 * Relative path segments (from the iteration root) to the folder holding per-iteration spec
 * docs (requirements/design/testcase/tasks). In monorepo mode these live under a task-named
 * subfolder (specs/<task>/) so that merging the iteration branch back into the shared repo does
 * not collide with other iterations' docs; in multi-repo mode they stay directly under specs/.
 * The task-name subfolder is derived from the iteration directory's own name (worktrees/<task>).
 */
export function getSpecDocsRelSegments(iterDir: string, config: SpecDocsConfig): string[] {
    const root = getSpecRootDirName(config);
    if (isMonoMode(config)) {
        return [root, path.basename(iterDir)];
    }
    return [root];
}

/**
 * Legacy (pre-'specs') spec-doc location segments, rooted at the docs folder. Used only for
 * read fallback and one-time migration of iterations created before specRootDir existed.
 */
export function getLegacySpecDocsRelSegments(iterDir: string, config: SpecDocsConfig): string[] {
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
 * Resolve an existing spec file for reads/detection: prefer the canonical (mode-aware) location
 * under the spec root, then fall back to the legacy docs-based location (docs/ or docs/<task>/)
 * for iterations created before specRootDir was introduced. Returns the canonical path when none
 * exist (for write targets).
 */
export function resolveSpecFile(iterDir: string, config: SpecDocsConfig, fileName: string): string {
    const canonical = getSpecFile(iterDir, config, fileName);
    if (fs.existsSync(canonical)) {
        return canonical;
    }
    const legacySpec = path.join(iterDir, ...getLegacySpecDocsRelSegments(iterDir, config), fileName);
    if (legacySpec !== canonical && fs.existsSync(legacySpec)) {
        return legacySpec;
    }
    return canonical;
}

/**
 * Resolve the tasks plan file, preferring the mode-aware canonical location under the spec root,
 * then falling back to the legacy docs-based location (docs/tasks.md or docs/<task>/tasks.md) and
 * the very-legacy doc/task.md. Returns the canonical path when none exist (for write targets).
 */
export function resolveFeaturePlanFileForIteration(iterDir: string, config: SpecDocsConfig): string {
    const canonical = getSpecFile(iterDir, config, 'tasks.md');
    const legacySpec = path.join(iterDir, ...getLegacySpecDocsRelSegments(iterDir, config), 'tasks.md');
    const legacyFlat = path.join(iterDir, ...FEATURE_PLAN_PRIMARY_REL_PATH.split('/'));
    const legacyOld = path.join(iterDir, ...FEATURE_PLAN_LEGACY_REL_PATH.split('/'));
    for (const candidate of [canonical, legacySpec, legacyFlat, legacyOld]) {
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
    autoAdvanceEnabled: true,
    autoRepairEnabled: true,
    autoContinueAfterManualDone: true,
    devConversationMode: 'batch',
    compactTaskDecomposition: false,
    autoDetectTaskSplitMode: true,
    iterationBranchPrefix: 'task',
    iterationWorktreePrefix: 'task',
    iterationNamingSemantic: true,
    iterationWorktreeNameMaxLength: 52,
    simpleTaskKeywords: 'blacklist,whitelist,crud,toggle,config,list,search,管理,增删改查,配置,名单',
    complexTaskKeywords: 'workflow,state machine,multi-tenant,distributed,transaction,integration,migration,权限,审批,多角色,并发,分布式,跨系统,联调,多模块,复杂',
    aiProvider: 'copilot-chat',
    cliCommandTemplate: '',
    aiFallbackToManual: true,
    aiPanelAutoSubmit: true,
    worktreeSyncPaths: 'worktree/.github/instructions\nworktree/.spec',
    customProjectStructure: '',
    projectStructureRefineMode: 'local+ai',
    specRootDir: 'specs',
    gateLevel: 'standard',
    customButtons: [],
    aiQuickChatButtons: [],
    autoPollEnabled: false,
    autoPollIntervalSec: 60,
    autoPollScript: DEFAULT_POLL_SCRIPT,
    autoPollPrompt: DEFAULT_AUTO_POLL_PROMPT,
    autoPollSkipMarkers: DEFAULT_AUTO_POLL_SKIP_MARKERS,
    lifecycleHooks: { worktreeOpen: [] },
};

// ── Iteration archive ──────────────────────────────────────────────

/** File name for the iteration archive document under <root>/.harness/. */
export const HARNESS_STATE_ARCHIVE_FILE = 'iteration-state-archive.json';

/** Schema version for the iteration archive document format. */
export const ITERATION_ARCHIVE_SCHEMA_VERSION = 1;

/**
 * Snapshot of a completed iteration at archive time. Preserves all Task fields
 * plus archive metadata (archivedAt, archiveReason). The id field acts as the
 * idempotent deduplication key across repeated archive runs.
 */
export interface IterationArchiveItem extends Feature {
    /** ISO-8601 timestamp when this iteration was archived. */
    archivedAt: string;
    /** Reason for archival. 'completed' indicates the iteration reached STAGE.DONE. */
    archiveReason: 'completed';
}

/**
 * Top-level structure of the iteration archive file
 * (.harness/iteration-state-archive.json).
 * Stable contract: schemaVersion + tasks + lastSyncedAt.
 */
export interface IterationArchiveDocument {
    schemaVersion: number;
    tasks: IterationArchiveItem[];
    lastSyncedAt: string;
}

// ── Domain Knowledge Aggregate Models (Req-1..Req-8) ──────────────

/**
 * Snapshot of the registry used by the subpanel for resolution vocabulary.
 * Binds Req-4, Req-7.
 */
export interface DomainRegistrySnapshot {
    domains: DomainRegistryEntry[];
}

/**
 * A registry validation issue produced when loading registry.yaml.
 * Binds Req-4, Req-7.
 */
export interface RegistryValidationIssue {
    code: 'duplicate-canonical' | 'duplicate-alias' | 'invalid-slug';
    message: string;
    canonical?: string;
    alias?: string;
    entryIndexes: number[];
}

/**
 * Tracks file revision anchors used for concurrent-write detection.
 * Binds Req-4, Req-8.
 */
export interface DomainRevisionSet {
    registryRevision: string;
    indexRevision: string;
    /** Map of canonicalDomain → file revision. */
    domainDocRevisions: Record<string, string>;
}

/** A single contract change within a domain change entry. Binds Req-2, Req-6. */
export interface DomainContractChange {
    id: string;
    reqId: string;
    method: string;
    path: string;
    requestShape: Record<string, unknown>;
    responseShape: Record<string, unknown>;
}

/** A single invariant change within a domain change entry. Binds Req-2, Req-6. */
export interface DomainInvariantChange {
    id: string;
    reqId: string;
    text: string;
}

/**
 * A single domain change item within the iteration change set.
 * reqId is the capability primary key; must be unique per change set. Binds Req-4, Req-6.
 */
export interface DomainChange {
    canonicalDomain: string | null;
    rawDomain: string;
    reqId: string;
    title: string;
    userStory: string;
    changeType: 'add' | 'update' | 'deprecate' | 'remove' | 'move';
    status: 'active' | 'deprecated' | 'removed';
    contracts: DomainContractChange[];
    invariants: DomainInvariantChange[];
}

/**
 * The structured iteration change set edited in the subpanel.
 * basedOnBaselineVersion + sourceRevisionSet are the concurrent-write anchor. Binds Req-2, Req-3, Req-6, Req-8.
 */
export interface DomainChangeSet {
    iterationId: string;
    basedOnBaselineVersion: string;
    sourceRevisionSet: DomainRevisionSet;
    updatedAt: string;
    domainChanges: DomainChange[];
}

/** An existing capability record in the baseline snapshot. Binds Req-2, Req-4. */
export interface DomainCapabilityRecord {
    reqId: string;
    title: string;
    userStory: string;
    status: 'active' | 'deprecated' | 'removed';
}

/** An existing contract record in the baseline snapshot. Binds Req-2. */
export interface DomainContractRecord {
    id: string;
    reqId: string;
    method: string;
    path: string;
    requestShape: Record<string, unknown>;
    responseShape: Record<string, unknown>;
}

/** An existing invariant record in the baseline snapshot. Binds Req-2. */
export interface DomainInvariantRecord {
    id: string;
    reqId: string;
    text: string;
}

/**
 * Read-only baseline snapshot for a single domain, consumed by the projection engine.
 * Binds Req-2, Req-4, Req-8.
 */
export interface DomainBaselineSnapshot {
    canonicalDomain: string;
    version: string;
    capabilities: DomainCapabilityRecord[];
    contracts: DomainContractRecord[];
    invariants: DomainInvariantRecord[];
}

/**
 * A projected domain document produced by the projection engine.
 * Used for preview and as input to three-way merge. Binds Req-2, Req-4, Req-8.
 */
export interface ProjectedDomainDocument {
    canonicalDomain: string;
    version: string;
    capabilities: DomainCapabilityRecord[];
    contracts: DomainContractRecord[];
    invariants: DomainInvariantRecord[];
    /** Serialized markdown content for document-level merge checks. */
    markdownContent: string;
}

/**
 * A detected conflict requiring resolution before commit.
 * severity='blocking' prevents commit; severity='warning' is informational only. Binds Req-4, Req-5.
 */
export interface DomainConflict {
    id: string;
    type: 'domain-name' | 'baseline-version' | 'capability-key' | 'document-merge';
    severity: 'blocking' | 'warning';
    reqIds: string[];
    message: string;
    /** For document-merge conflicts: the section identifiers that cannot be auto-merged. */
    conflictingSections?: string[];
}

/**
 * The projection result returned by previewProjection.
 * projectedDomains must be sorted by canonicalDomain for deterministic output. Binds Req-2, Req-8.
 */
export interface DomainProjectionResult {
    baselineVersion: string;
    projectedDomains: ProjectedDomainDocument[];
    conflicts: DomainConflict[];
    warnings: string[];
}

/**
 * User decision for resolving a conflict in the subpanel. Binds Req-5.
 */
export type ConflictDecision =
    | { action: 'merge-existing'; targetCanonical: string }
    | { action: 'append-alias'; alias: string; targetCanonical: string }
    | { action: 'create-canonical'; newCanonical: string; displayName: string }
    | { action: 'choose-value'; field: string; chosenValue: unknown }
    | { action: 'keep-draft'; sectionId: string }
    | { action: 'keep-current'; sectionId: string }
    | { action: 'manual-merge'; sectionId: string; mergedContent: string };

/**
 * A resolved conflict record included in the commit request. Binds Req-5, Req-6.
 */
export interface DomainConflictResolution {
    conflictId: string;
    decision: ConflictDecision;
}

/**
 * Summary returned after a successful atomic commit. Binds Req-3, Req-8.
 */
export interface CommitSummary {
    baselineVersion: string;
    rebased: boolean;
    rebasedFromBaselineVersion?: string;
    processedDomains: number;
    processedCapabilities: number;
    skippedAsNoChange: boolean;
    /** SHA-256 of the deterministic-v1 serialized output for idempotency verification. */
    canonicalSerializationHash: string;
    commitId: string;
    writtenFiles: string[];
}

/**
 * Context payload returned by loadDomainKnowledgeContext.
 * Carries everything the subpanel needs to drive editing and projection. Binds Req-1, Req-2, Req-7.
 */
export interface DomainKnowledgeContext {
    baselineVersion: string;
    registry: DomainRegistrySnapshot;
    baselineSnapshot: DomainBaselineSnapshot[];
    draftChangeSet: DomainChangeSet;
}

/**
 * State used by the baseline sync banner to surface drift and rebase status.
 * Binds Req-4, Req-8.
 */
export interface BaselineSyncState {
    stale: boolean;
    rebaseInProgress: boolean;
    rebased: boolean;
    latestBaselineVersion: string;
    latestRevisions: DomainRevisionSet;
}
