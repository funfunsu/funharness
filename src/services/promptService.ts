import * as fs from 'fs';
import * as path from 'path';
import { AGENT_DIR, BASE, PROMPT_CONFIGS, PROMPTS_DIR } from '../models';

export class PromptService {
    constructor(
        private readonly workspaceRoot: string,
        private readonly extensionPath: string,
    ) {}

    ensureProjectPrompts(): void {
        const targetDir = this.getProjectPromptsDir();
        fs.mkdirSync(targetDir, { recursive: true });

        for (const cfg of PROMPT_CONFIGS) {
            const target = path.join(targetDir, cfg.file);
            if (!fs.existsSync(target)) {
                const source = this.getBundledPromptFile(cfg.key);
                if (fs.existsSync(source)) {
                    fs.copyFileSync(source, target);
                }
            }
        }
    }

    createAgentDefinitions(): void {
        const agentDir = path.join(this.workspaceRoot, AGENT_DIR);
        fs.mkdirSync(agentDir, { recursive: true });

        for (const cfg of PROMPT_CONFIGS) {
            const agentFile = path.join(agentDir, `fun-harness-${cfg.key}.agent.md`);
            const promptContent = this.getBundledPromptContent(cfg.key);
            fs.writeFileSync(agentFile, this.buildAgentDefinition(cfg.key, cfg.name, promptContent), 'utf8');
        }
    }

    restoreAgentPrompt(promptKey: string): void {
        const cfg = PROMPT_CONFIGS.find(c => c.key === promptKey);
        if (!cfg) {
            return;
        }
        const agentDir = path.join(this.workspaceRoot, AGENT_DIR);
        const agentFile = path.join(agentDir, `fun-harness-${promptKey}.agent.md`);
        const promptContent = this.getBundledPromptContent(promptKey);
        fs.writeFileSync(agentFile, this.buildAgentDefinition(promptKey, cfg.name, promptContent), 'utf8');
    }

    getRenderedPrompt(step: string, taskName: string, taskDesc: string, currentWorkSpace: string): string {
        const file = this.getPromptFile(step);
        if (!fs.existsSync(file)) {
            return '';
        }
        const content = fs.readFileSync(file, 'utf8');
        return content
            .replace(/{{taskName}}/g, taskName)
            .replace(/{{taskDesc}}/g, taskDesc)
            .replace(/{{currentWorkSpace}}/g, currentWorkSpace);
    }

    private getProjectPromptsDir(): string {
        return path.join(this.workspaceRoot, BASE, PROMPTS_DIR);
    }

    private getPromptFile(key: string): string {
        const item = PROMPT_CONFIGS.find(i => i.key === key);
        if (!item) {
            return '';
        }
        return path.join(this.getProjectPromptsDir(), item.file);
    }

    private getBundledPromptFile(key: string): string {
        const item = PROMPT_CONFIGS.find(i => i.key === key);
        if (!item) {
            return '';
        }
        return path.join(this.extensionPath, PROMPTS_DIR, item.file);
    }

    private getBundledPromptContent(key: string): string {
        const file = this.getBundledPromptFile(key);
        if (!file || !fs.existsSync(file)) {
            return '';
        }
        return fs.readFileSync(file, 'utf8');
    }

    private buildAgentDefinition(key: string, name: string, promptContent: string): string {
        return `---
name: fun-harness-${key}
description: ${name}
argument-hint: "The task name, description, and output path"
---

${promptContent}
`;
    }
}
