import { HarnessMessage } from './harnessMessages';
import * as vscode from 'vscode';
import { WorkspaceTodoStoreService, WorkspaceTodoItem } from './services/workspaceTodoStoreService';
import { appendTodoLog } from './services/harnessLog';

interface HarnessMessageControllerDeps {
    isWorktreeSubview: () => boolean;
    setPage: (page: string) => void;
    reloadTasks: () => void;
    render: () => void;
    generateCapabilityDelta: (taskId: string) => Promise<void>;
    runDomainBaselineAggregation: (taskId: string) => Promise<void>;
    reviewSuspectedDomains: (taskId: string) => Promise<void>;
    previewDomainBaselineSummary: (taskId: string) => Promise<void>;
    openCustomPrompt: (step: 'req' | 'des' | 'tcs' | 'tsk' | 'dev') => Promise<void>;
    saveGit:(frontendGit: string, backendGit: string, baseBranch: string, dryRun: boolean, monorepoGit?: string, monorepoDirs?: { frontend?: string; backend?: string; docs?: string; scripts?: string }, mode?: 'mono' | 'multi') => Promise<void>;
    saveAdvancedConfig: (msg: Extract<HarnessMessage, { type: 'saveAdvancedConfig' }>) => void;
    initProjectStructure: () => Promise<void>;
    applyProjectStructurePreview: () => Promise<void>;
    openArtifactsIndex: () => Promise<void>;
    openMasterWorkspace: () => Promise<void>;
    testAiProvider: () => Promise<void>;
    createTask: (name: string, desc: string, quickMode?: boolean) => Promise<void>;
    createTaskFromTodo?: (name: string, desc: string) => Promise<{ id: string }>;
    logWebviewEvent: (taskId: string, event: string, detail?: string) => void;
    requestEditTaskDesc: (taskId: string) => Promise<void>;
    updateTaskDesc: (taskId: string, desc: string) => void;
    resetTask: (taskId: string) => Promise<void>;
    pushAllCode: (taskId: string) => Promise<void>;
    runAgent: (taskId: string, step: Extract<HarnessMessage, { type: 'runAgent' }>['step']) => Promise<void>;
    specDeltaReview: (taskId: string) => Promise<void>;
    startAuto: (taskId: string) => Promise<void>;
    pauseAuto: (taskId: string) => void;
    nextTask: (taskId: string) => Promise<void>;
    retryTask: (taskId: string, subId: string) => Promise<void>;
    setSubTaskStatus: (taskId: string, subId: string, status: 'todo' | 'doing' | 'done' | 'failed') => Promise<void>;
    setTaskAutomation: (taskId: string, aa: boolean, ar: boolean) => void;
    setTaskAiProvider: (taskId: string, ap: string) => void;
    openFolderLocation: (taskId: string, location: Extract<HarnessMessage, { type: 'openFolderLocation' }>['location']) => Promise<void>;
    openArtifact: (taskId: string, artifact: Extract<HarnessMessage, { type: 'openArtifact' }>['artifact']) => Promise<void>;
    nextStage: (taskId: string, step: Extract<HarnessMessage, { type: 'next' }>['step'], targetStage?: Extract<HarnessMessage, { type: 'next' }>['targetStage']) => Promise<void>;
    pass: (taskId: string) => Promise<void>;
    syncMainCode: (taskId: string) => Promise<void>;
    completeDevWithPush: (taskId: string) => Promise<void>;
    pushAndNextStage: (taskId: string) => Promise<void>;
    commitToBaseline: (taskId: string) => Promise<void>;
    saveCustomButtons: (buttons: { name: string; script?: string; args?: string; scriptSource?: string; command?: string; placement?: 'iteration' | 'main' }[]) => void;
    saveLifecycleHooks: (hooks: { script: string; scriptSource?: string; args?: string }[]) => void;
    runCustomButton: (taskId: string, buttonId: string) => Promise<void>;
    runMainCustomButton: (buttonId: string) => Promise<void>;
    openScriptDir: () => Promise<void>;
    openHarnessLog: () => void;
    saveAutoPollConfig: (msg: Extract<HarnessMessage, { type: 'saveAutoPollConfig' }>) => void;
    createPollScriptTemplate: () => Promise<void>;
    toggleAutoPoll: (enable: boolean) => void;
    // Todo message handlers are optional to keep backward compatibility during staged rollout.
    todoCreate?: (msg: Extract<HarnessMessage, { type: 'todo.create' }>) => Promise<void>;
    todoUpdate?: (msg: Extract<HarnessMessage, { type: 'todo.update' }>) => Promise<void>;
    todoDelete?: (msg: Extract<HarnessMessage, { type: 'todo.delete' }>) => Promise<void>;
    todoList?: (msg: Extract<HarnessMessage, { type: 'todo.list' }>) => Promise<void>;
    todoPromoteToTask?: (msg: Extract<HarnessMessage, { type: 'todo.promoteToTask' }>) => Promise<void>;
    todoChanged?: (msg: Extract<HarnessMessage, { type: 'todo.changed' }>) => void;
    todoError?: (msg: Extract<HarnessMessage, { type: 'todo.error' }>) => void;
}

