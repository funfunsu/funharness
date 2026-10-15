import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface CodeGraphBuildInput {
    worktreePath: string;
}

export interface CodeGraphBuildResult {
    status: 'success' | 'warning';
    summary: string;
    startedAt: string;
    endedAt: string;
}

/**
 * Runs the CodeGraph initialization command in a worktree and normalizes execution status.
 */
export class CodeGraphBuildRunner {
    /**
     * Execute one build attempt and return normalized success/warning result.
     */
    runInitBuild(input: CodeGraphBuildInput): CodeGraphBuildResult {
        const startedAt = new Date().toISOString();
        let result = spawnSync('codegraph', ['init'], {
            cwd: input.worktreePath,
            encoding: 'utf8',
            shell: false,
            timeout: 180_000,
        });
        if (result.status !== 0 && process.platform === 'win32') {
            const script = 'Invoke-Expression (fnm env --shell powershell | Out-String); codegraph init';
            const plans: Array<{ command: string; args: string[] }> = [
                {
                    command: 'powershell',
                    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
                },
                {
                    command: 'pwsh',
                    args: ['-NoProfile', '-Command', script],
                },
            ];

            for (const plan of plans) {
                const fallback = spawnSync(plan.command, plan.args, {
                    cwd: input.worktreePath,
                    encoding: 'utf8',
                    shell: false,
                    timeout: 180_000,
                });
                if (fallback.status === 0) {
                    result = fallback;
                    break;
                }
            }
        }
        const endedAt = new Date().toISOString();

        if (result.status !== 0) {
            const stderr = (result.stderr || '').trim();
            const stdout = (result.stdout || '').trim();
            const digest = stderr || stdout || 'codegraph init failed';
            return {
                status: 'warning',
                summary: `codegraph init warning: ${digest}`,
                startedAt,
                endedAt,
            };
        }

        const codeGraphDir = path.join(input.worktreePath, '.codegraph');
        if (!fs.existsSync(codeGraphDir)) {
            return {
                status: 'warning',
                summary: 'codegraph init completed but .codegraph directory is missing',
                startedAt,
                endedAt,
            };
        }

        return {
            status: 'success',
            summary: 'codegraph init completed successfully',
            startedAt,
            endedAt,
        };
    }
}
