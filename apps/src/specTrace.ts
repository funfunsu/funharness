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
