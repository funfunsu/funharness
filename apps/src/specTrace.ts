/**
 * Lightweight, dependency-free traceability validator for Fun Harness artifacts.
 *
 * It does NOT do full YAML parsing (no js-yaml available). Instead it extracts the
 * machine-readable ```yaml``` fenced block (the one carrying `artifactType:`) and
 * scans requirement IDs to verify cross-artifact ID closure:
 *   - no dangling references (every referenced Req-* must be defined in requirements.md)
 *   - no orphan requirements (every defined Req-* must be covered by the downstream artifact)
 */

export type TraceArtifactKind = 'des' | 'tcs' | 'tsk';

export interface TraceLink {
    requirementId: string;
    designRefs: string[];
    taskRefs: string[];
    testRefs: string[];
    status: 'complete' | 'incomplete';
}

export interface TraceMatrixSnapshot {
    traceMatrix: TraceLink[];
    orphanChanges: string[];
    checkedAt: string;
}

/** Extract the fenced ```yaml block that contains `artifactType:` (the machine-readable region). */
export function extractMachineBlock(content: string): string {
    const fenceRe = /```\s*ya?ml\s*\r?\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    let fallback: string | undefined;
    while ((match = fenceRe.exec(content)) !== null) {
        const body = match[1];
        if (/artifactType\s*:/i.test(body)) {
            return body;
        }
        if (fallback === undefined) {
            fallback = body;
        }
    }
    return fallback ?? '';
}

/** Collect requirement IDs defined at the top level of requirements.md machine block. */
export function collectDefinedReqIds(requirementsContent: string): string[] {
    const block = extractMachineBlock(requirementsContent);
    const source = block || requirementsContent;
    const ids = new Set<string>();
    const re = /^\s*-\s*id\s*:\s*(Req-[\w-]+)/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        ids.add(m[1]);
    }
    return Array.from(ids);
}

/** Collect every requirement ID referenced anywhere in an artifact machine block. */
export function collectReferencedReqIds(artifactContent: string): string[] {
    const block = extractMachineBlock(artifactContent);
    const source = block || artifactContent;
    const ids = new Set<string>();

    // requirementIds: [Req-1, Req-2]
    const listRe = /requirementIds?\s*:\s*\[([^\]]*)\]/gi;
    let m: RegExpExecArray | null;
    while ((m = listRe.exec(source)) !== null) {
        const inner = m[1];
        const tokenRe = /Req-[\w-]+/g;
        let t: RegExpExecArray | null;
        while ((t = tokenRe.exec(inner)) !== null) {
            ids.add(t[0]);
        }
    }

    // requirementId: Req-1  (singular scalar form)
    const scalarRe = /requirementId\s*:\s*(Req-[\w-]+)/gi;
    while ((m = scalarRe.exec(source)) !== null) {
        ids.add(m[1]);
    }

    return Array.from(ids);
}

const COVERAGE_LABEL: Record<TraceArtifactKind, string> = {
    des: '设计契约/模型/不变量',
    tcs: '测试用例',
    tsk: '开发任务',
};

/**
 * Validate ID closure between requirements.md and a downstream artifact.
 * Returns a list of human-readable error strings (empty = pass).
 *
 * @param enforceCoverage when false (relaxed gate), orphan/uncovered requirements are
 *        NOT reported as errors; only dangling references (structural integrity) block.
 */
export function validateTraceability(
    requirementsContent: string,
    artifactContent: string,
    kind: TraceArtifactKind,
    enforceCoverage = true,
): string[] {
    const errors: string[] = [];
    const defined = collectDefinedReqIds(requirementsContent);
    if (defined.length === 0) {
        errors.push('无法完成追溯校验：requirements.md 机器块未定义任何 Req-* 需求');
        return errors;
    }

    const definedSet = new Set(defined);
    const referenced = collectReferencedReqIds(artifactContent);
    const referencedSet = new Set(referenced);

    const dangling = referenced.filter((id) => !definedSet.has(id));
    if (dangling.length > 0) {
        const shown = dangling.slice(0, 10).join('、');
        errors.push(`追溯断裂：${kind} 机器块引用了 requirements.md 中不存在的需求 ${shown}`);
    }

    if (enforceCoverage) {
        const orphans = defined.filter((id) => !referencedSet.has(id));
        if (orphans.length > 0) {
            const shown = orphans.slice(0, 10).join('、');
            errors.push(`追溯缺口：需求 ${shown} 未被任何${COVERAGE_LABEL[kind]}覆盖（缺少对应 requirementIds）`);
        }
    }

    return errors;
}

/** Build a full Req-* trace matrix across design, tasks, and testcase artifacts. */
export function buildTraceMatrix(
    requirementsContent: string,
    designContent: string,
    tasksContent: string,
    testcaseContent?: string,
): TraceLink[] {
    const definedReqIds = collectDefinedReqIds(requirementsContent);
    const definedReqSet = new Set(definedReqIds);
    const designRefs = collectArtifactRequirementRefs(designContent);
    const taskRefs = collectArtifactRequirementRefs(tasksContent);
    const testRefs = collectArtifactRequirementRefs(testcaseContent || '');

    return definedReqIds.map(requirementId => {
        const designMatches = designRefs.get(requirementId) || [];
        const taskMatches = taskRefs.get(requirementId) || [];
        const testMatches = testRefs.get(requirementId) || [];
        const status = designMatches.length > 0 && taskMatches.length > 0 && testMatches.length > 0
            ? 'complete'
            : 'incomplete';
        return {
            requirementId,
            designRefs: filterDefinedRefs(designMatches, definedReqSet),
            taskRefs: filterDefinedRefs(taskMatches, definedReqSet),
            testRefs: filterDefinedRefs(testMatches, definedReqSet),
            status,
        };
    });
}

/** Detect trace-closure breaks: dangling refs and requirements lacking downstream mappings. */
export function detectOrphanChanges(
    requirementsContent: string,
    designContent: string,
    tasksContent: string,
    testcaseContent?: string,
): string[] {
    const orphanChanges: string[] = [];
    const definedReqIds = collectDefinedReqIds(requirementsContent);
    const definedReqSet = new Set(definedReqIds);
    const designRefs = collectArtifactRequirementRefs(designContent);
    const taskRefs = collectArtifactRequirementRefs(tasksContent);
    const testRefs = collectArtifactRequirementRefs(testcaseContent || '');

    const downstreamRefs = new Map<string, string[]>();
    mergeRefMap(downstreamRefs, designRefs);
    mergeRefMap(downstreamRefs, taskRefs);
    mergeRefMap(downstreamRefs, testRefs);

    for (const [requirementId, refs] of downstreamRefs.entries()) {
        if (!definedReqSet.has(requirementId)) {
            orphanChanges.push(`TRACE_CLOSURE_BROKEN: dangling requirement reference ${requirementId} -> ${refs.join(', ')}`);
        }
    }

    const traceMatrix = buildTraceMatrix(requirementsContent, designContent, tasksContent, testcaseContent);
    for (const link of traceMatrix) {
        if (link.designRefs.length === 0 && link.taskRefs.length === 0 && link.testRefs.length === 0) {
            orphanChanges.push(`TRACE_CLOSURE_BROKEN: ${link.requirementId} has no design/task/test mapping`);
            continue;
        }
        if (link.designRefs.length === 0) {
            orphanChanges.push(`TRACE_CLOSURE_BROKEN: ${link.requirementId} missing design mapping`);
        }
        if (link.taskRefs.length === 0) {
            orphanChanges.push(`TRACE_CLOSURE_BROKEN: ${link.requirementId} missing task mapping`);
        }
        if (link.testRefs.length === 0) {
            orphanChanges.push(`TRACE_CLOSURE_BROKEN: ${link.requirementId} missing test mapping`);
        }
    }

    return Array.from(new Set(orphanChanges));
}

/** Build an API-3 style snapshot with trace matrix, orphan changes, and timestamp. */
export function buildTraceMatrixSnapshot(
    requirementsContent: string,
    designContent: string,
    tasksContent: string,
    testcaseContent?: string,
): TraceMatrixSnapshot {
    return {
        traceMatrix: buildTraceMatrix(requirementsContent, designContent, tasksContent, testcaseContent),
        orphanChanges: detectOrphanChanges(requirementsContent, designContent, tasksContent, testcaseContent),
        checkedAt: new Date().toISOString(),
    };
}

/** Collect per-requirement reference locations from an artifact's machine block. */
function collectArtifactRequirementRefs(content: string): Map<string, string[]> {
    const source = extractMachineBlock(content) || content;
    const refs = new Map<string, string[]>();
    const lines = source.split(/\r?\n/);
    let currentAnchor = 'machine-block';

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const anchorMatch = line.match(/^\s*[-]?\s*(id|name|title)\s*:\s*([^\n#]+)/i);
        if (anchorMatch) {
            currentAnchor = `${anchorMatch[1]}=${anchorMatch[2].trim()}`;
        }
        const reqMatches = line.match(/Req-[\w-]+/g) || [];
        for (const requirementId of reqMatches) {
            const existing = refs.get(requirementId) || [];
            const ref = `${currentAnchor}@L${index + 1}`;
            if (!existing.includes(ref)) {
                existing.push(ref);
            }
            refs.set(requirementId, existing);
        }
    }

    return refs;
}

/** Merge requirement-ref maps while preserving insertion order and deduplicating locations. */
function mergeRefMap(target: Map<string, string[]>, source: Map<string, string[]>): void {
    for (const [requirementId, refs] of source.entries()) {
        const existing = target.get(requirementId) || [];
        for (const ref of refs) {
            if (!existing.includes(ref)) {
                existing.push(ref);
            }
        }
        target.set(requirementId, existing);
    }
}

/** Keep refs stable and deduplicated for requirements known by requirements.md. */
function filterDefinedRefs(refs: string[], definedReqSet: Set<string>): string[] {
    if (refs.length === 0) {
        return [];
    }
    return Array.from(new Set(refs)).filter(() => definedReqSet.size >= 0);
}
