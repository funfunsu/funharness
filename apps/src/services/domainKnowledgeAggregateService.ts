import * as fs from 'fs';
import * as path from 'path';
import {
    CapabilityDelta,
    CapabilityDeltaItem,
    ContractDeltaItem,
    DomainDelta,
    DomainRegistry,
    DomainRegistryEntry,
    InvariantDeltaItem,
} from '../models';
import {
    hasMarkedBlock,
    readTextIfExists,
    replaceMarkedBlockStrict,
    writeTextAtomic,
} from './fileOps';
import { CapabilityDeltaService } from './capabilityDeltaService';
import { DomainRegistryService } from './domainRegistryService';
import { PromptService } from './promptService';

const DOMAIN_DOCS_DIR = path.join('docs', 'domains');

const MARKER_AUTO_CAPABILITIES = 'AUTO:capabilities';
const MARKER_AUTO_CONTRACTS = 'AUTO:contracts';
const MARKER_AUTO_INVARIANTS = 'AUTO:invariants';
const MARKER_AUTO_CHANGELOG = 'AUTO:changelog';
const MARKER_AUTO_INDEX = 'AUTO:index';
const MARKER_HUMAN_OVERVIEW = 'HUMAN:overview';
const MARKER_HUMAN_NOTES = 'HUMAN:notes';
const MARKER_HUMAN_INDEX_NOTES = 'HUMAN:notes';

interface DomainIndexRow {
    canonical: string;
    displayName: string;
    status: string;
    documentLink: string;
}

interface CapabilityRow {
    reqId: string;
    title: string;
    status: string;
    firstIntroduced: string;
    lastChanged: string;
}

interface ContractRow {
    key: string;
    reqId: string;
    method: string;
    routePath: string;
    request: string;
    response: string;
}

interface InvariantRow {
    id: string;
    reqId: string;
    text: string;
}

export interface DomainDocumentChangeSummary {
    created: boolean;
    capabilitiesUpserted: number;
    contractsUpserted: number;
    invariantsUpserted: number;
    changelogAppended: boolean;
}

export interface UpsertDomainDocumentInput {
    repoRoot: string;
    canonical: string;
    registryEntry: DomainRegistryEntry;
    domainDelta: DomainDelta;
    iteration: string;
    generatedAt?: string;
}

export interface AggregationRecord {
    iteration: string;
    contentHash: string;
    aggregatedAt: string;
}

export interface SkippedAggregationRecord {
    iteration: string;
    contentHash: string;
    reason: 'already-aggregated' | 'invalid-delta' | 'read-failed';
    detail?: string;
}

export interface SuspectedDomainRecord {
    iteration: string;
    rawDomain: string;
    relatedReqIds: string[];
    suggestedCanonical: string | null;
}

export interface AggregatePendingDeltasResult {
    processed: AggregationRecord[];
    skipped: SkippedAggregationRecord[];
    suspectedDomains: SuspectedDomainRecord[];
}

export interface DomainRegistryCoverageIssue {
    iteration: string;
    rawDomain: string;
    contentHash: string;
}

interface AggregateOneDeltaResult {
    writes: number;
    unresolved: number;
}

type DomainSummaryAiRefiner = (prompt: string) => string;

/**
 * Service providing template parsing and strict AUTO/HUMAN marker upsert for domain documents.
 */
export class DomainKnowledgeAggregateService {
    private readonly capabilityDeltaService: CapabilityDeltaService;
    private readonly domainRegistryService: DomainRegistryService;
    private readonly domainSummaryAiRefiner?: DomainSummaryAiRefiner;

    /**
     * Create domain aggregate service with explicit dependencies for deterministic aggregation flow.
     */
    constructor(
        capabilityDeltaService?: CapabilityDeltaService,
        domainRegistryService?: DomainRegistryService,
        domainSummaryAiRefiner?: DomainSummaryAiRefiner,
    ) {
        this.capabilityDeltaService = capabilityDeltaService || new CapabilityDeltaService();
        this.domainRegistryService = domainRegistryService || new DomainRegistryService();
        this.domainSummaryAiRefiner = domainSummaryAiRefiner;
    }

