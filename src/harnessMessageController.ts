import { HarnessMessage } from './harnessMessages';
import * as vscode from 'vscode';

interface HarnessMessageControllerDeps {
    isWorktreeSubview: () => boolean;
    setPage: (page: string) => void;
    reloadTasks: () => void;
    render: () => void;
    setSelectedPromptKey: (key: string) => void;
    restoreSelectedAgentPrompt: () => void;
    saveGit: (frontendGit: string, backendGit: string, baseBranch: string, dryRun: boolean) => Promise<void>;
    saveDevConfig: (msg: Extract<HarnessMessage, { type: 'saveDevConfig' }>) => void;
    saveRuntimeConfig: (msg: Extract<HarnessMessage, { type: 'saveRuntimeConfig' }>) => void;
    saveAdvancedConfig: (msg: Extract<HarnessMessage, { type: 'saveAdvancedConfig' }>) => void;
    initProjectStructure: () => Promise<void>;
    applyProjectStructurePreview: () => Promise<void>;
    openArtifactsIndex: () => Promise<void>;
    openMasterWorkspace: () => Promise<void>;
    autoDetectDevEnv: () => Promise<void>;
    testAiProvider: () => Promise<void>;
    createTask: (name: string, desc: string) => Promise<void>;
    requestEditTaskDesc: (taskId: string) => Promise<void>;
    updateTaskDesc: (taskId: string, desc: string) => void;
    resetTask: (taskId: string) => Promise<void>;
    pushAllCode: (taskId: string) => Promise<void>;
    runAgent: (taskId: string, step: Extract<HarnessMessage, { type: 'runAgent' }>['step']) => Promise<void>;
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
    startService: (taskId: string, target: 'frontend' | 'backend') => Promise<void>;
    completeDevWithPush: (taskId: string) => Promise<void>;
    pushAndNextStage: (taskId: string) => Promise<void>;
    commitToBaseline: (taskId: string) => Promise<void>;
}

export class HarnessMessageController {
    constructor(private readonly deps: HarnessMessageControllerDeps) {}

    private ensureWorktreeAllowed(msg: HarnessMessage): boolean {
        if (!this.deps.isWorktreeSubview()) {
            return true;
        }

        switch (msg.type) {
            case 'refresh':
            case 'runAgent':
            case 'startAuto':
            case 'pauseAuto':
            case 'nextTask':
            case 'retryTask':
            case 'setSubTaskStatus':
            case 'setTaskAiProvider':
            case 'openArtifact':
            case 'openFolderLocation':
            case 'next':
            case 'pass':
            case 'syncMainCode':
            case 'startService':
            case 'pushAll':
            case 'completeDevWithPush':
            case 'pushAndNextStage':
            case 'commitToBaseline':
            case 'openMasterWorkspace':
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
            case 'sel':
                this.deps.setSelectedPromptKey(msg.key);
                return;
            case 'initAgent':
                this.deps.restoreSelectedAgentPrompt();
                return;
            case 'saveGit':
                await this.deps.saveGit(msg.fg, msg.bg, msg.bb, msg.dr);
                return;
            case 'saveDevConfig':
                this.deps.saveDevConfig(msg);
                return;
            case 'saveRuntimeConfig':
                this.deps.saveRuntimeConfig(msg);
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
            case 'autoDetectDevEnv':
                await this.deps.autoDetectDevEnv();
                return;
            case 'testAiProvider':
                await this.deps.testAiProvider();
                return;
            case 'create':
                await this.deps.createTask(msg.name, msg.desc);
                return;
            case 'requestEditTaskDesc':
                await this.deps.requestEditTaskDesc(msg.id);
                return;
            case 'updateTaskDesc':
                this.deps.updateTaskDesc(msg.id, msg.desc);
                return;
            case 'resetTask':
                vscode.window.showInformationMessage('已收到重置任务请求，正在执行...');
                await this.deps.resetTask(msg.id);
                return;
            case 'pushAll':
                await this.deps.pushAllCode(msg.id);
                return;
            case 'runAgent':
                await this.deps.runAgent(msg.id, msg.step);
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
            case 'startService':
                await this.deps.startService(msg.id, msg.target);
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
        }
    }
}
