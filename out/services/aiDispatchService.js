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
    async dispatch(query, iterDir, source, providerOverride) {
        const cfg = this.getConfig();
        const provider = (0, models_1.getAiProvider)(providerOverride || cfg.aiProvider || 'copilot-chat');
        if (provider.kind === 'manual') {
            await this.dispatchManual(query, source);
            return;
        }
        if (provider.kind === 'vscode-chat') {
            await this.dispatchVscodeChat(query, provider);
            return;
        }
        if (provider.kind === 'panel') {
            await this.dispatchPanel(query, provider, source);
            return;
        }
        // provider.kind === 'cli'
        try {
            await this.dispatchCli(query, iterDir, cfg, provider, source);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (cfg.aiFallbackToManual !== false) {
                vscode.window.showWarningMessage(`${provider.label} 派发失败，已自动降级到手工模式：${message}`);
                await this.dispatchManual(query, source);
                return;
            }
            throw error;
        }
    }
    async testConnection() {
        const cfg = this.getConfig();
        const provider = (0, models_1.getAiProvider)(cfg.aiProvider || 'copilot-chat');
        if (provider.kind === 'manual') {
            vscode.window.showInformationMessage('手工模式无需连通性检测：提示词将复制到剪贴板并打开文档。');
            return;
        }
        if (provider.kind === 'vscode-chat') {
            await this.testVscodeChat(provider);
            return;
        }
        if (provider.kind === 'panel') {
            await this.testPanel(provider);
            return;
        }
        // provider.kind === 'cli'
        await this.testCli(cfg, provider);
    }
    // ── VS Code Chat dispatch ──────────────────────────────────────
    async dispatchVscodeChat(query, provider) {
        const command = provider.chatCommand || 'workbench.action.chat.open';
        await vscode.commands.executeCommand(command, {
            query,
            isPartial: false,
        });
    }
    async testVscodeChat(provider) {
        const command = provider.chatCommand || 'workbench.action.chat.open';
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes(command)) {
            vscode.window.showInformationMessage(`${provider.label} 可用：已检测到命令 ${command}。`);
        }
        else {
            vscode.window.showWarningMessage(`未检测到 ${provider.label} 命令 ${command}，请确认对应扩展已安装并启用。`);
        }
    }
    // ── CLI dispatch ───────────────────────────────────────────────
    async dispatchCli(query, iterDir, cfg, provider, source) {
        const promptFile = this.writePromptFile(query, iterDir, source);
        const template = this.resolveCliTemplate(cfg, provider);
        const command = this.buildCliCommand(template, promptFile);
        const terminal = vscode.window.createTerminal({
            name: `Fun Harness ${provider.label}`,
            cwd: iterDir,
        });
        terminal.show(true);
        terminal.sendText(command, true);
        vscode.window.showInformationMessage(`已通过 ${provider.label} 派发任务（source=${source}）`);
    }
    async testCli(cfg, provider) {
        const detectCmd = provider.detectHint || 'echo ok';
        try {
            const output = (0, child_process_1.execSync)(detectCmd, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            const version = output.split(/\r?\n/)[0] || output;
            const samplePromptFile = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.', models_1.BASE, 'dispatch-prompts', 'sample.md');
            const template = this.resolveCliTemplate(cfg, provider);
            const commandPreview = this.buildCliCommand(template, samplePromptFile);
            const hasCustomTemplate = Boolean(this.getEffectiveCliTemplate(cfg).trim());
            const hasPromptPlaceholder = template.includes('{promptFile}');
            vscode.window.showInformationMessage(`${provider.label} 可用：${version}`);
            vscode.window.showInformationMessage(`命令模板预览：${commandPreview}`);
            if (hasCustomTemplate && !hasPromptPlaceholder) {
                vscode.window.showWarningMessage(`当前 CLI 命令模板未包含 {promptFile} 占位符，派发时将无法自动注入提示词文件路径。`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`${provider.label} 检测失败：${message}`);
        }
    }
    // ── Panel dispatch (open provider's own panel + clipboard) ───
    async dispatchPanel(query, provider, source) {
        await vscode.env.clipboard.writeText(query);
        const command = provider.panelCommand;
        if (command) {
            try {
                await vscode.commands.executeCommand(command);
            }
            catch {
                // Panel command failed — still copied to clipboard, user can open manually.
            }
        }
        vscode.window.showInformationMessage(`已复制提示词到剪贴板并打开 ${provider.label}，请粘贴执行（source=${source}）`);
    }
    async testPanel(provider) {
        const command = provider.panelCommand;
        if (!command) {
            vscode.window.showWarningMessage(`${provider.label} 未配置面板命令。`);
            return;
        }
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes(command)) {
            vscode.window.showInformationMessage(`${provider.label} 可用：已检测到命令 ${command}。`);
        }
        else {
            vscode.window.showWarningMessage(`未检测到 ${provider.label} 命令 ${command}，请确认对应扩展已安装并启用。`);
        }
    }
    // ── Manual dispatch ────────────────────────────────────────────
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
    // ── Shared helpers ─────────────────────────────────────────────
    writePromptFile(query, iterDir, source) {
        const folder = path.join(iterDir, models_1.BASE, 'dispatch-prompts');
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `${source}-${Date.now()}.md`);
        fs.writeFileSync(file, query, 'utf8');
        return file;
    }
    getEffectiveCliTemplate(cfg) {
        // Support legacy field name for backward compatibility
        return (cfg.cliCommandTemplate || cfg.claudeCliCommandTemplate || '').trim();
    }
    resolveCliTemplate(cfg, provider) {
        const userTemplate = this.getEffectiveCliTemplate(cfg);
        if (userTemplate) {
            return userTemplate;
        }
        if (provider.defaultCliTemplate) {
            return provider.defaultCliTemplate;
        }
        // Fallback default for CLI providers
        return process.platform === 'win32'
            ? 'Get-Content -Raw "{promptFile}" | claude'
            : 'cat "{promptFile}" | claude';
    }
    buildCliCommand(template, promptFile) {
        const normalizedFile = promptFile.replace(/\\/g, '/');
        return template.replace(/\{promptFile\}/g, normalizedFile);
    }
}
exports.AiDispatchService = AiDispatchService;
//# sourceMappingURL=aiDispatchService.js.map