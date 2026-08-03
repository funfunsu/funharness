import * as fs from 'fs';
import * as path from 'path';
import { BASE, PROMPTS_DIR } from '../models';

const DEFAULT_PROJECT_STRUCTURE = `# 前端目录（Vue3 + TypeScript + Pinia）
src/
├── api/            # API 接口定义层（只写 URL 和 method，每个业务模块一个文件）
├── mock/
│   ├── index.js        # 路由映射表 (mockDataMap)，所有 Mock 路由在此注册
│   ├── interceptor.js  # axios 拦截器（Mock 核心开关）
│   └── modules/        # Mock 数据实现，与 api/ 一一对应
├── stores/         # Pinia 状态层（可选，用于跨组件共享数据，内部仍调用 api/）
├── views/          # 页面
├── components/     # 公共组件（图表、顶栏、面板等）
├── router/
│   └── index.ts    # 路由配置（含权限守卫）
└── utils/
    └── request.ts  # axios 封装（含 Mock 拦截接入点）

# 后端目录（SpringBoot DDD 分层，包名以 [基础包名] 为前缀）
[基础包名]/
├── application/
│   ├── adapter/
│   │   ├── api/
│   │   ├── consumer/
│   │   └── scheduler/
│   ├── service/
│   │   ├── XxxAppService.java
│   │   └── process/
│   │       └── XxxProcess.java
│   ├── repository/
│   ├── dto/
│   ├── converter/
│   ├── external/
│   └── error/
├── domain/
│   └── [聚合根]/
│       ├── entity/
│       ├── event/
│       ├── repository/
│       ├── constants/
│       ├── enums/
│       ├── error/
│       └── properties/
├── infrastructure/
│   └── [聚合根]/
│       └── repository/
│           ├── dao/
│           ├── cache/
│           ├── storage/
│           ├── dataObject/
│           └── converter/
├── external/
│   └── [外部中心名称]/
│       ├── dto/
│       ├── converter/
│       ├── feign/
│       ├── error/
│       └── properties/
└── boot/
    └── XxxApplication.java
`;

type DetectedAppKind = 'vue3' | 'react' | 'java-ddd' | 'node' | 'vscode-extension' | 'ts-lib' | 'node-generic';

interface DetectedApp {
    root: string;
    kind: DetectedAppKind;
}

export interface StructureGateViolation {
    ruleId: string;
    location: string;
    message: string;
    suggestion: string;
}

export interface StructureGateResult {
    passed: boolean;
    gateStatus: 'passed' | 'failed';
    gateId: string;
    checkedAt: string;
    violations: StructureGateViolation[];
    requiredSections: string[];
    requiredFields: string[];
}

/** Error raised when structure quality gate fails before artifact write. */
export class StructureGateFailedError extends Error {
    readonly code = 'STRUCTURE_GATE_FAILED';

    constructor(public readonly gate: StructureGateResult) {
        super(`STRUCTURE_GATE_FAILED: gateId=${gate.gateId}; violations=${gate.violations.length}`);
        this.name = 'StructureGateFailedError';
    }
}

/** Contract for a sample profile used by sample-driven project-structure extraction. */
export interface ProjectStructureSampleProfile {
    id: string;
    name: string;
    schemaVersion: string;
    exemplarMarkdown: string;
    includePatterns: string[];
    excludePatterns: string[];
}

/** Resolved sample profile with provenance details for audit and diagnostics. */
export interface ProjectStructureSampleProfileLoadResult {
    profile: ProjectStructureSampleProfile;
    source: 'sample-file' | 'root-structure' | 'bundled-default';
    resolvedPath?: string;
}

/** Error raised when a required sample profile file is missing or unreadable. */
export class SampleProfileUnavailableError extends Error {
    readonly code = 'SAMPLE_PROFILE_UNAVAILABLE';
    readonly sampleProfileId: string;
    readonly attemptedPaths: string[];

    constructor(sampleProfileId: string, attemptedPaths: string[], reason: string) {
        super(`SAMPLE_PROFILE_UNAVAILABLE: ${reason}`);
        this.name = 'SampleProfileUnavailableError';
        this.sampleProfileId = sampleProfileId;
        this.attemptedPaths = attemptedPaths;
    }
}

/** Error raised when granularity rule set is contradictory or invalid. */
export class GranularityRuleConflictError extends Error {
    readonly code = 'GRANULARITY_RULE_CONFLICT';
    readonly profileId: string;

    constructor(profileId: string, reason: string) {
        super(`GRANULARITY_RULE_CONFLICT: ${reason}`);
        this.name = 'GranularityRuleConflictError';
        this.profileId = profileId;
    }
}

/** Input payload aligned with design API-1 contract for extraction requests. */
export interface ProjectStructureExtractionInput {
    workspaceRoot: string;
    sampleProfileId: string;
    granularityProfileId: string;
    extractionMode: 'sampleDriven' | 'legacy';
    sampleProfile: ProjectStructureSampleProfile;
    granularityRuleSet: ProjectStructureGranularityRuleSet;
}

/** Rule set aligned with design Model-2 for extraction granularity control. */
export interface ProjectStructureGranularityRuleSet {
    id: string;
    maxDepth: number;
    mustExpandDomains: string[];
    collapsePatterns: string[];
    dedupeStrategy: 'byPath' | 'bySemantic';
}

export interface ProjectStructureExtractionBuildOptions {
    requireSampleFile?: boolean;
}

/** Source-code file extensions worth surfacing in a concise structure tree. */
const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|vue|java|kt|py|go|rs)$/i;
/** Max notable files listed per directory before collapsing into a summary line. */
const NOTABLE_FILE_LIMIT = 12;

export class ProjectStructureService {
    private monorepoMainDir: string | undefined;
    private monorepoFrontendDir: string | undefined;
    private monorepoBackendDir: string | undefined;
    private monorepoMode = false;
    private activeGranularityRuleSet: ProjectStructureGranularityRuleSet | undefined;
    private lastStructureGateResult: StructureGateResult | undefined;

    constructor(
        private readonly workspaceRoot: string,
        private readonly extensionPath: string,
    ) {}

    /**
     * In monorepo mode, set to repos/mono-main so that project-structure.md
     * lives inside the git-managed worktree rather than the untracked workspace docs/.
     */
    setMonorepoMainDir(dir: string | undefined): void {
        this.monorepoMainDir = dir;
    }

    /**
     * Whether the harness operates in monorepo (single-repo) mode. Only in this
     * mode does detection treat the configured dir as an apps container that may
     * hold multiple sub-applications. Multi-repo mode keeps the frontend/backend
     * split intact.
     */
    setMonorepoMode(isMono: boolean): void {
        this.monorepoMode = isMono;
    }

    /**
     * Configure the frontend/backend subdirectories (from `monorepoDirs`) so that
     * detection scans exactly the folders the user declared instead of only the
     * hardcoded conventional candidates. Empty/undefined values are ignored.
     */
    setMonorepoDirs(dirs: { frontend?: string; backend?: string } | undefined): void {
        this.monorepoFrontendDir = (dirs?.frontend || '').trim() || undefined;
        this.monorepoBackendDir = (dirs?.backend || '').trim() || undefined;
    }

    private getStructureRoot(): string {
        return this.monorepoMainDir || this.workspaceRoot;
    }

    /**
     * Base roots to resolve monorepo subdirectories against, most-specific first.
     * In monorepo mode the real clone usually lives at repos/mono-main, but the
     * current worktree checkout itself may also hold the code, so include both.
     */
    private getDetectionBaseRoots(): string[] {
        const roots: string[] = [];
        if (this.monorepoMainDir) {
            roots.push(this.monorepoMainDir);
        }
        roots.push(this.workspaceRoot);
        return Array.from(new Set(roots));
    }

    /** Candidate frontend roots derived from the configured monorepoDirs.frontend. */
    private getConfiguredFrontendCandidates(): string[] {
        if (!this.monorepoFrontendDir) {
            return [];
        }
        return this.getDetectionBaseRoots().map(base => path.join(base, this.monorepoFrontendDir as string));
    }

    /** Candidate backend roots derived from the configured monorepoDirs.backend. */
    private getConfiguredBackendCandidates(): string[] {
        if (!this.monorepoBackendDir) {
            return [];
        }
        return this.getDetectionBaseRoots().map(base => path.join(base, this.monorepoBackendDir as string));
    }

    getRootStructureFilePath(): string {
        return path.join(this.getStructureRoot(), 'docs', 'project-structure.md');
    }

