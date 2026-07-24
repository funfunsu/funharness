import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, PROMPT_CONFIGS, PROMPTS_DIR, getDocsRootDirName, getSpecDocsDir } from '../models';
import { resolveConstitution, summarizeConstitution } from '../constitution';

export interface RenderedPrompt {
    content: string;
    source: 'project-override' | 'bundled-default';
    path: string;
}

/** Contract for a sample profile consumed by prompt assembly in sample-driven mode. */
export interface PromptSampleProfileContract {
    id: string;
    name: string;
    schemaVersion: string;
    exemplarMarkdown: string;
    includePatterns: string[];
    excludePatterns: string[];
}

/** Input contract aligned with design API-1 request fields. */
export interface ProjectStructurePromptInput {
    workspaceRoot: string;
    sampleProfileId: string;
    granularityProfileId: string;
    extractionMode: 'sampleDriven' | 'legacy';
    sampleProfile: PromptSampleProfileContract;
    granularityRuleSet?: {
        id: string;
        maxDepth: number;
        mustExpandDomains: string[];
        collapsePatterns: string[];
        dedupeStrategy: 'byPath' | 'bySemantic';
    };
    outputContract?: {
        requiredSections: string[];
        requiredFields: string[];
        formatHint?: string;
    };
}

/** Error raised when prompt contract blocks are missing in sample-driven mode. */
export class PromptContractIncompleteError extends Error {
    readonly code = 'PROMPT_CONTRACT_INCOMPLETE';

    constructor(
        public readonly missingBlocks: string[],
        public readonly details: string[],
    ) {
        super(
            `PROMPT_CONTRACT_INCOMPLETE: missingBlocks=${missingBlocks.join(',') || '(none)'}; details=${details.join(',') || '(none)'}`,
        );
    }
}

export interface DomainSummaryPromptCapability {
    reqId: string;
    title: string;
    status: string;
}

export interface DomainSummaryPromptInput {
    canonical: string;
    displayName: string;
    capabilities: DomainSummaryPromptCapability[];
    registryCanonicals: string[];
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
            { taskName, taskDesc, currentWorkSpace },
            config
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

    /**
     * Build a deterministic prompt section for project-structure extraction.
     * The section binds sample standards to an explicit request contract.
     */
    buildProjectStructureExtractionSection(input: ProjectStructurePromptInput): string {
        this.assertProjectStructurePromptContract(input);
        const profile = input.sampleProfile;
        const includePatterns = profile.includePatterns.length > 0 ? profile.includePatterns : ['**/*'];
        const excludePatterns = profile.excludePatterns;
        const granularityRuleSet = input.granularityRuleSet;
        const mappedGranularityLines = granularityRuleSet
            ? [
                '### Granularity Rule Set',
                `- id: ${granularityRuleSet.id}`,
                `- maxDepth: ${granularityRuleSet.maxDepth}`,
                `- mustExpandDomains: ${granularityRuleSet.mustExpandDomains.join(', ') || '(none)'}`,
                `- collapsePatterns: ${granularityRuleSet.collapsePatterns.join(', ') || '(none)'}`,
                `- dedupeStrategy: ${granularityRuleSet.dedupeStrategy}`,
                '',
            ]
            : [];
        const outputContract = input.outputContract!;
        return [
            '## Project Structure Extraction Input',
            `- workspaceRoot: ${input.workspaceRoot}`,
            `- sampleProfileId: ${input.sampleProfileId}`,
            `- granularityProfileId: ${input.granularityProfileId}`,
            `- extractionMode: ${input.extractionMode}`,
            '',
            '### Sample Standard',
            `- id: ${profile.id}`,
            `- name: ${profile.name}`,
            `- schemaVersion: ${profile.schemaVersion}`,
            `- includePatterns: ${includePatterns.join(', ')}`,
            `- excludePatterns: ${excludePatterns.join(', ') || '(none)'}`,
            '',
            '### Rule Constraints',
            ...mappedGranularityLines,
            '### Output Contract',
            `- requiredSections: ${outputContract.requiredSections.join(', ') || '(none)'}`,
            `- requiredFields: ${outputContract.requiredFields.join(', ') || '(none)'}`,
            `- formatHint: ${outputContract.formatHint || '(none)'}`,
            '',
            '### Sample Exemplar',
            profile.exemplarMarkdown.trim(),
        ].join('\n');
    }

    /**
     * Guard INV-3/E-3: sample-driven mode must include sample/rules/output-contract blocks.
     * If any block is missing, fail fast and block AI dispatch.
     */
    private assertProjectStructurePromptContract(input: ProjectStructurePromptInput): void {
        if (input.extractionMode !== 'sampleDriven') {
            return;
        }
        const missingBlocks: string[] = [];
        const details: string[] = [];

        if (!input.sampleProfile || !input.sampleProfile.id || !input.sampleProfile.exemplarMarkdown.trim()) {
            missingBlocks.push('sample');
            details.push('sampleProfile.id/exemplarMarkdown');
        }

        if (!input.granularityRuleSet) {
            missingBlocks.push('rules');
            details.push('granularityRuleSet');
        }

        if (!input.outputContract) {
            missingBlocks.push('outputContract');
            details.push('outputContract');
        } else {
            if (input.outputContract.requiredSections.length === 0) {
                details.push('outputContract.requiredSections');
            }
            if (input.outputContract.requiredFields.length === 0) {
                details.push('outputContract.requiredFields');
            }
            if (input.outputContract.requiredSections.length === 0 || input.outputContract.requiredFields.length === 0) {
                if (!missingBlocks.includes('outputContract')) {
                    missingBlocks.push('outputContract');
                }
            }
        }

        if (missingBlocks.length > 0) {
            throw new PromptContractIncompleteError(missingBlocks, details);
        }
    }

