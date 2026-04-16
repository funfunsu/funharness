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
exports.AiDispatchService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const models_1 = require("../models");
class AiDispatchService {
    constructor(getConfig) {
        this.getConfig = getConfig;
    }
    async dispatch(query, iterDir, source) {
        const cfg = this.getConfig();
        const provider = cfg.aiProvider || 'copilot-chat';
        if (provider === 'copilot-chat') {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query,
                isPartial: false,
            });
            return;
        }
        if (provider === 'manual') {
            await this.dispatchManual(query, source);
            return;
        }
        try {
            await this.dispatchClaudeCli(query, iterDir, cfg, source);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (cfg.aiFallbackToManual !== false) {
                vscode.window.showWarningMessage(`Claude CLI 派发失败，已自动降级到手工模式：${message}`);
                await this.dispatchManual(query, source);
                return;
            }
            throw error;
        }
    }
    async testConnection() {
        const cfg = this.getConfig();
        const provider = cfg.aiProvider || 'copilot-chat';
        if (provider === 'manual') {
            vscode.window.showInformationMessage('手工模式无需连通性检测：提示词将复制到剪贴板并打开文档。');
            return;
        }
        if (provider === 'copilot-chat') {
            const commands = await vscode.commands.getCommands(true);
            if (commands.includes('workbench.action.chat.open')) {
                vscode.window.showInformationMessage('Copilot Chat 可用：已检测到 workbench.action.chat.open。');
            }
            else {
                vscode.window.showWarningMessage('未检测到 Copilot Chat 命令 workbench.action.chat.open，请确认 Copilot Chat 已安装并启用。');
            }
            return;
        }
        try {
            const output = (0, child_process_1.execSync)('claude --version', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            const version = output.split(/\r?\n/)[0] || output;
            const samplePromptFile = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.', models_1.BASE, 'dispatch-prompts', 'sample.md');
            const commandPreview = this.buildClaudeCliCommand(cfg.claudeCliCommandTemplate || '', samplePromptFile);
            const hasCustomTemplate = Boolean((cfg.claudeCliCommandTemplate || '').trim());
            const hasPromptPlaceholder = (cfg.claudeCliCommandTemplate || '').includes('{promptFile}');
            vscode.window.showInformationMessage(`Claude CLI 可用：${version}`);
            vscode.window.showInformationMessage(`命令模板预览：${commandPreview}`);
            if (hasCustomTemplate && !hasPromptPlaceholder) {
                vscode.window.showWarningMessage('当前 Claude CLI 命令模板未包含 {promptFile} 占位符，派发时将无法自动注入提示词文件路径。');
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`Claude CLI 检测失败：${message}`);
        }
    }
    async dispatchManual(query, source) {
        await vscode.env.clipboard.writeText(query);
        const title = source === 'stage-agent' ? '阶段 Agent 手工提示词' : '开发子任务手工提示词';
        const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: [
                `# ${title}`,
                '',
                '已自动复制到剪贴板。你可以粘贴到任意 AI 工具执行。',
                '',
                '```text',
                query,
                '```',
            ].join('\n'),
        });
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    }
    async dispatchClaudeCli(query, iterDir, cfg, source) {
        const promptFile = this.writePromptFile(query, iterDir, source);
        const command = this.buildClaudeCliCommand(cfg.claudeCliCommandTemplate || '', promptFile);
        const terminal = vscode.window.createTerminal({
            name: 'Fun Harness Claude CLI',
            cwd: iterDir,
        });
        terminal.show(true);
        terminal.sendText(command, true);
        vscode.window.showInformationMessage(`已通过 Claude CLI 派发任务（source=${source}）`);
    }
    writePromptFile(query, iterDir, source) {
        const folder = path.join(iterDir, models_1.BASE, 'dispatch-prompts');
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `${source}-${Date.now()}.md`);
        fs.writeFileSync(file, query, 'utf8');
        return file;
    }
    buildClaudeCliCommand(template, promptFile) {
        const normalizedFile = promptFile.replace(/\\/g, '/');
        const defaultTemplate = process.platform === 'win32'
            ? 'Get-Content -Raw "{promptFile}" | claude'
            : 'cat "{promptFile}" | claude';
        const effectiveTemplate = (template || defaultTemplate).trim();
        return effectiveTemplate.replace(/\{promptFile\}/g, normalizedFile);
    }
}
exports.AiDispatchService = AiDispatchService;
//# sourceMappingURL=aiDispatchService.js.map