    /**
     * Aggregate pending capability-delta files and persist idempotent state in registry lastAggregated.
     */
    aggregatePendingDeltas(repoRoot: string, enableAiRefinement: boolean, docsRepoRoot?: string): AggregatePendingDeltasResult {
        const normalizedRepoRoot = path.resolve((repoRoot || '').trim());
        if (!normalizedRepoRoot) {
            throw new Error('repoRoot is required');
        }

        const normalizedDocsRepoRoot = docsRepoRoot
            ? path.resolve(docsRepoRoot.trim())
            : normalizedRepoRoot;

        const registryLoad = this.domainRegistryService.loadRegistry(normalizedDocsRepoRoot);
        if (registryLoad.validationErrors.length > 0) {
            throw new Error(`Invalid registry: ${registryLoad.validationErrors.map(item => item.message).join('; ')}`);
        }

        const registry = registryLoad.registry;
        const deltaPaths = this.discoverDeltaFiles(normalizedRepoRoot);
        const processed: AggregationRecord[] = [];
        const skipped: SkippedAggregationRecord[] = [];
        const suspectedDomains: SuspectedDomainRecord[] = [];
        let registryChanged = false;

        for (const deltaPath of deltaPaths) {
            let delta: CapabilityDelta;
            try {
                delta = this.readDeltaFile(deltaPath);
            } catch (error) {
                skipped.push({
                    iteration: this.resolveIterationFromDeltaPath(deltaPath),
                    contentHash: '',
                    reason: 'read-failed',
                    detail: error instanceof Error ? error.message : String(error || 'unknown'),
                });
                continue;
            }

            const validation = this.capabilityDeltaService.validateDelta(delta);
            if (!validation.valid || delta.contentHash !== validation.contentHash) {
                skipped.push({
                    iteration: delta.iteration,
                    contentHash: delta.contentHash,
                    reason: 'invalid-delta',
                    detail: !validation.valid
                        ? validation.errors.map(item => `${item.field}: ${item.message}`).join('; ')
                        : 'contentHash mismatch',
                });
                continue;
            }

            const alreadyAggregated = this.domainRegistryService.hasAggregatedRecord(registry, delta.iteration, delta.contentHash);
            if (alreadyAggregated && !this.shouldReprocessAggregatedDelta(registry, delta)) {
                skipped.push({
                    iteration: delta.iteration,
                    contentHash: delta.contentHash,
                    reason: 'already-aggregated',
                });
                continue;
            }

            const aggregateResult = this.aggregateOneDelta(
                normalizedDocsRepoRoot,
                registry,
                delta,
                suspectedDomains,
                enableAiRefinement,
            );
            if (aggregateResult.unresolved === 0 && (aggregateResult.writes > 0 || this.hasDomainPayload(delta))) {
                const aggregatedAt = new Date().toISOString();
                this.domainRegistryService.upsertAggregatedRecord(registry, {
                    iteration: delta.iteration,
                    contentHash: delta.contentHash,
                    aggregatedAt,
                });
                processed.push({
                    iteration: delta.iteration,
                    contentHash: delta.contentHash,
                    aggregatedAt,
                });
                registryChanged = true;
            }
        }

        if (registryChanged) {
            this.domainRegistryService.saveRegistry(normalizedDocsRepoRoot, registry);
        }

        this.upsertDomainIndex(normalizedDocsRepoRoot, registry.domains);

        return {
            processed,
            skipped,
            suspectedDomains: this.collectSuspectedDomains([], suspectedDomains),
        };
    }

    /**
     * Scan all deltas and report unresolved raw domains against current registry mappings.
     */
    getRegistryCoverageIssues(repoRoot: string, docsRepoRoot?: string): DomainRegistryCoverageIssue[] {
        const normalizedRepoRoot = path.resolve((repoRoot || '').trim());
        if (!normalizedRepoRoot) {
            throw new Error('repoRoot is required');
        }

        const normalizedDocsRepoRoot = docsRepoRoot
            ? path.resolve(docsRepoRoot.trim())
            : normalizedRepoRoot;

        const registryLoad = this.domainRegistryService.loadRegistry(normalizedDocsRepoRoot);
        if (registryLoad.validationErrors.length > 0) {
            throw new Error(`Invalid registry: ${registryLoad.validationErrors.map(item => item.message).join('; ')}`);
        }

        const issues = new Map<string, DomainRegistryCoverageIssue>();
        const deltaPaths = this.discoverDeltaFiles(normalizedRepoRoot);
        for (const deltaPath of deltaPaths) {
            let delta: CapabilityDelta;
            try {
                delta = this.readDeltaFile(deltaPath);
            } catch {
                continue;
            }

            for (const domainDelta of delta.domains) {
                if (this.resolveRegistryEntryForDomainDelta(registryLoad.registry, domainDelta)) {
                    continue;
                }
                const rawDomain = (domainDelta.rawDomain || domainDelta.canonical || '').trim();
                if (!rawDomain) {
                    continue;
                }
                const key = `${delta.iteration}|${rawDomain.toLowerCase()}|${delta.contentHash}`;
                if (!issues.has(key)) {
                    issues.set(key, {
                        iteration: delta.iteration,
                        rawDomain,
                        contentHash: delta.contentHash,
                    });
                }
            }
        }

        return Array.from(issues.values()).sort((left, right) => {
            if (left.iteration !== right.iteration) {
                return left.iteration.localeCompare(right.iteration);
            }
            return left.rawDomain.localeCompare(right.rawDomain);
        });
    }

