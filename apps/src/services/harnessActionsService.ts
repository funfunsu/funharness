import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { HarnessStep } from '../harnessMessages';
import {
    BASE,
    Config,
    CustomButton,
    CUSTOM_SCRIPT_DIR,
    DEFAULT_MONOREPO_DIRS,
    HARNESS_STATE_FILE,
    HARNESS_STATE_FILE_LEGACY,
    HookEntry,
    STAGE,
    TASK_PLAN_LEGACY_REL_PATH,
    TASK_PLAN_PRIMARY_REL_PATH,
    Task,
    getScriptsSubdir,
    getSpecFile,
    getSpecFileRel,
    getLegacySpecDocsRelSegments,
    resolveGateLevel,
    resolveSpecFile,
    resolveTaskPlanFileForIteration,
    getDocsRootDirName,
    isMonoMode,
    isOsScriptFile,
    normalizeCustomButton,
} from '../models';
import { TaskScheduler } from '../taskScheduler';
import { GitService } from './gitService';
import { appendHarnessLog } from './harnessLog';
import { validateTraceability } from '../specTrace';
import { safeRemovePath } from './fileOps';

interface ArtifactIndexItem {
    taskId: string;
    taskName: string;
    updatedAt: string;
    trigger: 'manualPush' | 'taskDone';
    requirementsPath?: string;
    designPath?: string;
}

interface ArtifactIndexFile {
    version: 1;
    updatedAt: string;
    items: ArtifactIndexItem[];
}

interface HarnessActionsDeps {
    getTasks: () => Task[];
    getConfig: () => Config;
    reloadConfig?: () => void;
    /** Master workspace root (the "主目录"), even when invoked from a worktree subview window. */
    getMasterRoot: () => string;
    getIterationDir: (task: Task) => string;
    ensureIterationDir: (task: Task) => void;
    saveAndRender: () => void;
    gitService: GitService;
    getScheduler: (task: Task) => TaskScheduler;
    stopScheduler: (taskId: string) => void;
    onPass: (task: Task) => void;
    isWorktreeSubview: () => boolean;
    dispatchAi: (query: string, iterDir: string, source: 'stage-agent' | 'dev-subtask', providerOverride?: string) => Promise<void>;
    copyProjectStructureToIteration: (iterDir: string) => void;
    renderAgentPrompt: (step: HarnessStep, taskName: string, taskDesc: string, iterDir: string) => { content: string; source: string; path: string };
}

export class HarnessActionsService {
    constructor(private readonly deps: HarnessActionsDeps) {}
    private readonly lastAutoRepairAt: Map<string, number> = new Map();
    private readonly lastAutoRepairSignature: Map<string, string> = new Map();
    private readonly repairingKeys: Set<string> = new Set();
    private readonly artifactRepairTimers: Map<string, NodeJS.Timeout> = new Map();
    /** Per (task:step) count of auto-repair attempts, for max-retry + human escalation. */
    private readonly repairAttempts: Map<string, number> = new Map();
    /** Keys that exhausted auto-repair and were escalated to a human gate. */
    private readonly escalatedRepairKeys: Set<string> = new Set();
    private static readonly MAX_AUTO_REPAIR_ATTEMPTS = 3;

    private readonly stageArtifacts = {
        req: 'requirements',
        des: 'design',
        tcs: 'testcase',
        tsk: 'tasks',
    } as const;

    private showLocalBaseFallbackNoticeIfAny(): void {
        const notice = this.deps.gitService.consumeLocalBaseFallbackNotice();
        if (notice) {
            vscode.window.showInformationMessage(notice);
        }
    }

    private replaceTemplateVars(template: string, vars: Record<string, string>): string {
        let rendered = template;
        for (const [key, value] of Object.entries(vars)) {
            const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rendered = rendered.replace(new RegExp(`{{\\s*${safeKey}\\s*}}`, 'g'), value ?? '');
        }
        return rendered;
    }

    private renderQuickDevPrompt(template: string, task: Task, iterDir: string): string {
        const signalsDir = path.join(iterDir, 'signals');
        const techStack = (this.deps.getConfig().techStack || '').trim();
        const codingStandards = (this.deps.getConfig().codingStandards || '').trim();
        const docsRel = getSpecFileRel(iterDir, this.deps.getConfig(), '').replace(/[/\\]+$/, '') || 'docs';
        const vars: Record<string, string> = {
            currentWorkSpace: iterDir,
            docsDir: docsRel,
            signalsDir,
            taskName: task.name || '',
            taskDesc: task.desc || '',
            subTaskId: task.id,
            subTaskName: task.name || '',
            subTaskOwner: 'FullStack',
            techStack,
            codingStandards,
            designContext: task.desc || '',
            outputFiles: '- (快捷模式未拆分子任务，请按任务描述输出实现文件)',
            acceptanceCriteria: '- 代码可正常编译运行并满足任务描述',
            taskSplitMode: this.resolveTaskSplitMode(task),
            'current ISO timestamp': new Date().toISOString(),
            'list each file you created, one per line': '请按实际创建文件填写',
            'real Task ID from the instruction': task.id,
            'signals directory from the instruction': signalsDir,
        };
        const rendered = this.replaceTemplateVars(template, vars);
        // Final fallback: clear any unreplaced handlebars token so the dispatched prompt
        // never leaks literal {{token}} to the AI when users add custom placeholders.
        return rendered.replace(/{{\s*([^{}]+?)\s*}}/g, (_m, key) => vars[String(key).trim()] ?? '');
    }

    private hasTaskPlan(iterDir: string): boolean {
        const canonical = resolveTaskPlanFileForIteration(iterDir, this.deps.getConfig());
        const legacyFlat = path.join(iterDir, ...TASK_PLAN_PRIMARY_REL_PATH.split('/'));
        const legacyOld = path.join(iterDir, ...TASK_PLAN_LEGACY_REL_PATH.split('/'));
        return fs.existsSync(canonical) || fs.existsSync(legacyFlat) || fs.existsSync(legacyOld);
    }

    async createTask(name: string, desc: string, quickMode?: boolean): Promise<void> {
        const id = `task_${Date.now()}`;
        const cfg = this.deps.getConfig();
        const inferredSplitMode = this.inferTaskSplitMode(name, desc, cfg);
        const newTask: Task = {
            id,
            name,
            desc,
            taskSplitMode: inferredSplitMode,
            stage: STAGE.INITIALIZING,
            autoAdvanceEnabled: cfg.autoAdvanceEnabled,
            autoRepairEnabled: cfg.autoRepairEnabled,
            quickMode: Boolean(quickMode),
        };
        this.deps.getTasks().push(newTask);
        this.deps.ensureIterationDir(newTask);
        // Lazy-init mode: do not auto-create git worktree here.
        // Worktree/checkout is created only when user explicitly opens the task worktree.
        if (newTask.quickMode) {
            newTask.stage = STAGE.DEVELOPING;
        } else {
            newTask.stage = STAGE.WRITING_REQUIREMENT;
        }
        this.deps.saveAndRender();
        if (newTask.quickMode) {
            // Skip requirements/design/testcase/task-split — jump straight to DEVELOPING.
            // Dev Agent runs with only task.desc and project context.
            vscode.window.showInformationMessage('已使用快捷模式：跳过文档生成，直接进入开发');
        } else {
            vscode.window.showInformationMessage(`任务拆分模式已自动判定：${inferredSplitMode === 'compact' ? '急速模式' : '标准模式'}`);
            vscode.window.showInformationMessage('提示：代码目录将在点击任务的 Worktree 按钮时初始化');
        }
    }

