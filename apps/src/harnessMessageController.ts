import { HarnessMessage, ReviewStage } from './harnessMessages';
import * as vscode from 'vscode';
import { WorkspaceTodoStoreService, WorkspaceTodoItem } from './services/workspaceTodoStoreService';
import { appendStructureGateFailureLog, appendTodoLog } from './services/harnessLog';
import { GranularityRuleConflictError, SampleProfileUnavailableError, StructureGateFailedError } from './services/projectStructureService';
import { PromptContractIncompleteError } from './services/promptService';

interface HarnessMessageControllerDeps {
    isWorktreeSubview: () => boolean;
    setPage: (page: string) => void;
    reloadFeatures: () => void;
    render: () => void;
    generateCapabilityDelta: (featureId: string) => Promise<void>;
    runDomainBaselineAggregation: (featureId: string) => Promise<void>;
    reviewSuspectedDomains: (featureId: string) => Promise<void>;
    applyDomainAdjudication: (featureId: string) => Promise<void>;
    commitDomainBaseline: (featureId: string) => Promise<void>;
    previewDomainBaselineSummary: (featureId: string) => Promise<void>;
    openCustomPrompt: (step: 'req' | 'des' | 'tcs' | 'tsk' | 'dev') => Promise<void>;
    openReviewCustomPrompt?: (stage: ReviewStage) => Promise<void>;
    openStageReview?: (stage: ReviewStage) => Promise<void>;
    saveStagePrompt?: (stage: ReviewStage, promptBody: string) => Promise<void>;
    runStageReview?: (stage: ReviewStage, context: Extract<HarnessMessage, { type: 'runStageReview' }>['context']) => Promise<void>;
    getLatestReviewStatus?: (stage: ReviewStage) => Promise<void>;
    openCustomConstitution: () => Promise<void>;
    saveGit:(frontendGit: string, backendGit: string, baseBranch: string, dryRun: boolean, monorepoGit?: string, monorepoDirs?: { frontend?: string; backend?: string; docs?: string; scripts?: string }, mode?: 'mono' | 'multi') => Promise<void>;
    saveAdvancedConfig: (msg: Extract<HarnessMessage, { type: 'saveAdvancedConfig' }>) => void;
    initProjectStructure: () => Promise<void>;
    applyProjectStructurePreview: () => Promise<void>;
    openArtifactsIndex: () => Promise<void>;
    openMasterWorkspace: () => Promise<void>;
    testAiProvider: () => Promise<void>;
    createFeature: (name: string, desc: string, quickMode?: boolean) => Promise<void>;
    createFeatureFromTodo?: (name: string, desc: string) => Promise<{ id: string }>;
    logWebviewEvent: (featureId: string, event: string, detail?: string) => void;
    requestEditFeatureDesc: (featureId: string) => Promise<void>;
    updateFeatureDesc: (featureId: string, desc: string) => void;
    resetFeature: (featureId: string) => Promise<void>;
    pushAllCode: (featureId: string) => Promise<void>;
    runAgent: (featureId: string, step: Extract<HarnessMessage, { type: 'runAgent' }>['step']) => Promise<void>;
    specDeltaReview: (featureId: string) => Promise<void>;
    startAuto: (featureId: string) => Promise<void>;
    pauseAuto: (featureId: string) => void;
    nextFeature: (featureId: string) => Promise<void>;
    retryFeature: (featureId: string, subId: string) => Promise<void>;
    setSubFeatureStatus: (featureId: string, subId: string, status: 'todo' | 'doing' | 'done' | 'failed') => Promise<void>;
    setFeatureAutomation: (featureId: string, aa: boolean, ar: boolean) => void;
    setFeatureAiProvider: (featureId: string, ap: string) => void;
    openFolderLocation: (featureId: string, location: Extract<HarnessMessage, { type: 'openFolderLocation' }>['location']) => Promise<void>;
    openArtifact: (featureId: string, artifact: Extract<HarnessMessage, { type: 'openArtifact' }>['artifact']) => Promise<void>;
    nextStage: (featureId: string, step: Extract<HarnessMessage, { type: 'next' }>['step'], targetStage?: Extract<HarnessMessage, { type: 'next' }>['targetStage']) => Promise<void>;
    pass: (featureId: string) => Promise<void>;
    syncMainCode: (featureId: string) => Promise<void>;
    completeDevWithPush: (featureId: string) => Promise<void>;
    pushAndNextStage: (featureId: string) => Promise<void>;
    commitToBaseline: (featureId: string) => Promise<void>;
    saveCustomButtons: (buttons: { name: string; script?: string; args?: string; scriptSource?: string; command?: string; placement?: 'iteration' | 'main' }[]) => void;
    saveLifecycleHooks: (hooks: { script: string; scriptSource?: string; args?: string }[]) => void;
    runCustomButton: (featureId: string, buttonId: string) => Promise<void>;
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
    todoPromoteToFeature?: (msg: Extract<HarnessMessage, { type: 'todo.promoteToFeature' }>) => Promise<void>;
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
            case 'requestEditFeatureDesc':
            case 'updateFeatureDesc':
            case 'resetFeature':
            case 'runAgent':
            case 'specDeltaReview':
            case 'startAuto':
            case 'pauseAuto':
            case 'nextFeature':
            case 'retryFeature':
            case 'setSubFeatureStatus':
            case 'setFeatureAutomation':
            case 'setFeatureAiProvider':
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
            case 'openReviewCustomPrompt':
            case 'openStageReview':
            case 'saveStagePrompt':
            case 'runStageReview':
            case 'getLatestReviewStatus':
            case 'openCustomConstitution':
            case 'todo.create':
            case 'todo.update':
            case 'todo.delete':
            case 'todo.list':
            case 'todo.promoteToFeature':
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

