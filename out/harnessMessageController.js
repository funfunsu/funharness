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
exports.HarnessMessageController = void 0;
const vscode = __importStar(require("vscode"));
class HarnessMessageController {
    constructor(deps) {
        this.deps = deps;
    }
    ensureWorktreeAllowed(msg) {
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
            case 'openArtifact':
            case 'openFolderLocation':
            case 'next':
            case 'pass':
            case 'syncMainCode':
            case 'startService':
            case 'pushAll':
            case 'completeDevWithPush':
            case 'pushAndNextStage':
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
    async handle(msg) {
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
                this.deps.saveGit(msg.fg, msg.bg, msg.mb, msg.sb, msg.dr);
                return;
            case 'saveDevConfig':
                this.deps.saveDevConfig(msg);
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
        }
    }
}
exports.HarnessMessageController = HarnessMessageController;
//# sourceMappingURL=harnessMessageController.js.map