    /**
     * Upsert docs/domains/_index.md and keep exactly one row per canonical domain.
     */
    upsertDomainIndex(repoRoot: string, domains: DomainRegistryEntry[]): string {
        const indexPath = path.join(path.resolve((repoRoot || '').trim()), DOMAIN_DOCS_DIR, '_index.md');
        const existing = readTextIfExists(indexPath);
        let content = existing || this.buildInitialIndexTemplate();

        if (!hasMarkedBlock(content, MARKER_HUMAN_INDEX_NOTES) || !hasMarkedBlock(content, MARKER_AUTO_INDEX)) {
            throw new Error('Invalid _index.md marker structure');
        }

        const rows = domains
            .map(item => ({
                canonical: item.canonical,
                displayName: item.displayName,
                status: item.status,
                documentLink: `./${item.canonical}.md`,
            }))
            .sort((left, right) => left.canonical.localeCompare(right.canonical));

        content = replaceMarkedBlockStrict(content, MARKER_AUTO_INDEX, this.renderIndexRows(rows)).content;
        writeTextAtomic(indexPath, `${content.replace(/\r\n/g, '\n').trimEnd()}\n`);
        return indexPath;
    }

    /**
     * Collect and deduplicate suspected domain records from delta payloads.
     */
    collectSuspectedDomains(deltas: CapabilityDelta[], seed: SuspectedDomainRecord[] = []): SuspectedDomainRecord[] {
        const merged = [...seed];
        for (const delta of deltas) {
            for (const domainDelta of delta.domains) {
                if (!domainDelta.isSuspectedNew) {
                    continue;
                }
                merged.push({
                    iteration: delta.iteration,
                    rawDomain: (domainDelta.rawDomain || domainDelta.canonical || 'uncategorized').trim() || 'uncategorized',
                    relatedReqIds: this.collectReqIds(domainDelta),
                    suggestedCanonical: domainDelta.canonical,
                });
            }
        }

        const index = new Map<string, SuspectedDomainRecord>();
        for (const item of merged) {
            const key = `${item.iteration}|${item.rawDomain.toLowerCase()}`;
            const existing = index.get(key);
            if (!existing) {
                index.set(key, {
                    iteration: item.iteration,
                    rawDomain: item.rawDomain,
                    relatedReqIds: [...item.relatedReqIds],
                    suggestedCanonical: item.suggestedCanonical,
                });
                continue;
            }

            const reqIds = new Set<string>([...existing.relatedReqIds, ...item.relatedReqIds]);
            existing.relatedReqIds = Array.from(reqIds.values()).sort((left, right) => left.localeCompare(right));
            if (!existing.suggestedCanonical && item.suggestedCanonical) {
                existing.suggestedCanonical = item.suggestedCanonical;
            }
        }

        return Array.from(index.values()).sort((left, right) => {
            if (left.iteration !== right.iteration) {
                return left.iteration.localeCompare(right.iteration);
            }
            return left.rawDomain.localeCompare(right.rawDomain);
        });
    }

    /**
     * Upsert one domain document using marker block updates while preserving all HUMAN sections.
     */
    upsertDomainDocument(input: UpsertDomainDocumentInput): { filePath: string; changeSummary: DomainDocumentChangeSummary } {
        const filePath = this.resolveDomainDocPath(input.repoRoot, input.canonical);
        const existing = readTextIfExists(filePath);
        const created = !existing;
        let content = existing || this.buildInitialTemplate(input.canonical, input.registryEntry.displayName);

        this.assertTemplateMarkers(content);

        const timestamp = (input.generatedAt || new Date().toISOString()).trim();
        const capabilityRows = this.mergeCapabilityRows(
            this.parseCapabilityRows(this.extractMarkedBody(content, MARKER_AUTO_CAPABILITIES)),
            input.domainDelta.capabilities,
            input.iteration,
        );
        const contractRows = this.mergeContractRows(
            this.parseContractRows(this.extractMarkedBody(content, MARKER_AUTO_CONTRACTS)),
            input.domainDelta.contracts,
        );
        const invariantRows = this.mergeInvariantRows(
            this.parseInvariantRows(this.extractMarkedBody(content, MARKER_AUTO_INVARIANTS)),
            input.domainDelta.invariants,
        );

        const changelogBody = this.appendChangelogEntry(
            this.extractMarkedBody(content, MARKER_AUTO_CHANGELOG),
            input.iteration,
            timestamp,
            capabilityRows.length,
            contractRows.length,
            invariantRows.length,
        );

        content = replaceMarkedBlockStrict(content, MARKER_AUTO_CAPABILITIES, this.renderCapabilityRows(capabilityRows)).content;
        content = replaceMarkedBlockStrict(content, MARKER_AUTO_CONTRACTS, this.renderContractRows(contractRows)).content;
        content = replaceMarkedBlockStrict(content, MARKER_AUTO_INVARIANTS, this.renderInvariantRows(invariantRows)).content;
        content = replaceMarkedBlockStrict(content, MARKER_AUTO_CHANGELOG, changelogBody).content;
        content = this.updateFrontMatter(content, {
            domain: input.canonical,
            displayName: input.registryEntry.displayName,
            lastUpdatedAt: timestamp,
            contributingIterations: this.mergeFrontMatterIterations(content, input.iteration),
        });

        writeTextAtomic(filePath, `${content.replace(/\r\n/g, '\n').trimEnd()}\n`);

        return {
            filePath,
            changeSummary: {
                created,
                capabilitiesUpserted: capabilityRows.length,
                contractsUpserted: contractRows.length,
                invariantsUpserted: invariantRows.length,
                changelogAppended: true,
            },
        };
    }

