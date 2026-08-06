import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    CapabilityDeltaItem,
    CapabilityDelta,
    CapabilityDeltaValidationError,
    CapabilityDeltaValidationResult,
    CapabilityStatus,
    ContractDeltaItem,
    DomainDelta,
    InvariantDeltaItem,
} from '../models';
import { DomainRegistryService, DomainFallbackSignals } from './domainRegistryService';
import type { DomainSummaryPromptInput } from './promptService';

interface RequirementRecord {
    id: string;
    domain: string | null;
    rawDomain: string | null;
    title: string;
    userStory: string;
    status: CapabilityStatus;
}

interface ApiContractRecord {
    id: string;
    requirementIds: string[];
    method: string;
    path: string;
    requestShape: Record<string, unknown>;
    responseShape: Record<string, unknown>;
}

interface InvariantRecord {
    id: string;
    requirementIds: string[];
    rule: string;
}

interface DomainBucket {
    canonical: string | null;
    rawDomain: string | null;
    isSuspectedNew: boolean;
    capabilities: Map<string, CapabilityDeltaItem>;
    contracts: Map<string, ContractDeltaItem>;
    invariants: Map<string, InvariantDeltaItem>;
}

export interface CapabilityDeltaGenerationResult {
    delta: CapabilityDelta;
    deltaPath: string;
    validation: CapabilityDeltaValidationResult;
}

/**
 * Service for capability-delta schema validation and deterministic content-hash generation.
 */
export class CapabilityDeltaService {
    private readonly domainRegistryService: DomainRegistryService;

    /**
     * Create capability-delta service with deterministic extractor and validator.
     */
    constructor(domainRegistryService?: DomainRegistryService) {
        this.domainRegistryService = domainRegistryService || new DomainRegistryService();
    }

    /**
     * Generate capability-delta.json from current iteration requirements/design using deterministic extraction only.
     */
    generateForIteration(repoRoot: string, iterationPath: string): CapabilityDeltaGenerationResult {
        const normalizedRepoRoot = this.normalizeRepoRoot(repoRoot);
        const iterationAbsolutePath = this.resolveIterationPath(normalizedRepoRoot, iterationPath);
        const requirementsPath = path.join(iterationAbsolutePath, 'requirements.md');
        const designPath = path.join(iterationAbsolutePath, 'design.md');

        if (!fs.existsSync(requirementsPath)) {
            throw new Error(`Missing requirements artifact: ${requirementsPath}`);
        }
        if (!fs.existsSync(designPath)) {
            throw new Error(`Missing design artifact: ${designPath}`);
        }

        const registryResult = this.domainRegistryService.loadRegistry(normalizedRepoRoot);
        if (registryResult.validationErrors.length > 0) {
            throw new Error(
                `Invalid domain registry: ${registryResult.validationErrors.map(item => item.message).join('; ')}`,
            );
        }

        const requirementsContent = fs.readFileSync(requirementsPath, 'utf8');
        const designContent = fs.readFileSync(designPath, 'utf8');
        const requirements = this.parseRequirementsFromMachineBlock(requirementsContent);
        const apiContracts = this.parseApiContractsFromMachineBlock(designContent);
        const invariants = this.parseInvariantsFromMachineBlock(designContent);

        const requirementMap = new Map<string, RequirementRecord>();
        for (const requirement of requirements) {
            requirementMap.set(requirement.id, requirement);
        }

        const domainBuckets = new Map<string, DomainBucket>();

        for (const requirement of requirements) {
            const bucket = this.resolveBucketForRequirement(
                domainBuckets,
                registryResult.registry,
                requirement,
            );
            const normalizedCapabilityTitle = this.deriveCapabilityTitle(requirement.title, requirement.userStory);

            bucket.capabilities.set(requirement.id, {
                reqId: requirement.id,
                title: normalizedCapabilityTitle,
                userStory: requirement.userStory,
                status: requirement.status,
            });
        }

        for (const contract of apiContracts) {
            const bucket = this.resolveBucketForContract(
                domainBuckets,
                registryResult.registry,
                contract,
                requirementMap,
            );

            const targetReqId = this.pickPrimaryRequirementId(contract.requirementIds);
            bucket.contracts.set(contract.id, {
                id: contract.id,
                reqId: targetReqId || '',
                method: contract.method,
                path: contract.path,
                requestShape: contract.requestShape,
                responseShape: contract.responseShape,
            });
        }

        for (const invariant of invariants) {
            const bucket = this.resolveBucketForInvariant(
                domainBuckets,
                registryResult.registry,
                invariant,
                requirementMap,
            );

            const primaryReqId = invariant.requirementIds.length > 0 ? invariant.requirementIds[0] : '';
            bucket.invariants.set(invariant.id, {
                id: invariant.id,
                reqId: primaryReqId,
                text: invariant.rule,
            });
        }

        const domains = Array.from(domainBuckets.values())
            .map(item => this.toDomainDelta(item))
            .sort((left, right) => this.buildDomainSortKey(left).localeCompare(this.buildDomainSortKey(right)));

        const iteration = path.basename(iterationAbsolutePath).trim();
        const generatedAt = this.buildDeterministicGeneratedAt(requirementsContent, designContent);
        const draftDelta: CapabilityDelta = {
            iteration,
            generatedAt,
            contentHash: '',
            domains,
        };

        const validation = this.validateDelta(draftDelta);
        if (!validation.valid) {
            throw new Error(`Capability delta validation failed: ${validation.errors.map(item => `${item.field}: ${item.message}`).join('; ')}`);
        }

        const delta: CapabilityDelta = {
            ...draftDelta,
            contentHash: validation.contentHash,
        };

        const deltaPath = path.join(iterationAbsolutePath, 'delta', 'capability-delta.json');
        fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
        fs.writeFileSync(deltaPath, `${JSON.stringify(delta, null, 2)}\n`, 'utf8');

        return {
            delta,
            deltaPath,
            validation,
        };
    }

