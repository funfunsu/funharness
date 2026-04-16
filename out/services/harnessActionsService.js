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
exports.HarnessActionsService = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const models_1 = require("../models");
class HarnessActionsService {
    constructor(deps) {
        this.deps = deps;
        this.lastAutoRepairAt = new Map();
        this.lastAutoRepairSignature = new Map();
        this.repairingKeys = new Set();
        this.stageArtifacts = {
            req: 'requirements',
            des: 'design',
            tcs: 'testcase',
            tsk: 'tasks',
        };
    }
    async createTask(name, desc) {
        const id = `task_${Date.now()}`;
        const cfg = this.deps.getConfig();
        const inferredSplitMode = this.inferTaskSplitMode(name, desc, cfg);
        const newTask = {
            id,
            name,
            desc,
            taskSplitMode: inferredSplitMode,
            stage: models_1.STAGE.INITIALIZING,
            autoAdvanceEnabled: cfg.autoAdvanceEnabled,
            autoRepairEnabled: cfg.autoRepairEnabled,
        };
        this.deps.getTasks().push(newTask);
        this.deps.ensureIterationDir(newTask);
        this.deps.saveAndRender();
        await this.initializeTaskGit(newTask);
        vscode.window.showInformationMessage(`任务拆分模式已自动判定：${inferredSplitMode === 'compact' ? '急速模式' : '标准模式'}`);
        if (newTask.worktreePath) {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(newTask.worktreePath), {
                forceNewWindow: true,
            });
        }
    }
    async resetTaskByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        try {
            vscode.window.showInformationMessage(`正在重置任务：${task.name}`);
            this.deps.stopScheduler(task.id);
            const iterDir = this.deps.getIterationDir(task);
            if (fs.existsSync(iterDir)) {
                fs.rmSync(iterDir, { recursive: true, force: true });
            }
            task.iterationBranch = undefined;
            task.mergeTargetBranchUsed = undefined;
            task.baseSyncBranchUsed = undefined;
            task.stage = models_1.STAGE.INITIALIZING;
            this.deps.ensureIterationDir(task);
            this.deps.saveAndRender();
            await this.initializeTaskGit(task);
            vscode.window.showInformationMessage(`任务已重置：${task.name}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`重置任务失败：${message}`);
        }
    }
    updateTaskDescByTaskId(taskId, desc) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const trimmed = desc.trim();
        if (!trimmed) {
            vscode.window.showWarningMessage('需求描述不能为空');
            return;
        }
        task.desc = trimmed;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`已更新任务需求描述：${task.name}`);
    }
    async promptUpdateTaskDescByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
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
    setTaskAutomationByTaskId(taskId, aa, ar) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        task.autoAdvanceEnabled = aa;
        task.autoRepairEnabled = ar;
        this.deps.saveAndRender();
    }
    async pushAllByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const iterDir = this.deps.getIterationDir(task);
        vscode.window.showInformationMessage('正在推送代码...');
        const result = await this.deps.gitService.pushAll(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message, { modal: true });
        }
        else {
            vscode.window.showInformationMessage(result.message);
        }
    }
    async runAgentByTaskId(taskId, step) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const slashCommands = {
            req: 'fun-harness-requirement',
            des: 'fun-harness-design',
            tcs: 'fun-harness-testcase',
            tsk: 'fun-harness-task',
            dev: 'fun-harness-dev',
        };
        const iterDir = this.deps.getIterationDir(task);
        const splitMode = this.resolveTaskSplitMode(task);
        const query = `/${slashCommands[step]} taskName=${task.name} taskDesc='${task.desc}' currentWorkSpace=${iterDir} taskSplitMode=${splitMode}`;
        await this.deps.dispatchAi(query, iterDir, 'stage-agent');
        if (step === 'tcs') {
            await this.openArtifactByTaskId(taskId, 'testcase');
        }
        else if (step === 'tsk') {
            await this.openArtifactByTaskId(taskId, 'tasks');
        }
    }
    async openArtifactByTaskId(taskId, artifact) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const iterDir = this.deps.getIterationDir(task);
        const testScriptName = process.platform === 'win32' ? 'test-api.ps1' : 'test-api.sh';
        const fileMap = {
            requirements: path.join('docs', 'requirements.md'),
            design: path.join('docs', 'design.md'),
            testcase: path.join('docs', 'testcase.md'),
            tasks: this.resolveTaskPlanFile(iterDir),
            testScript: path.join('tests', testScriptName),
        };
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
    async openFolderLocationByTaskId(taskId, location) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const iterDir = this.deps.getIterationDir(task);
        const locationMap = {
            worktree: iterDir,
            frontend: path.join(iterDir, 'frontend'),
            backend: path.join(iterDir, 'backend'),
            mainFrontend: path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'repos', 'frontend-main'),
            mainBackend: path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'repos', 'backend-main'),
        };
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
    syncConfiguredPathsForWorktree(worktreePath) {
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`同步配置目录到 worktree 失败：${message}`);
        }
    }
    parseWorktreeSyncEntries(raw) {
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
    resolveMasterWorkspaceRoot() {
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
    normalizePath(inputPath) {
        return inputPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }
    seedWorktreeHarnessState(task, worktreePath) {
        try {
            const harnessDir = path.join(worktreePath, models_1.BASE);
            fs.mkdirSync(harnessDir, { recursive: true });
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const configPath = path.join(harnessDir, 'config.json');
            const configPayload = {
                ...this.deps.getConfig(),
                __harnessConfigOrigin: 'worktreeSnapshot',
                __harnessMasterRoot: workspaceRoot,
            };
            fs.writeFileSync(configPath, JSON.stringify(configPayload, null, 2), 'utf8');
            const snapshot = {
                ...task,
                // Keep absolute path so the worktree window can locate the same iteration folder.
                worktreePath,
            };
            const taskPath = path.join(harnessDir, models_1.HARNESS_STATE_FILE);
            fs.writeFileSync(taskPath, JSON.stringify([snapshot], null, 2), 'utf8');
            const legacyTaskPath = path.join(harnessDir, models_1.HARNESS_STATE_FILE_LEGACY);
            if (fs.existsSync(legacyTaskPath)) {
                fs.rmSync(legacyTaskPath, { force: true });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`写入 worktree 面板状态失败：${message}`);
        }
    }
    async ensureIterationCodeBeforeOpen(task, iterDir) {
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
            task.baseSyncBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }
        task.mergeTargetBranchUsed = result.mergeTargetBranchUsed || task.mergeTargetBranchUsed;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`代码补偿完成：${task.name}`);
        return true;
    }
    async startAutoByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
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
    pauseAutoByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const scheduler = this.deps.getScheduler(task);
        scheduler.pause();
        this.deps.saveAndRender();
    }
    async nextTaskByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const scheduler = this.deps.getScheduler(task);
        await scheduler.manualNext(task);
        this.deps.saveAndRender();
    }
    async retryTaskByTaskId(taskId, subId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const scheduler = this.deps.getScheduler(task);
        await scheduler.retryTask(subId, task);
        this.deps.saveAndRender();
    }
    async setSubTaskStatusByTaskId(taskId, subId, status) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const scheduler = this.deps.getScheduler(task);
        scheduler.updateSubTaskStatus(subId, status);
        this.deps.saveAndRender();
        if (status === 'done' && task.stage === models_1.STAGE.DEVELOPING && this.deps.getConfig().autoContinueAfterManualDone) {
            await scheduler.startAuto(task);
            this.deps.saveAndRender();
            vscode.window.showInformationMessage(`已手动修正子任务 ${subId} 为完成，并自动继续执行下一子任务`);
            return;
        }
        vscode.window.showInformationMessage(`已手动修正子任务 ${subId} 状态为 ${status}`);
    }
    async nextStageByTaskId(taskId, step, targetStage) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const nextAgentStep = {
            req: 'des',
            des: 'tcs',
            tcs: 'tsk',
        };
        if (targetStage) {
            // 根据targetStage设置下一个阶段
            if (targetStage === 'tcs')
                task.stage = models_1.STAGE.WRITING_TESTCASE;
            if (targetStage === 'tsk')
                task.stage = models_1.STAGE.WRITING_TASKS;
            if (targetStage === 'dev')
                task.stage = models_1.STAGE.DEVELOPING;
            this.deps.saveAndRender();
            // 运行targetStage对应的agent
            await this.runAgentByTaskId(taskId, targetStage);
            vscode.window.showInformationMessage(`已推进到下一阶段，并自动打开 ${targetStage.toUpperCase()} Agent`);
            return;
        }
        if (step === 'req')
            task.stage = models_1.STAGE.WRITING_DESIGN;
        if (step === 'des')
            task.stage = models_1.STAGE.WRITING_TESTCASE;
        if (step === 'tcs')
            task.stage = models_1.STAGE.WRITING_TASKS;
        if (step === 'tsk')
            task.stage = models_1.STAGE.DEVELOPING;
        if (step === 'dev') {
            task.stage = models_1.STAGE.READY_FOR_REVIEW;
            this.deps.stopScheduler(task.id);
        }
        this.deps.saveAndRender();
        const followupStep = nextAgentStep[step];
        if (followupStep) {
            await this.runAgentByTaskId(taskId, followupStep);
            vscode.window.showInformationMessage(`已推进到下一阶段，并自动打开 ${followupStep.toUpperCase()} Agent`);
        }
    }
    async autoAdvanceReadyTasks() {
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
            if (step === 'tcs')
                task.stage = models_1.STAGE.WRITING_TASKS;
            if (step === 'tsk')
                task.stage = models_1.STAGE.DEVELOPING;
            changed = true;
        }
        if (changed) {
            this.deps.saveAndRender();
        }
        return changed;
    }
    async passByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const iterDir = this.deps.getIterationDir(task);
        const mergeResult = await this.deps.gitService.mergeIterationToTarget(task, iterDir);
        if (!mergeResult.success) {
            const detail = mergeResult.message || '未知错误';
            const lines = detail.split('\n');
            const brief = lines[0];
            const extra = lines.slice(1).join('\n');
            vscode.window.showErrorMessage(`合并失败（${task.name}）：${brief}`, { detail: extra || undefined, modal: true });
            return;
        }
        task.stage = models_1.STAGE.DONE;
        this.deps.onPass(task);
        this.deps.saveAndRender();
        if (mergeResult.message) {
            vscode.window.showInformationMessage(mergeResult.message);
        }
        if (this.deps.isWorktreeSubview()) {
            await vscode.window.showInformationMessage('当前 worktree 任务已结束，正在关闭窗口...');
            await vscode.commands.executeCommand('workbench.action.closeWindow');
        }
    }
    async syncMainCodeByTaskId(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        vscode.window.showInformationMessage(`正在同步主仓库代码到 ${task.name}...`);
        const iterDir = this.deps.getIterationDir(task);
        const result = await this.deps.gitService.syncMainCode(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(`同步失败：${result.message}`, { modal: true });
        }
        else {
            vscode.window.showInformationMessage(result.message);
        }
    }
    async startServiceByTaskId(taskId, target) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
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
    async completeDevWithPush(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const iterDir = this.deps.getIterationDir(task);
        // First: Push all code to remote
        vscode.window.showInformationMessage('正在推送代码...');
        const result = await this.deps.gitService.pushAll(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message, { modal: true });
            return;
        }
        // Then: Mark as complete development (change to READY_FOR_REVIEW)
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.nextStageByTaskId(taskId, 'dev');
    }
    async pushAndNextStage(taskId) {
        const task = this.getTaskById(taskId);
        if (!task)
            return;
        const iterDir = this.deps.getIterationDir(task);
        // First: Push all code to remote
        vscode.window.showInformationMessage('正在推送代码...');
        const result = await this.deps.gitService.pushAll(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message, { modal: true });
            return;
        }
        // Then: Change to READY_FOR_REVIEW stage
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.nextStageByTaskId(taskId, 'dev');
    }
    async initializeTaskGit(task) {
        task.stage = models_1.STAGE.INITIALIZING;
        this.deps.saveAndRender();
        const iterDir = this.deps.getIterationDir(task);
        const result = await this.deps.gitService.createIterationBranches(task, iterDir);
        if (!result.success) {
            vscode.window.showErrorMessage(result.message || '迭代初始化失败');
            return;
        }
        if (result.baseBranch) {
            task.baseSyncBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }
        task.mergeTargetBranchUsed = result.mergeTargetBranchUsed || '';
        task.stage = models_1.STAGE.WRITING_REQUIREMENT;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(result.message || '✅ 迭代初始化完成');
    }
    getTaskById(taskId) {
        return this.deps.getTasks().find((task) => task.id === taskId);
    }
    stageToStep(stage) {
        if (stage === models_1.STAGE.WRITING_REQUIREMENT)
            return 'req';
        if (stage === models_1.STAGE.WRITING_DESIGN)
            return 'des';
        if (stage === models_1.STAGE.WRITING_TESTCASE)
            return 'tcs';
        if (stage === models_1.STAGE.WRITING_TASKS)
            return 'tsk';
        return null;
    }
    validateStageArtifact(task, step) {
        const iterDir = this.deps.getIterationDir(task);
        const fileMap = {
            req: path.join('docs', 'requirements.md'),
            des: path.join('docs', 'design.md'),
            tcs: path.join('docs', 'testcase.md'),
        };
        const filePath = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : path.join(iterDir, fileMap[step]);
        const errors = [];
        if (!fs.existsSync(filePath)) {
            if (step === 'tsk') {
                return { valid: false, errors: [`缺少文件 ${models_1.TASK_PLAN_PRIMARY_REL_PATH}（兼容 ${models_1.TASK_PLAN_LEGACY_REL_PATH}）`] };
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
        const rules = {
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
            }
            else {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
                }
                catch {
                    errors.push('test-manifest.json 不是合法 JSON');
                }
            }
        }
        return { valid: errors.length === 0, errors };
    }
    validateTestManifestSchema(manifest) {
        const errors = [];
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
        }
        else {
            const scriptObj = script;
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
            }
            else {
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
            const tc = item;
            if (typeof tc.id !== 'string' || !tc.id.startsWith('TC-')) {
                errors.push(`${prefix}.id 必须是 TC- 开头`);
            }
            if (!Array.isArray(tc.requirementIds) || tc.requirementIds.length === 0) {
                errors.push(`${prefix}.requirementIds 不能为空`);
            }
            const api = tc.api;
            if (!api || typeof api !== 'object') {
                errors.push(`${prefix}.api 缺失`);
            }
            else {
                const apiObj = api;
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
    validateTestScriptFromManifest(iterDir, manifest) {
        const errors = [];
        if (!this.isTestScriptRequired(manifest)) {
            return errors;
        }
        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            return errors;
        }
        const scriptObj = script;
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
    isTestScriptRequired(manifest) {
        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            return true;
        }
        const required = script.required;
        if (required === undefined) {
            return true;
        }
        return required === true;
    }
    async tryAutoRepair(task, step, errors) {
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
        }
        finally {
            this.repairingKeys.delete(key);
        }
    }
    buildArtifactSignature(task, step, errors) {
        const fileMap = {
            req: path.join('docs', 'requirements.md'),
            des: path.join('docs', 'design.md'),
            tcs: path.join('docs', 'testcase.md'),
        };
        const iterDir = this.deps.getIterationDir(task);
        const file = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : path.join(iterDir, fileMap[step]);
        const statPart = fs.existsSync(file) ? `mtime:${fs.statSync(file).mtimeMs}` : 'missing';
        const errPart = errors.slice(0, 3).join('|');
        return `${statPart}|${errPart}`;
    }
    resolveTaskPlanFile(iterDir) {
        const preferred = path.join(iterDir, ...models_1.TASK_PLAN_PRIMARY_REL_PATH.split('/'));
        const legacy = path.join(iterDir, ...models_1.TASK_PLAN_LEGACY_REL_PATH.split('/'));
        if (fs.existsSync(preferred)) {
            return preferred;
        }
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return preferred;
    }
    toRelativeIterationPath(iterDir, absPath) {
        return path.relative(iterDir, absPath).replace(/\\/g, '/');
    }
    isTaskAutoAdvanceEnabled(task) {
        if (typeof task.autoAdvanceEnabled === 'boolean') {
            return task.autoAdvanceEnabled;
        }
        return this.deps.getConfig().autoAdvanceEnabled;
    }
    isTaskAutoRepairEnabled(task, cfg) {
        if (typeof task.autoRepairEnabled === 'boolean') {
            return task.autoRepairEnabled;
        }
        return (cfg || this.deps.getConfig()).autoRepairEnabled;
    }
    resolveTaskSplitMode(task) {
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
    inferTaskSplitMode(name, desc, cfg) {
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
    parseKeywords(raw) {
        return (raw || '')
            .split(',')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);
    }
}
exports.HarnessActionsService = HarnessActionsService;
//# sourceMappingURL=harnessActionsService.js.map