    /**
     * Build optional AI refinement prompt for domain capability summaries.
     */
    buildDomainSummaryPrompt(input: DomainSummaryPromptInput): string {
        return PromptService.buildDomainSummaryPrompt(input);
    }

    /**
     * Build optional AI refinement prompt for domain capability summaries.
     */
    static buildDomainSummaryPrompt(input: DomainSummaryPromptInput): string {
        const canonical = (input.canonical || '').trim();
        const displayName = (input.displayName || canonical).trim();
        const capabilities = (input.capabilities || [])
            .map(item => ({
                reqId: (item.reqId || '').trim(),
                title: (item.title || '').trim(),
                status: (item.status || '').trim() || 'active',
            }))
            .filter(item => item.reqId.length > 0);
        const registryCanonicals = Array.from(new Set((input.registryCanonicals || [])
            .map(item => (item || '').trim())
            .filter(Boolean))).sort((left, right) => left.localeCompare(right));

        const payload = {
            domain: {
                canonical,
                displayName,
            },
            canonical,
            displayName,
            capabilities,
            registryCanonicals,
        };

        return [
            '你是领域能力摘要润色助手。',
            `领域：${displayName}${canonical ? `（${canonical}）` : ''}`,
            '你只能润色已存在 capabilities 的 title 文案，不得新增/删除 capability，不得改 reqId，不得改 status。',
            '你不得创建新领域名，canonical 必须保留在 registryCanonicals 中。',
            '若输入存在不清晰描述，可保持原文，不得臆造事实。',
            '仅返回 JSON，不要返回 Markdown，不要解释。',
            '返回格式：{"capabilities":[{"reqId":"Req-...","title":"..."}]}',
            '',
            JSON.stringify(payload, null, 2),
        ].join('\n');
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
        // Backward compatibility: legacy root-level prompts/ directory.
        const legacyProjectDir = path.join(this.workspaceRoot, PROMPTS_DIR);
        if (!dirs.includes(legacyProjectDir)) {
            dirs.push(legacyProjectDir);
        }
        const normalized = this.workspaceRoot.replace(/\\/g, '/');
        const marker = '/worktrees/';
        const idx = normalized.indexOf(marker);
        if (idx > 0) {
            const masterRoot = this.workspaceRoot.slice(0, idx);
            const masterDir = path.join(masterRoot, BASE, PROMPTS_DIR);
            if (!dirs.includes(masterDir)) {
                dirs.push(masterDir);
            }
            const legacyMasterDir = path.join(masterRoot, PROMPTS_DIR);
            if (!dirs.includes(legacyMasterDir)) {
                dirs.push(legacyMasterDir);
            }
        }
        return dirs;
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
        const candidates = [
            path.join(this.extensionPath, BASE, PROMPTS_DIR, item.file),
            path.join(this.extensionPath, PROMPTS_DIR, item.file),
        ];
        return candidates.find(p => fs.existsSync(p)) || candidates[0];
    }

    private composeStagePrompt(
        step: string,
        userContent: string,
        context: { taskName: string; taskDesc: string; currentWorkSpace: string },
        config?: Partial<Config>
    ): string {
        const locked = this.renderSystemPrompt(step, context, config);
        if (!locked) {
            return userContent;
        }
        const constitutionSection = this.renderConstitutionSection(context.currentWorkSpace);
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
        return `${constitutionSection}${locked}\n\n${customSection}`;
    }

    /**
     * Build the highest-priority Constitution block prepended to every stage/dev prompt.
     * Precedence: only below the runtime instruction. Empty string when no constitution found.
     */
    private renderConstitutionSection(currentWorkSpace: string): string {
        const resolved = resolveConstitution(currentWorkSpace, this.workspaceRoot, this.extensionPath);
        if (!resolved.content.trim()) {
            return '';
        }
        const { body, version } = summarizeConstitution(resolved.content);
        const provenance = resolved.source === 'project'
            ? `项目宪法${version ? `（v${version}）` : ''}`
            : `内置默认宪法${version ? `（v${version}）` : ''}`;
        return [
            '# ⚖️ 工程宪法（最高治理层 · 优先级仅次于运行时指令）',
            `> 来源：${provenance} — 下述条款为硬约束，高于本系统提示词之外的一切内容；如与运行时指令冲突，以运行时为准。`,
            '',
            body,
            '',
            '---',
            '',
        ].join('\n');
    }

    private renderSystemPrompt(
        step: string,
        context: { taskName: string; taskDesc: string; currentWorkSpace: string },
        config?: Partial<Config>
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
        const specDocsDir = getSpecDocsDir(context.currentWorkSpace, config as Config | undefined);
        const docsRootDir = path.join(context.currentWorkSpace, getDocsRootDirName(config as Config | undefined));
        const vars: Record<string, string> = {
            taskName: context.taskName,
            taskDesc: context.taskDesc,
            currentWorkSpace: context.currentWorkSpace,
            requirementsPath: path.join(specDocsDir, 'requirements.md'),
            designPath: path.join(specDocsDir, 'design.md'),
            projectStructurePath: path.join(docsRootDir, 'project-structure.md'),
            testcasePath: path.join(specDocsDir, 'testcase.md'),
            tasksPath: path.join(specDocsDir, 'tasks.md'),
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
