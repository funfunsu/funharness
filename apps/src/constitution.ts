import * as fs from 'fs';
import * as path from 'path';
import { BASE, PROMPTS_DIR, deriveMasterRoot, getPrimaryTrackedSpecsDir, getTrackedSpecsDirCandidates } from './models';

/** Team-owned, git-tracked constitution location inside the target repository. */
export const CONSTITUTION_DIR = 'specs';
export const LEGACY_CONSTITUTION_DIR = '.spec';
export const CONSTITUTION_FILE = 'constitution.md';
export const CONSTITUTION_REL_PATH = `${CONSTITUTION_DIR}/${CONSTITUTION_FILE}`;

export interface ResolvedConstitution {
    content: string;
    /** 'project' when found in a repo/worktree/master .spec; 'bundled-default' otherwise. */
    source: 'project' | 'bundled-default';
    path: string;
}

function readIfPresent(candidate: string): string | undefined {
    try {
        if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const text = fs.readFileSync(candidate, 'utf8');
            if (text.trim()) {
                return text;
            }
        }
    } catch {
        // ignore unreadable candidate
    }
    return undefined;
}

/**
 * Resolve the effective constitution for a pipeline run.
 *
 * Search order (first non-empty wins):
 *   1. <iterDir>/specs/constitution.md                     (per-iteration override)
 *   2. <masterRoot>/repos/{mono-main,backend-main,frontend-main}/specs/constitution.md
 *   3. <workspaceRoot>/specs/constitution.md
 *   4. <masterRoot>/specs/constitution.md
 *   5. Legacy .spec/* fallbacks for backward compatibility
 *   6. bundled default (apps/system-prompts/constitution_default.md)
 */
export function resolveConstitution(
    iterDir: string,
    workspaceRoot: string,
    extensionPath: string,
): ResolvedConstitution {
    const masterRoot = deriveMasterRoot(workspaceRoot);
    const projectCandidates: string[] = [
        path.join(iterDir, CONSTITUTION_DIR, CONSTITUTION_FILE),
        ...getTrackedSpecsDirCandidates(workspaceRoot).map(dir => path.join(dir, CONSTITUTION_FILE)),
        // Backward compatibility: read legacy .spec path if present.
        path.join(iterDir, LEGACY_CONSTITUTION_DIR, CONSTITUTION_FILE),
        path.join(workspaceRoot, LEGACY_CONSTITUTION_DIR, CONSTITUTION_FILE),
        path.join(masterRoot, 'repos', 'mono-main', LEGACY_CONSTITUTION_DIR, CONSTITUTION_FILE),
        path.join(masterRoot, 'repos', 'backend-main', LEGACY_CONSTITUTION_DIR, CONSTITUTION_FILE),
        path.join(masterRoot, 'repos', 'frontend-main', LEGACY_CONSTITUTION_DIR, CONSTITUTION_FILE),
        path.join(masterRoot, LEGACY_CONSTITUTION_DIR, CONSTITUTION_FILE),
    ];
    const seen = new Set<string>();
    for (const candidate of projectCandidates) {
        if (seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);
        const content = readIfPresent(candidate);
        if (content !== undefined) {
            return { content, source: 'project', path: candidate };
        }
    }

    const bundledCandidates = [
        path.join(extensionPath, 'system-prompts', CONSTITUTION_FILE.replace('.md', '_default.md')),
        path.join(extensionPath, BASE, PROMPTS_DIR, CONSTITUTION_FILE.replace('.md', '_default.md')),
    ];
    for (const candidate of bundledCandidates) {
        const content = readIfPresent(candidate);
        if (content !== undefined) {
            // Auto-seed the preferred git-tracked specs location so users can edit and commit it.
            const seedPath = path.join(getPrimaryTrackedSpecsDir(workspaceRoot), CONSTITUTION_FILE);
            if (!fs.existsSync(seedPath)) {
                try {
                    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
                    fs.writeFileSync(seedPath, content, 'utf8');
                } catch {
                    // Non-fatal: read-only workspace or permission issue — silently ignore.
                }
            }
            return { content, source: 'bundled-default', path: candidate };
        }
    }
    return { content: '', source: 'bundled-default', path: bundledCandidates[0] };
}

/**
 * Strip an optional leading YAML frontmatter block so the prompt injects clean prose.
 * Returns both the stripped body and any detected `version:` for provenance.
 */
export function summarizeConstitution(content: string): { body: string; version?: string } {
    const trimmed = content.replace(/^\uFEFF/, '');
    const fmMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    let body = trimmed;
    let version: string | undefined;
    if (fmMatch) {
        body = trimmed.slice(fmMatch[0].length);
        const verLine = fmMatch[1].match(/^\s*version:\s*(.+?)\s*$/m);
        if (verLine) {
            version = verLine[1].replace(/^["']|["']$/g, '').trim();
        }
    }
    return { body: body.trim(), version };
}
