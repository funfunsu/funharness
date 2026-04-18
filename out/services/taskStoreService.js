"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskStoreService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const models_1 = require("../models");
class TaskStoreService {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }
    getIterationDir(task) {
        const meta = this.getConfigMeta();
        if (meta.origin === 'worktreeSnapshot') {
            // In a child worktree window, always read artifacts from current workspace root.
            return this.workspaceRoot;
        }
        return task.worktreePath || path.join(this.workspaceRoot, 'worktrees', task.name);
    }
    ensureIterationDir(task) {
        const worktreePath = this.getIterationDir(task);
        task.worktreePath = worktreePath;
        fs.mkdirSync(worktreePath, { recursive: true });
    }
    loadTasks() {
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
    saveTasks(tasks) {
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
            const harnessDir = path.join(iterDir, models_1.BASE);
            fs.mkdirSync(harnessDir, { recursive: true });
            const file = path.join(harnessDir, models_1.HARNESS_STATE_FILE);
            fs.writeFileSync(file, JSON.stringify([task], null, 2), 'utf8');
            const legacy = path.join(harnessDir, models_1.HARNESS_STATE_FILE_LEGACY);
            if (fs.existsSync(legacy)) {
                fs.rmSync(legacy, { force: true });
            }
        }
    }
    getConfigMeta() {
        const file = this.getConfigFile();
        if (!fs.existsSync(file)) {
            return { origin: 'unknown', readOnly: false };
        }
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const originRaw = raw.__harnessConfigOrigin;
            const origin = originRaw === 'master' || originRaw === 'worktreeSnapshot' ? originRaw : 'unknown';
            const masterRoot = typeof raw.__harnessMasterRoot === 'string' ? raw.__harnessMasterRoot : undefined;
            return {
                origin,
                masterRoot,
                readOnly: origin === 'worktreeSnapshot',
            };
        }
        catch {
            return { origin: 'unknown', readOnly: false };
        }
    }
    configFileExists() {
        return fs.existsSync(this.getConfigFile());
    }
    loadConfig() {
        const file = this.getConfigFile();
        if (!fs.existsSync(file)) {
            return { ...models_1.DEFAULT_CONFIG };
        }
        try {
            const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
            return { ...models_1.DEFAULT_CONFIG, ...loaded };
        }
        catch {
            return { ...models_1.DEFAULT_CONFIG };
        }
    }
    saveConfig(config) {
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
    loadLocalTasks() {
        const file = this.getTaskFile();
        if (fs.existsSync(file)) {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
            catch {
                return [];
            }
        }
        // Backward compatibility for old .harness/tasks.json naming.
        const legacy = this.getLegacyTaskFile();
        if (!fs.existsSync(legacy)) {
            return [];
        }
        try {
            const tasks = JSON.parse(fs.readFileSync(legacy, 'utf8'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf8');
            fs.rmSync(legacy, { force: true });
            return tasks;
        }
        catch {
            return [];
        }
    }
    saveLocalTasks(tasks) {
        const file = this.getTaskFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf8');
        const legacy = this.getLegacyTaskFile();
        if (fs.existsSync(legacy)) {
            fs.rmSync(legacy, { force: true });
        }
    }
    loadTasksFromWorktrees() {
        const worktreesRoot = path.join(this.workspaceRoot, 'worktrees');
        if (!fs.existsSync(worktreesRoot)) {
            return [];
        }
        const taskMap = new Map();
        for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const harnessDir = path.join(worktreesRoot, entry.name, models_1.BASE);
            const currentFile = path.join(harnessDir, models_1.HARNESS_STATE_FILE);
            const legacyFile = path.join(harnessDir, models_1.HARNESS_STATE_FILE_LEGACY);
            const taskFile = fs.existsSync(currentFile)
                ? currentFile
                : legacyFile;
            if (!fs.existsSync(taskFile)) {
                continue;
            }
            try {
                const list = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
                if (taskFile === legacyFile) {
                    fs.writeFileSync(currentFile, JSON.stringify(list, null, 2), 'utf8');
                    fs.rmSync(legacyFile, { force: true });
                }
                for (const task of list) {
                    if (task && task.id) {
                        taskMap.set(task.id, task);
                    }
                }
            }
            catch {
                // Ignore malformed task snapshots and continue scanning.
            }
        }
        return Array.from(taskMap.values());
    }
    getTaskFile() {
        return path.join(this.workspaceRoot, models_1.BASE, models_1.HARNESS_STATE_FILE);
    }
    getLegacyTaskFile() {
        return path.join(this.workspaceRoot, models_1.BASE, models_1.HARNESS_STATE_FILE_LEGACY);
    }
    getConfigFile() {
        return path.join(this.workspaceRoot, models_1.BASE, 'config.json');
    }
}
exports.TaskStoreService = TaskStoreService;
//# sourceMappingURL=taskStoreService.js.map