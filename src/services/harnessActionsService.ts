import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { HarnessStep } from '../harnessMessages';
import {
    BASE,
    Config,
    CUSTOM_SCRIPT_DIR,
    HARNESS_STATE_FILE,
    HARNESS_STATE_FILE_LEGACY,
    STAGE,
    TASK_PLAN_LEGACY_REL_PATH,
    TASK_PLAN_PRIMARY_REL_PATH,
    Task,
} from '../models';
import { TaskScheduler } from '../taskScheduler';
import { GitService } from './gitService';

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

    private readonly stageArtifacts = {
        req: 'requirements',
        des: 'design',
        tcs: 'testcase',
        tsk: 'tasks',
    } as const;

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
        this.deps.copyProjectStructureToIteration(this.deps.getIterationDir(newTask));
        this.deps.saveAndRender();
        await this.initializeTaskGit(newTask);
        if (newTask.quickMode) {
            // Skip requirements/design/testcase/task-split — jump straight to DEVELOPING.
            // Dev Agent runs with only task.desc and project context.
            newTask.stage = STAGE.DEVELOPING;
            this.deps.saveAndRender();
            vscode.window.showInformationMessage('已使用快捷模式：跳过文档生成，直接进入开发');
        } else {
            vscode.window.showInformationMessage(`任务拆分模式已自动判定：${inferredSplitMode === 'compact' ? '急速模式' : '标准模式'}`);
        }
        if (newTask.worktreePath) {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(newTask.worktreePath), {
                forceNewWindow: true,
            });
        }
    }

    async resetTaskByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        try {
            vscode.window.showInformationMessage(`正在重置任务：${task.name}`);

            this.deps.stopScheduler(task.id);

            const iterDir = this.deps.getIterationDir(task);
            if (fs.existsSync(iterDir)) {
                fs.rmSync(iterDir, { recursive: true, force: true });
            }

            task.iterationBranch = undefined;
            task.baseBranchUsed = undefined;
            task.stage = STAGE.INITIALIZING;

            this.deps.ensureIterationDir(task);
            this.deps.copyProjectStructureToIteration(this.deps.getIterationDir(task));
            this.deps.saveAndRender();
            await this.initializeTaskGit(task);
            vscode.window.showInformationMessage(`任务已重置：${task.name}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`重置任务失败：${message}`);
        }
    }

    updateTaskDescByTaskId(taskId: string, desc: string): void {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const trimmed = desc.trim();
        if (!trimmed) {
            vscode.window.showWarningMessage('需求描述不能为空');
            return;
        }
        task.desc = trimmed;
        this.deps.saveAndRender();
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

    async runAgentByTaskId(taskId: string, step: HarnessStep): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        this.reconcileStageArtifactPath(task, step);

        const rendered = this.deps.renderAgentPrompt(step, task.name, task.desc, iterDir);
        if (!rendered.content.trim()) {
            vscode.window.showErrorMessage(`未找到可用的 ${step} Prompt，请检查扩展内置 prompts/ 目录。`);
            return;
        }

        const splitMode = this.resolveTaskSplitMode(task);
        const query = `${rendered.content}\n\n---\n运行参数：taskSplitMode=${splitMode}`;
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
        }
        const testScriptName = process.platform === 'win32' ? 'test-api.ps1' : 'test-api.sh';
        const fileMap = {
            requirements: path.join('docs', 'requirements.md'),
            design: path.join('docs', 'design.md'),
            testcase: path.join('docs', 'testcase.md'),
            tasks: this.resolveTaskPlanFile(iterDir),
            testScript: path.join('tests', testScriptName),
        } as const;
        const filePath = artifact === 'tasks'
            ? fileMap.tasks
            : path.join(iterDir, fileMap[artifact]);

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '', 'utf8');
        }

        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    }

    async openFolderLocationByTaskId(
        taskId: string,
        location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend'
    ): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        const locationMap = {
            worktree: iterDir,
            frontend: path.join(iterDir, 'frontend'),
            backend: path.join(iterDir, 'backend'),
            mainFrontend: path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'repos', 'frontend-main'),
            mainBackend: path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'repos', 'backend-main'),
        } as const;

        const targetPath = locationMap[location];
        if (!fs.existsSync(targetPath)) {
            vscode.window.showWarningMessage(`目录不存在：${targetPath}`);
            return;
        }

        if (location === 'worktree') {
            const compensated = await this.ensureIterationCodeBeforeOpen(task, targetPath);
            if (!compensated) {
                return;
            }
            this.syncConfiguredPathsForWorktree(targetPath);
            this.seedWorktreeHarnessState(task, targetPath);
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
                    fs.rmSync(targetPath, { recursive: true, force: true });
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
            return ['.github/instructions'];
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
                fs.rmSync(legacyTaskPath, { force: true });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`写入 worktree 面板状态失败：${message}`);
        }
    }

    private async ensureIterationCodeBeforeOpen(task: Task, iterDir: string): Promise<boolean> {
        const cfg = this.deps.getConfig();
        const frontendMissing = Boolean(cfg.frontendGit) && !fs.existsSync(path.join(iterDir, 'frontend', '.git'));
        const backendMissing = Boolean(cfg.backendGit) && !fs.existsSync(path.join(iterDir, 'backend', '.git'));

        if (!frontendMissing && !backendMissing) {
            return true;
        }

        vscode.window.showInformationMessage(`检测到代码目录缺失，正在补偿重建：${task.name}`);
        const result = await this.deps.gitService.createIterationBranches(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(`补偿拉取失败：${result.message || '未知错误'}`);
            return false;
        }

        if (result.baseBranch) {
            task.baseBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`代码补偿完成：${task.name}`);
        return true;
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

            if (step === 'tcs') task.stage = STAGE.WRITING_TASKS;
            if (step === 'tsk') task.stage = STAGE.DEVELOPING;
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
                    fs.rmSync(iterDir, { recursive: true, force: true });
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
            const child = spawn('sh', ['-c', `sleep 3 && rm -rf "${escaped}"`], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
        } catch {
            // Best-effort: if scheduling fails, the user can manually delete the dir.
        }
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
        }
    }

    async startServiceByTaskId(taskId: string, target: 'frontend' | 'backend'): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;
        const iterDir = this.deps.getIterationDir(task);
        const compensated = await this.ensureIterationCodeBeforeOpen(task, iterDir);
        if (!compensated) return;
        await this.startSingleTarget(task, target, iterDir);
    }

    /**
     * Unified "启动服务" entry. Walks each existing sub-repo under the iteration dir
     * (frontend / backend) and launches it via fun_harness_start.{sh,ps1}.
     * Falls back to materializing the legacy config command, then to AI agent generation
     * when neither a script nor a config command exists.
     */
    async startServicesByTaskId(taskId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        const compensated = await this.ensureIterationCodeBeforeOpen(task, iterDir);
        if (!compensated) return;

        const targets: Array<'frontend' | 'backend'> = [];
        if (fs.existsSync(path.join(iterDir, 'frontend'))) targets.push('frontend');
        if (fs.existsSync(path.join(iterDir, 'backend'))) targets.push('backend');

        if (targets.length === 0) {
            vscode.window.showWarningMessage('当前迭代下没有可启动的代码目录（frontend / backend 均不存在）');
            return;
        }

        for (const target of targets) {
            await this.startSingleTarget(task, target, iterDir);
        }
    }

    /**
     * Runs a user-defined custom button. Scripts are maintained as a single shared
     * set under `<masterRoot>/script/` (the "主目录"). Clicking opens a terminal whose
     * cwd is THIS task's worktree iteration directory and runs the master script there,
     * so one unified script operates on whichever iteration the button was clicked from.
     */
    async runCustomButtonByTaskId(taskId: string, buttonId: string): Promise<void> {
        const task = this.getTaskById(taskId);
        if (!task) return;

        const button = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        if (!button) {
            vscode.window.showWarningMessage('未找到对应的自定义按钮，请在「高级设置」中重新配置');
            return;
        }
        const command = (button.command || '').trim();
        if (!command) {
            vscode.window.showWarningMessage(`自定义按钮「${button.name}」未配置指令`);
            return;
        }

        const iterDir = this.deps.getIterationDir(task);
        const compensated = await this.ensureIterationCodeBeforeOpen(task, iterDir);
        if (!compensated) return;
        if (!fs.existsSync(iterDir)) {
            vscode.window.showWarningMessage(`迭代目录不存在，无法执行：${iterDir}`);
            return;
        }

        // The button may target a subfolder of the worktree (e.g. frontend/backend);
        // empty = the worktree root. The terminal cwd is set to this folder so the
        // master script runs against the right project.
        const workdir = (button.workdir || '').trim();
        const runDir = workdir ? path.join(iterDir, workdir) : iterDir;
        if (workdir && !fs.existsSync(runDir)) {
            vscode.window.showWarningMessage(`执行目录不存在：${runDir}。请确认该 worktree 下存在「${workdir}」文件夹。`);
            return;
        }

        // Resolve the script against the shared master script dir. The first token is
        // the script file (relative to <masterRoot>/script/, leading "./" optional);
        // anything after it is passed through as arguments.
        const scriptDir = path.join(this.deps.getMasterRoot(), CUSTOM_SCRIPT_DIR);
        const firstSpace = command.search(/\s/);
        const scriptRef = (firstSpace === -1 ? command : command.slice(0, firstSpace)).replace(/^\.\//, '');
        const extraArgs = firstSpace === -1 ? '' : command.slice(firstSpace);
        const scriptPath = path.join(scriptDir, scriptRef);

        if (!fs.existsSync(scriptPath)) {
            vscode.window.showWarningMessage(`脚本不存在：${scriptPath}。请在主目录的 ${CUSTOM_SCRIPT_DIR}/ 目录下维护脚本（如 deploy.sh）。`);
            return;
        }

        const runCmd = this.buildCustomButtonCommand(scriptPath, extraArgs);
        const terminal = vscode.window.createTerminal({
            name: `Fun Harness ${task.name} ${button.name}`,
            cwd: runDir,
        });
        terminal.show(true);
        terminal.sendText(runCmd, true);
        vscode.window.showInformationMessage(`已在 ${task.name} 执行「${button.name}」：${runCmd}`);
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

    private async startSingleTarget(task: Task, target: 'frontend' | 'backend', iterDir: string): Promise<void> {
        const targetDir = path.join(iterDir, target);
        if (!fs.existsSync(targetDir)) {
            return;
        }
        const isWin = process.platform === 'win32';
        const scriptName = isWin ? 'fun_harness_start.ps1' : 'fun_harness_start.sh';
        const scriptPath = path.join(targetDir, scriptName);

        // Path A: script already exists — run it.
        if (fs.existsSync(scriptPath)) {
            this.launchStartScript(task, target, targetDir, scriptName, isWin);
            return;
        }

        // Path B: legacy config cmd exists — materialize into a script and run.
        const cfg = this.deps.getConfig();
        const configCmd = ((target === 'frontend' ? cfg.frontendStartCmd : cfg.backendStartCmd) || '').trim();
        if (configCmd) {
            const port = target === 'backend' && cfg.backendPort > 0 ? cfg.backendPort : undefined;
            this.writeStartScript(scriptPath, configCmd, isWin, target, port);
            this.launchStartScript(task, target, targetDir, scriptName, isWin);
            return;
        }

        // Path C: no script and no config — ask the AI to generate one.
        await this.dispatchStartScriptAgent(task, target, targetDir, scriptName, iterDir);
    }

    private writeStartScript(scriptPath: string, cmd: string, isWin: boolean, target: 'frontend' | 'backend', port?: number): void {
        const portValue = port && port > 0 ? String(port) : '';
        const content = isWin
            ? this.buildPwshStartScript(target, cmd, portValue)
            : this.buildBashStartScript(target, cmd, portValue);
        fs.writeFileSync(scriptPath, content, 'utf8');
        if (!isWin) {
            try { fs.chmodSync(scriptPath, 0o755); } catch { /* best-effort */ }
        }
    }

    private buildBashStartScript(label: string, cmd: string, port: string): string {
        return [
            '#!/usr/bin/env bash',
            '# fun_harness_start (auto-generated by Fun Harness)',
            'set -e',
            'cd "$(dirname "$0")"',
            '',
            `PORT="${port}"`,
            'if [ -n "$PORT" ] && command -v lsof >/dev/null 2>&1; then',
            '    PIDS=$(lsof -t -i:"$PORT" 2>/dev/null || true)',
            '    if [ -n "$PIDS" ]; then',
            '        echo "Fun Harness: freeing port $PORT (PIDs: $PIDS)"',
            '        echo "$PIDS" | xargs kill 2>/dev/null || true',
            '        sleep 1',
            '        REMAINING=$(lsof -t -i:"$PORT" 2>/dev/null || true)',
            '        if [ -n "$REMAINING" ]; then echo "$REMAINING" | xargs kill -9 2>/dev/null || true; fi',
            '    fi',
            'fi',
            '',
            `echo "Fun Harness: starting ${label}"`,
            `exec ${cmd}`,
            '',
        ].join('\n');
    }

    private buildPwshStartScript(label: string, cmd: string, port: string): string {
        return [
            '# fun_harness_start (auto-generated by Fun Harness)',
            '$ErrorActionPreference = "Stop"',
            'Set-Location -Path $PSScriptRoot',
            '',
            `$port = "${port}"`,
            'if ($port -ne "") {',
            '    try {',
            '        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue',
            '        foreach ($c in $conns) {',
            '            Write-Host "Fun Harness: freeing port $port (PID $($c.OwningProcess))"',
            '            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue',
            '        }',
            '        if ($conns) { Start-Sleep -Seconds 1 }',
            '    } catch { }',
            '}',
            '',
            `Write-Host "Fun Harness: starting ${label}"`,
            cmd,
            '',
        ].join('\n');
    }

    private launchStartScript(task: Task, target: 'frontend' | 'backend', dir: string, scriptName: string, isWin: boolean): void {
        const terminal = vscode.window.createTerminal({
            name: `Fun Harness ${task.name} ${target}`,
            cwd: dir,
        });
        terminal.show(true);
        // Windows: use powershell.exe (Windows PowerShell 5.1) — it always ships with
        // Windows and is callable from both cmd.exe and a PowerShell session. pwsh
        // (PowerShell 7+) is frequently not installed / not on PATH. The generated .ps1
        // only uses 5.1-compatible cmdlets, so powershell.exe runs it fine.
        const cmd = isWin
            ? `powershell -ExecutionPolicy Bypass -File ./${scriptName}`
            : `bash ./${scriptName}`;
        terminal.sendText(cmd, true);
        vscode.window.showInformationMessage(`已启动 ${target}（${scriptName}）`);
    }

    private async dispatchStartScriptAgent(
        task: Task,
        target: 'frontend' | 'backend',
        targetDir: string,
        scriptName: string,
        iterDir: string,
    ): Promise<void> {
        const isWin = process.platform === 'win32';
        const cfg = this.deps.getConfig();
        const explicitPort = target === 'backend' && cfg.backendPort > 0 ? cfg.backendPort : undefined;
        const techStack = (cfg.techStack || '').trim();
        const javaProfile = (cfg.javaRuntimeProfile || '').trim() || 'dev';

        const prompt = [
            `# 任务：为 ${target} 项目生成启动脚本 ${scriptName}`,
            `目录：${targetDir}`,
            techStack ? `项目技术栈备注：${techStack}` : '',
            `用户需求：${task.desc || '（未填写）'}`,
            '',
            '## 通用要求',
            `1. 在 \`${targetDir}\` 下生成 \`${scriptName}\`，**只生成这一个文件**，不修改其他源码/配置。`,
            '2. 自动识别该目录技术栈：package.json / pom.xml / build.gradle / build.gradle.kts / Cargo.toml / requirements.txt / pyproject.toml / go.mod / Makefile。',
            isWin
                ? '3. 使用 PowerShell 语法；第一行写注释 `# fun_harness_start`；启用 `$ErrorActionPreference = "Stop"`。'
                : '3. 使用 bash 语法；第一行 `#!/usr/bin/env bash`；启用 `set -e`；生成后通过 `chmod +x` 设可执行。',
            '4. 启动前 echo 一行 `Fun Harness: starting ' + target + '`；服务进程要保持前台运行（不要 `&` 后台化），便于 VS Code 终端能直接看到日志、Ctrl+C 干净退出。',
            '',
            '## 启动前先清理（**必做**）',
            `5. 端口清理：${explicitPort ? `已知服务端口为 ${explicitPort}。` : '从项目配置（application.yml / .env / vite.config 等）解析出真实监听端口；解析不到则向用户暴露一个可改的 \`PORT=""\` 变量留空。'}`,
            isWin
                ? '   用 `Get-NetTCPConnection -LocalPort $port -State Listen` 找占用进程；逐个 `Stop-Process -Id $_.OwningProcess -Force`，然后 `Start-Sleep -Seconds 1`。包一层 try/catch 防错。'
                : '   用 `lsof -t -i:"$PORT"` 取占用 PID；先 `kill`，停 1 秒后对仍存活的 PID `kill -9`。整段用 `command -v lsof >/dev/null 2>&1` 保护。',
            '6. 进程清理（兜底）：除了端口，还要根据本项目特征匹配残留进程并杀掉。例如：',
            isWin
                ? '   - Java 项目：`Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*<本目录绝对路径>*" -and $_.CommandLine -like "*java*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`'
                : '   - Java 项目：`pgrep -f "<本目录绝对路径>.*(spring-boot|java -jar|gradle bootRun)" | xargs -r kill -9`',
            isWin
                ? '   - Node 项目：匹配 vite / next / nuxt / webpack-dev-server / nodemon，结合本目录路径过滤后 Stop-Process。'
                : '   - Node 项目：`pgrep -f "<本目录绝对路径>.*(vite|next|nuxt|webpack|nodemon)" | xargs -r kill -9`',
            '   ⚠️ 必须用"本目录路径"做过滤，避免误杀同机器上其他项目的同名进程。',
            '',
            '## Java 项目专项要求（pom.xml / build.gradle 存在时）',
            '7. 多模块识别：',
            '   - 若 pom.xml 含 `<modules>` 节点（聚合工程），扫描各子模块的 pom.xml 中 spring-boot-starter / spring-boot-maven-plugin / `@SpringBootApplication` 注解，定位 **可启动模块**（启动类所在的那个）。',
            '   - 找到后用 `mvn -pl <module> -am spring-boot:run` 或 `cd <module> && mvn spring-boot:run` 启动；`-am` 自动构建依赖模块。',
            '   - Gradle 多模块同理：`./gradlew :<module>:bootRun` 或 `cd <module> && ./gradlew bootRun`。',
            '   - 若有多个可启动模块，**注释列出全部候选，默认启动名字最像主服务的那个**（如 `*-server`、`*-app`、`*-web`、`*-api`），其他在注释里写明切换方法。',
            '8. 单模块 Spring Boot：`mvn spring-boot:run` 或 `./gradlew bootRun`，并加上 profile：',
            `   - 注入 \`-Dspring-boot.run.profiles=${javaProfile}\`（Maven）/ \`--args='--spring.profiles.active=${javaProfile}'\`（Gradle）。`,
            '9. 依赖安装：首次或 pom 变更时执行 `mvn -DskipTests install`（仅当依赖未本地化时）；不要每次都跑全量 install。',
            '',
            '## Node 项目专项要求（package.json 存在时）',
            '10. 解析 `scripts` 字段，依次找：`dev` → `start:dev` → `start` → `serve`；只取第一个匹配的脚本。',
            '11. 包管理器优先级：pnpm-lock.yaml → pnpm，yarn.lock → yarn，否则 npm。',
            '12. 安装：仅当 `node_modules` 不存在时执行安装；存在则跳过。',
            '',
            '## 输出',
            '13. 生成完成后，**简短**告知用户已生成；告诉用户回到 VS Code 重新点「启动服务」即可运行。',
            '14. 不要尝试执行该脚本本身（不要 `bash fun_harness_start.sh`），只生成文件。',
        ].filter(Boolean).join('\n');

        vscode.window.showInformationMessage(`未发现 ${scriptName}，已派发 AI 生成启动脚本。生成完成后请再次点击「启动服务」。`);
        await this.deps.dispatchAi(prompt, iterDir, 'stage-agent', task.aiProvider);
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
        const fileMap = {
            req: path.join('docs', 'requirements.md'),
            des: path.join('docs', 'design.md'),
            tcs: path.join('docs', 'testcase.md'),
        } as const;
        const filePath = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : path.join(iterDir, fileMap[step]);
        const errors: string[] = [];

        if (!fs.existsSync(filePath)) {
            if (step === 'tsk') {
                return { valid: false, errors: [`缺少文件 ${TASK_PLAN_PRIMARY_REL_PATH}（兼容 ${TASK_PLAN_LEGACY_REL_PATH}）`] };
            }
            return { valid: false, errors: [`缺少文件 ${fileMap[step]}`] };
        }

        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) {
            const relPath = step === 'tsk'
                ? this.toRelativeIterationPath(iterDir, filePath)
                : fileMap[step];
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
        this.lastAutoRepairAt.set(key, now);
        this.lastAutoRepairSignature.set(key, signature);
        this.repairingKeys.add(key);

        try {
            await this.runAgentByTaskId(task.id, step);
            vscode.window.showInformationMessage(`已触发自动回修：${task.name} ${step}（${errors.slice(0, 2).join('；')}）`);
        } finally {
            this.repairingKeys.delete(key);
        }
    }

    private buildArtifactSignature(task: Task, step: Exclude<HarnessStep, 'dev'>, errors: string[]): string {
        const fileMap = {
            req: path.join('docs', 'requirements.md'),
            des: path.join('docs', 'design.md'),
            tcs: path.join('docs', 'testcase.md'),
        } as const;
        const iterDir = this.deps.getIterationDir(task);
        const file = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : path.join(iterDir, fileMap[step]);
        const statPart = fs.existsSync(file) ? `mtime:${fs.statSync(file).mtimeMs}` : 'missing';
        const errPart = errors.slice(0, 3).join('|');
        return `${statPart}|${errPart}`;
    }

    private resolveTaskPlanFile(iterDir: string): string {
        const preferred = path.join(iterDir, ...TASK_PLAN_PRIMARY_REL_PATH.split('/'));
        const legacy = path.join(iterDir, ...TASK_PLAN_LEGACY_REL_PATH.split('/'));
        if (fs.existsSync(preferred)) {
            return preferred;
        }
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return preferred;
    }

    private stageArtifactRelativePath(step: Exclude<HarnessStep, 'dev'>): string {
        const fileMap = {
            req: path.join('docs', 'requirements.md'),
            des: path.join('docs', 'design.md'),
            tcs: path.join('docs', 'testcase.md'),
            tsk: TASK_PLAN_PRIMARY_REL_PATH,
        } as const;
        return fileMap[step];
    }

    private reconcileStageArtifactPath(task: Task, step: HarnessStep): boolean {
        if (step === 'dev') {
            return false;
        }

        const iterDir = this.deps.getIterationDir(task);
        const canonicalRel = this.stageArtifactRelativePath(step);
        const canonicalAbs = path.join(iterDir, ...canonicalRel.split('/'));
        fs.mkdirSync(path.dirname(canonicalAbs), { recursive: true });
        const canonicalReady = fs.existsSync(canonicalAbs) && fs.readFileSync(canonicalAbs, 'utf8').trim().length > 0;
        if (canonicalReady) {
            return true;
        }

        const fileName = path.basename(canonicalAbs);
        const candidates = [
            path.join(iterDir, fileName),
            path.join(iterDir, 'doc', fileName),
            path.join(iterDir, '.harness', 'staging', fileName),
            path.join(iterDir, '.harness', 'artifacts', fileName),
        ];

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
                fs.rmSync(candidate, { force: true });
            } catch {
                // ignore delete errors and keep canonical copy.
            }
            vscode.window.showInformationMessage(`已自动修复 ${fileName} 路径到 ${canonicalRel}`);
            return true;
        }

        return false;
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
            const sourceRequirements = path.join(iterDir, 'docs', 'requirements.md');
            const sourceDesign = path.join(iterDir, 'docs', 'design.md');
            const masterRoot = this.resolveMasterWorkspaceRoot();
            if (!masterRoot) {
                return;
            }

            const targetRequirements = path.join(masterRoot, 'docs', 'requirements', `requirements-${task.id}.md`);
            const targetDesign = path.join(masterRoot, 'docs', 'designs', `designs-${task.id}.md`);

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
}
