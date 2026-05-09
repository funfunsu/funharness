import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { BASE, Config } from '../models';

type DispatchSource = 'stage-agent' | 'dev-subtask';

export class AiDispatchService {
    constructor(private readonly getConfig: () => Config) {}

    async dispatch(query: string, iterDir: string, source: DispatchSource): Promise<void> {
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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (cfg.aiFallbackToManual !== false) {
                vscode.window.showWarningMessage(`Claude CLI 派发失败，已自动降级到手工模式：${message}`);
                await this.dispatchManual(query, source);
                return;
            }
            throw error;
        }
    }

    async testConnection(): Promise<void> {
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
            } else {
                vscode.window.showWarningMessage('未检测到 Copilot Chat 命令 workbench.action.chat.open，请确认 Copilot Chat 已安装并启用。');
            }
            return;
        }

        try {
            const output = execSync('claude --version', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            const version = output.split(/\r?\n/)[0] || output;
            const samplePromptFile = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.', BASE, 'dispatch-prompts', 'sample.md');
            const commandPreview = this.buildClaudeCliCommand(cfg.claudeCliCommandTemplate || '', samplePromptFile);
            const hasCustomTemplate = Boolean((cfg.claudeCliCommandTemplate || '').trim());
            const hasPromptPlaceholder = (cfg.claudeCliCommandTemplate || '').includes('{promptFile}');

            vscode.window.showInformationMessage(`Claude CLI 可用：${version}`);
            vscode.window.showInformationMessage(`命令模板预览：${commandPreview}`);

            if (hasCustomTemplate && !hasPromptPlaceholder) {
                vscode.window.showWarningMessage('当前 Claude CLI 命令模板未包含 {promptFile} 占位符，派发时将无法自动注入提示词文件路径。');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`Claude CLI 检测失败：${message}`);
        }
    }

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

    private async dispatchClaudeCli(query: string, iterDir: string, cfg: Config, source: DispatchSource): Promise<void> {
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

    private writePromptFile(query: string, iterDir: string, source: DispatchSource): string {
        const folder = path.join(iterDir, BASE, 'dispatch-prompts');
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `${source}-${Date.now()}.md`);
        fs.writeFileSync(file, query, 'utf8');
        return file;
    }

    private buildClaudeCliCommand(template: string, promptFile: string): string {
        const normalizedFile = promptFile.replace(/\\/g, '/');
        const defaultTemplate = process.platform === 'win32'
            ? 'Get-Content -Raw "{promptFile}" | claude'
            : 'cat "{promptFile}" | claude';
        const effectiveTemplate = (template || defaultTemplate).trim();
        return effectiveTemplate.replace(/\{promptFile\}/g, normalizedFile);
    }
}
