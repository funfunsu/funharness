export interface CodeGraphDedupeWindowKey {
    sessionId: string;
    worktreePath: string;
}

export interface CodeGraphDedupeDecision {
    deduped: boolean;
    key: string;
    reason?: string;
}

/**
 * In-memory dedupe guard that limits a session/worktree pair to one active init run.
 */
export class CodeGraphDedupeGuard {
    private readonly activeKeys: Set<string> = new Set();

    /**
     * Start a new guarded run and return whether this trigger should be deduped.
     */
    begin(key: CodeGraphDedupeWindowKey): CodeGraphDedupeDecision {
        const normalizedKey = this.toKey(key);
        if (this.activeKeys.has(normalizedKey)) {
            return {
                deduped: true,
                key: normalizedKey,
                reason: 'same session/worktree run is already active',
            };
        }

        this.activeKeys.add(normalizedKey);
        return {
            deduped: false,
            key: normalizedKey,
        };
    }

    /**
     * Release a guarded run so later triggers can execute again.
     */
    end(key: CodeGraphDedupeWindowKey): void {
        this.activeKeys.delete(this.toKey(key));
    }

    /**
     * Check if a session/worktree pair is currently running.
     */
    isActive(key: CodeGraphDedupeWindowKey): boolean {
        return this.activeKeys.has(this.toKey(key));
    }

    /**
     * Build a stable in-memory key using normalized path separators and casing.
     */
    private toKey(key: CodeGraphDedupeWindowKey): string {
        const normalizedSessionId = (key.sessionId || '').trim().toLowerCase();
        const normalizedWorktreePath = (key.worktreePath || '')
            .trim()
            .replace(/[\\/]+/g, '/')
            .toLowerCase();
        return `${normalizedSessionId}::${normalizedWorktreePath}`;
    }
}
