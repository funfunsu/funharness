import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, CustomButton, DEFAULT_CONFIG, HARNESS_STATE_FILE, HARNESS_STATE_FILE_LEGACY, STAGE, Stage, Task, normalizeCustomButton } from '../models';
import { safeRemovePath } from './fileOps';

const STAGE_ORDER: Stage[] = [
    STAGE.INITIALIZING,
    STAGE.WRITING_REQUIREMENT,
    STAGE.WRITING_DESIGN,
    STAGE.WRITING_TESTCASE,
    STAGE.WRITING_TASKS,
    STAGE.DEVELOPING,
    STAGE.READY_FOR_REVIEW,
    STAGE.DONE,
];

export interface HarnessConfigMeta {
    origin: 'master' | 'worktreeSnapshot' | 'unknown';
    masterRoot?: string;
    readOnly: boolean;
}

export class TaskStoreService {
    constructor(private readonly workspaceRoot: string) {}

    getIterationDir(task: Task): string {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            // In a child worktree window, always read artifacts from current workspace root.
            return this.workspaceRoot;
        }
        return task.worktreePath || path.join(this.workspaceRoot, 'worktrees', task.name);
    }

    ensureIterationDir(task: Task): void {
        const worktreePath = this.getIterationDir(task);
        task.worktreePath = worktreePath;
        // Lazy-init mode: only record the intended path; physical creation happens
        // when user explicitly opens the task worktree.
    }

    loadTasks(): Task[] {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            return this.migrateTaskBaselines(this.loadLocalTasks());
        }

        const localTasks = this.loadLocalTasks();
        const localIds = new Set(localTasks.map(t => t.id));

        const worktreeTasks = this.loadTasksFromWorktrees();
        if (worktreeTasks.length === 0) {
            return this.migrateTaskBaselines(localTasks);
        }

        // Root file is the authoritative task list.
        // Worktree snapshots carry richer per-task state (e.g. substage progress),
        // so prefer their version, but only for tasks that still exist in the root file.
        if (localIds.size > 0) {
            const worktreeMap = new Map(worktreeTasks.map(t => [t.id, t]));
            return this.migrateTaskBaselines(localTasks.map(t => worktreeMap.get(t.id) || t));
        }

        // No root file yet (fresh workspace) — trust worktree scan as-is.
        return this.migrateTaskBaselines(worktreeTasks);
    }

    /**
     * Collapse legacy per-task baseline aliases (baseSyncBranchUsed / mergeTargetBranchUsed) into
     * the single canonical baseBranchUsed, so the rest of the app only ever reads one field.
     */
    private migrateTaskBaselines(tasks: Task[]): Task[] {
        for (const t of tasks) {
            if (t.baseBranchUsed) {
                continue;
            }
            const legacyFields = t as unknown as Record<string, unknown>;
            const legacy = legacyFields.baseSyncBranchUsed ?? legacyFields.mergeTargetBranchUsed;
            if (typeof legacy === 'string' && legacy.trim()) {
                t.baseBranchUsed = legacy.trim();
            }
        }
        return tasks;
    }

    saveTasks(tasks: Task[]): void {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            this.saveLocalTasks(tasks);
            // Propagate to master root if reachable, so that:
            // 1) The master root's iteration-state.json reflects the latest task state
            //    instead of lagging until master itself triggers a save.
            // 2) The user reading the file directly (e.g. after passByTaskId) sees the
            //    expected stage, not the stale pre-merge value.
            this.propagateTasksToMaster(meta.masterRoot, tasks);
            return;
        }

        // Keep legacy master copy for backward compatibility.
        this.saveLocalTasks(tasks);

        // Use per-worktree task snapshots as the source of truth.
        for (const task of tasks) {
            const iterDir = this.getIterationDir(task);
            if (!iterDir) {
                continue;
            }
            // Lazy-init mode: do not create iteration dirs just for state snapshots.
            // Only write per-worktree state after the iteration directory is physically created
            // (typically when user explicitly opens/initializes that worktree).
            if (!fs.existsSync(iterDir)) {
                continue;
            }
            const harnessDir = path.join(iterDir, BASE);
            fs.mkdirSync(harnessDir, { recursive: true });
            const file = path.join(harnessDir, HARNESS_STATE_FILE);

            // Preserve per-task fields that may have been set from the worktree subview,
            // which has its own in-memory copy the master panel doesn't see in real time.
            // Critically: do NOT regress task.stage. If the subview already advanced this
            // task (e.g. after passByTaskId set DONE), master must not overwrite it back to
            // an earlier stage just because master's in-memory copy hasn't reloaded yet.
            const taskToSave = { ...task };
            if (fs.existsSync(file)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Task[];
                    const existingTask = existing.find(t => t.id === task.id);
                    if (existingTask?.aiProvider && !task.aiProvider) {
                        taskToSave.aiProvider = existingTask.aiProvider;
                    }
                    if (existingTask?.stage && this.isStageMoreAdvanced(existingTask.stage, task.stage)) {
                        taskToSave.stage = existingTask.stage;
                    }
                } catch {
                    // ignore malformed files
                }
            }
            fs.writeFileSync(file, JSON.stringify([taskToSave], null, 2), 'utf8');
            const legacy = path.join(harnessDir, HARNESS_STATE_FILE_LEGACY);
            if (fs.existsSync(legacy)) {
                safeRemovePath(legacy);
            }
        }
    }

    getConfigMeta(): HarnessConfigMeta {
        const file = this.getConfigFile();
        if (!fs.existsSync(file)) {
            return { origin: 'unknown', readOnly: false };
        }
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            const originRaw = raw.__harnessConfigOrigin;
            const origin = originRaw === 'master' || originRaw === 'worktreeSnapshot' ? originRaw : 'unknown';
            const masterRoot = typeof raw.__harnessMasterRoot === 'string' ? raw.__harnessMasterRoot : undefined;
            return {
                origin,
                masterRoot,
                readOnly: origin === 'worktreeSnapshot',
            };
        } catch {
            return { origin: 'unknown', readOnly: false };
        }
    }

    configFileExists(): boolean {
        return fs.existsSync(this.getConfigFile());
    }

    loadConfig(): Config {
        const file = this.getConfigFile();
        if (!fs.existsSync(file)) {
            return { ...DEFAULT_CONFIG };
        }

        try {
            const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Config> & Record<string, unknown>;
            // Migrate legacy provider id
            if (loaded.aiProvider === 'claude-cli') {
                loaded.aiProvider = 'claude-code-cli';
            }
            // Migrate legacy field name
            if (!loaded.cliCommandTemplate && loaded.claudeCliCommandTemplate) {
                loaded.cliCommandTemplate = loaded.claudeCliCommandTemplate;
            }
            // Migrate two-field branch config into unified baseBranch
            if (!loaded.baseBranch) {
                const legacyBase = (loaded.baseSyncBranch as string | undefined || '').trim();
                const legacyMerge = (loaded.mergeTargetBranch as string | undefined || '').trim();
                loaded.baseBranch = legacyBase || legacyMerge || '';
            }
            // Ensure monorepo fields exist for configs saved before monorepo support, and
            // deep-merge monorepoDirs so a partially-specified object keeps default subfolders.
            const merged = { ...DEFAULT_CONFIG, ...loaded };
            merged.monorepoGit = typeof loaded.monorepoGit === 'string' ? loaded.monorepoGit : '';
            merged.monorepoDirs = { ...DEFAULT_CONFIG.monorepoDirs, ...(loaded.monorepoDirs || {}) };
            // Migrate legacy single-field buttons (command) to the {scriptSource, script, args} form.
            merged.customButtons = Array.isArray(loaded.customButtons)
                ? (loaded.customButtons as CustomButton[]).map(normalizeCustomButton)
                : [];
            return merged;
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    /**
     * Update only the customButtons field in every existing worktree snapshot's
     * config.json (preserving each snapshot's other settings). Lets already-created
     * worktree subview windows pick up newly configured buttons after a reload.
     * Master-only — callers must guard against the read-only worktree snapshot origin.
     */
    syncCustomButtonsToWorktrees(buttons: CustomButton[]): void {
        const worktreesRoot = path.join(this.workspaceRoot, 'worktrees');
        if (!fs.existsSync(worktreesRoot)) {
            return;
        }
        for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const cfgFile = path.join(worktreesRoot, entry.name, BASE, 'config.json');
            if (!fs.existsSync(cfgFile)) {
                continue;
            }
            try {
                const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
                raw.customButtons = buttons;
                fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2), 'utf8');
            } catch {
                // Ignore malformed snapshots; never block the master save.
            }
        }
    }

    saveConfig(config: Config): void {
        const meta = this.getConfigMeta();
        const file = this.getConfigFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const payload = {
            ...config,
            __harnessConfigOrigin: meta.origin === 'worktreeSnapshot' ? 'worktreeSnapshot' : 'master',
            __harnessMasterRoot: meta.masterRoot,
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    }

    private loadLocalTasks(): Task[] {
        const file = this.getTaskFile();
        if (fs.existsSync(file)) {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8')) as Task[];
            } catch {
                return [];
            }
        }

        // Backward compatibility for old .harness/tasks.json naming.
        const legacy = this.getLegacyTaskFile();
        if (!fs.existsSync(legacy)) {
            return [];
        }

        try {
            const tasks = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Task[];
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf8');
            safeRemovePath(legacy);
            return tasks;
        } catch {
            return [];
        }
    }

    private isStageMoreAdvanced(candidate: Stage | undefined, current: Stage | undefined): boolean {
        if (!candidate || !current) {
            return false;
        }
        const candidateIdx = STAGE_ORDER.indexOf(candidate);
        const currentIdx = STAGE_ORDER.indexOf(current);
        if (candidateIdx < 0 || currentIdx < 0) {
            return false;
        }
        return candidateIdx > currentIdx;
    }

    private saveLocalTasks(tasks: Task[]): void {
        const file = this.getTaskFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf8');
        const legacy = this.getLegacyTaskFile();
        if (fs.existsSync(legacy)) {
            safeRemovePath(legacy);
        }
    }

    /**
     * Called when saving from a worktree subview: merge the in-subview tasks into the
     * master root's iteration-state.json so master reads the same state without needing
     * to call loadTasks first. Each task is matched by id; tasks already in master but
     * not in this subview's snapshot are preserved.
     */
    private propagateTasksToMaster(masterRoot: string | undefined, tasks: Task[]): void {
        if (!masterRoot || !fs.existsSync(masterRoot)) {
            return;
        }
        try {
            const masterFile = path.join(masterRoot, BASE, HARNESS_STATE_FILE);
            fs.mkdirSync(path.dirname(masterFile), { recursive: true });
            let masterTasks: Task[] = [];
            if (fs.existsSync(masterFile)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(masterFile, 'utf8')) as Task[];
                    if (Array.isArray(parsed)) {
                        masterTasks = parsed;
                    }
                } catch {
                    // ignore malformed file, fall through to overwrite
                }
            }
            const byId = new Map<string, Task>(masterTasks.map(t => [t.id, t]));
            for (const task of tasks) {
                byId.set(task.id, { ...byId.get(task.id), ...task });
            }
            const merged = Array.from(byId.values());
            fs.writeFileSync(masterFile, JSON.stringify(merged, null, 2), 'utf8');
        } catch {
            // Subview save must not be blocked by master propagation failures.
        }
    }

    private loadTasksFromWorktrees(): Task[] {
        const worktreesRoot = path.join(this.workspaceRoot, 'worktrees');
        if (!fs.existsSync(worktreesRoot)) {
            return [];
        }

        const taskMap = new Map<string, Task>();
        for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const harnessDir = path.join(worktreesRoot, entry.name, BASE);
            const currentFile = path.join(harnessDir, HARNESS_STATE_FILE);
            const legacyFile = path.join(harnessDir, HARNESS_STATE_FILE_LEGACY);
            const taskFile = fs.existsSync(currentFile)
                ? currentFile
                : legacyFile;
            if (!fs.existsSync(taskFile)) {
                continue;
            }
            try {
                const list = JSON.parse(fs.readFileSync(taskFile, 'utf8')) as Task[];
                if (taskFile === legacyFile) {
                    fs.writeFileSync(currentFile, JSON.stringify(list, null, 2), 'utf8');
                    safeRemovePath(legacyFile);
                }
                for (const task of list) {
                    if (task && task.id) {
                        taskMap.set(task.id, task);
                    }
                }
            } catch {
                // Ignore malformed task snapshots and continue scanning.
            }
        }

        return Array.from(taskMap.values());
    }

    private getTaskFile(): string {
        return path.join(this.workspaceRoot, BASE, HARNESS_STATE_FILE);
    }

    private getLegacyTaskFile(): string {
        return path.join(this.workspaceRoot, BASE, HARNESS_STATE_FILE_LEGACY);
    }

    private getConfigFile(): string {
        return path.join(this.workspaceRoot, BASE, 'config.json');
    }
}
