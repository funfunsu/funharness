import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, CustomButton, DEFAULT_CONFIG, HARNESS_STATE_ARCHIVE_FILE, HARNESS_STATE_FILE, HARNESS_STATE_FILE_LEGACY, ITERATION_ARCHIVE_SCHEMA_VERSION, IterationArchiveDocument, IterationArchiveItem, STAGE, Stage, Feature, normalizeCustomButton, resolveSpecFile, resolveFeaturePlanFileForIteration } from '../models';
import { appendHarnessLog } from './harnessLog';
import { safeRemovePath } from './fileOps';
import { buildTraceMatrixSnapshot, TraceMatrixSnapshot } from '../specTrace';
import { deriveIterationWorktreeNameWithOptions } from './branchName';

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

export class FeatureStoreService {
    constructor(private readonly workspaceRoot: string) {}

    private samePath(a: string, b: string): boolean {
        const na = path.resolve(a || '').replace(/[\\/]+/g, path.sep).toLowerCase();
        const nb = path.resolve(b || '').replace(/[\\/]+/g, path.sep).toLowerCase();
        return na === nb;
    }

    private toPersistedFeature(task: Feature): Feature {
        const { allowStageRegressionOnce: _allowStageRegressionOnce, ...persisted } = task;
        return persisted;
    }

    /**
     * Build the latest Req-* trace snapshot for a task iteration using current spec artifacts.
     * Returns empty-content derived results when optional artifacts are missing.
     */
    getRequirementTraceSnapshot(task: Feature): TraceMatrixSnapshot {
        const iterDir = this.getIterationDir(task);
        const config = this.loadConfig();
        const requirementsPath = resolveSpecFile(iterDir, config, 'requirements.md');
        const designPath = resolveSpecFile(iterDir, config, 'design.md');
        const testcasePath = resolveSpecFile(iterDir, config, 'testcase.md');
        const tasksPath = resolveFeaturePlanFileForIteration(iterDir, config);

        const requirementsContent = this.readOptionalTextFile(requirementsPath);
        const designContent = this.readOptionalTextFile(designPath);
        const testcaseContent = this.readOptionalTextFile(testcasePath);
        const tasksContent = this.readOptionalTextFile(tasksPath);

        return buildTraceMatrixSnapshot(
            requirementsContent,
            designContent,
            tasksContent,
            testcaseContent,
        );
    }

    getIterationDir(task: Feature): string {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            // In a child worktree window, always read artifacts from current workspace root.
            return this.workspaceRoot;
        }
        const config = this.loadConfig();
        const englishDir = path.join(this.workspaceRoot, 'worktrees', deriveIterationWorktreeNameWithOptions(task, {
            branchPrefix: config.iterationBranchPrefix,
            worktreePrefix: config.iterationWorktreePrefix,
            semanticSlug: config.iterationNamingSemantic,
            worktreeNameMaxLength: config.iterationWorktreeNameMaxLength,
        }));
        const legacyName = (task.name || '').trim();
        const legacyDir = legacyName
            ? path.join(this.workspaceRoot, 'worktrees', legacyName)
            : '';

        // Lazy migration: old snapshots may persist a legacy path derived from task.name.
        // If that legacy folder does not exist yet, switch to the new English-safe path.
        if (task.worktreePath) {
            if (legacyDir && this.samePath(task.worktreePath, legacyDir)) {
                if (fs.existsSync(legacyDir)) {
                    return legacyDir;
                }
                return englishDir;
            }
            return task.worktreePath;
        }

