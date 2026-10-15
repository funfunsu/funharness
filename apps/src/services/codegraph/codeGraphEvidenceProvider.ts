import * as fs from 'fs';
import * as path from 'path';
import {
    CodeGraphEvidenceBundle,
    CodeGraphEvidenceFreshness,
    CodeGraphEvidenceSeam,
    CodeGraphEvidenceStage,
} from '../../models';

export interface CodeGraphEvidenceInput {
    worktreePath: string;
    stage: CodeGraphEvidenceStage;
    budgetTokens: number;
    freshnessPolicy?: 'latest-success-record';
}

interface CodeGraphEvidenceCore {
    anchors: string[];
    seams: CodeGraphEvidenceSeam[];
    impactSet: string[];
}

interface CodeGraphEvidenceCacheEntry {
    bundlePath: string;
    fileStamp: string;
    core: CodeGraphEvidenceCore;
}

/**
 * Loads CodeGraph evidence bundles from disk, applies lightweight cache and marks stale/missing freshness.
 */
export class CodeGraphEvidenceProvider {
    private readonly cacheByWorktree = new Map<string, CodeGraphEvidenceCacheEntry>();

    constructor(private readonly staleThresholdMs: number = 24 * 60 * 60 * 1000) {}

    /**
     * Read stage evidence with budget trimming and freshness status.
     */
    getStageEvidence(input: CodeGraphEvidenceInput): CodeGraphEvidenceBundle {
        const normalizedWorktreePath = path.resolve(input.worktreePath);
        const bundlePath = this.resolveBundlePath(normalizedWorktreePath);

        if (!bundlePath) {
            return {
                usable: false,
                freshness: 'missing',
                anchors: [],
                seams: [],
                impactSet: [],
                bundlePath: path.join(normalizedWorktreePath, '.codegraph', 'evidence.json'),
                warning: 'codegraph evidence bundle is missing',
            };
        }

        const cachedOrLoaded = this.readCoreFromCacheOrDisk(normalizedWorktreePath, bundlePath);
        if (!cachedOrLoaded) {
            return {
                usable: false,
                freshness: 'missing',
                anchors: [],
                seams: [],
                impactSet: [],
                bundlePath,
                warning: 'codegraph evidence bundle is unreadable',
            };
        }

        const freshness = this.resolveFreshness(normalizedWorktreePath, input.freshnessPolicy);
        const warning = freshness === 'fresh' ? undefined : 'codegraph evidence is stale; provider falls back to warning mode';
        const trimmed = this.applyBudget(cachedOrLoaded.core, input.stage, input.budgetTokens);

        return {
            usable: freshness === 'fresh',
            freshness,
            anchors: trimmed.anchors,
            seams: trimmed.seams,
            impactSet: trimmed.impactSet,
            bundlePath,
            warning,
        };
    }

    /**
     * Load evidence core from memory cache when file stamp matches, otherwise refresh from disk.
     */
    private readCoreFromCacheOrDisk(worktreePath: string, bundlePath: string): CodeGraphEvidenceCacheEntry | undefined {
        const fileStamp = this.getFileStamp(bundlePath);
        if (!fileStamp) {
            return undefined;
        }

        const cacheKey = this.getCacheKey(worktreePath);
        const cached = this.cacheByWorktree.get(cacheKey);
        if (cached && cached.bundlePath === bundlePath && cached.fileStamp === fileStamp) {
            return cached;
        }

        const parsed = this.loadEvidenceCore(bundlePath);
        if (!parsed) {
            return undefined;
        }

        const entry: CodeGraphEvidenceCacheEntry = {
            bundlePath,
            fileStamp,
            core: parsed,
        };
        this.cacheByWorktree.set(cacheKey, entry);
        return entry;
    }

    /**
     * Resolve freshness by checking latest successful run timestamp from process ledger.
     */
    private resolveFreshness(worktreePath: string, freshnessPolicy?: 'latest-success-record'): CodeGraphEvidenceFreshness {
        if (freshnessPolicy && freshnessPolicy !== 'latest-success-record') {
            return 'stale';
        }
        const latestSuccessAt = this.getLatestSuccessTimestamp(worktreePath);
        if (!latestSuccessAt) {
            return 'stale';
        }
        if (Date.now() - latestSuccessAt > this.staleThresholdMs) {
            return 'stale';
        }
        return 'fresh';
    }

