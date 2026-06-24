import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    AUTO_POLL_LOCK_FILE,
    BASE,
    Config,
    CUSTOM_SCRIPT_DIR,
    DEFAULT_AUTO_POLL_PROMPT,
    DEFAULT_AUTO_POLL_SKIP_MARKERS,
    DEFAULT_POLL_SCRIPT,
    TODO_FILE,
} from '../models';
import { appendHarnessLog } from './harnessLog';

/**
 * Persisted in <masterRoot>/.harness/auto-poll-lock.json. Holds which worktree is
 * currently running the remote-task poller. Because every worktree window shares the
 * same master filesystem, this file is how separate VS Code windows enforce the
 * "only one worktree may poll at a time" rule.
 */
interface AutoPollLock {
    worktreePath: string;
    worktreeName: string;
    taskName: string;
    /** Extension-host pid of the owning window (used for liveness detection). */
    pid: number;
    startedAt: string;
    /** Refreshed on every poll tick; the primary "still running" signal. */
    heartbeatAt: string;
}

export interface AutoPollStatus {
    /** Polling is running in the current worktree window. */
    enabledHere: boolean;
    /** Another live worktree currently owns the poller; its name (for the "请移步" hint). */
    activeElsewhereName?: string;
    intervalSec: number;
    script: string;
    scriptExists: boolean;
}

interface AutoPollDeps {
    /** Master workspace root (the "主目录"), even from a worktree subview window. */
    getMasterRoot: () => string;
    /** In-memory config (worktree windows hold a read-only snapshot). */
    getConfig: () => Config;
    /** Absolute path of the worktree opened in this window. */
    getCurrentWorktreePath: () => string;
    /** Re-render the webview so the toggle reflects the new state. */
    onStatusChange: () => void;
    /** Invoke the task's AI executor on freshly-pulled todo content, prefixed with the configured prompt. */
    dispatchTodo: (todoContent: string, worktreePath: string, prompt: string) => Promise<void> | void;
}

