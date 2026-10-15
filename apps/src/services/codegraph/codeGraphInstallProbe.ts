import { spawnSync } from 'child_process';

type SpawnSyncLike = typeof spawnSync;

export interface CodeGraphCliProbeResult {
    available: boolean;
    summary: string;
    version?: string;
    checkedAt: string;
}

export interface CodeGraphEnsureCliInput {
    worktreePath: string;
    autoInstallEnabled: boolean;
}

export interface CodeGraphEnsureCliResult {
    ready: boolean;
    attemptedInstall: boolean;
    installedNow: boolean;
    summary: string;
}

/**
 * Probes CodeGraph CLI availability and performs a single non-interactive install attempt when enabled.
 */
export class CodeGraphInstallProbe {
    constructor(
        private readonly spawn: SpawnSyncLike = spawnSync,
        private readonly platform: NodeJS.Platform = process.platform,
    ) {}

    /**
     * Check whether codegraph command is available on PATH.
     */
    probeCli(worktreePath: string): CodeGraphCliProbeResult {
        const checkedAt = new Date().toISOString();
        const failures: string[] = [];
        for (const plan of this.getProbePlans()) {
            const result = this.spawn(plan.command, plan.args, {
                cwd: worktreePath,
                encoding: 'utf8',
                shell: plan.shell ?? false,
                timeout: 10_000,
            });

            if (result.status === 0) {
                const version = (result.stdout || result.stderr || '').trim();
                return {
                    available: true,
                    summary: 'codegraph command is available',
                    version,
                    checkedAt,
                };
            }

            const errorMsg = result.error && typeof result.error.message === 'string'
                ? result.error.message
                : '';
            const stderr = (result.stderr || '').trim();
            const stdout = (result.stdout || '').trim();
            const digest = errorMsg || stderr || stdout || 'probe failed';
            failures.push(`${plan.label}: ${digest}`);
        }

        return {
            available: false,
            summary: failures.length > 0
                ? `codegraph command is not available: ${failures.join(' | ')}`
                : 'codegraph command is not available',
            checkedAt,
        };
    }

    /**
     * Ensure CLI is available; when missing and policy enabled, run one install attempt.
     */
    ensureCli(input: CodeGraphEnsureCliInput): CodeGraphEnsureCliResult {
        const firstProbe = this.probeCli(input.worktreePath);
        if (firstProbe.available) {
            return {
                ready: true,
                attemptedInstall: false,
                installedNow: false,
                summary: firstProbe.version
                    ? `codegraph available (${firstProbe.version})`
                    : 'codegraph available',
            };
        }

        if (!input.autoInstallEnabled) {
            return {
                ready: false,
                attemptedInstall: false,
                installedNow: false,
                summary: 'codegraph missing and auto-install is disabled',
            };
        }

        const installPlans = this.getInstallPlans();
        const failures: string[] = [];
        let installSucceeded = false;

        for (const installPlan of installPlans) {
            const install = this.spawn(installPlan.command, installPlan.args, {
                cwd: input.worktreePath,
                encoding: 'utf8',
                shell: installPlan.shell ?? false,
                timeout: 180_000,
            });

            if (install.status === 0) {
                installSucceeded = true;
                break;
            }

            const errorMsg = install.error && typeof install.error.message === 'string'
                ? install.error.message
                : '';
            const stderr = (install.stderr || '').trim();
            const stdout = (install.stdout || '').trim();
            const digest = errorMsg || stderr || stdout || 'install command failed';
            failures.push(`${installPlan.label}: ${digest}`);
        }

        if (!installSucceeded) {
            const digest = failures.join(' | ') || 'install command failed';
            return {
                ready: false,
                attemptedInstall: true,
                installedNow: false,
                summary: `codegraph auto-install failed: ${digest}. manual: ${this.getManualInstallCommand()}`,
            };
        }

        const secondProbe = this.probeCli(input.worktreePath);
        if (!secondProbe.available) {
            return {
                ready: false,
                attemptedInstall: true,
                installedNow: false,
                summary: 'codegraph install completed but command is still unavailable',
            };
        }

        return {
            ready: true,
            attemptedInstall: true,
            installedNow: true,
            summary: secondProbe.version
                ? `codegraph installed (${secondProbe.version})`
                : 'codegraph installed',
        };
    }

    private getProbePlans(): Array<{ command: string; args: string[]; label: string; shell?: boolean }> {
        if (this.platform === 'win32') {
            const psScript = 'Invoke-Expression (fnm env --shell powershell | Out-String); codegraph --version';
            return [
                {
                    command: 'codegraph',
                    args: ['--version'],
                    label: 'win32:direct',
                },
                {
                    command: 'powershell',
                    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
                    label: 'win32:powershell+fnm',
                },
                {
                    command: 'pwsh',
                    args: ['-NoProfile', '-Command', psScript],
                    label: 'win32:pwsh+fnm',
                },
            ];
        }

        return [{
            command: 'codegraph',
            args: ['--version'],
            label: `${this.platform}:direct`,
        }];
    }

    private getInstallPlans(): Array<{ command: string; args: string[]; label: string; shell?: boolean }> {
        if (this.platform === 'win32') {
            const psScript = 'Invoke-Expression (fnm env --shell powershell | Out-String); npm.cmd install -g @colbymchenry/codegraph';
            return [
                {
                    command: 'npm.cmd',
                    args: ['install', '-g', '@colbymchenry/codegraph'],
                    label: 'win32:npm.cmd',
                },
                {
                    command: 'npm',
                    args: ['install', '-g', '@colbymchenry/codegraph'],
                    label: 'win32:npm',
                },
                {
                    command: 'powershell',
                    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
                    label: 'win32:powershell+fnm',
                },
                {
                    command: 'pwsh',
                    args: ['-NoProfile', '-Command', psScript],
                    label: 'win32:pwsh+fnm',
                },
            ];
        }

        if (this.platform === 'darwin') {
            return [{
                command: 'npm',
                args: ['install', '-g', '@colbymchenry/codegraph'],
                label: 'darwin:npm',
            }];
        }

        return [{
            command: 'npm',
            args: ['install', '-g', '@colbymchenry/codegraph'],
            label: `${this.platform}:npm`,
        }];
    }

    private getManualInstallCommand(): string {
        if (this.platform === 'win32') {
            return 'npm.cmd install -g @colbymchenry/codegraph (if you use fnm: Invoke-Expression (fnm env --shell powershell | Out-String); npm.cmd install -g @colbymchenry/codegraph)';
        }
        return 'npm install -g @colbymchenry/codegraph';
    }
}