    /**
     * Find the first existing bundle path from known CodeGraph evidence candidates.
     */
    private resolveBundlePath(worktreePath: string): string | undefined {
        const candidates = [
            path.join(worktreePath, '.codegraph', 'evidence.json'),
            path.join(worktreePath, '.codegraph', 'evidence', 'bundle.json'),
            path.join(worktreePath, '.harness', 'process', 'codegraph-evidence.json'),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    /**
     * Parse and normalize evidence payload into anchors/seams/impactSet arrays.
     */
    private loadEvidenceCore(bundlePath: string): CodeGraphEvidenceCore | undefined {
        try {
            const rawText = fs.readFileSync(bundlePath, 'utf8');
            const payload = JSON.parse(rawText) as Record<string, unknown>;

            const anchors = this.normalizeStringArray(payload.anchors);
            const impactSet = this.normalizeStringArray(payload.impactSet);
            const seams = this.normalizeSeams(payload.seams);

            return { anchors, seams, impactSet };
        } catch {
            return undefined;
        }
    }

    /**
     * Trim evidence volume by stage-aware priority and approximate token budget.
     */
    private applyBudget(core: CodeGraphEvidenceCore, stage: CodeGraphEvidenceStage, budgetTokens: number): CodeGraphEvidenceCore {
        if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
            return { anchors: [], seams: [], impactSet: [] };
        }

        const budget = Math.max(32, Math.floor(budgetTokens));
        let consumed = 0;

        const pushWithBudget = <T>(items: T[], estimate: (item: T) => number): T[] => {
            const accepted: T[] = [];
            for (const item of items) {
                const cost = Math.max(1, estimate(item));
                if (consumed + cost > budget) {
                    break;
                }
                accepted.push(item);
                consumed += cost;
            }
            return accepted;
        };

        const anchorCost = (value: string): number => Math.ceil(value.length / 4);
        const seamCost = (value: CodeGraphEvidenceSeam): number => Math.ceil((value.caller.length + value.callee.length + value.relation.length) / 4);

        let anchors: string[] = [];
        let seams: CodeGraphEvidenceSeam[] = [];
        let impactSet: string[] = [];

        if (stage === 'req') {
            anchors = pushWithBudget(core.anchors, anchorCost);
            seams = pushWithBudget(core.seams, seamCost);
            impactSet = pushWithBudget(core.impactSet, anchorCost);
        } else if (stage === 'des') {
            seams = pushWithBudget(core.seams, seamCost);
            anchors = pushWithBudget(core.anchors, anchorCost);
            impactSet = pushWithBudget(core.impactSet, anchorCost);
        } else if (stage === 'tsk') {
            impactSet = pushWithBudget(core.impactSet, anchorCost);
            seams = pushWithBudget(core.seams, seamCost);
            anchors = pushWithBudget(core.anchors, anchorCost);
        } else {
            seams = pushWithBudget(core.seams, seamCost);
            impactSet = pushWithBudget(core.impactSet, anchorCost);
            anchors = pushWithBudget(core.anchors, anchorCost);
        }

        return { anchors, seams, impactSet };
    }

    /**
     * Read latest successful run timestamp from .harness/process/codegraph-runs.jsonl.
     */
    private getLatestSuccessTimestamp(worktreePath: string): number | undefined {
        const ledgerPath = path.join(worktreePath, '.harness', 'process', 'codegraph-runs.jsonl');
        if (!fs.existsSync(ledgerPath)) {
            return undefined;
        }

        try {
            const content = fs.readFileSync(ledgerPath, 'utf8');
            const lines = content.split(/\r?\n/).filter(Boolean);
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                const line = lines[index];
                const parsed = JSON.parse(line) as { status?: string; endedAt?: string };
                if (parsed.status !== 'success' || !parsed.endedAt) {
                    continue;
                }
                const timestamp = Date.parse(parsed.endedAt);
                if (!Number.isNaN(timestamp)) {
                    return timestamp;
                }
            }
        } catch {
            return undefined;
        }

        return undefined;
    }

    /**
     * Compute a stable cache key for path comparison across platforms.
     */
    private getCacheKey(worktreePath: string): string {
        const resolved = path.resolve(worktreePath);
        if (process.platform === 'win32') {
            return resolved.replace(/\\/g, '/').toLowerCase();
        }
        return resolved;
    }

    /**
     * Build a file stamp from mtime and size to detect bundle updates cheaply.
     */
    private getFileStamp(filePath: string): string | undefined {
        try {
            const stat = fs.statSync(filePath);
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return undefined;
        }
    }

    /**
     * Normalize unknown JSON array payload into a string array.
     */
    private normalizeStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }

    /**
     * Normalize seam records while tolerating partially shaped payloads.
     */
    private normalizeSeams(value: unknown): CodeGraphEvidenceSeam[] {
        if (!Array.isArray(value)) {
            return [];
        }

        const seams: CodeGraphEvidenceSeam[] = [];
        for (const item of value) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const record = item as Record<string, unknown>;
            const caller = typeof record.caller === 'string' ? record.caller.trim() : '';
            const callee = typeof record.callee === 'string' ? record.callee.trim() : '';
            const relation = typeof record.relation === 'string' ? record.relation.trim() : '';
            if (!caller || !callee || !relation) {
                continue;
            }
            seams.push({ caller, callee, relation });
        }
        return seams;
    }
}