import * as fs from 'fs';
import * as path from 'path';
import {
    DomainRegistry,
    DomainRegistryAggregationRecord,
    DomainRegistryConflict,
    DomainRegistryEntry,
    DomainRegistryLoadResult,
    DomainRegistrySnapshot,
    RegistryValidationIssue,
} from '../models';
import { assertPathInRepoRoot, normalizeAndValidateRepoRoot } from './workspaceRoot';

const REGISTRY_RELATIVE_PATH = path.join('docs', 'domains', 'registry.yaml');

/**
 * Reserved fallback tokens that must never be persisted as domain aliases.
 * These are sentinels used internally when a change has no resolvable domain,
 * so aliasing them onto a real canonical would corrupt future normalization.
 */
const RESERVED_DOMAIN_TOKENS = new Set(['uncategorized', 'unknown']);

export type DomainMatchSource =
    | 'explicit'
    | 'canonical'
    | 'alias'
    | 'reqIdPrefix'
    | 'artifactPathPattern'
    | 'contractPattern'
    | 'keywordMap'
    | 'none';

export interface DomainFallbackSignals {
    explicitDomain?: string | null;
    reqIdPrefixDomain?: string | null;
    artifactPathPatternDomain?: string | null;
    contractPatternDomain?: string | null;
    keywordMapDomain?: string | null;
}

export interface DomainNormalizationResult {
    canonical: string | null;
    matchedBy: DomainMatchSource;
    isSuspectedNew: boolean;
}

export interface DomainLookupIndex {
    canonicalSet: Set<string>;
    aliasToCanonical: Map<string, string>;
}

export type DomainAdjudicationDecision = 'mergeExisting' | 'createCanonical' | 'appendAlias';

export interface DomainAdjudicationInput {
    decision: DomainAdjudicationDecision;
    rawDomain: string;
    targetCanonical?: string | null;
    displayName?: string | null;
}

/**
 * Service responsible for loading, initializing, validating and saving the domain registry.
 */
export class DomainRegistryService {
    /**
     * Normalize a raw domain name to its canonical form using registry vocabulary only.
     * Returns canonical=null when the raw name cannot be uniquely resolved, triggering a
     * domain-name conflict in the subpanel. Implements API-9. Binds Req-4, Req-5, Req-7.
     */
    normalizeDomainCanonical(
        rawDomain: string,
        registry: DomainRegistrySnapshot | DomainRegistry,
    ): { canonical: string | null; matchedBy: 'canonical' | 'alias' | 'none' } {
        const normalizedRaw = this.normalizeRegistryKey(rawDomain || '');
        if (!normalizedRaw) {
            return { canonical: null, matchedBy: 'none' };
        }
        for (const entry of registry.domains) {
            if (this.normalizeRegistryKey(entry.canonical) === normalizedRaw) {
                return { canonical: entry.canonical, matchedBy: 'canonical' };
            }
        }
        for (const entry of registry.domains) {
            if ('aliases' in entry) {
                for (const alias of (entry as DomainRegistryEntry).aliases) {
                    if (this.normalizeRegistryKey(alias) === normalizedRaw) {
                        return { canonical: entry.canonical, matchedBy: 'alias' };
                    }
                }
            }
        }
        return { canonical: null, matchedBy: 'none' };
    }

