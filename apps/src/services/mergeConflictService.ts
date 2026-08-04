import {
    DomainCapabilityRecord,
    DomainConflict,
    DomainContractRecord,
    DomainInvariantRecord,
    ProjectedDomainDocument,
} from '../models';

/**
 * Three-way merge outcome for a single record keyed within a domain section.
 */
type MergeOutcome<T> =
    | { kind: 'ok'; record: T }
    | { kind: 'conflict'; sectionId: string; base?: T; current?: T; draft?: T };

/**
 * Service for three-way merge conflict detection on domain documents.
 * Compares base/current/draft versions of ProjectedDomainDocument arrays and
 * produces document-merge conflicts for sections that cannot be auto-merged.
 * Implements API-12. Binds Req-4, Req-5, Req-8.
 */
export class MergeConflictService {
    /**
     * Perform three-way document merge conflict detection.
     * For each domain section (capabilities / contracts / invariants):
     *   - Only draft changed   → auto-merge (take draft)
     *   - Only current changed → auto-merge (take current)
     *   - Both changed identically → auto-merge (take either)
     *   - Both changed differently → blocking document-merge conflict
     * Binds Req-4, Req-5, Req-8.
     */
    detectDocumentMergeConflicts(
        baseDocuments: ProjectedDomainDocument[],
        currentDocuments: ProjectedDomainDocument[],
        draftDocuments: ProjectedDomainDocument[],
    ): { conflicts: DomainConflict[]; autoMergedDocuments: ProjectedDomainDocument[] } {
        const baseMap = this.indexByCanonical(baseDocuments);
        const currentMap = this.indexByCanonical(currentDocuments);
        const draftMap = this.indexByCanonical(draftDocuments);

        const allDomains = new Set<string>([
            ...baseMap.keys(),
            ...currentMap.keys(),
            ...draftMap.keys(),
        ]);

        const conflicts: DomainConflict[] = [];
        const autoMergedDocuments: ProjectedDomainDocument[] = [];

        for (const domain of Array.from(allDomains).sort()) {
            const base = baseMap.get(domain);
            const current = currentMap.get(domain);
            const draft = draftMap.get(domain);

            const domainConflicts: string[] = [];
            const mergedCapabilities = this.mergeSection<DomainCapabilityRecord>(
                base?.capabilities ?? [],
                current?.capabilities ?? [],
                draft?.capabilities ?? [],
                r => r.reqId,
                (a, b) => this.capabilityEqual(a, b),
                `${domain}:capability`,
                domainConflicts,
            );
            const mergedContracts = this.mergeSection<DomainContractRecord>(
                base?.contracts ?? [],
                current?.contracts ?? [],
                draft?.contracts ?? [],
                r => r.id,
                (a, b) => this.contractEqual(a, b),
                `${domain}:contract`,
                domainConflicts,
            );
            const mergedInvariants = this.mergeSection<DomainInvariantRecord>(
                base?.invariants ?? [],
                current?.invariants ?? [],
                draft?.invariants ?? [],
                r => r.id,
                (a, b) => this.invariantEqual(a, b),
                `${domain}:invariant`,
                domainConflicts,
            );

            if (domainConflicts.length > 0) {
                conflicts.push({
                    id: `document-merge:${domain}`,
                    type: 'document-merge',
                    severity: 'blocking',
                    reqIds: [],
                    message: `领域 "${domain}" 存在不可自动合并的文档冲突`,
                    conflictingSections: domainConflicts,
                });
            }

            autoMergedDocuments.push({
                canonicalDomain: domain,
                version: (draft ?? current ?? base)?.version ?? 'v0',
                capabilities: mergedCapabilities,
                contracts: mergedContracts,
                invariants: mergedInvariants,
                markdownContent: '',
            });
        }

        return { conflicts, autoMergedDocuments };
    }

