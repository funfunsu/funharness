import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface AiCallRecord {
    id: string;
    timestamp: string;
    source: string;
    provider: string;
    scope: string | null;
    taskId: string | null;
    stage: string | null;
    attempt: number;
    promptFile: string | null;
    inputChars: number;
    inputBytes: number;
    sections: Array<{ name: string; chars: number; bytes: number }>;
    status: 'dispatched' | 'prepared' | 'completed' | 'failed';
    durationMs: number;
    usage: null;
    usageStatus: 'unavailable' | 'not-applicable';
    outputChars?: number;
    error?: string;
}

export class AiUsageService {
    private recordsPath(iterDir: string): string {
        return path.join(iterDir, '.harness', 'process', 'ai-calls.jsonl');
    }

    readCalls(iterDir: string): AiCallRecord[] {
        const records: AiCallRecord[] = [];
        try {
            for (const line of fs.readFileSync(this.recordsPath(iterDir), 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    const record = JSON.parse(line);
                    if (typeof record.id === 'string' && typeof record.source === 'string' &&
                        typeof record.provider === 'string' && Number.isFinite(record.inputBytes) &&
                        Number.isFinite(record.inputChars) && Array.isArray(record.sections) &&
                        record.sections.every((section: { name?: unknown; chars?: unknown; bytes?: unknown }) =>
                            section && typeof section.name === 'string' && Number.isFinite(section.chars) && Number.isFinite(section.bytes))) {
                        records.push(record);
                    }
                } catch {
                    continue;
                }
            }
        } catch {
            return records;
        }
        return records;
    }

    begin(query: string, iterDir: string, source: string, provider: string,
        scope: string | null, promptFile: string | null, context?: { stage?: string; taskId?: string }): AiCallRecord {
        const taskId = context?.taskId || (source === 'dev-subtask' ? query.match(/^- 任务ID[：:]\s*(\S+)/m)?.[1] || null : null);
        const stage = context?.stage || (source === 'dev-subtask' ? 'dev' : null);
        const previous = this.readCalls(iterDir).filter(call => call.source === source &&
            call.provider === provider && call.scope === scope && call.taskId === taskId && call.stage === stage);
        const sections: AiCallRecord['sections'] = [];
        let name = 'preamble';
        let body = '';
        const flush = () => {
            if (body) sections.push({ name, chars: body.length, bytes: Buffer.byteLength(body, 'utf8') });
            body = '';
        };
        for (const line of query.match(/[^\n]*\n|[^\n]+$/g) || []) {
            const heading = line.match(/^#{1,2}\s+(.+?)\r?\n?$/);
            if (heading) {
                flush();
                name = heading[1];
            }
            body += line;
        }
        flush();
        return {
            id: randomUUID(), timestamp: new Date().toISOString(), source, provider, scope, taskId, stage,
            attempt: previous.length + 1, promptFile,
            inputChars: query.length, inputBytes: Buffer.byteLength(query, 'utf8'), sections,
            status: 'failed', durationMs: 0, usage: null, usageStatus: source === 'local-process' ? 'not-applicable' : 'unavailable',
        };
    }

    finish(iterDir: string, record: AiCallRecord, status: AiCallRecord['status'], startedAt: number): void {
        try {
            record.status = status;
            record.durationMs = Date.now() - startedAt;
            const file = this.recordsPath(iterDir);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
            fs.writeFileSync(path.join(path.dirname(file), 'ai-usage-summary.json'),
                JSON.stringify(this.summarize(iterDir), null, 2), 'utf8');
        } catch {
            return;
        }
    }

    summarize(iterDir: string) {
        const calls = this.readCalls(iterDir);
        const aiCalls = calls.filter(call => call.source !== 'local-process');
        const localCalls = calls.filter(call => call.source === 'local-process');
        const groups: Record<string, { source: string; provider: string; taskId: string | null; stage: string | null;
            calls: number; failed: number; prepared: number; inputChars: number; inputBytes: number }> = {};
        const sections: Record<string, { chars: number; bytes: number }> = Object.create(null);
        for (const call of calls) {
            const key = JSON.stringify([call.source, call.provider, call.stage, call.taskId]);
            const group = groups[key] ||= { source: call.source, provider: call.provider, taskId: call.taskId, stage: call.stage,
                calls: 0, failed: 0, prepared: 0, inputChars: 0, inputBytes: 0 };
            group.calls += 1;
            group.failed += Number(call.status === 'failed');
            group.prepared += Number(call.status === 'prepared');
            group.inputChars += call.inputChars;
            group.inputBytes += call.inputBytes;
            for (const section of call.sections || []) {
                const total = sections[section.name] ||= { chars: 0, bytes: 0 };
                total.chars += section.chars;
                total.bytes += section.bytes;
            }
        }
        return { schemaVersion: 1, updatedAt: new Date().toISOString(), aiCalls: aiCalls.length,
            dispatchCalls: aiCalls.filter(call => call.source !== 'inline-refine').length,
            localCalls: localCalls.length, localCompleted: localCalls.filter(call => call.status === 'completed').length,
            inputChars: aiCalls.reduce((sum, call) => sum + call.inputChars, 0),
            inputBytes: aiCalls.reduce((sum, call) => sum + call.inputBytes, 0),
            usageStatus: 'unavailable', actualTokens: null, cost: null, groups: Object.values(groups), sections };
    }
}