    /**
     * Load the registry from the current repository root, creating a default file when missing.
     */
    loadRegistry(repoRoot: string): DomainRegistryLoadResult {
        const normalizedRepoRoot = normalizeAndValidateRepoRoot(repoRoot);
        const filePath = this.resolveRegistryPath(normalizedRepoRoot);
        let created = false;

        if (!fs.existsSync(filePath)) {
            created = true;
            this.writeRegistryFile(filePath, { domains: [] });
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const registry = this.parseRegistry(content);
        const validationErrors = this.validateRegistry(registry);

        return {
            registry,
            validationErrors,
            created,
            filePath,
        };
    }

    /**
     * Persist the provided registry back to the repository-local registry.yaml file.
     */
    saveRegistry(repoRoot: string, registry: DomainRegistry): string {
        const normalizedRepoRoot = normalizeAndValidateRepoRoot(repoRoot);
        const filePath = this.resolveRegistryPath(normalizedRepoRoot);
        this.writeRegistryFile(filePath, registry);
        return filePath;
    }

    /**
     * Check whether one iteration+contentHash record is already aggregated.
     */
    hasAggregatedRecord(registry: DomainRegistry, iteration: string, contentHash: string): boolean {
        const normalizedIteration = (iteration || '').trim();
        const normalizedHash = (contentHash || '').trim();
        if (!normalizedIteration || !normalizedHash || !Array.isArray(registry.lastAggregated)) {
            return false;
        }
        return registry.lastAggregated.some(record =>
            record.iteration === normalizedIteration && record.contentHash === normalizedHash,
        );
    }

    /**
     * Upsert one aggregation state record keyed by iteration.
     */
    upsertAggregatedRecord(registry: DomainRegistry, record: DomainRegistryAggregationRecord): DomainRegistry {
        if (!registry.lastAggregated) {
            registry.lastAggregated = [];
        }

        const normalizedIteration = (record.iteration || '').trim();
        const normalizedHash = (record.contentHash || '').trim();
        const normalizedAt = (record.aggregatedAt || '').trim();
        if (!normalizedIteration || !normalizedHash || !normalizedAt) {
            throw new Error('Invalid aggregation record');
        }

        const index = registry.lastAggregated.findIndex(item => item.iteration === normalizedIteration);
        const nextRecord: DomainRegistryAggregationRecord = {
            iteration: normalizedIteration,
            contentHash: normalizedHash,
            aggregatedAt: normalizedAt,
        };
        if (index >= 0) {
            registry.lastAggregated[index] = nextRecord;
        } else {
            registry.lastAggregated.push(nextRecord);
        }

        registry.lastAggregated.sort((left, right) => left.iteration.localeCompare(right.iteration));
        return registry;
    }

    /**
     * Find registry entry by canonical name with case-insensitive match.
     */
    findEntryByCanonical(registry: DomainRegistry, canonical: string): DomainRegistryEntry | null {
        const normalizedCanonical = this.normalizeRegistryKey(canonical || '');
        if (!normalizedCanonical) {
            return null;
        }
        for (const entry of registry.domains) {
            if (this.normalizeRegistryKey(entry.canonical) === normalizedCanonical) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Apply a main-panel domain adjudication decision and persist registry changes when needed.
     */
    applyAdjudication(repoRoot: string, input: DomainAdjudicationInput): DomainRegistry {
        const load = this.loadRegistry(repoRoot);
        if (load.validationErrors.length > 0) {
            throw new Error(`Invalid registry: ${load.validationErrors.map(item => item.message).join('; ')}`);
        }

        const registry = load.registry;
        const rawDomain = (input.rawDomain || '').trim();
        if (!rawDomain) {
            throw new Error('rawDomain is required');
        }

        if (input.decision === 'mergeExisting') {
            const targetCanonical = (input.targetCanonical || '').trim();
            const target = this.findEntryByCanonical(registry, targetCanonical);
            if (!target) {
                throw new Error(`Target canonical not found: ${targetCanonical}`);
            }
            const rawKey = this.normalizeRegistryKey(rawDomain);
            const canonicalKey = this.normalizeRegistryKey(target.canonical);
            const aliasExists = target.aliases.some(alias => this.normalizeRegistryKey(alias) === rawKey);
            if (rawKey && rawKey !== canonicalKey && !aliasExists && !this.isReservedDomainToken(rawDomain)) {
                target.aliases.push(rawDomain);
                target.aliases = Array.from(new Set(target.aliases.map(item => item.trim()).filter(Boolean)));
                this.assertRegistryValidOrThrow(registry);
                this.saveRegistry(repoRoot, registry);
            }
            return registry;
        }

        if (input.decision === 'createCanonical') {
            const canonical = this.normalizeCanonical((input.targetCanonical || rawDomain).trim());
            if (!canonical) {
                throw new Error('Canonical is required for createCanonical decision');
            }
            if (this.findEntryByCanonical(registry, canonical)) {
                throw new Error(`Canonical already exists: ${canonical}`);
            }

            registry.domains.push({
                canonical,
                displayName: (input.displayName || canonical).trim() || canonical,
                aliases: (this.normalizeRegistryKey(rawDomain) === this.normalizeRegistryKey(canonical) || this.isReservedDomainToken(rawDomain)) ? [] : [rawDomain],
                status: 'active',
            });
            this.assertRegistryValidOrThrow(registry);
            this.saveRegistry(repoRoot, registry);
            return registry;
        }

        if (input.decision === 'appendAlias') {
            const targetCanonical = (input.targetCanonical || '').trim();
            const target = this.findEntryByCanonical(registry, targetCanonical);
            if (!target) {
                throw new Error(`Target canonical not found: ${targetCanonical}`);
            }

            const aliasExists = target.aliases.some(alias => this.normalizeRegistryKey(alias) === this.normalizeRegistryKey(rawDomain));
            if (!aliasExists && this.normalizeRegistryKey(target.canonical) !== this.normalizeRegistryKey(rawDomain) && !this.isReservedDomainToken(rawDomain)) {
                target.aliases.push(rawDomain);
                target.aliases = Array.from(new Set(target.aliases.map(item => item.trim()).filter(Boolean)));
            }
            this.assertRegistryValidOrThrow(registry);
            this.saveRegistry(repoRoot, registry);
            return registry;
        }

        throw new Error(`Unsupported adjudication decision: ${input.decision}`);
    }

    /**
     * Validate canonical uniqueness, alias uniqueness, and canonical slug format.
     * Returns DomainRegistryConflict[] for backward compatibility; invalid-slug issues
     * are also emitted as RegistryValidationIssue via validateRegistryStrict. Binds Req-4, Req-7, INV-9.
     */
    validateRegistry(registry: DomainRegistry): DomainRegistryConflict[] {
        const conflicts: DomainRegistryConflict[] = [];
        const canonicalToIndexes = new Map<string, number[]>();
        const aliasToIndexes = new Map<string, number[]>();

        registry.domains.forEach((entry, index) => {
            const canonicalKey = this.normalizeRegistryKey(entry.canonical);
            // Check for invalid slug: must match /^[a-z0-9][a-z0-9-]*$/ (INV-9)
            if (canonicalKey && !/^[a-z0-9][a-z0-9-]*$/.test(canonicalKey)) {
                conflicts.push({
                    code: 'duplicate-canonical', // reuse existing code; invalid-slug uses RegistryValidationIssue
                    message: `Invalid canonical slug (must match [a-z0-9][a-z0-9-]*): ${entry.canonical}`,
                    canonical: entry.canonical,
                    entryIndexes: [index],
                });
            }
            if (canonicalKey) {
                const indexes = canonicalToIndexes.get(canonicalKey) ?? [];
                indexes.push(index);
                canonicalToIndexes.set(canonicalKey, indexes);
            }

            for (const alias of entry.aliases) {
                const aliasKey = this.normalizeRegistryKey(alias);
                if (!aliasKey) {
                    continue;
                }
                const indexes = aliasToIndexes.get(aliasKey) ?? [];
                indexes.push(index);
                aliasToIndexes.set(aliasKey, indexes);
            }
        });

        for (const [canonical, indexes] of canonicalToIndexes.entries()) {
            if (indexes.length > 1) {
                conflicts.push({
                    code: 'duplicate-canonical',
                    message: `Duplicate canonical domain detected: ${canonical}`,
                    canonical,
                    entryIndexes: indexes,
                });
            }
        }

        for (const [alias, indexes] of aliasToIndexes.entries()) {
            const uniqueIndexes = Array.from(new Set(indexes));
            if (uniqueIndexes.length > 1) {
                conflicts.push({
                    code: 'duplicate-alias',
                    message: `Alias is mapped by multiple domains: ${alias}`,
                    alias,
                    entryIndexes: uniqueIndexes,
                });
            }
        }

        return conflicts;
    }

    /**
     * Build lookup indexes that can be shared by extractors and aggregators.
     */
    buildLookupIndex(registry: DomainRegistry): DomainLookupIndex {
        const canonicalSet = new Set<string>();
        const aliasToCanonical = new Map<string, string>();

        for (const entry of registry.domains) {
            const canonicalKey = this.normalizeRegistryKey(entry.canonical);
            if (!canonicalKey) {
                continue;
            }
            canonicalSet.add(canonicalKey);

            for (const alias of entry.aliases) {
                const aliasKey = this.normalizeRegistryKey(alias);
                if (!aliasKey || aliasToCanonical.has(aliasKey)) {
                    continue;
                }
                aliasToCanonical.set(aliasKey, entry.canonical);
            }
        }

        return {
            canonicalSet,
            aliasToCanonical,
        };
    }

    /**
     * Normalize a domain name to a registered canonical value following strict precedence.
     */
    normalizeDomain(
        registry: DomainRegistry,
        rawDomain: string | null,
        requirementId: string,
        fallbackSignals: DomainFallbackSignals = {},
    ): DomainNormalizationResult {
        const normalizedRaw = this.normalizeRegistryKey(rawDomain || '');

        const explicitCandidate = this.pickFirstNonEmpty([
            fallbackSignals.explicitDomain,
            rawDomain,
        ]);
        const explicitMatch = this.resolveKnownDomain(registry, explicitCandidate);
        if (explicitMatch) {
            return {
                canonical: explicitMatch.canonical,
                matchedBy: explicitMatch.matchedBy,
                isSuspectedNew: false,
            };
        }

        const fallbackOrdered: Array<{ source: DomainMatchSource; value?: string | null }> = [
            { source: 'reqIdPrefix', value: fallbackSignals.reqIdPrefixDomain },
            { source: 'artifactPathPattern', value: fallbackSignals.artifactPathPatternDomain },
            { source: 'contractPattern', value: fallbackSignals.contractPatternDomain },
            { source: 'keywordMap', value: fallbackSignals.keywordMapDomain },
        ];

        for (const candidate of fallbackOrdered) {
            const known = this.resolveKnownDomain(registry, candidate.value);
            if (known) {
                return {
                    canonical: known.canonical,
                    matchedBy: candidate.source,
                    isSuspectedNew: false,
                };
            }
        }

        const hasMeaningfulInput = Boolean(normalizedRaw) || Boolean(this.normalizeRegistryKey(requirementId));
        return {
            canonical: null,
            matchedBy: 'none',
            isSuspectedNew: hasMeaningfulInput,
        };
    }

    /**
     * Validate registry and return structured RegistryValidationIssue[] aligned with API-8 contract.
     * Includes duplicate-canonical, duplicate-alias, and invalid-slug checks. Binds Req-4, Req-7, INV-9.
     */
    validateRegistryStrict(registry: DomainRegistry): RegistryValidationIssue[] {
        const issues: RegistryValidationIssue[] = [];
        const canonicalToIndexes = new Map<string, number[]>();
        const aliasToIndexes = new Map<string, number[]>();

        registry.domains.forEach((entry, index) => {
            const canonicalKey = this.normalizeRegistryKey(entry.canonical);
            // invalid-slug check (INV-9)
            if (canonicalKey && !/^[a-z0-9][a-z0-9-]*$/.test(canonicalKey)) {
                issues.push({
                    code: 'invalid-slug',
                    message: `Invalid canonical slug "${entry.canonical}": must match pattern [a-z0-9][a-z0-9-]*`,
                    canonical: entry.canonical,
                    entryIndexes: [index],
                });
            }
            if (canonicalKey) {
                const existing = canonicalToIndexes.get(canonicalKey) ?? [];
                existing.push(index);
                canonicalToIndexes.set(canonicalKey, existing);
            }
            for (const alias of entry.aliases) {
                const aliasKey = this.normalizeRegistryKey(alias);
                if (!aliasKey) { continue; }
                const existing = aliasToIndexes.get(aliasKey) ?? [];
                existing.push(index);
                aliasToIndexes.set(aliasKey, existing);
            }
        });

        for (const [canonical, indexes] of canonicalToIndexes.entries()) {
            if (indexes.length > 1) {
                issues.push({ code: 'duplicate-canonical', message: `Duplicate canonical: ${canonical}`, canonical, entryIndexes: indexes });
            }
        }
        for (const [alias, indexes] of aliasToIndexes.entries()) {
            const unique = Array.from(new Set(indexes));
            if (unique.length > 1) {
                issues.push({ code: 'duplicate-alias', message: `Alias mapped by multiple domains: ${alias}`, alias, entryIndexes: unique });
            }
        }
        return issues;
    }

    /**
     * Resolve the repository-local registry path without relying on any global workspace root.
     */
    resolveRegistryPath(repoRoot: string): string {
        const normalizedRoot = normalizeAndValidateRepoRoot(repoRoot);
        const registryPath = path.join(normalizedRoot, REGISTRY_RELATIVE_PATH);
        assertPathInRepoRoot(normalizedRoot, registryPath);
        return registryPath;
    }

    /**
     * Parse the constrained registry YAML format used by docs/domains/registry.yaml.
     */
    parseRegistry(content: string): DomainRegistry {
        const lines = content.replace(/\r\n/g, '\n').split('\n');
        const registry: DomainRegistry = { domains: [] };

        let section: 'domains' | 'lastAggregated' | null = null;
        let currentEntry: Partial<DomainRegistryEntry> | null = null;
        let currentAggregation: { iteration?: string; contentHash?: string; aggregatedAt?: string } | null = null;

        const pushCurrentEntry = (): void => {
            if (!currentEntry) {
                return;
            }
            registry.domains.push({
                canonical: (currentEntry.canonical || '').trim(),
                displayName: (currentEntry.displayName || '').trim(),
                aliases: Array.isArray(currentEntry.aliases) ? currentEntry.aliases.filter(Boolean) : [],
                status: currentEntry.status === 'deprecated' ? 'deprecated' : 'active',
            });
            currentEntry = null;
        };

        const pushCurrentAggregation = (): void => {
            if (!currentAggregation) {
                return;
            }
            if (!registry.lastAggregated) {
                registry.lastAggregated = [];
            }
            if (currentAggregation.iteration && currentAggregation.contentHash && currentAggregation.aggregatedAt) {
                registry.lastAggregated.push({
                    iteration: currentAggregation.iteration,
                    contentHash: currentAggregation.contentHash,
                    aggregatedAt: currentAggregation.aggregatedAt,
                });
            }
            currentAggregation = null;
        };

        for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            if (trimmed === 'domains:') {
                pushCurrentEntry();
                pushCurrentAggregation();
                section = 'domains';
                continue;
            }

            if (trimmed === 'lastAggregated:') {
                pushCurrentEntry();
                pushCurrentAggregation();
                section = 'lastAggregated';
                continue;
            }

            if (section === 'domains' && /^-\s+canonical\s*:/.test(trimmed)) {
                pushCurrentEntry();
                currentEntry = { aliases: [] };
                currentEntry.canonical = this.parseScalarValue(trimmed.replace(/^-\s+canonical\s*:\s*/, ''));
                continue;
            }

            if (section === 'lastAggregated' && /^-\s+iteration\s*:/.test(trimmed)) {
                pushCurrentAggregation();
                currentAggregation = {};
                currentAggregation.iteration = this.parseScalarValue(trimmed.replace(/^-\s+iteration\s*:\s*/, ''));
                continue;
            }

            if (section === 'domains' && currentEntry) {
                if (/^displayName\s*:/.test(trimmed)) {
                    currentEntry.displayName = this.parseScalarValue(trimmed.replace(/^displayName\s*:\s*/, ''));
                    continue;
                }
                if (/^aliases\s*:/.test(trimmed)) {
                    currentEntry.aliases = this.parseInlineArray(trimmed.replace(/^aliases\s*:\s*/, ''));
                    continue;
                }
                if (/^status\s*:/.test(trimmed)) {
                    const status = this.parseScalarValue(trimmed.replace(/^status\s*:\s*/, ''));
                    currentEntry.status = status === 'deprecated' ? 'deprecated' : 'active';
                    continue;
                }
            }

            if (section === 'lastAggregated' && currentAggregation) {
                if (/^contentHash\s*:/.test(trimmed)) {
                    currentAggregation.contentHash = this.parseScalarValue(trimmed.replace(/^contentHash\s*:\s*/, ''));
                    continue;
                }
                if (/^aggregatedAt\s*:/.test(trimmed)) {
                    currentAggregation.aggregatedAt = this.parseScalarValue(trimmed.replace(/^aggregatedAt\s*:\s*/, ''));
                }
            }
        }

        pushCurrentEntry();
        pushCurrentAggregation();
        return registry;
    }

    /**
     * Serialize the registry into the constrained YAML format used by the service.
     */
    serializeRegistry(registry: DomainRegistry): string {
        const lines: string[] = ['domains:'];

        for (const entry of registry.domains) {
            lines.push(`  - canonical: ${this.escapeScalar(entry.canonical)}`);
            lines.push(`    displayName: ${this.escapeScalar(entry.displayName)}`);
            lines.push(`    aliases: ${this.formatInlineArray(entry.aliases)}`);
            lines.push(`    status: ${entry.status}`);
        }

        if (registry.lastAggregated && registry.lastAggregated.length > 0) {
            lines.push('lastAggregated:');
            for (const record of registry.lastAggregated) {
                lines.push(`  - iteration: ${this.escapeScalar(record.iteration)}`);
                lines.push(`    contentHash: ${this.escapeScalar(record.contentHash)}`);
                lines.push(`    aggregatedAt: ${this.escapeScalar(record.aggregatedAt)}`);
            }
        }

        return `${lines.join('\n')}\n`;
    }

    /**
     * Normalize the provided repository root into an absolute path.
     * @deprecated Use normalizeAndValidateRepoRoot from workspaceRoot service instead.
     */
    private normalizeRepoRoot(repoRoot: string): string {
        return normalizeAndValidateRepoRoot(repoRoot);
    }

    /**
     * Write the registry file and ensure its parent directory exists first.
     */
    private writeRegistryFile(filePath: string, registry: DomainRegistry): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, this.serializeRegistry(registry), 'utf8');
    }