    /**
     * Aggregate one delta payload into domain documents and collect suspected domain entries.
     */
    private aggregateOneDelta(
        repoRoot: string,
        registry: DomainRegistry,
        delta: CapabilityDelta,
        suspectedDomains: SuspectedDomainRecord[],
        enableAiRefinement: boolean,
    ): AggregateOneDeltaResult {
        let writes = 0;
        let unresolved = 0;
        for (const domainDelta of delta.domains) {
            const registryEntry = this.resolveRegistryEntryForDomainDelta(registry, domainDelta);

            if (!registryEntry) {
                suspectedDomains.push({
                    iteration: delta.iteration,
                    rawDomain: (domainDelta.rawDomain || domainDelta.canonical || 'uncategorized').trim() || 'uncategorized',
                    relatedReqIds: this.collectReqIds(domainDelta),
                    suggestedCanonical: null,
                });
                unresolved += 1;
                continue;
            }

            const refinedDomainDelta = this.applyOptionalAiRefinement(
                domainDelta,
                registry,
                registryEntry,
                enableAiRefinement,
            );

            this.upsertDomainDocument({
                repoRoot,
                canonical: registryEntry.canonical,
                registryEntry,
                domainDelta: refinedDomainDelta,
                iteration: delta.iteration,
                generatedAt: delta.generatedAt,
            });
            writes += 1;
        }
        return { writes, unresolved };
    }

