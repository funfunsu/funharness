import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { SubFeature } from '../models';
import { LocalVerificationError } from './localProcessTaskService';

export interface LocalRepairState {
    taskId: string;
    requestId: string;
    attempt: number;
    status: 'waiting' | 'verifying' | 'verified' | 'blocked';
    fingerprints: string[];
    signature: string;
    check: string;
    failureDetails: string;
    allowedFiles: string[];
    signalFile: string;
    resumeAuto: boolean;
    createdAt: number;
    reason?: string;
    wasVerified?: boolean;
}

export class LocalRepairService {
    static readonly maxAttempts = 2;
    static readonly timeoutMs = 10 * 60 * 1000;

    constructor(private readonly iterDir: string) {}

    signature(task: SubFeature): string {
        return this.hash(JSON.stringify({ id: task.id, execution: task.execution, action: task.localAction,
            autoRepair: task.autoRepair,
            checks: task.checks, depends: task.depends, output: task.output, acceptance: task.acceptance,
            requirements: task.requirementIds, properties: task.propertyIds }));
    }

    private hash(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }

    private runtimePath(relative: string): string {
        const root = path.resolve(this.iterDir);
        const target = path.resolve(root, relative);
        const rel = path.relative(root, target);
        if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('Repair path escapes iteration');
        let cursor = target;
        while (cursor !== root) {
            if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Repair path traverses symbolic link');
            cursor = path.dirname(cursor);
        }
        return target;
    }

    private statePath(taskId: string): string {
        if (!/^\d+\.\d+$/.test(taskId)) throw new Error('Invalid repair task ID');
        return this.runtimePath(`.harness/process/local-repair-${taskId}.json`);
    }

    read(taskId: string): LocalRepairState | null {
        try {
            const file = this.statePath(taskId);
            if (!fs.existsSync(file)) return null;
            const state = JSON.parse(fs.readFileSync(file, 'utf8')) as LocalRepairState;
            if (state.taskId !== taskId || !/^[a-f0-9-]{36}$/.test(state.requestId) ||
                !['waiting', 'verifying', 'verified', 'blocked'].includes(state.status) ||
                !Number.isInteger(state.attempt) || state.attempt < 1 ||
                !Number.isFinite(state.createdAt) || state.createdAt <= 0 || typeof state.resumeAuto !== 'boolean' ||
                typeof state.signature !== 'string' || !/^[a-f0-9]{64}$/.test(state.signature) ||
                typeof state.failureDetails !== 'string' || !['compile', 'webview', 'tests'].includes(state.check) ||
                !Array.isArray(state.fingerprints) || !state.fingerprints.every(value => typeof value === 'string') ||
                !Array.isArray(state.allowedFiles) || !state.allowedFiles.every(value => typeof value === 'string') ||
                state.signalFile !== `signals/repair-${taskId}-${state.requestId}`) throw new Error('Invalid persisted repair state');
            return state;
        } catch {
            return { taskId, requestId: randomUUID(), attempt: LocalRepairService.maxAttempts, status: 'blocked',
                fingerprints: [], signature: this.hash('corrupt'), check: 'compile', failureDetails: '', allowedFiles: [],
                signalFile: '', resumeAuto: false, createdAt: Date.now(), reason: 'Corrupt persisted repair state' };
        }
    }

    save(state: LocalRepairState): void {
        const file = this.statePath(state.taskId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = this.runtimePath(`.harness/process/local-repair-${state.taskId}.json.tmp`);
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(temporary, file);
    }

    block(state: LocalRepairState, reason: string): void {
        state.status = 'blocked';
        state.reason = reason;
        this.save(state);
    }

    prepare(task: SubFeature, tasks: SubFeature[], failure: LocalVerificationError, resumeAuto: boolean): LocalRepairState {
        const previous = this.read(task.id);
        if (previous?.reason === 'Corrupt persisted repair state') throw new Error(previous.reason);
        if (previous?.status === 'waiting') throw new Error('Repair already in flight');
        const signature = this.signature(task);
        const continuing = previous && previous.status !== 'verified' && !previous.wasVerified && previous.signature === signature;
        const diagnostics = failure.result.output.split('\n').filter(line => /error TS\d+|SyntaxError|AssertionError|ERR_ASSERTION|not ok \d+/i.test(line));
        const fingerprint = this.hash(`${failure.check}:${diagnostics.join('\n').replace(/\u001b\[[0-9;]*m/g, '').replace(/\(node:\d+\)/g, '(node)').trim()}`);
        const allowedFiles = this.collectScope(task, tasks);
        const state: LocalRepairState = {
            taskId: task.id, requestId: randomUUID(), attempt: continuing ? previous.attempt + 1 : 1,
            status: 'waiting', fingerprints: continuing ? [...previous.fingerprints] : [], signature,
            check: failure.check, failureDetails: failure.message.slice(-16000), allowedFiles,
            signalFile: '', resumeAuto, createdAt: Date.now(),
        };
        state.signalFile = `signals/repair-${task.id}-${state.requestId}`;
        const reason = !failure.repairable ? 'Failure is not a repairable code diagnostic'
            : allowedFiles.length === 0 ? 'No implementation file scope declared by dependencies'
            : state.fingerprints.includes(fingerprint) ? 'Same diagnostic repeated after repair'
            : state.attempt > LocalRepairService.maxAttempts ? 'Automatic repair budget exhausted' : '';
        state.fingerprints.push(fingerprint);
        if (reason) {
            this.block(state, reason);
            throw new Error(reason);
        }
        this.save(state);
        return state;
    }

    acknowledge(state: LocalRepairState): boolean {
        const file = this.runtimePath(state.signalFile);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
        try {
            const signal = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (signal.requestId !== state.requestId || signal.taskId !== state.taskId || signal.status !== 'repaired') return false;
        } catch {
            return false;
        }
        state.status = 'verifying';
        this.save(state);
        return true;
    }

    private collectScope(task: SubFeature, tasks: SubFeature[]): string[] {
        const scope = new Set<string>();
        const visited = new Set<string>();
        const queue = [...task.depends];
        while (queue.length > 0) {
            const id = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const dependency = tasks.find(item => item.id === id);
            if (!dependency) continue;
            queue.push(...dependency.depends);
            if (dependency.execution === 'local') continue;
            for (const raw of [...dependency.output, ...dependency.newFiles, ...dependency.modifiedFiles]) {
                const file = raw.trim().replace(/^[\[`"']+|[\]`"']+$/g, '').replace(/\\/g, '/');
                if (!file || file.endsWith('/') || /[:\0]/.test(file) || path.isAbsolute(file) || file.split('/').includes('..') ||
                    /(^|\/)(\.harness|\.git|\.github|signals|specs|docs|node_modules|out|dist)(\/|$)/i.test(file) ||
                    /(^|\/)(package(-lock)?\.json|[^/]*lock[^/]*|validate-[^/]*)$/i.test(file)) continue;
                const absolute = this.runtimePath(file);
                if (fs.existsSync(absolute) && !fs.statSync(absolute).isFile()) continue;
                scope.add(file);
            }
        }
        return [...scope].sort();
    }
}