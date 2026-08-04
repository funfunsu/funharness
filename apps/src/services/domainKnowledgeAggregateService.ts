import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    CapabilityDelta,
    CapabilityDeltaItem,
    CommitSummary,
    ContractDeltaItem,
    DomainBaselineSnapshot,
    DomainCapabilityRecord,
    DomainChangeSet,
    DomainConflictResolution,
    DomainContractRecord,
    DomainDelta,
    DomainInvariantRecord,
    DomainKnowledgeContext,
    DomainRegistry,
    DomainRegistryEntry,
    DomainRevisionSet,
    InvariantDeltaItem,
} from '../models';
import {
    hasMarkedBlock,
    readTextIfExists,
    replaceMarkedBlockStrict,
    writeTextAtomic,
    writeTextAtomicMulti,
    AtomicWriteEntry,
} from './fileOps';
import { MergeConflictService } from './mergeConflictService';
import { CapabilityDeltaService } from './capabilityDeltaService';
import { DomainRegistryService } from './domainRegistryService';
import { PromptService } from './promptService';
import { assertPathInRepoRoot, normalizeAndValidateRepoRoot } from './workspaceRoot';

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
     * Validate all fields of a DomainChangeSet before it enters any write path.
     * Returns a list of field-level error messages; an empty array means the input is valid.
     * Binds INV-9, Req-6, Req-7.
     */
    validateDomainChangeSetInput(changeSet: DomainChangeSet): string[] {
        const errors: string[] = [];
        const reqIdPattern = /^Req-\d+$/;
        const iterationIdPattern = /^[A-Za-z0-9_\-./\u4e00-\u9fff]+$/;

        if (!changeSet.iterationId || !iterationIdPattern.test((changeSet.iterationId || '').trim())) {
            errors.push('DOMAIN_INPUT_INVALID: iterationId must be a non-empty alphanumeric identifier');
        }
        if (!changeSet.basedOnBaselineVersion || !(changeSet.basedOnBaselineVersion || '').trim()) {
            errors.push('DOMAIN_INPUT_INVALID: basedOnBaselineVersion must not be empty');
        }
        if (!changeSet.updatedAt || !(changeSet.updatedAt || '').trim()) {
            errors.push('DOMAIN_INPUT_INVALID: updatedAt must not be empty');
        }

        const seenReqIds = new Set<string>();
        for (const change of changeSet.domainChanges || []) {
            const reqId = (change.reqId || '').trim();
            if (!reqId || !reqIdPattern.test(reqId)) {
                errors.push(`DOMAIN_INPUT_INVALID: domainChange.reqId "${change.reqId}" must match Req-<number>`);
            } else if (seenReqIds.has(reqId)) {
                errors.push(`DOMAIN_INPUT_INVALID: duplicate reqId "${reqId}" in domainChanges (capability-key conflict)`);
            } else {
                seenReqIds.add(reqId);
            }

            if (!change.changeType || !['add', 'update', 'deprecate', 'remove', 'move'].includes(change.changeType)) {
                errors.push(`DOMAIN_INPUT_INVALID: domainChange.changeType "${change.changeType}" is not a valid value`);
            }
            if (!change.status || !['active', 'deprecated', 'removed'].includes(change.status)) {
                errors.push(`DOMAIN_INPUT_INVALID: domainChange.status "${change.status}" is not a valid value`);
            }

            for (const contract of change.contracts || []) {
                const contractReqId = (contract.reqId || '').trim();
                if (!contractReqId || !reqIdPattern.test(contractReqId)) {
                    errors.push(`DOMAIN_INPUT_INVALID: contract.reqId "${contract.reqId}" must match Req-<number>`);
                }
                if (!(contract.path || '').trim()) {
                    errors.push(`DOMAIN_INPUT_INVALID: contract.path must not be empty`);
                }
            }

            for (const invariant of change.invariants || []) {
                const invReqId = (invariant.reqId || '').trim();
                if (!invReqId || !reqIdPattern.test(invReqId)) {
                    errors.push(`DOMAIN_INPUT_INVALID: invariant.reqId "${invariant.reqId}" must match Req-<number>`);
                }
                if (!(invariant.text || '').trim()) {
                    errors.push(`DOMAIN_INPUT_INVALID: invariant.text must not be empty`);
                }
            }
        }

        return errors;
    }

    /**
     * Load the complete domain knowledge context for the subpanel: registry snapshot,
     * baseline snapshots for all active domains, and the current iteration draft change set.
     * Implements API-2. Binds Req-1, Req-2, Req-7.
     */
    loadDomainKnowledgeContext(repoRoot: string, iterationId: string): DomainKnowledgeContext {
        const normalizedRoot = normalizeAndValidateRepoRoot(repoRoot);
        const trimmedIterationId = (iterationId || '').trim();
        if (!trimmedIterationId) {
            throw new Error('DOMAIN_WORKSPACE_LOAD_FAILED: iterationId must not be empty');
        }

        // Load registry and validate. Binds Req-4, Req-7.
        const registryLoad = this.domainRegistryService.loadRegistry(normalizedRoot);
        if (registryLoad.validationErrors.length > 0) {
            const detail = registryLoad.validationErrors.map(e => e.message).join('; ');
            throw new Error(`DOMAIN_REGISTRY_INVALID: ${detail}`);
        }

        // Compute revision anchors for concurrent-write detection. Binds Req-4, Req-8.
        const revisions = this.computeRevisionSet(normalizedRoot, registryLoad.registry);

        // Build baseline snapshots for all active domains. Binds Req-2, Req-4.
        const baselineSnapshot = this.buildBaselineSnapshots(normalizedRoot, registryLoad.registry);

        // Derive a stable baselineVersion from sorted domain doc revision hashes. Binds Req-2, Req-8.
        const baselineVersion = this.deriveBaselineVersion(revisions);

        // Load or initialize draft change set. Binds Req-2, Req-6, Req-8.
        const draftChangeSet = this.loadOrInitDraftChangeSet(
            normalizedRoot,
            trimmedIterationId,
            baselineVersion,
            revisions,
        );

        return {
            baselineVersion,
            registry: { domains: registryLoad.registry.domains },
            baselineSnapshot,
            draftChangeSet,
        };
    }

    /**
     * Compute file revision anchors (short SHA-256 hashes) for registry, index and each domain doc.
     * Binds Req-4, Req-8.
     */
    private computeRevisionSet(repoRoot: string, registry: DomainRegistry): DomainRevisionSet {
        const registryPath = this.domainRegistryService.resolveRegistryPath(repoRoot);
        const registryRevision = this.hashFile(registryPath);

        const indexPath = path.join(repoRoot, 'docs', 'domains', '_index.md');
        const indexRevision = this.hashFile(indexPath);

        const domainDocRevisions: Record<string, string> = {};
        for (const entry of registry.domains) {
            if (entry.status === 'active') {
                const docPath = this.resolveDomainDocPath(repoRoot, entry.canonical);
                domainDocRevisions[entry.canonical] = this.hashFile(docPath);
            }
        }

        return { registryRevision, indexRevision, domainDocRevisions };
    }

    /**
     * Build DomainBaselineSnapshot[] by reading and parsing each active domain document.
     * Domains without an existing document get an empty snapshot. Binds Req-2, Req-4.
     */
    private buildBaselineSnapshots(repoRoot: string, registry: DomainRegistry): DomainBaselineSnapshot[] {
        const snapshots: DomainBaselineSnapshot[] = [];
        for (const entry of registry.domains) {
            if (entry.status !== 'active') {
                continue;
            }
            const docPath = this.resolveDomainDocPath(repoRoot, entry.canonical);
            const content = readTextIfExists(docPath);
            if (!content) {
                snapshots.push({
                    canonicalDomain: entry.canonical,
                    version: 'v0',
                    capabilities: [],
                    contracts: [],
                    invariants: [],
                });
                continue;
            }

            const version = this.extractFrontMatterField(content, 'version') || 'v0';
            const capabilities: DomainCapabilityRecord[] = this.parseCapabilityRows(
                this.extractMarkedBody(content, MARKER_AUTO_CAPABILITIES),
            ).map(row => ({
                reqId: row.reqId,
                title: row.title,
                userStory: '',
                status: row.status === 'deprecated' ? 'deprecated' : row.status === 'removed' ? 'removed' : 'active',
            }));
            const contracts: DomainContractRecord[] = this.parseContractRows(
                this.extractMarkedBody(content, MARKER_AUTO_CONTRACTS),
            ).map(row => ({
                id: row.key,
                reqId: row.reqId,
                method: row.method,
                path: row.routePath,
                requestShape: this.parseJsonShape(row.request),
                responseShape: this.parseJsonShape(row.response),
            }));
            const invariants: DomainInvariantRecord[] = this.parseInvariantRows(
                this.extractMarkedBody(content, MARKER_AUTO_INVARIANTS),
            ).map(row => ({
                id: row.id,
                reqId: row.reqId,
                text: row.text,
            }));

            snapshots.push({ canonicalDomain: entry.canonical, version, capabilities, contracts, invariants });
        }
        return snapshots.sort((a, b) => a.canonicalDomain.localeCompare(b.canonicalDomain));
    }

    /**
     * Derive a stable baseline version string from the sorted domain doc revision hashes.
     * Same revision set always produces the same version. Binds Req-2, Req-8.
     */
    private deriveBaselineVersion(revisions: DomainRevisionSet): string {
        const parts = [revisions.registryRevision, revisions.indexRevision];
        const sortedDomains = Object.keys(revisions.domainDocRevisions).sort();
        for (const domain of sortedDomains) {
            parts.push(`${domain}:${revisions.domainDocRevisions[domain]}`);
        }
        return `v-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`;
    }

    /**
     * Load draft change set from `specs/<iterationId>/delta/domain-change-set.json` when present,
     * otherwise return an initialized empty change set. Binds Req-2, Req-6, Req-8.
     */
    private loadOrInitDraftChangeSet(
        repoRoot: string,
        iterationId: string,
        baselineVersion: string,
        revisions: DomainRevisionSet,
    ): DomainChangeSet {
        const draftPath = path.join(repoRoot, 'specs', iterationId, 'delta', 'domain-change-set.json');
        assertPathInRepoRoot(repoRoot, draftPath);
        if (fs.existsSync(draftPath)) {
            try {
                const raw = fs.readFileSync(draftPath, 'utf8');
                const parsed: DomainChangeSet = JSON.parse(raw);
                // If draft is empty, prefer bootstrapping from capability-delta when available.
                if (!Array.isArray(parsed.domainChanges) || parsed.domainChanges.length === 0) {
                    const seededFromDelta = this.trySeedDraftFromCapabilityDelta(
                        repoRoot,
                        iterationId,
                        baselineVersion,
                        revisions,
                    );
                    if (seededFromDelta && seededFromDelta.domainChanges.length > 0) {
                        return seededFromDelta;
                    }
                }
                // Return existing draft as-is; caller (subpanel) will detect version drift.
                return parsed;
            } catch {
                // Corrupted draft: fall through to empty initialization.
            }
        }

        // Bootstrap from capability-delta when user has just generated delta but has no draft yet.
        const seededFromDelta = this.trySeedDraftFromCapabilityDelta(
            repoRoot,
            iterationId,
            baselineVersion,
            revisions,
        );
        if (seededFromDelta) {
            return seededFromDelta;
        }

        return {
            iterationId,
            basedOnBaselineVersion: baselineVersion,
            sourceRevisionSet: revisions,
            updatedAt: new Date().toISOString(),
            domainChanges: [],
        };
    }

    /**
     * Try building an initial DomainChangeSet from capability-delta.json when draft is missing.
     * This is read-only bootstrap logic and does not write files.
     */
    private trySeedDraftFromCapabilityDelta(
        repoRoot: string,
        iterationId: string,
        baselineVersion: string,
        revisions: DomainRevisionSet,
    ): DomainChangeSet | null {
        const candidates = [
            path.join(repoRoot, 'specs', iterationId, 'delta', 'capability-delta.json'),
            path.join(repoRoot, 'worktrees', iterationId, 'delta', 'capability-delta.json'),
            path.join(repoRoot, 'delta', 'capability-delta.json'),
        ];

        for (const candidate of candidates) {
            try {
                assertPathInRepoRoot(repoRoot, candidate);
                if (!fs.existsSync(candidate)) {
                    continue;
                }
                const raw = fs.readFileSync(candidate, 'utf8');
                const parsed = JSON.parse(raw) as CapabilityDelta;
                if (!parsed || !Array.isArray(parsed.domains)) {
                    continue;
                }

                const seenReqIds = new Set<string>();
                const domainChanges: DomainChangeSet['domainChanges'] = [];

                for (const domain of parsed.domains) {
                    const rawDomain = (domain.rawDomain || domain.canonical || 'uncategorized').trim() || 'uncategorized';
                    const canonicalDomain = domain.canonical || null;
                    const contracts = Array.isArray(domain.contracts) ? domain.contracts : [];
                    const invariants = Array.isArray(domain.invariants) ? domain.invariants : [];

                    for (const capability of Array.isArray(domain.capabilities) ? domain.capabilities : []) {
                        const reqId = (capability.reqId || '').trim();
                        if (!reqId || seenReqIds.has(reqId)) {
                            continue;
                        }
                        seenReqIds.add(reqId);

                        const capabilityStatus = capability.status === 'deprecated'
                            ? 'deprecated'
                            : capability.status === 'removed'
                                ? 'removed'
                                : 'active';
                        const changeType = capabilityStatus === 'deprecated'
                            ? 'deprecate'
                            : capabilityStatus === 'removed'
                                ? 'remove'
                                : 'add';

                        domainChanges.push({
                            canonicalDomain,
                            rawDomain,
                            reqId,
                            title: (capability.title || '').trim(),
                            userStory: (capability.userStory || '').trim(),
                            changeType,
                            status: capabilityStatus,
                            contracts: contracts
                                .filter(item => (item.reqId || '').trim() === reqId)
                                .map(item => ({
                                    id: (item.id || '').trim(),
                                    reqId,
                                    method: (item.method || '').trim().toUpperCase(),
                                    path: (item.path || '').trim(),
                                    requestShape: item.requestShape || {},
                                    responseShape: item.responseShape || {},
                                })),
                            invariants: invariants
                                .filter(item => (item.reqId || '').trim() === reqId)
                                .map(item => ({
                                    id: (item.id || '').trim(),
                                    reqId,
                                    text: (item.text || '').trim(),
                                })),
                        });
                    }
                }

                domainChanges.sort((a, b) => a.reqId.localeCompare(b.reqId));

                return {
                    iterationId,
                    basedOnBaselineVersion: baselineVersion,
                    sourceRevisionSet: revisions,
                    updatedAt: new Date().toISOString(),
                    domainChanges,
                };
            } catch {
                // Ignore invalid candidate file and continue fallback chain.
            }
        }

        return null;
    }

    /**
     * Compute a short SHA-256 hash of a file's contents for revision tracking.
     * Returns empty string when the file does not exist.
     */
    private hashFile(filePath: string): string {
        if (!fs.existsSync(filePath)) {
            return '';
        }
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    /**
     * Extract the value of a front-matter field (`fieldName: value`) from document content.
     */
    private extractFrontMatterField(content: string, fieldName: string): string | null {
        const match = content.replace(/\r\n/g, '\n').match(
            new RegExp(`^${fieldName}:\\s*(.+)$`, 'm'),
        );
        return match ? match[1].trim() : null;
    }

    /**
     * Attempt to parse a JSON shape string; return empty object on failure.
     */
    private parseJsonShape(raw: string): Record<string, unknown> {
        try {
            const parsed = JSON.parse((raw || '').trim() || '{}');
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Fall through
        }
        return {};
    }

    /**
     * Validate and persist the current iteration's domain change set draft to disk.
     * Returns the saved draft and a dirty flag indicating whether content changed.
     * Implements API-3. Binds Req-2, Req-6, Req-7.
     */
    saveDraftChangeSet(
        repoRoot: string,
        iterationId: string,
        changeSet: DomainChangeSet,
    ): { savedDraft: DomainChangeSet; dirty: boolean } {
        const normalizedRoot = normalizeAndValidateRepoRoot(repoRoot);
        const trimmedIterationId = (iterationId || '').trim();
        if (!trimmedIterationId) {
            throw new Error('DOMAIN_INPUT_INVALID: iterationId must not be empty');
        }

        // Validate all fields before persisting. Binds INV-9, Req-6.
        const validationErrors = this.validateDomainChangeSetInput(changeSet);
        if (validationErrors.length > 0) {
            throw new Error(validationErrors[0]);
        }

        const draftPath = path.join(normalizedRoot, 'specs', trimmedIterationId, 'delta', 'domain-change-set.json');
        assertPathInRepoRoot(normalizedRoot, draftPath);

        // Detect dirty state: compare content hash with existing draft. Binds Req-8.
        const savedDraft: DomainChangeSet = {
            ...changeSet,
            updatedAt: new Date().toISOString(),
        };
        const newContent = JSON.stringify(savedDraft, null, 2);
        let dirty = true;
        if (fs.existsSync(draftPath)) {
            try {
                const existingContent = fs.readFileSync(draftPath, 'utf8');
                const existing: DomainChangeSet = JSON.parse(existingContent);
                // Compare semantically: same changes mean not dirty.
                const existingHash = crypto.createHash('sha256')
                    .update(JSON.stringify({ ...existing, updatedAt: '' }))
                    .digest('hex');
                const newHash = crypto.createHash('sha256')
                    .update(JSON.stringify({ ...savedDraft, updatedAt: '' }))
                    .digest('hex');
                dirty = existingHash !== newHash;
            } catch {
                dirty = true;
            }
        }

        writeTextAtomic(draftPath, newContent);
        return { savedDraft, dirty };
    }

    /**
     * Compute a deterministic baseline projection from a change set and baseline snapshots.
     * Pure function: no file writes, same inputs always produce same output.
     * Implements API-4. Binds Req-2, Req-4, Req-8.
     */
    previewProjection(
        changeSet: DomainChangeSet,
        baselineVersion: string,
        baselineSnapshot: DomainBaselineSnapshot[],
        registry: import('../models').DomainRegistrySnapshot,
    ): import('../models').DomainProjectionResult {
        const conflicts: import('../models').DomainConflict[] = [];
        const warnings: string[] = [];

        // Build a mutable copy of baseline indexed by canonicalDomain.
        const baselineMap = new Map<string, DomainBaselineSnapshot>();
        for (const snap of baselineSnapshot) {
            baselineMap.set(snap.canonicalDomain, {
                ...snap,
                capabilities: [...snap.capabilities],
                contracts: [...snap.contracts],
                invariants: [...snap.invariants],
            });
        }

        // Track Req-* keys across the change set for capability-key conflict detection. Binds Req-4.
        const reqIdToCanonical = new Map<string, string>();

        for (const change of changeSet.domainChanges) {
            const reqId = (change.reqId || '').trim();

            // Verify canonical domain mapping. Binds Req-4, Req-5.
            let canonicalDomain = (change.canonicalDomain || '').trim();
            if (!canonicalDomain) {
                const resolved = this.domainRegistryService.normalizeDomainCanonical(
                    change.rawDomain,
                    registry,
                );
                if (!resolved.canonical) {
                    conflicts.push({
                        id: `domain-name:${reqId}`,
                        type: 'domain-name',
                        severity: 'blocking',
                        reqIds: [reqId],
                        message: `无法将 "${change.rawDomain}" 唯一映射到注册表 canonical 领域`,
                    });
                    continue;
                }
                canonicalDomain = resolved.canonical;
            }

            // Detect capability-key (Req-* primary key) conflicts across the change set. Binds Req-4.
            if (reqId) {
                const existingCanonical = reqIdToCanonical.get(reqId);
                if (existingCanonical && existingCanonical !== canonicalDomain) {
                    conflicts.push({
                        id: `capability-key:${reqId}`,
                        type: 'capability-key',
                        severity: 'blocking',
                        reqIds: [reqId],
                        message: `Req-ID "${reqId}" 同时出现在领域 "${existingCanonical}" 与 "${canonicalDomain}"，存在能力主键冲突`,
                    });
                }
                reqIdToCanonical.set(reqId, canonicalDomain);
            }

            // Ensure we have a projected snapshot for this domain.
            if (!baselineMap.has(canonicalDomain)) {
                baselineMap.set(canonicalDomain, {
                    canonicalDomain,
                    version: 'v0',
                    capabilities: [],
                    contracts: [],
                    invariants: [],
                });
            }
            const snap = baselineMap.get(canonicalDomain)!;

            // Apply capability change. Binds Req-2.
            if (change.changeType === 'remove') {
                snap.capabilities = snap.capabilities.filter(c => c.reqId !== reqId);
            } else {
                const existingIdx = snap.capabilities.findIndex(c => c.reqId === reqId);
                const capRecord: DomainCapabilityRecord = {
                    reqId,
                    title: change.title || '',
                    userStory: change.userStory || '',
                    status: change.changeType === 'deprecate' ? 'deprecated' : 'active',
                };
                if (existingIdx >= 0) {
                    snap.capabilities[existingIdx] = capRecord;
                } else {
                    snap.capabilities.push(capRecord);
                }
            }

            // Apply contract changes.
            for (const contract of change.contracts || []) {
                const existingIdx = snap.contracts.findIndex(c => c.id === contract.id);
                const contractRecord: DomainContractRecord = {
                    id: contract.id,
                    reqId: contract.reqId,
                    method: contract.method,
                    path: contract.path,
                    requestShape: contract.requestShape,
                    responseShape: contract.responseShape,
                };
                if (existingIdx >= 0) {
                    snap.contracts[existingIdx] = contractRecord;
                } else {
                    snap.contracts.push(contractRecord);
                }
            }

            // Apply invariant changes.
            for (const invariant of change.invariants || []) {
                const existingIdx = snap.invariants.findIndex(i => i.id === invariant.id);
                const invRecord: DomainInvariantRecord = {
                    id: invariant.id,
                    reqId: invariant.reqId,
                    text: invariant.text,
                };
                if (existingIdx >= 0) {
                    snap.invariants[existingIdx] = invRecord;
                } else {
                    snap.invariants.push(invRecord);
                }
            }
        }

        // Detect baseline version mismatch. Binds Req-4, Req-8.
        if (changeSet.basedOnBaselineVersion !== baselineVersion) {
            conflicts.push({
                id: `baseline-version:${changeSet.iterationId}`,
                type: 'baseline-version',
                severity: 'blocking',
                reqIds: [],
                message: `变更集基线版本 "${changeSet.basedOnBaselineVersion}" 与当前基线 "${baselineVersion}" 不一致，需要同步基线并重投影`,
            });
        }

        // Build projected domain documents, sorted deterministically. Binds Req-2, Req-8.
        const projectedDomains: import('../models').ProjectedDomainDocument[] = Array.from(baselineMap.values())
            .sort((a, b) => a.canonicalDomain.localeCompare(b.canonicalDomain))
            .map(snap => ({
                canonicalDomain: snap.canonicalDomain,
                version: snap.version,
                capabilities: [...snap.capabilities].sort((a, b) => a.reqId.localeCompare(b.reqId)),
                contracts: [...snap.contracts].sort((a, b) => a.id.localeCompare(b.id)),
                invariants: [...snap.invariants].sort((a, b) => a.id.localeCompare(b.id)),
                markdownContent: '',
            }));

        return {
            baselineVersion,
            projectedDomains,
            conflicts,
            warnings,
        };
    }

    /**
     * Detect and classify all conflicts between a change set and the current baseline projection.
     * Returns at least domain-name, baseline-version, and capability-key conflicts.
     * Implements API-5. Binds Req-4, Req-5, Req-8.
     */
    detectConflicts(
        changeSet: DomainChangeSet,
        projection: import('../models').DomainProjectionResult,
        baselineVersion: string,
    ): { conflicts: import('../models').DomainConflict[]; blocking: boolean } {
        // Projection already accumulates domain-name, capability-key and baseline-version conflicts.
        const allConflicts: import('../models').DomainConflict[] = [...(projection.conflicts || [])];

        // Extra baseline-version check: if not already flagged by projection, add it here. Binds Req-4.
        const hasVersionConflict = allConflicts.some(c => c.type === 'baseline-version');
        if (!hasVersionConflict && changeSet.basedOnBaselineVersion !== baselineVersion) {
            allConflicts.push({
                id: `baseline-version:${changeSet.iterationId}`,
                type: 'baseline-version',
                severity: 'blocking',
                reqIds: [],
                message: `变更集基线版本 "${changeSet.basedOnBaselineVersion}" 与当前基线 "${baselineVersion}" 不一致，请先同步基线并重投影`,
            });
        }

        // Extra duplicate-reqId check within changeSet (capability-key). Binds Req-4, Req-6.
        const seenReqIds = new Map<string, number>();
        for (const change of changeSet.domainChanges || []) {
            const reqId = (change.reqId || '').trim();
            if (!reqId) {
                continue;
            }
            const count = (seenReqIds.get(reqId) || 0) + 1;
            seenReqIds.set(reqId, count);
            if (count === 2) {
                const alreadyFlagged = allConflicts.some(c => c.type === 'capability-key' && c.reqIds.includes(reqId));
                if (!alreadyFlagged) {
                    allConflicts.push({
                        id: `capability-key:dup:${reqId}`,
                        type: 'capability-key',
                        severity: 'blocking',
                        reqIds: [reqId],
                        message: `Req-ID "${reqId}" 在本次变更集中重复出现，存在能力主键冲突`,
                    });
                }
            }
        }

        const blocking = allConflicts.some(c => c.severity === 'blocking');
        return { conflicts: allConflicts, blocking };
    }

    /**
     * Detect three-way document merge conflicts by comparing base/current/draft domain documents.
     * Sections that cannot be auto-merged produce document-merge blocking conflicts.
     * Implements API-12. Binds Req-4, Req-5, Req-8.
     */
    detectDocumentMergeConflicts(
        baseDocuments: import('../models').ProjectedDomainDocument[],
        currentDocuments: import('../models').ProjectedDomainDocument[],
        draftDocuments: import('../models').ProjectedDomainDocument[],
    ): { conflicts: import('../models').DomainConflict[]; autoMergedDocuments: import('../models').ProjectedDomainDocument[] } {
        const mergeService = new MergeConflictService();
        return mergeService.detectDocumentMergeConflicts(baseDocuments, currentDocuments, draftDocuments);
    }

    /**
     * Atomically commit the domain change set to disk:
     * 1. Validate inputs and block if unresolved blocking conflicts exist (INV-5).
     * 2. Detect no-change and return idempotent result (INV-11).
     * 3. Build deterministic-v1 serialized domain documents (INV-14).
     * 4. Write all target files via writeTextAtomicMulti; roll back on any failure (INV-4).
     * 5. Return CommitSummary with processed counts. Implements API-7. Binds Req-3, Req-6, Req-8.
     */
    commitChangeSet(
        repoRoot: string,
        changeSet: DomainChangeSet,
        baselineVersion: string,
        expectedRevisions: DomainRevisionSet,
        autoRebase: boolean,
        formatPolicy: 'deterministic-v1',
        resolvedConflicts: DomainConflictResolution[],
    ): CommitSummary {
        const normalizedRoot = normalizeAndValidateRepoRoot(repoRoot);

        // Validate change set fields. Binds INV-9, Req-6.
        const fieldErrors = this.validateDomainChangeSetInput(changeSet);
        if (fieldErrors.length > 0) {
            throw new Error(fieldErrors[0]);
        }

        // Block commit if any blocking conflicts remain (INV-5). Binds Req-3, Req-4.
        // Re-project against the real on-disk registry + baseline so the commit gate
        // matches what conflict detection saw. Passing empty inputs would spuriously
        // fail canonical-domain resolution (e.g. "uncategorized") that detect accepted.
        const registryLoad = this.domainRegistryService.loadRegistry(normalizedRoot);
        const baselineSnapshot = this.buildBaselineSnapshots(normalizedRoot, registryLoad.registry);
        const projection = this.previewProjection(
            changeSet,
            baselineVersion,
            baselineSnapshot,
            registryLoad.registry,
        );
        const { conflicts: allConflicts, blocking } = this.detectConflicts(changeSet, projection, baselineVersion);
        if (blocking) {
            const blockingMessages = allConflicts
                .filter(c => c.severity === 'blocking')
                .map(c => c.message)
                .join('; ');
            throw new Error(`DOMAIN_COMMIT_BLOCKED: ${blockingMessages}`);
        }

        // No-change detection: compute canonical hash of stable change-set fields. Binds INV-11, Req-3.
        // updatedAt and sourceRevisionSet are volatile and excluded from the semantic hash.
        const changeHash = this.computeChangeSetHash(changeSet, formatPolicy);
        const draftPath = path.join(normalizedRoot, 'specs', changeSet.iterationId, 'delta', 'domain-change-set.json');
        assertPathInRepoRoot(normalizedRoot, draftPath);

        // Fast path: no domain changes → always return no-change without writing. Binds INV-11, Req-3.
        if ((changeSet.domainChanges || []).length === 0) {
            return {
                baselineVersion,
                rebased: false,
                processedDomains: 0,
                processedCapabilities: 0,
                skippedAsNoChange: true,
                canonicalSerializationHash: changeHash,
                commitId: changeHash,
                writtenFiles: [],
            };
        }

        // Idempotency check: if semantic content is identical to what's on disk, skip re-write. Binds INV-11.
        if (fs.existsSync(draftPath)) {
            try {
                const existingRaw = fs.readFileSync(draftPath, 'utf8');
                const existingHash = this.computeChangeSetHash(JSON.parse(existingRaw), formatPolicy);
                if (existingHash === changeHash) {
                    // Verify that domain docs on disk also match the projection.
                    const docsUnchanged = this.isDomainDocsContentEqual(normalizedRoot, projection);
                    if (docsUnchanged) {
                        return {
                            baselineVersion,
                            rebased: false,
                            processedDomains: 0,
                            processedCapabilities: 0,
                            skippedAsNoChange: true,
                            canonicalSerializationHash: changeHash,
                            commitId: changeHash,
                            writtenFiles: [],
                        };
                    }
                }
            } catch {
                // Hash check failure is non-fatal; proceed with write.
            }
        }

        // Build deterministic-v1 write plan. Binds INV-14, Req-3, Req-6.
        const writeEntries: AtomicWriteEntry[] = [];
        const writtenFilePaths: string[] = [];

        // 1. Iteration delta: domain-change-set.json
        const changeSetContent = JSON.stringify(
            this.sortChangeSetDeterministic(changeSet),
            null,
            2,
        );
        writeEntries.push({ filePath: draftPath, content: changeSetContent });

        // 2. Domain baseline documents per canonical domain.
        // Only write domains touched by this change set to avoid unrelated rewrites.
        const affectedCanonicals = this.resolveAffectedCanonicalDomains(changeSet, registryLoad.registry);
        const processedDomains: string[] = [];
        const processedCapabilities: number[] = [];
        for (const domainDoc of projection.projectedDomains) {
            if (!affectedCanonicals.has(domainDoc.canonicalDomain)) {
                continue;
            }
            const docPath = this.resolveDomainDocPath(normalizedRoot, domainDoc.canonicalDomain);
            assertPathInRepoRoot(normalizedRoot, docPath);
            const docContent = this.serializeDomainDocDeterministicV1(domainDoc);
            writeEntries.push({ filePath: docPath, content: docContent });
            processedDomains.push(domainDoc.canonicalDomain);
            processedCapabilities.push(domainDoc.capabilities.length);
        }

        // 3. Domain index (_index.md) update. Reuse the registry loaded above.
        const indexPath = path.join(normalizedRoot, 'docs', 'domains', '_index.md');
        assertPathInRepoRoot(normalizedRoot, indexPath);
        const existingIndex = readTextIfExists(indexPath) || this.buildInitialIndexTemplate();
        const updatedIndex = this.rebuildIndexContent(existingIndex, registryLoad.registry.domains, projection.projectedDomains);
        writeEntries.push({ filePath: indexPath, content: updatedIndex });

        // Atomic write all files. Throws AtomicWriteRollbackError on any failure. Binds INV-4.
        const written = writeTextAtomicMulti(writeEntries);
        writtenFilePaths.push(...written);

        const totalCapabilities = processedCapabilities.reduce((s, n) => s + n, 0);
        // commitId is deterministic for same semantic content (INV-11).
        const commitId = changeHash;

        return {
            baselineVersion,
            rebased: false,
            processedDomains: processedDomains.length,
            processedCapabilities: totalCapabilities,
            skippedAsNoChange: false,
            canonicalSerializationHash: changeHash,
            commitId,
            writtenFiles: writtenFilePaths,
        };
    }

    /**
     * Resolve canonical domains actually touched by this change set.
     */
    private resolveAffectedCanonicalDomains(
        changeSet: DomainChangeSet,
        registry: import('../models').DomainRegistrySnapshot,
    ): Set<string> {
        const canonicals = new Set<string>();
        for (const change of changeSet.domainChanges || []) {
            const explicitCanonical = (change.canonicalDomain || '').trim();
            if (explicitCanonical) {
                canonicals.add(explicitCanonical);
                continue;
            }
            const resolved = this.domainRegistryService.normalizeDomainCanonical(
                change.rawDomain,
                registry,
            );
            if (resolved.canonical) {
                canonicals.add(resolved.canonical);
            }
        }
        return canonicals;
    }

    /**
     * Compute a deterministic SHA-256 hash of the change set's stable semantic fields.
     * Excludes volatile fields (updatedAt, sourceRevisionSet) so same content always
     * produces the same hash regardless of when the set was last touched. Binds INV-11, INV-14.
     */
    private computeChangeSetHash(changeSet: DomainChangeSet, _formatPolicy: string): string {
        const stable = {
            iterationId: changeSet.iterationId,
            basedOnBaselineVersion: changeSet.basedOnBaselineVersion,
            domainChanges: [...(changeSet.domainChanges || [])].sort((a, b) => a.reqId.localeCompare(b.reqId)),
        };
        return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
    }

    /**
     * Return a deterministically sorted copy of the change set (domainChanges sorted by reqId).
     * Binds INV-14.
     */
    private sortChangeSetDeterministic(changeSet: DomainChangeSet): DomainChangeSet {
        return {
            ...changeSet,
            domainChanges: [...(changeSet.domainChanges || [])].sort((a, b) => a.reqId.localeCompare(b.reqId)),
        };
    }

    /**
     * Check whether the current domain doc content on disk matches the projected content.
     * Used for idempotency verification: if all docs are already at the projected state,
     * the commit can be skipped. Binds INV-11, INV-14.
     */
    private isDomainDocsContentEqual(
        repoRoot: string,
        projection: import('../models').DomainProjectionResult,
    ): boolean {
        for (const domainDoc of projection.projectedDomains) {
            const docPath = this.resolveDomainDocPath(repoRoot, domainDoc.canonicalDomain);
            const existing = readTextIfExists(docPath);
            if (!existing) {
                return false;
            }
            const expected = this.serializeDomainDocDeterministicV1(domainDoc);
            if (existing.replace(/\r\n/g, '\n').trim() !== expected.trim()) {
                return false;
            }
        }
        return true;
    }

    /**
     * Refresh the current baseline snapshot and re-project to detect drift.
     * Implements API-11. Binds Req-4, Req-5, Req-8.
     */
    refreshBaselineAndReproject(
        repoRoot: string,
        changeSet: DomainChangeSet,
        currentBaselineVersion: string,
        expectedRevisions: DomainRevisionSet,
    ): {
        rebased: boolean;
        latestBaselineVersion: string;
        latestRevisions: DomainRevisionSet;
        projection: import('../models').DomainProjectionResult;
    } {
        const normalizedRoot = normalizeAndValidateRepoRoot(repoRoot);

        // Reload latest registry and baseline snapshot from disk.
        const registryLoad = this.domainRegistryService.loadRegistry(normalizedRoot);
        if (registryLoad.validationErrors.length > 0) {
            const detail = registryLoad.validationErrors.map(e => e.message).join('; ');
            throw new Error(`DOMAIN_REGISTRY_INVALID: ${detail}`);
        }

        const latestRevisions = this.computeRevisionSet(normalizedRoot, registryLoad.registry);
        const baselineSnapshot = this.buildBaselineSnapshots(normalizedRoot, registryLoad.registry);
        const latestBaselineVersion = this.deriveBaselineVersion(latestRevisions);

        // Determine if a rebase occurred (any revision drifted). Binds Req-4, INV-12.
        const rebased = latestBaselineVersion !== currentBaselineVersion;

        // Re-project using the latest baseline snapshot. Binds Req-2, Req-4, INV-3.
        const projection = this.previewProjection(
            changeSet,
            latestBaselineVersion,
            baselineSnapshot,
            { domains: registryLoad.registry.domains },
        );

        return { rebased, latestBaselineVersion, latestRevisions, projection };
    }

    /**
     * Serialize a projected domain document to deterministic-v1 Markdown.
     * Capabilities/contracts/invariants are sorted by key for consistent output. Binds INV-14.
     */
    private serializeDomainDocDeterministicV1(doc: import('../models').ProjectedDomainDocument): string {
        const capRows = this.serializeGroupedCapabilityRows(doc);
        const contractRows = [...doc.contracts]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(c => `| ${c.id} | ${c.reqId} | ${c.method} | ${c.path} |`)
            .join('\n');
        const invariantLines = [...doc.invariants]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(inv => `- [${inv.id}](${inv.reqId}) ${inv.text}`)
            .join('\n');

        return [
            `---`,
            `domain: ${doc.canonicalDomain}`,
            `version: ${doc.version}`,
            `---`,
            ``,
            `<!-- AUTO:capabilities:start -->`,
            `| 能力 | 状态 | 关联接口 | 关联需求 |`,
            `|------|------|----------|----------|`,
            capRows,
            `<!-- AUTO:capabilities:end -->`,
            ``,
            `<!-- AUTO:contracts:start -->`,
            `| Key | Req-ID | Method | Path |`,
            `|-----|--------|--------|------|`,
            contractRows,
            `<!-- AUTO:contracts:end -->`,
            ``,
            `<!-- AUTO:invariants:start -->`,
            invariantLines,
            `<!-- AUTO:invariants:end -->`,
            ``,
            `<!-- HUMAN:overview:start -->`,
            `<!-- HUMAN:overview:end -->`,
            ``,
            `<!-- HUMAN:notes:start -->`,
            `<!-- HUMAN:notes:end -->`,
            ``,
            `<!-- AUTO:changelog:start -->`,
            `<!-- AUTO:changelog:end -->`,
            ``,
        ].join('\n');
    }

    /**
     * Serialize a capability-centric, de-duplicated capability table for the domain document.
     * Capabilities sharing the same (title, status) are merged into one row; each row lists the
     * associated API contract keys and the underlying Req-IDs (for traceability). Grouping,
     * Req-IDs and API keys are all sorted so output stays deterministic (INV-3/INV-14).
     */
    private serializeGroupedCapabilityRows(doc: import('../models').ProjectedDomainDocument): string {
        const apiByReqId = new Map<string, Set<string>>();
        for (const contract of doc.contracts) {
            const reqId = (contract.reqId || '').trim();
            const contractId = (contract.id || '').trim();
            if (!reqId || !contractId) {
                continue;
            }
            const set = apiByReqId.get(reqId) || new Set<string>();
            set.add(contractId);
            apiByReqId.set(reqId, set);
        }

        interface CapabilityGroup {
            title: string;
            status: string;
            reqIds: Set<string>;
            apis: Set<string>;
        }
        const groups = new Map<string, CapabilityGroup>();
        for (const cap of doc.capabilities) {
            const title = (cap.title || '').trim();
            const status = (cap.status || 'active').trim();
            const reqId = (cap.reqId || '').trim();
            const key = `${title}\u0000${status}`;
            let group = groups.get(key);
            if (!group) {
                group = { title, status, reqIds: new Set<string>(), apis: new Set<string>() };
                groups.set(key, group);
            }
            if (reqId) {
                group.reqIds.add(reqId);
                for (const api of apiByReqId.get(reqId) || []) {
                    group.apis.add(api);
                }
            }
        }

        return [...groups.values()]
            .sort((a, b) => a.title.localeCompare(b.title) || a.status.localeCompare(b.status))
            .map(group => {
                const reqIds = [...group.reqIds].sort((x, y) => x.localeCompare(y)).join(', ');
                const apis = group.apis.size > 0
                    ? [...group.apis].sort((x, y) => x.localeCompare(y)).join(', ')
                    : '-';
                return `| ${this.escapeCell(group.title)} | ${this.escapeCell(group.status)} | ${this.escapeCell(apis)} | ${this.escapeCell(reqIds)} |`;
            })
            .join('\n');
    }

    /**
     * Rebuild the domain index content to reflect the latest projected domains.
     * Preserves existing HUMAN sections. Binds INV-14, Req-3.
     */
    private rebuildIndexContent(
        existingContent: string,
        registryEntries: import('../models').DomainRegistryEntry[],
        projectedDomains: import('../models').ProjectedDomainDocument[],
    ): string {
        const projectedSet = new Set(projectedDomains.map(d => d.canonicalDomain));
        const allDomains = new Map<string, { canonical: string; displayName: string; status: string }>();

        for (const entry of registryEntries) {
            if (entry.status === 'active' || projectedSet.has(entry.canonical)) {
                allDomains.set(entry.canonical, {
                    canonical: entry.canonical,
                    displayName: entry.displayName || entry.canonical,
                    status: entry.status || 'active',
                });
            }
        }

        // If projection contains a domain not yet registered, still expose it in index.
        for (const projected of projectedDomains) {
            if (!allDomains.has(projected.canonicalDomain)) {
                allDomains.set(projected.canonicalDomain, {
                    canonical: projected.canonicalDomain,
                    displayName: projected.canonicalDomain,
                    status: 'active',
                });
            }
        }

        const sortedDomains = Array.from(allDomains.values())
            .sort((a, b) => a.canonical.localeCompare(b.canonical));

        const rows = sortedDomains
            .map(e => `| [${e.canonical}](./${e.canonical}.md) | ${e.displayName || e.canonical} | ${e.status} |`)
            .join('\n');

        if (!hasMarkedBlock(existingContent, 'AUTO:index')) {
            return existingContent;
        }
        return replaceMarkedBlockStrict(
            existingContent,
            'AUTO:index',
            `| Domain | Display Name | Status |\n|--------|-------------|--------|\n${rows}`,
        ).content;
    }

    /**
     * Aggregate pending capability-delta files and persist idempotent state in registry lastAggregated.
     */
    aggregatePendingDeltas(repoRoot: string, enableAiRefinement: boolean, docsRepoRoot?: string): AggregatePendingDeltasResult {
        const normalizedRepoRoot = normalizeAndValidateRepoRoot(repoRoot);

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
        const normalizedRoot = normalizeAndValidateRepoRoot(repoRoot);
        const indexPath = path.join(normalizedRoot, DOMAIN_DOCS_DIR, '_index.md');
        // Enforce repo-root boundary before any file write. Binds INV-10, Req-7.
        assertPathInRepoRoot(normalizedRoot, indexPath);
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
        const normalizedRoot = normalizeAndValidateRepoRoot(input.repoRoot);
        const filePath = this.resolveDomainDocPath(normalizedRoot, input.canonical);
        // Enforce repo-root boundary before any file write. Binds INV-10, Req-7.
        assertPathInRepoRoot(normalizedRoot, filePath);
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
        const result: CapabilityRow[] = [];
        for (const row of rows) {
            const capabilityCell = row['能力'] ?? row['Capability'];
            const reqIdsCell = row['关联需求'] ?? row['Req-IDs'];
            // New capability-centric grouped format: expand each Req-ID back to a per-reqId record.
            if (capabilityCell !== undefined && reqIdsCell !== undefined) {
                const title = (capabilityCell || '').trim();
                const status = (row['状态'] || row['Status'] || 'active').trim();
                const reqIds = (reqIdsCell || '')
                    .split(/[,，]/)
                    .map(item => item.trim())
                    .filter(item => item.length > 0);
                for (const reqId of reqIds) {
                    result.push({ reqId, title, status, firstIntroduced: '', lastChanged: '' });
                }
                continue;
            }
            // Legacy per-reqId format (Req-ID | Title | Status | First Introduced | Last Changed).
            const reqId = (row['Req-ID'] || '').trim();
            if (reqId.length === 0) {
                continue;
            }
            result.push({
                reqId,
                title: row['Title'] || '',
                status: row['Status'] || 'active',
                firstIntroduced: row['First Introduced'] || '',
                lastChanged: row['Last Changed'] || '',
            });
        }
        return result;
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
