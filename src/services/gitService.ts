import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { Config, Task } from '../models';
import { appendHarnessLog } from './harnessLog';
import { clearDirChildrenPreserving, safeRemovePath } from './fileOps';

export class GitService {
    private config: Config;
    private workspaceRoot: string;
    private lastExecError: string = '';
    /** Iteration dir of the in-flight task op; git command logs go to its per-task harness.log. */
    private currentLogDir: string = '';

    constructor(config: Config, workspaceRoot: string = '') {
        this.config = config;
        this.workspaceRoot = workspaceRoot;
    }

    setConfig(config: Config): void {
        this.config = config;
    }

    setWorkspaceRoot(workspaceRoot: string): void {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Single source of truth for an iteration's baseline branch: the base recorded when the
     * iteration was created (task.baseBranchUsed), else the configured baseline, else 'main'.
     * All branch / merge / sync paths must resolve through here so there is exactly one notion
     * of "基线分支".
     */
    private resolveBaseBranch(task?: Task): string {
        return (task?.baseBranchUsed || this.config.baseBranch || 'main').trim();
    }

    /**
     * Log a git line to the unified per-task log: the current operation's iteration dir when set
     * (so logs are split per task), otherwise the master root for task-less ops like repo init.
     */
    private logGit(line: string): void {
        appendHarnessLog(this.currentLogDir || this.workspaceRoot, 'git', line);
    }

    async initializeRepos(): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = ''; // no single task → log repo init to the master root
        this.lastExecError = '';
        if (!this.config.frontendGit && !this.config.backendGit) {
            return { success: false, message: '请至少填写一个 Git 地址（前端或后端）' };
        }

        const baseBranch = (this.config.baseBranch || 'main').trim();
        const requireExact = Boolean(this.config.baseBranch?.trim());

        if (this.config.frontendGit) {
            const frontendMainDir = this.getMainRepoDir('frontend');
            const result = await this.ensureMainRepo(this.config.frontendGit, frontendMainDir, baseBranch, requireExact);
            if (!result.success) {
                return { success: false, message: this.withExecError('前端仓库初始化失败') };
            }
        }

        if (this.config.backendGit) {
            const backendMainDir = this.getMainRepoDir('backend');
            const result = await this.ensureMainRepo(this.config.backendGit, backendMainDir, baseBranch, requireExact);
            if (!result.success) {
                return { success: false, message: this.withExecError('后端仓库初始化失败') };
            }
        }

        return { success: true, message: '✅ Git 配置已保存，代码初始化完成' };
    }

    async createIterationBranches(task: Task, iterationDir: string): Promise<{ success: boolean; message?: string; baseBranch?: string; iterationBranch?: string }> {
        this.currentLogDir = iterationDir;
        this.lastExecError = '';
        const branchName = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        const baseBranch = (this.config.baseBranch || 'main').trim();
        const requireExactBaseBranch = Boolean(this.config.baseBranch?.trim());
        let resolvedBaseBranch = baseBranch;
        if (!branchName || branchName.length < 2) {
            return { success: false, message: '迭代名称必须使用英文' };
        }

        if (!this.config.frontendGit && !this.config.backendGit) {
            return { success: false, message: '请先在高级设置配置至少一个 Git 地址' };
        }

        const expectedWorktrees: string[] = [];

        if (this.config.frontendGit) {
            const frontendMainDir = this.getMainRepoDir('frontend');
            const frontendDir = path.join(iterationDir, 'frontend');
            const frontendInit = await this.ensureMainRepo(this.config.frontendGit, frontendMainDir, baseBranch, requireExactBaseBranch);
            if (!frontendInit.success) {
                return {
                    success: false,
                    message: this.withExecError(requireExactBaseBranch
                        ? `前端仓库初始化失败：无法按指定基线分支 ${baseBranch} 准备代码`
                        : '前端仓库初始化失败（clone/fetch/checkout）'),
                };
            }
            const frontendBaseBranch = frontendInit.baseBranch || baseBranch;
            resolvedBaseBranch = frontendBaseBranch;
            if (!await this.prepareWorktree(frontendMainDir, frontendDir, branchName, frontendBaseBranch)) {
                return { success: false, message: this.withExecError('前端 worktree 创建失败') };
            }
            expectedWorktrees.push(frontendDir);
        }

        if (this.config.backendGit) {
            const backendMainDir = this.getMainRepoDir('backend');
            const backendDir = path.join(iterationDir, 'backend');
            const backendInit = await this.ensureMainRepo(this.config.backendGit, backendMainDir, baseBranch, requireExactBaseBranch);
            if (!backendInit.success) {
                return {
                    success: false,
                    message: this.withExecError(requireExactBaseBranch
                        ? `后端仓库初始化失败：无法按指定基线分支 ${baseBranch} 准备代码`
                        : '后端仓库初始化失败（clone/fetch/checkout）'),
                };
            }
            const backendBaseBranch = backendInit.baseBranch || baseBranch;
            if (!resolvedBaseBranch) {
                resolvedBaseBranch = backendBaseBranch;
            }
            if (!await this.prepareWorktree(backendMainDir, backendDir, branchName, backendBaseBranch)) {
                return { success: false, message: this.withExecError('后端 worktree 创建失败') };
            }
            expectedWorktrees.push(backendDir);
        }

        const missing = expectedWorktrees.filter(dir => !this.hasGitWorktree(dir));
        if (missing.length > 0) {
            return {
                success: false,
                message: `迭代代码目录未成功重建：${missing.join(', ')}`,
            };
        }

        return {
            success: true,
            message: `✅ 迭代初始化完成，基线分支：${resolvedBaseBranch}，迭代分支：${branchName}`,
            baseBranch: resolvedBaseBranch,
            iterationBranch: branchName,
        };
    }

