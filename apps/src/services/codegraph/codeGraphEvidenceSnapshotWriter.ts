import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

type SpawnSyncLike = typeof spawnSync;

export interface CodeGraphEvidenceSnapshotResult {
    persisted: boolean;
    bundlePath: string;
    summary: string;
}

/**
 * Builds a lightweight evidence snapshot that PromptService can inject directly.
 * This keeps CodeGraph usable out-of-the-box without requiring manual bundle export.
 */
export class CodeGraphEvidenceSnapshotWriter {
    constructor(private readonly spawn: SpawnSyncLike = spawnSync) {}

    writeSnapshot(worktreePath: string): CodeGraphEvidenceSnapshotResult {
        const bundlePath = path.join(worktreePath, '.harness', 'process', 'codegraph-evidence.json');
        const generatedAt = new Date().toISOString();
        const statusLines = this.readStatusLines(worktreePath);

        const anchors: string[] = [
            `worktree:${path.basename(worktreePath)}`,
            `generatedAt:${generatedAt}`,
            ...statusLines.map(line => `status:${line}`),
        ];

        const payload = {
            anchors,
            seams: [],
            impactSet: [],
        };

        try {
            fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
            fs.writeFileSync(bundlePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            return {
                persisted: true,
                bundlePath,
                summary: 'evidence snapshot refreshed',
            };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
                persisted: false,
                bundlePath,
                summary: `evidence snapshot write failed: ${detail}`,
            };
        }
    }

    private readStatusLines(worktreePath: string): string[] {
        try {
            let result = this.spawn('codegraph', ['status'], {
                cwd: worktreePath,
                encoding: 'utf8',
                shell: false,
                timeout: 20_000,
            });

            if (result.status !== 0 && process.platform === 'win32') {
                const script = 'Invoke-Expression (fnm env --shell powershell | Out-String); codegraph status';
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
                    const fallback = this.spawn(plan.command, plan.args, {
                        cwd: worktreePath,
                        encoding: 'utf8',
                        shell: false,
                        timeout: 20_000,
                    });
                    if (fallback.status === 0) {
                        result = fallback;
                        break;
                    }
                }
            }

            const raw = `${result.stdout || ''}\n${result.stderr || ''}`
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .slice(0, 8);

            if (raw.length > 0) {
                return raw;
            }
        } catch {
            // Keep snapshot generation best-effort.
        }

        return ['status unavailable'];
    }
}