    /**
     * Decide whether a previously aggregated delta should be reprocessed after registry adjudication.
     */
    private shouldReprocessAggregatedDelta(registry: DomainRegistry, delta: CapabilityDelta): boolean {
        for (const domainDelta of delta.domains) {
            const wasWeaklyBound = Boolean(domainDelta.isSuspectedNew)
                || !(domainDelta.canonical || '').trim();
            if (!wasWeaklyBound) {
                continue;
            }

            if (!this.resolveRegistryEntryForDomainDelta(registry, domainDelta)) {
                continue;
            }

            if (
                domainDelta.capabilities.length > 0
                || domainDelta.contracts.length > 0
                || domainDelta.invariants.length > 0
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Resolve registry entry for one domain delta using canonical first, then rawDomain fallback.
     */
    private resolveRegistryEntryForDomainDelta(registry: DomainRegistry, domainDelta: DomainDelta): DomainRegistryEntry | null {
        const canonical = (domainDelta.canonical || '').trim();
        if (canonical) {
            const direct = this.domainRegistryService.findEntryByCanonical(registry, canonical);
            if (direct) {
                return direct;
            }
        }

        const rawDomain = (domainDelta.rawDomain || '').trim();
        if (!rawDomain) {
            return null;
        }

        const normalized = this.domainRegistryService.normalizeDomain(registry, rawDomain, '', { explicitDomain: rawDomain });
        if (!normalized.canonical) {
            return null;
        }
        return this.domainRegistryService.findEntryByCanonical(registry, normalized.canonical);
    }

    /**
     * Discover all capability-delta.json files under specs/<iteration>/delta directory.
     */
    private discoverDeltaFiles(repoRoot: string): string[] {
        const result = new Set<string>();

        // 1) canonical location under current repository root
        for (const filePath of this.collectDeltaFilesFromSpecsDir(path.join(repoRoot, 'specs'))) {
            result.add(path.resolve(filePath));
        }

        // 2) worktree-local locations: <repoRoot>/worktrees/*/specs/<iteration>/delta/capability-delta.json
        const worktreesDir = path.join(repoRoot, 'worktrees');
        if (fs.existsSync(worktreesDir)) {
            for (const entry of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const worktreeRoot = path.join(worktreesDir, entry.name);
                const specsDir = path.join(worktreesDir, entry.name, 'specs');
                for (const filePath of this.collectDeltaFilesFromSpecsDir(specsDir)) {
                    result.add(path.resolve(filePath));
                }
                for (const filePath of this.collectDeltaFilesFromWorktreeRoot(worktreeRoot)) {
                    result.add(path.resolve(filePath));
                }
            }
        }

        return Array.from(result.values()).sort((left, right) => left.localeCompare(right));
    }

    /**
     * Collect capability-delta files from compatibility locations under one worktree root.
     */
    private collectDeltaFilesFromWorktreeRoot(worktreeRoot: string): string[] {
        const candidates = [
            path.join(worktreeRoot, 'capability-delta.json'),
            path.join(worktreeRoot, 'delta', 'capability-delta.json'),
            path.join(worktreeRoot, 'specs', 'delta', 'capability-delta.json'),
        ];

        return candidates.filter(item => fs.existsSync(item));
    }

    /**
     * Collect capability-delta files from one specs directory.
     */
    private collectDeltaFilesFromSpecsDir(specsDir: string): string[] {
        if (!fs.existsSync(specsDir)) {
            return [];
        }

        const result: string[] = [];
        for (const entry of fs.readdirSync(specsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const deltaPath = path.join(specsDir, entry.name, 'delta', 'capability-delta.json');
            if (fs.existsSync(deltaPath)) {
                result.push(deltaPath);
            }
        }
        return result;
    }

    /**
     * Read one delta file and parse it as JSON payload.
     */
    private readDeltaFile(deltaPath: string): CapabilityDelta {
        const content = readTextIfExists(deltaPath);
        if (!content) {
            throw new Error(`Delta file is missing or empty: ${deltaPath}`);
        }
        return JSON.parse(content) as CapabilityDelta;
    }

    /**
     * Resolve iteration name from specs/<iteration>/delta/capability-delta.json path.
     */
    private resolveIterationFromDeltaPath(deltaPath: string): string {
        return path.basename(path.dirname(path.dirname(deltaPath)));
    }

    /**
     * Check whether delta payload contains any domain-level content.
     */
    private hasDomainPayload(delta: CapabilityDelta): boolean {
        return delta.domains.some(item =>
            item.capabilities.length > 0 || item.contracts.length > 0 || item.invariants.length > 0,
        );
    }

    /**
     * Build default _index.md template with strict HUMAN/AUTO marker boundaries.
     */
    private buildInitialIndexTemplate(): string {
        return [
            '# Domain Baseline Index',
            '',
            '本目录由领域基线聚合自动维护，人工编辑请只改 HUMAN:* 标记块内。',
            '',
            `<!-- ${MARKER_HUMAN_INDEX_NOTES}:start -->`,
            '可在此补充阅读说明。',
            `<!-- ${MARKER_HUMAN_INDEX_NOTES}:end -->`,
            '',
            `<!-- ${MARKER_AUTO_INDEX}:start -->`,
            this.renderIndexRows([]),
            `<!-- ${MARKER_AUTO_INDEX}:end -->`,
            '',
        ].join('\n');
    }

    /**
     * Render canonical-upserted index rows as markdown table.
     */
    private renderIndexRows(rows: DomainIndexRow[]): string {
        const lines = [
            '| Canonical | Display Name | Status | Document |',
            '| --- | --- | --- | --- |',
        ];
        for (const row of rows) {
            lines.push(`| ${this.escapeCell(row.canonical)} | ${this.escapeCell(row.displayName)} | ${this.escapeCell(row.status)} | [${this.escapeCell(row.canonical)}](${this.escapeCell(row.documentLink)}) |`);
        }
        return lines.join('\n');
    }

    /**
     * Collect unique Req-ID values from one domain delta.
     */
    private collectReqIds(domainDelta: DomainDelta): string[] {
        const reqIds = new Set<string>();
        for (const capability of domainDelta.capabilities) {
            if ((capability.reqId || '').trim()) {
                reqIds.add(capability.reqId.trim());
            }
        }
        for (const contract of domainDelta.contracts) {
            if ((contract.reqId || '').trim()) {
                reqIds.add(contract.reqId.trim());
            }
        }
        for (const invariant of domainDelta.invariants) {
            if ((invariant.reqId || '').trim()) {
                reqIds.add(invariant.reqId.trim());
            }
        }
        return Array.from(reqIds.values()).sort((left, right) => left.localeCompare(right));
    }

    /**
     * Resolve one domain documentation file path from repository root.
     */
    resolveDomainDocPath(repoRoot: string, canonical: string): string {
        const root = path.resolve((repoRoot || '').trim());
        if (!root) {
            throw new Error('repoRoot is required');
        }
        const normalizedCanonical = (canonical || '').trim().toLowerCase();
        if (!normalizedCanonical) {
            throw new Error('canonical is required');
        }
        return path.join(root, DOMAIN_DOCS_DIR, `${normalizedCanonical}.md`);
    }

    /**
     * Build default domain document template with fixed AUTO/HUMAN marker blocks.
     */
    buildInitialTemplate(canonical: string, displayName: string): string {
        const now = new Date().toISOString();
        return [
            '---',
            `domain: ${canonical}`,
            `displayName: ${displayName || canonical}`,
            `lastUpdatedAt: ${now}`,
            'contributingIterations: []',
            '---',
            '',
            '## 领域概述',
            `<!-- ${MARKER_HUMAN_OVERVIEW}:start -->`,
            '待补充。',
            `<!-- ${MARKER_HUMAN_OVERVIEW}:end -->`,
            '',
            '## 能力清单',
            `<!-- ${MARKER_AUTO_CAPABILITIES}:start -->`,
            this.renderCapabilityRows([]),
            `<!-- ${MARKER_AUTO_CAPABILITIES}:end -->`,
            '',
            '## API 契约',
            `<!-- ${MARKER_AUTO_CONTRACTS}:start -->`,
            this.renderContractRows([]),
            `<!-- ${MARKER_AUTO_CONTRACTS}:end -->`,
            '',
            '## 关键规则与不变量',
            `<!-- ${MARKER_AUTO_INVARIANTS}:start -->`,
            this.renderInvariantRows([]),
            `<!-- ${MARKER_AUTO_INVARIANTS}:end -->`,
            '',
            '## 补充说明',
            `<!-- ${MARKER_HUMAN_NOTES}:start -->`,
            '待补充。',
            `<!-- ${MARKER_HUMAN_NOTES}:end -->`,
            '',
            '## 变更历史',
            `<!-- ${MARKER_AUTO_CHANGELOG}:start -->`,
            '- 初始化',
            `<!-- ${MARKER_AUTO_CHANGELOG}:end -->`,
            '',
        ].join('\n');
    }

    /**
     * Ensure all required marker blocks exist before AUTO-only updates are applied.
     */
    private assertTemplateMarkers(content: string): void {
        const requiredMarkers = [
            MARKER_HUMAN_OVERVIEW,
            MARKER_HUMAN_NOTES,
            MARKER_AUTO_CAPABILITIES,
            MARKER_AUTO_CONTRACTS,
            MARKER_AUTO_INVARIANTS,
            MARKER_AUTO_CHANGELOG,
        ];

        for (const marker of requiredMarkers) {
            if (!hasMarkedBlock(content, marker)) {
                throw new Error(`Missing required marker block: ${marker}`);
            }
        }
    }

    /**
     * Extract raw body text from one marker block.
     */
    private extractMarkedBody(content: string, markerName: string): string {
        const begin = `<!-- ${markerName}:start -->`;
        const end = `<!-- ${markerName}:end -->`;
        const normalized = content.replace(/\r\n/g, '\n');
        const startIndex = normalized.indexOf(begin);
        const endIndex = normalized.indexOf(end);
        if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
            throw new Error(`Missing marker block: ${markerName}`);
        }
        return normalized.slice(startIndex + begin.length, endIndex).trim();
    }

    /**
     * Merge capability rows by Req-ID as stable upsert key.
     */
    private mergeCapabilityRows(existingRows: CapabilityRow[], incomingRows: CapabilityDeltaItem[], iteration: string): CapabilityRow[] {
        const map = new Map<string, CapabilityRow>();
        for (const row of existingRows) {
            map.set(row.reqId, row);
        }
        for (const item of incomingRows) {
            const current = map.get(item.reqId);
            if (!current) {
                map.set(item.reqId, {
                    reqId: item.reqId,
                    title: item.title,
                    status: item.status,
                    firstIntroduced: iteration,
                    lastChanged: iteration,
                });
                continue;
            }
            map.set(item.reqId, {
                ...current,
                title: item.title,
                status: item.status,
                lastChanged: iteration,
            });
        }
        return Array.from(map.values()).sort((left, right) => left.reqId.localeCompare(right.reqId));
    }

    /**
     * Apply optional AI title refinement while preserving structured capability keys.
     */
    private applyOptionalAiRefinement(
        domainDelta: DomainDelta,
        registry: DomainRegistry,
        registryEntry: DomainRegistryEntry,
        enableAiRefinement: boolean,
    ): DomainDelta {
        if (!enableAiRefinement || !this.domainSummaryAiRefiner) {
            return domainDelta;
        }
        if (domainDelta.capabilities.length === 0) {
            return domainDelta;
        }

        const prompt = PromptService.buildDomainSummaryPrompt({
            canonical: registryEntry.canonical,
            displayName: registryEntry.displayName,
            capabilities: domainDelta.capabilities.map(item => ({
                reqId: item.reqId,
                title: item.title,
                status: item.status,
            })),
            registryCanonicals: registry.domains.map(item => item.canonical),
        });

        let responseText = '';
        try {
            responseText = (this.domainSummaryAiRefiner(prompt) || '').trim();
        } catch {
            return domainDelta;
        }
        if (!responseText) {
            return domainDelta;
        }

        const refinedTitles = this.parseRefinedCapabilityTitles(responseText, domainDelta.capabilities);
        if (refinedTitles.size === 0) {
            return domainDelta;
        }

        return {
            ...domainDelta,
            capabilities: domainDelta.capabilities.map(item => {
                const refinedTitle = refinedTitles.get(item.reqId);
                if (!refinedTitle) {
                    return item;
                }
                return {
                    ...item,
                    title: refinedTitle,
                };
            }),
        };
    }

    /**
     * Parse AI response and keep only reqId/title updates for existing capability rows.
     */
    private parseRefinedCapabilityTitles(
        responseText: string,
        sourceCapabilities: CapabilityDeltaItem[],
    ): Map<string, string> {
        const knownReqIds = new Set(sourceCapabilities.map(item => item.reqId));
        const rawJson = this.extractJsonObject(responseText);
        if (!rawJson) {
            return new Map<string, string>();
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawJson);
        } catch {
            return new Map<string, string>();
        }

        if (!parsed || typeof parsed !== 'object') {
            return new Map<string, string>();
        }
        const capabilities = (parsed as { capabilities?: unknown }).capabilities;
        if (!Array.isArray(capabilities)) {
            return new Map<string, string>();
        }

        const result = new Map<string, string>();
        for (const item of capabilities) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const reqId = String((item as { reqId?: unknown }).reqId || '').trim();
            const title = String((item as { title?: unknown }).title || '').trim();
            if (!reqId || !title) {
                continue;
            }
            if (!knownReqIds.has(reqId)) {
                continue;
            }
            result.set(reqId, title);
        }

        return result;
    }

    /**
     * Extract the first JSON object from plain text or fenced markdown response.
     */
    private extractJsonObject(text: string): string | null {
        const trimmed = (text || '').trim();
        if (!trimmed) {
            return null;
        }
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced && fenced[1]) {
            return fenced[1].trim();
        }
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        return trimmed.slice(start, end + 1).trim();
    }