    getIterationStructureFilePath(iterDir: string): string {
        return path.join(iterDir, 'docs', 'project-structure.md');
    }

    getPreviewStructureFilePath(): string {
        return path.join(this.getStructureRoot(), 'docs', 'project-structure.preview.md');
    }

    private getLegacyRootStructureFilePath(): string {
        return path.join(this.workspaceRoot, BASE, 'project-structure.md');
    }

    /**
     * Ensure the root project-structure.md baseline exists and report which source produced it.
     * The returned `source` is a single, mutually-exclusive origin of the final document:
     *   - 'existing' : an existing non-empty root document was kept
     *   - 'detected' : content derived from the real workspace directory scan
     *   - 'default'  : fell back to the built-in default template
     * (The 'detected' branch wiring is implemented in a later task; this signature declares the contract.)
     */
    ensureBaseline(): { source: 'existing' | 'detected' | 'default'; filePath: string } {
        const existing = this.readRootStructure();
        if (existing) {
            if (!fs.existsSync(this.getRootStructureFilePath())) {
                this.writeRootStructure(existing);
            }
            return { source: 'existing', filePath: this.getRootStructureFilePath() };
        }

        return { source: 'default', filePath: this.getRootStructureFilePath() };
    }

    readRootStructure(): string {
        const filePath = this.getRootStructureFilePath();
        if (fs.existsSync(filePath)) {
            try {
                return fs.readFileSync(filePath, 'utf8').trim();
            } catch {
                return '';
            }
        }

        const legacyPath = this.getLegacyRootStructureFilePath();
        if (!fs.existsSync(legacyPath)) {
            return '';
        }
        try {
            return fs.readFileSync(legacyPath, 'utf8').trim();
        } catch {
            return '';
        }
    }

    writeRootStructure(content: string): void {
        const filePath = this.getRootStructureFilePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
    }

    writePreviewStructure(content: string): string {
        const filePath = this.getPreviewStructureFilePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
        return filePath;
    }

    applyPreviewToRoot(): boolean {
        const previewPath = this.getPreviewStructureFilePath();
        if (!fs.existsSync(previewPath)) {
            return false;
        }
        try {
            const content = fs.readFileSync(previewPath, 'utf8').trim();
            if (!content) {
                return false;
            }
            const gate = this.validateStructureQuality(content, {
                requiredSections: ['项目结构树', '关键模块说明'],
                requiredFields: ['title', 'sections', 'domainNodes'],
            });
            this.lastStructureGateResult = gate;
            this.appendStructureGateLog(gate, previewPath);
            if (!gate.passed) {
                return false;
            }
            this.writeRootStructure(content);
            return true;
        } catch {
            return false;
        }
    }

    /** Return the latest structure-quality gate decision for UI/log consumers. */
    getLastStructureGateResult(): StructureGateResult | undefined {
        return this.lastStructureGateResult;
    }

    /**
     * Validate structure artifact against requiredSections/requiredFields and derive gateStatus.
     * Missing requirements produce failed gate with structured violations.
     */
    validateStructureQuality(
        structureContent: string,
        contract: { requiredSections: string[]; requiredFields: string[] },
    ): StructureGateResult {
        const checkedAt = new Date().toISOString();
        const gateId = `structure-gate-${Date.now()}`;
        const violations: StructureGateViolation[] = [];
        const normalizedContent = structureContent || '';
        const lines = normalizedContent.split(/\r?\n/);

        const inferredTitle = this.extractStructureTitle(lines);
        const inferredSections = this.extractStructureSections(lines);
        const inferredDomainNodes = this.extractStructureDomainNodes(lines);

        for (const sectionName of contract.requiredSections) {
            if (!this.hasRequiredSection(sectionName, lines)) {
                violations.push({
                    ruleId: 'SG-REQ-SECTION',
                    location: 'structureContent',
                    message: `缺失必填段落：${sectionName}`,
                    suggestion: `补充段落或等价信息以满足 requiredSections(${sectionName})`,
                });
            }
        }

        for (const fieldName of contract.requiredFields) {
            if (!this.hasRequiredField(fieldName, {
                title: inferredTitle,
                sections: inferredSections,
                domainNodes: inferredDomainNodes,
            })) {
                violations.push({
                    ruleId: 'SG-REQ-FIELD',
                    location: fieldName,
                    message: `缺失必填结构字段：${fieldName}`,
                    suggestion: `补全字段 ${fieldName} 对应的可解析信息`,
                });
            }
        }

        return {
            passed: violations.length === 0,
            gateStatus: violations.length === 0 ? 'passed' : 'failed',
            gateId,
            checkedAt,
            violations,
            requiredSections: [...contract.requiredSections],
            requiredFields: [...contract.requiredFields],
        };
    }

    /** Persist gate decision for traceability and later troubleshooting. */
    private appendStructureGateLog(gate: StructureGateResult, sourcePath: string): void {
        try {
            const logPath = path.join(this.getStructureRoot(), BASE, 'project-structure-gate.log');
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            const payload = {
                at: gate.checkedAt,
                gateId: gate.gateId,
                gateStatus: gate.gateStatus,
                passed: gate.passed,
                sourcePath,
                violations: gate.violations,
                requiredSections: gate.requiredSections,
                requiredFields: gate.requiredFields,
            };
            fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
        } catch {
            // Best-effort logging only; gate decision itself remains authoritative.
        }
    }