    /**
     * Normalize canonical or alias keys before uniqueness checks.
     */
    private normalizeRegistryKey(value: string): string {
        return (value || '').trim().toLowerCase();
    }

    /**
     * Report whether a raw domain value is a reserved fallback sentinel that must
     * never be persisted as an alias (e.g. "uncategorized"). Binds Req-5, Req-8.
     */
    private isReservedDomainToken(value: string): boolean {
        return RESERVED_DOMAIN_TOKENS.has(this.normalizeRegistryKey(value));
    }

    /**
     * Normalize canonical slug values for registry entries.
     */
    private normalizeCanonical(value: string): string {
        return this.normalizeRegistryKey(value).replace(/\s+/g, '-');
    }

    /**
     * Validate registry after mutation and throw if conflict exists.
     */
    private assertRegistryValidOrThrow(registry: DomainRegistry): void {
        const conflicts = this.validateRegistry(registry);
        if (conflicts.length > 0) {
            throw new Error(`Registry conflict: ${conflicts.map(item => item.message).join('; ')}`);
        }
    }

    /**
     * Resolve a candidate domain against canonical names first and aliases second.
     */
    private resolveKnownDomain(
        registry: DomainRegistry,
        candidate: string | null | undefined,
    ): { canonical: string; matchedBy: 'canonical' | 'alias' } | null {
        const normalizedCandidate = this.normalizeRegistryKey(candidate || '');
        if (!normalizedCandidate) {
            return null;
        }

        for (const entry of registry.domains) {
            const normalizedCanonical = this.normalizeRegistryKey(entry.canonical);
            if (normalizedCanonical && normalizedCanonical === normalizedCandidate) {
                return {
                    canonical: entry.canonical,
                    matchedBy: 'canonical',
                };
            }
        }

        for (const entry of registry.domains) {
            for (const alias of entry.aliases) {
                if (this.normalizeRegistryKey(alias) === normalizedCandidate) {
                    return {
                        canonical: entry.canonical,
                        matchedBy: 'alias',
                    };
                }
            }
        }

        return null;
    }

