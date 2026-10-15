import * as fs from 'fs';
import * as path from 'path';

export interface CodeGraphRunRecord {
    runId: string;
    worktreeId: string;
    worktreePath: string;
    entryPoint: 'openFolderLocationByFeatureId' | 'runCustomButtonByFeatureId' | 'syncCodeGraphByFeatureId';
    status: 'success' | 'warning' | 'deduped';
    startedAt: string;
    endedAt: string;
    summary: string;
    errorDigest?: string;
    dedupeReason?: string;
}

export interface CodeGraphRunLedgerResult {
    persisted: boolean;
    logPath: string;
}

/**
 * Persists CodeGraph init run records into .harness/process as JSONL for traceability.
 */
export class CodeGraphRunLedger {
    /**
     * Append one run record to the process ledger file.
     */
    appendRunRecord(record: CodeGraphRunRecord): CodeGraphRunLedgerResult {
        const logPath = path.join(record.worktreePath, '.harness', 'process', 'codegraph-runs.jsonl');
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            const line = `${JSON.stringify(record)}\n`;
            fs.appendFileSync(logPath, line, 'utf8');
            return { persisted: true, logPath };
        } catch {
            return { persisted: false, logPath };
        }
    }
}