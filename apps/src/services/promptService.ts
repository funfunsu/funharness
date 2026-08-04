import * as fs from 'fs';
import * as path from 'path';
import { BASE, Config, PROMPT_CONFIGS, PROMPTS_DIR, deriveMasterRoot, getDocsRootDirName, getPrimaryTrackedSpecsDir, getSpecDocsDir, getTrackedSpecsDirCandidates } from '../models';
import { resolveConstitution, summarizeConstitution } from '../constitution';
import { ReviewPromptSource, ReviewStage, StageContext, StageReviewPromptResult } from '../harnessMessages';
import type { ReviewPromptConfigService } from './reviewPromptConfigService';

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

    /** 项目级可选覆盖目录：优先写入可被 git 跟踪的 specs 目录。 */
    getProjectPromptsDir(): string {
        return getPrimaryTrackedSpecsDir(this.workspaceRoot);
    }

    /**
     * In a worktree window, user-customized prompts are maintained in git-tracked
     * specs directories (prefer repos/mono-main/specs), with legacy directories as fallback.
     */
    private getCandidatePromptDirs(): string[] {
        const dirs = [...getTrackedSpecsDirCandidates(this.workspaceRoot)];
        // Backward compatibility: old prompt directories.
        const legacyProjectHarnessDir = path.join(this.workspaceRoot, BASE, PROMPTS_DIR);
        if (!dirs.includes(legacyProjectHarnessDir)) {
            dirs.push(legacyProjectHarnessDir);
        }
        const legacyProjectDir = path.join(this.workspaceRoot, PROMPTS_DIR);
        if (!dirs.includes(legacyProjectDir)) {
            dirs.push(legacyProjectDir);
        }
        const masterRoot = deriveMasterRoot(this.workspaceRoot);
        const legacyMasterHarnessDir = path.join(masterRoot, BASE, PROMPTS_DIR);
        if (!dirs.includes(legacyMasterHarnessDir)) {
            dirs.push(legacyMasterHarnessDir);
        }
        const legacyMasterDir = path.join(masterRoot, PROMPTS_DIR);
        if (!dirs.includes(legacyMasterDir)) {
            dirs.push(legacyMasterDir);
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

    /**
     * Per-stage bundled fallback review prompt bodies (MODEL-2, Req-2, INV-5).
     * Used only when neither a file-based custom prompt nor a bundled system-prompt file is found.
     * Each stage uses a distinct template to ensure cross-stage prompts are never conflated.
     */
    private static readonly DEFAULT_REVIEW_PROMPTS: Record<ReviewStage, string> = {
        requirements: [
            '# 需求评审模板（通用默认）',
            '',
            '请对以下需求文档进行系统性评审，检查以下维度：',
            '1. **完整性**：每条需求是否有唯一 Req-* ID、用户故事与验收标准（GIVEN/WHEN/THEN）。',
            '2. **可测试性**：每条验收标准是否可独立验证，边界条件是否清晰。',
            '3. **一致性**：需求间是否存在冲突或重复；术语是否统一。',
            '4. **可追溯性**：需求是否可追溯到业务目标，没有无来源的能力扩展。',
            '',
            '请逐条列出发现的问题，并给出修订建议；若无问题请说明理由。',
        ].join('\n'),
        design: [
            '# 设计评审模板（通用默认）',
            '',
            '请对以下技术设计文档进行系统性评审，检查以下维度：',
            '1. **需求覆盖**：所有 Req-* 是否均有对应的 API/Model/不变量设计，无遗漏。',
            '2. **接口稳定性**：API 契约（路径、字段名、方法签名）是否明确且不与已有契约冲突。',
            '3. **正确性属性**：不变量（INV-*）是否充分、可验证，且与需求保持一致。',
            '4. **安全底线**：外部输入是否在边界校验；是否规避 OWASP Top 10 常见漏洞。',
            '5. **最小实现**：是否存在超出需求范围的过度设计或多余能力扩展。',
            '',
            '请逐条列出发现的问题，并给出修订建议；若无问题请说明理由。',
        ].join('\n'),
        testcase: [
            '# 测试用例评审模板（通用默认）',
            '',
            '请对以下测试用例文档进行系统性评审，检查以下维度：',
            '1. **覆盖率**：每条 Req-* 是否至少有一条对应测试用例；正常路径与异常路径均已覆盖。',
            '2. **格式规范**：每条用例是否遵循 GIVEN/WHEN/THEN 格式且步骤清晰。',
            '3. **可追溯性**：测试用例是否明确绑定 Req-* ID，无未绑定的游离用例。',
            '4. **可执行性**：测试步骤是否具体可操作，预期结果是否可客观判断。',
            '5. **独立性**：各测试用例之间是否存在不必要的依赖，能否独立运行。',
            '',
            '请逐条列出发现的问题，并给出修订建议；若无问题请说明理由。',
        ].join('\n'),
    };

    /** Map review stage to its bundled system-prompt filename in `apps/system-prompts/`. */
    private static readonly REVIEW_SYSTEM_PROMPT_FILES: Record<ReviewStage, string> = {
        requirements: 'review_requirements_system_prompt.md',
        design: 'review_design_system_prompt.md',
        testcase: 'review_testcase_system_prompt.md',
    };

    /** Map review stage to the user-customizable filename searched in candidate project dirs. */
    private static readonly REVIEW_CUSTOM_PROMPT_FILES: Record<ReviewStage, string> = {
        requirements: 'review_requirements_custom_prompt.md',
        design: 'review_design_custom_prompt.md',
        testcase: 'review_testcase_custom_prompt.md',
    };

    /**
     * Return the absolute path for the user-custom review prompt file of a given stage.
     * The file lives in the primary git-tracked specs dir (same convention as other custom prompts).
     */
    getReviewCustomPromptPath(stage: ReviewStage): string {
        const fileName = PromptService.REVIEW_CUSTOM_PROMPT_FILES[stage];
        return path.join(this.getProjectPromptsDir(), fileName);
    }

    /**
     * Resolve the review prompt for the given stage (API-2, Req-2, Req-3).
     *
     * Priority (highest to lowest):
     *   1. File-based custom prompt — `review_{stage}_custom_prompt.md` in project specs dirs.
     *   2. JSON-based custom prompt — from configService (legacy, backward-compatible).
     *   3. Bundled system-prompt file — `apps/system-prompts/review_{stage}_system_prompt.md`.
     *   4. Hardcoded fallback string (INV-5: each stage has a distinct non-empty template).
     *
     * The composed prompt always includes stage context snapshot + template body (INV-4).
     * When configService is not provided the method behaves as if no JSON custom prompt exists
     * and falls back to file/bundled/hardcoded defaults (INV-3).
     */
    resolveReviewPromptByStage(
        stage: ReviewStage,
        context: StageContext,
        configService?: ReviewPromptConfigService,
    ): StageReviewPromptResult {
        // 1. File-based custom prompt (highest priority).
        const customFileName = PromptService.REVIEW_CUSTOM_PROMPT_FILES[stage];
        let fileCustomPrompt: string | undefined;
        for (const dir of this.getCandidatePromptDirs()) {
            const candidate = path.join(dir, customFileName);
            if (fs.existsSync(candidate)) {
                const raw = fs.readFileSync(candidate, 'utf8').trim();
                if (raw.length > 0) {
                    fileCustomPrompt = raw;
                    break;
                }
            }
        }

        // 2. JSON-based custom prompt (legacy backward-compatible).
        const jsonCustomPrompt = configService?.getStagePrompt(stage);
        const hasJsonCustom = typeof jsonCustomPrompt === 'string' && jsonCustomPrompt.trim().length > 0;

        if (fileCustomPrompt) {
            const source: ReviewPromptSource = 'custom';
            const promptBody = fileCustomPrompt;
            const composedPrompt = this.buildReviewComposedPrompt(context, promptBody);
            return { source, promptBody, composedPrompt };
        }

        if (hasJsonCustom) {
            const source: ReviewPromptSource = 'custom';
            const promptBody = jsonCustomPrompt!;
            const composedPrompt = this.buildReviewComposedPrompt(context, promptBody);
            return { source, promptBody, composedPrompt };
        }

        // 3. Bundled system-prompt file.
        const systemFileName = PromptService.REVIEW_SYSTEM_PROMPT_FILES[stage];
        const bundledPath = path.join(this.extensionPath, this.systemPromptDir, systemFileName);
        let defaultPromptBody: string;
        if (fs.existsSync(bundledPath)) {
            defaultPromptBody = fs.readFileSync(bundledPath, 'utf8').trim();
        } else {
            // 4. Hardcoded fallback.
            defaultPromptBody = PromptService.DEFAULT_REVIEW_PROMPTS[stage];
        }

        const composedPrompt = this.buildReviewComposedPrompt(context, defaultPromptBody);
        return { source: 'default', promptBody: defaultPromptBody, composedPrompt };
    }

    /** Build the composed prompt string from context + template body (INV-4). */
    private buildReviewComposedPrompt(context: StageContext, promptBody: string): string {
        const contextLines = Object.entries(context)
            .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
            .join('\n');
        const contextSection = contextLines
            ? `## 当前阶段上下文\n${contextLines}`
            : '## 当前阶段上下文\n（无额外上下文）';
        return [contextSection, '', promptBody].join('\n');
    }
}
