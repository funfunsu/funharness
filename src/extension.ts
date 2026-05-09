import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    BASE,
    Config,
    DEFAULT_CONFIG,
    PROMPT_CONFIGS,
    STAGE,
    SubTask,
    TASK_PLAN_LEGACY_REL_PATH,
    TASK_PLAN_PRIMARY_REL_PATH,
    Task,
    TaskStats
} from './models';
import { TaskScheduler } from './taskScheduler';
import { startMasterArtifactWatcher } from './masterArtifactWatcher';
import { buildErrorPageHtml, buildMainPageHtml, buildSettingsPageHtml, MainTaskViewModel } from './webviewTemplates';
import { HarnessConfigMeta, TaskStoreService } from './services/taskStoreService';
import { PromptService } from './services/promptService';
import { GitService } from './services/gitService';
import { AiDispatchService } from './services/aiDispatchService';
import { HarnessMessage } from './harnessMessages';
import { HarnessMessageController } from './harnessMessageController';
import { SchedulerRegistry } from './schedulerRegistry';
import { HarnessActionsService } from './services/harnessActionsService';
import { resolveHarnessWorkspaceRoot } from './workspaceRoot';

let harness: Harness | undefined;
let workspaceRoot: string;
let extensionPath: string;
// ─────────────────── Harness (main class) ───────────────────

export function activate(context: vscode.ExtensionContext): void {
    extensionPath = context.extensionPath;
    harness = new Harness(context);
    harness.init();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'fun-harness.sidebar',
            new HarnessViewProvider(harness),
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fun-harness.open', async () => {
            try {
                await vscode.commands.executeCommand('workbench.view.extension.fun-harness-sidebar');
            } catch {
                harness!.panel ? harness!.panel.reveal() : harness!.createPanel();
            }
        })
    );
}

class HarnessViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly harness: Harness) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        webviewView.webview.options = { enableScripts: true };
        try {
            this.harness.attachSidebarView(webviewView);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            webviewView.webview.html = buildErrorPageHtml(
                'Fun Harness 侧边栏加载失败',
                message,
                '请先检查当前工作区是否为预期项目目录，或查看扩展开发主机日志中的堆栈。'
            );
        }
    }
}