    /**
     * Merge contract rows by method+path as stable upsert key.
     */
    private mergeContractRows(existingRows: ContractRow[], incomingRows: ContractDeltaItem[]): ContractRow[] {
        const map = new Map<string, ContractRow>();
        for (const row of existingRows) {
            map.set(this.contractRowKey(row.method, row.routePath), row);
        }
        for (const item of incomingRows) {
            const key = this.contractRowKey(item.method, item.path);
            map.set(key, {
                key,
                reqId: item.reqId,
                method: item.method,
                routePath: item.path,
                request: this.toOneLineJson(item.requestShape),
                response: this.toOneLineJson(item.responseShape),
            });
        }
        return Array.from(map.values()).sort((left, right) => left.key.localeCompare(right.key));
    }

    /**
     * Merge invariant rows by invariant id and keep deterministic order.
     */
    private mergeInvariantRows(existingRows: InvariantRow[], incomingRows: InvariantDeltaItem[]): InvariantRow[] {
        const map = new Map<string, InvariantRow>();
        for (const row of existingRows) {
            map.set(row.id, row);
        }
        for (const item of incomingRows) {
            map.set(item.id, {
                id: item.id,
                reqId: item.reqId,
                text: item.text,
            });
        }
        return Array.from(map.values()).sort((left, right) => left.id.localeCompare(right.id));
    }