    /**
     * Best-effort cleanup used by task reset: detach iteration frontend/backend worktrees
     * from their main repos first, then remove their directories from disk.
     */
    async detachIterationWorktrees(iterationDir: string): Promise<{ success: boolean; errors: string[] }> {
        this.currentLogDir = iterationDir;
        const errors: string[] = [];
        const repos: Array<{ kind: 'frontend' | 'backend'; mainDir: string; worktreeDir: string }> = [];

        if (this.config.frontendGit) {
            repos.push({
                kind: 'frontend',
                mainDir: this.getMainRepoDir('frontend'),
                worktreeDir: path.join(iterationDir, 'frontend'),
            });
        }
        if (this.config.backendGit) {
            repos.push({
                kind: 'backend',
                mainDir: this.getMainRepoDir('backend'),
                worktreeDir: path.join(iterationDir, 'backend'),
            });
        }

        for (const repo of repos) {
            const escapedWorktree = repo.worktreeDir.replace(/"/g, '\\"');
            try {
                if (fs.existsSync(repo.mainDir)) {
                    const registered = await this.hasRegisteredWorktreeAtPath(repo.mainDir, repo.worktreeDir);
                    if (registered) {
                        const removed = await this.execCmd(`git worktree remove --force "${escapedWorktree}"`, repo.mainDir);
                        if (!removed && !/not a working tree/i.test(this.lastExecError || '')) {
                            errors.push(`[${repo.kind}] git worktree remove 失败：${this.lastExecError}`);
                        }
                    }
                    await this.execCmd('git worktree prune', repo.mainDir);
                }

                this.safeRemovePath(repo.worktreeDir, { recursive: true });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`[${repo.kind}] 删除目录失败：${message}`);
            }
        }

        return { success: errors.length === 0, errors };
    }

    /**
     * Unified safe deletion for files/directories with retry semantics for Windows file locks.
     */
    safeRemovePath(targetPath: string, options?: { recursive?: boolean }): void {
        safeRemovePath(targetPath, options);
    }

    /**
     * Remove all direct children under a directory while preserving specific entry names.
     */
    clearDirChildrenPreserving(dirPath: string, preserveNames: string[] = []): void {
        clearDirChildrenPreserving(dirPath, preserveNames);
    }

    private getMainRepoDir(kind: 'frontend' | 'backend'): string {
        return path.join(this.workspaceRoot, 'repos', `${kind}-main`);
    }

    private buildCommitMessage(task: Task): string {
        const raw = (task.desc || task.name || 'update').trim();
        const normalized = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        const truncated = normalized.length > 120 ? normalized.slice(0, 120).trim() : normalized;
        return truncated.replace(/"/g, '\\"') || 'update';
    }

    private async ensureMainRepo(remote: string, repoDir: string, baseBranch: string, requireExactBaseBranch: boolean): Promise<{ success: boolean; baseBranch?: string }> {
        if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
            fs.mkdirSync(path.dirname(repoDir), { recursive: true });
            const cloned = await this.execCmd(`git clone ${remote} "${repoDir}"`, this.workspaceRoot || path.dirname(repoDir));
            if (!cloned) {
                return { success: false };
            }
        }
        return this.checkoutAndPullBase(repoDir, baseBranch, requireExactBaseBranch);
    }

    private async prepareWorktree(mainRepoDir: string, worktreeDir: string, branchName: string, baseBranch: string): Promise<boolean> {
        if (fs.existsSync(worktreeDir)) {
            const removed = await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
            if (!removed) {
                // When git does not recognize this path as a worktree, treat it as stale folder and continue.
                if (!/not a working tree/i.test(this.lastExecError || '')) {
                    return false;
                }
            }
            this.safeRemovePath(worktreeDir, { recursive: true });
        }

        // Clean stale worktree records before creating a new one.
        await this.execCmd('git worktree prune', mainRepoDir);

        if (await this.hasRegisteredWorktreeAtPath(mainRepoDir, worktreeDir)) {
            // Same path already registered by git worktree metadata, reuse it when valid.
            return this.hasGitWorktree(worktreeDir);
        }

        fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
        const added = await this.execCmd(`git worktree add "${worktreeDir}" -B ${branchName} ${baseBranch}`, mainRepoDir);
        if (!added) {
            const conflictPath = this.extractAlreadyCheckedOutPath(this.lastExecError);
            if (conflictPath && this.isSamePath(conflictPath, worktreeDir)) {
                if (this.hasGitWorktree(worktreeDir)) {
                    // Already attached at the same location; treat as successful reuse.
                    return true;
                }
                // Clear stale registration and retry once.
                await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
                await this.execCmd('git worktree prune', mainRepoDir);
                const retried = await this.execCmd(`git worktree add "${worktreeDir}" -B ${branchName} ${baseBranch}`, mainRepoDir);
                if (!retried) {
                    return false;
                }
                return this.hasGitWorktree(worktreeDir);
            }
            return false;
        }
        return this.hasGitWorktree(worktreeDir);
    }