export class HarnessMessageController {
    private todoStore?: WorkspaceTodoStoreService;
    private todoFileWatcher?: vscode.FileSystemWatcher;

    constructor(private readonly deps: HarnessMessageControllerDeps) {}

    /**
     * Watch workspace todo persistence file so sibling panels can refresh after external writes.
     */
    private ensureTodoFileWatcher(workspaceRoot: string): void {
        if (this.todoFileWatcher) {
            return;
        }
        const pattern = new vscode.RelativePattern(workspaceRoot, '.harness/workspace-todos.json');
        this.todoFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        const onChanged = () => {
            try {
                const todoStore = this.getTodoStore();
                todoStore.load();
                this.emitTodoChanged('reloaded', todoStore.list());
            } catch {
                // Ignore external transient write errors; manual refresh can recover.
            }
        };
        this.todoFileWatcher.onDidCreate(onChanged);
        this.todoFileWatcher.onDidChange(onChanged);
        this.todoFileWatcher.onDidDelete(() => {
            try {
                const todoStore = this.getTodoStore();
                todoStore.load();
                this.emitTodoChanged('reloaded', todoStore.list());
            } catch {
                // Ignore external transient delete errors; manual refresh can recover.
            }
        });
    }

    /**
     * Lazily initialize workspace Todo store for fallback message handling.
     */
    private getTodoStore(): WorkspaceTodoStoreService {
        if (this.todoStore) {
            return this.todoStore;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('TODO-IO-001: 未检测到工作区目录');
        }
        this.ensureTodoFileWatcher(workspaceRoot);
        this.todoStore = new WorkspaceTodoStoreService(workspaceRoot);
        this.todoStore.load();
        return this.todoStore;
    }