    /**
     * Apply optional AI title refinement to a generated delta and recompute its content hash.
     * Deterministic-safe: structure keys (reqId/status/contracts/invariants) are untouched; only
     * capability titles may be replaced. Any AI failure or empty response leaves the delta unchanged.
     */
    async refineDeltaTitles(
        delta: CapabilityDelta,
        registryCanonicals: string[],
        buildPrompt: (input: DomainSummaryPromptInput) => string,
        runAi: (prompt: string) => Promise<string | null> | string | null,
    ): Promise<CapabilityDelta> {
        if (!delta || !Array.isArray(delta.domains) || delta.domains.length === 0) {
            return delta;
        }

        let mutated = false;
        const refinedDomains: CapabilityDelta['domains'] = [];
        for (const domain of delta.domains) {
            const capabilities = Array.isArray(domain.capabilities) ? domain.capabilities : [];
            if (capabilities.length === 0) {
                refinedDomains.push(domain);
                continue;
            }
            const input: DomainSummaryPromptInput = {
                canonical: (domain.canonical || '').trim(),
                displayName: (domain.canonical || domain.rawDomain || '').trim(),
                capabilities: capabilities.map(item => ({
                    reqId: item.reqId,
                    title: item.title,
                    status: item.status,
                })),
                registryCanonicals,
            };

            let responseText = '';
            try {
                const prompt = buildPrompt(input);
                responseText = ((await runAi(prompt)) || '').trim();
            } catch {
                refinedDomains.push(domain);
                continue;
            }
            if (!responseText) {
                refinedDomains.push(domain);
                continue;
            }

            const refinedTitles = this.parseRefinedCapabilityTitles(responseText, capabilities);
            if (refinedTitles.size === 0) {
                refinedDomains.push(domain);
                continue;
            }

            const nextCapabilities = capabilities.map(item => {
                const nextTitle = refinedTitles.get(item.reqId);
                if (!nextTitle || nextTitle === item.title) {
                    return item;
                }
                mutated = true;
                return { ...item, title: nextTitle };
            });

            refinedDomains.push({ ...domain, capabilities: nextCapabilities });
        }

        if (!mutated) {
            return delta;
        }

        const refined: CapabilityDelta = { ...delta, contentHash: '', domains: refinedDomains };
        const validation = this.validateDelta(refined);
        return { ...refined, contentHash: validation.contentHash };
    }

    /**
     * Persist a capability delta to disk using the canonical serialization format.
     */
    persistDelta(deltaPath: string, delta: CapabilityDelta): void {
        fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
        fs.writeFileSync(deltaPath, `${JSON.stringify(delta, null, 2)}\n`, 'utf8');
    }

    /**
     * Parse AI response JSON and keep only title updates for known reqIds.
     */
    private parseRefinedCapabilityTitles(
        responseText: string,
        sourceCapabilities: CapabilityDeltaItem[],
    ): Map<string, string> {
        const result = new Map<string, string>();
        const knownReqIds = new Set(sourceCapabilities.map(item => item.reqId));
        const rawJson = this.extractJsonObject(responseText);
        if (!rawJson) {
            return result;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawJson);
        } catch {
            return result;
        }
        const capabilities = (parsed as { capabilities?: unknown })?.capabilities;
        if (!Array.isArray(capabilities)) {
            return result;
        }
        for (const item of capabilities) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const reqId = String((item as { reqId?: unknown }).reqId || '').trim();
            const title = String((item as { title?: unknown }).title || '').trim();
            if (!reqId || !title || !knownReqIds.has(reqId)) {
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
        const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        return candidate.slice(start, end + 1);
    }

