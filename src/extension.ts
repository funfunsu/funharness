import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    BASE,
    Config,
    CUSTOM_SCRIPT_DIR,
    CustomButton,
    DEFAULT_AUTO_POLL_PROMPT,
    DEFAULT_CONFIG,
    DEFAULT_POLL_SCRIPT,
    TODO_FILE,
    STAGE,
    SubTask,
    TASK_PLAN_LEGACY_REL_PATH,
    TASK_PLAN_PRIMARY_REL_PATH,
    Task,
    TaskStats,
    getAiProvider
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
import { ProjectStructureService } from './services/projectStructureService';
import { AutoPollService } from './services/autoPollService';

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
    private config: Config = { ...DEFAULT_CONFIG };
    private schedulerRegistry!: SchedulerRegistry;
    private taskStore!: TaskStoreService;
    private configMeta: HarnessConfigMeta = { origin: 'unknown', readOnly: false };
    private promptService!: PromptService;
    private gitService: GitService = new GitService(this.config);
    private messageController!: HarnessMessageController;
    private actionsService!: HarnessActionsService;
    private aiDispatchService!: AiDispatchService;
    private projectStructureService!: ProjectStructureService;
    private autoPollService!: AutoPollService;
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
            // Keep all reads/writes bounded to the currently opened workspace.
            workspaceRoot = this.openedWorkspacePath;

            this.gitService.setWorkspaceRoot(workspaceRoot);
            this.taskStore = new TaskStoreService(workspaceRoot);
            this.promptService = new PromptService(workspaceRoot, extensionPath);
            this.projectStructureService = new ProjectStructureService(workspaceRoot, extensionPath);
            this.aiDispatchService = new AiDispatchService(() => this.config);
            this.autoPollService = new AutoPollService({
                getMasterRoot: () => this.getMasterRoot(),
                getConfig: () => this.config,
                getCurrentWorktreePath: () => this.openedWorkspacePath || workspaceRoot,
                onStatusChange: () => this.render(),
                dispatchTodo: async (todoContent, worktreePath, prompt) => this.dispatchTodoToAi(todoContent, worktreePath, prompt),
            });
            this.schedulerRegistry = new SchedulerRegistry(
                (task) => this.getIterationDir(task),
                workspaceRoot,
                () => this.config,
                async (query, iterDir, source, providerOverride) => this.aiDispatchService.dispatch(query, iterDir, source, providerOverride),
                () => this.render(),
                () => this.promptService.getRenderedPrompt('dev', '', '', workspaceRoot, this.config),
            );
            this.actionsService = new HarnessActionsService({
                getTasks: () => this.tasks,
                getConfig: () => this.config,
                getMasterRoot: () => this.getMasterRoot(),
                getIterationDir: (task) => this.getIterationDir(task),
                ensureIterationDir: (task) => this.taskStore.ensureIterationDir(task),
                saveAndRender: () => this.saveAndRender(),
                gitService: this.gitService,
                getScheduler: (task) => this.getScheduler(task),
                stopScheduler: (taskId) => this.schedulerRegistry.stop(taskId),
                onPass: (task) => vscode.window.showInformationMessage(`✅ ${task.name} 完成`),
                isWorktreeSubview: () => this.isWorktreeSubview(),
                dispatchAi: async (query, iterDir, source, providerOverride) => this.aiDispatchService.dispatch(query, iterDir, source, providerOverride),
                copyProjectStructureToIteration: (iterDir) => this.projectStructureService.copyRootStructureToIteration(iterDir),
                renderAgentPrompt: (step, taskName, taskDesc, iterDir) => this.promptService.getRenderedPromptWithSource(step, taskName, taskDesc, iterDir, this.config),
            });
            this.messageController = new HarnessMessageController({
                isWorktreeSubview: () => this.isWorktreeSubview(),
                setPage: (page) => { this.currentPage = page; },
                reloadTasks: () => this.loadTasks(),
                render: () => this.render(),
                restoreFactoryPrompts: () => this.handleRestoreFactoryPrompts(),
                saveGit: (frontendGit, backendGit, baseBranch, dryRun) => this.handleSaveGit(frontendGit, backendGit, baseBranch, dryRun),
                saveDevConfig: (msg) => this.handleSaveDevConfig(msg),
                saveRuntimeConfig: (msg) => this.handleSaveRuntimeConfig(msg),
                saveAdvancedConfig: (msg) => this.handleSaveAdvancedConfig(msg),
                initProjectStructure: () => this.handleInitProjectStructure(),
                applyProjectStructurePreview: () => this.handleApplyProjectStructurePreview(),
                openArtifactsIndex: () => this.handleOpenArtifactsIndex(),
                openMasterWorkspace: () => this.handleOpenMasterWorkspace(),
                autoDetectDevEnv: () => this.handleAutoDetectDevEnv(),
                testAiProvider: async () => this.aiDispatchService.testConnection(),
                setSubTaskStatus: async (taskId, subId, status) => this.actionsService.setSubTaskStatusByTaskId(taskId, subId, status),
                createTask: async (name, desc, quickMode) => this.actionsService.createTask(name, desc, quickMode),
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
                setTaskAiProvider: (taskId, ap) => {
                    const task = this.tasks.find(t => t.id === taskId);
                    if (task) {
                        task.aiProvider = ap;
                        this.saveAndRender();
                    }
                },
                openFolderLocation: async (taskId, location) => this.actionsService.openFolderLocationByTaskId(taskId, location),
                openArtifact: async (taskId, artifact) => this.actionsService.openArtifactByTaskId(taskId, artifact),
                nextStage: async (taskId, step, targetStage) => this.actionsService.nextStageByTaskId(taskId, step, targetStage),
                pass: async (taskId) => this.actionsService.passByTaskId(taskId),
                syncMainCode: async (taskId) => this.actionsService.syncMainCodeByTaskId(taskId),
                startService: async (taskId, target) => this.actionsService.startServiceByTaskId(taskId, target),
                startServices: async (taskId) => this.actionsService.startServicesByTaskId(taskId),
                completeDevWithPush: async (taskId) => this.actionsService.completeDevWithPush(taskId),
                pushAndNextStage: async (taskId) => this.actionsService.pushAndNextStage(taskId),
                commitToBaseline: async (taskId) => this.actionsService.commitToBaselineByTaskId(taskId),
                saveCustomButtons: (buttons) => this.handleSaveCustomButtons(buttons),
                runCustomButton: async (taskId, buttonId) => this.actionsService.runCustomButtonByTaskId(taskId, buttonId),
                runMainCustomButton: async (buttonId) => this.actionsService.runStandaloneCustomButton(buttonId),
                openScriptDir: () => this.handleOpenScriptDir(),
                saveAutoPollConfig: (msg) => this.handleSaveAutoPollConfig(msg),
                createPollScriptTemplate: () => this.handleCreatePollScriptTemplate(),
                toggleAutoPoll: (enable) => this.handleToggleAutoPoll(enable),
            });
            startMasterArtifactWatcher(this.context, {
                workspaceRoot,
                baseDirName: BASE,
            });
            this.loadTasks();
            this.loadConfig();
            this.ensureProjectStructureBaseline();
            if (!this.taskStore.configFileExists()) {
                this.currentPage = 'settings';
            }
            this.gitService.setConfig(this.config);
            // If this worktree window left auto-polling on before a reload, pick it back up.
            if (this.isWorktreeSubview()) {
                this.autoPollService.resumeIfOwnedAfterReload();
            }
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
        const effectiveGitRoot = (this.configMeta.origin === 'worktreeSnapshot' && this.configMeta.masterRoot && fs.existsSync(this.configMeta.masterRoot))
            ? this.configMeta.masterRoot
            : workspaceRoot;
        this.gitService.setWorkspaceRoot(effectiveGitRoot);
    }

    private saveConfig(): void {
        this.taskStore.saveConfig(this.config);
        this.configMeta = this.taskStore.getConfigMeta();
        this.gitService.setConfig(this.config);
    }

    private loadTasks(): void {
        this.tasks = this.taskStore.loadTasks();
        this.reconcileStagesWithArtifacts();
    }

    /**
     * Auto-advance task stages to match existing artifacts on disk.
     * This handles the case where an AI tool (e.g. Claude Code) generates
     * multiple artifacts in one go but the user didn't click each confirm button.
     */
    private reconcileStagesWithArtifacts(): void {
        let dirty = false;
        for (const task of this.tasks) {
            if (task.stage === STAGE.DONE || task.stage === STAGE.READY_FOR_REVIEW) {
                continue;
            }
            const iterDir = this.getIterationDir(task);
            const docsDir = path.join(iterDir, 'docs');
            const hasRequirements = this.hasMeaningfulArtifactContent(path.join(docsDir, 'requirements.md'));
            const hasDesign = this.hasMeaningfulArtifactContent(path.join(docsDir, 'design.md'));
            const hasTaskPlan = fs.existsSync(path.join(iterDir, ...TASK_PLAN_PRIMARY_REL_PATH.split('/')))
                || fs.existsSync(path.join(iterDir, ...TASK_PLAN_LEGACY_REL_PATH.split('/')));

            let target = task.stage;
            if (hasTaskPlan) {
                target = STAGE.DEVELOPING;
            } else if (hasDesign) {
                target = STAGE.WRITING_TASKS;
            } else if (hasRequirements) {
                target = STAGE.WRITING_DESIGN;
            }

            // Only advance, never regress
            const stageOrder = [
                STAGE.INITIALIZING, STAGE.WRITING_REQUIREMENT, STAGE.WRITING_DESIGN,
                STAGE.WRITING_TESTCASE, STAGE.WRITING_TASKS, STAGE.DEVELOPING,
                STAGE.READY_FOR_REVIEW, STAGE.DONE,
            ];
            if (stageOrder.indexOf(target) > stageOrder.indexOf(task.stage)) {
                task.stage = target;
                dirty = true;
            }
        }
        if (dirty) {
            this.saveTasks();
        }
    }

    private saveTasks(): void {
        this.taskStore.saveTasks(this.tasks);
    }

    private getIterationDir(task: Task): string {
        return this.taskStore.getIterationDir(task);
    }

    /** The master workspace root ("主目录"), resolved even from a worktree subview window. */
    private getMasterRoot(): string {
        if (this.configMeta.origin === 'worktreeSnapshot' && this.configMeta.masterRoot && fs.existsSync(this.configMeta.masterRoot)) {
            return this.configMeta.masterRoot;
        }
        return workspaceRoot;
    }

    /** File names available for custom buttons, scanned from <masterRoot>/script/. */
    private listCustomScripts(): string[] {
        const dir = path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR);
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => e.isFile() && !e.name.startsWith('.'))
                .map(e => e.name)
                .sort((a, b) => a.localeCompare(b));
        } catch {
            return [];
        }
    }

    /** Create (if needed) and reveal the shared script dir, guiding the user to put scripts there. */
    private async handleOpenScriptDir(): Promise<void> {
        const dir = path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            // best-effort
        }
        try {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        } catch {
            // reveal is best-effort; the path is still shown below
        }
        vscode.window.showInformationMessage(`请将脚本放入此目录后点「刷新脚本列表」：${dir}`);
        this.renderSettings();
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
                mergeRouteReady: Boolean(task.baseBranchUsed),
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
            aiProvider: this.config.aiProvider,
            customButtons: this.config.customButtons || [],
            autoPoll: this.isWorktreeSubview() ? this.autoPollService.getStatus() : undefined,
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
                this.configMeta,
                this.listCustomScripts(),
                path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR),
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

    private handleRestoreFactoryPrompts(): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }
        try {
            const restored = this.promptService.restoreFactoryPrompts();
            vscode.window.showInformationMessage(`✅ 已将 ${restored.length} 个 Prompt 恢复为出厂设置（写入 .harness/prompts/）`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`恢复 Prompt 出厂设置失败：${message}`);
        }
    }

    private async handleSaveGit(frontendGit: string, backendGit: string, baseBranch: string, dryRun: boolean): Promise<void> {
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
        this.config.baseBranch = baseBranch;
        this.config.mergeDryRunEnabled = dryRun;
        this.saveConfig();
        this.gitService.setConfig(this.config);

        vscode.window.showInformationMessage('⏳ 正在初始化代码仓库...');
        const result = await this.gitService.initializeRepos();
        if (result.success) {
            vscode.window.showInformationMessage(result.message);
            await this.handleInitProjectStructure();
        } else {
            vscode.window.showErrorMessage(result.message);
        }
    }

    private handleSaveDevConfig(msg: Extract<HarnessMessage, { type: 'saveDevConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }

        const customCliTemplate = (msg.cct || '').trim();
        const selectedProvider = getAiProvider(msg.ap);
        if (selectedProvider.kind === 'cli' && customCliTemplate && !customCliTemplate.includes('{promptFile}')) {
            vscode.window.showErrorMessage(
                'CLI 命令模板必须包含 {promptFile} 占位符，例如：cat "{promptFile}" | claude。已拦截保存。'
            );
            return;
        }

        this.config.backendStartCmd = msg.bsc;
        this.config.backendPort = msg.bp;
        this.config.frontendStartCmd = msg.fsc;
        this.config.startupChainMode = msg.sm === 'light' ? 'light' : 'full';
        this.config.javaRuntimeProfile = (msg.jp || '').trim();
        this.config.frontendStartupTemplate = ((msg.fst || '').trim() || '{install} && {run}');
        this.config.backendStartupTemplate = ((msg.bst || '').trim() || '{install} && {offline} && {clean} && {run}');
        this.config.techStack = msg.ts;
        this.config.codingStandards = msg.cs;
        this.config.projectConventions = msg.pc;
        this.config.maxConcurrentAutoTasks = Math.max(1, msg.mc || 1);
        this.config.autoAdvanceEnabled = msg.aa;
        this.config.autoRepairEnabled = msg.ar;
        this.config.autoContinueAfterManualDone = msg.am;
        this.config.compactTaskDecomposition = msg.cm;
        this.config.autoDetectTaskSplitMode = msg.ad;
        this.config.simpleTaskKeywords = msg.sk;
        this.config.complexTaskKeywords = msg.ck;
        this.config.aiProvider = msg.ap;
        this.config.cliCommandTemplate = msg.cct;
        this.config.aiFallbackToManual = msg.afm;
        this.config.aiPanelAutoSubmit = msg.pas;
        this.config.worktreeSyncPaths = msg.wsd;
        this.config.customProjectStructure = msg.cps;
        this.config.projectStructureRefineMode = msg.prm === 'local' ? 'local' : 'local+ai';
        this.saveConfig();
        this.ensureProjectStructureBaseline();
        vscode.window.showInformationMessage('✅ 开发配置已保存');
    }

    private handleSaveRuntimeConfig(msg: Extract<HarnessMessage, { type: 'saveRuntimeConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }

        const customCliTemplate = (msg.cct || '').trim();
        const selectedProvider = getAiProvider(msg.ap);
        if (selectedProvider.kind === 'cli' && customCliTemplate && !customCliTemplate.includes('{promptFile}')) {
            vscode.window.showErrorMessage(
                'CLI 命令模板必须包含 {promptFile} 占位符，例如：cat "{promptFile}" | claude。已拦截保存。'
            );
            return;
        }

        this.config.backendStartCmd = msg.bsc;
        this.config.backendPort = msg.bp;
        this.config.frontendStartCmd = msg.fsc;
        this.config.startupChainMode = msg.sm === 'light' ? 'light' : 'full';
        this.config.javaRuntimeProfile = (msg.jp || '').trim();
        this.config.frontendStartupTemplate = ((msg.fst || '').trim() || '{install} && {run}');
        this.config.backendStartupTemplate = ((msg.bst || '').trim() || '{install} && {offline} && {clean} && {run}');
        this.config.aiProvider = msg.ap;
        this.config.cliCommandTemplate = msg.cct;
        this.config.aiFallbackToManual = msg.afm;
        this.config.aiPanelAutoSubmit = msg.pas;
        this.saveConfig();
        vscode.window.showInformationMessage('✅ 运行参数已保存');
    }

    private handleSaveAdvancedConfig(msg: Extract<HarnessMessage, { type: 'saveAdvancedConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }

        this.config.techStack = msg.ts;
        this.config.codingStandards = msg.cs;
        this.config.projectConventions = msg.pc;
        this.config.maxConcurrentAutoTasks = Math.max(1, msg.mc || 1);
        this.config.autoAdvanceEnabled = msg.aa;
        this.config.autoRepairEnabled = msg.ar;
        this.config.autoContinueAfterManualDone = msg.am;
        this.config.compactTaskDecomposition = msg.cm;
        this.config.autoDetectTaskSplitMode = msg.ad;
        this.config.simpleTaskKeywords = msg.sk;
        this.config.complexTaskKeywords = msg.ck;
        this.config.worktreeSyncPaths = msg.wsd;
        this.config.customProjectStructure = msg.cps;
        this.config.projectStructureRefineMode = msg.prm === 'local' ? 'local' : 'local+ai';
        this.saveConfig();
        this.ensureProjectStructureBaseline();
        vscode.window.showInformationMessage('✅ 高级策略已保存');
    }

    private handleSaveCustomButtons(buttons: { name: string; command: string; workdir?: string; placement?: 'iteration' | 'main' }[]): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改自定义按钮');
            return;
        }

        const normalized: CustomButton[] = (buttons || [])
            .map((b, i) => ({
                id: `cb_${i}`,
                name: (b.name || '').trim(),
                command: (b.command || '').trim(),
                workdir: (b.workdir || '').trim(),
                placement: b.placement === 'main' ? 'main' as const : 'iteration' as const,
            }))
            .filter(b => b.name && b.command);

        this.config.customButtons = normalized;
        this.saveConfig();
        // Push the latest buttons into existing worktree snapshots so their subview
        // panels reflect them after a window reload (new worktrees inherit on creation).
        this.taskStore.syncCustomButtonsToWorktrees(normalized);
        // Ensure the shared script dir exists so the user has a place to drop scripts.
        const scriptDir = path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR);
        try {
            fs.mkdirSync(scriptDir, { recursive: true });
        } catch {
            // best-effort
        }
        this.renderSettings();
        vscode.window.showInformationMessage(`✅ 已保存 ${normalized.length} 个自定义按钮。脚本请放在：${scriptDir}`);
    }

    private handleSaveAutoPollConfig(msg: Extract<HarnessMessage, { type: 'saveAutoPollConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，自动轮询设置请在主窗口修改');
            return;
        }
        const interval = Math.max(5, Math.floor(Number(msg.interval) || 0));
        const script = (msg.script || '').trim() || DEFAULT_POLL_SCRIPT;
        this.config.autoPollIntervalSec = interval;
        this.config.autoPollScript = script;
        this.config.autoPollPrompt = (msg.prompt || '').trim() || DEFAULT_AUTO_POLL_PROMPT;
        // Keep as-is (incl. an explicit empty string, which disables skip-matching). Markers are
        // matched per-line after trimming, so trailing blank lines are harmless.
        this.config.autoPollSkipMarkers = msg.skipMarkers ?? '';
        this.saveConfig();
        // Ensure the shared script dir exists so the user has somewhere to put the script.
        try {
            fs.mkdirSync(path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR), { recursive: true });
        } catch {
            // best-effort
        }
        this.renderSettings();
        vscode.window.showInformationMessage(
            `✅ 自动轮询设置已保存（间隔 ${interval}s，脚本 ${script}）。开启后将「拉取并执行」：拉到新内容即派发给当前任务的 AI 执行器。`
        );
    }

    /**
     * Invoked when a poll updates todo.md and auto-dispatch is on. Builds a prompt around the
     * pulled tasks and routes it through the shared AI dispatch path, honoring the active task's
     * configured AI executor (Claude Code panel/CLI, Copilot, etc.).
     */
    private async dispatchTodoToAi(todoContent: string, worktreePath: string, promptOverride?: string): Promise<void> {
        const task = this.tasks.find(t => t.stage !== STAGE.DONE) || this.tasks[0];
        const provider = (task?.aiProvider || this.config.aiProvider || '').trim() || undefined;
        const query = this.buildAutoPollDispatchQuery(todoContent, promptOverride);
        await this.aiDispatchService.dispatch(query, worktreePath, 'dev-subtask', provider);
    }

    /**
     * The auto-dispatch query is simply the user-configured prompt followed by the pulled todo.md
     * content. `promptOverride` carries the master-config value resolved by AutoPollService (so
     * worktree windows use the latest prompt, not their stale config snapshot); falls back to this
     * window's config and finally the built-in default.
     */
    private buildAutoPollDispatchQuery(todoContent: string, promptOverride?: string): string {
        const prompt = (promptOverride ?? this.config.autoPollPrompt ?? '').trim() || DEFAULT_AUTO_POLL_PROMPT;
        const trimmed = todoContent.length > 8000
            ? `${todoContent.slice(0, 8000)}\n... (内容过长已截断，请直接读取 ${TODO_FILE} 获取完整清单)`
            : todoContent;
        const todoBlock = todoContent.trim().startsWith('```') ? trimmed : '```markdown\n' + trimmed + '\n```';
        return [prompt, '', todoBlock].join('\n');
    }

    /** Scaffold a starter pull-task script (Node) under <masterRoot>/script/ if it doesn't exist yet. */
    private async handleCreatePollScriptTemplate(): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，请在主窗口创建脚本');
            return;
        }
        const scriptDir = path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR);
        const script = (this.config.autoPollScript || '').trim() || DEFAULT_POLL_SCRIPT;
        const scriptPath = path.join(scriptDir, script);
        try {
            fs.mkdirSync(scriptDir, { recursive: true });
        } catch {
            // best-effort
        }
        if (fs.existsSync(scriptPath)) {
            const doc = await vscode.workspace.openTextDocument(scriptPath);
            await vscode.window.showTextDocument(doc, { preview: false });
            vscode.window.showInformationMessage(`脚本已存在，已为你打开：${scriptPath}`);
            this.renderSettings();
            return;
        }
        const isJs = /\.(c|m)?js$/i.test(script);
        const template = isJs
            ? `// fun-harness 拉取远程任务脚本。\n// 约定：把本次拉取到的"任务清单"内容打印到 stdout（标准输出）。\n// 插件会读取 stdout：仅当内容非空且与现有 todo.md 不同才覆盖 todo.md。\n// 运行目录（cwd）为当前 worktree。运行方式：node ${script}\n\nasync function pullTasks() {\n    // TODO: 在这里实现你的远程拉取逻辑（如调用 API、读取队列等）。\n    // 返回 markdown 文本；返回空字符串表示"本次无新内容"，插件不会覆盖 todo.md。\n    return '';\n}\n\npullTasks()\n    .then((content) => {\n        if (content && content.trim()) {\n            process.stdout.write(content);\n        }\n    })\n    .catch((err) => {\n        console.error(err && err.stack ? err.stack : String(err));\n        process.exit(1);\n    });\n`
            : `#!/usr/bin/env bash\n# fun-harness 拉取远程任务脚本。\n# 约定：把本次拉取到的"任务清单"内容打印到 stdout（标准输出）。\n# 插件仅当内容非空且与现有 todo.md 不同才覆盖 todo.md。运行目录（cwd）为当前 worktree。\nset -euo pipefail\n\n# TODO: 在这里实现远程拉取逻辑，并 echo 出 markdown 内容。\n# 输出为空表示本次无新内容，插件不会覆盖 todo.md。\n`;
        fs.writeFileSync(scriptPath, template, 'utf8');
        const doc = await vscode.workspace.openTextDocument(scriptPath);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`✅ 已创建示例脚本：${scriptPath}`);
        this.renderSettings();
    }

    private handleToggleAutoPoll(enable: boolean): void {
        if (enable) {
            const task = this.tasks.find(t => t.stage !== STAGE.DONE) || this.tasks[0];
            this.autoPollService.enable(task?.name || path.basename(this.openedWorkspacePath || workspaceRoot));
        } else {
            this.autoPollService.disable();
        }
    }

    private ensureProjectStructureBaseline(): void {
        if (this.configMeta.readOnly || !this.projectStructureService) {
            return;
        }
        this.projectStructureService.ensureBaseline(this.config.customProjectStructure || '');
    }

    private async handleInitProjectStructure(): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此初始化项目结构');
            return;
        }
        if (!this.projectStructureService) {
            return;
        }

        const custom = (this.config.customProjectStructure || '').trim();
        if (custom) {
            this.projectStructureService.writeRootStructure(custom);
            const customDoc = await vscode.workspace.openTextDocument(this.projectStructureService.getRootStructureFilePath());
            await vscode.window.showTextDocument(customDoc, { preview: false, preserveFocus: false });
            vscode.window.showInformationMessage('已应用自定义项目结构。Design Agent 将以该文档为准。');
            return;
        }

        const detected = this.projectStructureService.detectStructureFromWorkspace();
        const previewPath = this.projectStructureService.writePreviewStructure(detected.content);
        const structureDoc = await vscode.workspace.openTextDocument(previewPath);
        await vscode.window.showTextDocument(structureDoc, { preview: false, preserveFocus: false });

        if (detected.detected && this.config.projectStructureRefineMode !== 'local') {
            const reviewPrompt = this.buildProjectStructureAiReviewPrompt(detected.content, detected.summary);
            try {
                await this.aiDispatchService.dispatch(reviewPrompt, workspaceRoot, 'stage-agent');
                vscode.window.showInformationMessage('已触发 AI 二次审阅：请根据 AI 建议完善预览文档后再点击“应用预览结构”。');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`AI 二次审阅触发失败：${message}`);
            }
        }

        if (detected.detected) {
            const action = await vscode.window.showInformationMessage(
                `已生成项目结构预览（${detected.summary}）。请先检查并可直接编辑该预览，完成后点击“应用预览结构到正式文档”。`,
                '改用默认结构',
                '立即应用预览'
            );
            if (action === '改用默认结构') {
                this.projectStructureService.writeRootStructure(this.projectStructureService.getDefaultStructure());
                const defaultDoc = await vscode.workspace.openTextDocument(this.projectStructureService.getRootStructureFilePath());
                await vscode.window.showTextDocument(defaultDoc, { preview: false, preserveFocus: false });
                vscode.window.showInformationMessage('已回退到默认项目结构模板。');
                return;
            }
            if (action === '立即应用预览') {
                await this.handleApplyProjectStructurePreview();
            }
            return;
        }

        this.projectStructureService.writeRootStructure(this.projectStructureService.getDefaultStructure());
        const defaultDoc = await vscode.workspace.openTextDocument(this.projectStructureService.getRootStructureFilePath());
        await vscode.window.showTextDocument(defaultDoc, { preview: false, preserveFocus: false });
        vscode.window.showInformationMessage('未检测到可提炼的现有结构，已写入默认项目结构模板。');
    }

    private buildProjectStructureAiReviewPrompt(detectedContent: string, summary: string): string {
        const requirementsPath = path.join(workspaceRoot, 'docs', 'requirements.md');
        const hasRequirements = fs.existsSync(requirementsPath);
        const requirementsHint = hasRequirements
            ? `需求文档存在：${requirementsPath}，请结合 Req-* 输出“本次需求潜在改动包路径模板”。`
            : '未检测到需求文档，先输出通用“需求类型 -> 包路径”映射模板。';

        return [
            '# 任务：项目结构二次审阅（仅输出可落地结构文档）',
            '',
            '请基于下方已提炼结构进行增强，目标是让后续 AI 开发可直接定位改动包与新增类落位。',
            '',
            '输出要求：',
            '1. 只输出 Markdown，可直接作为 docs/project-structure.md 内容。',
            '2. 保留“现有目录（检测结果）”，但必须补充：模块职责、改动包映射、新增类落包规则。',
            '3. 明确“当新增需求时，优先修改哪些 module/package”。',
            '4. 禁止泛泛建议，优先使用已出现的真实包路径。',
            `5. ${requirementsHint}`,
            '',
            `检测摘要：${summary}`,
            '',
            '--- 已提炼结构（待增强）---',
            detectedContent,
        ].join('\n');
    }

    private async handleApplyProjectStructurePreview(): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此应用预览结构');
            return;
        }
        if (!this.projectStructureService) {
            return;
        }

        const applied = this.projectStructureService.applyPreviewToRoot();
        if (!applied) {
            vscode.window.showWarningMessage('未找到可应用的预览结构，或预览内容为空。');
            return;
        }

        const rootDoc = await vscode.workspace.openTextDocument(this.projectStructureService.getRootStructureFilePath());
        await vscode.window.showTextDocument(rootDoc, { preview: false, preserveFocus: false });
        vscode.window.showInformationMessage('✅ 已将预览结构应用到正式文档（docs/project-structure.md）');
    }

    private async handleOpenArtifactsIndex(): Promise<void> {
        const masterRoot = this.configMeta.masterRoot || workspaceRoot;
        const indexPath = path.join(masterRoot, 'docs', 'artifacts-index.json');
        if (!fs.existsSync(indexPath)) {
            const initial = {
                version: 1,
                updatedAt: new Date().toISOString(),
                items: [],
            };
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            fs.writeFileSync(indexPath, JSON.stringify(initial, null, 2), 'utf8');
        }

        const doc = await vscode.workspace.openTextDocument(indexPath);
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    }

    private async handleOpenMasterWorkspace(): Promise<void> {
        const masterRoot = (this.configMeta.masterRoot || '').trim();
        if (!masterRoot) {
            vscode.window.showWarningMessage('未检测到主工作区路径，无法跳转。');
            return;
        }
        if (!fs.existsSync(masterRoot)) {
            vscode.window.showWarningMessage(`主工作区路径不存在：${masterRoot}`);
            return;
        }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(masterRoot), false);
    }

    private async handleAutoDetectDevEnv(): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此自动回填环境配置');
            return;
        }

        const frontendRoot = this.detectFrontendRoot();
        const backendRoot = this.detectBackendRoot();

        const frontendDetection = frontendRoot ? await this.detectOrGenerateFrontendStartCommand(frontendRoot) : { command: '', generated: false, note: '' };
        const frontendCmd = frontendDetection.command;
        const backendDetection = backendRoot ? await this.detectOrGenerateBackendStartCommand(backendRoot) : { command: '', generated: false, note: '' };
        const backendCmd = backendDetection.command;
        const backendPort = backendRoot ? this.detectBackendPort(backendRoot) : 0;

        const changes: string[] = [];
        if (frontendCmd) {
            this.config.frontendStartCmd = frontendCmd;
            changes.push(`前端启动命令=${frontendCmd}${frontendDetection.generated ? '（已自动补全 scripts.dev）' : ''}${frontendDetection.note ? `（${frontendDetection.note}）` : ''}`);
        }
        if (backendCmd) {
            this.config.backendStartCmd = backendCmd;
            changes.push(`后端启动命令=${backendCmd}${backendDetection.generated ? '（已自动补全 scripts.dev）' : ''}${backendDetection.note ? `（${backendDetection.note}）` : ''}`);
        }
        if (backendPort > 0) {
            this.config.backendPort = backendPort;
            changes.push(`后端端口=${backendPort}`);
        }

        this.saveConfig();
        this.render();

        if (changes.length === 0) {
            vscode.window.showInformationMessage('未检测到可回填的环境配置，已保留现有设置。');
            return;
        }

        vscode.window.showInformationMessage(`已自动回填环境配置：${changes.join('；')}`);
    }

    private async detectOrGenerateFrontendStartCommand(frontendRoot: string): Promise<{ command: string; generated: boolean; note: string }> {
        const mode = this.resolveStartupChainMode(this.config.startupChainMode);
        const template = (this.config.frontendStartupTemplate || '{install} && {run}').trim();
        const detected = this.detectFrontendStartCommand(frontendRoot);
        if (detected) {
            return {
                command: this.buildEnhancedNodeStartCommand(frontendRoot, detected, mode, template),
                generated: false,
                note: `增强启动链（${mode === 'full' ? '完整模式' : '轻量模式'}）`,
            };
        }

        const generatedScript = this.suggestFrontendDevScript(frontendRoot);
        if (!generatedScript) {
            return { command: '', generated: false, note: '' };
        }

        const action = await vscode.window.showInformationMessage(
            `未检测到 scripts.dev。是否按项目依赖自动生成 scripts.dev = \"${generatedScript}\"？`,
            '生成并回填',
            '仅本次使用',
            '跳过'
        );

        if (action === '生成并回填') {
            const updated = this.writeDevScriptToPackageJson(frontendRoot, generatedScript);
            if (updated) {
                return {
                    command: this.buildEnhancedNodeStartCommand(frontendRoot, 'npm run dev', mode, template),
                    generated: true,
                    note: `增强启动链（${mode === 'full' ? '完整模式' : '轻量模式'}）`,
                };
            }
        }

        if (action === '仅本次使用') {
            return {
                command: this.buildEnhancedNodeStartCommand(frontendRoot, generatedScript, mode, template),
                generated: false,
                note: `增强启动链（${mode === 'full' ? '完整模式' : '轻量模式'}）`,
            };
        }

        return { command: '', generated: false, note: '' };
    }

    private async detectOrGenerateBackendStartCommand(backendRoot: string): Promise<{ command: string; generated: boolean; note: string }> {
        const mode = this.resolveStartupChainMode(this.config.startupChainMode);
        const profile = (this.config.javaRuntimeProfile || '').trim();
        const template = (this.config.backendStartupTemplate || '{install} && {offline} && {clean} && {run}').trim();
        const javaCommand = this.detectEnhancedJavaBackendStartCommand(backendRoot, mode, profile, template);
        if (javaCommand) {
            return {
                command: javaCommand,
                generated: false,
                note: `增强启动链（Java ${mode === 'full' ? '完整模式' : '轻量模式'}${profile ? `，profile=${profile}` : ''}）`,
            };
        }

        const detectedNode = this.detectBackendNodeStartCommand(backendRoot);
        if (detectedNode) {
            return {
                command: this.buildEnhancedNodeStartCommand(backendRoot, detectedNode, mode, template),
                generated: false,
                note: `增强启动链（Node ${mode === 'full' ? '完整模式' : '轻量模式'}）`,
            };
        }

        const generatedScript = this.suggestBackendDevScript(backendRoot);
        if (!generatedScript) {
            return { command: '', generated: false, note: '' };
        }

        const action = await vscode.window.showInformationMessage(
            `未检测到后端可用启动脚本。是否按项目依赖自动生成 scripts.dev = "${generatedScript}"？`,
            '生成并回填',
            '仅本次使用',
            '跳过'
        );

        if (action === '生成并回填') {
            const updated = this.writeDevScriptToPackageJson(backendRoot, generatedScript);
            if (updated) {
                return {
                    command: this.buildEnhancedNodeStartCommand(backendRoot, 'npm run dev', mode, template),
                    generated: true,
                    note: `增强启动链（Node ${mode === 'full' ? '完整模式' : '轻量模式'}）`,
                };
            }
        }

        if (action === '仅本次使用') {
            return {
                command: this.buildEnhancedNodeStartCommand(backendRoot, generatedScript, mode, template),
                generated: false,
                note: `增强启动链（Node ${mode === 'full' ? '完整模式' : '轻量模式'}）`,
            };
        }

        return { command: '', generated: false, note: '' };
    }

    private detectFrontendRoot(): string {
        const candidates = [
            path.join(workspaceRoot, 'repos', 'frontend-main'),
            path.join(workspaceRoot, 'frontend'),
            workspaceRoot,
        ];
        for (const candidate of candidates) {
            const pkgPath = path.join(candidate, 'package.json');
            const srcPath = path.join(candidate, 'src');
            if (fs.existsSync(pkgPath) && fs.existsSync(srcPath)) {
                return candidate;
            }
        }
        return '';
    }

    private detectBackendRoot(): string {
        const candidates = [
            path.join(workspaceRoot, 'repos', 'backend-main'),
            path.join(workspaceRoot, 'backend'),
            workspaceRoot,
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(path.join(candidate, 'pom.xml')) || fs.existsSync(path.join(candidate, 'build.gradle'))) {
                return candidate;
            }
            if (fs.existsSync(path.join(candidate, 'package.json')) && fs.existsSync(path.join(candidate, 'src'))) {
                return candidate;
            }
        }
        return '';
    }

    private detectFrontendStartCommand(frontendRoot: string): string {
        const pkgPath = path.join(frontendRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            return '';
        }
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
            const scripts = pkg.scripts || {};
            if (scripts.dev) return 'npm run dev';
            if (scripts['start:dev']) return 'npm run start:dev';
            if (scripts.start) return 'npm run start';
            if (scripts.serve) return 'npm run serve';

            const inferred = this.inferRunScriptFromPackageScripts(
                scripts,
                ['watch', 'start:local', 'start-local', 'preview', 'compile'],
                [
                    /\bvite\b/i,
                    /next\s+dev/i,
                    /nuxt\s+dev/i,
                    /webpack\s+serve/i,
                    /react-scripts\s+start/i,
                    /astro\s+dev/i,
                    /vue-cli-service\s+serve/i,
                ]
            );
            if (inferred) return `npm run ${inferred}`;
        } catch {
            // ignore malformed package json.
        }
        return '';
    }

    private suggestFrontendDevScript(frontendRoot: string): string {
        const pkgPath = path.join(frontendRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            return '';
        }

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
                scripts?: Record<string, string>;
            };
            const deps = {
                ...(pkg.dependencies || {}),
                ...(pkg.devDependencies || {}),
            };

            if (deps.vite) return 'vite';
            if (deps.next) return 'next dev';
            if (deps.nuxt || deps['nuxt3']) return 'nuxt dev';
            if (deps['@vue/cli-service']) return 'vue-cli-service serve';
            if (deps['react-scripts']) return 'react-scripts start';
            if (deps.astro) return 'astro dev';
            if (deps['webpack-dev-server']) return 'webpack serve';
            if (deps.parcel) return 'parcel src/index.html';
        } catch {
            // ignore malformed package json.
        }

        return '';
    }

    private suggestBackendDevScript(backendRoot: string): string {
        const pkgPath = path.join(backendRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            return '';
        }

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = {
                ...(pkg.dependencies || {}),
                ...(pkg.devDependencies || {}),
            };

            if (deps['@nestjs/core']) return 'nest start --watch';
            if (deps.tsx) return 'tsx watch src/index.ts';
            if (deps.nodemon) return 'nodemon src/index.js';
            if (deps['ts-node-dev']) return 'ts-node-dev --respawn src/index.ts';
            if (deps.express || deps.fastify || deps.koa || deps.hapi) return 'node src/index.js';
        } catch {
            // ignore malformed package json.
        }

        return '';
    }

    private buildEnhancedNodeStartCommand(
        projectRoot: string,
        runCommand: string,
        mode: 'light' | 'full',
        template: string
    ): string {
        const packageManager = this.detectNodePackageManager(projectRoot);
        const installCommand = mode === 'full' ? this.getNodeInstallCommand(packageManager) : '';
        const normalizedRun = this.normalizeNodeRunCommand(runCommand.trim(), packageManager);
        const defaultTemplate = mode === 'full' ? '{install} && {run}' : '{run}';
        return this.applyStartupTemplate(template || defaultTemplate, {
            install: installCommand,
            run: normalizedRun,
            offline: '',
            clean: '',
        }, defaultTemplate);
    }

    private detectNodePackageManager(projectRoot: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
        if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
        if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
        if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
        return 'npm';
    }

    private getNodeInstallCommand(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
        if (packageManager === 'pnpm') return 'pnpm install';
        if (packageManager === 'yarn') return 'yarn install';
        if (packageManager === 'bun') return 'bun install';
        return 'npm install';
    }

    private normalizeNodeRunCommand(command: string, packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
        if (!command) {
            return '';
        }
        const match = command.match(/^npm\s+run\s+(.+)$/);
        if (!match) {
            return command;
        }
        const scriptName = match[1].trim();
        if (!scriptName) {
            return command;
        }
        if (packageManager === 'pnpm') {
            return `pnpm ${scriptName}`;
        }
        if (packageManager === 'yarn') {
            return `yarn ${scriptName}`;
        }
        if (packageManager === 'bun') {
            return `bun run ${scriptName}`;
        }
        return command;
    }

    private writeDevScriptToPackageJson(frontendRoot: string, devScript: string): boolean {
        const pkgPath = path.join(frontendRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            return false;
        }

        try {
            const raw = fs.readFileSync(pkgPath, 'utf8');
            const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
            const scripts = pkg.scripts || {};
            if (!scripts.dev) {
                scripts.dev = devScript;
                pkg.scripts = scripts;
                fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
                vscode.window.showInformationMessage(`已写入 ${path.join(frontendRoot, 'package.json')} 的 scripts.dev=${devScript}`);
            }
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`自动写入 scripts.dev 失败：${message}`);
            return false;
        }
    }

    private detectEnhancedJavaBackendStartCommand(
        backendRoot: string,
        mode: 'light' | 'full',
        profile: string,
        template: string
    ): string {
        const profileArgs = (runner: 'maven' | 'gradle'): string => {
            if (!profile) {
                return '';
            }
            if (runner === 'maven') {
                return ` -Dspring-boot.run.profiles=${profile}`;
            }
            return ` --args='--spring.profiles.active=${profile}'`;
        };

        const mavenSelector = this.resolveMavenBootRunSelector(backendRoot);

        if (fs.existsSync(path.join(backendRoot, 'mvnw'))) {
            const run = `./mvnw${mavenSelector} spring-boot:run${profileArgs('maven')}`;
            const fallback = mode === 'full' ? '{offline} && {clean} && {run}' : '{run}';
            const offline = mode === 'full' ? `./mvnw${mavenSelector} -DskipTests dependency:go-offline` : '';
            const clean = mode === 'full' ? `./mvnw${mavenSelector} -DskipTests clean` : '';
            return this.applyStartupTemplate(template, {
                install: '',
                offline,
                clean,
                run,
            }, fallback);
        }
        if (fs.existsSync(path.join(backendRoot, 'pom.xml'))) {
            const run = `mvn${mavenSelector} spring-boot:run${profileArgs('maven')}`;
            const fallback = mode === 'full' ? '{offline} && {clean} && {run}' : '{run}';
            const offline = mode === 'full' ? `mvn${mavenSelector} -DskipTests dependency:go-offline` : '';
            const clean = mode === 'full' ? `mvn${mavenSelector} -DskipTests clean` : '';
            return this.applyStartupTemplate(template, {
                install: '',
                offline,
                clean,
                run,
            }, fallback);
        }
        if (fs.existsSync(path.join(backendRoot, 'gradlew'))) {
            const run = `./gradlew bootRun${profileArgs('gradle')}`;
            const fallback = mode === 'full' ? '{offline} && {clean} && {run}' : '{run}';
            const offline = mode === 'full' ? './gradlew --refresh-dependencies' : '';
            const clean = mode === 'full' ? './gradlew clean' : '';
            return this.applyStartupTemplate(template, {
                install: '',
                offline,
                clean,
                run,
            }, fallback);
        }
        if (fs.existsSync(path.join(backendRoot, 'build.gradle'))) {
            const run = `gradle bootRun${profileArgs('gradle')}`;
            const fallback = mode === 'full' ? '{offline} && {clean} && {run}' : '{run}';
            const offline = mode === 'full' ? 'gradle --refresh-dependencies' : '';
            const clean = mode === 'full' ? 'gradle clean' : '';
            return this.applyStartupTemplate(template, {
                install: '',
                offline,
                clean,
                run,
            }, fallback);
        }
        return '';
    }

    private resolveMavenBootRunSelector(backendRoot: string): string {
        const rootPom = path.join(backendRoot, 'pom.xml');
        if (!fs.existsSync(rootPom)) {
            return '';
        }

        let rootPomRaw = '';
        try {
            rootPomRaw = fs.readFileSync(rootPom, 'utf8');
        } catch {
            return '';
        }

        const moduleMatches = Array.from(rootPomRaw.matchAll(/<module>\s*([^<\n\r]+)\s*<\/module>/gi));
        const modulePaths = moduleMatches
            .map((match) => (match[1] || '').trim())
            .filter(Boolean);
        const hasModules = modulePaths.length > 0;
        const rootIsPomPackaging = /<packaging>\s*pom\s*<\/packaging>/i.test(rootPomRaw);
        const rootHasBootPlugin = /spring-boot-maven-plugin/i.test(rootPomRaw);

        // Single-module executable project: run directly from backend root.
        if (!hasModules && rootHasBootPlugin) {
            return '';
        }

        // Aggregator root without modules fallback.
        if (!hasModules) {
            return '';
        }

        const scored: Array<{ modulePath: string; score: number }> = [];

        for (const modulePath of modulePaths) {
            const modulePom = path.join(backendRoot, modulePath, 'pom.xml');
            if (!fs.existsSync(modulePom)) {
                continue;
            }

            try {
                const raw = fs.readFileSync(modulePom, 'utf8');
                const hasBootPlugin = /spring-boot-maven-plugin/i.test(raw);
                const hasBootStarter = /spring-boot-starter/i.test(raw);
                const isPomPack = /<packaging>\s*pom\s*<\/packaging>/i.test(raw);
                if (!hasBootPlugin && (!hasBootStarter || isPomPack)) {
                    continue;
                }

                const name = modulePath.toLowerCase();
                let score = 0;
                if (hasBootPlugin) score += 100;
                if (hasBootStarter) score += 30;
                if (/start|boot|app|web/.test(name)) score += 20;
                if (/service/.test(name)) score += 10;
                scored.push({ modulePath, score });
            } catch {
                // Ignore malformed child pom and keep scanning.
            }
        }

        if (scored.length === 0) {
            // If root is not an aggregator and has boot plugin, keep root execution.
            if (!rootIsPomPackaging && rootHasBootPlugin) {
                return '';
            }
            return '';
        }

        scored.sort((a, b) => b.score - a.score);
        const target = scored[0].modulePath;
        const normalizedTarget = target.replace(/\\/g, '/').replace(/"/g, '\\"');
        return ` -f "${normalizedTarget}/pom.xml"`;
    }

    private resolveStartupChainMode(mode: string): 'light' | 'full' {
        return mode === 'light' ? 'light' : 'full';
    }

    private applyStartupTemplate(
        template: string,
        vars: { install: string; offline: string; clean: string; run: string },
        fallbackTemplate: string
    ): string {
        const effective = (template || fallbackTemplate || '{run}').trim() || '{run}';
        const rendered = effective
            .replace(/\{install\}/g, vars.install)
            .replace(/\{offline\}/g, vars.offline)
            .replace(/\{clean\}/g, vars.clean)
            .replace(/\{run\}/g, vars.run);

        const segments = rendered
            .split(/&&|\n/)
            .map(seg => seg.trim())
            .filter(Boolean);

        if (segments.length > 0) {
            return segments.join(' && ');
        }

        const fallbackRendered = fallbackTemplate
            .replace(/\{install\}/g, vars.install)
            .replace(/\{offline\}/g, vars.offline)
            .replace(/\{clean\}/g, vars.clean)
            .replace(/\{run\}/g, vars.run);

        return fallbackRendered
            .split(/&&|\n/)
            .map(seg => seg.trim())
            .filter(Boolean)
            .join(' && ');
    }

    private detectBackendNodeStartCommand(backendRoot: string): string {
        const pkgPath = path.join(backendRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            return '';
        }
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
            const scripts = pkg.scripts || {};
            if (scripts.dev) return 'npm run dev';
            if (scripts['start:dev']) return 'npm run start:dev';
            if (scripts.start) return 'npm run start';

            const inferred = this.inferRunScriptFromPackageScripts(
                scripts,
                ['watch', 'serve', 'preview', 'compile'],
                [
                    /nest\s+start\s+--watch/i,
                    /nodemon\b/i,
                    /tsx\s+watch/i,
                    /ts-node-dev\b/i,
                    /node\s+.+/i,
                ]
            );
            if (inferred) return `npm run ${inferred}`;
        } catch {
            // ignore malformed package json.
        }
        return '';
    }

    private inferRunScriptFromPackageScripts(
        scripts: Record<string, string>,
        preferredKeys: string[],
        commandMatchers: RegExp[]
    ): string {
        for (const key of preferredKeys) {
            if (scripts[key]) {
                return key;
            }
        }

        for (const [key, cmd] of Object.entries(scripts)) {
            if (/(^|[:_-])(dev|start|serve|watch|local)([:_-]|$)/i.test(key) && cmd.trim()) {
                return key;
            }
        }

        for (const [key, cmd] of Object.entries(scripts)) {
            if (commandMatchers.some((matcher) => matcher.test(cmd))) {
                return key;
            }
        }

        return '';
    }

    private detectBackendPort(backendRoot: string): number {
        const files = [
            path.join(backendRoot, 'src', 'main', 'resources', 'application.yml'),
            path.join(backendRoot, 'src', 'main', 'resources', 'application.yaml'),
            path.join(backendRoot, 'src', 'main', 'resources', 'application.properties'),
            path.join(backendRoot, '.env'),
        ];

        for (const file of files) {
            if (!fs.existsSync(file)) {
                continue;
            }
            const raw = fs.readFileSync(file, 'utf8');
            const yamlMatch = raw.match(/server\s*:\s*[\s\S]*?port\s*:\s*(\d{2,5})/m);
            if (yamlMatch) {
                return Number(yamlMatch[1]);
            }
            const propMatch = raw.match(/(?:server\.port|PORT)\s*[=:]\s*(\d{2,5})/m);
            if (propMatch) {
                return Number(propMatch[1]);
            }
        }

        return this.config.backendPort || 8080;
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

    disposeAutoPoll(): void {
        this.autoPollService?.dispose();
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
        harness.disposeAutoPoll();
    }
}