    /**
     * Parse capability markdown table back into typed rows.
     */
    private parseCapabilityRows(content: string): CapabilityRow[] {
        const rows = this.parseMarkdownTable(content);
        return rows
            .filter(row => (row['Req-ID'] || '').trim().length > 0)
            .map(row => ({
                reqId: row['Req-ID'] || '',
                title: row['Title'] || '',
                status: row['Status'] || 'active',
                firstIntroduced: row['First Introduced'] || '',
                lastChanged: row['Last Changed'] || '',
            }));
    }

    /**
     * Parse contract markdown table back into typed rows.
     */
    private parseContractRows(content: string): ContractRow[] {
        const rows = this.parseMarkdownTable(content);
        return rows
            .filter(row => (row['Key'] || '').trim().length > 0)
            .map(row => ({
                key: row['Key'] || '',
                reqId: row['Req-ID'] || '',
                method: row['Method'] || '',
                routePath: row['Path'] || '',
                request: row['Request'] || '{}',
                response: row['Response'] || '{}',
            }));
    }

    /**
     * Parse invariants bullet list into typed rows.
     */
    private parseInvariantRows(content: string): InvariantRow[] {
        const lines = content.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
        const rows: InvariantRow[] = [];
        for (const line of lines) {
            const match = line.match(/^-\s*\[(.+?)\]\s*\((.+?)\)\s*(.+)$/);
            if (!match) {
                continue;
            }
            rows.push({
                id: match[1].trim(),
                reqId: match[2].trim(),
                text: match[3].trim(),
            });
        }
        return rows;
    }

    /**
     * Parse markdown table with first row as header.
     */
    private parseMarkdownTable(content: string): Array<Record<string, string>> {
        const lines = content
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('|') && line.endsWith('|'));

        if (lines.length < 2) {
            return [];
        }