    /**
     * Create an iteration task from a workspace todo and return the created task identity.
     */
    async createTaskFromTodo(title: string, description: string): Promise<Task> {
        const normalizedTitle = (title || '').trim();
        if (!normalizedTitle) {
            throw new Error('TODO-PROMOTE-001: 待办标题为空，无法创建迭代任务');
        }

        const normalizedDesc = (description || '').trim();
        const id = `task_${Date.now()}`;
        const cfg = this.deps.getConfig();
        const inferredSplitMode = this.inferTaskSplitMode(normalizedTitle, normalizedDesc, cfg);
        const newTask: Task = {
            id,
            name: normalizedTitle,
            desc: normalizedDesc,
            taskSplitMode: inferredSplitMode,
            stage: STAGE.INITIALIZING,
            autoAdvanceEnabled: cfg.autoAdvanceEnabled,
            autoRepairEnabled: cfg.autoRepairEnabled,
            quickMode: false,
        };

        this.deps.getTasks().push(newTask);
        this.deps.ensureIterationDir(newTask);
        newTask.stage = STAGE.WRITING_REQUIREMENT;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`已从待办创建迭代任务：${newTask.name}`);
        return newTask;
    }

    async resetTaskByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const iterDir = this.deps.getIterationDir(task);
        this.logTaskReset(task, `收到重置请求，当前阶段=${task.stage}`);

        const confirmLabel = '确认重置';
        const answer = await vscode.window.showWarningMessage(
            `重置任务「${task.name}」是不可回滚操作。将清空当前迭代代码与阶段进度，并回到需求阶段起点。是否继续？`,
            { modal: true, detail: '该操作会尝试移除当前迭代 worktree、重建代码目录，并重新从基线初始化。' },
            confirmLabel,
        );
        if (answer !== confirmLabel) {
            this.logTaskReset(task, '用户取消重置');
            return;
        }

        try {
            this.logTaskReset(task, '用户已确认，开始执行重置');
            vscode.window.showInformationMessage(`正在重置任务：${task.name}`);

            this.deps.stopScheduler(task.id);
            this.logTaskReset(task, '已停止自动调度器');

            const detachResult = await this.deps.gitService.detachIterationWorktrees(iterDir);
            if (!detachResult.success && detachResult.errors.length > 0) {
                this.logTaskReset(task, `worktree 清理告警：${detachResult.errors.join('；')}`);
                vscode.window.showWarningMessage(`重置前 worktree 清理存在告警：${detachResult.errors.join('；')}`);
            }

            if (fs.existsSync(iterDir)) {
                if (this.deps.isWorktreeSubview()) {
                    this.logTaskReset(task, '当前为子面板模式，保留 .harness 并清空其余内容');
                    this.clearIterationDirContentsForSubview(iterDir);
                } else {
                    this.logTaskReset(task, `删除迭代目录：${iterDir}`);
                    this.deps.gitService.safeRemovePath(iterDir, { recursive: true });
                }
            }

            task.iterationBranch = undefined;
            task.baseBranchUsed = undefined;
            task.stage = STAGE.INITIALIZING;
            this.logTaskReset(task, '任务状态已重置为 initializing，等待用户打开 Worktree 时重建代码');

            this.deps.ensureIterationDir(task);
            this.deps.saveAndRender();
            task.stage = STAGE.WRITING_REQUIREMENT;
            this.deps.saveAndRender();
            this.logTaskReset(task, `重置完成（懒初始化），当前阶段=${task.stage}`);
            vscode.window.showInformationMessage(`任务已重置：${task.name}（点击 Worktree 按钮时初始化代码）`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendHarnessLog(this.resolveTaskLogDir(task), 'reset', `重置失败：${message}`);
            vscode.window.showErrorMessage(`重置任务失败：${message}`);
        }
    }

    /**
     * In a worktree subview the iteration dir is the current VS Code workspace root,
     * so deleting the folder itself is unsafe. Clear child entries and preserve .harness.
     */
    private clearIterationDirContentsForSubview(iterDir: string): void {
        this.deps.gitService.clearDirChildrenPreserving(iterDir, [BASE]);
    }

    private resolveTaskLogDir(task: Task): string {
        const iterDir = this.deps.getIterationDir(task);
        // Lazy-init safety: before worktree attach, avoid creating iterDir/.harness via logs.
        if (iterDir && fs.existsSync(path.join(iterDir, '.git'))) {
            return iterDir;
        }
        return this.deps.getMasterRoot();
    }

    private logTaskReset(task: Task, message: string): void {
        appendHarnessLog(this.resolveTaskLogDir(task), 'reset', `[${task.id}] ${message}`);
    }

    logUiEventByTaskId(taskId: string, event: string, detail?: string): void {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const suffix = detail ? ` | ${detail}` : '';
        appendHarnessLog(this.resolveTaskLogDir(task), 'webview', `[${task.id}] ${event}${suffix}`);
    }

    updateTaskDescByTaskId(taskId: string, desc: string): void {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const trimmed = desc.trim();
        if (!trimmed) {
            this.logUiEventByTaskId(taskId, 'updateTaskDesc.rejected', 'empty description');
            vscode.window.showWarningMessage('需求描述不能为空');
            return;
        }
        const oldLen = (task.desc || '').length;
        task.desc = trimmed;
        this.deps.saveAndRender();
        this.logUiEventByTaskId(taskId, 'updateTaskDesc.saved', `oldLen=${oldLen};newLen=${trimmed.length}`);
        vscode.window.showInformationMessage(`已更新任务需求描述：${task.name}`);
    }

    async promptUpdateTaskDescByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const input = await vscode.window.showInputBox({
            title: `编辑需求描述：${task.name}`,
            value: task.desc ?? '',
            prompt: '请输入新的需求描述',
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() ? undefined : '需求描述不能为空',
        });

        if (input === undefined) {
            return;
        }

        this.updateTaskDescByTaskId(taskId, input);
    }

    setTaskAutomationByTaskId(taskId: string, aa: boolean, ar: boolean): void {
        const task = this.getTaskById(taskId);
        if (!task) return;
        task.autoAdvanceEnabled = aa;
        task.autoRepairEnabled = ar;
        this.deps.saveAndRender();
    }

    async pushAllByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const iterDir = this.deps.getIterationDir(task);
        vscode.window.showInformationMessage('正在推送代码...');
        const result = await this.deps.gitService.pushAll(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message, { modal: true });
        } else {
            this.syncTaskDocsToMaster(task, iterDir, 'manualPush');
            vscode.window.showInformationMessage(result.message);
        }
    }

    async commitToBaselineByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const iterDir = this.deps.getIterationDir(task);
        vscode.window.showInformationMessage('正在提交并合并到基线...');
        const result = await this.deps.gitService.mergeIterationToTarget(task, iterDir, { cleanup: false });
        if (!result.success) {
            const lines = (result.message || '未知错误').split('\n');
            const brief = lines[0];
            const extra = lines.slice(1).join('\n');
            vscode.window.showErrorMessage(brief, { detail: extra || undefined, modal: true });
            return;
        }
        this.syncTaskDocsToMaster(task, iterDir, 'manualPush');
        vscode.window.showInformationMessage(result.message);
    }

    async runAgentByTaskId(taskId: string, step: HarnessStep, repairFeedback?: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        const shouldUseSchedulerForDev = step === 'dev' && this.hasTaskPlan(iterDir);

        if (step === 'dev' && (!task.quickMode || shouldUseSchedulerForDev)) {
            const scheduler = this.deps.getScheduler(task);
            await scheduler.startAuto(task);
            this.deps.saveAndRender();
            vscode.window.showInformationMessage('已按 tasks.md 子任务链启动开发调度（自动检查并继续下一个）。');
            return;
        }

        if (step === 'des') {
            this.deps.copyProjectStructureToIteration(iterDir);
        }

        this.reconcileStageArtifactPath(task, step);

        const rendered = this.deps.renderAgentPrompt(step, task.name, task.desc, iterDir);
        if (!rendered.content.trim()) {
            vscode.window.showErrorMessage(`未找到可用的 ${step} Prompt，请检查扩展内置 prompts/ 目录。`);
            return;
        }

        const splitMode = this.resolveTaskSplitMode(task);
        const promptContent = step === 'dev' ? this.renderQuickDevPrompt(rendered.content, task, iterDir) : rendered.content;
        const repairSection = this.buildRepairFeedbackSection(repairFeedback);
        const query = `${promptContent}${repairSection}\n\n---\n运行参数：taskSplitMode=${splitMode}`;
        await this.deps.dispatchAi(query, iterDir, 'stage-agent', task.aiProvider);
        vscode.window.showInformationMessage(`已派发 ${step.toUpperCase()} Agent（Prompt来源: ${rendered.source}）`);
        this.startArtifactRepairWatch(task, step);

        if (step === 'tcs') {
            await this.openArtifactByTaskId(taskId, 'testcase');
        } else if (step === 'tsk') {
            await this.openArtifactByTaskId(taskId, 'tasks');
        }
    }

    async openArtifactByTaskId(taskId: string, artifact: 'requirements' | 'design' | 'testcase' | 'tasks' | 'testScript'): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        if (artifact === 'requirements') {
            this.reconcileStageArtifactPath(task, 'req');
        } else if (artifact === 'design') {
            this.reconcileStageArtifactPath(task, 'des');
        } else if (artifact === 'testcase') {
            this.reconcileStageArtifactPath(task, 'tcs');
        } else if (artifact === 'tasks') {
            this.reconcileStageArtifactPath(task, 'tsk');
        }
        const testScriptName = process.platform === 'win32' ? 'test-api.ps1' : 'test-api.sh';
        const cfg = this.deps.getConfig();
        const fileMap = {
            requirements: getSpecFile(iterDir, cfg, 'requirements.md'),
            design: getSpecFile(iterDir, cfg, 'design.md'),
            testcase: getSpecFile(iterDir, cfg, 'testcase.md'),
            tasks: this.resolveTaskPlanFile(iterDir),
            testScript: path.join(iterDir, 'tests', testScriptName),
        } as const;
        const filePath = fileMap[artifact];

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '', 'utf8');
        }

        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    }

    async openFolderLocationByTaskId(
        taskId: string,
        location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend' | 'mono' | 'mainMono'
    ): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const cfg = this.deps.getConfig();
        const isMono = Boolean(cfg.monorepoGit?.trim());
        const dirs = cfg.monorepoDirs || DEFAULT_MONOREPO_DIRS;
        const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const iterDir = this.deps.getIterationDir(task);
        // In monorepo mode the frontend/backend subfolders use the configured names; in multi-repo
        // mode they are the fixed worktree subdirs. The monorepo main repo is a dedicated clone at
        // repos/mono-main; multi-repo mode uses per-side clones under repos/.
        const feSub = isMono ? (dirs.frontend || DEFAULT_MONOREPO_DIRS.frontend) : 'frontend';
        const beSub = isMono ? (dirs.backend || DEFAULT_MONOREPO_DIRS.backend) : 'backend';
        const locationMap = {
            worktree: iterDir,
            mono: iterDir,
            frontend: path.join(iterDir, feSub),
            backend: path.join(iterDir, beSub),
            mainMono: path.join(rootDir, 'repos', 'mono-main'),
            mainFrontend: isMono ? path.join(rootDir, 'repos', 'mono-main') : path.join(rootDir, 'repos', 'frontend-main'),
            mainBackend: isMono ? path.join(rootDir, 'repos', 'mono-main') : path.join(rootDir, 'repos', 'backend-main'),
        } as const;

        // Lazy-init entry point: initialize only when user explicitly opens iteration folders.
        if (location === 'worktree' || location === 'mono' || location === 'frontend' || location === 'backend') {
            const initResult = await this.ensureIterationCodeBeforeOpen(task, iterDir);
            if (!initResult.ok) {
                return;
            }

            // When newly initialized (first time), run worktree-open hooks before opening the window
            if (initResult.wasNewlyCreated && location === 'worktree') {
                await this.runWorktreeOpenHooks(task, iterDir);
            }
        }

        const targetPath = locationMap[location];
        if (!fs.existsSync(targetPath)) {
            vscode.window.showWarningMessage(`目录不存在：${targetPath}`);
            return;
        }

        if (location === 'worktree' || location === 'mono') {
            this.syncConfiguredPathsForWorktree(iterDir);
            this.seedWorktreeHarnessState(task, iterDir);
        }

        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetPath), {
            forceNewWindow: true,
        });
    }

    private syncConfiguredPathsForWorktree(worktreePath: string): void {
        try {
            const sourceRoot = this.resolveMasterWorkspaceRoot();
            if (!sourceRoot) {
                return;
            }

            const entries = this.parseWorktreeSyncEntries(this.deps.getConfig().worktreeSyncPaths || '');
            if (entries.length === 0) {
                return;
            }

            for (const relPath of entries) {
                const sourcePath = path.join(sourceRoot, ...relPath.split('/'));
                const targetPath = path.join(worktreePath, ...relPath.split('/'));
                if (!fs.existsSync(sourcePath)) {
                    continue;
                }
                if (this.normalizePath(sourcePath) === this.normalizePath(targetPath)) {
                    continue;
                }

                if (fs.existsSync(targetPath)) {
                    this.deps.gitService.safeRemovePath(targetPath, { recursive: true });
                }

                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.cpSync(sourcePath, targetPath, {
                    recursive: true,
                    force: true,
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`同步配置目录到 worktree 失败：${message}`);
        }
    }

    private parseWorktreeSyncEntries(raw: string): string[] {
        const input = (raw || '').trim();
        if (!input) {
            return ['.github/instructions', '.spec'];
        }

        const parsed = input
            .split(/[\n,;]+/)
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => item.replace(/\\/g, '/'))
            .map(item => item.replace(/^\.?\//, ''))
            .map(item => item.replace(/^worktree\//i, ''))
            .map(item => item.replace(/^\/+/, ''))
            .map(item => item.replace(/\/+$/, ''))
            .filter(Boolean);

        return Array.from(new Set(parsed));
    }

    private resolveMasterWorkspaceRoot(): string {
        const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (!current) {
            return '';
        }

        const marker = `${path.sep}worktrees${path.sep}`;
        const markerIdx = current.indexOf(marker);
        if (markerIdx >= 0) {
            return current.slice(0, markerIdx);
        }

        return current;
    }

    private normalizePath(inputPath: string): string {
        return inputPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    private seedWorktreeHarnessState(task: Task, worktreePath: string): void {
        try {
            const harnessDir = path.join(worktreePath, BASE);
            fs.mkdirSync(harnessDir, { recursive: true });

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

            const configPath = path.join(harnessDir, 'config.json');
            const configPayload = {
                ...this.deps.getConfig(),
                __harnessConfigOrigin: 'worktreeSnapshot',
                __harnessMasterRoot: workspaceRoot,
            };
            fs.writeFileSync(configPath, JSON.stringify(configPayload, null, 2), 'utf8');

            const snapshot: Task = {
                ...task,
                // Keep absolute path so the worktree window can locate the same iteration folder.
                worktreePath,
            };
            const taskPath = path.join(harnessDir, HARNESS_STATE_FILE);
            fs.writeFileSync(taskPath, JSON.stringify([snapshot], null, 2), 'utf8');
            const legacyTaskPath = path.join(harnessDir, HARNESS_STATE_FILE_LEGACY);
            if (fs.existsSync(legacyTaskPath)) {
                safeRemovePath(legacyTaskPath);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`写入 worktree 面板状态失败：${message}`);
        }
    }

    private async ensureIterationCodeBeforeOpen(
        task: Task,
        iterDir: string
    ): Promise<{ ok: boolean; wasNewlyCreated: boolean }> {
        const cfg = this.deps.getConfig();
        let missing: boolean;
        if (cfg.monorepoGit?.trim()) {
            // Monorepo: the iteration dir root itself is the single git worktree.
            missing = !fs.existsSync(path.join(iterDir, '.git'));
        } else {
            const frontendMissing = Boolean(cfg.frontendGit) && !fs.existsSync(path.join(iterDir, 'frontend', '.git'));
            const backendMissing = Boolean(cfg.backendGit) && !fs.existsSync(path.join(iterDir, 'backend', '.git'));
            missing = frontendMissing || backendMissing;
        }

        if (!missing) {
            return { ok: true, wasNewlyCreated: false };
        }

        vscode.window.showInformationMessage(`检测到代码目录缺失，正在补偿重建：${task.name}`);
        const result = await this.deps.gitService.createIterationBranches(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(`补偿拉取失败：${result.message || '未知错误'}`);
            return { ok: false, wasNewlyCreated: false };
        }

        if (result.baseBranch) {
            task.baseBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`代码补偿完成：${task.name}`);
        this.showLocalBaseFallbackNoticeIfAny();
        return { ok: true, wasNewlyCreated: true };
    }

    async startAutoByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const activeAutoCount = this.deps.getTasks()
            .map(item => this.deps.getScheduler(item))
            .filter(scheduler => scheduler.isAutoMode())
            .length;
        const currentScheduler = this.deps.getScheduler(task);
        const maxConcurrent = Math.max(1, this.deps.getConfig().maxConcurrentAutoTasks || 1);
        if (!currentScheduler.isAutoMode() && activeAutoCount >= maxConcurrent) {
            vscode.window.showWarningMessage(`自动执行槽位已满（${activeAutoCount}/${maxConcurrent}），请先暂停其他任务`);
            return;
        }
        const scheduler = this.deps.getScheduler(task);
        await scheduler.startAuto(task);
        this.deps.saveAndRender();
    }

    pauseAutoByTaskId(taskId: string): void {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        scheduler.pause();
        this.deps.saveAndRender();
    }

    async nextTaskByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        await scheduler.manualNext(task);
        this.deps.saveAndRender();
    }

    async retryTaskByTaskId(taskId: string, subId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        await scheduler.retryTask(subId, task);
        this.deps.saveAndRender();
    }

    async setSubTaskStatusByTaskId(taskId: string, subId: string, status: 'todo' | 'doing' | 'done' | 'failed'): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        scheduler.updateSubTaskStatus(subId, status);
        this.deps.saveAndRender();

        if (status === 'done' && task.stage === STAGE.DEVELOPING && this.deps.getConfig().autoContinueAfterManualDone) {
            await scheduler.startAuto(task);
            this.deps.saveAndRender();
            vscode.window.showInformationMessage(`已手动修正子任务 ${subId} 为完成，并自动继续执行下一子任务`);
            return;
        }

        vscode.window.showInformationMessage(`已手动修正子任务 ${subId} 状态为 ${status}`);
    }

    async nextStageByTaskId(taskId: string, step: HarnessStep, targetStage?: HarnessStep): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const nextAgentStep: Partial<Record<HarnessStep, HarnessStep>> = {
            req: 'des',
            des: 'tcs',
            tcs: 'tsk',
        };

        if (targetStage) {
            // 根据targetStage设置下一个阶段
            if (targetStage === 'tcs') task.stage = STAGE.WRITING_TESTCASE;
            if (targetStage === 'tsk') task.stage = STAGE.WRITING_TASKS;
            if (targetStage === 'dev') task.stage = STAGE.DEVELOPING;

            // Save first to persist stage, then run agent, then render.
            // Calling saveAndRender() before dispatch replaces the webview HTML
            // which can interfere with the subsequent command execution.
            this.deps.saveAndRender();

            // 运行targetStage对应的agent
            try {
                await this.runAgentByTaskId(taskId, targetStage);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`跳转到 ${targetStage.toUpperCase()} 后自动派发 Agent 失败：${message}`);
            }

            this.deps.saveAndRender();
            return;
        }

        if (step === 'req') task.stage = STAGE.WRITING_DESIGN;
        if (step === 'des') task.stage = STAGE.WRITING_TESTCASE;
        if (step === 'tcs') task.stage = STAGE.WRITING_TASKS;
        if (step === 'tsk') task.stage = STAGE.DEVELOPING;
        if (step === 'dev') {
            task.stage = STAGE.READY_FOR_REVIEW;
            this.deps.stopScheduler(task.id);
        }

        this.deps.saveAndRender();

        const followupStep = nextAgentStep[step];
        if (followupStep) {
            await this.runAgentByTaskId(taskId, followupStep);
            vscode.window.showInformationMessage(`已推进到下一阶段，并自动打开 ${followupStep.toUpperCase()} Agent`);
        }
    }

    async autoAdvanceReadyTasks(): Promise<boolean> {
        let changed = false;
        for (const task of this.deps.getTasks()) {
            const step = this.stageToStep(task.stage);
            if (!step) {
                continue;
            }
            if (!this.isTaskAutoAdvanceEnabled(task)) {
                continue;
            }

            // Requirement/Design stages must be manually confirmed by user.
            if (step === 'req' || step === 'des') {
                continue;
            }

            const validation = this.validateStageArtifact(task, step);
            if (!validation.valid) {
                await this.tryAutoRepair(task, step, validation.errors);
                continue;
            }

            this.clearRepairState(task, step);
            if (step === 'tcs') task.stage = STAGE.WRITING_TASKS;
            if (step === 'tsk') {
                // strict gate keeps the task plan as a human gate: pass machine checks,
                // then wait for explicit human confirmation before entering development.
                if (resolveGateLevel(this.deps.getConfig()) === 'strict') {
                    continue;
                }
                task.stage = STAGE.DEVELOPING;
            }
            changed = true;
        }

        if (changed) {
            this.deps.saveAndRender();
        }
        return changed;
    }

    async passByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        const mergeResult = await this.deps.gitService.mergeIterationToTarget(task, iterDir);
        if (!mergeResult.success) {
            const detail = mergeResult.message || '未知错误';
            const lines = detail.split('\n');
            const brief = lines[0];
            const extra = lines.slice(1).join('\n');
            vscode.window.showErrorMessage(
                `合并失败（${task.name}）：${brief}`,
                { detail: extra || undefined, modal: true }
            );
            return;
        }

        task.stage = STAGE.DONE;
        this.deps.onPass(task);
        this.deps.saveAndRender();
        this.syncTaskDocsToMaster(task, iterDir, 'taskDone');
        if (mergeResult.message) {
            vscode.window.showInformationMessage(mergeResult.message);
        }

        // Only purge the iteration directory when git-level cleanup (worktrees + branches) fully
        // succeeded. If something failed there, leave the iteration dir on disk so the user can
        // diagnose without losing local state.
        if (mergeResult.cleanupComplete) {
            const isSubview = this.deps.isWorktreeSubview();
            if (isSubview) {
                // VSCode still has iterDir as its workspace root. Defer the rm to a detached
                // child that survives this extension instance, so deletion happens after the
                // window is closed and file handles are released.
                this.scheduleDetachedIterDirCleanup(iterDir);
            } else {
                try {
                    this.deps.gitService.safeRemovePath(iterDir, { recursive: true });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showWarningMessage(`迭代目录清理失败，请手动删除：${iterDir}（${message}）`);
                }
            }
        }

        if (this.deps.isWorktreeSubview()) {
            await vscode.window.showInformationMessage('当前 worktree 任务已结束，正在关闭窗口...');
            await vscode.commands.executeCommand('workbench.action.closeWindow');
        }
    }

    private scheduleDetachedIterDirCleanup(iterDir: string): void {
        // Sanity: refuse to schedule deletion of suspicious paths (root, cwd of master, etc.).
        const normalized = path.resolve(iterDir);
        if (!normalized || normalized === path.sep || normalized.split(path.sep).filter(Boolean).length < 3) {
            return;
        }
        const escaped = normalized.replace(/"/g, '\\"');
        try {
            const command = this.buildDetachedCleanupCommand(escaped);
            const child = spawn(command.bin, command.args, {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
        } catch {
            // Best-effort: if scheduling fails, the user can manually delete the dir.
        }
    }

    private buildDetachedCleanupCommand(escapedPath: string): { bin: string; args: string[] } {
        if (process.platform === 'win32') {
            const script = `Start-Sleep -Seconds 3; Remove-Item -LiteralPath \"${escapedPath}\" -Recurse -Force -ErrorAction SilentlyContinue`;
            return { bin: 'powershell', args: ['-NoProfile', '-Command', script] };
        }
        return { bin: 'sh', args: ['-c', `sleep 3 && rm -rf "${escapedPath}"`] };
    }

    async syncMainCodeByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        vscode.window.showInformationMessage(`正在同步主仓库代码到 ${task.name}...`);
        const iterDir = this.deps.getIterationDir(task);
        const result = await this.deps.gitService.syncMainCode(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(`同步失败：${result.message}`, { modal: true });
        } else {
            vscode.window.showInformationMessage(result.message);
            this.showLocalBaseFallbackNoticeIfAny();
        }
    }

    /**
     * Runs a user-defined custom button. The script is resolved from the button's configured
     * source ('master' shared dir, or this iteration's committed 'worktree' scripts). Clicking
     * opens a terminal whose cwd is THIS task's worktree iteration directory and runs the
     * resolved script there.
     */
    async runCustomButtonByTaskId(taskId: string, buttonId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        let raw = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        if (!raw || !normalizeCustomButton(raw).script) {
            // Config may be stale in worktree subview — reload from disk and retry.
            this.deps.reloadConfig?.();
            raw = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        }
        if (!raw) {
            vscode.window.showWarningMessage('未找到对应的自定义按钮，请在「高级设置」中重新配置');
            return;
        }
        const button = normalizeCustomButton(raw);
        if (!button.script) {
            vscode.window.showWarningMessage(`自定义按钮「${button.name}」未选择脚本`);
            return;
        }

        const iterDir = this.deps.getIterationDir(task);
        const initResult = await this.ensureIterationCodeBeforeOpen(task, iterDir);
        if (!initResult.ok) return;
        if (!fs.existsSync(iterDir)) {
            vscode.window.showWarningMessage(`迭代目录不存在，无法执行：${iterDir}`);
            return;
        }

        // Run the script from the worktree iteration dir.
        this.launchCustomButton(button, iterDir, true, `迭代目录不存在：{dir}`, task.name);
    }

    /**
     * Runs a 'main' placement custom button — one that belongs to no task iteration. It is
     * rendered in the main panel's dedicated area and runs against the master workspace root.
     */
    async runStandaloneCustomButton(buttonId: string): Promise<void> {
        const raw = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        if (!raw) {
            vscode.window.showWarningMessage('未找到对应的自定义按钮，请在「高级设置」中重新配置');
            return;
        }
        const button = normalizeCustomButton(raw);
        if (!button.script) {
            vscode.window.showWarningMessage(`自定义按钮「${button.name}」未选择脚本`);
            return;
        }

        const masterRoot = this.deps.getMasterRoot();
        if (!fs.existsSync(masterRoot)) {
            vscode.window.showWarningMessage(`主工作区目录不存在，无法执行：${masterRoot}`);
            return;
        }
        this.launchCustomButton(button, masterRoot, false, `主工作区目录不存在：{dir}`, '主面板');
    }

    /**
     * Resolve the absolute directory a button's script lives in, honoring its scriptSource:
     * - 'master':   `<masterRoot>/script/`.
     * - 'worktree': the committed scripts dir inside THIS iteration worktree (iteration context),
     *               falling back to the main clone for 'main'-placement buttons.
     *               In multi-repo mode, searches frontend-main then backend-main (or their
     *               worktree equivalents) to locate the script.
     * `runBaseDir` is the iteration worktree dir for iteration buttons, else the master root.
     */
    private resolveScriptDir(button: CustomButton, runBaseDir: string, isIterationContext: boolean): string {
        const masterRoot = this.deps.getMasterRoot();
        const config = this.deps.getConfig();
        const isMono = Boolean((config.monorepoGit || '').trim());
        const scriptsSubdir = getScriptsSubdir(config);
        const source = button.scriptSource || 'master';

        if (source === 'master') {
            return path.join(masterRoot, CUSTOM_SCRIPT_DIR);
        }

        const repoScriptsDir = (): string => {
            if (isMono) {
                return path.join(masterRoot, 'repos', 'mono-main', scriptsSubdir);
            }
            // Multi-repo: try frontend-main first, fall back to backend-main.
            const feDir = path.join(masterRoot, 'repos', 'frontend-main', scriptsSubdir);
            const script = (button.script || '').trim();
            if (script && fs.existsSync(path.join(feDir, script))) {
                return feDir;
            }
            return path.join(masterRoot, 'repos', 'backend-main', scriptsSubdir);
        };

        if (source === 'worktree' && isIterationContext) {
            if (isMono) {
                return path.join(runBaseDir, scriptsSubdir);
            }
            // Multi-repo worktree: try frontend subdir first, fall back to backend.
            const feDir = path.join(runBaseDir, 'frontend', scriptsSubdir);
            const script = (button.script || '').trim();
            if (script && fs.existsSync(path.join(feDir, script))) {
                return feDir;
            }
            return path.join(runBaseDir, 'backend', scriptsSubdir);
        }
        // 'worktree' with no worktree (main-panel button): use the main clone.
        return repoScriptsDir();
    }

    /**
     * Shared launcher for custom buttons. The terminal cwd is always `baseDir` (the iteration
     * worktree dir or master root); the script itself handles any sub-navigation.
     */
    private launchCustomButton(button: CustomButton, baseDir: string, isIterationContext: boolean, missingDirTpl: string, label: string): void {
        const script = (button.script || '').trim();
        const extraArgs = (button.args || '').trim();
        const runDir = baseDir;

        const scriptDir = this.resolveScriptDir(button, baseDir, isIterationContext);
        const scriptPath = path.join(scriptDir, script);

        if (!fs.existsSync(scriptPath)) {
            vscode.window.showWarningMessage(`脚本不存在：${scriptPath}。请确认脚本仍位于所选来源目录中。`);
            return;
        }

        const runCmd = this.buildCustomButtonCommand(scriptPath, extraArgs ? ` ${extraArgs}` : '');
        const terminalName = `Fun Harness ${label} ${button.name}`;
        const existing = vscode.window.terminals.find(t => t.name === terminalName);
        if (existing) {
            // Force-stop any currently running process in this named terminal, then run fresh.
            existing.dispose();
        }
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: runDir,
        });
        terminal.show(true);
        terminal.sendText(runCmd, true);
        vscode.window.showInformationMessage(`已在 ${label} 执行「${button.name}」：${runCmd}`);
    }

    /**
     * Build the shell invocation for a master script per the current OS, keeping spaces
     * in the path safe. The same script file yields a different launch command on
     * Windows vs. macOS/Linux.
     */
    private buildCustomButtonCommand(scriptPath: string, extraArgs: string): string {
        const quoted = `"${scriptPath}"`;
        const lower = scriptPath.toLowerCase();
        const isWin = process.platform === 'win32';
        if (lower.endsWith('.ps1')) {
            // Windows ships powershell.exe; elsewhere fall back to PowerShell Core (pwsh).
            return isWin
                ? `powershell -ExecutionPolicy Bypass -File ${quoted}${extraArgs}`
                : `pwsh -File ${quoted}${extraArgs}`;
        }
        if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
            // Batch files run on Windows shells; invoke by path directly.
            return `${quoted}${extraArgs}`;
        }
        if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
            // Prefix bash so the script runs even without the executable bit
            // (and via Git Bash / WSL when on Windows).
            return `bash ${quoted}${extraArgs}`;
        }
        return `${quoted}${extraArgs}`;
    }

    async completeDevWithPush(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        
        // First: Push all code to remote
        vscode.window.showInformationMessage('正在推送代码...');
        const result = await this.deps.gitService.pushAll(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message, { modal: true });
            return;
        }
        this.syncTaskDocsToMaster(task, iterDir, 'manualPush');

        // Then: Mark as complete development (change to READY_FOR_REVIEW)
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.nextStageByTaskId(taskId, 'dev');
    }

    async pushAndNextStage(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        
        // First: Push all code to remote
        vscode.window.showInformationMessage('正在推送代码...');
        const result = await this.deps.gitService.pushAll(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message, { modal: true });
            return;
        }
        this.syncTaskDocsToMaster(task, iterDir, 'manualPush');

        // Then: Change to READY_FOR_REVIEW stage
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.nextStageByTaskId(taskId, 'dev');
    }

    private async initializeTaskGit(task: Task): Promise<void> {
        task.stage = STAGE.INITIALIZING;
        this.deps.saveAndRender();

        const iterDir = this.deps.getIterationDir(task);
        const result = await this.deps.gitService.createIterationBranches(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message || '迭代初始化失败');
            return;
        }

        if (result.baseBranch) {
            task.baseBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }

        task.stage = STAGE.WRITING_REQUIREMENT;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(result.message || '✅ 迭代初始化完成');
        this.showLocalBaseFallbackNoticeIfAny();
    }

    private getTaskById(taskId: string): Task | undefined {
        return this.deps.getTasks().find((task) => task.id === taskId);
    }

    private stageToStep(stage: Task['stage']): Exclude<HarnessStep, 'dev'> | null {
        if (stage === STAGE.WRITING_REQUIREMENT) return 'req';
        if (stage === STAGE.WRITING_DESIGN) return 'des';
        if (stage === STAGE.WRITING_TESTCASE) return 'tcs';
        if (stage === STAGE.WRITING_TASKS) return 'tsk';
        return null;
    }

    private validateStageArtifact(task: Task, step: Exclude<HarnessStep, 'dev'>): { valid: boolean; errors: string[] } {
        this.reconcileStageArtifactPath(task, step);
        const iterDir = this.deps.getIterationDir(task);
        const cfg = this.deps.getConfig();
        const fileNameMap = {
            req: 'requirements.md',
            des: 'design.md',
            tcs: 'testcase.md',
        } as const;
        const filePath = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : getSpecFile(iterDir, cfg, fileNameMap[step]);
        const errors: string[] = [];

        if (!fs.existsSync(filePath)) {
            if (step === 'tsk') {
                return { valid: false, errors: [`缺少文件 ${getSpecFileRel(iterDir, cfg, 'tasks.md')}（兼容 ${TASK_PLAN_LEGACY_REL_PATH}）`] };
            }
            return { valid: false, errors: [`缺少文件 ${getSpecFileRel(iterDir, cfg, fileNameMap[step])}`] };
        }

        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) {
            const relPath = step === 'tsk'
                ? this.toRelativeIterationPath(iterDir, filePath)
                : getSpecFileRel(iterDir, cfg, fileNameMap[step]);
            return { valid: false, errors: [`${relPath} 为空`] };
        }

        const rules: Record<Exclude<HarnessStep, 'dev'>, Array<{ test: RegExp; message: string }>> = {
            req: [
                { test: /^#\s*需求文档/m, message: '缺少“需求文档”标题' },
                { test: /^##\s*需求清单/m, message: '缺少“需求清单”章节' },
                { test: /^###\s*需求-\d+[：:]/m, message: '缺少至少一个需求条目' },
                { test: /^####\s*验收标准/m, message: '缺少“验收标准”小节' },
                { test: /artifactType:\s*requirements/m, message: '缺少 requirements 机器块' },
                { test: /requirements:\s*/m, message: '机器块中缺少 requirements 列表' },
            ],
            des: [
                { test: /^#\s*设计文档/m, message: '缺少“设计文档”标题' },
                { test: /^###\s*3\.1\s*API\s*契约|^##\s*3\.1\s*API\s*契约/m, message: '缺少 API 契约章节' },
                { test: /^##\s*4\.\s*正确性属性|^##\s*4\s*正确性属性/m, message: '缺少正确性属性章节' },
                { test: /artifactType:\s*design/m, message: '缺少 design 机器块' },
                { test: /apiContracts:\s*/m, message: '机器块中缺少 apiContracts 列表' },
                { test: /invariants:\s*/m, message: '机器块中缺少 invariants 列表' },
            ],
            tcs: [
                { test: /^#\s*测试用例文档/m, message: '缺少“测试用例文档”标题' },
                { test: /^##\s*3\.\s*用例清单|^##\s*3\s*用例清单/m, message: '缺少用例清单章节' },
                { test: /^###\s*TC-\d+/m, message: '缺少至少一个测试用例' },
                { test: /artifactType:\s*testcase/m, message: '缺少 testcase 机器块' },
                { test: /testCases:\s*/m, message: '机器块中缺少 testCases 列表' },
            ],
            tsk: [
                { test: /^#\s*任务拆解文档/m, message: '缺少“任务拆解文档”标题' },
                { test: /^##\s*任务清单/m, message: '缺少任务清单章节' },
                { test: /^-\s*\[([ xX]|doing|failed)\]\s*\d+\.\d+/m, message: '缺少至少一个任务项' },
                { test: /artifactType:\s*tasks/m, message: '缺少 tasks 机器块' },
                { test: /tasks:\s*/m, message: '机器块中缺少 tasks 列表' },
            ],
        };

        for (const rule of rules[step]) {
            if (!rule.test.test(content)) {
                errors.push(rule.message);
            }
        }

        if (step === 'tcs') {
            const iterDir = this.deps.getIterationDir(task);
            const manifestPath = path.join(iterDir, 'tests', 'test-manifest.json');
            if (!fs.existsSync(manifestPath)) {
                errors.push('缺少 tests/test-manifest.json');
            } else {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
                    errors.push(...this.validateTestManifestSchema(manifest));
                    const scriptRequired = this.isTestScriptRequired(manifest);
                    if (scriptRequired) {
                        if (!/BEGIN_SCRIPT/m.test(content)) {
                            errors.push('缺少 BEGIN_SCRIPT 脚本块');
                        }
                        if (!/END_SCRIPT/m.test(content)) {
                            errors.push('缺少 END_SCRIPT 脚本块');
                        }
                    }
                    errors.push(...this.validateTestScriptFromManifest(iterDir, manifest));
                } catch {
                    errors.push('test-manifest.json 不是合法 JSON');
                }
            }
        }

        // Semantic traceability hard gate: cross-artifact Req-* ID closure.
        if ((step === 'des' || step === 'tcs' || step === 'tsk')) {
            const reqPath = getSpecFile(iterDir, cfg, 'requirements.md');
            if (!fs.existsSync(reqPath)) {
                errors.push('缺少 requirements.md，无法完成追溯闭环校验');
            } else {
                const reqContent = fs.readFileSync(reqPath, 'utf8');
                // relaxed gate only enforces reference integrity (no dangling); coverage closure is off.
                const enforceCoverage = resolveGateLevel(cfg) !== 'relaxed';
                errors.push(...validateTraceability(reqContent, content, step, enforceCoverage));
            }
        }

        return { valid: errors.length === 0, errors };
    }

    private validateTestManifestSchema(manifest: Record<string, unknown>): string[] {
        const errors: string[] = [];
        if (manifest.artifactType !== 'test-manifest') {
            errors.push('test-manifest.json 缺少 artifactType=test-manifest');
        }

        const taskName = manifest.taskName;
        if (typeof taskName !== 'string' || !taskName.trim()) {
            errors.push('test-manifest.json 缺少 taskName');
        }

        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            errors.push('test-manifest.json 缺少 script 对象');
        } else {
            const scriptObj = script as Record<string, unknown>;
            const required = scriptObj.required;
            const scriptRequired = required === undefined ? true : required === true;
            if (required !== undefined && typeof required !== 'boolean') {
                errors.push('test-manifest.json script.required 必须是布尔值');
            }

            if (scriptRequired) {
                if (scriptObj.os !== 'windows' && scriptObj.os !== 'non-windows') {
                    errors.push('test-manifest.json script.os 必须是 windows 或 non-windows');
                }
                if (typeof scriptObj.path !== 'string' || !String(scriptObj.path).startsWith('tests/')) {
                    errors.push('test-manifest.json script.path 必须位于 tests/ 目录');
                }
            } else {
                const reason = scriptObj.reason;
                if (typeof reason !== 'string' || !reason.trim()) {
                    errors.push('script.required=false 时必须提供 script.reason');
                }
            }
        }

        const testCases = manifest.testCases;
        if (!Array.isArray(testCases) || testCases.length === 0) {
            errors.push('test-manifest.json 缺少 testCases 列表');
            return errors;
        }

        testCases.forEach((item, idx) => {
            const prefix = `testCases[${idx}]`;
            if (!item || typeof item !== 'object') {
                errors.push(`${prefix} 必须是对象`);
                return;
            }
            const tc = item as Record<string, unknown>;
            if (typeof tc.id !== 'string' || !tc.id.startsWith('TC-')) {
                errors.push(`${prefix}.id 必须是 TC- 开头`);
            }
            if (!Array.isArray(tc.requirementIds) || tc.requirementIds.length === 0) {
                errors.push(`${prefix}.requirementIds 不能为空`);
            }

            const api = tc.api;
            if (!api || typeof api !== 'object') {
                errors.push(`${prefix}.api 缺失`);
            } else {
                const apiObj = api as Record<string, unknown>;
                if (typeof apiObj.method !== 'string' || !apiObj.method.trim()) {
                    errors.push(`${prefix}.api.method 缺失`);
                }
                if (typeof apiObj.path !== 'string' || !String(apiObj.path).startsWith('/')) {
                    errors.push(`${prefix}.api.path 必须以 / 开头`);
                }
            }

            if (!['normal', 'boundary', 'exception'].includes(String(tc.scenario || ''))) {
                errors.push(`${prefix}.scenario 必须是 normal|boundary|exception`);
            }
            if (typeof tc.expectedStatus !== 'number') {
                errors.push(`${prefix}.expectedStatus 必须是数字`);
            }
        });

        return errors;
    }

    private validateTestScriptFromManifest(iterDir: string, manifest: Record<string, unknown>): string[] {
        const errors: string[] = [];
        if (!this.isTestScriptRequired(manifest)) {
            return errors;
        }
        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            return errors;
        }

        const scriptObj = script as Record<string, unknown>;
        const scriptRel = typeof scriptObj.path === 'string' ? scriptObj.path : '';
        if (!scriptRel.startsWith('tests/')) {
            return errors;
        }

        const scriptPath = path.join(iterDir, scriptRel);
        if (!fs.existsSync(scriptPath)) {
            errors.push(`缺少 ${scriptRel}（请由 testcase Agent 直接生成脚本文件）`);
            return errors;
        }

        const content = fs.readFileSync(scriptPath, 'utf8');
        if (!content.trim()) {
            errors.push(`${scriptRel} 为空`);
            return errors;
        }

        if (!/(PASS|FAIL)/i.test(content)) {
            errors.push(`${scriptRel} 缺少 PASS/FAIL 输出`);
        }
        if (!/exit\s+0|exit\s+1/i.test(content)) {
            errors.push(`${scriptRel} 缺少明确退出码（exit 0/1）`);
        }

        return errors;
    }

    private isTestScriptRequired(manifest: Record<string, unknown>): boolean {
        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            return true;
        }
        const required = (script as Record<string, unknown>).required;
        if (required === undefined) {
            return true;
        }
        return required === true;
    }

    private async tryAutoRepair(task: Task, step: Exclude<HarnessStep, 'dev'>, errors: string[]): Promise<void> {
        const cfg = this.deps.getConfig();
        if (!this.isTaskAutoRepairEnabled(task, cfg)) {
            return;
        }

        const key = `${task.id}:${step}`;
        if (this.repairingKeys.has(key)) {
            return;
        }

        // Already escalated to a human gate: stop auto-looping until a human intervenes.
        if (this.escalatedRepairKeys.has(key)) {
            return;
        }

        const signature = this.buildArtifactSignature(task, step, errors);
        const lastSig = this.lastAutoRepairSignature.get(key);
        if (lastSig === signature) {
            return;
        }

        const now = Date.now();
        const last = this.lastAutoRepairAt.get(key) || 0;
        if (now - last < 10000) {
            return;
        }

        const attempts = (this.repairAttempts.get(key) || 0) + 1;
        if (attempts > HarnessActionsService.MAX_AUTO_REPAIR_ATTEMPTS) {
            this.escalateRepair(task, step, errors);
            return;
        }
        this.repairAttempts.set(key, attempts);

        this.lastAutoRepairAt.set(key, now);
        this.lastAutoRepairSignature.set(key, signature);
        this.repairingKeys.add(key);

        try {
            const feedback = this.buildRepairFeedbackContent(step, attempts, errors);
            await this.runAgentByTaskId(task.id, step, feedback);
            vscode.window.showInformationMessage(
                `已触发自动回修（第 ${attempts}/${HarnessActionsService.MAX_AUTO_REPAIR_ATTEMPTS} 次）：${task.name} ${step}（${errors.slice(0, 2).join('；')}）`
            );
        } finally {
            this.repairingKeys.delete(key);
        }
    }

    /** Escalate to a human gate after exhausting auto-repair attempts (no silent stop). */
    private escalateRepair(task: Task, step: Exclude<HarnessStep, 'dev'>, errors: string[]): void {
        const key = `${task.id}:${step}`;
        this.escalatedRepairKeys.add(key);
        const detail = errors.slice(0, 5).map((e) => `• ${e}`).join('\n');
        vscode.window.showWarningMessage(
            `自动回修已达上限（${HarnessActionsService.MAX_AUTO_REPAIR_ATTEMPTS} 次），需人工介入：${task.name} ${step.toUpperCase()}`,
            { modal: false, detail }
        );
        appendHarnessLog(
            this.deps.getIterationDir(task),
            'auto-repair',
            `escalated ${key} after ${HarnessActionsService.MAX_AUTO_REPAIR_ATTEMPTS} attempts: ${errors.join(' | ')}`
        );
    }

    /** Reset repair bookkeeping once a stage validates cleanly (or a human re-triggers it). */
    private clearRepairState(task: Task, step: Exclude<HarnessStep, 'dev'>): void {
        const key = `${task.id}:${step}`;
        this.repairAttempts.delete(key);
        this.escalatedRepairKeys.delete(key);
        this.lastAutoRepairSignature.delete(key);
    }

    /** Compose the runtime "回修指令" appended to a regenerated prompt so repair is targeted. */
    private buildRepairFeedbackContent(step: Exclude<HarnessStep, 'dev'>, attempt: number, errors: string[]): string {
        const list = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
        return [
            `本次为第 ${attempt} 次自动回修。上一版 ${step.toUpperCase()} 产物未通过机器门禁，请针对以下失败项做最小修正，并保持其余内容稳定：`,
            list,
            '要求：只修复上述问题，不要重写无关章节；确保机器可读 YAML 区与追溯 ID 闭环（无悬空引用、无未覆盖需求）。',
        ].join('\n');
    }

    /** Wrap repair feedback as a clearly-delimited section for injection into the agent query. */
    private buildRepairFeedbackSection(repairFeedback?: string): string {
        const trimmed = (repairFeedback || '').trim();
        if (!trimmed) {
            return '';
        }
        return `\n\n---\n## 回修指令（最高优先，针对性修复）\n${trimmed}`;
    }

    private buildArtifactSignature(task: Task, step: Exclude<HarnessStep, 'dev'>, errors: string[]): string {
        const fileNameMap = {
            req: 'requirements.md',
            des: 'design.md',
            tcs: 'testcase.md',
        } as const;
        const iterDir = this.deps.getIterationDir(task);
        const file = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : getSpecFile(iterDir, this.deps.getConfig(), fileNameMap[step]);
        const statPart = fs.existsSync(file) ? `mtime:${fs.statSync(file).mtimeMs}` : 'missing';
        const errPart = errors.slice(0, 3).join('|');
        return `${statPart}|${errPart}`;
    }

    private resolveTaskPlanFile(iterDir: string): string {
        return resolveTaskPlanFileForIteration(iterDir, this.deps.getConfig());
    }

    private stageArtifactFileName(step: Exclude<HarnessStep, 'dev'>): string {
        const fileMap = {
            req: 'requirements.md',
            des: 'design.md',
            tcs: 'testcase.md',
            tsk: 'tasks.md',
        } as const;
        return fileMap[step];
    }

    private reconcileStageArtifactPath(task: Task, step: HarnessStep): boolean {
        if (step === 'dev') {
            return false;
        }

        const iterDir = this.deps.getIterationDir(task);
        const cfg = this.deps.getConfig();
        const fileName = this.stageArtifactFileName(step);
        const canonicalAbs = getSpecFile(iterDir, cfg, fileName);
        const canonicalRel = getSpecFileRel(iterDir, cfg, fileName);
        fs.mkdirSync(path.dirname(canonicalAbs), { recursive: true });
        const canonicalReady = fs.existsSync(canonicalAbs) && fs.readFileSync(canonicalAbs, 'utf8').trim().length > 0;
        if (canonicalReady) {
            return true;
        }

        const candidates = [
            path.join(iterDir, fileName),
            path.join(iterDir, 'doc', fileName),
            path.join(iterDir, '.harness', 'staging', fileName),
            path.join(iterDir, '.harness', 'artifacts', fileName),
        ];

        // Legacy docs-based spec location (docs/<file> or docs/<task>/<file>), used to migrate
        // iterations created before specRootDir. Task-scoped in mono mode, so always safe to include.
        const legacySpecCandidate = path.join(iterDir, ...getLegacySpecDocsRelSegments(iterDir, cfg), fileName);
        if (this.normalize(legacySpecCandidate) !== this.normalize(canonicalAbs)) {
            candidates.unshift(legacySpecCandidate);
        }

        const docsRootCandidate = path.join(iterDir, getDocsRootDirName(cfg), fileName);
        if (!isMonoMode(cfg)) {
            // Legacy flat docs-root location (docs/<file>) for non-monorepo mode.
            candidates.unshift(docsRootCandidate);
        } else if (this.isLegacyMonoArtifactForTask(docsRootCandidate, fileName, path.basename(iterDir))) {
            // In monorepo mode, only migrate docs-root files that clearly belong to this
            // iteration task to avoid consuming repository-level project documents.
            candidates.unshift(docsRootCandidate);
        }

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate) || this.normalize(candidate) === this.normalize(canonicalAbs)) {
                continue;
            }
            const content = fs.readFileSync(candidate, 'utf8');
            if (!content.trim()) {
                continue;
            }
            fs.writeFileSync(canonicalAbs, content, 'utf8');
            try {
                safeRemovePath(candidate);
            } catch {
                // ignore delete errors and keep canonical copy.
            }
            vscode.window.showInformationMessage(`已自动修复 ${fileName} 路径到 ${canonicalRel}`);
            return true;
        }

        return false;
    }

    private isLegacyMonoArtifactForTask(filePath: string, fileName: string, taskName: string): boolean {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            return false;
        }
        if (!content.trim()) {
            return false;
        }

        const artifactTypeMap: Record<string, string> = {
            'requirements.md': 'requirements',
            'design.md': 'design',
            'testcase.md': 'testcase',
            'tasks.md': 'tasks',
        };
        const artifactType = artifactTypeMap[fileName];
        if (!artifactType) {
            return false;
        }

        const escapedTaskName = taskName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const typePattern = new RegExp(`artifactType\\s*:\\s*${artifactType}\\b`, 'i');
        const taskPattern = new RegExp(`taskName\\s*:\\s*["']?${escapedTaskName}["']?\\b`, 'i');
        return typePattern.test(content) && taskPattern.test(content);
    }

    private startArtifactRepairWatch(task: Task, step: HarnessStep): void {
        if (step === 'dev' || step === 'tsk') {
            return;
        }
        const key = `${task.id}:${step}`;
        const existing = this.artifactRepairTimers.get(key);
        if (existing) {
            clearInterval(existing);
        }

        const startedAt = Date.now();
        const timer = setInterval(() => {
            const fixed = this.reconcileStageArtifactPath(task, step);
            if (fixed || Date.now() - startedAt > 180000) {
                clearInterval(timer);
                this.artifactRepairTimers.delete(key);
            }
        }, 2000);
        this.artifactRepairTimers.set(key, timer);
    }

    private normalize(inputPath: string): string {
        return inputPath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    }

    private syncTaskDocsToMaster(task: Task, iterDir: string, trigger: 'manualPush' | 'taskDone'): void {
        try {
            // Iteration-docs-to-root archival is only meaningful in multi-repo mode. In monorepo mode
            // the git merge of the iteration branch already propagates docs into the main repo, so
            // this manual copy-back would be redundant.
            const cfg = this.deps.getConfig();
            if (Boolean(cfg.monorepoGit?.trim())) {
                return;
            }
            const sourceRequirements = resolveSpecFile(iterDir, cfg, 'requirements.md');
            const sourceDesign = resolveSpecFile(iterDir, cfg, 'design.md');
            const masterRoot = this.resolveMasterWorkspaceRoot();
            if (!masterRoot) {
                return;
            }

            const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
            const targetRequirements = path.join(masterRoot, 'docs', 'requirements', `requirements-${safeName}.md`);
            const targetDesign = path.join(masterRoot, 'docs', 'designs', `designs-${safeName}.md`);

            const copied: string[] = [];
            let requirementsSynced = false;
            let designSynced = false;
            if (this.copyNonEmptyFile(sourceRequirements, targetRequirements)) {
                copied.push('requirements');
                requirementsSynced = true;
            }
            if (this.copyNonEmptyFile(sourceDesign, targetDesign)) {
                copied.push('design');
                designSynced = true;
            }

            this.updateArtifactIndex(masterRoot, task, trigger, {
                requirementsPath: requirementsSynced ? targetRequirements : undefined,
                designPath: designSynced ? targetDesign : undefined,
            });

            if (copied.length > 0) {
                const tip = trigger === 'taskDone' ? '任务完成后已归档文档' : '提交代码后已归档文档';
                vscode.window.showInformationMessage(`${tip}：${copied.join('、')}（taskId=${task.id}）`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`归档需求/设计文档失败：${message}`);
        }
    }

    private copyNonEmptyFile(sourcePath: string, targetPath: string): boolean {
        if (!fs.existsSync(sourcePath)) {
            return false;
        }
        const content = fs.readFileSync(sourcePath, 'utf8');
        if (!content.trim()) {
            return false;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf8');
        return true;
    }

    private updateArtifactIndex(
        masterRoot: string,
        task: Task,
        trigger: 'manualPush' | 'taskDone',
        paths: { requirementsPath?: string; designPath?: string }
    ): void {
        const indexPath = path.join(masterRoot, 'docs', 'artifacts-index.json');
        const now = new Date().toISOString();

        let data: ArtifactIndexFile = {
            version: 1,
            updatedAt: now,
            items: [],
        };

        if (fs.existsSync(indexPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Partial<ArtifactIndexFile>;
                if (Array.isArray(raw.items)) {
                    data = {
                        version: 1,
                        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
                        items: raw.items.filter((item): item is ArtifactIndexItem => Boolean(item && typeof item.taskId === 'string')),
                    };
                }
            } catch {
                // Keep default empty index when existing file is malformed.
            }
        }

        const existing = data.items.find(item => item.taskId === task.id);
        if (existing) {
            existing.taskName = task.name;
            existing.updatedAt = now;
            existing.trigger = trigger;
            if (paths.requirementsPath) {
                existing.requirementsPath = this.toWorkspaceLikePath(masterRoot, paths.requirementsPath);
            }
            if (paths.designPath) {
                existing.designPath = this.toWorkspaceLikePath(masterRoot, paths.designPath);
            }
        } else {
            data.items.push({
                taskId: task.id,
                taskName: task.name,
                updatedAt: now,
                trigger,
                ...(paths.requirementsPath ? { requirementsPath: this.toWorkspaceLikePath(masterRoot, paths.requirementsPath) } : {}),
                ...(paths.designPath ? { designPath: this.toWorkspaceLikePath(masterRoot, paths.designPath) } : {}),
            });
        }

        data.updatedAt = now;
        data.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        fs.mkdirSync(path.dirname(indexPath), { recursive: true });
        fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf8');
    }

    private toWorkspaceLikePath(masterRoot: string, absPath: string): string {
        const rel = path.relative(masterRoot, absPath).replace(/\\/g, '/');
        return rel || absPath;
    }

    private toRelativeIterationPath(iterDir: string, absPath: string): string {
        return path.relative(iterDir, absPath).replace(/\\/g, '/');
    }

    private isTaskAutoAdvanceEnabled(task: Task): boolean {
        if (typeof task.autoAdvanceEnabled === 'boolean') {
            return task.autoAdvanceEnabled;
        }
        return this.deps.getConfig().autoAdvanceEnabled;
    }

    private isTaskAutoRepairEnabled(task: Task, cfg?: Config): boolean {
        if (typeof task.autoRepairEnabled === 'boolean') {
            return task.autoRepairEnabled;
        }
        return (cfg || this.deps.getConfig()).autoRepairEnabled;
    }

    private resolveTaskSplitMode(task: Task): 'standard' | 'compact' {
        const cfg = this.deps.getConfig();
        if (cfg.compactTaskDecomposition) {
            return 'compact';
        }
        if (!cfg.autoDetectTaskSplitMode) {
            return 'standard';
        }
        if (task.taskSplitMode) {
            return task.taskSplitMode;
        }
        return this.inferTaskSplitMode(task.name, task.desc, cfg);
    }

    private inferTaskSplitMode(name: string, desc: string, cfg: Config): 'standard' | 'compact' {
        if (!cfg.autoDetectTaskSplitMode) {
            return 'standard';
        }
        const text = `${name || ''} ${desc || ''}`.trim().toLowerCase();
        if (!text) {
            return 'standard';
        }

        const complexKeywords = this.parseKeywords(cfg.complexTaskKeywords);
        if (complexKeywords.some(keyword => text.includes(keyword))) {
            return 'standard';
        }

        const simpleKeywords = this.parseKeywords(cfg.simpleTaskKeywords);
        const looksSimpleByKeyword = simpleKeywords.some(keyword => text.includes(keyword));
        const looksSimpleByLength = text.length <= 80;
        const sentenceCount = text.split(/[。！？.!?;；\n]/).map(item => item.trim()).filter(Boolean).length;

        if (looksSimpleByKeyword && (looksSimpleByLength || sentenceCount <= 2)) {
            return 'compact';
        }
        if (looksSimpleByLength && sentenceCount <= 1) {
            return 'compact';
        }

        return 'standard';
    }

    private parseKeywords(raw: string): string[] {
        return (raw || '')
            .split(',')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);
    }

    /**
     * Resolve the absolute path to a Hook script based on its scriptSource.
     * Mirrors the CustomButton path resolution logic.
     * - master: <masterRoot>/script/<entry.script>
     * - worktree: iteration-context scripts directory (from resolveScriptDir)
     */
    private resolveHookScriptPath(entry: HookEntry, iterDir: string): string {
        const masterRoot = this.deps.getMasterRoot();
        const config = this.deps.getConfig();
        const source = entry.scriptSource || 'master';

        if (source === 'master') {
            return path.join(masterRoot, CUSTOM_SCRIPT_DIR, entry.script);
        }

        // For 'worktree' source, reuse resolveScriptDir by adapting HookEntry to CustomButton shape
        const adaptedButton: CustomButton = {
            id: 'hook-temp',
            name: 'hook-temp',
            script: entry.script,
            scriptSource: 'worktree',
            placement: 'iteration',
        };
        const scriptDir = this.resolveScriptDir(adaptedButton, iterDir, true);
        return path.join(scriptDir, entry.script);
    }

    /**
     * Spawn and execute a single Hook script asynchronously.
     * Handles missing files, OS incompatibility, and non-zero exit codes gracefully.
     * All errors are non-blocking: the promise always resolves (never rejects).
     */
    private spawnHookAsync(
        entry: HookEntry,
        iterDir: string,
        taskName: string,
        logDir: string
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            const scriptName = entry.script;
            const scriptArgs = (entry.args || '').trim();

            // Skip scripts incompatible with the current OS
            if (!isOsScriptFile(scriptName)) {
                appendHarnessLog(logDir, 'hook', `SKIP_OS: ${scriptName}`);
                resolve();
                return;
            }

            const scriptPath = this.resolveHookScriptPath(entry, iterDir);

            // Check if script file exists
            if (!fs.existsSync(scriptPath)) {
                const msg = `脚本不存在：${scriptPath}`;
                appendHarnessLog(logDir, 'hook', `MISSING: ${scriptPath}`);
                vscode.window.showWarningMessage(msg);
                resolve();
                return;
            }

            // Parse script arguments
            const args = scriptArgs ? scriptArgs.split(/\s+/) : [];

            // Spawn the script process
            let stdout = '';
            let stderr = '';
            const proc = spawn(scriptPath, args, {
                cwd: iterDir,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('error', (error) => {
                const errMsg = error instanceof Error ? error.message : String(error);
                appendHarnessLog(logDir, 'hook', `SPAWN_ERROR: ${scriptName} ${errMsg}`);
                vscode.window.showWarningMessage(`Hook 脚本执行失败：${scriptName} - ${errMsg}`);
                resolve();
            });

            proc.on('exit', (exitCode) => {
                if (exitCode === 0) {
                    appendHarnessLog(logDir, 'hook', `OK: ${scriptName} exit=0`);
                    resolve();
                } else {
                    const stderrSnippet = stderr.trim().split('\n').slice(0, 3).join(' | ');
                    appendHarnessLog(logDir, 'hook', `FAILED: ${scriptName} exit=${exitCode} stderr=${stderrSnippet}`);
                    vscode.window.showWarningMessage(`Hook 脚本执行失败：${scriptName} (exit=${exitCode})`);
                    resolve();
                }
            });
        });
    }

    /**
     * Execute all worktree-open Hook scripts in sequence when Worktree is first initialized.
     * Reads hooks from config.lifecycleHooks.worktreeOpen and runs them under a progress notification.
     * Single hook failures do not stop subsequent hooks (all are independent).
     */
    private async runWorktreeOpenHooks(task: Task, iterDir: string): Promise<void> {
        const config = this.deps.getConfig();
        const hooks = config.lifecycleHooks?.worktreeOpen || [];

        // Silent skip if no hooks configured (INV-6)
        if (hooks.length === 0) {
            return;
        }

        const logDir = iterDir;
        const taskName = task.name;

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `正在执行 Worktree 初始化 Hook...`,
                cancellable: false,
            },
            async (progress) => {
                for (let i = 0; i < hooks.length; i++) {
                    const hook = hooks[i];
                    progress.report({
                        message: `[${i + 1}/${hooks.length}] ${hook.script}`,
                    });
                    await this.spawnHookAsync(hook, iterDir, taskName, logDir);
                }
            }
        );
    }
}