    /**
     * Validate schema fields and calculate deterministic content hash for a capability delta.
     */
    validateDelta(delta: CapabilityDelta): CapabilityDeltaValidationResult {
        const errors: CapabilityDeltaValidationError[] = [];
        const normalizedDelta = this.normalizeDelta(delta, errors);
        const contentHash = this.computeContentHash(normalizedDelta);

        return {
            valid: errors.length === 0,
            errors,
            contentHash,
        };
    }

    /**
     * Compute a deterministic sha1 hash from a normalized capability-delta payload.
     */
    computeContentHash(delta: Omit<CapabilityDelta, 'contentHash'>): string {
        const stable = JSON.stringify(delta);
        return crypto.createHash('sha1').update(stable, 'utf8').digest('hex');
    }

    /**
     * Normalize delta payload and collect schema errors for required fields.
     */
    private normalizeDelta(
        delta: CapabilityDelta,
        errors: CapabilityDeltaValidationError[],
    ): Omit<CapabilityDelta, 'contentHash'> {
        const iteration = this.requireString(delta?.iteration, 'iteration', errors);
        const generatedAt = this.requireString(delta?.generatedAt, 'generatedAt', errors);

        if (!Array.isArray(delta?.domains)) {
            errors.push({ field: 'domains', message: 'domains must be an array' });
        }

        const domains = (Array.isArray(delta?.domains) ? delta.domains : [])
            .map((item, index) => this.normalizeDomainDelta(item, index, errors))
            .sort((left, right) => this.buildDomainSortKey(left).localeCompare(this.buildDomainSortKey(right)));

        return {
            iteration,
            generatedAt,
            domains,
        };
    }