    /**
     * Pick the first non-empty candidate value.
     */
    private pickFirstNonEmpty(values: Array<string | null | undefined>): string | null {
        for (const value of values) {
            if (this.normalizeRegistryKey(value || '')) {
                return value as string;
            }
        }
        return null;
    }

    /**
     * Parse a scalar YAML value by trimming surrounding quotes when present.
     */
    private parseScalarValue(rawValue: string): string {
        const trimmed = rawValue.trim();
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
            return trimmed.slice(1, -1);
        }
        return trimmed;
    }

    /**
     * Parse an inline YAML array like `[a, b, c]` into string items.
     */
    private parseInlineArray(rawValue: string): string[] {
        const trimmed = rawValue.trim();
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
            return [];
        }
        const inner = trimmed.slice(1, -1).trim();
        if (!inner) {
            return [];
        }
        return inner
            .split(',')
            .map(item => this.parseScalarValue(item))
            .map(item => item.trim())
            .filter(Boolean);
    }

    /**
     * Format a string array into the inline YAML array style used by the registry file.
     */
    private formatInlineArray(values: string[]): string {
        if (!values.length) {
            return '[]';
        }
        return `[${values.map(value => this.escapeScalar(value)).join(', ')}]`;
    }

    /**
     * Escape a scalar conservatively when it contains YAML-significant characters.
     */
    private escapeScalar(value: string): string {
        const normalized = value ?? '';
        if (!normalized) {
            return '""';
        }
        if (/[:\[\]#,]|^\s|\s$/.test(normalized)) {
            return `"${normalized.replace(/"/g, '\\"')}"`;
        }
        return normalized;
    }
}