    /** Map project-structure extraction errors into a user-friendly warning string. */
    private mapProjectStructureError(error: unknown): string {
        if (error instanceof StructureGateFailedError) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
                appendStructureGateFailureLog(workspaceRoot, {
                    gateId: error.gate.gateId,
                    violations: error.gate.violations.map(item => ({
                        ruleId: item.ruleId,
                        location: item.location,
                        suggestion: item.suggestion,
                        message: item.message,
                    })),
                });
            }
            const first = error.gate.violations[0];
            if (first) {
                return `${error.code}: gateId=${error.gate.gateId}; ruleId=${first.ruleId}; location=${first.location}; suggestion=${first.suggestion}`;
            }
            return `${error.code}: gateId=${error.gate.gateId}; violations=0`;
        }
        if (error instanceof PromptContractIncompleteError) {
            const missing = error.missingBlocks.join(', ') || '(none)';
            const details = error.details.join(', ') || '(none)';
            return `${error.code}: 提示词契约片段缺失（missingBlocks=${missing}; details=${details}）。已阻断 AI 请求。`;
        }
        if (error instanceof GranularityRuleConflictError) {
            return `${error.code}: 颗粒度规则冲突（profile=${error.profileId}）。请修正 maxDepth/mustExpandDomains/collapsePatterns 配置。`;
        }
        if (error instanceof SampleProfileUnavailableError) {
            const attempted = error.attemptedPaths.map(p => p.replace(/\\/g, '/')).join(' ; ');
            return `${error.code}: 样例配置不可用（id=${error.sampleProfileId}）。请检查样例文件路径：${attempted}`;
        }
        const message = error instanceof Error ? error.message : String(error || 'unknown');
        if (message.includes('GRANULARITY_RULE_CONFLICT')) {
            return `GRANULARITY_RULE_CONFLICT: ${message}`;
        }
        if (message.includes('SAMPLE_PROFILE_UNAVAILABLE')) {
            return `SAMPLE_PROFILE_UNAVAILABLE: ${message}`;
        }
        if (message.includes('PROMPT_CONTRACT_INCOMPLETE')) {
            return `PROMPT_CONTRACT_INCOMPLETE: ${message}`;
        }
        return `PROJECT_STRUCTURE_EXTRACTION_ERROR: ${message}`;
    }

    /**
     * Determine whether the incoming review request targets a supported key stage.
     */
    private isReviewStage(stage: string): stage is ReviewStage {
        return stage === 'requirements' || stage === 'design' || stage === 'testcase';
    }

    /**
     * Validate review-stage requests and map unsupported stages to a warning instead of throwing.
     */
    private ensureReviewStage(stage: string): stage is ReviewStage {
        if (this.isReviewStage(stage)) {
            return true;
        }
        vscode.window.showWarningMessage('REVIEW-VAL-001: 评审仅支持 requirements、design、testcase 三个阶段');
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
                this.deps.reloadFeatures();
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
            case 'applyDomainAdjudication':
                await this.deps.applyDomainAdjudication(msg.id);
                return;
            case 'commitDomainBaseline':
                await this.deps.commitDomainBaseline(msg.id);
                return;
            case 'previewDomainBaselineSummary':
                await this.deps.previewDomainBaselineSummary(msg.id);
                return;
            case 'openCustomPrompt':
                await this.deps.openCustomPrompt(msg.step);
                return;
            case 'openReviewCustomPrompt':
                if (!this.ensureReviewStage(msg.stage)) {
                    return;
                }
                await this.deps.openReviewCustomPrompt?.(msg.stage);
                return;
            case 'openStageReview':
                if (!this.ensureReviewStage(msg.stage)) {
                    return;
                }
                await this.deps.openStageReview?.(msg.stage);
                return;
            case 'saveStagePrompt':
                if (!this.ensureReviewStage(msg.stage)) {
                    return;
                }
                await this.deps.saveStagePrompt?.(msg.stage, msg.promptBody);
                return;
            case 'runStageReview':
                if (!this.ensureReviewStage(msg.stage)) {
                    return;
                }
                await this.deps.runStageReview?.(msg.stage, msg.context);
                return;
            case 'getLatestReviewStatus':
                if (!this.ensureReviewStage(msg.stage)) {
                    return;
                }
                await this.deps.getLatestReviewStatus?.(msg.stage);
                return;
            case 'openCustomConstitution':
                await this.deps.openCustomConstitution();
                return;
            case 'saveGit':
                await this.deps.saveGit(msg.fg, msg.bg, msg.bb, msg.dr, msg.mg, msg.md, msg.mode);
                return;
            case 'saveAdvancedConfig':
                this.deps.saveAdvancedConfig(msg);
                return;
            case 'initProjectStructure':
                try {
                    await this.deps.initProjectStructure();
                } catch (error) {
                    const mapped = this.mapProjectStructureError(error);
                    vscode.window.showWarningMessage(mapped);
                }
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
                await this.deps.createFeature(msg.name, msg.desc, msg.quickMode);
                return;
            case 'logWebviewEvent':
                this.deps.logWebviewEvent(msg.id, msg.event, msg.detail);
                return;
            case 'requestEditFeatureDesc':
                await this.deps.requestEditFeatureDesc(msg.id);
                return;
            case 'updateFeatureDesc':
                this.deps.updateFeatureDesc(msg.id, msg.desc);
                return;
            case 'resetFeature':
                await this.deps.resetFeature(msg.id);
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
            case 'nextFeature':
                await this.deps.nextFeature(msg.id);
                return;
            case 'retryFeature':
                await this.deps.retryFeature(msg.id, msg.subId);
                return;
            case 'setSubFeatureStatus':
                await this.deps.setSubFeatureStatus(msg.id, msg.subId, msg.status);
                return;
            case 'setFeatureAutomation':
                this.deps.setFeatureAutomation(msg.id, msg.aa, msg.ar);
                return;
            case 'setFeatureAiProvider':
                this.deps.setFeatureAiProvider(msg.id, msg.ap);
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
            case 'todo.promoteToFeature':
                if (this.deps.todoPromoteToFeature) {
                    await this.deps.todoPromoteToFeature(msg);
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

                    const createdFeature = this.deps.createFeatureFromTodo
                        ? await this.deps.createFeatureFromTodo(todo.title, todo.description ?? '')
                        : undefined;

                    if (!createdFeature?.id) {
                        await this.deps.createFeature(todo.title, todo.description ?? '', false);
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
