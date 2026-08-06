import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync, spawn } from 'child_process';
import { BASE, Config, AiProviderDefinition, getAiProvider } from '../models';
import { appendHarnessLog } from './harnessLog';

type DispatchSource = 'stage-agent' | 'dev-subtask';

export class AiDispatchService {
    /** Keep the latest chat scope per provider so dev subtasks can reuse one chat per batch (1.x / 2.x). */
    private readonly lastVscodeChatScopeByProvider = new Map<string, string>();

    constructor(private readonly getConfig: () => Config) {}

    /**
     * Best-effort text refinement for workflows that require AI output inline.
     * Currently supports CLI providers that can print the result to stdout.
     */
    refineToTextSync(query: string, iterDir: string, providerOverride?: string): string | null {
        const cfg = this.getConfig();
        const provider = getAiProvider(providerOverride || cfg.aiProvider || 'copilot-chat');
        if (provider.kind !== 'cli') {
            return null;
        }

        const promptFile = this.writePromptFile(query, iterDir, 'stage-agent');
        const template = this.resolveCliTemplate(cfg, provider);
        const command = this.buildCliCommand(template, promptFile);
        try {
            const output = execSync(command, {
                cwd: iterDir,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                maxBuffer: 1024 * 1024,
                timeout: 120000,
            }).trim();
            return output || null;
        } catch (error) {
            console.warn('[fun-harness] refineToTextSync failed:', error);
            return null;
        }
    }

    /**
     * Best-effort inline text refinement that returns AI output to the caller.
     * Uses a CLI provider synchronously when configured, otherwise falls back to the
     * VS Code Language Model API (GitHub Copilot and other registered chat models).
     * Returns null when no model is available or the request fails.
     */
    async refineToText(query: string, iterDir: string, providerOverride?: string): Promise<string | null> {
        const cliResult = this.refineToTextSync(query, iterDir, providerOverride);
        if (cliResult !== null) {
            appendHarnessLog(iterDir, 'ai-refine', `cli refine returned ${cliResult.length} chars`);
            return cliResult;
        }
        return this.refineToTextViaLanguageModel(query, undefined, iterDir);
    }

