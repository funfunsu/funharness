import * as fs from 'fs';
import * as path from 'path';
import { BASE, HARNESS_LOG_FILE } from '../models';

/**
 * Append one line to the unified per-task harness log at `<baseDir>/.harness/harness.log`.
 *
 * `baseDir` should be the task's iteration / worktree directory, so logs are naturally split per
 * task; pass the master root for non-task operations (e.g. repo initialization). Every subsystem
 * (git, auto-poll, AI dispatch) logs through here, each line tagged with a short `category` so the
 * merged file stays readable:
 *
 *   [2026-05-28T..Z] [git] OK  [/path/repo] git merge --no-ff feat-x
 *   [2026-05-28T..Z] [auto-poll] 已拉取到新任务内容，已更新 todo.md
 *
 * Best-effort: any failure (missing dir, permissions) is swallowed so logging never breaks the
 * operation it is recording.
 */
export function appendHarnessLog(baseDir: string, category: string, message: string): void {
    try {
        const dir = (baseDir || '').trim();
        if (!dir) {
            return;
        }
        const harnessDir = path.join(dir, BASE);
        fs.mkdirSync(harnessDir, { recursive: true });
        fs.appendFileSync(
            path.join(harnessDir, HARNESS_LOG_FILE),
            `[${new Date().toISOString()}] [${category}] ${message}\n`,
            'utf8',
        );
    } catch {
        // logging is best-effort
    }
}

/**
 * Append one Todo-domain log entry with a stable code and optional detail payload.
 */
export function appendTodoLog(baseDir: string, code: string, message: string, detail?: string): void {
    const suffix = detail ? ` | ${detail}` : '';
    appendHarnessLog(baseDir, 'todo', `${code} | ${message}${suffix}`);
}

export interface StructureGateLogViolation {
    ruleId: string;
    location: string;
    suggestion: string;
    message?: string;
}

/**
 * Append a normalized structure-gate failure log entry.
 * Required fields: gateId, violations, location, suggestion.
 */
export function appendStructureGateFailureLog(
    baseDir: string,
    payload: {
        gateId: string;
        violations: StructureGateLogViolation[];
        sourcePath?: string;
    },
): void {
    const violationSummary = payload.violations.map(item => (
        `ruleId=${item.ruleId}; location=${item.location}; suggestion=${item.suggestion}; message=${item.message || ''}`
    ));
    const source = payload.sourcePath ? `sourcePath=${payload.sourcePath}` : 'sourcePath=(unknown)';
    appendHarnessLog(
        baseDir,
        'structure-gate',
        `STRUCTURE_GATE_FAILED | gateId=${payload.gateId} | violations=${violationSummary.join(' || ')} | ${source}`,
    );
}
