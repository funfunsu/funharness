import { CodeGraphDedupeGuard } from './codeGraphDedupeGuard';
import { CodeGraphInstallProbe } from './codeGraphInstallProbe';
import { CodeGraphBuildRunner } from './codeGraphBuildRunner';
import { CodeGraphRunLedger } from './codeGraphRunLedger';
import { CodeGraphEvidenceSnapshotWriter } from './codeGraphEvidenceSnapshotWriter';
import { CodeGraphAgentsGuideUpdater } from './codeGraphAgentsGuideUpdater';
import { isCodeGraphInitialized } from './codeGraphState';

export type CodeGraphInitEntryPoint = 'openFolderLocationByFeatureId' | 'runCustomButtonByFeatureId' | 'syncCodeGraphByFeatureId';

export interface CodeGraphInitInput {
    sessionId: string;
    worktreePath: string;
    featureId?: string;
    taskName?: string;
    entryPoint: CodeGraphInitEntryPoint;
    autoCodeGraphEnabled: boolean;
    autoInstallEnabled: boolean;
}

export type CodeGraphInitStatus = 'success' | 'warning' | 'deduped';

export interface CodeGraphInitResult {
    status: CodeGraphInitStatus;
    summary: string;
    startedAt: string;
    endedAt: string;
}

/**
 * Orchestrates one CodeGraph init attempt per session/worktree active window.
 */
export class CodeGraphInitOrchestrator {
    constructor(
        private readonly dedupeGuard: CodeGraphDedupeGuard,
        private readonly installProbe: CodeGraphInstallProbe = new CodeGraphInstallProbe(),
        private readonly buildRunner: CodeGraphBuildRunner = new CodeGraphBuildRunner(),
        private readonly runLedger: CodeGraphRunLedger = new CodeGraphRunLedger(),
        private readonly evidenceSnapshotWriter: CodeGraphEvidenceSnapshotWriter = new CodeGraphEvidenceSnapshotWriter(),
        private readonly agentsGuideUpdater: CodeGraphAgentsGuideUpdater = new CodeGraphAgentsGuideUpdater(),
    ) {}

    /**
     * Run init once for a session/worktree pair; repeated active triggers become deduped.
     */
    async runOnce(input: CodeGraphInitInput): Promise<CodeGraphInitResult> {
        const startedAt = new Date().toISOString();
        const runId = `${startedAt}:${input.sessionId}:${input.worktreePath}`;
        const worktreeId = input.featureId || input.taskName || input.worktreePath;
        const decision = this.dedupeGuard.begin({
            sessionId: input.sessionId,
            worktreePath: input.worktreePath,
        });

        if (decision.deduped) {
            return this.persistAndReturn(input, runId, worktreeId, {
                status: 'deduped',
                summary: decision.reason || 'deduped',
                startedAt,
                endedAt: new Date().toISOString(),
            }, decision.reason);
        }

        try {
            if (!input.autoCodeGraphEnabled) {
                return this.persistAndReturn(input, runId, worktreeId, {
                    status: 'warning',
                    summary: 'auto codegraph is disabled by policy',
                    startedAt,
                    endedAt: new Date().toISOString(),
                });
            }

            if (isCodeGraphInitialized(input.worktreePath)) {
                const snapshot = this.evidenceSnapshotWriter.writeSnapshot(input.worktreePath);
                const guide = this.agentsGuideUpdater.ensureUsageGuide(input.worktreePath);
                return this.persistAndReturn(input, runId, worktreeId, {
                    status: 'deduped',
                    summary: snapshot.persisted
                        ? `codegraph already initialized; skip rebuild; evidence snapshot refreshed; ${guide.summary}`
                        : `codegraph already initialized; skip rebuild; ${snapshot.summary}; ${guide.summary}`,
                    startedAt,
                    endedAt: new Date().toISOString(),
                }, 'already initialized', snapshot.persisted ? undefined : snapshot.summary);
            }

            const cli = this.installProbe.ensureCli({
                worktreePath: input.worktreePath,
                autoInstallEnabled: input.autoInstallEnabled,
            });

            if (!cli.ready) {
                return this.persistAndReturn(input, runId, worktreeId, {
                    status: 'warning',
                    summary: cli.summary,
                    startedAt,
                    endedAt: new Date().toISOString(),
                }, undefined, cli.summary);
            }

            const build = this.buildRunner.runInitBuild({
                worktreePath: input.worktreePath,
            });

            if (build.status === 'warning') {
                return this.persistAndReturn(input, runId, worktreeId, {
                    status: 'warning',
                    summary: build.summary,
                    startedAt,
                    endedAt: build.endedAt,
                }, undefined, build.summary);
            }

            const entry = input.entryPoint;
            const installSummary = cli.installedNow ? 'installed-now' : 'already-available';
            const snapshot = this.evidenceSnapshotWriter.writeSnapshot(input.worktreePath);
            const guide = this.agentsGuideUpdater.ensureUsageGuide(input.worktreePath);
            return this.persistAndReturn(input, runId, worktreeId, {
                status: 'success',
                summary: snapshot.persisted
                    ? `init completed (${entry}, ${installSummary}); evidence snapshot refreshed; ${guide.summary}`
                    : `init completed (${entry}, ${installSummary}); ${snapshot.summary}; ${guide.summary}`,
                startedAt,
                endedAt: build.endedAt,
            }, undefined, snapshot.persisted ? undefined : snapshot.summary);
        } finally {
            this.dedupeGuard.end({
                sessionId: input.sessionId,
                worktreePath: input.worktreePath,
            });
        }
    }

    /**
     * Persist a normalized run attempt record and return the original orchestration result.
     */
    private persistAndReturn(
        input: CodeGraphInitInput,
        runId: string,
        worktreeId: string,
        result: CodeGraphInitResult,
        dedupeReason?: string,
        errorDigest?: string,
    ): CodeGraphInitResult {
        this.runLedger.appendRunRecord({
            runId,
            worktreeId,
            worktreePath: input.worktreePath,
            entryPoint: input.entryPoint,
            status: result.status,
            startedAt: result.startedAt,
            endedAt: result.endedAt,
            summary: result.summary,
            errorDigest,
            dedupeReason,
        });
        return result;
    }

    /**
     * Expose guard state for tests and runtime diagnostics.
     */
    isActive(sessionId: string, worktreePath: string): boolean {
        return this.dedupeGuard.isActive({ sessionId, worktreePath });
    }
}
