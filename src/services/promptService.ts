import * as fs from 'fs';
import * as path from 'path';
import { AGENT_DIR, BASE, Config, PROMPT_CONFIGS, PROMPTS_DIR } from '../models';

type PromptSource = 'task-override' | 'master-override' | 'workspace-override' | 'bundled-default';

export interface RenderedPrompt {
    content: string;
    source: PromptSource;
    path: string;
}

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

    getRenderedPrompt(step: string, taskName: string, taskDesc: string, currentWorkSpace: string, config?: Partial<Config>): string {
        const rendered = this.getRenderedPromptWithSource(step, taskName, taskDesc, currentWorkSpace, config);
        return rendered.content;
    }

    getRenderedPromptWithSource(step: string, taskName: string, taskDesc: string, currentWorkSpace: string, config?: Partial<Config>): RenderedPrompt {
        const resolved = this.resolvePromptFile(step, currentWorkSpace);
        if (!resolved.path || !fs.existsSync(resolved.path)) {
            return { content: '', source: resolved.source, path: resolved.path };
        }
        const content = fs.readFileSync(resolved.path, 'utf8');
        const techStack = (config?.techStack || '').trim();
        const codingStandards = (config?.codingStandards || '').trim();
        const projectConventions = (config?.projectConventions || '').trim();
        let renderedContent = content
            .replace(/{{taskName}}/g, taskName)
            .replace(/{{taskDesc}}/g, taskDesc)
            .replace(/{{currentWorkSpace}}/g, currentWorkSpace)
            .replace(/{{techStack}}/g, techStack)
            .replace(/{{codingStandards}}/g, codingStandards)
            .replace(/{{projectConventions}}/g, projectConventions);

        if (projectConventions && !/{{projectConventions}}/g.test(content)) {
            renderedContent += `\n\n## 项目自定义约定\n${projectConventions}\n`;
        }

        return {
            content: renderedContent,
            source: resolved.source,
            path: resolved.path,
        };
    }

    private resolvePromptFile(step: string, currentWorkSpace: string): { source: PromptSource; path: string } {
        const item = PROMPT_CONFIGS.find(i => i.key === step);
        if (!item) {
            return { source: 'bundled-default', path: '' };
        }

        const taskOverride = path.join(currentWorkSpace, BASE, PROMPTS_DIR, item.file);
        if (fs.existsSync(taskOverride)) {
            return { source: 'task-override', path: taskOverride };
        }

        const masterRoot = this.resolveMasterRoot(currentWorkSpace);
        if (masterRoot) {
            const masterOverride = path.join(masterRoot, BASE, PROMPTS_DIR, item.file);
            if (fs.existsSync(masterOverride)) {
                return { source: 'master-override', path: masterOverride };
            }
        }

        const workspaceOverride = this.getPromptFile(step);
        if (workspaceOverride && fs.existsSync(workspaceOverride)) {
            return { source: 'workspace-override', path: workspaceOverride };
        }

        return { source: 'bundled-default', path: this.getBundledPromptFile(step) };
    }

    private resolveMasterRoot(currentWorkSpace: string): string {
        const configCandidates = [
            path.join(currentWorkSpace, BASE, 'config.json'),
            path.join(this.workspaceRoot, BASE, 'config.json'),
        ];

        for (const file of configCandidates) {
            if (!fs.existsSync(file)) {
                continue;
            }
            try {
                const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
                const masterRoot = typeof raw.__harnessMasterRoot === 'string' ? raw.__harnessMasterRoot : '';
                if (!masterRoot) {
                    continue;
                }
                const resolvedMasterRoot = path.resolve(masterRoot);
                if (!this.isWithinWorkspaceRoot(resolvedMasterRoot)) {
                    continue;
                }
                if (fs.existsSync(resolvedMasterRoot)) {
                    return resolvedMasterRoot;
                }
            } catch {
                // Ignore malformed config and continue.
            }
        }

        return '';
    }

    private isWithinWorkspaceRoot(targetPath: string): boolean {
        const root = path.resolve(this.workspaceRoot);
        const target = path.resolve(targetPath);
        return target === root || target.startsWith(`${root}${path.sep}`);
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