    /**
     * Emit todo.changed payload and trigger a re-render so webview can refresh.
     */
    private emitTodoChanged(reason: Extract<HarnessMessage, { type: 'todo.changed' }>['reason'], todos: WorkspaceTodoItem[]): void {
        const payload: Extract<HarnessMessage, { type: 'todo.changed' }> = {
            type: 'todo.changed',
            reason,
            todos: todos.map(todo => ({
                id: todo.id,
                title: todo.title,
                description: todo.description,
                status: todo.status,
                createdAt: todo.createdAt,
                updatedAt: todo.updatedAt,
                sourcePanel: todo.sourcePanel,
            })),
        };
        let posted = false;
        try {
            this.deps.todoChanged?.(payload);
            posted = true;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error || 'unknown');
            this.logTodo('TODO-SYNC-001', '面板同步广播失败', detail);
            vscode.window.showWarningMessage('TODO-SYNC-001: 面板同步广播失败');
        }
        // Only do a full render when postMessage failed; a full render replaces
        // the entire webview HTML which resets client-side todo state to [].
        if (!posted) {
            this.deps.render();
        }
    }

    private emitTodoError(code: string, message: string, detail?: string): void {
        try {
            this.deps.todoError?.({ type: 'todo.error', code, message, detail });
        } catch (error) {
            const fallbackDetail = error instanceof Error ? error.message : String(error || 'unknown');
            this.logTodo('TODO-SYNC-001', '待办错误提示广播失败', fallbackDetail);
        }
    }

    /**
     * Map low-level errors to TODO-VAL / TODO-IO categories expected by design contracts.
     */
    private mapTodoError(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error || '未知错误');
        if (message.includes('TODO-VAL-001')) {
            return 'TODO-VAL-001: 标题不能为空';
        }
        if (message.includes('TODO-VAL-002')) {
            return 'TODO-VAL-002: 待办不存在';
        }
        if (message.includes('TODO-IO-001')) {
            return 'TODO-IO-001: 待办存储文件读取失败';
        }
        if (message.includes('TODO-IO-002')) {
            return 'TODO-IO-002: 待办存储文件写入失败';
        }
        if (message.includes('TODO-SYNC-001')) {
            return 'TODO-SYNC-001: 面板同步广播失败';
        }
        if (message.includes('TODO-PROMOTE-001')) {
            return 'TODO-PROMOTE-001: 待办转任务失败';
        }
        if (message.includes('TODO-POLICY-001')) {
            return 'TODO-POLICY-001: 不支持的转化策略（keep|mark-promoted）';
        }
        return `TODO-IO-002: ${message}`;
    }

    /**
     * Append a best-effort Todo error log under workspace-level harness logs.
     */
    private logTodo(code: string, message: string, detail?: string): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return;
        }
        appendTodoLog(workspaceRoot, code, message, detail);
    }

    private ensureWorktreeAllowed(msg: HarnessMessage): boolean {
        if (!this.deps.isWorktreeSubview()) {
            return true;
        }

        switch (msg.type) {
            case 'refresh':
            case 'generateCapabilityDelta':
            case 'logWebviewEvent':
            case 'requestEditTaskDesc':
            case 'updateTaskDesc':
            case 'resetTask':
            case 'runAgent':
            case 'specDeltaReview':
            case 'startAuto':
            case 'pauseAuto':
            case 'nextTask':
            case 'retryTask':
            case 'setSubTaskStatus':
            case 'setTaskAutomation':
            case 'setTaskAiProvider':
            case 'openArtifact':
            case 'openFolderLocation':
            case 'next':
            case 'pass':
            case 'syncMainCode':
            case 'pushAll':
            case 'completeDevWithPush':
            case 'pushAndNextStage':
            case 'commitToBaseline':
            case 'runCustomButton':
            case 'openMasterWorkspace':
            case 'toggleAutoPoll':
            case 'openCustomPrompt':
            case 'todo.create':
            case 'todo.update':
            case 'todo.delete':
            case 'todo.list':
            case 'todo.promoteToTask':
                return true;
            case 'page':
                if (msg.page === 'main') {
                    return true;
                }
                break;
        }

        vscode.window.showWarningMessage('子 worktree 面板仅支持当前迭代任务操作，已拦截该请求');
        return false;
    }

    async handle(msg: HarnessMessage): Promise<void> {
        if (!this.ensureWorktreeAllowed(msg)) {
            return;
        }

        switch (msg.type) {
            case 'page':
                this.deps.setPage(msg.page);
                this.deps.render();
                return;
            case 'refresh':
                this.deps.reloadTasks();
                this.deps.render();
                return;
            case 'generateCapabilityDelta':
                await this.deps.generateCapabilityDelta(msg.id);
                return;
            case 'runDomainBaselineAggregation':
                await this.deps.runDomainBaselineAggregation(msg.id);
                return;
            case 'reviewSuspectedDomains':
                await this.deps.reviewSuspectedDomains(msg.id);
                return;
            case 'previewDomainBaselineSummary':
                await this.deps.previewDomainBaselineSummary(msg.id);
                return;
            case 'openCustomPrompt':
                await this.deps.openCustomPrompt(msg.step);
                return;
            case 'saveGit':
                await this.deps.saveGit(msg.fg, msg.bg, msg.bb, msg.dr, msg.mg, msg.md, msg.mode);
                return;
            case 'saveAdvancedConfig':
                this.deps.saveAdvancedConfig(msg);
                return;
            case 'initProjectStructure':
                await this.deps.initProjectStructure();
                return;
            case 'applyProjectStructurePreview':
                await this.deps.applyProjectStructurePreview();
                return;
            case 'openArtifactsIndex':
                await this.deps.openArtifactsIndex();
                return;
            case 'openMasterWorkspace':
                await this.deps.openMasterWorkspace();
                return;
            case 'testAiProvider':
                await this.deps.testAiProvider();
                return;
            case 'create':
                await this.deps.createTask(msg.name, msg.desc, msg.quickMode);
                return;
            case 'logWebviewEvent':
                this.deps.logWebviewEvent(msg.id, msg.event, msg.detail);
                return;
            case 'requestEditTaskDesc':
                await this.deps.requestEditTaskDesc(msg.id);
                return;
            case 'updateTaskDesc':
                this.deps.updateTaskDesc(msg.id, msg.desc);
                return;
            case 'resetTask':
                await this.deps.resetTask(msg.id);
                return;
            case 'pushAll':
                await this.deps.pushAllCode(msg.id);
                return;
            case 'runAgent':
                await this.deps.runAgent(msg.id, msg.step);
                return;
            case 'specDeltaReview':
                await this.deps.specDeltaReview(msg.id);
                return;
            case 'startAuto':
                await this.deps.startAuto(msg.id);
                return;
            case 'pauseAuto':
                this.deps.pauseAuto(msg.id);
                return;
            case 'nextTask':
                await this.deps.nextTask(msg.id);
                return;
            case 'retryTask':
                await this.deps.retryTask(msg.id, msg.subId);
                return;
            case 'setSubTaskStatus':
                await this.deps.setSubTaskStatus(msg.id, msg.subId, msg.status);
                return;
            case 'setTaskAutomation':
                this.deps.setTaskAutomation(msg.id, msg.aa, msg.ar);
                return;
            case 'setTaskAiProvider':
                this.deps.setTaskAiProvider(msg.id, msg.ap);
                return;
            case 'openFolderLocation':
                await this.deps.openFolderLocation(msg.id, msg.location);
                return;
            case 'openArtifact':
                await this.deps.openArtifact(msg.id, msg.artifact);
                return;
            case 'next':
                await this.deps.nextStage(msg.id, msg.step, msg.targetStage);
                return;
            case 'pass':
                await this.deps.pass(msg.id);
                return;
            case 'syncMainCode':
                await this.deps.syncMainCode(msg.id);
                return;
            case 'completeDevWithPush':
                await this.deps.completeDevWithPush(msg.id);
                return;
            case 'pushAndNextStage':
                await this.deps.pushAndNextStage(msg.id);
                return;
            case 'commitToBaseline':
                await this.deps.commitToBaseline(msg.id);
                return;
            case 'saveCustomButtons':
                this.deps.saveCustomButtons(msg.buttons);
                return;
            case 'saveLifecycleHooks':
                this.deps.saveLifecycleHooks(msg.hooks);
                return;
            case 'runCustomButton':
                await this.deps.runCustomButton(msg.id, msg.buttonId);
                return;
            case 'runMainCustomButton':
                await this.deps.runMainCustomButton(msg.buttonId);
                return;
            case 'openScriptDir':
                await this.deps.openScriptDir();
                return;
            case 'openHarnessLog':
                this.deps.openHarnessLog();
                return;
            case 'saveAutoPollConfig':
                this.deps.saveAutoPollConfig(msg);
                return;
            case 'createPollScriptTemplate':
                await this.deps.createPollScriptTemplate();
                return;
            case 'toggleAutoPoll':
                this.deps.toggleAutoPoll(msg.enable);
                return;
            case 'todo.create':
                if (this.deps.todoCreate) {
                    await this.deps.todoCreate(msg);
                    return;
                }
                try {
                    const todoStore = this.getTodoStore();
                    todoStore.create({
                        title: msg.title,
                        description: msg.description,
                        sourcePanel: msg.sourcePanel,
                    });
                    this.emitTodoChanged('created', todoStore.list());
                } catch (error) {
                    const mapped = this.mapTodoError(error);
                    this.logTodo(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                    vscode.window.showWarningMessage(mapped);
                    this.emitTodoError(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                }
                return;
            case 'todo.update':
                if (this.deps.todoUpdate) {
                    await this.deps.todoUpdate(msg);
                    return;
                }
                try {
                    const todoStore = this.getTodoStore();
                    todoStore.update({
                        id: msg.id,
                        title: msg.title,
                        description: msg.description,
                        status: msg.status,
                    });
                    this.emitTodoChanged('updated', todoStore.list());
                } catch (error) {
                    const mapped = this.mapTodoError(error);
                    this.logTodo(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                    vscode.window.showWarningMessage(mapped);
                    this.emitTodoError(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                }
                return;
            case 'todo.delete':
                if (this.deps.todoDelete) {
                    await this.deps.todoDelete(msg);
                    return;
                }
                try {
                    const todoStore = this.getTodoStore();
                    todoStore.remove(msg.id);
                    this.emitTodoChanged('deleted', todoStore.list());
                } catch (error) {
                    const mapped = this.mapTodoError(error);
                    this.logTodo(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                    vscode.window.showWarningMessage(mapped);
                    this.emitTodoError(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                }
                return;
            case 'todo.list':
                if (this.deps.todoList) {
                    await this.deps.todoList(msg);
                    return;
                }
                try {
                    const todoStore = this.getTodoStore();
                    this.emitTodoChanged('reloaded', todoStore.list());
                } catch (error) {
                    const mapped = this.mapTodoError(error);
                    this.logTodo(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                    vscode.window.showWarningMessage(mapped);
                    this.emitTodoError(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                }
                return;
            case 'todo.promoteToTask':
                if (this.deps.todoPromoteToTask) {
                    await this.deps.todoPromoteToTask(msg);
                    return;
                }
                try {
                    const todoStore = this.getTodoStore();
                    const todo = todoStore.list().find(item => item.id === msg.todoId);
                    if (!todo) {
                        const mapped = 'TODO-VAL-002: 待办不存在';
                        this.logTodo('TODO-VAL-002', mapped);
                        vscode.window.showWarningMessage(mapped);
                        return;
                    }

                    const createdTask = this.deps.createTaskFromTodo
                        ? await this.deps.createTaskFromTodo(todo.title, todo.description ?? '')
                        : undefined;

                    if (!createdTask?.id) {
                        await this.deps.createTask(todo.title, todo.description ?? '', false);
                    }

                    // Always remove the promoted todo from the list.
                    todoStore.remove(msg.todoId);
                    this.emitTodoChanged('promoted', todoStore.list());
                } catch (error) {
                    const mapped = this.mapTodoError(error);
                    this.logTodo(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                    vscode.window.showWarningMessage(mapped);
                    this.emitTodoError(mapped.split(':')[0], mapped, error instanceof Error ? error.message : String(error));
                }
                return;
            case 'todo.changed':
                // todo.changed is an extension-to-webview event and should not be sent from webview.
                return;
        }
    }
}