    /**
     * Three-way merge a single typed section array.
     * Returns the merged records; appends section IDs for unresolvable conflicts to `conflictSectionIds`.
     */
    private mergeSection<T>(
        base: T[],
        current: T[],
        draft: T[],
        keyOf: (record: T) => string,
        equal: (a: T, b: T) => boolean,
        sectionPrefix: string,
        conflictSectionIds: string[],
    ): T[] {
        const baseMap = new Map(base.map(r => [keyOf(r), r]));
        const currentMap = new Map(current.map(r => [keyOf(r), r]));
        const draftMap = new Map(draft.map(r => [keyOf(r), r]));

        const allKeys = new Set<string>([
            ...baseMap.keys(),
            ...currentMap.keys(),
            ...draftMap.keys(),
        ]);

        const result: T[] = [];
        for (const key of Array.from(allKeys).sort()) {
            const outcome = this.mergeRecord(
                baseMap.get(key),
                currentMap.get(key),
                draftMap.get(key),
                equal,
                `${sectionPrefix}:${key}`,
            );
            if (outcome.kind === 'conflict') {
                conflictSectionIds.push(outcome.sectionId);
                // Include draft version as best-effort placeholder; commit is blocked.
                const placeholder = outcome.draft ?? outcome.current ?? outcome.base;
                if (placeholder) {
                    result.push(placeholder);
                }
            } else {
                result.push(outcome.record);
            }
        }
        return result;
    }

    /**
     * Decide how to merge one record keyed by its ID.
     * Three-way merge rules:
     *   base=A, current=A, draft=B → take draft   (only draft changed)
     *   base=A, current=B, draft=A → take current (only current changed)
     *   base=A, current=B, draft=B → take either  (both changed to same value)
     *   base=A, current=B, draft=C → conflict     (divergent changes)
     *   base=undefined, current=B, draft=C (B≠C) → conflict (concurrent adds)
     */
    private mergeRecord<T>(
        base: T | undefined,
        current: T | undefined,
        draft: T | undefined,
        equal: (a: T, b: T) => boolean,
        sectionId: string,
    ): MergeOutcome<T> {
        // Both absent: nothing to merge.
        if (!current && !draft) {
            return base ? { kind: 'ok', record: base } : { kind: 'conflict', sectionId, base, current, draft };
        }

        // Current deleted, draft present or vice-versa with a change → conflict
        if (!current && draft) {
            if (!base) {
                return { kind: 'ok', record: draft };
            }
            return { kind: 'conflict', sectionId, base, current, draft };
        }
        if (current && !draft) {
            if (!base) {
                return { kind: 'ok', record: current };
            }
            return { kind: 'conflict', sectionId, base, current, draft };
        }

        // Both present
        const cur = current!;
        const drft = draft!;

        if (equal(cur, drft)) {
            return { kind: 'ok', record: cur };
        }

        if (base) {
            const currentSame = equal(cur, base);
            const draftSame = equal(drft, base);
            if (currentSame && !draftSame) {
                return { kind: 'ok', record: drft };
            }
            if (!currentSame && draftSame) {
                return { kind: 'ok', record: cur };
            }
        }

        // Divergent: both changed from base (or new key appeared in both with different content)
        return { kind: 'conflict', sectionId, base, current, draft };
    }

    /** Build a Map<canonicalDomain, ProjectedDomainDocument>. */
    private indexByCanonical(docs: ProjectedDomainDocument[]): Map<string, ProjectedDomainDocument> {
        const map = new Map<string, ProjectedDomainDocument>();
        for (const doc of docs) {
            map.set(doc.canonicalDomain, doc);
        }
        return map;
    }

    /** Equality check for DomainCapabilityRecord. */
    private capabilityEqual(a: DomainCapabilityRecord, b: DomainCapabilityRecord): boolean {
        return (
            a.reqId === b.reqId &&
            a.title === b.title &&
            a.status === b.status &&
            a.userStory === b.userStory
        );
    }

    /** Equality check for DomainContractRecord. */
    private contractEqual(a: DomainContractRecord, b: DomainContractRecord): boolean {
        return (
            a.id === b.id &&
            a.reqId === b.reqId &&
            a.method === b.method &&
            a.path === b.path &&
            JSON.stringify(a.requestShape) === JSON.stringify(b.requestShape) &&
            JSON.stringify(a.responseShape) === JSON.stringify(b.responseShape)
        );
    }

    /** Equality check for DomainInvariantRecord. */
    private invariantEqual(a: DomainInvariantRecord, b: DomainInvariantRecord): boolean {
        return a.id === b.id && a.reqId === b.reqId && a.text === b.text;
    }
}
