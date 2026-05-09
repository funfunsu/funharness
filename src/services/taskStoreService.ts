import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, DEFAULT_CONFIG, HARNESS_STATE_FILE, HARNESS_STATE_FILE_LEGACY, Task } from '../models';

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
        fs.mkdirSync(worktreePath, { recursive: true });
    }

    loadTasks(): Task[] {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            return this.loadLocalTasks();
        }

        const worktreeTasks = this.loadTasksFromWorktrees();
        if (worktreeTasks.length > 0) {
            return worktreeTasks;
        }

        // Backward compatibility with legacy root-level task file.
        return this.loadLocalTasks();
    }

    saveTasks(tasks: Task[]): void {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            this.saveLocalTasks(tasks);
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
            const harnessDir = path.join(iterDir, BASE);
            fs.mkdirSync(harnessDir, { recursive: true });
            const file = path.join(harnessDir, HARNESS_STATE_FILE);
            fs.writeFileSync(file, JSON.stringify([task], null, 2), 'utf8');
            const legacy = path.join(harnessDir, HARNESS_STATE_FILE_LEGACY);
            if (fs.existsSync(legacy)) {
                fs.rmSync(legacy, { force: true });
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
            const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Config>;
            return { ...DEFAULT_CONFIG, ...loaded };
        } catch {
            return { ...DEFAULT_CONFIG };
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
            fs.rmSync(legacy, { force: true });
            return tasks;
        } catch {
            return [];
        }
    }

    private saveLocalTasks(tasks: Task[]): void {
        const file = this.getTaskFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf8');
        const legacy = this.getLegacyTaskFile();
        if (fs.existsSync(legacy)) {
            fs.rmSync(legacy, { force: true });
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
                    fs.rmSync(legacyFile, { force: true });
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