    /**
     * Send a single-turn request to a VS Code language model and collect the full text.
     * The first call may trigger a one-time user consent prompt for model access.
     */
    async refineToTextViaLanguageModel(
        query: string,
        options?: { vendor?: string; family?: string },
        iterDir?: string,
    ): Promise<string | null> {
        const log = (message: string) => {
            if (iterDir) {
                appendHarnessLog(iterDir, 'ai-refine', message);
            }
        };
        const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
        if (!lm || typeof lm.selectChatModels !== 'function') {
            log('language model API unavailable (vscode.lm missing; requires VS Code >= 1.90)');
            return null;
        }
        try {
            const selector: vscode.LanguageModelChatSelector = { vendor: options?.vendor || 'copilot' };
            if (options?.family) {
                selector.family = options.family;
            }
            let models = await lm.selectChatModels(selector);
            if (!models || models.length === 0) {
                models = await lm.selectChatModels({ vendor: 'copilot' });
            }
            if (!models || models.length === 0) {
                log(`no language models available for vendor="${selector.vendor}"`);
                return null;
            }
            const model = this.pickPreferredRefineModel(models, options?.family);
            log(`using language model vendor=${model.vendor} family=${model.family} id=${model.id}`);
            const messages = [vscode.LanguageModelChatMessage.User(query)];
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                const response = await model.sendRequest(messages, {}, tokenSource.token);
                let text = '';
                for await (const fragment of response.text) {
                    text += fragment;
                }
                const trimmed = text.trim();
                log(`language model returned ${trimmed.length} chars`);
                return trimmed || null;
            } finally {
                tokenSource.dispose();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`language model request failed: ${message}`);
            console.warn('[fun-harness] refineToTextViaLanguageModel failed:', error);
            return null;
        }
    }

    /**
     * Pick a low-cost model for lightweight refinement tasks. Prefers inexpensive families
     * (gpt-4o-mini / gpt-4.1 / gpt-4o) and avoids premium families (claude / o1 / gpt-5 / gemini)
     * when a cheaper option exists. An explicit family override always wins when available.
     */
    private pickPreferredRefineModel(
        models: readonly vscode.LanguageModelChat[],
        familyOverride?: string,
    ): vscode.LanguageModelChat {
        if (familyOverride) {
            const wanted = familyOverride.toLowerCase();
            const exact = models.find(
                model => (model.family || '').toLowerCase() === wanted || (model.id || '').toLowerCase() === wanted,
            );
            if (exact) {
                return exact;
            }
        }

        const preferredFamilies = ['gpt-4o-mini', 'gpt-4.1', 'gpt-4o'];
        for (const family of preferredFamilies) {
            const match = models.find(
                model => (model.family || '').toLowerCase().includes(family) || (model.id || '').toLowerCase().includes(family),
            );
            if (match) {
                return match;
            }
        }

        const premiumPattern = /claude|o1|o3|gpt-5|opus|sonnet|gemini|fable/i;
        const nonPremium = models.find(model => !premiumPattern.test(`${model.family} ${model.id}`));
        return nonPremium || models[0];
    }

    async dispatch(query: string, iterDir: string, source: DispatchSource, providerOverride?: string): Promise<void> {
        const cfg = this.getConfig();
        const provider = getAiProvider(providerOverride || cfg.aiProvider || 'copilot-chat');
        const conversationScope = this.resolveConversationScope(source, iterDir, query);
        const snapshot = this.writeDispatchSnapshot(query, iterDir, source, provider.label);
        appendHarnessLog(
            iterDir,
            'ai-dispatch',
            `source=${source} provider=${provider.label} scope=${conversationScope || 'none'} bytes=${Buffer.byteLength(query, 'utf8')} promptFile=${snapshot || '(write-failed)'}`,
        );

        if (provider.kind === 'manual') {
            await this.dispatchManual(query, source);
            return;
        }

        if (provider.kind === 'vscode-chat') {
            await this.dispatchVscodeChat(query, provider, source, conversationScope);
            return;
        }

        if (provider.kind === 'panel') {
            await this.dispatchPanel(query, provider, source, conversationScope);
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

    private async dispatchVscodeChat(
        query: string,
        provider: AiProviderDefinition,
        source: DispatchSource,
        conversationScope: string | null,
    ): Promise<void> {
        const providerKey = provider.id || provider.label;
        const previousScope = this.lastVscodeChatScopeByProvider.get(providerKey);
        const shouldOpenNewChat = this.shouldOpenNewVscodeChat(source, conversationScope, previousScope);

        if (shouldOpenNewChat) {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.newChat');
            } catch {
                // Older VS Code builds may not expose a dedicated new-chat command.
            }
        }

        const command = provider.chatCommand || 'workbench.action.chat.open';
        await vscode.commands.executeCommand(command, {
            query,
            isPartial: false,
        });

        if (source === 'dev-subtask' && conversationScope) {
            this.lastVscodeChatScopeByProvider.set(providerKey, conversationScope);
        }
    }

    /**
     * Decide whether to open a new VS Code chat session before dispatch.
     * For dev-subtask dispatches, keep reusing the current session whenever possible:
     * - open new only on first dev dispatch (no previous scope), or
     * - when current parsed scope explicitly differs from previous scope (cross-batch).
     * If scope parsing fails for one dispatch, do NOT force a new chat; reuse current.
     */
    private shouldOpenNewVscodeChat(
        source: DispatchSource,
        conversationScope: string | null,
        previousScope: string | undefined,
    ): boolean {
        if (source !== 'dev-subtask') {
            return true;
        }
        if (!previousScope) {
            return true;
        }
        if (!conversationScope) {
            return false;
        }
        return previousScope !== conversationScope;
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

    private async dispatchPanel(
        query: string,
        provider: AiProviderDefinition,
        source: DispatchSource,
        conversationScope: string | null,
    ): Promise<void> {
        // Always keep the full prompt on the clipboard as a safety net (the panel cannot be
        // auto-submitted programmatically, and deep links cap length).
        await vscode.env.clipboard.writeText(query);

        // 1) Preferred: invoke the provider's prefill command directly with the full prompt.
        //    For Claude Code this is `claude-vscode.primaryEditor.open(session, prompt)` — the
        //    same command its deep link forwards to, but with no URI length/encoding limits.
        if (provider.panelPromptCommand) {
            try {
                await vscode.commands.executeCommand(provider.panelPromptCommand, conversationScope || undefined, query);
                const sent = await this.maybeAutoSubmit(provider);
                vscode.window.showInformationMessage(
                    `已唤起 ${provider.label} 并预填提示词${this.autoSubmitTail(sent)}（source=${source}）。`,
                );
                return;
            } catch {
                // Command unavailable (e.g. extension not installed) — fall through.
            }
        }

        // 2) Fallback: a deep-link URI that opens the panel with the prompt pre-filled.
        if (provider.openUriTemplate) {
            const opened = await this.openPanelViaUri(query, provider);
            if (opened) {
                const sent = await this.maybeAutoSubmit(provider);
                vscode.window.showInformationMessage(
                    `已唤起 ${provider.label} 并预填提示词${this.autoSubmitTail(sent)}（source=${source}）。完整提示词已复制到剪贴板。`,
                );
                return;
            }
        }

        // 3) Last resort: open the panel via command and rely on a manual paste.
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

    private resolveConversationScope(source: DispatchSource, iterDir: string, query: string): string | null {
        if (source !== 'dev-subtask') {
            return null;
        }

        const mode = this.getConfig().devConversationMode === 'single' ? 'single' : 'batch';
        if (mode === 'single') {
            return `dev-single:${iterDir}`;
        }

        const batch = this.extractSubTaskBatch(query);
        if (!batch) {
            return null;
        }

        return `dev-batch:${iterDir}:${batch}`;
    }

    private extractSubTaskBatch(query: string): string | null {
        const text = String(query || '');
        const match = text.match(/(?:^|\n)\s*-\s*任务ID\s*[：:]\s*(\d+)\.(\d+)/i)
            || text.match(/(?:^|\n)\s*taskId\s*[：:]\s*(\d+)\.(\d+)/i);
        if (!match) {
            return null;
        }
        return match[1];
    }

    /**
     * Open a provider's panel through its deep-link URI with the prompt pre-filled. Caps the
     * embedded prompt so the resulting URI stays within practical length limits; the full text
     * remains on the clipboard. Returns false if the URI could not be opened.
     *
     * We hand the fully pre-encoded URI to the OS opener (open / start / xdg-open) rather than
     * vscode.env.openExternal, because openExternal re-encodes the Uri and mangles the
     * `?prompt=` separator and existing percent-escapes. The OS opener receives the exact bytes,
     * matching the verified `open "vscode://anthropic.claude-code/open?prompt=..."` command.
     */
    private async openPanelViaUri(query: string, provider: AiProviderDefinition): Promise<boolean> {
        const MAX_URI_PROMPT_CHARS = 1800;
        const truncated = query.length > MAX_URI_PROMPT_CHARS;
        const promptForUri = truncated
            ? `${query.slice(0, MAX_URI_PROMPT_CHARS)}\n\n（提示词较长已截断：完整内容已复制到剪贴板，并可直接读取当前工作区的 todo.md）`
            : query;
        const uriString = provider.openUriTemplate!.replace('{prompt}', encodeURIComponent(promptForUri));
        return this.openUriViaOs(uriString);
    }

    private openUriViaOs(uriString: string): Promise<boolean> {
        return new Promise((resolve) => {
            const platform = process.platform;
            let command: string;
            let args: string[];
            if (platform === 'darwin') {
                command = 'open';
                args = [uriString];
            } else if (platform === 'win32') {
                // `start` is a cmd builtin; the empty "" is the (required) window-title arg.
                command = process.env.ComSpec || 'cmd.exe';
                args = ['/c', 'start', '', uriString];
            } else {
                command = 'xdg-open';
                args = [uriString];
            }
            try {
                const child = spawn(command, args, { windowsHide: true });
                child.on('error', () => resolve(false));
                child.on('close', (code) => resolve(code === 0 || code === null));
            } catch {
                resolve(false);
            }
        });
    }

    /**
     * After a panel executor pre-fills its prompt, optionally press Return to submit it. The Claude
     * Code panel (both the prefill command and the deep link) only pre-fills — it never auto-sends —
     * so on macOS we drive a keystroke via `osascript`/System Events, matching the verified manual
     * sequence: open the panel, wait ~1.2s for the input to focus, then `keystroke return`.
     *
     * Returns 'sent' (keystroke dispatched), 'failed' (osascript errored — usually the editor lacks
     * the macOS「辅助功能/Accessibility」permission), or 'skipped' (disabled by config/provider, or a
     * non-macOS platform). In every case the prompt stays pre-filled and on the clipboard, so the
     * user can always send it manually.
     */
    private maybeAutoSubmit(provider: AiProviderDefinition): Promise<'sent' | 'failed' | 'skipped'> {
        const enabled = provider.autoSubmit === true && this.getConfig().aiPanelAutoSubmit !== false;
        if (!enabled || process.platform !== 'darwin') {
            return Promise.resolve('skipped');
        }
        const DELAY_MS = 1200; // give the panel time to open and focus its input before pressing Return
        return new Promise((resolve) => {
            setTimeout(() => {
                try {
                    let stderr = '';
                    const child = spawn(
                        'osascript',
                        ['-e', 'tell application "System Events" to keystroke return'],
                        { windowsHide: true },
                    );
                    child.stderr?.on('data', (d) => { stderr += d.toString(); });
                    child.on('error', (err) => {
                        console.error('[fun-harness] osascript 自动回车启动失败：', err);
                        resolve('failed');
                    });
                    child.on('close', (code) => {
                        if (code === 0) {
                            resolve('sent');
                            return;
                        }
                        // Most common: macOS hasn't granted the editor「辅助功能」(Accessibility) and
                        // 「自动化 → System Events」(Automation) permission, so osascript exits non-zero
                        // with e.g. error -1719/-1743. Surface the real message to make it actionable.
                        const detail = stderr.trim();
                        console.error(`[fun-harness] osascript 自动回车失败 (exit ${code})：${detail}`);
                        if (detail) {
                            vscode.window.showWarningMessage(`自动回车发送失败：${detail.slice(0, 300)}`);
                        }
                        resolve('failed');
                    });
                } catch (err) {
                    console.error('[fun-harness] osascript 自动回车异常：', err);
                    resolve('failed');
                }
            }, DELAY_MS);
        });
    }

    /** Notification suffix describing what happened with auto-submit (see maybeAutoSubmit). */
    private autoSubmitTail(status: 'sent' | 'failed' | 'skipped'): string {
        switch (status) {
            case 'sent':
                return '，已自动回车发送';
            case 'failed':
                return '，自动发送失败（请为编辑器授予「辅助功能」权限，或手动按回车）';
            default:
                return '，确认后按回车发送';
        }
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

    /**
     * Persist the final prompt dispatched to AI so users can audit exact runtime content.
     * Returns the absolute snapshot file path, or empty string on best-effort failure.
     */
    private writeDispatchSnapshot(query: string, iterDir: string, source: DispatchSource, providerLabel: string): string {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const provider = providerLabel.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'unknown';
        const fileName = `${source}-${provider}-${stamp}.md`;
        try {
            const folder = path.join(iterDir, BASE, 'dispatch-prompts');
            fs.mkdirSync(folder, { recursive: true });
            const file = path.join(folder, fileName);
            fs.writeFileSync(file, query, 'utf8');
            this.writeWorkspaceMirrorSnapshot(query, fileName, file);
            return file;
        } catch (error) {
            this.writeWorkspaceMirrorSnapshot(query, fileName);
            console.warn('[fun-harness] writeDispatchSnapshot failed:', error);
            return '';
        }
    }

    private writePromptFile(query: string, iterDir: string, source: DispatchSource): string {
        const folder = path.join(iterDir, BASE, 'dispatch-prompts');
        fs.mkdirSync(folder, { recursive: true });
        const fileName = `${source}-${Date.now()}.md`;
        const file = path.join(folder, fileName);
        fs.writeFileSync(file, query, 'utf8');
        this.writeWorkspaceMirrorSnapshot(query, fileName, file);
        return file;
    }

    private writeWorkspaceMirrorSnapshot(query: string, fileName: string, primaryFile?: string): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return;
        }

        const mirrorFolder = path.join(workspaceRoot, BASE, 'dispatch-prompts');
        const mirrorFile = path.join(mirrorFolder, fileName);
        if (primaryFile && path.resolve(primaryFile) === path.resolve(mirrorFile)) {
            return;
        }

        try {
            fs.mkdirSync(mirrorFolder, { recursive: true });
            fs.writeFileSync(mirrorFile, query, 'utf8');
        } catch (error) {
            console.warn('[fun-harness] writeWorkspaceMirrorSnapshot failed:', error);
        }
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