        return englishDir;
    }

    ensureIterationDir(task: Feature): void {
        const worktreePath = this.getIterationDir(task);
        task.worktreePath = worktreePath;
        // Lazy-init mode: only record the intended path; physical creation happens
        // when user explicitly opens the task worktree.
    }

    loadFeatures(): Feature[] {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            return this.migrateTaskBaselines(this.loadLocalTasks());
        }

        const localTasks = this.loadLocalTasks();
        const localIds = new Set(localTasks.map(t => t.id));

        const worktreeFeatures = this.loadFeaturesFromWorktrees();
        if (worktreeFeatures.length === 0) {
            return this.migrateTaskBaselines(localTasks);
        }

        // Root file is the authoritative task list.
        // Worktree snapshots carry richer per-task state (e.g. substage progress),
        // so prefer their version, but only for tasks that still exist in the root file.
        if (localIds.size > 0) {
            const worktreeMap = new Map(worktreeFeatures.map(t => [t.id, t]));
            return this.migrateTaskBaselines(localTasks.map(t => worktreeMap.get(t.id) || t));
        }

        // No root file yet (fresh workspace) — trust worktree scan as-is.
        return this.migrateTaskBaselines(worktreeFeatures);
    }

    /**
     * Collapse legacy per-task baseline aliases (baseSyncBranchUsed / mergeTargetBranchUsed) into
     * the single canonical baseBranchUsed, so the rest of the app only ever reads one field.
     */
    private migrateTaskBaselines(tasks: Feature[]): Feature[] {
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

    saveFeatures(features: Feature[]): void {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            this.saveLocalTasks(features);
            // Propagate to master root if reachable, so that:
            // 1) The master root's iteration-state.json reflects the latest task state
            //    instead of lagging until master itself triggers a save.
            // 2) The user reading the file directly (e.g. after passByTaskId) sees the
            //    expected stage, not the stale pre-merge value.
            this.propagateTasksToMaster(meta.masterRoot, features);
            return;
        }

        // Keep legacy master copy for backward compatibility.
        this.saveLocalTasks(features);

        // Use per-worktree task snapshots as the source of truth.
        for (const task of features) {
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
            const allowStageRegression = task.allowStageRegressionOnce === true;
            const taskToSave = this.toPersistedFeature(task);
            if (fs.existsSync(file)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Feature[];
                    const existingTask = existing.find(t => t.id === task.id);
                    if (existingTask?.aiProvider && !task.aiProvider) {
                        taskToSave.aiProvider = existingTask.aiProvider;
                    }
                    if (!allowStageRegression && existingTask?.stage && this.isStageMoreAdvanced(existingTask.stage, task.stage)) {
                        taskToSave.stage = existingTask.stage;
                    }
                } catch {
                    // ignore malformed files
                }
            }
            // Do not write done tasks to per-worktree snapshots — they have already
            // been archived at the authoritative root level by saveLocalTasks (INV-1).
            if (taskToSave.stage === STAGE.DONE) {
                continue;
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
            // Ensure lifecycleHooks exists and deep-merge with defaults so old configs auto-fill.
            merged.lifecycleHooks = {
                worktreeOpen: Array.isArray(loaded?.lifecycleHooks?.worktreeOpen)
                    ? loaded.lifecycleHooks.worktreeOpen
                    : [],
            };
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

    private loadLocalTasks(): Feature[] {
        const file = this.getTaskFile();
        if (fs.existsSync(file)) {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8')) as Feature[];
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
            const tasks = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Feature[];
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

    /**
     * Persist the task list to the local state file, archiving completed tasks first.
     * Done tasks are written to the archive document before being removed from the
     * active state file. If archiving fails the done tasks are kept in the active file
     * so they are not silently lost (Req-5, INV-6).
     */
    private saveLocalTasks(tasks: Feature[]): void {
        // Split done tasks from active tasks (Req-1, Req-2, INV-1).
        const completedTasks = tasks.filter(t => t.stage === STAGE.DONE).map(task => this.toPersistedFeature(task));
        const activeTasks = tasks.filter(t => t.stage !== STAGE.DONE).map(task => this.toPersistedFeature(task));

        // Archive done tasks first. On failure, retain them in the active file to
        // prevent data loss and allow a self-healing retry on the next save (INV-6).
        const archiveSucceeded = this.writeArchiveDocument(this.workspaceRoot, completedTasks);
        const tasksToWrite = archiveSucceeded ? activeTasks : tasks;

        const file = this.getTaskFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(tasksToWrite, null, 2), 'utf8');
        const legacy = this.getLegacyTaskFile();
        if (fs.existsSync(legacy)) {
            safeRemovePath(legacy);
        }
    }

    /**
     * Called when saving from a worktree subview: propagate the latest task state
     * to the master root so it reads a consistent view without a full reload.
     *
     * Done tasks are archived to the master's archive file first (Req-6, INV-7).
     * If archiving succeeds, done tasks are removed from the master's active state.
     * If archiving fails, done tasks are retained in the master's active state so
     * they can be re-tried on the next propagation and are not silently lost (INV-6).
     * All propagation failures are swallowed so the worktree local save is never blocked.
     */
    private propagateTasksToMaster(masterRoot: string | undefined, tasks: Feature[]): void {
        if (!masterRoot || !fs.existsSync(masterRoot)) {
            return;
        }
        try {
            // Separate done tasks from active tasks for archive-first propagation.
            const completedTasks = tasks.filter(t => t.stage === STAGE.DONE).map(task => this.toPersistedFeature(task));
            const activeTasks = tasks.filter(t => t.stage !== STAGE.DONE).map(task => this.toPersistedFeature(task));

            const masterFile = path.join(masterRoot, BASE, HARNESS_STATE_FILE);
            fs.mkdirSync(path.dirname(masterFile), { recursive: true });
            let masterTasks: Feature[] = [];
            if (fs.existsSync(masterFile)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(masterFile, 'utf8')) as Feature[];
                    if (Array.isArray(parsed)) {
                        masterTasks = parsed;
                    }
                } catch {
                    // ignore malformed file, fall through to overwrite
                }
            }

            // Archive done tasks to the master's archive file before removal (INV-7).
            const archiveOk = this.writeArchiveDocument(masterRoot, completedTasks);

            // Merge active tasks into the master's task map.
            const byId = new Map<string, Feature>(masterTasks.map(t => [t.id, t]));
            for (const task of activeTasks) {
                byId.set(task.id, { ...byId.get(task.id), ...task });
            }
            if (archiveOk) {
                // Archive succeeded: remove done tasks from master's active state.
                for (const task of completedTasks) {
                    byId.delete(task.id);
                }
            } else {
                // Archive failed: merge done tasks back so master retains them for retry.
                for (const task of completedTasks) {
                    byId.set(task.id, { ...byId.get(task.id), ...task });
                }
            }
            const merged = Array.from(byId.values());
            fs.writeFileSync(masterFile, JSON.stringify(merged, null, 2), 'utf8');
        } catch {
            // Subview save must not be blocked by master propagation failures.
        }
    }

    private loadFeaturesFromWorktrees(): Feature[] {
        const worktreesRoot = path.join(this.workspaceRoot, 'worktrees');
        if (!fs.existsSync(worktreesRoot)) {
            return [];
        }

        const taskMap = new Map<string, Feature>();
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
                const list = JSON.parse(fs.readFileSync(taskFile, 'utf8')) as Feature[];
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

    /**
     * Read the iteration archive document from disk for the given root directory.
     * Returns an empty archive document if the file does not exist or is corrupt.
     * Safe: never throws an uncaught exception.
     */
    private readArchiveDocument(root: string): IterationArchiveDocument {
        const archiveFile = path.join(root, BASE, HARNESS_STATE_ARCHIVE_FILE);
        if (!fs.existsSync(archiveFile)) {
            return { schemaVersion: ITERATION_ARCHIVE_SCHEMA_VERSION, tasks: [], lastSyncedAt: '' };
        }
        try {
            const raw = fs.readFileSync(archiveFile, 'utf8');
            const parsed = JSON.parse(raw) as IterationArchiveDocument;
            const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
            return {
                schemaVersion: ITERATION_ARCHIVE_SCHEMA_VERSION,
                tasks,
                lastSyncedAt: parsed?.lastSyncedAt || '',
            };
        } catch {
            // Return empty doc — caller decides whether to treat this as corrupt.
            return { schemaVersion: ITERATION_ARCHIVE_SCHEMA_VERSION, tasks: [], lastSyncedAt: '' };
        }
    }

    /**
     * Upsert completed tasks into the iteration archive document and persist to disk.
     * Deduplicates by task id so repeated runs are idempotent.
     * New entries are annotated with archivedAt (ISO-8601) and archiveReason='completed'.
     * If the existing archive file is corrupt, logs the failure and returns false so that
     * the caller can keep the task in the active state file rather than losing the record.
     * Returns true on success, false on any failure.
     */
    private writeArchiveDocument(root: string, completedTasks: Feature[]): boolean {
        if (!completedTasks.length) {
            return true;
        }
        const archiveFile = path.join(root, BASE, HARNESS_STATE_ARCHIVE_FILE);
        let archiveDoc: IterationArchiveDocument;

        // If the archive file exists, parse it first. A corrupt file blocks removal of
        // the active task to prevent data loss (Req-4 / Req-5 invariant).
        if (fs.existsSync(archiveFile)) {
            try {
                const raw = fs.readFileSync(archiveFile, 'utf8');
                const parsed = JSON.parse(raw) as IterationArchiveDocument;
                const existingTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
                archiveDoc = {
                    schemaVersion: ITERATION_ARCHIVE_SCHEMA_VERSION,
                    tasks: existingTasks,
                    lastSyncedAt: parsed?.lastSyncedAt || '',
                };
            } catch {
                appendHarnessLog(
                    root,
                    'archive',
                    `CORRUPT_ARCHIVE: failed to parse ${HARNESS_STATE_ARCHIVE_FILE} — aborting archive to prevent data loss`,
                );
                return false;
            }
        } else {
            archiveDoc = { schemaVersion: ITERATION_ARCHIVE_SCHEMA_VERSION, tasks: [], lastSyncedAt: '' };
        }

        // Upsert: skip tasks already present in the archive (idempotent by id).
        const now = new Date().toISOString();
        const existingIds = new Set(archiveDoc.tasks.map(t => t.id));
        for (const task of completedTasks) {
            if (!existingIds.has(task.id)) {
                const archiveItem: IterationArchiveItem = { ...task, archivedAt: now, archiveReason: 'completed' };
                archiveDoc.tasks.push(archiveItem);
            }
        }
        archiveDoc.lastSyncedAt = now;

        try {
            fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
            fs.writeFileSync(archiveFile, JSON.stringify(archiveDoc, null, 2), 'utf8');
            return true;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            appendHarnessLog(root, 'archive', `WRITE_FAILED: could not persist ${HARNESS_STATE_ARCHIVE_FILE} — ${detail}`);
            return false;
        }
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

    /** Read UTF-8 file content when present; returns empty string for missing/unreadable files. */
    private readOptionalTextFile(filePath: string): string {
        if (!filePath || !fs.existsSync(filePath)) {
            return '';
        }
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return '';
        }
    }
}