    async pushAll(task: Task, iterationDir: string): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = iterationDir;
        const failures: Array<{ repo: string; reason: string }> = [];
        const commitMessage = this.buildCommitMessage(task);
        const expectedBranch = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');

        if (this.config.frontendGit) {
            const frontendDir = path.join(iterationDir, 'frontend');
            const branchErr = await this.assertExpectedBranch(frontendDir, expectedBranch);
            if (branchErr) {
                failures.push({ repo: 'frontend', reason: branchErr });
            } else {
                const frontendError = await this.pushRepoChanges('frontend', frontendDir, commitMessage);
                if (frontendError) {
                    failures.push({ repo: 'frontend', reason: frontendError });
                }
            }
        }

        if (this.config.backendGit) {
            const backendDir = path.join(iterationDir, 'backend');
            const branchErr = await this.assertExpectedBranch(backendDir, expectedBranch);
            if (branchErr) {
                failures.push({ repo: 'backend', reason: branchErr });
            } else {
                const backendError = await this.pushRepoChanges('backend', backendDir, commitMessage);
                if (backendError) {
                    failures.push({ repo: 'backend', reason: backendError });
                }
            }
        }

        if (failures.length > 0) {
            const detail = failures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return { success: false, message: `推送失败：\n${detail}` };
        }
        return { success: true, message: '✅ 代码已全部推送' };
    }

    private async pushRepoChanges(repoName: string, repoDir: string, commitMessage: string): Promise<string | null> {
        if (!fs.existsSync(repoDir)) {
            return `目录不存在: ${repoDir}`;
        }

        // Use -A to stage tracked changes plus newly created files.
        const addCmd = await this.execCmd(`git add . -- :(exclude).harness`, repoDir);
        if (!addCmd) {
            return `git add 失败: ${this.lastExecError}`;
        }

        const status = await this.execCmdOutput('git status --porcelain --untracked-files=all', repoDir);
        if (!status.success) {
            return `git status 检查失败: ${this.lastExecError}`;
        }
        const remainingUntracked = status.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('?? '));
        if (remainingUntracked.length > 0) {
            return `仍有未跟踪文件未纳入提交: ${remainingUntracked.join(', ')}`;
        }

        const commitCmd = await this.execCmd(`git commit -m "${commitMessage}" --allow-empty`, repoDir);
        if (!commitCmd) {
            return `git commit 失败: ${this.lastExecError}`;
        }

        const pushCmd = await this.execCmd('git push origin HEAD', repoDir);
        if (!pushCmd) {
            return `git push 失败: ${this.lastExecError}`;
        }

        return null;
    }

    async syncMainCode(task: Task, iterationDir: string): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = iterationDir;
        const baseBranch = this.resolveBaseBranch(task);
        const expectedBranch = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        const failures: Array<{ repo: string; reason: string }> = [];

        if (this.config.frontendGit) {
            const mainDir = this.getMainRepoDir('frontend');
            const worktreeDir = path.join(iterationDir, 'frontend');
            const result = await this.syncRepoToWorktree(mainDir, worktreeDir, baseBranch, expectedBranch);
            if (!result.ok) { failures.push({ repo: 'frontend', reason: result.reason || '未知' }); }
        }

        if (this.config.backendGit) {
            const mainDir = this.getMainRepoDir('backend');
            const worktreeDir = path.join(iterationDir, 'backend');
            const result = await this.syncRepoToWorktree(mainDir, worktreeDir, baseBranch, expectedBranch);
            if (!result.ok) { failures.push({ repo: 'backend', reason: result.reason || '未知' }); }
        }

        if (failures.length > 0) {
            const detail = failures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return { success: false, message: `同步失败：\n${detail}` };
        }
        return { success: true, message: `✅ 已同步主仓库最新代码（${baseBranch}）到当前 worktree` };
    }

    private async syncRepoToWorktree(mainRepoDir: string, worktreeDir: string, baseBranch: string, expectedBranch?: string): Promise<{ ok: boolean; reason?: string }> {
        if (!fs.existsSync(mainRepoDir)) {
            return { ok: false, reason: `主仓库目录不存在：${mainRepoDir}` };
        }
        if (!fs.existsSync(worktreeDir)) {
            return { ok: false, reason: `worktree 目录不存在：${worktreeDir}` };
        }

        // Guard: verify the worktree is on the expected iteration branch before merging.
        if (expectedBranch) {
            const branchErr = await this.assertExpectedBranch(worktreeDir, expectedBranch);
            if (branchErr) {
                return { ok: false, reason: branchErr };
            }
        }

        // Auto-commit any pending local changes so the merge can proceed cleanly.
        {
            const addOk = await this.execCmd(`git add . -- :(exclude).harness`, worktreeDir);
            if (!addOk) {
                return { ok: false, reason: `同步前自动暂存失败：${this.lastExecError}` };
            }
            const status = await this.execCmdOutput('git status --porcelain', worktreeDir);
            if (!status.success) {
                return { ok: false, reason: `同步前状态检查失败：${this.lastExecError}` };
            }
            if (status.stdout.trim().length > 0) {
                const committed = await this.execCmd(
                    `git commit -m "chore: auto-commit before sync from ${baseBranch}"`,
                    worktreeDir,
                );
                if (!committed) {
                    return { ok: false, reason: `同步前自动提交失败：${this.lastExecError}` };
                }
            }
        }

        const fetched = await this.execCmd('git fetch origin', mainRepoDir);
        if (!fetched) {
            return { ok: false, reason: `fetch 失败：${this.lastExecError}` };
        }
        // Note: do NOT run `git pull origin ${baseBranch}` in mainRepoDir here.
        // The main repo may not be on baseBranch, and pulling would merge baseBranch
        // into whatever branch it is currently on, which could corrupt iteration branches.
        // git fetch origin (above) is sufficient to update origin/${baseBranch} tracking ref.
        const merged = await this.execCmd(`git merge origin/${baseBranch} --no-edit`, worktreeDir);
        if (!merged) {
            return { ok: false, reason: `合并主分支代码失败（可能有冲突）：${this.lastExecError}` };
        }
        return { ok: true };
    }

    async mergeIterationToTarget(task: Task, iterationDir: string, options: { cleanup?: boolean } = {}): Promise<{ success: boolean; message: string; cleanupComplete?: boolean }> {
        this.currentLogDir = iterationDir;
        const cleanup = options.cleanup !== false;
        // Single, consistent baseline resolution (task base → config baseline → main). Previously
        // this read only config.baseBranch and silently returned success when empty, which is why
        // "提交代码" sometimes appeared to succeed without merging.
        const target = this.resolveBaseBranch(task);

        const sourceBranch = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        this.logGit(`=== 提交代码/合并到基线 开始：task="${task.name}" source=${sourceBranch} target=${target} cleanup=${cleanup} ===`);
        if (!sourceBranch) {
            return { success: false, message: '无法识别迭代分支名' };
        }

        type RepoCtx = { kind: 'frontend' | 'backend'; mainDir: string; worktreeDir: string };
        const repos: RepoCtx[] = [];
        if (this.config.frontendGit) {
            repos.push({
                kind: 'frontend',
                mainDir: this.getMainRepoDir('frontend'),
                worktreeDir: path.join(iterationDir, 'frontend'),
            });
        }
        if (this.config.backendGit) {
            repos.push({
                kind: 'backend',
                mainDir: this.getMainRepoDir('backend'),
                worktreeDir: path.join(iterationDir, 'backend'),
            });
        }

        // Quick check: skip the entire pipeline when no worktree has any changes.
        let anyChanges = false;
        for (const repo of repos) {
            if (!fs.existsSync(repo.worktreeDir)) continue;
            const quickStatus = await this.execCmdOutput('git status --porcelain', repo.worktreeDir);
            if (quickStatus.success && quickStatus.stdout.trim().length > 0) {
                anyChanges = true;
                break;
            }
        }
        if (!anyChanges) {
            this.logGit(`=== 提交代码/合并到基线 跳过：无代码变更 ===`);
            return { success: true, message: '✅ 无代码变更，已跳过推送合并流程' };
        }

        // Phase 1 — Backup: ensure each worktree is fully committed and its iteration branch
        // is pushed to the remote. After this phase, even if merge/push to target fails,
        // the user's work is preserved on origin/<sourceBranch>.
        const sourceShas: Record<string, string> = {};
        for (const repo of repos) {
            const prep = await this.prepareIterationForMerge(repo.worktreeDir, sourceBranch, task);
            if (!prep.ok) {
                return {
                    success: false,
                    message: `[${repo.kind}] 迭代分支同步到远程失败：${prep.reason}\n\n` +
                        `本地 worktree 和迭代分支均未变更，请处理后重试。`,
                };
            }
            sourceShas[repo.kind] = prep.sha || '';
        }

        // Phase 2 — Merge into target & push, verify remote actually advanced and contains source.
        for (const repo of repos) {
            const merged = await this.mergeRepoBranch(repo.mainDir, sourceBranch, target, sourceShas[repo.kind]);
            if (!merged.ok) {
                return {
                    success: false,
                    message: `[${repo.kind}] 合并/推送到远程基线 ${target} 失败：${merged.reason}\n\n` +
                        `⚠️ 代码已安全保存在远程 origin/${sourceBranch}，本地 worktree 与迭代分支均已保留，未执行任何清理。\n` +
                        `请手动处理冲突或确认远程状态后重试。`,
                };
            }
        }

        // Phase 3 — Cleanup only after confirming remote target contains the source commits.
        // Skipped when caller passed { cleanup: false } (e.g. "提交代码" intermediate save that
        // keeps the iteration branch alive for continued work).
        if (!cleanup) {
            return {
                success: true,
                message: `✅ 已推送迭代分支 ${sourceBranch} 到远程并合并到基线 ${target}（worktree 与迭代分支保留，可继续工作）`,
            };
        }

        const cleanupFailures: Array<{ repo: string; reason: string }> = [];
        for (const repo of repos) {
            const cleanupResult = await this.cleanupMergedBranch(repo.mainDir, repo.worktreeDir, sourceBranch, target);
            if (!cleanupResult.ok) {
                cleanupFailures.push({ repo: repo.kind, reason: cleanupResult.reason || '未知错误' });
            }
        }

        if (cleanupFailures.length > 0) {
            const detail = cleanupFailures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return {
                success: true,
                cleanupComplete: false,
                message: `✅ 已合并到远程基线 ${target}（已校验远程包含本次提交）。\n` +
                    `但部分清理步骤失败：\n${detail}\n` +
                    `代码本身已安全在远程基线，可手动清理 worktree/迭代分支。`,
            };
        }

        return { success: true, cleanupComplete: true, message: `✅ 已合并到远程基线 ${target} 并清理迭代分支 ${sourceBranch}` };
    }

    /**
     * Prepare a worktree for merging: auto-commit any pending changes on the iteration branch,
     * push it to remote as a safety backup, and verify the remote SHA matches local.
     * Returns the verified source SHA so the caller can later assert it is an ancestor of the
     * target branch after merge.
     */
    private async prepareIterationForMerge(worktreeDir: string, sourceBranch: string, task: Task): Promise<{ ok: boolean; reason?: string; sha?: string }> {
        if (!fs.existsSync(worktreeDir)) {
            return { ok: false, reason: `worktree 目录不存在：${worktreeDir}` };
        }

        const branchErr = await this.assertExpectedBranch(worktreeDir, sourceBranch);
        if (branchErr) {
            return { ok: false, reason: branchErr };
        }

        const addCmd = await this.execCmd(`git add . -- :(exclude).harness`, worktreeDir);
        if (!addCmd) {
            return { ok: false, reason: `git add 失败：${this.lastExecError}` };
        }

        const status = await this.execCmdOutput('git status --porcelain', worktreeDir);
        if (!status.success) {
            return { ok: false, reason: `git status 失败：${this.lastExecError}` };
        }
        if (status.stdout.trim().length > 0) {
            const commitMessage = this.buildCommitMessage(task);
            const committed = await this.execCmd(`git commit -m "${commitMessage}"`, worktreeDir);
            if (!committed) {
                return { ok: false, reason: `自动提交未提交改动失败：${this.lastExecError}` };
            }
        }

        // Confirm working tree is clean now — otherwise the later non-forced worktree remove
        // could still fail and we want to surface it as a merge-prep error, not a cleanup error.
        const recheck = await this.execCmdOutput('git status --porcelain', worktreeDir);
        if (!recheck.success || recheck.stdout.trim().length > 0) {
            return { ok: false, reason: `worktree 仍有未跟踪/未提交内容：${recheck.stdout.trim() || this.lastExecError}` };
        }

        const pushed = await this.execCmd(`git push -u origin ${sourceBranch}`, worktreeDir);
        if (!pushed) {
            return { ok: false, reason: `推送迭代分支到远程失败：${this.lastExecError}` };
        }

        const fetched = await this.execCmd('git fetch origin', worktreeDir);
        if (!fetched) {
            return { ok: false, reason: `推送后 fetch origin 失败：${this.lastExecError}` };
        }

        const localShaOut = await this.execCmdOutput(`git rev-parse ${sourceBranch}`, worktreeDir);
        if (!localShaOut.success) {
            return { ok: false, reason: `读取本地 ${sourceBranch} SHA 失败：${this.lastExecError}` };
        }
        const remoteShaOut = await this.execCmdOutput(`git rev-parse origin/${sourceBranch}`, worktreeDir);
        if (!remoteShaOut.success) {
            return { ok: false, reason: `读取远程 origin/${sourceBranch} SHA 失败：${this.lastExecError}` };
        }
        const localSha = localShaOut.stdout.trim();
        const remoteSha = remoteShaOut.stdout.trim();
        if (!localSha || !remoteSha || localSha !== remoteSha) {
            return {
                ok: false,
                reason: `远程 origin/${sourceBranch} (${remoteSha || '空'}) 与本地 ${sourceBranch} (${localSha || '空'}) 不一致，推送未真正生效`,
            };
        }
        return { ok: true, sha: localSha };
    }

    private async mergeRepoBranch(repoDir: string, sourceBranch: string, targetBranch: string, expectedSourceSha: string): Promise<{ ok: boolean; reason?: string }> {
        if (!fs.existsSync(repoDir)) {
            return { ok: false, reason: `目录不存在：${repoDir}` };
        }
        if (!expectedSourceSha) {
            return { ok: false, reason: `内部错误：缺少 ${sourceBranch} 的预期 SHA，已中止合并` };
        }

        // Guard: refuse to switch branches when the main repo has uncommitted changes.
        const dirtyCheck = await this.execCmdOutput('git status --porcelain', repoDir);
        if (!dirtyCheck.success) {
            return { ok: false, reason: `主仓库状态检查失败：${this.lastExecError}` };
        }
        if (dirtyCheck.stdout.trim().length > 0) {
            return { ok: false, reason: `主仓库 ${repoDir} 有未提交的改动，请先在主仓库处理后再试。` };
        }

        const fetched = await this.execCmd('git fetch origin', repoDir);
        if (!fetched) {
            return { ok: false, reason: `fetch origin 失败：${this.lastExecError}` };
        }

        const checkoutTarget = await this.execCmd(`git checkout ${targetBranch}`, repoDir);
        if (!checkoutTarget) {
            const createFromRemote = await this.execCmd(`git checkout -b ${targetBranch} origin/${targetBranch}`, repoDir);
            if (!createFromRemote) {
                if (/already exists/i.test(this.lastExecError)) {
                    // Branch exists locally but wasn't checked out above (e.g. dirty state).
                    // Force-switch to it.
                    const forceCheckout = await this.execCmd(`git checkout ${targetBranch}`, repoDir);
                    if (!forceCheckout) {
                        return { ok: false, reason: `目标分支 ${targetBranch} 本地已存在但无法切换：${this.lastExecError}` };
                    }
                } else {
                    const createLocal = await this.execCmd(`git checkout -b ${targetBranch}`, repoDir);
                    if (!createLocal) {
                        return { ok: false, reason: `无法切换到目标分支 ${targetBranch}：${this.lastExecError}` };
                    }
                }
            }
        }

        // pull must succeed — proceeding against a stale local target can silently push the
        // wrong history or cause the post-push ancestry check to fail confusingly.
        // Skip pull if remote branch doesn't yet exist (first push of target).
        const remoteTargetExists = await this.execCmd(`git rev-parse --verify origin/${targetBranch}`, repoDir);
        if (remoteTargetExists) {
            const pulled = await this.execCmd(`git pull origin ${targetBranch}`, repoDir);
            if (!pulled) {
                return { ok: false, reason: `git pull origin ${targetBranch} 失败：${this.lastExecError}` };
            }
        }

        if (this.config.mergeDryRunEnabled) {
            const dryRunOk = await this.execCmd(`git merge --no-commit --no-ff ${sourceBranch}`, repoDir);
            if (!dryRunOk) {
                const dryRunError = this.lastExecError;
                // Only abort if a merge was actually in progress (MERGE_HEAD exists).
                if (fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD'))) {
                    await this.execCmd('git merge --abort', repoDir);
                }
                return { ok: false, reason: `干运行冲突检测失败（与 ${targetBranch} 有冲突），请手动解决：${dryRunError}` };
            }
            await this.execCmd('git merge --abort', repoDir);
        }

        const merged = await this.execCmd(
            `git merge --no-ff ${sourceBranch} -m "chore: merge ${sourceBranch} into ${targetBranch}"`,
            repoDir
        );
        if (!merged) {
            return { ok: false, reason: `合并命令执行失败：${this.lastExecError}` };
        }

        // Local sanity: merged target must now contain the iteration SHA.
        const localContainsSource = await this.execCmd(`git merge-base --is-ancestor ${expectedSourceSha} HEAD`, repoDir);
        if (!localContainsSource) {
            return { ok: false, reason: `本地合并后 HEAD 不包含 ${sourceBranch} 的 commit ${expectedSourceSha}` };
        }

        const pushed = await this.execCmd(`git push origin ${targetBranch}`, repoDir);
        if (!pushed) {
            return { ok: false, reason: `push 到 ${targetBranch} 失败：${this.lastExecError}` };
        }

        // Verify remote actually advanced. `git push` can exit 0 in degenerate cases without
        // updating the remote ref we expected, so we explicitly compare SHAs.
        const refetched = await this.execCmd('git fetch origin', repoDir);
        if (!refetched) {
            return { ok: false, reason: `推送后 fetch origin 失败，无法校验远程：${this.lastExecError}` };
        }
        const localTargetSha = await this.execCmdOutput(`git rev-parse ${targetBranch}`, repoDir);
        if (!localTargetSha.success) {
            return { ok: false, reason: `读取本地 ${targetBranch} SHA 失败：${this.lastExecError}` };
        }
        const remoteTargetSha = await this.execCmdOutput(`git rev-parse origin/${targetBranch}`, repoDir);
        if (!remoteTargetSha.success) {
            return { ok: false, reason: `读取远程 origin/${targetBranch} SHA 失败：${this.lastExecError}` };
        }
        const lts = localTargetSha.stdout.trim();
        const rts = remoteTargetSha.stdout.trim();
        if (!lts || !rts || lts !== rts) {
            return {
                ok: false,
                reason: `远程 origin/${targetBranch} (${rts || '空'}) 与本地 ${targetBranch} (${lts || '空'}) 不一致，推送未真正生效`,
            };
        }

        // Final verification: the remote target ref must contain the source SHA.
        const remoteContainsSource = await this.execCmd(`git merge-base --is-ancestor ${expectedSourceSha} origin/${targetBranch}`, repoDir);
        if (!remoteContainsSource) {
            return {
                ok: false,
                reason: `远程 origin/${targetBranch} 不包含 ${sourceBranch} 的 commit ${expectedSourceSha}，合并校验失败`,
            };
        }

        return { ok: true };
    }

    private async cleanupMergedBranch(mainRepoDir: string, worktreeDir: string, sourceBranch: string, targetBranch: string): Promise<{ ok: boolean; reason?: string }> {
        if (!fs.existsSync(mainRepoDir)) {
            return { ok: false, reason: `主仓库目录不存在：${mainRepoDir}` };
        }

        // Safety net: verify the remote target branch actually contains the iteration commits
        // before deleting anything. Use git ls-remote to check the remote directly (does not
        // depend on local branch state, which may already be cleaned up).
        const remoteTargetRef = await this.execCmdOutput(`git ls-remote origin ${targetBranch}`, mainRepoDir);
        if (!remoteTargetRef.success || !remoteTargetRef.stdout.trim()) {
            return { ok: false, reason: `无法读取远程 origin/${targetBranch}，已中止清理以防误删` };
        }

        const failures: string[] = [];

        // ── Local cleanup (worktree + local branch) ──
        const registered = await this.hasRegisteredWorktreeAtPath(mainRepoDir, worktreeDir);
        if (registered) {
            const removed = await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
            if (!removed) {
                failures.push(`移除 worktree 失败：${this.lastExecError}`);
            }
        }
        await this.execCmd('git worktree prune', mainRepoDir);

        const deletedLocal = await this.execCmd(`git branch -D ${sourceBranch}`, mainRepoDir);
        if (!deletedLocal) {
            if (!/not found|unknown branch|does not exist|no such branch/i.test(this.lastExecError)) {
                failures.push(`删除本地分支失败：${this.lastExecError}`);
            }
        }

        // ── Remote cleanup (always attempted, independent of local state) ──
        const remoteRef = await this.execCmdOutput(`git ls-remote origin ${sourceBranch}`, mainRepoDir);
        if (remoteRef.success && remoteRef.stdout.trim()) {
            // Use the explicit ref syntax for maximum reliability across git versions.
            const deletedRemote = await this.execCmd(
                `git push origin :refs/heads/${sourceBranch}`,
                mainRepoDir,
            );
            if (!deletedRemote) {
                failures.push(`删除远程分支 origin/${sourceBranch} 失败：${this.lastExecError}`);
            }
        } else {
            this.logGit(`远程分支 origin/${sourceBranch} 已不存在，跳过删除`);
        }

        if (failures.length > 0) {
            return { ok: false, reason: failures.join('；') };
        }
        return { ok: true };
    }

    private async checkoutAndPullBase(repoDir: string, baseBranch: string, requireExactBaseBranch: boolean): Promise<{ success: boolean; baseBranch?: string }> {
        const fetched = await this.execCmd('git fetch origin', repoDir);
        if (!fetched) {
            return { success: false };
        }
        const branchCandidates = requireExactBaseBranch
            ? [baseBranch]
            : await this.buildBaseBranchCandidates(repoDir, baseBranch);

        for (const candidate of branchCandidates) {
            const switched = await this.switchToBranch(repoDir, candidate);
            if (!switched) {
                continue;
            }
            const pulled = await this.execCmd(`git pull origin ${candidate}`, repoDir);
            if (pulled) {
                return { success: true, baseBranch: candidate };
            }
        }

        // If the specified base branch doesn't exist, create it from master/main
        if (requireExactBaseBranch) {
            const fallbackBranch = await this.findDefaultBranch(repoDir);
            if (fallbackBranch) {
                const switched = await this.switchToBranch(repoDir, fallbackBranch);
                if (switched) {
                    await this.execCmd(`git pull origin ${fallbackBranch}`, repoDir);
                    const created = await this.execCmd(`git checkout -b ${baseBranch}`, repoDir);
                    if (created) {
                        await this.execCmd(`git push -u origin ${baseBranch}`, repoDir);
                        return { success: true, baseBranch };
                    }
                }
            }
            this.lastExecError = this.withExecError(`指定基线分支不可用: ${baseBranch}`);
        }

        return { success: false };
    }

    private async findDefaultBranch(repoDir: string): Promise<string | null> {
        const remoteDefault = await this.resolveRemoteDefaultBranch(repoDir);
        if (remoteDefault) {
            return remoteDefault;
        }
        for (const candidate of ['master', 'main']) {
            const switched = await this.switchToBranch(repoDir, candidate);
            if (switched) {
                return candidate;
            }
        }
        return null;
    }

    private async buildBaseBranchCandidates(repoDir: string, preferred: string): Promise<string[]> {
        const list: string[] = [];
        const pushUnique = (name?: string) => {
            const v = (name || '').trim();
            if (!v || list.includes(v)) {
                return;
            }
            list.push(v);
        };

        pushUnique(preferred);
        const remoteDefault = await this.resolveRemoteDefaultBranch(repoDir);
        pushUnique(remoteDefault || undefined);
        pushUnique('master');
        pushUnique('main');

        return list;
    }

    private async resolveRemoteDefaultBranch(repoDir: string): Promise<string | null> {
        const symbolic = await this.execCmdOutput('git symbolic-ref --short refs/remotes/origin/HEAD', repoDir);
        if (!symbolic.success) {
            return null;
        }
        const line = (symbolic.stdout || '').trim();
        if (!line) {
            return null;
        }
        const parts = line.split('/');
        return parts.length >= 2 ? parts[parts.length - 1] : null;
    }

    private async switchToBranch(repoDir: string, branch: string): Promise<boolean> {
        const checkout = await this.execCmd(`git checkout ${branch}`, repoDir);
        if (checkout) {
            return true;
        }
        return this.execCmd(`git checkout -b ${branch} origin/${branch}`, repoDir);
    }

    private async getCurrentBranch(repoDir: string): Promise<string | null> {
        const result = await this.execCmdOutput('git branch --show-current', repoDir);
        if (!result.success) {
            return null;
        }
        return result.stdout.trim() || null;
    }

    /**
     * Returns an error string if the repo at repoDir is NOT on expectedBranch, or null if it is.
     * Skips the check when the directory doesn't exist (let downstream report the missing dir).
     */
    private async assertExpectedBranch(repoDir: string, expectedBranch: string): Promise<string | null> {
        if (!fs.existsSync(repoDir)) {
            return null;
        }
        const currentBranch = await this.getCurrentBranch(repoDir);
        if (currentBranch && currentBranch !== expectedBranch) {
            return `分支异常：当前所在分支为 "${currentBranch}"，期望分支为 "${expectedBranch}"。` +
                `请检查 worktree 是否被误操作（例如手动执行了 git checkout）。操作已中止，以防止代码推送到错误分支。`;
        }
        return null;
    }

    private hasGitWorktree(worktreeDir: string): boolean {
        return fs.existsSync(worktreeDir) && fs.existsSync(path.join(worktreeDir, '.git'));
    }

    private removeDirRobustly(targetDir: string): void {
        this.safeRemovePath(targetDir, { recursive: true });
    }

    private async hasRegisteredWorktreeAtPath(mainRepoDir: string, worktreeDir: string): Promise<boolean> {
        const out = await this.execCmdOutput('git worktree list --porcelain', mainRepoDir);
        if (!out.success) {
            return false;
        }
        const target = this.normalizePath(worktreeDir);
        return out.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('worktree '))
            .map(line => line.substring('worktree '.length))
            .some(p => this.normalizePath(p) === target);
    }

    private extractAlreadyCheckedOutPath(errorText: string): string | null {
        const match = /(already\s+)?checked out at '([^']+)'/i.exec(errorText || '');
        if (!match) {
            return null;
        }
        const pathGroup = match[2] || match[1];
        if (!pathGroup) {
            return null;
        }
        return pathGroup;
    }

    private isSamePath(left: string, right: string): boolean {
        return this.normalizePath(left) === this.normalizePath(right);
    }

    private normalizePath(input: string): string {
        return (input || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .toLowerCase();
    }

    private withExecError(prefix: string): string {
        if (!this.lastExecError) {
            return prefix;
        }
        return `${prefix}；${this.lastExecError}`;
    }

    private async execCmd(cmd: string, cwd: string): Promise<boolean> {
        return new Promise((resolve) => {
            exec(cmd, { cwd }, (err, stdout, stderr) => {
                const outText = (stdout || '').toString().trim();
                const errText = (stderr || '').toString().trim();
                if (err) {
                    this.lastExecError = `命令失败: ${cmd} | 目录: ${cwd}${errText ? ` | stderr: ${errText}` : ''}${outText ? ` | stdout: ${outText}` : ''}`;
                    console.error(`EXEC ERROR: ${this.lastExecError}`);
                    this.logGit(`ERR (exit ${err.code ?? '?'}) [${cwd}] ${cmd}${errText ? `\n  stderr: ${errText}` : ''}${outText ? `\n  stdout: ${outText}` : ''}`);
                } else {
                    this.lastExecError = '';
                    const detail = errText || outText ? `\n  ${errText ? `stderr: ${errText}` : ''}${outText ? `stdout: ${outText}` : ''}` : '';
                    this.logGit(`OK  [${cwd}] ${cmd}${detail}`);
                }
                resolve(!err);
            });
        });
    }

    private async execCmdOutput(cmd: string, cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            exec(cmd, { cwd }, (err, stdout, stderr) => {
                const out = (stdout || '').toString();
                const errText = (stderr || '').toString();
                if (err) {
                    const compactErr = errText.trim();
                    this.lastExecError = `命令失败: ${cmd} | 目录: ${cwd}${compactErr ? ` | stderr: ${compactErr}` : ''}${out.trim() ? ` | stdout: ${out.trim()}` : ''}`;
                    this.logGit(`ERR (exit ${err.code ?? '?'}) [${cwd}] ${cmd}${compactErr ? `\n  stderr: ${compactErr}` : ''}${out.trim() ? `\n  stdout: ${out.trim()}` : ''}`);
                    resolve({ success: false, stdout: out, stderr: errText });
                    return;
                }
                const outTrimmed = out.trim();
                const errTrimmed = errText.trim();
                const detail = errTrimmed || outTrimmed ? `\n  ${errTrimmed ? `stderr: ${errTrimmed}` : ''}${outTrimmed ? `stdout: ${outTrimmed}` : ''}` : '';
                this.logGit(`OK  [${cwd}] ${cmd}${detail}`);
                resolve({ success: true, stdout: out, stderr: errText });
            });
        });
    }
}