    /** Extract title from first markdown heading or first non-empty line. */
    private extractStructureTitle(lines: string[]): string {
        for (const line of lines) {
            const heading = line.match(/^\s*#\s+(.+)\s*$/);
            if (heading) {
                return heading[1].trim();
            }
        }
        const firstText = lines.find(line => line.trim().length > 0);
        return firstText ? firstText.trim() : '';
    }

    /** Extract second-level sections, with fallback to major tree root entries. */
    private extractStructureSections(lines: string[]): string[] {
        const sections = lines
            .map(line => line.match(/^\s*##\s+(.+)\s*$/))
            .filter((v): v is RegExpMatchArray => Boolean(v))
            .map(match => match[1].trim())
            .filter(Boolean);
        if (sections.length > 0) {
            return sections;
        }
        const fallback = lines
            .map(line => line.match(/^\s*([\w\-.\[\]\/]+)\/?\s*(#.*)?$/))
            .filter((v): v is RegExpMatchArray => Boolean(v))
            .map(match => match[1].trim())
            .filter(v => v.length > 0 && !v.startsWith('#'));
        return Array.from(new Set(fallback)).slice(0, 8);
    }

    /** Extract domain node signals from tree lines and annotated node lines. */
    private extractStructureDomainNodes(lines: string[]): string[] {
        const nodes = lines
            .map(line => line.match(/(?:├──|└──)\s*([^#\n]+)/))
            .filter((v): v is RegExpMatchArray => Boolean(v))
            .map(match => match[1].trim())
            .filter(Boolean);
        if (nodes.length > 0) {
            return nodes;
        }
        const annotated = lines
            .filter(line => /#\s*说明/.test(line) || /#\s*/.test(line))
            .map(line => line.replace(/#.*$/, '').trim())
            .filter(Boolean);
        return Array.from(new Set(annotated)).slice(0, 32);
    }

    /** Section-level matching with semantic fallbacks for current structure markdown style. */
    private hasRequiredSection(sectionName: string, lines: string[]): boolean {
        const normalized = sectionName.trim();
        if (!normalized) {
            return true;
        }
        const fullText = lines.join('\n');
        if (fullText.includes(normalized)) {
            return true;
        }
        if (normalized === '项目结构树') {
            return lines.some(line => /(?:├──|└──)/.test(line) || /\bsrc\/?\s*$/.test(line));
        }
        if (normalized === '关键模块说明') {
            return lines.some(line => /#\s*说明/.test(line) || /#\s+.+/.test(line));
        }
        return false;
    }

    /** Required-field matching for inferred structure artifact fields. */
    private hasRequiredField(
        fieldName: string,
        inferred: { title: string; sections: string[]; domainNodes: string[] },
    ): boolean {
        switch (fieldName) {
            case 'title':
                return inferred.title.trim().length > 0;
            case 'sections':
                return inferred.sections.length > 0;
            case 'domainNodes':
                return inferred.domainNodes.length > 0;
            default:
                return true;
        }
    }

    copyRootStructureToIteration(iterDir: string): void {
        const rootContent = this.readRootStructure();
        if (!rootContent) {
            return;
        }
        const targetPath = this.getIterationStructureFilePath(iterDir);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, `${rootContent}\n`, 'utf8');
    }

    /**
     * Build extraction input payload with a loaded sample profile.
     * This is the canonical loading entry for sample-driven extraction.
     */
    buildExtractionInput(
        sampleProfileId: string,
        granularityProfileId: string,
        extractionMode: 'sampleDriven' | 'legacy' = 'sampleDriven',
        options?: ProjectStructureExtractionBuildOptions,
    ): ProjectStructureExtractionInput {
        const requireSampleFile = options?.requireSampleFile === true || extractionMode === 'sampleDriven';
        const loaded = requireSampleFile
            ? this.loadSampleProfileRequired(sampleProfileId)
            : this.loadSampleProfile(sampleProfileId);
        const granularityRuleSet = this.loadGranularityRuleSet(granularityProfileId);
        return {
            workspaceRoot: this.workspaceRoot,
            sampleProfileId: loaded.profile.id,
            granularityProfileId: granularityRuleSet.id,
            extractionMode,
            sampleProfile: loaded.profile,
            granularityRuleSet,
        };
    }

    /**
     * Resolve granularity rules from an optional profile file, with deterministic
     * built-in fallbacks for extraction flow stability.
     */
    loadGranularityRuleSet(granularityProfileId: string): ProjectStructureGranularityRuleSet {
        const normalizedId = this.normalizeGranularityProfileId(granularityProfileId);
        const profilePath = this.resolveGranularityProfileFilePath(normalizedId);
        let resolved: ProjectStructureGranularityRuleSet;
        if (profilePath) {
            const parsed = this.readGranularityRuleSetFile(profilePath, normalizedId);
            if (parsed) {
                resolved = parsed;
                this.validateGranularityRuleSet(resolved);
                this.activeGranularityRuleSet = resolved;
                return resolved;
            }
        }
        resolved = this.getBuiltInGranularityRuleSet(normalizedId);
        this.validateGranularityRuleSet(resolved);
        this.activeGranularityRuleSet = resolved;
        return resolved;
    }

    /** Resolve the in-use rule set for directory rendering with default fallback. */
    private getActiveGranularityRuleSet(): ProjectStructureGranularityRuleSet {
        if (this.activeGranularityRuleSet) {
            return this.activeGranularityRuleSet;
        }
        const fallback = this.getBuiltInGranularityRuleSet('default');
        this.activeGranularityRuleSet = fallback;
        return fallback;
    }

    /**
     * Strict sample loader: requires profile markdown file existence and readability.
     * Throws SampleProfileUnavailableError when file is absent/invalid.
     */
    loadSampleProfileRequired(sampleProfileId: string): ProjectStructureSampleProfileLoadResult {
        const normalizedId = this.normalizeSampleProfileId(sampleProfileId);
        const fileCandidates = this.getSampleProfileDirectoryCandidates()
            .map(dir => path.join(dir, `${normalizedId}.md`));
        const sampleFile = fileCandidates.find(candidate => fs.existsSync(candidate));
        if (!sampleFile) {
            throw new SampleProfileUnavailableError(
                normalizedId,
                fileCandidates,
                `样例文件不存在，期望文件名 ${normalizedId}.md`,
            );
        }

        const exemplarMarkdown = this.readTrimmedFile(sampleFile);
        if (!exemplarMarkdown) {
            throw new SampleProfileUnavailableError(
                normalizedId,
                [sampleFile],
                '样例文件不可读或内容为空',
            );
        }

        const meta = this.readSampleProfileMeta(sampleFile, normalizedId);
        return {
            source: 'sample-file',
            resolvedPath: sampleFile,
            profile: {
                id: normalizedId,
                name: meta.name,
                schemaVersion: meta.schemaVersion,
                exemplarMarkdown,
                includePatterns: meta.includePatterns,
                excludePatterns: meta.excludePatterns,
            },
        };
    }

    /**
     * Load a sample profile by id from workspace files with deterministic fallbacks.
     * Priority: sample file -> root project-structure -> bundled default template.
     */
    loadSampleProfile(sampleProfileId: string): ProjectStructureSampleProfileLoadResult {
        const normalizedId = this.normalizeSampleProfileId(sampleProfileId);
        const sampleFile = this.resolveSampleProfileFilePath(normalizedId);
        if (sampleFile) {
            const exemplarMarkdown = this.readTrimmedFile(sampleFile);
            if (exemplarMarkdown) {
                const meta = this.readSampleProfileMeta(sampleFile, normalizedId);
                return {
                    source: 'sample-file',
                    resolvedPath: sampleFile,
                    profile: {
                        id: normalizedId,
                        name: meta.name,
                        schemaVersion: meta.schemaVersion,
                        exemplarMarkdown,
                        includePatterns: meta.includePatterns,
                        excludePatterns: meta.excludePatterns,
                    },
                };
            }
        }

        const rootContent = this.readRootStructure();
        if (rootContent) {
            return {
                source: 'root-structure',
                resolvedPath: this.getRootStructureFilePath(),
                profile: {
                    id: normalizedId,
                    name: 'Root Project Structure Baseline',
                    schemaVersion: '1.0',
                    exemplarMarkdown: rootContent,
                    includePatterns: ['**/*'],
                    excludePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'],
                },
            };
        }

        return {
            source: 'bundled-default',
            profile: {
                id: normalizedId,
                name: 'Bundled Default Project Structure',
                schemaVersion: '1.0',
                exemplarMarkdown: this.getDefaultStructure(),
                includePatterns: ['**/*'],
                excludePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'],
            },
        };
    }

    detectStructureFromWorkspace(): { content: string; detected: boolean; summary: string } {
        // Monorepo mode: the configured dir is an apps container that may hold one
        // or many sub-applications (frontend/backend/TS lib/VS Code extension).
        if (this.monorepoMode) {
            const apps = this.detectAppsFromContainers();
            if (apps.length > 0) {
                const sections = apps.map(app => {
                    const rel = this.toWorkspaceRelative(app.root);
                    return `## 应用 ${rel}（${this.appKindLabel(app.kind)}）\n\n${this.buildAppSection(app)}`;
                });
                const summary = apps
                    .map(app => `${path.basename(app.root)}: ${this.appKindLabel(app.kind)}`)
                    .join(' | ');
                return { content: sections.join('\n\n'), detected: true, summary };
            }
        }

        // Multi-repo mode (and monorepo fallback): keep the frontend/backend split.
        const frontend = this.findFrontendProject();
        const backend = this.findBackendProject();

        if (!frontend && !backend) {
            return {
                content: this.getDefaultStructure(),
                detected: false,
                summary: '未检测到前后端项目，已回退默认结构',
            };
        }

        const sections: string[] = [];
        const summaryParts: string[] = [];

        if (frontend) {
            sections.push(this.buildFrontendConciseTree(frontend));
            summaryParts.push(`前端: ${frontend.kind === 'vue3' ? 'Vue3' : 'React'}`);
        }

        if (backend) {
            sections.push(this.buildBackendConciseTree(backend));
            summaryParts.push(`后端: ${backend.kind === 'java-ddd' ? 'Java' : 'Node.js'}`);
        }

        return {
            content: sections.join('\n\n'),
            detected: true,
            summary: summaryParts.join(' | '),
        };
    }

    /** Normalize user-provided sample profile ids to a safe file-compatible token. */
    private normalizeSampleProfileId(sampleProfileId: string): string {
        const raw = (sampleProfileId || '').trim();
        if (!raw) {
            return 'default';
        }
        return raw.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
    }

    /** Normalize granularity profile ids to a safe token used by mapping lookup. */
    private normalizeGranularityProfileId(granularityProfileId: string): string {
        const raw = (granularityProfileId || '').trim();
        if (!raw) {
            return 'default';
        }
        return raw.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
    }

    /** Resolve sample profile markdown path from supported sample directories. */
    private resolveSampleProfileFilePath(sampleProfileId: string): string | undefined {
        const candidates = this.getSampleProfileDirectoryCandidates()
            .map(dir => path.join(dir, `${sampleProfileId}.md`));
        return candidates.find(candidate => fs.existsSync(candidate));
    }

    /**
     * Supported sample-profile folders under current repo/worktree.
     * Keep repo-root-relative to satisfy monorepo and multi-repo topologies.
     */
    private getSampleProfileDirectoryCandidates(): string[] {
        const roots = [this.workspaceRoot];
        if (this.monorepoMainDir) {
            roots.unshift(this.monorepoMainDir);
        }
        const dirs = roots.flatMap(root => [
            path.join(root, 'docs', 'project-structure', 'samples'),
            path.join(root, BASE, 'project-structure', 'samples'),
        ]);
        return Array.from(new Set(dirs));
    }

    /** Candidate granularity profile files under workspace-level docs and .harness dirs. */
    private getGranularityProfileDirectoryCandidates(): string[] {
        const roots = [this.workspaceRoot];
        if (this.monorepoMainDir) {
            roots.unshift(this.monorepoMainDir);
        }
        const dirs = roots.flatMap(root => [
            path.join(root, 'docs', 'project-structure', 'granularity-profiles'),
            path.join(root, BASE, 'project-structure', 'granularity-profiles'),
        ]);
        return Array.from(new Set(dirs));
    }

    /** Resolve granularity profile JSON path from supported profile directories. */
    private resolveGranularityProfileFilePath(granularityProfileId: string): string | undefined {
        const candidates = this.getGranularityProfileDirectoryCandidates()
            .map(dir => path.join(dir, `${granularityProfileId}.json`));
        return candidates.find(candidate => fs.existsSync(candidate));
    }

    /** Read granularity profile JSON and normalize to a strict Model-2 ruleset. */
    private readGranularityRuleSetFile(filePath: string, granularityProfileId: string): ProjectStructureGranularityRuleSet | undefined {
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProjectStructureGranularityRuleSet>;
            const maxDepth = Number(raw.maxDepth);
            const mustExpandDomains = Array.isArray(raw.mustExpandDomains)
                ? raw.mustExpandDomains.map(v => String(v).trim()).filter(Boolean)
                : [];
            const collapsePatterns = Array.isArray(raw.collapsePatterns)
                ? raw.collapsePatterns.map(v => String(v).trim()).filter(Boolean)
                : [];
            const dedupeStrategy = raw.dedupeStrategy === 'bySemantic' ? 'bySemantic' : 'byPath';
            return {
                id: String(raw.id || granularityProfileId).trim() || granularityProfileId,
                maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? Math.floor(maxDepth) : 4,
                mustExpandDomains,
                collapsePatterns,
                dedupeStrategy,
            };
        } catch {
            return undefined;
        }
    }

    /** Built-in granularity presets used when no external profile file is present. */
    private getBuiltInGranularityRuleSet(granularityProfileId: string): ProjectStructureGranularityRuleSet {
        const presets: Record<string, ProjectStructureGranularityRuleSet> = {
            default: {
                id: 'default',
                maxDepth: 4,
                mustExpandDomains: ['src', 'domain', 'application', 'infrastructure'],
                collapsePatterns: ['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.vscode'],
                dedupeStrategy: 'byPath',
            },
            concise: {
                id: 'concise',
                maxDepth: 3,
                mustExpandDomains: ['src', 'domain'],
                collapsePatterns: ['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.vscode', '__tests__'],
                dedupeStrategy: 'byPath',
            },
            detailed: {
                id: 'detailed',
                maxDepth: 6,
                mustExpandDomains: ['src', 'domain', 'application', 'infrastructure', 'services'],
                collapsePatterns: ['node_modules', '.git'],
                dedupeStrategy: 'bySemantic',
            },
        };
        return presets[granularityProfileId] || {
            ...presets.default,
            id: granularityProfileId,
        };
    }

    /** Read an optional JSON sidecar metadata file next to a sample markdown file. */
    private readSampleProfileMeta(sampleFilePath: string, sampleProfileId: string): {
        name: string;
        schemaVersion: string;
        includePatterns: string[];
        excludePatterns: string[];
    } {
        const metaPath = sampleFilePath.replace(/\.md$/i, '.json');
        if (!fs.existsSync(metaPath)) {
            return {
                name: `Sample Profile ${sampleProfileId}`,
                schemaVersion: '1.0',
                includePatterns: ['**/*'],
                excludePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'],
            };
        }
        try {
            const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<ProjectStructureSampleProfile>;
            const includePatterns = Array.isArray(raw.includePatterns)
                ? raw.includePatterns.map(v => String(v).trim()).filter(Boolean)
                : ['**/*'];
            const excludePatterns = Array.isArray(raw.excludePatterns)
                ? raw.excludePatterns.map(v => String(v).trim()).filter(Boolean)
                : ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'];
            return {
                name: String(raw.name || `Sample Profile ${sampleProfileId}`).trim(),
                schemaVersion: String(raw.schemaVersion || '1.0').trim(),
                includePatterns,
                excludePatterns,
            };
        } catch {
            return {
                name: `Sample Profile ${sampleProfileId}`,
                schemaVersion: '1.0',
                includePatterns: ['**/*'],
                excludePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'],
            };
        }
    }

    /** Read a file and return trimmed content; returns empty string on any error. */
    private readTrimmedFile(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf8').trim();
        } catch {
            return '';
        }
    }

    // ── Monorepo apps-container detection ──────────────────────────────

    /**
     * Existing container directories to scan for sub-applications. In monorepo
     * mode this is driven by the configured monorepoDirs (frontend/backend), plus
     * the conventional `apps` folder as a fallback.
     */
    private getAppContainerRoots(): string[] {
        const roots = [
            ...this.getConfiguredFrontendCandidates(),
            ...this.getConfiguredBackendCandidates(),
            ...this.getDetectionBaseRoots().map(base => path.join(base, 'apps')),
        ];
        return Array.from(new Set(roots)).filter(root => fs.existsSync(root));
    }

    /**
     * Enumerate applications inside the configured container(s). If a container
     * holds recognizable app sub-directories, each becomes an app; otherwise the
     * container itself is treated as a single application.
     */
    private detectAppsFromContainers(): DetectedApp[] {
        const apps: DetectedApp[] = [];
        const seen = new Set<string>();

        const addApp = (root: string): void => {
            const key = path.resolve(root);
            if (seen.has(key)) {
                return;
            }
            const kind = this.classifyApp(root);
            if (!kind) {
                return;
            }
            seen.add(key);
            apps.push({ root, kind });
        };

        for (const container of this.getAppContainerRoots()) {
            const childApps = this.listRealSubDirs(container, 40)
                .map(name => path.join(container, name))
                .filter(childRoot => this.isAppRoot(childRoot) && this.classifyApp(childRoot));

            if (childApps.length > 0) {
                childApps.forEach(addApp);
            } else if (this.isAppRoot(container)) {
                addApp(container);
            }
        }

        return apps;
    }

    /** A directory looks like an application root when it carries a build manifest. */
    private isAppRoot(root: string): boolean {
        return fs.existsSync(path.join(root, 'package.json'))
            || fs.existsSync(path.join(root, 'pom.xml'))
            || fs.existsSync(path.join(root, 'build.gradle'))
            || fs.existsSync(path.join(root, 'build.gradle.kts'));
    }

    /** Classify a single application root into a supported kind, or null. */
    private classifyApp(root: string): DetectedAppKind | null {
        const pkg = path.join(root, 'package.json');
        const srcDir = path.join(root, 'src');

        if (fs.existsSync(pkg)) {
            if (this.containsVueFile(srcDir, 3)) {
                return 'vue3';
            }
            if (this.containsReactDependency(pkg) || this.containsReactFile(srcDir, 3)) {
                return 'react';
            }
        }

        if (this.isJavaBackendProject(root)) {
            return 'java-ddd';
        }

        if (fs.existsSync(pkg)) {
            if (this.containsNodeServerHints(pkg)) {
                return 'node';
            }
            if (this.isVscodeExtension(pkg)) {
                return 'vscode-extension';
            }
            if (this.isTsLibrary(root, pkg)) {
                return 'ts-lib';
            }
            return 'node-generic';
        }

        return null;
    }

    private isVscodeExtension(pkgPath: string): boolean {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                engines?: Record<string, string>;
                contributes?: unknown;
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            return Boolean(pkg.engines?.vscode || pkg.contributes || deps['@types/vscode']);
        } catch {
            return false;
        }
    }

    private isTsLibrary(root: string, pkgPath: string): boolean {
        const hasTsconfig = fs.existsSync(path.join(root, 'tsconfig.json'));
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                types?: string;
                typings?: string;
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            return hasTsconfig || Boolean(deps.typescript || pkg.types || pkg.typings);
        } catch {
            return hasTsconfig;
        }
    }

    private listRealSubDirs(dir: string, max: number): string[] {
        if (!fs.existsSync(dir)) {
            return [];
        }
        try {
            const raw = fs.readdirSync(dir, { withFileTypes: true })
                .filter((entry: fs.Dirent) => entry.isDirectory())
                .map((entry: fs.Dirent) => entry.name)
                .filter(name => !name.startsWith('.'))
                .sort();
            return this.applyGranularityDirectoryMapping(raw, max, true);
        } catch {
            return [];
        }
    }

    private appKindLabel(kind: DetectedAppKind): string {
        switch (kind) {
            case 'vue3': return '前端 Vue3';
            case 'react': return '前端 React';
            case 'java-ddd': return '后端 Java';
            case 'node': return '后端 Node.js';
            case 'vscode-extension': return 'VS Code 扩展';
            case 'ts-lib': return 'TypeScript 库';
            default: return 'Node.js 应用';
        }
    }

    private buildAppSection(app: DetectedApp): string {
        switch (app.kind) {
            case 'vue3':
            case 'react':
                return this.buildFrontendConciseTree({ root: app.root, kind: app.kind });
            case 'java-ddd':
                return this.buildBackendConciseTree({ root: app.root, kind: 'java-ddd' });
            case 'node':
                return this.buildBackendConciseTree({ root: app.root, kind: 'node' });
            case 'vscode-extension':
                return this.buildGenericTsTree(app.root, 'VS Code 扩展（TypeScript）');
            case 'ts-lib':
                return this.buildGenericTsTree(app.root, 'TypeScript 库');
            default:
                return this.buildGenericTsTree(app.root, 'Node.js / TypeScript 应用');
        }
    }

    private buildGenericTsTree(root: string, label: string): string {
        const relRoot = this.toWorkspaceRelative(root);
        const lines: string[] = [`# ${label}`, `${relRoot}/`];

        // Top level: list directories (structure skeleton) plus notable root files.
        const topDirs = this.listRealSubDirs(root, 20);
        const rootFiles = this.listNotableFiles(root);
        const entries: Array<{ name: string; kind: 'dir' | 'file' | 'more' }> = [
            ...topDirs.map(name => ({ name, kind: 'dir' as const })),
            ...this.collapseFiles(rootFiles),
        ];

        if (entries.length === 0) {
            lines.push('└── (源码文件位于此目录)');
            return lines.join('\n');
        }

        entries.forEach((entry, i) => {
            const isLast = i === entries.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const childIndent = isLast ? '    ' : '│   ';
            if (entry.kind === 'dir') {
                const role = this.inferGenericTsDirRoleBrief(entry.name);
                const padding = ' '.repeat(Math.max(1, 16 - entry.name.length));
                lines.push(role
                    ? `${prefix} ${entry.name}/${padding}# ${role}`
                    : `${prefix} ${entry.name}/`);
                // Expand src/ one level so its dirs AND source files are visible.
                if (entry.name === 'src') {
                    this.appendGenericDirContents(lines, path.join(root, 'src'), childIndent);
                }
            } else {
                lines.push(`${prefix} ${entry.name}`);
            }
        });
        return lines.join('\n');
    }

    /**
     * Append a directory's contents (sub-directories first, then notable source
     * files) to the tree. Files are collapsed into a summary line once they
     * exceed NOTABLE_FILE_LIMIT so structure is complete without drowning in leaves.
     */
    private appendGenericDirContents(lines: string[], dir: string, indent: string): void {
        const dirs = this.listRealSubDirs(dir, 20);
        const files = this.listNotableFiles(dir);
        const entries: Array<{ name: string; kind: 'dir' | 'file' | 'more' }> = [
            ...dirs.map(name => ({ name, kind: 'dir' as const })),
            ...this.collapseFiles(files),
        ];

        entries.forEach((entry, i) => {
            const isLast = i === entries.length - 1;
            const prefix = isLast ? '└──' : '├──';
            if (entry.kind === 'dir') {
                const role = this.inferGenericTsDirRoleBrief(entry.name);
                const padding = ' '.repeat(Math.max(1, 16 - entry.name.length));
                lines.push(role
                    ? `${indent}${prefix} ${entry.name}/${padding}# ${role}`
                    : `${indent}${prefix} ${entry.name}/`);
            } else {
                lines.push(`${indent}${prefix} ${entry.name}`);
            }
        });
    }

    /** List source files in a directory, entry points first, tests/declarations excluded. */
    private listNotableFiles(dir: string): string[] {
        if (!fs.existsSync(dir)) {
            return [];
        }
        let files: string[];
        try {
            files = fs.readdirSync(dir, { withFileTypes: true })
                .filter((entry: fs.Dirent) => entry.isFile())
                .map((entry: fs.Dirent) => entry.name)
                .filter(name => SOURCE_FILE_PATTERN.test(name)
                    && !/\.d\.ts$/i.test(name)
                    && !/\.(test|spec)\.[jt]sx?$/i.test(name));
        } catch {
            return [];
        }
        const entryRank = (name: string): number =>
            /^(index|main|extension|app|server|bootstrap)\./i.test(name) ? 0 : 1;
        files.sort((a, b) => entryRank(a) - entryRank(b) || a.localeCompare(b));
        return files;
    }

    /**
     * Turn a file list into renderable entries: list up to NOTABLE_FILE_LIMIT files
     * verbatim, then a single summary entry when there are more.
     */
    private collapseFiles(files: string[]): Array<{ name: string; kind: 'file' | 'more' }> {
        if (files.length <= NOTABLE_FILE_LIMIT) {
            return files.map(name => ({ name, kind: 'file' as const }));
        }
        const shown: Array<{ name: string; kind: 'file' | 'more' }> =
            files.slice(0, NOTABLE_FILE_LIMIT).map(name => ({ name, kind: 'file' as const }));
        shown.push({ name: `…（共 ${files.length} 个源码文件）`, kind: 'more' as const });
        return shown;
    }

    private inferGenericTsDirRoleBrief(name: string): string {
        const n = name.toLowerCase();
        const map: Record<string, string> = {
            src: '源码',
            services: '业务服务',
            service: '业务服务',
            commands: '命令处理',
            providers: '视图/功能提供者',
            provider: '视图/功能提供者',
            webview: 'Webview 界面',
            views: '视图',
            view: '视图',
            components: '组件',
            models: '数据模型',
            model: '数据模型',
            types: '类型定义',
            type: '类型定义',
            utils: '通用工具',
            util: '工具函数',
            helpers: '工具函数',
            lib: '库代码',
            core: '核心逻辑',
            api: 'API 层',
            config: '配置',
            constants: '常量与枚举',
            test: '测试',
            tests: '测试',
            __tests__: '测试',
            scripts: '脚本',
            media: '静态资源',
            assets: '静态资源',
            resources: '资源文件',
            i18n: '国际化',
            locales: '国际化',
        };
        return map[n] || '';
    }

    getDefaultStructure(): string {
        const bundledCandidates = [
            path.join(this.extensionPath, BASE, PROMPTS_DIR, 'default_project_structure.md'),
            path.join(this.extensionPath, PROMPTS_DIR, 'default_project_structure.md'),
        ];
        for (const bundled of bundledCandidates) {
            if (!fs.existsSync(bundled)) {
                continue;
            }
            try {
                const content = fs.readFileSync(bundled, 'utf8').trim();
                if (content) {
                    return content;
                }
            } catch {
                // ignore bundled file read failures and try next fallback.
            }
        }
        return DEFAULT_PROJECT_STRUCTURE.trim();
    }

    // ── Detection helpers ──────────────────────────────────────────────

    private findFrontendProject(): { root: string; kind: 'vue3' | 'react' } | null {
        const candidates = [
            // Highest priority: the folder the user configured via monorepoDirs.frontend.
            ...this.getConfiguredFrontendCandidates(),
            this.workspaceRoot,
            path.join(this.workspaceRoot, 'repos', 'frontend-main'),
            path.join(this.workspaceRoot, 'frontend'),
            // Monorepo layout: dedicated main clone at repos/mono-main, with an apps/ folder.
            path.join(this.workspaceRoot, 'repos', 'mono-main', 'apps'),
            path.join(this.workspaceRoot, 'repos', 'mono-main'),
            path.join(this.workspaceRoot, 'apps'),
        ];
        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) {
                continue;
            }
            const srcDir = path.join(candidate, 'src');
            const pkg = path.join(candidate, 'package.json');
            if (!fs.existsSync(srcDir) || !fs.existsSync(pkg)) {
                continue;
            }
            if (this.containsVueFile(srcDir, 3)) {
                return { root: candidate, kind: 'vue3' };
            }
            if (this.containsReactDependency(pkg) || this.containsReactFile(srcDir, 3)) {
                return { root: candidate, kind: 'react' };
            }
        }
        return null;
    }

    private findBackendProject(): { root: string; kind: 'java-ddd' | 'node' } | null {
        const candidates = [
            // Highest priority: the folder the user configured via monorepoDirs.backend.
            ...this.getConfiguredBackendCandidates(),
            path.join(this.workspaceRoot, 'repos', 'backend-main'),
            path.join(this.workspaceRoot, 'backend'),
            this.workspaceRoot,
            // Monorepo layout: dedicated main clone at repos/mono-main, with an apps/ folder.
            path.join(this.workspaceRoot, 'repos', 'mono-main', 'apps'),
            path.join(this.workspaceRoot, 'repos', 'mono-main'),
            path.join(this.workspaceRoot, 'apps'),
        ];
        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) {
                continue;
            }
            if (this.isJavaBackendProject(candidate)) {
                return { root: candidate, kind: 'java-ddd' };
            }
            const nodePkg = path.join(candidate, 'package.json');
            const nodeSrc = path.join(candidate, 'src');
            if (fs.existsSync(nodePkg) && (fs.existsSync(nodeSrc) || fs.existsSync(path.join(candidate, 'app')))) {
                if (this.containsNodeServerHints(nodePkg)) {
                    return { root: candidate, kind: 'node' };
                }
            }
        }
        return null;
    }

    private isJavaBackendProject(candidate: string): boolean {
        const javaDir = path.join(candidate, 'src', 'main', 'java');
        const hasMavenBuild = fs.existsSync(path.join(candidate, 'pom.xml'));
        const hasGradleBuild = fs.existsSync(path.join(candidate, 'build.gradle')) || fs.existsSync(path.join(candidate, 'build.gradle.kts'));
        if (fs.existsSync(javaDir) && (hasMavenBuild || hasGradleBuild)) {
            return true;
        }

        const mavenModules = this.resolveMavenModulePaths(candidate);
        if (mavenModules.length > 0) {
            for (const modulePath of mavenModules) {
                const moduleRoot = path.join(candidate, modulePath);
                const moduleJavaDir = path.join(moduleRoot, 'src', 'main', 'java');
                const modulePom = path.join(moduleRoot, 'pom.xml');
                if (fs.existsSync(modulePom) && fs.existsSync(moduleJavaDir)) {
                    return true;
                }
            }
        }

        // Fallback: scan one level for common Java module shape.
        for (const child of this.listSubDirs(candidate, 40)) {
            const childRoot = path.join(candidate, child);
            const childJavaDir = path.join(childRoot, 'src', 'main', 'java');
            const childPom = path.join(childRoot, 'pom.xml');
            const childGradle = path.join(childRoot, 'build.gradle');
            const childGradleKts = path.join(childRoot, 'build.gradle.kts');
            if (fs.existsSync(childJavaDir) && (fs.existsSync(childPom) || fs.existsSync(childGradle) || fs.existsSync(childGradleKts))) {
                return true;
            }
        }

        return false;
    }

    private resolveMavenModulePaths(candidate: string): string[] {
        const pomPath = path.join(candidate, 'pom.xml');
        if (!fs.existsSync(pomPath)) {
            return [];
        }
        try {
            const raw = fs.readFileSync(pomPath, 'utf8');
            return Array.from(raw.matchAll(/<module>\s*([^<\n\r]+)\s*<\/module>/gi), (match: RegExpMatchArray) => (match[1] || '').trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    private containsVueFile(dir: string, depth: number): boolean {
        if (depth < 0 || !fs.existsSync(dir)) {
            return false;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.vue')) {
                return true;
            }
            if (entry.isDirectory() && this.containsVueFile(fullPath, depth - 1)) {
                return true;
            }
        }
        return false;
    }

    private containsReactFile(dir: string, depth: number): boolean {
        if (depth < 0 || !fs.existsSync(dir)) {
            return false;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && /\.(jsx|tsx)$/.test(entry.name)) {
                return true;
            }
            if (entry.isDirectory() && this.containsReactFile(fullPath, depth - 1)) {
                return true;
            }
        }
        return false;
    }

    private containsReactDependency(pkgPath: string): boolean {
        try {
            const pkgRaw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = {
                ...(pkgRaw.dependencies || {}),
                ...(pkgRaw.devDependencies || {}),
            };
            return Boolean(deps.react || deps['react-dom'] || deps.next);
        } catch {
            return false;
        }
    }

    private containsNodeServerHints(pkgPath: string): boolean {
        try {
            const pkgRaw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = {
                ...(pkgRaw.dependencies || {}),
                ...(pkgRaw.devDependencies || {}),
            };
            return Boolean(deps.express || deps.koa || deps.fastify || deps['@nestjs/core']);
        } catch {
            return false;
        }
    }

    private listSubDirs(dir: string, max: number): string[] {
        if (!fs.existsSync(dir)) {
            return ['api', 'stores', 'views', 'components', 'router', 'utils'];
        }
        const dirs = fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry: fs.Dirent) => entry.isDirectory())
            .map((entry: fs.Dirent) => entry.name)
            .sort();
        const mapped = this.applyGranularityDirectoryMapping(dirs, max, false);
        return mapped.length > 0 ? mapped : ['api', 'stores', 'views', 'components', 'router', 'utils'];
    }

    /**
     * Apply granularity mapping on directory names:
     * - collapsePatterns: remove noisy directories unless in mustExpandDomains
     * - dedupeStrategy=bySemantic: merge repeated semantic directories
     * - dedupeStrategy=byPath: keep only first duplicate path token
     */
    private applyGranularityDirectoryMapping(names: string[], max: number, keepFilesystemNames: boolean): string[] {
        const rules = this.getActiveGranularityRuleSet();
        const mustExpand = new Set(rules.mustExpandDomains.map(v => v.toLowerCase()));
        const collapsePatterns = rules.collapsePatterns.map(v => v.toLowerCase()).filter(Boolean);

        const visible = names.filter(name => {
            const lower = name.toLowerCase();
            if (mustExpand.has(lower)) {
                return true;
            }
            return !collapsePatterns.some(pattern => this.matchesCollapsePattern(lower, pattern));
        });

        if (rules.dedupeStrategy === 'byPath' || keepFilesystemNames) {
            return Array.from(new Set(visible)).slice(0, max);
        }

        const buckets = new Map<string, string[]>();
        visible.forEach(name => {
            const key = this.semanticDirectoryKey(name);
            const group = buckets.get(key) || [];
            group.push(name);
            buckets.set(key, group);
        });

        const merged: string[] = [];
        for (const group of buckets.values()) {
            if (group.length >= 3) {
                const first = group[0];
                const normalized = this.semanticDirectoryKey(first).replace(/\*+$/g, '') || first.toLowerCase();
                const summary = `${normalized}-* (${group.length})`;
                merged.push(summary);
            } else {
                merged.push(...group);
            }
        }
        return merged.slice(0, max);
    }

    /** Match collapse pattern against a directory name token. */
    private matchesCollapsePattern(name: string, pattern: string): boolean {
        if (!pattern) {
            return false;
        }
        if (pattern.includes('*')) {
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`, 'i').test(name);
        }
        return name === pattern || name.includes(pattern);
    }

    /** Normalize directory names to semantic buckets for dedupe-by-semantic merging. */
    private semanticDirectoryKey(name: string): string {
        return name
            .toLowerCase()
            .replace(/[-_]?\d+$/g, '')
            .replace(/[-_](impl|module|service|services|feature|features)$/g, '')
            .trim() || name.toLowerCase();
    }

    /** Validate granularity rules and throw explicit conflict errors when contradictory. */
    private validateGranularityRuleSet(ruleSet: ProjectStructureGranularityRuleSet): void {
        if (!Number.isFinite(ruleSet.maxDepth) || ruleSet.maxDepth < 1) {
            throw new GranularityRuleConflictError(ruleSet.id, 'maxDepth 必须大于等于 1');
        }

        const collapse = new Set(ruleSet.collapsePatterns.map(v => v.toLowerCase()));
        const conflictingDomain = ruleSet.mustExpandDomains.find(domain => collapse.has(domain.toLowerCase()));
        if (conflictingDomain) {
            throw new GranularityRuleConflictError(
                ruleSet.id,
                `mustExpandDomains 与 collapsePatterns 冲突：${conflictingDomain}`,
            );
        }
    }

    private pickJavaBasePackage(javaDir: string): string {
        if (!fs.existsSync(javaDir)) {
            return '[基础包名]';
        }
        const first = fs.readdirSync(javaDir, { withFileTypes: true }).find((entry: fs.Dirent) => entry.isDirectory());
        if (!first) {
            return '[基础包名]';
        }
        const secondPath = path.join(javaDir, first.name);
        const second = fs.readdirSync(secondPath, { withFileTypes: true }).find((entry: fs.Dirent) => entry.isDirectory());
        if (!second) {
            return first.name;
        }
        return `${first.name}/${second.name}`;
    }

    private pickJavaBasePackageForBackend(backendRoot: string, modules: string[]): string {
        const rootJavaDir = path.join(backendRoot, 'src', 'main', 'java');
        const rootPackage = this.pickJavaBasePackage(rootJavaDir);
        if (rootPackage !== '[基础包名]') {
            return rootPackage;
        }

        for (const modulePath of modules) {
            const moduleJavaDir = path.join(backendRoot, modulePath, 'src', 'main', 'java');
            const modulePackage = this.pickJavaBasePackage(moduleJavaDir);
            if (modulePackage !== '[基础包名]') {
                return modulePackage;
            }
        }

        return '[基础包名]';
    }

    private inferJavaArchitectureStyle(
        backendRoot: string,
        modules: string[],
        packageHint: string,
    ): 'ddd' | 'layered' | 'mixed' {
        const packageSegments = packageHint === '[基础包名]' ? [] : packageHint.split('/');
        const roots: string[] = [];

        if (modules.length > 0) {
            for (const modulePath of modules) {
                roots.push(path.join(backendRoot, modulePath, 'src', 'main', 'java'));
            }
        } else {
            roots.push(path.join(backendRoot, 'src', 'main', 'java'));
        }

        let dddSignals = 0;
        let layeredSignals = 0;
        const checkDirs = (base: string, dirs: string[]): number => dirs.reduce((acc, dir) => acc + (fs.existsSync(path.join(base, dir)) ? 1 : 0), 0);

        for (const javaRoot of roots) {
            const root = packageSegments.length > 0 ? path.join(javaRoot, ...packageSegments) : javaRoot;
            dddSignals += checkDirs(root, ['application', 'domain', 'infrastructure']);
            layeredSignals += checkDirs(root, ['controller', 'service', 'repository', 'mapper', 'dao']);
        }

        if (dddSignals >= 3 && layeredSignals <= 1) {
            return 'ddd';
        }
        if (layeredSignals >= 2 && dddSignals <= 1) {
            return 'layered';
        }
        return dddSignals === 0 && layeredSignals === 0 ? 'layered' : 'mixed';
    }

    private toWorkspaceRelative(absPath: string): string {
        const rel = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
        return rel || '.';
    }

    // ── Concise tree builders ──────────────────────────────────────────

    private buildFrontendConciseTree(frontend: { root: string; kind: 'vue3' | 'react' }): string {
        const srcDir = path.join(frontend.root, 'src');
        const relRoot = this.toWorkspaceRelative(frontend.root);
        const srcChildren = this.listSubDirs(srcDir, 15);
        const label = frontend.kind === 'vue3' ? 'Vue3 + TypeScript' : 'React + TypeScript';

        const lines: string[] = [`# 前端目录（${label}）`, `${relRoot}/src/`];
        srcChildren.forEach((name, i) => {
            const isLast = i === srcChildren.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const role = this.inferFrontendDirRoleBrief(name);
            const padding = ' '.repeat(Math.max(1, 16 - name.length));
            lines.push(role
                ? `${prefix} ${name}/${padding}# ${role}`
                : `${prefix} ${name}/`);
        });
        return lines.join('\n');
    }

    private buildBackendConciseTree(backend: { root: string; kind: 'java-ddd' | 'node' }): string {
        const relRoot = this.toWorkspaceRelative(backend.root);

        if (backend.kind === 'node') {
            return this.buildNodeBackendTree(backend.root, relRoot);
        }
        return this.buildJavaBackendTree(backend.root, relRoot);
    }

    private buildNodeBackendTree(backendRoot: string, relRoot: string): string {
        const srcDir = path.join(backendRoot, 'src');
        const srcChildren = this.listSubDirs(srcDir, 15);
        const lines: string[] = [`# 后端目录（Node.js）`, `${relRoot}/src/`];
        srcChildren.forEach((name, i) => {
            const isLast = i === srcChildren.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const role = this.inferNodeDirRoleBrief(name);
            const padding = ' '.repeat(Math.max(1, 16 - name.length));
            lines.push(role
                ? `${prefix} ${name}/${padding}# ${role}`
                : `${prefix} ${name}/`);
        });
        return lines.join('\n');
    }

    private buildJavaBackendTree(backendRoot: string, relRoot: string): string {
        const modules = this.resolveMavenModulePaths(backendRoot);
        const isMultiModule = modules.length > 0;
        const packageHint = this.pickJavaBasePackageForBackend(backendRoot, modules);
        const javaStyle = this.inferJavaArchitectureStyle(backendRoot, modules, packageHint || '[基础包名]');
        const styleLabel = javaStyle === 'ddd'
            ? 'SpringBoot DDD 分层'
            : javaStyle === 'layered'
                ? 'SpringBoot 分层'
                : 'SpringBoot 混合分层';
        const pkgDisplay = packageHint !== '[基础包名]'
            ? packageHint.replace(/\//g, '.')
            : '[基础包名]';

        if (!isMultiModule) {
            return this.buildJavaSingleModuleTree(backendRoot, relRoot, packageHint, pkgDisplay, styleLabel, javaStyle);
        }
        return this.buildJavaMultiModuleTree(backendRoot, relRoot, modules, pkgDisplay, styleLabel, javaStyle);
    }

    private buildJavaSingleModuleTree(
        backendRoot: string,
        relRoot: string,
        packageHint: string,
        pkgDisplay: string,
        styleLabel: string,
        javaStyle: 'ddd' | 'layered' | 'mixed',
    ): string {
        const javaDir = path.join(backendRoot, 'src', 'main', 'java');
        const pkgDir = packageHint !== '[基础包名]'
            ? path.join(javaDir, ...packageHint.split('/'))
            : javaDir;

        const lines: string[] = [`# 后端目录（${styleLabel}，包名前缀 ${pkgDisplay}）`, `${pkgDisplay}/`];
        const leafDirs = this.listJavaLeafPackageDirs(pkgDir);

        if (leafDirs.length > 0) {
            this.appendTreeLines(lines, leafDirs, '', (name) => this.inferJavaDirRoleBrief(path.basename(name), javaStyle));
        } else {
            // No detected dirs, output convention tree based on style
            lines.push(...this.getJavaConventionTree(javaStyle));
        }
        return lines.join('\n');
    }

    private buildJavaMultiModuleTree(
        backendRoot: string,
        relRoot: string,
        modules: string[],
        pkgDisplay: string,
        styleLabel: string,
        javaStyle: 'ddd' | 'layered' | 'mixed',
    ): string {
        const lines: string[] = [`# 后端目录（${styleLabel}，多模块）`, `${relRoot}/`];

        modules.forEach((modulePath, mi) => {
            const isLastModule = mi === modules.length - 1;
            const modulePrefix = isLastModule ? '└──' : '├──';
            const childIndent = isLastModule ? '    ' : '│   ';
            const moduleName = path.basename(modulePath);
            const moduleRole = this.inferJavaModuleRoleBrief(moduleName);
            const modulePadding = ' '.repeat(Math.max(1, 24 - moduleName.length));

            lines.push(moduleRole
                ? `${modulePrefix} ${moduleName}/${modulePadding}# ${moduleRole}`
                : `${modulePrefix} ${moduleName}/`);

            // List actual packages under this module
            const moduleRoot = path.join(backendRoot, modulePath);
            const javaDir = path.join(moduleRoot, 'src', 'main', 'java');
            const modulePackageHint = this.pickJavaBasePackage(javaDir);
            const modulePkgDisplay = modulePackageHint !== '[基础包名]'
                ? modulePackageHint.replace(/\//g, '.')
                : pkgDisplay;
            const pkgSegments = modulePackageHint !== '[基础包名]' ? modulePackageHint.split('/') : [];
            const pkgDir = pkgSegments.length > 0 ? path.join(javaDir, ...pkgSegments) : javaDir;

            if (!fs.existsSync(pkgDir)) {
                return;
            }

            const leafDirs = this.listJavaLeafPackageDirs(pkgDir);
            if (leafDirs.length === 0) {
                return;
            }

            lines.push(`${childIndent}└── ${modulePkgDisplay}/`);
            const pkgIndent = childIndent + '    ';
            this.appendTreeLines(lines, leafDirs, pkgIndent, (name) => this.inferJavaDirRoleBrief(path.basename(name), javaStyle));
        });

        return lines.join('\n');
    }

    private appendTreeLines(
        lines: string[],
        dirs: string[],
        indent: string,
        roleFn: (name: string) => string,
    ): void {
        dirs.forEach((name, i) => {
            const isLast = i === dirs.length - 1;
            const prefix = isLast ? '└──' : '├──';
            const role = roleFn(name);
            const padding = ' '.repeat(Math.max(1, 20 - name.length));
            lines.push(role
                ? `${indent}${prefix} ${name}/${padding}# ${role}`
                : `${indent}${prefix} ${name}/`);
        });
    }

    private listJavaPackageDirs(pkgDir: string): string[] {
        if (!fs.existsSync(pkgDir)) {
            return [];
        }
        try {
            return fs.readdirSync(pkgDir, { withFileTypes: true })
                .filter((e: fs.Dirent) => e.isDirectory())
                .map((e: fs.Dirent) => e.name)
                .sort();
        } catch {
            return [];
        }
    }

    private listJavaLeafPackageDirs(pkgDir: string, maxLeaves: number = 36, maxDepth: number = 8): string[] {
        if (!fs.existsSync(pkgDir)) {
            return [];
        }

        const leaves: string[] = [];
        const visit = (dir: string, rel: string[], depth: number): void => {
            if (depth > maxDepth || leaves.length >= maxLeaves) {
                return;
            }
            let childDirs: string[] = [];
            try {
                childDirs = fs.readdirSync(dir, { withFileTypes: true })
                    .filter((e: fs.Dirent) => e.isDirectory())
                    .map((e: fs.Dirent) => e.name)
                    .sort();
            } catch {
                return;
            }

            if (childDirs.length === 0) {
                if (rel.length > 0) {
                    leaves.push(rel.join('/'));
                }
                return;
            }

            childDirs.forEach((name) => visit(path.join(dir, name), [...rel, name], depth + 1));
        };

        visit(pkgDir, [], 0);
        return leaves;
    }

    private getJavaConventionTree(javaStyle: 'ddd' | 'layered' | 'mixed'): string[] {
        if (javaStyle === 'ddd') {
            return [
                '├── application/            # 应用层（服务编排、DTO、适配器）',
                '├── domain/                 # 领域层（实体、事件、仓储接口）',
                '├── infrastructure/         # 基础设施层（DAO、缓存、存储实现）',
                '├── external/               # 外部对接层（Feign、防腐转换）',
                '└── boot/                   # 启动层',
            ];
        }
        return [
            '├── controller/             # 接口入口（参数校验/鉴权）',
            '├── service/                # 业务编排与规则',
            '├── repository/             # 数据访问抽象',
            '├── mapper/                 # 持久化映射',
            '├── entity/                 # 领域对象',
            '├── dto/                    # 请求/响应对象',
            '└── boot/                   # 启动装配',
        ];
    }

    // ── Role inference (brief, one-line) ───────────────────────────────

    private inferFrontendDirRoleBrief(name: string): string {
        const n = name.toLowerCase();
        const map: Record<string, string> = {
            api: 'API 接口定义',
            apis: 'API 接口定义',
            mock: 'Mock 数据',
            mocks: 'Mock 数据',
            store: '状态管理',
            stores: '状态管理',
            view: '页面',
            views: '页面',
            page: '页面',
            pages: '页面',
            component: '公共组件',
            components: '公共组件',
            router: '路由配置',
            util: '通用工具',
            utils: '通用工具',
            helper: '工具函数',
            helpers: '工具函数',
            type: 'TS 类型定义',
            types: 'TS 类型定义',
            config: '运行配置',
            constant: '常量与枚举',
            constants: '常量与枚举',
            static: '静态资源',
            asset: '静态资源',
            assets: '静态资源',
            style: '样式文件',
            styles: '样式文件',
            layout: '布局组件',
            layouts: '布局组件',
            plugin: '插件',
            plugins: '插件',
            directive: '自定义指令',
            directives: '自定义指令',
            composable: '组合式函数',
            composables: '组合式函数',
            hook: '自定义 Hook',
            hooks: '自定义 Hook',
            service: '业务服务',
            services: '业务服务',
            locale: '国际化',
            locales: '国际化',
            i18n: '国际化',
            subpackages: '业务子域模块',
            module: '业务模块',
            modules: '业务模块',
        };
        return map[n] || '';
    }

    private inferNodeDirRoleBrief(name: string): string {
        const n = name.toLowerCase();
        const map: Record<string, string> = {
            controller: '路由控制器',
            controllers: '路由控制器',
            service: '业务服务',
            services: '业务服务',
            model: '数据模型',
            models: '数据模型',
            middleware: '中间件',
            middlewares: '中间件',
            route: '路由定义',
            routes: '路由定义',
            util: '通用工具',
            utils: '通用工具',
            config: '配置',
            type: '类型定义',
            types: '类型定义',
            domain: '领域模型',
            infrastructure: '基础设施（DB/缓存）',
            repository: '数据访问',
            interface: '接口入口',
            interfaces: '接口入口',
            shared: '公共模块',
        };
        return map[n] || '';
    }

    private inferJavaDirRoleBrief(name: string, javaStyle: 'ddd' | 'layered' | 'mixed'): string {
        const n = name.toLowerCase();
        if (javaStyle === 'ddd') {
            const map: Record<string, string> = {
                application: '应用层（服务编排、DTO、适配器）',
                domain: '领域层（实体、事件、仓储接口）',
                infrastructure: '基础设施层（DAO、缓存、存储）',
                external: '外部对接层（Feign、防腐转换）',
                boot: '启动层',
                adapter: '适配器（API/MQ/定时任务入口）',
                service: '应用服务',
                dto: '请求/响应对象',
                converter: '对象转换器',
                repository: '仓储',
                entity: '实体',
                event: '领域事件',
                enums: '枚举',
                constants: '常量',
                error: '错误码',
                process: '编排流程',
                consumer: 'MQ 消费者',
                scheduler: '定时任务',
                api: 'REST 入口',
                properties: '配置属性',
                dao: 'DAO',
                cache: '缓存',
                storage: '对象存储',
                dataobject: '持久化对象',
                feign: 'Feign 客户端',
            };
            return map[n] || '';
        }
        const map: Record<string, string> = {
            controller: 'REST 控制器',
            service: '业务服务',
            repository: '数据访问',
            mapper: '持久化映射',
            dao: 'DAO',
            entity: '领域实体',
            model: '数据模型',
            dto: '请求/响应对象',
            vo: '视图对象',
            config: '配置',
            boot: '启动装配',
            integration: '外部系统适配',
            external: '外部系统适配',
            client: '外部客户端',
            feign: 'Feign 客户端',
            job: '定时任务',
            consumer: 'MQ 消费者',
            listener: '事件监听',
            enums: '枚举',
            constants: '常量',
            error: '错误码',
            exception: '异常定义',
            util: '工具类',
            utils: '工具类',
            common: '公共模块',
            impl: '实现类',
            interceptor: '拦截器',
            filter: '过滤器',
            aspect: '切面',
        };
        return map[n] || '';
    }

    private inferJavaModuleRoleBrief(moduleName: string): string {
        const n = moduleName.toLowerCase();
        if (/service|core|domain/.test(n)) {
            return '业务核心模块';
        }
        if (/web|api|gateway/.test(n)) {
            return '接口入口模块';
        }
        if (/start|boot|app/.test(n)) {
            return '启动装配模块';
        }
        if (/common|shared|base/.test(n)) {
            return '公共基础模块';
        }
        if (/infra|infrastructure|dal/.test(n)) {
            return '基础设施模块';
        }
        if (/client|integration|external/.test(n)) {
            return '外部对接模块';
        }
        return '';
    }
}