export class AutoPollService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private activeWorktreePath = '';
    private running = false;

    constructor(private readonly deps: AutoPollDeps) {}

    // ── Public API ─────────────────────────────────────────────────

    getStatus(): AutoPollStatus {
        const { intervalSec, script } = this.resolveSettings();
        const scriptPath = path.join(this.deps.getMasterRoot(), CUSTOM_SCRIPT_DIR, script);
        const here = this.deps.getCurrentWorktreePath();
        const lock = this.readLock();
        const activeElsewhere = lock
            && !this.samePath(lock.worktreePath, here)
            && this.isLockAlive(lock, intervalSec)
            ? lock.worktreeName
            : undefined;
        return {
            enabledHere: this.timer !== null && this.samePath(this.activeWorktreePath, here),
            activeElsewhereName: activeElsewhere,
            intervalSec,
            script,
            scriptExists: fs.existsSync(scriptPath),
        };
    }

    /** Enable polling in this worktree. Returns false (and shows a warning) if another worktree owns it. */
    enable(taskName: string): boolean {
        const here = this.deps.getCurrentWorktreePath();
        if (!here) {
            vscode.window.showWarningMessage('未检测到当前 worktree 路径，无法开启自动轮询。');
            return false;
        }

        const { intervalSec, script } = this.resolveSettings();
        const scriptPath = path.join(this.deps.getMasterRoot(), CUSTOM_SCRIPT_DIR, script);
        if (!fs.existsSync(scriptPath)) {
            vscode.window.showWarningMessage(
                `拉取脚本不存在：${scriptPath}。请在主面板「自动轮询」设置中创建示例脚本，或在主目录的 ${CUSTOM_SCRIPT_DIR}/ 下放置 ${script}。`
            );
            return false;
        }

        // Exclusivity: reject if a *different*, still-alive worktree owns the lock.
        const lock = this.readLock();
        if (lock && !this.samePath(lock.worktreePath, here) && this.isLockAlive(lock, intervalSec)) {
            vscode.window.showWarningMessage(
                `「${lock.worktreeName}」worktree 已开启自动轮询远程任务，请移步该 worktree，或先在那里关闭后再开启。`
            );
            return false;
        }

        this.writeLock({
            worktreePath: here,
            worktreeName: path.basename(here),
            taskName,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
        });
        this.startTimer(here, intervalSec);
        vscode.window.showInformationMessage(
            `▶ 已在「${path.basename(here)}」开启自动轮询远程任务（每 ${intervalSec}s 拉取一次 → ${TODO_FILE}）。`
        );
        // First pull immediately so the user sees results without waiting a full interval.
        void this.tick();
        this.deps.onStatusChange();
        return true;
    }

    /** Disable polling in this worktree and release the shared lock if we own it. */
    disable(): void {
        this.stopTimer();
        this.releaseLockIfOwned();
        vscode.window.showInformationMessage('⏸ 已关闭自动轮询远程任务。');
        this.deps.onStatusChange();
    }

    /**
     * On a worktree window (re)start, resume polling if the lock points at this worktree
     * but its previous owner process is gone (i.e. we left it on, then reloaded the window).
     */
    resumeIfOwnedAfterReload(): void {
        const here = this.deps.getCurrentWorktreePath();
        if (!here || this.timer) {
            return;
        }
        const lock = this.readLock();
        if (!lock || !this.samePath(lock.worktreePath, here)) {
            return;
        }
        // Same worktree, but the recorded pid is this window's predecessor (now dead) — reclaim it.
        if (lock.pid === process.pid || this.isPidAlive(lock.pid)) {
            return;
        }
        const { intervalSec } = this.resolveSettings();
        this.writeLock({ ...lock, pid: process.pid, heartbeatAt: new Date().toISOString() });
        this.startTimer(here, intervalSec);
        void this.tick();
    }

    /** Stop the timer and release the lock; called on extension deactivate. */
    dispose(): void {
        this.stopTimer();
        this.releaseLockIfOwned();
    }

    // ── Timer / poll loop ──────────────────────────────────────────

    private startTimer(worktreePath: string, intervalSec: number): void {
        this.stopTimer();
        this.activeWorktreePath = worktreePath;
        const ms = Math.max(5, intervalSec) * 1000;
        this.timer = setInterval(() => { void this.tick(); }, ms);
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.activeWorktreePath = '';
    }

    private async tick(): Promise<void> {
        if (this.running) {
            return; // a previous pull is still in flight; skip this beat
        }
        this.running = true;
        try {
            const here = this.deps.getCurrentWorktreePath();
            // Defensive: another window may have taken over the lock — stand down quietly.
            const lock = this.readLock();
            if (!lock || !this.samePath(lock.worktreePath, here)) {
                this.stopTimer();
                this.deps.onStatusChange();
                return;
            }
            this.writeLock({ ...lock, pid: process.pid, heartbeatAt: new Date().toISOString() });

            const { script, prompt, skipMarkers } = this.resolveSettings();
            const scriptPath = path.join(this.deps.getMasterRoot(), CUSTOM_SCRIPT_DIR, script);
            if (!fs.existsSync(scriptPath)) {
                return;
            }

            const result = await this.runScript(scriptPath, here);
            if (result.code !== 0) {
                this.appendLog(here, `拉取失败（exit ${result.code}）：${(result.stderr || '').trim().slice(0, 500)}`);
                return;
            }

            const pulled = result.stdout;
            if (!pulled || pulled.trim().length === 0) {
                return; // empty pull → never overwrite todo.md
            }
            // "No pending task" sentinel (e.g. "没有未完成的待办任务") → treat like an empty pull:
            // don't overwrite todo.md and don't wake the AI executor.
            if (skipMarkers.includes(pulled.trim().toLowerCase())) {
                this.appendLog(here, '本次拉取无待办任务（命中跳过标记），未更新 todo.md，也未派发 AI');
                return;
            }
            const updated = this.writeTodoIfChanged(here, pulled);
            if (updated) {
                this.appendLog(here, '已拉取到新任务内容，已更新 todo.md');
                vscode.window.showInformationMessage(`📥 已拉取新的远程任务内容，已更新 ${TODO_FILE}`);
                this.deps.onStatusChange();

                // todo.md changed → wake the AI executor to run the pulled tasks.
                // Auto-poll now always means "拉取并执行"; there is no separate dispatch toggle.
                try {
                    await this.deps.dispatchTodo(pulled, here, prompt);
                    this.appendLog(here, '已唤起 AI 执行器处理新任务');
                } catch (err) {
                    this.appendLog(here, `唤起 AI 执行器失败：${err instanceof Error ? err.message : String(err)}`);
                }
            }
        } finally {
            this.running = false;
        }
    }

    /** Write todo.md only when the pulled content is non-empty AND differs from the current file. */
    private writeTodoIfChanged(worktreePath: string, pulled: string): boolean {
        const todoPath = path.join(worktreePath, TODO_FILE);
        const next = `${pulled.replace(/\s+$/, '')}\n`;
        if (fs.existsSync(todoPath)) {
            try {
                const current = fs.readFileSync(todoPath, 'utf8');
                if (current.trim() === pulled.trim()) {
                    return false; // unchanged → keep the existing todo.md
                }
            } catch {
                // unreadable existing file → fall through and overwrite
            }
        }
        fs.writeFileSync(todoPath, next, 'utf8');
        return true;
    }

    private runScript(scriptPath: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
        const { command, args } = this.resolveRunner(scriptPath);
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            const finish = (code: number) => {
                if (settled) return;
                settled = true;
                resolve({ code, stdout, stderr });
            };
            try {
                // When `command` is VS Code's embedded binary (process.execPath), it is an
                // Electron executable — ELECTRON_RUN_AS_NODE makes it behave as a plain Node
                // runtime instead of launching a second editor window.
                const env = command === process.execPath
                    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
                    : process.env;
                const child = spawn(command, args, { cwd, windowsHide: true, env });
                const killer = setTimeout(() => {
                    stderr += '\n[fun-harness] 脚本执行超时（120s），已终止。';
                    child.kill();
                    finish(124);
                }, 120_000);
                child.stdout.on('data', (d) => { stdout += d.toString(); });
                child.stderr.on('data', (d) => { stderr += d.toString(); });
                child.on('error', (err) => {
                    clearTimeout(killer);
                    stderr += `\n[fun-harness] 启动脚本失败：${err instanceof Error ? err.message : String(err)}`;
                    finish(127);
                });
                child.on('close', (code) => {
                    clearTimeout(killer);
                    finish(code ?? 0);
                });
            } catch (err) {
                stderr += `\n[fun-harness] 启动脚本异常：${err instanceof Error ? err.message : String(err)}`;
                finish(127);
            }
        });
    }

    /** Map a script file to its runtime invocation (Node for .js, bash/pwsh for shell scripts). */
    private resolveRunner(scriptPath: string): { command: string; args: string[] } {
        const lower = scriptPath.toLowerCase();
        const isWin = process.platform === 'win32';
        if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) {
            return { command: process.execPath, args: [scriptPath] };
        }
        if (lower.endsWith('.ps1')) {
            return isWin
                ? { command: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] }
                : { command: 'pwsh', args: ['-File', scriptPath] };
        }
        if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
            return { command: 'bash', args: [scriptPath] };
        }
        if (lower.endsWith('.py')) {
            return { command: isWin ? 'python' : 'python3', args: [scriptPath] };
        }
        // Unknown extension: execute the file directly and let the OS resolve the shebang.
        return { command: scriptPath, args: [] };
    }

    // ── Lock helpers ───────────────────────────────────────────────

    private resolveSettings(): { intervalSec: number; script: string; prompt: string; skipMarkers: string[] } {
        // Prefer the master config on disk so worktree windows pick up the latest values
        // (their in-memory snapshot is captured at worktree-creation time).
        const cfg = this.readMasterConfig() ?? this.deps.getConfig();
        const intervalSec = Math.max(5, Number(cfg.autoPollIntervalSec) || 60);
        const script = (cfg.autoPollScript || '').trim() || DEFAULT_POLL_SCRIPT;
        const prompt = (cfg.autoPollPrompt || '').trim() || DEFAULT_AUTO_POLL_PROMPT;
        // `?? DEFAULT` only fills in for configs predating this field; an explicit '' means "no markers".
        const skipMarkers = (cfg.autoPollSkipMarkers ?? DEFAULT_AUTO_POLL_SKIP_MARKERS)
            .split(/\r?\n/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        return { intervalSec, script, prompt, skipMarkers };
    }

    private readMasterConfig(): Config | null {
        try {
            const file = path.join(this.deps.getMasterRoot(), BASE, 'config.json');
            if (!fs.existsSync(file)) {
                return null;
            }
            return JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
        } catch {
            return null;
        }
    }

    private lockPath(): string {
        return path.join(this.deps.getMasterRoot(), BASE, AUTO_POLL_LOCK_FILE);
    }

    private readLock(): AutoPollLock | null {
        try {
            const file = this.lockPath();
            if (!fs.existsSync(file)) {
                return null;
            }
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AutoPollLock>;
            if (!raw.worktreePath) {
                return null;
            }
            return {
                worktreePath: raw.worktreePath,
                worktreeName: raw.worktreeName || path.basename(raw.worktreePath),
                taskName: raw.taskName || '',
                pid: Number(raw.pid) || 0,
                startedAt: raw.startedAt || '',
                heartbeatAt: raw.heartbeatAt || '',
            };
        } catch {
            return null;
        }
    }

    private writeLock(lock: AutoPollLock): void {
        try {
            const file = this.lockPath();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(lock, null, 2), 'utf8');
        } catch {
            // best-effort; a failed heartbeat write just makes the lock look stale sooner
        }
    }

    private releaseLockIfOwned(): void {
        const here = this.deps.getCurrentWorktreePath();
        const lock = this.readLock();
        if (lock && this.samePath(lock.worktreePath, here)) {
            try {
                fs.rmSync(this.lockPath(), { force: true });
            } catch {
                // best-effort
            }
        }
    }

    /** A lock counts as "alive" only while its owner process exists AND its heartbeat is fresh. */
    private isLockAlive(lock: AutoPollLock, intervalSec: number): boolean {
        const staleMs = Math.max(intervalSec * 1000 * 3, 90_000);
        const beat = Date.parse(lock.heartbeatAt || lock.startedAt || '');
        const heartbeatFresh = Number.isFinite(beat) && (Date.now() - beat) < staleMs;
        return heartbeatFresh && this.isPidAlive(lock.pid);
    }

    private isPidAlive(pid: number): boolean {
        if (!pid || pid <= 0) {
            return false;
        }
        try {
            process.kill(pid, 0);
            return true;
        } catch (err) {
            // EPERM means the process exists but we can't signal it → still alive.
            return (err as NodeJS.ErrnoException).code === 'EPERM';
        }
    }

    private appendLog(worktreePath: string, message: string): void {
        // Unified per-task log: shares <iterDir>/.harness/harness.log with git and other subsystems.
        appendHarnessLog(worktreePath, 'auto-poll', message);
    }

    private samePath(a: string, b: string): boolean {
        if (!a || !b) {
            return false;
        }
        const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
        return norm(a) === norm(b);
    }
}
