import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    BASE,
    Config,
    CUSTOM_SCRIPT_DIR,
    CustomButton,
    CustomButtonScriptSource,
    DEFAULT_AUTO_POLL_PROMPT,
    DEFAULT_CONFIG,
    DEFAULT_MONOREPO_DIRS,
    DEFAULT_POLL_SCRIPT,
    HARNESS_LOG_FILE,
    PROMPTS_DIR,
    ScriptInventory,
    TODO_FILE,
    STAGE,
    SubTask,
    TASK_PLAN_LEGACY_REL_PATH,
    TASK_PLAN_PRIMARY_REL_PATH,
    Task,
    TaskStats,
    getAiProvider,
    getScriptsSubdir,
    resolveSpecFile,
    resolveTaskPlanFileForIteration,
    isOsScriptFile,
    normalizeCustomButton
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
                (task, subTaskName) => this.promptService.getRenderedPrompt(
                    'dev',
                    (subTaskName || task.name || '').trim(),
                    (task.desc || '').trim(),
                    this.getIterationDir(task),
                    this.config,
                ),
            );
            this.actionsService = new HarnessActionsService({
                getTasks: () => this.tasks,
                getConfig: () => this.config,
                reloadConfig: () => this.loadConfig(),
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
                copyProjectStructureToIteration: (iterDir) => this.copyProjectStructureToIteration(iterDir),
                renderAgentPrompt: (step, taskName, taskDesc, iterDir) => this.promptService.getRenderedPromptWithSource(step, taskName, taskDesc, iterDir, this.config),
            });
            this.messageController = new HarnessMessageController({
                isWorktreeSubview: () => this.isWorktreeSubview(),
                setPage: (page) => { this.currentPage = page; },
                reloadTasks: () => { if (this.isWorktreeSubview()) { this.loadConfig(); } this.loadTasks(); },
                render: () => this.render(),
                openCustomPrompt: (step) => this.handleOpenCustomPrompt(step),
                saveGit: (frontendGit, backendGit, baseBranch, dryRun, monorepoGit, monorepoDirs, mode) => this.handleSaveGit(frontendGit, backendGit, baseBranch, dryRun, monorepoGit, monorepoDirs, mode),
                saveAdvancedConfig: (msg) => this.handleSaveAdvancedConfig(msg),
                initProjectStructure: () => this.handleInitProjectStructure(),
                applyProjectStructurePreview: () => this.handleApplyProjectStructurePreview(),
                openArtifactsIndex: () => this.handleOpenArtifactsIndex(),
                openMasterWorkspace: () => this.handleOpenMasterWorkspace(),
                testAiProvider: async () => this.aiDispatchService.testConnection(),
                setSubTaskStatus: async (taskId, subId, status) => this.actionsService.setSubTaskStatusByTaskId(taskId, subId, status),
                createTask: async (name, desc, quickMode) => this.actionsService.createTask(name, desc, quickMode),
                createTaskFromTodo: async (name, desc) => this.actionsService.createTaskFromTodo(name, desc),
                logWebviewEvent: (taskId, event, detail) => this.actionsService.logUiEventByTaskId(taskId, event, detail),
                requestEditTaskDesc: async (taskId) => this.actionsService.promptUpdateTaskDescByTaskId(taskId),
                updateTaskDesc: (taskId, desc) => this.actionsService.updateTaskDescByTaskId(taskId, desc),
                resetTask: async (taskId) => this.actionsService.resetTaskByTaskId(taskId),
                pushAllCode: async (taskId) => this.actionsService.pushAllByTaskId(taskId),
                runAgent: async (taskId, step) => this.actionsService.runAgentByTaskId(taskId, step),
                specDeltaReview: async (taskId) => this.actionsService.reviewSpecDeltaByTaskId(taskId),
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
                completeDevWithPush: async (taskId) => this.actionsService.completeDevWithPush(taskId),
                pushAndNextStage: async (taskId) => this.actionsService.pushAndNextStage(taskId),
                commitToBaseline: async (taskId) => this.actionsService.commitToBaselineByTaskId(taskId),
                saveCustomButtons: (buttons) => this.handleSaveCustomButtons(buttons),
                runCustomButton: async (taskId, buttonId) => this.actionsService.runCustomButtonByTaskId(taskId, buttonId),
                runMainCustomButton: async (buttonId) => this.actionsService.runStandaloneCustomButton(buttonId),
                openScriptDir: () => this.handleOpenScriptDir(),
                openHarnessLog: () => this.handleOpenHarnessLog(),
                saveAutoPollConfig: (msg) => this.handleSaveAutoPollConfig(msg),
                createPollScriptTemplate: () => this.handleCreatePollScriptTemplate(),
                toggleAutoPoll: (enable) => this.handleToggleAutoPoll(enable),
                todoChanged: (msg) => {
                    const webview = this.sidebarView?.webview ?? this.panel?.webview;
                    webview?.postMessage(msg);
                },
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
            const hasTestcase = this.hasMeaningfulArtifactContent(resolveSpecFile(iterDir, this.config, 'testcase.md'));
            const hasTaskPlan = fs.existsSync(resolveTaskPlanFileForIteration(iterDir, this.config));

            let target = task.stage;
            if (hasTaskPlan) {
                target = STAGE.DEVELOPING;
            } else if (hasTestcase) {
                target = STAGE.WRITING_TASKS;
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

    /** Scan a directory for OS-appropriate script files (hidden files excluded). */
    private scanScriptDir(dir: string): string[] {
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => e.isFile() && !e.name.startsWith('.') && isOsScriptFile(e.name))
                .map(e => e.name)
                .sort((a, b) => a.localeCompare(b));
        } catch {
            return [];
        }
    }

    /**
     * Build the per-source script inventory the settings webview uses to populate button
     * dropdowns. Covers the shared master `script/` dir plus the committed scripts dirs of the
     * main clone(s) — mono-main in monorepo mode, or frontend/backend-main in multi-repo mode.
     */
    private buildScriptInventory(): ScriptInventory {
        const masterRoot = this.getMasterRoot();
        const isMono = Boolean((this.config.monorepoGit || '').trim());
        const scriptsSubdir = getScriptsSubdir(this.config);
        const masterDir = path.join(masterRoot, CUSTOM_SCRIPT_DIR);
        const inventory: ScriptInventory = {
            mode: isMono ? 'mono' : 'multi',
            scriptsSubdir,
            master: this.scanScriptDir(masterDir),
            repoMono: [],
            repoFrontend: [],
            repoBackend: [],
            dirs: { master: masterDir },
        };
        if (isMono) {
            const monoDir = path.join(masterRoot, 'repos', 'mono-main', scriptsSubdir);
            inventory.repoMono = this.scanScriptDir(monoDir);
            inventory.dirs.repoMono = monoDir;
        } else {
            const feDir = path.join(masterRoot, 'repos', 'frontend-main', scriptsSubdir);
            const beDir = path.join(masterRoot, 'repos', 'backend-main', scriptsSubdir);
            inventory.repoFrontend = this.scanScriptDir(feDir);
            inventory.repoBackend = this.scanScriptDir(beDir);
            inventory.dirs.repoFrontend = feDir;
            inventory.dirs.repoBackend = beDir;
        }
        return inventory;
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

    /** Open the unified harness log file in the editor for troubleshooting. */
    private handleOpenHarnessLog(): void {
        const masterRoot = this.getMasterRoot();
        const logPath = path.join(masterRoot, BASE, HARNESS_LOG_FILE);
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            if (!fs.existsSync(logPath)) {
                fs.writeFileSync(logPath, '', 'utf8');
            }
        } catch {
            // best-effort — vscode.open will still try
        }
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(logPath));
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
            const isMono = Boolean(this.config.monorepoGit?.trim());
            const monoDirs = this.config.monorepoDirs || DEFAULT_MONOREPO_DIRS;
            const frontendDir = path.join(iterDir, isMono ? (monoDirs.frontend || DEFAULT_MONOREPO_DIRS.frontend) : 'frontend');
            const backendDir = path.join(iterDir, isMono ? (monoDirs.backend || DEFAULT_MONOREPO_DIRS.backend) : 'backend');
            const mainFrontendDir = isMono ? path.join(workspaceRoot, 'repos', 'mono-main') : path.join(workspaceRoot, 'repos', 'frontend-main');
            const mainBackendDir = isMono ? path.join(workspaceRoot, 'repos', 'mono-main') : path.join(workspaceRoot, 'repos', 'backend-main');
            const requirementsFile = resolveSpecFile(iterDir, this.config, 'requirements.md');
            const designFile = resolveSpecFile(iterDir, this.config, 'design.md');
            const taskPlanFile = resolveTaskPlanFileForIteration(iterDir, this.config);
            const artifacts = {
                requirements: fs.existsSync(requirementsFile),
                requirementsReady: this.hasMeaningfulArtifactContent(requirementsFile),
                design: fs.existsSync(designFile),
                designReady: this.hasMeaningfulArtifactContent(designFile),
                testcase: fs.existsSync(resolveSpecFile(iterDir, this.config, 'testcase.md')),
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
            if (isMono) {
                if (!fs.existsSync(path.join(iterDir, '.git'))) {
                    healthReasons.push('仓库代码缺失');
                    severity = 'bad';
                }
            } else if (!rawHealth.frontendExists && !rawHealth.backendExists) {
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
                specDeltaStatus: this.actionsService.getTaskSpecDeltaStatus(task.id),
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

        webview.html = buildMainPageHtml(taskViews, {}, {
            compactTaskDecomposition: this.config.compactTaskDecomposition,
            isWorktreeSubview: this.isWorktreeSubview(),
            aiProvider: this.config.aiProvider,
            customButtons: this.config.customButtons || [],
            autoPollEnabled: this.config.autoPollEnabled,
            autoPoll: this.isWorktreeSubview() ? this.autoPollService.getStatus() : undefined,
            specDeltaOverview: this.isWorktreeSubview() ? undefined : this.actionsService.getSpecDeltaOverview(),
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
                this.buildScriptInventory(),
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

    private async handleOpenCustomPrompt(step: 'req' | 'des' | 'tcs' | 'tsk' | 'dev'): Promise<void> {
        const promptFileMap: Record<typeof step, string> = {
            req: 'requirements_custom_prompt.md',
            des: 'design_custom_prompt.md',
            tcs: 'testcase_custom_prompt.md',
            tsk: 'tasks_custom_prompt.md',
            dev: 'dev_custom_prompt.md',
        };
        const fileName = promptFileMap[step];
        const promptPath = path.join(this.getMasterRoot(), BASE, PROMPTS_DIR, fileName);
        const legacyPromptPath = path.join(this.getMasterRoot(), PROMPTS_DIR, fileName);
        try {
            fs.mkdirSync(path.dirname(promptPath), { recursive: true });
            if (!fs.existsSync(promptPath) && fs.existsSync(legacyPromptPath)) {
                // Auto-migrate legacy root-level prompts/<file> to .harness/prompts/<file>.
                fs.renameSync(legacyPromptPath, promptPath);
            }
            if (!fs.existsSync(promptPath)) {
                fs.writeFileSync(promptPath, '', 'utf8');
            }
            const document = await vscode.workspace.openTextDocument(promptPath);
            await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`打开 custom prompt 失败：${message}`);
        }
    }

    private async handleSaveGit(frontendGit: string, backendGit: string, baseBranch: string, dryRun: boolean, monorepoGit?: string, monorepoDirs?: { frontend?: string; backend?: string; docs?: string; scripts?: string }, mode?: 'mono' | 'multi'): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }
        // Resolve the active mode. Older webviews may not send `mode`; fall back to "monorepo when a
        // single-repo URL is present" to preserve prior behaviour.
        const activeMode: 'mono' | 'multi' = mode ?? ((monorepoGit || '').trim() ? 'mono' : 'multi');

        let mono = (monorepoGit || '').trim();
        if (activeMode === 'mono') {
            // Monorepo: require an explicit URL from the user.
            if (!mono) {
                vscode.window.showWarningMessage('单一仓库模式：请填写 Git 地址');
                return;
            }
        } else {
            // Multi-repo: explicitly disable monorepo mode and require at least one side URL.
            mono = '';
            if (!frontendGit && !backendGit) {
                vscode.window.showWarningMessage('多仓库模式：请至少填写前端或后端 Git 地址');
                return;
            }
        }
        this.config.monorepoGit = mono;
        if (monorepoDirs) {
            this.config.monorepoDirs = {
                frontend: DEFAULT_MONOREPO_DIRS.frontend,
                backend: DEFAULT_MONOREPO_DIRS.backend,
                docs: DEFAULT_MONOREPO_DIRS.docs,
                scripts: DEFAULT_MONOREPO_DIRS.scripts,
            };
        }
        // In monorepo mode the separate frontend/backend remotes are ignored; keep them stored so
        // switching back to multi-repo mode does not lose the previously configured URLs.
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

    private handleSaveAdvancedConfig(msg: Extract<HarnessMessage, { type: 'saveAdvancedConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改设置');
            return;
        }

        this.config.projectConventions = msg.pc;
        this.config.maxConcurrentAutoTasks = Math.max(1, msg.mc || 1);
        this.config.autoContinueAfterManualDone = msg.am;
        this.config.compactTaskDecomposition = msg.cm;
        this.config.autoDetectTaskSplitMode = msg.ad;
        this.config.simpleTaskKeywords = msg.sk;
        this.config.complexTaskKeywords = msg.ck;
        this.config.worktreeSyncPaths = msg.wsd;
        this.config.projectStructureRefineMode = msg.prm === 'local' ? 'local' : 'local+ai';
        this.config.specRootDir = (msg.srd || '').trim() || 'specs';
        this.config.gateLevel = (msg.gl === 'relaxed' || msg.gl === 'strict') ? msg.gl : 'standard';
        this.config.cliCommandTemplate = msg.cct;
        this.config.aiFallbackToManual = msg.afm;
        this.config.aiPanelAutoSubmit = msg.pas;
        this.saveConfig();
        this.ensureProjectStructureBaseline();
        vscode.window.showInformationMessage('✅ 高级策略已保存');
    }

    private handleSaveCustomButtons(buttons: { name: string; script?: string; args?: string; scriptSource?: string; command?: string; placement?: 'iteration' | 'main' }[]): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此修改自定义按钮');
            return;
        }

        const normalized: CustomButton[] = (buttons || [])
            .map((b, i) => normalizeCustomButton({
                id: `cb_${i}`,
                name: (b.name || '').trim(),
                scriptSource: (b.scriptSource as CustomButtonScriptSource | undefined),
                script: (b.script || '').trim(),
                args: (b.args || '').trim(),
                command: b.command,
                placement: b.placement === 'main' ? 'main' as const : 'iteration' as const,
            }))
            .filter(b => b.name && b.script);

        this.config.customButtons = normalized;
        this.saveConfig();
        // Push the latest buttons into existing worktree snapshots so their subview
        // panels reflect them after a window reload (new worktrees inherit on creation).
        this.taskStore.syncCustomButtonsToWorktrees(normalized);
        // Ensure the shared master script dir exists so the user always has a place to drop
        // uncommitted scripts (committed source dirs are created with the repo scaffold).
        const scriptDir = path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR);
        try {
            fs.mkdirSync(scriptDir, { recursive: true });
        } catch {
            // best-effort
        }
        this.renderSettings();
        vscode.window.showInformationMessage(`✅ 已保存 ${normalized.length} 个自定义按钮`);
    }

    private handleSaveAutoPollConfig(msg: Extract<HarnessMessage, { type: 'saveAutoPollConfig' }>): void {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，自动轮询设置请在主窗口修改');
            return;
        }
        const enabled = msg.enabled === true;
        const interval = Math.max(5, Math.floor(Number(msg.interval) || 0));
        const script = (msg.script || '').trim() || DEFAULT_POLL_SCRIPT;
        this.config.autoPollEnabled = enabled;
        this.config.autoPollIntervalSec = interval;
        this.config.autoPollScript = script;
        this.config.autoPollPrompt = (msg.prompt || '').trim() || DEFAULT_AUTO_POLL_PROMPT;
        // Keep as-is (incl. an explicit empty string, which disables skip-matching). Markers are
        // matched per-line after trimming, so trailing blank lines are harmless.
        this.config.autoPollSkipMarkers = msg.skipMarkers ?? '';
        this.saveConfig();
        // Ensure the shared script dir exists so the user has somewhere to put the script.
        if (enabled) {
            try {
                fs.mkdirSync(path.join(this.getMasterRoot(), CUSTOM_SCRIPT_DIR), { recursive: true });
            } catch {
                // best-effort
            }
        }
        this.renderSettings();
        const statusText = enabled ? '已启用' : '已关闭';
        vscode.window.showInformationMessage(
            `✅ 自动轮询${statusText}（间隔 ${interval}s，脚本 ${script}）。${enabled ? '开启后将「拉取并执行」：拉到新内容即派发给当前任务的 AI 执行器。' : ''}`
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
        // In monorepo mode, project-structure.md lives in the git-managed mono-main repo.
        const isMono = Boolean((this.config.monorepoGit || '').trim());
        this.projectStructureService.setMonorepoMode(isMono);
        this.projectStructureService.setMonorepoMainDir(
            isMono ? path.join(workspaceRoot, 'repos', 'mono-main') : undefined
        );
        this.projectStructureService.setMonorepoDirs(isMono ? this.config.monorepoDirs : undefined);
        this.projectStructureService.ensureBaseline();
    }

    /**
     * Ensure iteration docs/project-structure.md is copied from master workspace baseline
     * even when this window is opened on a worktree subview.
     */
    private copyProjectStructureToIteration(iterDir: string): void {
        const masterRoot = this.getMasterRoot();
        const masterService = new ProjectStructureService(masterRoot, extensionPath);
        const isMono = Boolean((this.config.monorepoGit || '').trim());
        masterService.setMonorepoMainDir(
            isMono ? path.join(masterRoot, 'repos', 'mono-main') : undefined
        );
        masterService.copyRootStructureToIteration(iterDir);

        // Fallback to current-window service in case master baseline is empty.
        const target = path.join(iterDir, 'docs', 'project-structure.md');
        if (!fs.existsSync(target)) {
            this.projectStructureService.copyRootStructureToIteration(iterDir);
        }

        // Preferred fallback: if both copies missed, seed MASTER baseline first so
        // future worktrees can reuse one shared docs/project-structure.md.
        if (!fs.existsSync(target)) {
            masterService.ensureBaseline();
            masterService.copyRootStructureToIteration(iterDir);
        }

        // Final fallback: still guarantee current iteration has usable context.
        if (!fs.existsSync(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `${masterService.getDefaultStructure()}\n`, 'utf8');
        }
    }

    private async handleInitProjectStructure(): Promise<void> {
        if (this.configMeta.readOnly) {
            vscode.window.showWarningMessage('当前窗口使用的是主窗口配置快照，不允许在此初始化项目结构');
            return;
        }
        if (!this.projectStructureService) {
            return;
        }

        // Align detection roots with monorepo config so it scans the configured
        // frontend/backend subdirectories (and the mono-main clone) rather than
        // only the hardcoded conventional candidates.
        const isMono = Boolean((this.config.monorepoGit || '').trim());
        this.projectStructureService.setMonorepoMode(isMono);
        this.projectStructureService.setMonorepoMainDir(
            isMono ? path.join(workspaceRoot, 'repos', 'mono-main') : undefined
        );
        this.projectStructureService.setMonorepoDirs(isMono ? this.config.monorepoDirs : undefined);

        const detected = this.projectStructureService.detectStructureFromWorkspace();
        const previewPath = this.projectStructureService.writePreviewStructure(detected.content);
        const structureDoc = await vscode.workspace.openTextDocument(previewPath);
        await vscode.window.showTextDocument(structureDoc, { preview: false, preserveFocus: false });

        const aiReviewMode = detected.detected && this.config.projectStructureRefineMode !== 'local';
        if (aiReviewMode) {
            const reviewPrompt = this.buildProjectStructureAiReviewPrompt(detected.content, detected.summary, previewPath);
            try {
                await this.aiDispatchService.dispatch(reviewPrompt, workspaceRoot, 'stage-agent');
                vscode.window.showInformationMessage('已触发 AI 二次审阅：请根据 AI 建议完善预览文档后再点击“应用预览结构”。');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`AI 二次审阅触发失败：${message}`);
            }
        }

        if (detected.detected) {
            // In AI review mode the preview is still being refined, so the immediate
            // apply option is omitted to avoid applying the un-reviewed tree.
            const promptMessage = aiReviewMode
                ? `已生成项目结构预览（${detected.summary}），并已触发 AI 二次审阅。请等待 AI 完善预览后，再点击“应用预览结构”。`
                : `已生成项目结构预览（${detected.summary}）。请先检查并可直接编辑该预览，完成后点击“应用预览结构到正式文档”。`;
            const actions = aiReviewMode ? ['改用默认结构'] : ['改用默认结构', '立即应用预览'];
            const action = await vscode.window.showInformationMessage(promptMessage, ...actions);
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

    private buildProjectStructureAiReviewPrompt(detectedContent: string, summary: string, previewPath: string): string {
        const previewRel = path.relative(workspaceRoot, previewPath).replace(/\\/g, '/') || previewPath;

        return [
            '# 任务：为项目结构目录树补充简要说明（轻量标注，勿扩写）',
            '',
            `请直接编辑预览文件：${previewRel}`,
            '',
            '严格要求：',
            `1. 只修改预览文件 ${previewRel}，不要改动任何其它文件（尤其不要写 docs/project-structure.md）。`,
            '2. 完整保留现有目录树的结构、层级与缩进，不得增删目录节点、不得调整顺序。',
            '3. 仅在每个目录/关键节点行尾用 “# 说明” 补充一句话职责描述（已有说明则保持或微调）。',
            '4. 每条说明不超过 20 个字，只描述该目录的职责，不写改动指引、不写落包规则、不写示例代码。',
            '5. 不要新增章节、表格、前言或总结，输出仍是一棵带注释的目录树。',
            '',
            `检测摘要：${summary}`,
            '',
            '--- 当前预览目录树（在此基础上补充说明）---',
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
