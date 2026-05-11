import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HarnessStep } from '../harnessMessages';
import {
    BASE,
    Config,
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

    async createTask(name: string, desc: string): Promise<void> {
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
        };
        this.deps.getTasks().push(newTask);
        this.deps.ensureIterationDir(newTask);
        this.deps.copyProjectStructureToIteration(this.deps.getIterationDir(newTask));
        this.deps.saveAndRender();
        await this.initializeTaskGit(newTask);
        vscode.window.showInformationMessage(`任务拆分模式已自动判定：${inferredSplitMode === 'compact' ? '急速模式' : '标准模式'}`);
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
            vscode.window.showErrorMessage(`未找到可用的 ${step} Prompt，请检查 .harness/prompts 或扩展内置 prompts。`);
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

        if (this.deps.isWorktreeSubview()) {
            await vscode.window.showInformationMessage('当前 worktree 任务已结束，正在关闭窗口...');
            await vscode.commands.executeCommand('workbench.action.closeWindow');
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
        if (!compensated) {
            return;
        }

        const cfg = this.deps.getConfig();
        const command = (target === 'frontend' ? cfg.frontendStartCmd : cfg.backendStartCmd || '').trim();
        if (!command) {
            vscode.window.showWarningMessage(`未配置${target === 'frontend' ? '前端' : '后端'}启动命令，请先在高级设置填写。`);
            return;
        }

        const targetDir = path.join(iterDir, target);
        if (!fs.existsSync(targetDir)) {
            vscode.window.showWarningMessage(`目录不存在：${targetDir}`);
            return;
        }

        const terminal = vscode.window.createTerminal({
            name: `Fun Harness ${task.name} ${target}`,
            cwd: targetDir,
        });
        terminal.show(true);
        terminal.sendText(command, true);
        vscode.window.showInformationMessage(`已在 ${targetDir} 启动命令：${command}`);
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