class Harness {
    private context: vscode.ExtensionContext;
    panel: vscode.WebviewPanel | null = null;
    private sidebarView?: vscode.WebviewView;
    tasks: Task[] = [];
    private currentPage: string = 'main';
    private selectedPromptKey: string = 'req';
    private config: Config = { ...DEFAULT_CONFIG };
    private schedulerRegistry!: SchedulerRegistry;
    private taskStore!: TaskStoreService;
    private configMeta: HarnessConfigMeta = { origin: 'unknown', readOnly: false };
    private promptService!: PromptService;
    private gitService: GitService = new GitService(this.config);
    private messageController!: HarnessMessageController;
    private actionsService!: HarnessActionsService;
    private aiDispatchService!: AiDispatchService;
    private autoAdvanceRunning: boolean = false;
    private openedWorkspacePath: string = '';
    private initializationError?: string;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    init(): void {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
            this.initializationError = '未检测到已打开的工作区。';
            return;
        }
        this.openedWorkspacePath = root.uri.fsPath;
        try {
            const resolvedRoot = resolveHarnessWorkspaceRoot(this.openedWorkspacePath);
            workspaceRoot = resolvedRoot.workspaceRoot;

            this.gitService.setWorkspaceRoot(workspaceRoot);
            this.taskStore = new TaskStoreService(workspaceRoot);
            this.promptService = new PromptService(workspaceRoot, extensionPath);
            this.aiDispatchService = new AiDispatchService(() => this.config);
            this.schedulerRegistry = new SchedulerRegistry(
                (task) => this.getIterationDir(task),
                workspaceRoot,
                () => this.config,
                async (query, iterDir, source) => this.aiDispatchService.dispatch(query, iterDir, source),
                () => this.render(),
            );
            this.actionsService = new HarnessActionsService({
                getTasks: () => this.tasks,
                getConfig: () => this.config,
                getIterationDir: (task) => this.getIterationDir(task),
                ensureIterationDir: (task) => this.taskStore.ensureIterationDir(task),
                saveAndRender: () => this.saveAndRender(),
                gitService: this.gitService,
                getScheduler: (task) => this.getScheduler(task),
                stopScheduler: (taskId) => this.schedulerRegistry.stop(taskId),
                onPass: (task) => vscode.window.showInformationMessage(`✅ ${task.name} 完成`),
                isWorktreeSubview: () => this.isWorktreeSubview(),
                dispatchAi: async (query, iterDir, source) => this.aiDispatchService.dispatch(query, iterDir, source),
            });
            this.messageController = new HarnessMessageController({
                isWorktreeSubview: () => this.isWorktreeSubview(),
                setPage: (page) => { this.currentPage = page; },
                reloadTasks: () => this.loadTasks(),
                render: () => this.render(),
                setSelectedPromptKey: (key) => { this.selectedPromptKey = key; },
                restoreSelectedAgentPrompt: () => this.restoreSelectedAgentPrompt(),
                saveGit: (frontendGit, backendGit, mergeTargetBranch, baseSyncBranch, dryRun) => this.handleSaveGit(frontendGit, backendGit, mergeTargetBranch, baseSyncBranch, dryRun),
                saveDevConfig: (msg) => this.handleSaveDevConfig(msg),
                testAiProvider: async () => this.aiDispatchService.testConnection(),
                setSubTaskStatus: async (taskId, subId, status) => this.actionsService.setSubTaskStatusByTaskId(taskId, subId, status),
                createTask: async (name, desc) => this.actionsService.createTask(name, desc),
                requestEditTaskDesc: async (taskId) => this.actionsService.promptUpdateTaskDescByTaskId(taskId),
                updateTaskDesc: (taskId, desc) => this.actionsService.updateTaskDescByTaskId(taskId, desc),
                resetTask: async (taskId) => this.actionsService.resetTaskByTaskId(taskId),
                pushAllCode: async (taskId) => this.actionsService.pushAllByTaskId(taskId),
                runAgent: async (taskId, step) => this.actionsService.runAgentByTaskId(taskId, step),
                startAuto: async (taskId) => this.actionsService.startAutoByTaskId(taskId),
                pauseAuto: (taskId) => this.actionsService.pauseAutoByTaskId(taskId),
                nextTask: async (taskId) => this.actionsService.nextTaskByTaskId(taskId),
                retryTask: async (taskId, subId) => this.actionsService.retryTaskByTaskId(taskId, subId),
                setTaskAutomation: (taskId, aa, ar) => this.actionsService.setTaskAutomationByTaskId(taskId, aa, ar),
                openFolderLocation: async (taskId, location) => this.actionsService.openFolderLocationByTaskId(taskId, location),
                openArtifact: async (taskId, artifact) => this.actionsService.openArtifactByTaskId(taskId, artifact),
                nextStage: async (taskId, step, targetStage) => this.actionsService.nextStageByTaskId(taskId, step, targetStage),
                pass: async (taskId) => this.actionsService.passByTaskId(taskId),
                syncMainCode: async (taskId) => this.actionsService.syncMainCodeByTaskId(taskId),
                startService: async (taskId, target) => this.actionsService.startServiceByTaskId(taskId, target),
                completeDevWithPush: async (taskId) => this.actionsService.completeDevWithPush(taskId),
                pushAndNextStage: async (taskId) => this.actionsService.pushAndNextStage(taskId),
            });
            this.promptService.ensureProjectPrompts();
            startMasterArtifactWatcher(this.context, {
                workspaceRoot,
                baseDirName: BASE,
            });
            this.loadTasks();
            this.loadConfig();
            if (!this.taskStore.configFileExists()) {
                this.currentPage = 'settings';
            }
            this.gitService.setConfig(this.config);
            setInterval(async () => {
                if (this.currentPage !== 'main' || this.autoAdvanceRunning) {
                    return;
                }
                this.autoAdvanceRunning = true;
                try {
                    await this.actionsService.autoAdvanceReadyTasks();
                    this.render();
                } finally {
                    this.autoAdvanceRunning = false;
                }
            }, 2000);
            this.initializationError = undefined;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.initializationError = message;
            console.error('Fun Harness initialization failed:', error);
        }
    }

    private getScheduler(task: Task): TaskScheduler {
        return this.schedulerRegistry.get(task);
    }

    private loadConfig(): void {
        this.config = this.taskStore.loadConfig();
        this.configMeta = this.taskStore.getConfigMeta();
    }

    private saveConfig(): void {
        this.taskStore.saveConfig(this.config);
        this.configMeta = this.taskStore.getConfigMeta();
        this.gitService.setConfig(this.config);
    }

    private loadTasks(): void {
        this.tasks = this.taskStore.loadTasks();
    }

    private saveTasks(): void {
        this.taskStore.saveTasks(this.tasks);
    }

    private getIterationDir(task: Task): string {
        return this.taskStore.getIterationDir(task);
    }

    private getTaskStats(task: Task): TaskStats {
        const scheduler = this.getScheduler(task);
        const subTasks = scheduler.parseTasksMd();
        if (subTasks.length === 0) {
            return { total: 0, todo: 0, doing: 0, done: 0, failed: 0 };
        }
        return {
            total: subTasks.length,
            todo: subTasks.filter(t => t.status === 'todo').length,
            doing: subTasks.filter(t => t.status === 'doing').length,
            done: subTasks.filter(t => t.status === 'done').length,
            failed: subTasks.filter(t => t.status === 'failed').length
        };
    }

    // ─── Render ───

    render(): void {
        const webview = this.sidebarView?.webview ?? this.panel?.webview;
        if (!webview) return;
        if (this.initializationError) {
            webview.html = buildErrorPageHtml(
                'Fun Harness 初始化失败',
                this.initializationError,
                `openedWorkspace: ${this.openedWorkspacePath || '(unknown)'}\nworkspaceRoot: ${workspaceRoot || '(unknown)'}`
            );
            return;
        }
        try {
        if (this.currentPage === 'settings') return this.renderSettings();
        const running = this.tasks.filter(t => t.stage !== STAGE.DONE);
        const taskViews: MainTaskViewModel[] = running.map((task) => {
            const stats = this.getTaskStats(task);
            const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
            const scheduler = this.getScheduler(task);
            const subTasks = scheduler.parseTasksMd();
            const iterDir = this.getIterationDir(task);
            const testScriptName = process.platform === 'win32' ? 'test-api.ps1' : 'test-api.sh';
            const frontendDir = path.join(iterDir, 'frontend');
            const backendDir = path.join(iterDir, 'backend');
            const docsDir = path.join(iterDir, 'docs');
            const mainFrontendDir = path.join(workspaceRoot, 'repos', 'frontend-main');
            const mainBackendDir = path.join(workspaceRoot, 'repos', 'backend-main');
            const requirementsFile = path.join(docsDir, 'requirements.md');
            const designFile = path.join(docsDir, 'design.md');
            const taskPlanFile = fs.existsSync(path.join(iterDir, ...TASK_PLAN_PRIMARY_REL_PATH.split('/')))
                ? path.join(iterDir, ...TASK_PLAN_PRIMARY_REL_PATH.split('/'))
                : path.join(iterDir, ...TASK_PLAN_LEGACY_REL_PATH.split('/'));
            const artifacts = {
                requirements: fs.existsSync(requirementsFile),
                requirementsReady: this.hasMeaningfulArtifactContent(requirementsFile),
                design: fs.existsSync(designFile),
                designReady: this.hasMeaningfulArtifactContent(designFile),
                testcase: fs.existsSync(path.join(docsDir, 'testcase.md')),
                tasks: fs.existsSync(taskPlanFile),
                testScript: fs.existsSync(path.join(iterDir, 'tests', testScriptName)),
            };
            const rawHealth = {
                worktreeExists: fs.existsSync(iterDir),
                frontendExists: fs.existsSync(frontendDir),
                backendExists: fs.existsSync(backendDir),
                mainFrontendExists: fs.existsSync(mainFrontendDir),
                mainBackendExists: fs.existsSync(mainBackendDir),
                branchRouteReady: Boolean(task.iterationBranch),
                mergeRouteReady: Boolean(task.mergeTargetBranchUsed),
            };
            const healthReasons: string[] = [];
            let severity: 'good' | 'warn' | 'bad' = 'good';

            if (!rawHealth.worktreeExists) {
                healthReasons.push('worktree 缺失');
                severity = 'bad';
            }
            if (!rawHealth.frontendExists && !rawHealth.backendExists) {
                healthReasons.push('前后端目录都缺失');
                severity = 'bad';
            }
            if (!rawHealth.branchRouteReady) {
                healthReasons.push('迭代分支未记录');
                severity = 'bad';
            }
            if (stats.failed > 0) {
                healthReasons.push(`存在 ${stats.failed} 个失败子任务`);
                severity = 'bad';
            }
            if (severity !== 'bad' && !rawHealth.mergeRouteReady) {
                healthReasons.push('目标合并分支未配置');
                severity = 'warn';
            }
            if (severity === 'good' && !artifacts.testcase && task.stage !== STAGE.WRITING_REQUIREMENT && task.stage !== STAGE.WRITING_DESIGN) {
                healthReasons.push('缺少 testcase 产物');
                severity = 'warn';
            }
            if (severity === 'good' && !artifacts.tasks && task.stage === STAGE.DEVELOPING) {
                healthReasons.push(`开发阶段缺少 ${TASK_PLAN_PRIMARY_REL_PATH}（兼容 ${TASK_PLAN_LEGACY_REL_PATH}）`);
                severity = 'warn';
            }

            return {
                task,
                stats,
                pct,
                subTasks,
                latestFailureReason: this.readLatestFailureReason(iterDir, subTasks),
                isAuto: scheduler.isAutoMode(),
                artifacts,
                health: {
                    ...rawHealth,
                    severity,
                    summary: healthReasons.length > 0 ? healthReasons.join('；') : '状态正常',
                },
            };
        });
        taskViews.sort((left, right) => {
            const severityRank = { bad: 0, warn: 1, good: 2 };
            const leftRank = severityRank[left.health.severity];
            const rightRank = severityRank[right.health.severity];
            if (leftRank !== rightRank) {
                return leftRank - rightRank;
            }
            if (left.isAuto !== right.isAuto) {
                return left.isAuto ? -1 : 1;
            }
            if (left.stats.doing !== right.stats.doing) {
                return right.stats.doing - left.stats.doing;
            }
            return left.task.name.localeCompare(right.task.name);
        });

        const activeAutoCount = taskViews.filter(view => view.isAuto).length;
        const abnormalCount = taskViews.filter(view => view.health.severity !== 'good').length;
        webview.html = buildMainPageHtml(taskViews, {
            activeAutoCount,
            maxConcurrentAutoTasks: this.config.maxConcurrentAutoTasks,
            abnormalCount,
        }, {
            compactTaskDecomposition: this.config.compactTaskDecomposition,
            isWorktreeSubview: this.isWorktreeSubview(),
            frontendStartCmd: this.config.frontendStartCmd,
            backendStartCmd: this.config.backendStartCmd,
        });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            webview.html = buildErrorPageHtml(
                'Fun Harness 渲染失败',
                message,
                `openedWorkspace: ${this.openedWorkspacePath || '(unknown)'}\nworkspaceRoot: ${workspaceRoot || '(unknown)'}`
            );
        }
    }

    private renderSettings(): void {
        const webview = this.sidebarView?.webview ?? this.panel?.webview;
        if (!webview) return;
        try {
            webview.html = buildSettingsPageHtml(
                this.config,
                this.selectedPromptKey,
                PROMPT_CONFIGS,
                this.configMeta,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            webview.html = buildErrorPageHtml('Fun Harness 设置页渲染失败', message);
        }
    }

    // ─── Messages ───

    private bindToWebview(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (msg: HarnessMessage) => {
            await this.messageController.handle(msg);
        });
    }

    attachSidebarView(view: vscode.WebviewView): void {
        this.sidebarView = view;
        this.bindToWebview(view.webview);
        view.onDidDispose(() => { this.sidebarView = undefined; });
        this.render();
    }

    private restoreSelectedAgentPrompt(): void {
        this.promptService.restoreAgentPrompt(this.selectedPromptKey);
        vscode.window.showInformationMessage('✅ Agent Prompt 已恢复出厂设置');
    }

    private async handleSaveGit(frontendGit: string, backendGit: string, mergeTargetBranch: string, baseSyncBranch: string, dryRun: boolean): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }
        if (!frontendGit && !backendGit) {
            vscode.window.showWarningMessage('请至少填写一个 Git 地址（前端或后端）');
            return;
        }
        this.config.frontendGit = frontendGit;
        this.config.backendGit = backendGit;
        this.config.mergeTargetBranch = mergeTargetBranch;
        this.config.baseSyncBranch = baseSyncBranch;
        this.config.mergeDryRunEnabled = dryRun;
        this.saveConfig();
        this.gitService.setConfig(this.config);

        vscode.window.showInformationMessage('⏳ 正在初始化代码仓库...');
        const result = await this.gitService.initializeRepos();
        if (result.success) {
            vscode.window.showInformationMessage(result.message);
        } else {
            vscode.window.showErrorMessage(result.message);
        }
    }

    private handleSaveDevConfig(msg: Extract<HarnessMessage, { type: 'saveDevConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }

        const customClaudeTemplate = (msg.cct || '').trim();
        if (msg.ap === 'claude-cli' && customClaudeTemplate && !customClaudeTemplate.includes('{promptFile}')) {
            vscode.window.showErrorMessage(
                'Claude CLI 命令模板必须包含 {promptFile} 占位符，例如：Get-Content -Raw "{promptFile}" | claude。已拦截保存。'
            );
            return;
        }

        this.config.backendStartCmd = msg.bsc;
        this.config.backendPort = msg.bp;
        this.config.frontendStartCmd = msg.fsc;
        this.config.techStack = msg.ts;
        this.config.codingStandards = msg.cs;
        this.config.maxConcurrentAutoTasks = Math.max(1, msg.mc || 1);
        this.config.autoAdvanceEnabled = msg.aa;
        this.config.autoRepairEnabled = msg.ar;
        this.config.autoContinueAfterManualDone = msg.am;
        this.config.compactTaskDecomposition = msg.cm;
        this.config.autoDetectTaskSplitMode = msg.ad;
        this.config.simpleTaskKeywords = msg.sk;
        this.config.complexTaskKeywords = msg.ck;
        this.config.aiProvider = msg.ap;
        this.config.claudeCliCommandTemplate = msg.cct;
        this.config.aiFallbackToManual = msg.afm;
        this.config.worktreeSyncPaths = msg.wsd;
        this.saveConfig();
        vscode.window.showInformationMessage('✅ 开发配置已保存');
    }

    createPanel(): void {
        this.panel = vscode.window.createWebviewPanel('harness', '🤖 AI 研发流程', vscode.ViewColumn.Beside, { enableScripts: true });
        this.bindToWebview(this.panel.webview);
        this.render();
        this.panel.onDidDispose(() => { this.panel = null; });
    }

    private saveAndRender(): void {
        this.saveTasks();
        this.render();
    }

    private isWorktreeSubview(): boolean {
        // workspaceRoot may be normalized to project root; use original opened path for subview detection.
        const openedPath = this.openedWorkspacePath || workspaceRoot;
        const inWorktreeDir = openedPath.includes(path.sep + 'worktrees' + path.sep) || openedPath.endsWith('-worktree');
        return this.configMeta.origin === 'worktreeSnapshot' || inWorktreeDir;
    }

    stopAllSchedulers(): void {
        this.schedulerRegistry.stopAll();
    }

    private readLatestFailureReason(iterDir: string, subTasks: SubTask[]): string {
        const failed = subTasks.filter(item => item.status === 'failed').map(item => item.id);
        if (failed.length === 0) {
            return '';
        }

        for (const subId of failed) {
            const logPath = path.join(iterDir, 'logs', `task-${subId}.log`);
            if (!fs.existsSync(logPath)) {
                continue;
            }
            const lines = fs.readFileSync(logPath, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                const line = lines[i];
                if (/❌|⏰|失败|超时/i.test(line)) {
                    return `[${subId}] ${line.replace(/^\[[^\]]+\]\s*/, '')}`;
                }
            }
        }

        return `存在失败子任务：${failed.join(', ')}`;
    }

    private hasMeaningfulArtifactContent(filePath: string): boolean {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        try {
            return fs.readFileSync(filePath, 'utf8').trim().length > 0;
        } catch {
            return false;
        }
    }
}

export function deactivate(): void {
    if (harness) {
        harness.stopAllSchedulers();
    }
}