    /**
     * Normalize a domain delta section and validate all required list fields.
     */
    private normalizeDomainDelta(
        domain: DomainDelta,
        domainIndex: number,
        errors: CapabilityDeltaValidationError[],
    ): DomainDelta {
        const canonical = this.normalizeNullableString(domain?.canonical);
        const rawDomain = this.normalizeNullableString(domain?.rawDomain);
        const isSuspectedNew = Boolean(domain?.isSuspectedNew);

        if (!Array.isArray(domain?.capabilities)) {
            errors.push({
                field: `domains[${domainIndex}].capabilities`,
                message: 'capabilities must be an array',
            });
        }
        if (!Array.isArray(domain?.contracts)) {
            errors.push({
                field: `domains[${domainIndex}].contracts`,
                message: 'contracts must be an array',
            });
        }
        if (!Array.isArray(domain?.invariants)) {
            errors.push({
                field: `domains[${domainIndex}].invariants`,
                message: 'invariants must be an array',
            });
        }

        const capabilities = (Array.isArray(domain?.capabilities) ? domain.capabilities : [])
            .map((item, itemIndex) => {
                const reqId = this.requireString(
                    item?.reqId,
                    `domains[${domainIndex}].capabilities[${itemIndex}].reqId`,
                    errors,
                );
                const title = this.requireString(
                    item?.title,
                    `domains[${domainIndex}].capabilities[${itemIndex}].title`,
                    errors,
                );
                const userStory = this.requireString(
                    item?.userStory,
                    `domains[${domainIndex}].capabilities[${itemIndex}].userStory`,
                    errors,
                );
                const status = this.normalizeStatus(
                    item?.status,
                    `domains[${domainIndex}].capabilities[${itemIndex}].status`,
                    errors,
                );

                return { reqId, title, userStory, status };
            })
            .sort((left, right) => left.reqId.localeCompare(right.reqId));

        const contracts = (Array.isArray(domain?.contracts) ? domain.contracts : [])
            .map((item, itemIndex) => this.normalizeContract(item, domainIndex, itemIndex, errors))
            .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));

        const invariants = (Array.isArray(domain?.invariants) ? domain.invariants : [])
            .map((item, itemIndex) => this.normalizeInvariant(item, domainIndex, itemIndex, errors))
            .sort((left, right) => left.id.localeCompare(right.id));

        return {
            canonical,
            rawDomain,
            isSuspectedNew,
            capabilities,
            contracts,
            invariants,
        };
    }

    /**
     * Normalize contract entry and validate required scalar fields.
     */
    private normalizeContract(
        item: ContractDeltaItem,
        domainIndex: number,
        itemIndex: number,
        errors: CapabilityDeltaValidationError[],
    ): ContractDeltaItem {
        return {
            id: this.requireString(item?.id, `domains[${domainIndex}].contracts[${itemIndex}].id`, errors),
            reqId: this.requireString(item?.reqId, `domains[${domainIndex}].contracts[${itemIndex}].reqId`, errors),
            method: this.requireString(item?.method, `domains[${domainIndex}].contracts[${itemIndex}].method`, errors),
            path: this.requireString(item?.path, `domains[${domainIndex}].contracts[${itemIndex}].path`, errors),
            requestShape: this.normalizeRecord(item?.requestShape, `domains[${domainIndex}].contracts[${itemIndex}].requestShape`, errors),
            responseShape: this.normalizeRecord(item?.responseShape, `domains[${domainIndex}].contracts[${itemIndex}].responseShape`, errors),
        };
    }

    /**
     * Normalize invariant entry and validate required scalar fields.
     */
    private normalizeInvariant(
        item: InvariantDeltaItem,
        domainIndex: number,
        itemIndex: number,
        errors: CapabilityDeltaValidationError[],
    ): InvariantDeltaItem {
        return {
            id: this.requireString(item?.id, `domains[${domainIndex}].invariants[${itemIndex}].id`, errors),
            reqId: this.requireString(item?.reqId, `domains[${domainIndex}].invariants[${itemIndex}].reqId`, errors),
            text: this.requireString(item?.text, `domains[${domainIndex}].invariants[${itemIndex}].text`, errors),
        };
    }

    /**
     * Require a non-empty string value and record an error when invalid.
     */
    private requireString(
        value: unknown,
        field: string,
        errors: CapabilityDeltaValidationError[],
    ): string {
        if (typeof value !== 'string') {
            errors.push({ field, message: `${field} must be a string` });
            return '';
        }
        const trimmed = value.trim();
        if (!trimmed) {
            errors.push({ field, message: `${field} must not be empty` });
        }
        return trimmed;
    }

    /**
     * Normalize optional string values to null when empty.
     */
    private normalizeNullableString(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        return trimmed || null;
    }

    /**
     * Normalize capability status to an allowed enum value.
     */
    private normalizeStatus(
        value: unknown,
        field: string,
        errors: CapabilityDeltaValidationError[],
    ): CapabilityStatus {
        const allowed: CapabilityStatus[] = ['active', 'deprecated', 'removed'];
        if (typeof value !== 'string') {
            errors.push({ field, message: `${field} must be one of ${allowed.join(', ')}` });
            return 'active';
        }
        const normalized = value.trim().toLowerCase() as CapabilityStatus;
        if (!allowed.includes(normalized)) {
            errors.push({ field, message: `${field} must be one of ${allowed.join(', ')}` });
            return 'active';
        }
        return normalized;
    }

    /**
     * Normalize record-shaped objects and report an error for non-object values.
     */
    private normalizeRecord(
        value: unknown,
        field: string,
        errors: CapabilityDeltaValidationError[],
    ): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            errors.push({ field, message: `${field} must be an object` });
            return {};
        }

        const raw = value as Record<string, unknown>;
        const keys = Object.keys(raw).sort((left, right) => left.localeCompare(right));
        const normalized: Record<string, unknown> = {};
        for (const key of keys) {
            normalized[key] = raw[key];
        }
        return normalized;
    }

    /**
     * Build deterministic sorting key for domain entries.
     */
    private buildDomainSortKey(domain: DomainDelta): string {
        return `${domain.canonical || '~'}|${domain.rawDomain || '~'}|${domain.isSuspectedNew ? '1' : '0'}`;
    }

    /**
     * Resolve current repository root path.
     */
    private normalizeRepoRoot(repoRoot: string): string {
        const normalized = (repoRoot || '').trim();
        if (!normalized) {
            throw new Error('repoRoot is required');
        }
        return path.resolve(normalized);
    }

    /**
     * Resolve iteration directory path from absolute or repository-relative input.
     */
    private resolveIterationPath(repoRoot: string, iterationPath: string): string {
        const normalizedIterationPath = (iterationPath || '').trim();
        if (!normalizedIterationPath) {
            throw new Error('iterationPath is required');
        }

        const resolved = path.isAbsolute(normalizedIterationPath)
            ? path.resolve(normalizedIterationPath)
            : path.resolve(repoRoot, normalizedIterationPath);

        const hasArtifacts = (basePath: string): boolean => {
            return fs.existsSync(path.join(basePath, 'requirements.md'))
                && fs.existsSync(path.join(basePath, 'design.md'));
        };

        if (hasArtifacts(resolved)) {
            return resolved;
        }

        // Backward-compatible fallback: when caller passes a worktree root,
        // artifacts may live under specs/<iteration-name>/.
        const iterationName = path.basename(resolved);
        const nestedUnderCurrent = path.join(resolved, 'specs', iterationName);
        if (hasArtifacts(nestedUnderCurrent)) {
            return nestedUnderCurrent;
        }

        const nestedUnderRepoRoot = path.join(repoRoot, 'specs', iterationName);
        if (hasArtifacts(nestedUnderRepoRoot)) {
            return nestedUnderRepoRoot;
        }

        return resolved;
    }

    /**
     * Parse requirements list from requirements.md machine-readable YAML block.
     */
    private parseRequirementsFromMachineBlock(requirementsContent: string): RequirementRecord[] {
        const block = this.extractYamlMachineBlock(requirementsContent);
        const sectionLines = this.extractYamlSectionLines(block, 'requirements');
        const items = this.parseYamlObjectList(sectionLines, ['id', 'domain', 'rawDomain', 'title', 'userStory']);

        return items
            .map(item => {
                const id = (item.id || '').trim();
                if (!id) {
                    return null;
                }
                const title = (item.title || '').trim();
                const userStory = (item.userStory || '').trim();
                const domain = (item.domain || '').trim() || null;
                const rawDomain = (item.rawDomain || '').trim() || null;
                return {
                    id,
                    domain,
                    rawDomain,
                    title,
                    userStory,
                    status: this.inferCapabilityStatus(title, userStory),
                } as RequirementRecord;
            })
            .filter((item): item is RequirementRecord => Boolean(item));
    }

    /**
     * Parse API contract entries from design.md machine-readable YAML block.
     */
    private parseApiContractsFromMachineBlock(designContent: string): ApiContractRecord[] {
        const block = this.extractYamlMachineBlock(designContent);
        const sectionLines = this.extractYamlSectionLines(block, 'apiContracts');
        const objects = this.parseYamlObjectBlocks(sectionLines);
        const result: ApiContractRecord[] = [];

        for (const objectLines of objects) {
            const id = this.readScalarField(objectLines, 'id');
            const method = this.readScalarField(objectLines, 'method').toUpperCase();
            const apiPath = this.readScalarField(objectLines, 'path');

            if (!id || !method || !apiPath) {
                continue;
            }

            const requirementIds = this.readInlineArrayField(objectLines, 'requirementIds');
            const requestShape = this.readMapField(objectLines, 'request');
            const responseShape = this.readMapField(objectLines, 'response');

            result.push({
                id,
                requirementIds,
                method,
                path: apiPath,
                requestShape,
                responseShape,
            });
        }

        return result.sort((left, right) => left.id.localeCompare(right.id));
    }

    /**
     * Parse invariant entries from design.md machine-readable YAML block.
     * Supports both single and comma-separated requirementId values.
     */
    private parseInvariantsFromMachineBlock(designContent: string): InvariantRecord[] {
        const block = this.extractYamlMachineBlock(designContent);
        const sectionLines = this.extractYamlSectionLines(block, 'invariants');
        const items = this.parseYamlObjectList(sectionLines, ['id', 'requirementId', 'rule']);

        return items
            .map(item => {
                const id = (item.id || '').trim();
                const requirementIdStr = (item.requirementId || '').trim();
                const rule = (item.rule || '').trim();
                if (!id || !requirementIdStr || !rule) {
                    return null;
                }
                const requirementIds = requirementIdStr.split(',').map(s => s.trim()).filter(Boolean);
                return { id, requirementIds, rule } as InvariantRecord;
            })
            .filter((item): item is InvariantRecord => Boolean(item))
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    /**
     * Resolve or create a target domain bucket for a requirement item.
     */
    private resolveBucketForRequirement(
        buckets: Map<string, DomainBucket>,
        registry: { domains: Array<{ canonical: string; aliases: string[]; displayName: string; status: 'active' | 'deprecated' }> },
        requirement: RequirementRecord,
    ): DomainBucket {
        const domainCandidate = this.pickRequirementDomainCandidate(requirement);
        const rawDomainCandidate = this.pickRequirementRawDomain(requirement, domainCandidate);
        const normalized = this.domainRegistryService.normalizeDomain(
            registry,
            domainCandidate,
            requirement.id,
            {
                explicitDomain: domainCandidate,
            },
        );

        return this.ensureBucket(
            buckets,
            normalized.canonical,
            rawDomainCandidate,
            normalized.isSuspectedNew,
        );
    }

    private pickRequirementDomainCandidate(requirement: RequirementRecord): string | null {
        const domain = (requirement.domain || '').trim();
        if (domain && !this.isFallbackRequirementDomain(domain)) {
            return domain;
        }
        const rawDomain = (requirement.rawDomain || '').trim();
        return rawDomain || null;
    }

    private pickRequirementRawDomain(requirement: RequirementRecord, domainCandidate: string | null): string | null {
        const rawDomain = (requirement.rawDomain || '').trim();
        if (rawDomain) {
            return rawDomain;
        }
        return domainCandidate;
    }

    private isFallbackRequirementDomain(domain: string): boolean {
        const normalized = domain.trim().toLowerCase();
        return normalized === 'uncategorized' || normalized === 'unknown';
    }

    /**
     * Resolve or create a target domain bucket for records not directly bound to requirement data.
     * Generates fallback signals from requirement ID patterns to improve domain inference.
     */
    private resolveBucketForUnboundEntry(
        buckets: Map<string, DomainBucket>,
        registry: { domains: Array<{ canonical: string; aliases: string[]; displayName: string; status: 'active' | 'deprecated' }> },
        reqId: string | null,
    ): DomainBucket {
        const requirementId = (reqId || '').trim();
        const fallbackSignals = this.generateFallbackSignalsForRequirementId(registry, requirementId);

        const normalized = this.domainRegistryService.normalizeDomain(
            registry,
            null,
            requirementId,
            fallbackSignals,
        );

        return this.ensureBucket(
            buckets,
            normalized.canonical,
            null,
            normalized.isSuspectedNew,
        );
    }

    /**
     * Generate fallback domain signals from a requirement ID by matching against registry patterns.
     * Attempts to match reqIdPrefix patterns to infer the most likely domain.
     */
    private generateFallbackSignalsForRequirementId(
        registry: { domains: Array<{ canonical: string; aliases: string[]; displayName: string; status: 'active' | 'deprecated' }> },
        requirementId: string,
    ): DomainFallbackSignals {
        if (!requirementId || !registry.domains) {
            return {};
        }

        const signals: DomainFallbackSignals = {};

        for (const domain of registry.domains) {
            const metadata = (domain as any).metadata || {};
            if (metadata.reqIdPrefix && typeof metadata.reqIdPrefix === 'string') {
                try {
                    const prefixPattern = new RegExp(`^${metadata.reqIdPrefix}`);
                    if (prefixPattern.test(requirementId)) {
                        signals.reqIdPrefixDomain = domain.canonical;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        return signals;
    }

    /**
     * Resolve or create a target domain bucket for an API contract with multiple requirement IDs.
     * Tries each requirement in order until finding one with a valid domain.
     */
    private resolveBucketForContract(
        buckets: Map<string, DomainBucket>,
        registry: { domains: Array<{ canonical: string; aliases: string[]; displayName: string; status: 'active' | 'deprecated' }> },
        contract: ApiContractRecord,
        requirementMap: Map<string, RequirementRecord>,
    ): DomainBucket {
        for (const reqId of contract.requirementIds) {
            const requirement = requirementMap.get(reqId) || null;
            if (requirement && requirement.domain) {
                return this.resolveBucketForRequirement(buckets, registry, requirement);
            }
        }

        for (const reqId of contract.requirementIds) {
            const requirement = requirementMap.get(reqId) || null;
            if (requirement) {
                return this.resolveBucketForRequirement(buckets, registry, requirement);
            }
        }

        const primaryReqId = this.pickPrimaryRequirementId(contract.requirementIds);
        return this.resolveBucketForUnboundEntry(buckets, registry, primaryReqId);
    }

    /**
     * Resolve or create a target domain bucket for an invariant with multiple requirement IDs.
     * Tries each requirement in order until finding one with a valid domain.
     */
    private resolveBucketForInvariant(
        buckets: Map<string, DomainBucket>,
        registry: { domains: Array<{ canonical: string; aliases: string[]; displayName: string; status: 'active' | 'deprecated' }> },
        invariant: InvariantRecord,
        requirementMap: Map<string, RequirementRecord>,
    ): DomainBucket {
        for (const reqId of invariant.requirementIds) {
            const requirement = requirementMap.get(reqId) || null;
            if (requirement && requirement.domain) {
                return this.resolveBucketForRequirement(buckets, registry, requirement);
            }
        }

        for (const reqId of invariant.requirementIds) {
            const requirement = requirementMap.get(reqId) || null;
            if (requirement) {
                return this.resolveBucketForRequirement(buckets, registry, requirement);
            }
        }

        const primaryReqId = invariant.requirementIds.length > 0 ? invariant.requirementIds[0] : null;
        return this.resolveBucketForUnboundEntry(buckets, registry, primaryReqId);
    }

    /**
     * Ensure a unique bucket instance exists for the target domain key.
     */
    private ensureBucket(
        buckets: Map<string, DomainBucket>,
        canonical: string | null,
        rawDomain: string | null,
        isSuspectedNew: boolean,
    ): DomainBucket {
        const normalizedCanonical = canonical && canonical.trim() ? canonical.trim() : null;
        const normalizedRawDomain = rawDomain && rawDomain.trim() ? rawDomain.trim() : null;
        const key = normalizedCanonical
            ? `canonical:${normalizedCanonical.toLowerCase()}`
            : `raw:${(normalizedRawDomain || 'unknown').toLowerCase()}`;

        const existing = buckets.get(key);
        if (existing) {
            if (!existing.rawDomain && normalizedRawDomain) {
                existing.rawDomain = normalizedRawDomain;
            }
            existing.isSuspectedNew = existing.isSuspectedNew || isSuspectedNew;
            return existing;
        }

        const created: DomainBucket = {
            canonical: normalizedCanonical,
            rawDomain: normalizedRawDomain,
            isSuspectedNew,
            capabilities: new Map<string, CapabilityDeltaItem>(),
            contracts: new Map<string, ContractDeltaItem>(),
            invariants: new Map<string, InvariantDeltaItem>(),
        };
        buckets.set(key, created);
        return created;
    }

    /**
     * Convert intermediate domain bucket to sorted domain-delta payload.
     */
    private toDomainDelta(bucket: DomainBucket): DomainDelta {
        const capabilities = Array.from(bucket.capabilities.values())
            .sort((left, right) => left.reqId.localeCompare(right.reqId));
        const contracts = Array.from(bucket.contracts.values())
            .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
        const invariants = Array.from(bucket.invariants.values())
            .sort((left, right) => left.id.localeCompare(right.id));

        return {
            canonical: bucket.canonical,
            rawDomain: bucket.rawDomain,
            isSuspectedNew: bucket.isSuspectedNew,
            capabilities,
            contracts,
            invariants,
        };
    }

    /**
     * Derive a stable capability status from textual hints.
     */
    private inferCapabilityStatus(title: string, userStory: string): CapabilityStatus {
        const text = `${title} ${userStory}`.toLowerCase();
        if (/\bremoved\b|删除|移除/.test(text)) {
            return 'removed';
        }
        if (/\bdeprecated\b|废弃/.test(text)) {
            return 'deprecated';
        }
        return 'active';
    }

    /**
     * Convert requirement-level phrasing into stable domain-capability wording.
     * Keeps deterministic output while avoiding temporary implementation phrasing.
     */
    private deriveCapabilityTitle(title: string, userStory: string): string {
        const rawTitle = (title || '').trim();
        const text = `${rawTitle} ${(userStory || '').trim()}`;
        if (!rawTitle) {
            return '';
        }

        // Dictionary-domain focused normalization rules (deterministic, no AI).
        if (/字典/.test(text)) {
            if (/迁移/.test(text)) {
                return '字典数据迁移与兼容能力';
            }
            if (/同步|一致性|校验|验证/.test(text)) {
                return '字典数据一致性校验能力';
            }
            if (/查询|管理|接口|API/.test(text)) {
                return '字典查询与管理能力';
            }
            if (/扩展|扩展性|可扩展/.test(text)) {
                return '字典类型扩展能力';
            }
            if (/统一|结构|模型|表结构/.test(text)) {
                return '统一字典模型能力';
            }
        }

        // Generic normalization for non-dictionary domains.
        if (/迁移/.test(text)) {
            return '数据迁移与兼容能力';
        }
        if (/同步|一致性|校验|验证/.test(text)) {
            return '数据一致性保障能力';
        }

        return rawTitle;
    }

    /**
     * Pick first non-empty requirement id from contract links.
     */
    private pickPrimaryRequirementId(requirementIds: string[]): string | null {
        for (const id of requirementIds) {
            const normalized = (id || '').trim();
            if (normalized) {
                return normalized;
            }
        }
        return null;
    }

    /**
     * Extract machine-readable YAML block wrapped by fenced yaml markers.
     */
    private extractYamlMachineBlock(content: string): string {
        const normalized = content.replace(/\r\n/g, '\n');
        const match = normalized.match(/```yaml\n([\s\S]*?)\n```/);
        if (!match) {
            throw new Error('Missing machine-readable YAML block');
        }
        return match[1];
    }

    /**
     * Extract lines for a top-level YAML section key.
     */
    private extractYamlSectionLines(yamlBlock: string, sectionName: string): string[] {
        const lines = yamlBlock.replace(/\r\n/g, '\n').split('\n');
        const startIndex = lines.findIndex(line => line.trim() === `${sectionName}:`);
        if (startIndex < 0) {
            return [];
        }

        const sectionLines: string[] = [];
        for (let index = startIndex + 1; index < lines.length; index += 1) {
            const line = lines[index];
            const normalizedLine = line.replace(/\t/g, '    ');
            const isTopLevelKey = this.getLineIndent(normalizedLine) === 0
                && /^[A-Za-z0-9_-]+\s*:/.test(normalizedLine.trim());
            if (isTopLevelKey) {
                break;
            }
            sectionLines.push(line);
        }
        return sectionLines;
    }

    /**
     * Parse a YAML list section into scalar field object list.
     */
    private parseYamlObjectList(
        sectionLines: string[],
        fields: string[],
        itemIndent: number = 2,
    ): Array<Record<string, string>> {
        const objectBlocks = this.parseYamlObjectBlocks(sectionLines, itemIndent);
        const result: Array<Record<string, string>> = [];

        for (const objectLines of objectBlocks) {
            const item: Record<string, string> = {};
            for (const field of fields) {
                item[field] = this.readScalarField(objectLines, field);
            }
            result.push(item);
        }

        return result;
    }

    /**
     * Split YAML list section lines into item blocks.
     */
    private parseYamlObjectBlocks(sectionLines: string[], itemIndent: number = 2): string[][] {
        const blocks: string[][] = [];
        let current: string[] = [];

        for (const line of sectionLines) {
            const normalizedLine = line.replace(/\t/g, '    ');
            const trimmed = normalizedLine.trim();
            const isItemHeader = trimmed.startsWith('- ') && this.getLineIndent(normalizedLine) === itemIndent;
            if (isItemHeader) {
                if (current.length > 0) {
                    blocks.push(current);
                }
                current = [line];
                continue;
            }

            if (current.length > 0) {
                current.push(line);
            }
        }

        if (current.length > 0) {
            blocks.push(current);
        }

        return blocks;
    }

    /**
     * Get leading whitespace length for indentation-aware YAML parsing.
     */
    private getLineIndent(line: string): number {
        const match = line.match(/^\s*/);
        return match ? match[0].length : 0;
    }

    /**
     * Read scalar field value from a YAML object block.
     */
    private readScalarField(objectLines: string[], fieldName: string): string {
        const inlinePattern = new RegExp(`^\\s*-\\s*${this.escapeRegExp(fieldName)}\\s*:\\s*(.+)\\s*$`);
        const normalPattern = new RegExp(`^\\s+${this.escapeRegExp(fieldName)}\\s*:\\s*(.+)\\s*$`);

        for (const line of objectLines) {
            const inlineMatch = line.match(inlinePattern);
            if (inlineMatch) {
                return this.cleanupYamlScalar(inlineMatch[1]);
            }

            const normalMatch = line.match(normalPattern);
            if (normalMatch) {
                return this.cleanupYamlScalar(normalMatch[1]);
            }
        }

        return '';
    }

    /**
     * Read inline array field value from a YAML object block.
     */
    private readInlineArrayField(objectLines: string[], fieldName: string): string[] {
        const scalar = this.readScalarField(objectLines, fieldName);
        if (!scalar.startsWith('[') || !scalar.endsWith(']')) {
            return [];
        }
        const body = scalar.slice(1, -1).trim();
        if (!body) {
            return [];
        }
        return body
            .split(',')
            .map(item => this.cleanupYamlScalar(item))
            .filter(Boolean);
    }

    /**
     * Read a simple nested map field from a YAML object block.
     */
    private readMapField(objectLines: string[], fieldName: string): Record<string, unknown> {
        const map: Record<string, unknown> = {};
        let active = false;
        let baseIndent = 0;

        const headerPatternInline = new RegExp(`^\\s*-\\s*${this.escapeRegExp(fieldName)}\\s*:\\s*$`);
        const headerPatternNormal = new RegExp(`^\\s+${this.escapeRegExp(fieldName)}\\s*:\\s*$`);

        for (const line of objectLines) {
            if (!active) {
                if (headerPatternInline.test(line) || headerPatternNormal.test(line)) {
                    active = true;
                    baseIndent = line.search(/\S|$/);
                }
                continue;
            }

            const currentIndent = line.search(/\S|$/);
            if (line.trim() === '') {
                continue;
            }
            if (currentIndent <= baseIndent) {
                break;
            }

            const pairMatch = line.match(/^\s+([^:]+):\s*(.+)\s*$/);
            if (pairMatch) {
                const key = pairMatch[1].trim();
                const value = this.cleanupYamlScalar(pairMatch[2]);
                map[key] = value;
            }
        }

        return map;
    }

    /**
     * Cleanup scalar text parsed from constrained YAML lines.
     */
    private cleanupYamlScalar(raw: string): string {
        const trimmed = (raw || '').trim();
        if (!trimmed) {
            return '';
        }
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
            return trimmed.slice(1, -1).trim();
        }
        return trimmed;
    }

    /**
     * Escape a string for use in RegExp literals.
     */
    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Build deterministic generatedAt value from source artifact contents.
     */
    private buildDeterministicGeneratedAt(requirementsContent: string, designContent: string): string {
        const sourceHash = crypto
            .createHash('sha1')
            .update(this.normalizeForHash(requirementsContent), 'utf8')
            .update('\n---\n')
            .update(this.normalizeForHash(designContent), 'utf8')
            .digest('hex');

        const baseMs = Date.UTC(2020, 0, 1, 0, 0, 0);
        const offsetSeconds = parseInt(sourceHash.slice(0, 8), 16) % (365 * 24 * 60 * 60);
        return new Date(baseMs + offsetSeconds * 1000).toISOString();
    }

    /**
     * Normalize text before hashing to avoid line-ending noise.
     */
    private normalizeForHash(content: string): string {
        return (content || '').replace(/\r\n/g, '\n').trim();
    }
}
