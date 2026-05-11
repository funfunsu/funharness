import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { BASE, Config, AiProviderDefinition, getAiProvider } from '../models';

type DispatchSource = 'stage-agent' | 'dev-subtask';

export class AiDispatchService {
    constructor(private readonly getConfig: () => Config) {}

    async dispatch(query: string, iterDir: string, source: DispatchSource, providerOverride?: string): Promise<void> {
        const cfg = this.getConfig();
        const provider = getAiProvider(providerOverride || cfg.aiProvider || 'copilot-chat');

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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (cfg.aiFallbackToManual !== false) {
                vscode.window.showWarningMessage(`${provider.label} 派发失败，已自动降级到手工模式：${message}`);
                await this.dispatchManual(query, source);
                return;
            }
            throw error;
        }
    }

    async testConnection(): Promise<void> {
        const cfg = this.getConfig();
        const provider = getAiProvider(cfg.aiProvider || 'copilot-chat');

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

    private async dispatchVscodeChat(query: string, provider: AiProviderDefinition): Promise<void> {
        const command = provider.chatCommand || 'workbench.action.chat.open';
        await vscode.commands.executeCommand(command, {
            query,
            isPartial: false,
        });
    }

    private async testVscodeChat(provider: AiProviderDefinition): Promise<void> {
        const command = provider.chatCommand || 'workbench.action.chat.open';
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes(command)) {
            vscode.window.showInformationMessage(`${provider.label} 可用：已检测到命令 ${command}。`);
        } else {
            vscode.window.showWarningMessage(`未检测到 ${provider.label} 命令 ${command}，请确认对应扩展已安装并启用。`);
        }
    }

    // ── CLI dispatch ───────────────────────────────────────────────

    private async dispatchCli(
        query: string,
        iterDir: string,
        cfg: Config,
        provider: AiProviderDefinition,
        source: DispatchSource,
    ): Promise<void> {
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

    private async testCli(cfg: Config, provider: AiProviderDefinition): Promise<void> {
        const detectCmd = provider.detectHint || 'echo ok';
        try {
            const output = execSync(detectCmd, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            const version = output.split(/\r?\n/)[0] || output;

            const samplePromptFile = path.join(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.',
                BASE,
                'dispatch-prompts',
                'sample.md',
            );
            const template = this.resolveCliTemplate(cfg, provider);
            const commandPreview = this.buildCliCommand(template, samplePromptFile);
            const hasCustomTemplate = Boolean(this.getEffectiveCliTemplate(cfg).trim());
            const hasPromptPlaceholder = template.includes('{promptFile}');

            vscode.window.showInformationMessage(`${provider.label} 可用：${version}`);
            vscode.window.showInformationMessage(`命令模板预览：${commandPreview}`);

            if (hasCustomTemplate && !hasPromptPlaceholder) {
                vscode.window.showWarningMessage(
                    `当前 CLI 命令模板未包含 {promptFile} 占位符，派发时将无法自动注入提示词文件路径。`,
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`${provider.label} 检测失败：${message}`);
        }
    }

    // ── Panel dispatch (open provider's own panel + clipboard) ───

    private async dispatchPanel(query: string, provider: AiProviderDefinition, source: DispatchSource): Promise<void> {
        await vscode.env.clipboard.writeText(query);
        const command = provider.panelCommand;
        if (command) {
            try {
                await vscode.commands.executeCommand(command);
            } catch {
                // Panel command failed — still copied to clipboard, user can open manually.
            }
        }
        vscode.window.showInformationMessage(
            `已复制提示词到剪贴板并打开 ${provider.label}，请粘贴执行（source=${source}）`,
        );
    }

    private async testPanel(provider: AiProviderDefinition): Promise<void> {
        const command = provider.panelCommand;
        if (!command) {
            vscode.window.showWarningMessage(`${provider.label} 未配置面板命令。`);
            return;
        }
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes(command)) {
            vscode.window.showInformationMessage(`${provider.label} 可用：已检测到命令 ${command}。`);
        } else {
            vscode.window.showWarningMessage(`未检测到 ${provider.label} 命令 ${command}，请确认对应扩展已安装并启用。`);
        }
    }

    // ── Manual dispatch ────────────────────────────────────────────

    private async dispatchManual(query: string, source: DispatchSource): Promise<void> {
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

    private writePromptFile(query: string, iterDir: string, source: DispatchSource): string {
        const folder = path.join(iterDir, BASE, 'dispatch-prompts');
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `${source}-${Date.now()}.md`);
        fs.writeFileSync(file, query, 'utf8');
        return file;
    }

    private getEffectiveCliTemplate(cfg: Config): string {
        // Support legacy field name for backward compatibility
        return (cfg.cliCommandTemplate || cfg.claudeCliCommandTemplate || '').trim();
    }

    private resolveCliTemplate(cfg: Config, provider: AiProviderDefinition): string {
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

    private buildCliCommand(template: string, promptFile: string): string {
        const normalizedFile = promptFile.replace(/\\/g, '/');
        return template.replace(/\{promptFile\}/g, normalizedFile);
    }
}
