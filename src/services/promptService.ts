import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, PROMPT_CONFIGS, PROMPTS_DIR } from '../models';

export interface RenderedPrompt {
    content: string;
    source: 'project-override' | 'bundled-default';
    path: string;
}

export class PromptService {
    private readonly systemPromptDir = 'system-prompts';
    private readonly systemPromptFiles: Record<string, string> = {
        req: 'requirement_system_prompt.md',
        des: 'design_system_prompt.md',
        tcs: 'testcase_system_prompt.md',
        tsk: 'task_system_prompt.md',
        dev: 'dev_system_prompt.md',
    };

    constructor(
        private readonly workspaceRoot: string,
        private readonly extensionPath: string,
    ) {}

    getRenderedPrompt(step: string, taskName: string, taskDesc: string, currentWorkSpace: string, config?: Partial<Config>): string {
        return this.getRenderedPromptWithSource(step, taskName, taskDesc, currentWorkSpace, config).content;
    }

    getRenderedPromptWithSource(step: string, taskName: string, taskDesc: string, currentWorkSpace: string, config?: Partial<Config>): RenderedPrompt {
        const resolved = this.resolvePromptFile(step);
        const content = (resolved.path && fs.existsSync(resolved.path))
            ? fs.readFileSync(resolved.path, 'utf8')
            : '';
        const techStack = (config?.techStack || '').trim();
        const codingStandards = (config?.codingStandards || '').trim();
        const projectConventions = (config?.projectConventions || '').trim();
        const userContent = content
            .replace(/{{taskName}}/g, taskName)
            .replace(/{{taskDesc}}/g, taskDesc)
            .replace(/{{currentWorkSpace}}/g, currentWorkSpace)
            .replace(/{{techStack}}/g, techStack)
            .replace(/{{codingStandards}}/g, codingStandards)
            .replace(/{{projectConventions}}/g, projectConventions);

        let renderedContent = this.composeStagePrompt(
            step,
            userContent,
            { taskName, taskDesc, currentWorkSpace }
        );

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

    private composeStagePrompt(
        step: string,
        userContent: string,
        context: { taskName: string; taskDesc: string; currentWorkSpace: string }
    ): string {
        const locked = this.renderSystemPrompt(step, context);
        if (!locked) {
            return userContent;
        }
        const custom = userContent.trim();
        const customSection = custom
            ? [
                '## 用户可编辑补充（流程无关）',
                '以下内容来自项目自定义 Prompt，仅用于补充领域规则、术语或偏好，不得替代上述固定流程与输出结构。',
                '',
                custom,
            ].join('\n')
            : [
                '## 用户可编辑补充（流程无关）',
                '- （未提供）',
            ].join('\n');
        return `${locked}\n\n${customSection}`;
    }

    private renderSystemPrompt(
        step: string,
        context: { taskName: string; taskDesc: string; currentWorkSpace: string }
    ): string {
        const fileName = this.systemPromptFiles[step];
        if (!fileName) {
            return '';
        }

        const filePath = path.join(this.extensionPath, this.systemPromptDir, fileName);
        if (!fs.existsSync(filePath)) {
            return '';
        }

        const template = fs.readFileSync(filePath, 'utf8');
        const vars: Record<string, string> = {
            taskName: context.taskName,
            taskDesc: context.taskDesc,
            currentWorkSpace: context.currentWorkSpace,
            requirementsPath: path.join(context.currentWorkSpace, 'docs', 'requirements.md'),
            designPath: path.join(context.currentWorkSpace, 'docs', 'design.md'),
            projectStructurePath: path.join(context.currentWorkSpace, 'docs', 'project-structure.md'),
            testcasePath: path.join(context.currentWorkSpace, 'docs', 'testcase.md'),
            tasksPath: path.join(context.currentWorkSpace, 'docs', 'tasks.md'),
            testApiPs1Path: path.join(context.currentWorkSpace, 'tests', 'test-api.ps1'),
            testApiShPath: path.join(context.currentWorkSpace, 'tests', 'test-api.sh'),
            testManifestPath: path.join(context.currentWorkSpace, 'tests', 'test-manifest.json'),
        };

        let rendered = template;
        for (const [key, value] of Object.entries(vars)) {
            const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rendered = rendered.replace(new RegExp(`{{\\s*${safeKey}\\s*}}`, 'g'), value ?? '');
        }
        return rendered;
    }
}