        const headers = this.parseMarkdownRow(lines[0]);
        const result: Array<Record<string, string>> = [];
        for (let index = 2; index < lines.length; index += 1) {
            const values = this.parseMarkdownRow(lines[index]);
            const row: Record<string, string> = {};
            for (let i = 0; i < headers.length; i += 1) {
                row[headers[i]] = values[i] || '';
            }
            result.push(row);
        }
        return result;
    }

    /**
     * Parse one markdown table row to cell values.
     */
    private parseMarkdownRow(line: string): string[] {
        const body = line.slice(1, -1);
        return body.split('|').map(cell => cell.trim());
    }

    /**
     * Render capability rows as markdown table.
     */
    private renderCapabilityRows(rows: CapabilityRow[]): string {
        const output = [
            '| Req-ID | Title | Status | First Introduced | Last Changed |',
            '| --- | --- | --- | --- | --- |',
        ];
        for (const row of rows) {
            output.push(`| ${this.escapeCell(row.reqId)} | ${this.escapeCell(row.title)} | ${this.escapeCell(row.status)} | ${this.escapeCell(row.firstIntroduced)} | ${this.escapeCell(row.lastChanged)} |`);
        }
        return output.join('\n');
    }

    /**
     * Render contract rows as markdown table.
     */
    private renderContractRows(rows: ContractRow[]): string {
        const output = [
            '| Key | Req-ID | Method | Path | Request | Response |',
            '| --- | --- | --- | --- | --- | --- |',
        ];
        for (const row of rows) {
            output.push(`| ${this.escapeCell(row.key)} | ${this.escapeCell(row.reqId)} | ${this.escapeCell(row.method)} | ${this.escapeCell(row.routePath)} | ${this.escapeCell(row.request)} | ${this.escapeCell(row.response)} |`);
        }
        return output.join('\n');
    }

    /**
     * Render invariant rows as markdown bullet list.
     */
    private renderInvariantRows(rows: InvariantRow[]): string {
        if (rows.length === 0) {
            return '- 暂无';
        }
        return rows.map(row => `- [${row.id}] (${row.reqId}) ${row.text}`).join('\n');
    }

    /**
     * Append one changelog entry for current iteration while avoiding exact duplicates.
     */
    private appendChangelogEntry(
        currentBody: string,
        iteration: string,
        timestamp: string,
        capabilityCount: number,
        contractCount: number,
        invariantCount: number,
    ): string {
        const normalized = currentBody.replace(/\r\n/g, '\n').trim();
        const lines = normalized ? normalized.split('\n').map(line => line.trim()).filter(Boolean) : [];
        const summary = `- ${timestamp} | ${iteration} | capabilities=${capabilityCount}, contracts=${contractCount}, invariants=${invariantCount}`;
        if (lines.includes(summary)) {
            return lines.join('\n');
        }
        lines.push(summary);
        return lines.join('\n');
    }

    /**
     * Update domain document front matter values in place.
     */
    private updateFrontMatter(
        content: string,
        payload: { domain: string; displayName: string; lastUpdatedAt: string; contributingIterations: string[] },
    ): string {
        const normalized = content.replace(/\r\n/g, '\n');
        const match = normalized.match(/^---\n([\s\S]*?)\n---\n/);
        if (!match || typeof match.index !== 'number') {
            throw new Error('Missing front matter block');
        }

        const nextFrontMatter = [
            '---',
            `domain: ${payload.domain}`,
            `displayName: ${payload.displayName}`,
            `lastUpdatedAt: ${payload.lastUpdatedAt}`,
            `contributingIterations: [${payload.contributingIterations.join(', ')}]`,
            '---',
        ].join('\n');

        return `${nextFrontMatter}${normalized.slice(match.index + match[0].length - 1)}`;
    }

    /**
     * Merge existing contributing iterations with current one in deterministic order.
     */
    private mergeFrontMatterIterations(content: string, iteration: string): string[] {
        const normalized = content.replace(/\r\n/g, '\n');
        const match = normalized.match(/contributingIterations:\s*\[(.*?)\]/);
        const iterations = new Set<string>();
        if (match) {
            const raw = (match[1] || '').trim();
            if (raw) {
                for (const token of raw.split(',')) {
                    const value = token.trim();
                    if (value) {
                        iterations.add(value);
                    }
                }
            }
        }
        iterations.add(iteration);
        return Array.from(iterations.values()).sort((left, right) => left.localeCompare(right));
    }

    /**
     * Build stable upsert key for contract rows.
     */
    private contractRowKey(method: string, routePath: string): string {
        return `${(method || '').trim().toUpperCase()} ${(routePath || '').trim()}`;
    }

    /**
     * Serialize object to one-line JSON for markdown table storage.
     */
    private toOneLineJson(value: Record<string, unknown>): string {
        return JSON.stringify(value || {});
    }

    /**
     * Escape markdown table cell delimiters and line breaks.
     */
    private escapeCell(value: string): string {
        return (value || '').replace(/\|/g, '\\|').replace(/\n/g, '<br/>').trim();
    }
}
