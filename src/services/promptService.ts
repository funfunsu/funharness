import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, PROMPT_CONFIGS, PROMPTS_DIR } from '../models';

export interface RenderedPrompt {
    content: string;
    source: 'project-override' | 'bundled-default';
    path: string;
}

export class PromptService {
    constructor(
        private readonly workspaceRoot: string,
        private readonly extensionPath: string,
    ) {}

    getRenderedPrompt(step: string, taskName: string, taskDesc: string, currentWorkSpace: string, config?: Partial<Config>): string {
        return this.getRenderedPromptWithSource(step, taskName, taskDesc, currentWorkSpace, config).content;
    }

    getRenderedPromptWithSource(step: string, taskName: string, taskDesc: string, currentWorkSpace: string, config?: Partial<Config>): RenderedPrompt {
        const resolved = this.resolvePromptFile(step);
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

    /** 项目级可选覆盖目录：<workspaceRoot>/.harness/prompts（默认不存在，存在时优先生效）。 */
    getProjectPromptsDir(): string {
        return path.join(this.workspaceRoot, BASE, PROMPTS_DIR);
    }

    /**
     * In a worktree window, user-customized prompts are typically maintained in the
     * master workspace's .harness/prompts. We keep local override priority, then
     * fall back to the master prompts dir derived from ".../worktrees/<name>".
     */
    private getCandidatePromptDirs(): string[] {
        const dirs = [this.getProjectPromptsDir()];
        const normalized = this.workspaceRoot.replace(/\\/g, '/');
        const marker = '/worktrees/';
        const idx = normalized.indexOf(marker);
        if (idx > 0) {
            const masterRoot = this.workspaceRoot.slice(0, idx);
            const masterDir = path.join(masterRoot, BASE, PROMPTS_DIR);
            if (!dirs.includes(masterDir)) {
                dirs.push(masterDir);
            }
        }
        return dirs;
    }

    /**
     * 「恢复出厂」：把内置 prompts/ 覆盖写入项目级 .harness/prompts/。
     * 首次调用得到一份可编辑副本；改坏后再次调用即一键修复。返回被写入的文件名列表。
     */
    restoreFactoryPrompts(): string[] {
        const targetDir = this.getProjectPromptsDir();
        fs.mkdirSync(targetDir, { recursive: true });
        const restored: string[] = [];
        for (const cfg of PROMPT_CONFIGS) {
            const source = this.getBundledPromptFile(cfg.key);
            if (source && fs.existsSync(source)) {
                fs.copyFileSync(source, path.join(targetDir, cfg.file));
                restored.push(cfg.file);
            }
        }
        return restored;
    }

    private resolvePromptFile(step: string): { source: RenderedPrompt['source']; path: string } {
        const item = PROMPT_CONFIGS.find(i => i.key === step);
        if (!item) {
            return { source: 'bundled-default', path: '' };
        }
        // Dev prompt dynamic task context is assembled by runtime code; to avoid
        // user-level prompt overrides breaking placeholders, dev always uses bundled template.
        if (step === 'dev') {
            return { source: 'bundled-default', path: this.getBundledPromptFile(step) };
        }
        for (const dir of this.getCandidatePromptDirs()) {
            const override = path.join(dir, item.file);
            if (fs.existsSync(override)) {
                return { source: 'project-override', path: override };
            }
        }
        return { source: 'bundled-default', path: this.getBundledPromptFile(step) };
    }

    private getBundledPromptFile(key: string): string {
        const item = PROMPT_CONFIGS.find(i => i.key === key);
        if (!item) {
            return '';
        }
        return path.join(this.extensionPath, PROMPTS_DIR, item.file);
    }
}
