import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { Config, DEFAULT_MONOREPO_DIRS, Feature } from '../models';
import { appendHarnessLog } from './harnessLog';
import { clearDirChildrenPreserving, safeRemovePath } from './fileOps';
import { deriveIterationBranchName } from './branchName';

/**
 * Describes one git repository the harness manages for an iteration. In multi-repo mode there is
 * one descriptor per configured side (frontend/backend), each checked out into an `iterationDir`
 * subfolder. In monorepo mode there is a single descriptor whose worktree IS the iteration dir root.
 */
interface RepoDescriptor {
    kind: 'frontend' | 'backend' | 'mono';
    /** Human-friendly label used in user-facing messages. */
    label: string;
    remote: string;
    mainDir: string;
    worktreeDir: string;
}

export class GitService {
    private config: Config;
    private workspaceRoot: string;
    private lastExecError: string = '';
    private localBaseFallbackNotices: Set<string> = new Set();
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
     * Consume and clear one-shot notices about local-base fallback usage.
     * Returns null when no fallback happened in recent git operations.
     */
    consumeLocalBaseFallbackNotice(): string | null {
        if (this.localBaseFallbackNotices.size === 0) {
            return null;
        }
        const details = Array.from(this.localBaseFallbackNotices.values()).join('；');
        this.localBaseFallbackNotices.clear();
        return `提示：检测到指定基线分支不可用，已自动回退到可用基线继续执行（${details}）。`;
    }

    private clearOperationNotices(): void {
        this.localBaseFallbackNotices.clear();
    }

    private markLocalBaseFallback(detail: string): void {
        const normalized = (detail || '').trim();
        if (normalized) {
            this.localBaseFallbackNotices.add(normalized);
        }
    }

    /**
     * Single source of truth for an iteration's baseline branch: the base recorded when the
     * iteration was created (task.baseBranchUsed), else the configured baseline, else 'main'.
     * All branch / merge / sync paths must resolve through here so there is exactly one notion
     * of "基线分支".
     */
    private resolveBaseBranch(task?: Feature): string {
        return (task?.baseBranchUsed || this.config.baseBranch || 'main').trim();
    }

    /** True when a single-repository (monorepo) remote is configured. */
    private isMonorepo(): boolean {
        return Boolean(this.config.monorepoGit && this.config.monorepoGit.trim());
    }

    /**
     * Single source of truth for which repositories an iteration spans. Monorepo mode yields one
     * descriptor whose worktree is the iteration dir root; multi-repo mode yields one descriptor
     * per configured frontend/backend, each checked out into an `iterationDir` subfolder.
     * Pass '' for `iterationDir` when only main-repo info is needed (e.g. initializeRepos).
     */
    private resolveRepoDescriptors(iterationDir: string): RepoDescriptor[] {
        if (this.isMonorepo()) {
            return [{
                kind: 'mono',
                label: '仓库',
                remote: this.config.monorepoGit.trim(),
                // Monorepo: a dedicated main clone under repos/mono-main; iterations are git
                // worktrees whose root IS the iteration dir (front/back live in configured subfolders).
                mainDir: this.getMainRepoDir('mono'),
                worktreeDir: iterationDir,
            }];
        }
        const descriptors: RepoDescriptor[] = [];
        if (this.config.frontendGit) {
            descriptors.push({
                kind: 'frontend',
                label: '前端',
                remote: this.config.frontendGit,
                mainDir: this.getMainRepoDir('frontend'),
                worktreeDir: path.join(iterationDir, 'frontend'),
            });
        }
        if (this.config.backendGit) {
            descriptors.push({
                kind: 'backend',
                label: '后端',
                remote: this.config.backendGit,
                mainDir: this.getMainRepoDir('backend'),
                worktreeDir: path.join(iterationDir, 'backend'),
            });
        }
        return descriptors;
    }

    /**
     * Log a git line to the unified per-task log: the current operation's iteration dir when set
     * (so logs are split per task), otherwise the master root for task-less ops like repo init.
     */
    private logGit(line: string): void {
        // Critical for lazy-init: before a worktree is successfully attached, writing logs to
        // `currentLogDir/.harness` would implicitly create the directory and then make
        // `git worktree add <currentLogDir>` fail with "already exists".
        // Therefore only log to currentLogDir when it is already a valid git worktree.
        const preferred = (this.currentLogDir || '').trim();
        const canUsePreferred = Boolean(preferred) && fs.existsSync(path.join(preferred, '.git'));
        appendHarnessLog(canUsePreferred ? preferred : this.workspaceRoot, 'git', line);
    }

    /**
     * Always writes to the workspace root `.harness/harness.log`, regardless of whether
     * the current iteration dir has a `.git` yet. Use for pre-operation progress messages
     * so the log file exists even while a blocking network command (clone/fetch) is running.
     */
    private logGitToRoot(line: string): void {
        appendHarnessLog(this.workspaceRoot || this.currentLogDir, 'git', line);
    }

    async initializeRepos(): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = ''; // no single task → log repo init to the master root
        this.lastExecError = '';
        this.clearOperationNotices();
        const descriptors = this.resolveRepoDescriptors('');
        if (descriptors.length === 0) {
            return { success: false, message: '请至少填写一个 Git 地址（前端/后端或单一仓库）' };
        }

        const baseBranch = (this.config.baseBranch || 'main').trim();
        // Saving Git settings should initialize repos robustly even when the configured base
        // branch does not exist yet on remote. Exact-branch enforcement is done when creating
        // iteration branches, not during settings save.
        const requireExact = false;

        for (const repo of descriptors) {
            const result = await this.ensureMainRepo(repo.remote, repo.mainDir, baseBranch, requireExact);
            if (!result.success) {
                return { success: false, message: this.withExecError(`${repo.label}仓库初始化失败`) };
            }
            if (repo.kind === 'mono') {
                this.ensureMonorepoScaffold(repo.mainDir);
            }
        }

        return { success: true, message: '✅ Git 配置已保存，代码初始化完成' };
    }

    async createIterationBranches(task: Feature, iterationDir: string): Promise<{ success: boolean; message?: string; baseBranch?: string; iterationBranch?: string }> {
        this.currentLogDir = iterationDir;
        this.lastExecError = '';
        this.clearOperationNotices();
        const branchName = deriveIterationBranchName(task);
        const baseBranch = (this.config.baseBranch || 'main').trim();
        const requireExactBaseBranch = Boolean(this.config.baseBranch?.trim());
        let resolvedBaseBranch = baseBranch;

        // Write immediately so the log file exists even if a subsequent network command hangs.
        this.logGitToRoot(`=== 开始重建代码目录：task="${task.name}" iterDir=${iterationDir} baseBranch=${baseBranch} ===`);

        const descriptors = this.resolveRepoDescriptors(iterationDir);
        if (descriptors.length === 0) {
            return { success: false, message: '请先在高级设置配置至少一个 Git 地址' };
        }

        const expectedWorktrees: string[] = [];
        let baseAssigned = false;

        for (const repo of descriptors) {
            const init = await this.ensureMainRepo(repo.remote, repo.mainDir, baseBranch, requireExactBaseBranch);
            if (!init.success) {
                return {
                    success: false,
                    message: this.withExecError(requireExactBaseBranch
                        ? `${repo.label}仓库初始化失败：无法按指定基线分支 ${baseBranch} 准备代码`
                        : `${repo.label}仓库初始化失败（clone/fetch/checkout）`),
                };
            }
            const repoBaseBranch = init.baseBranch || baseBranch;
            if (!baseAssigned) {
                resolvedBaseBranch = repoBaseBranch;
                baseAssigned = true;
            }
            if (!await this.prepareWorktree(repo.mainDir, repo.worktreeDir, branchName, repoBaseBranch)) {
                return { success: false, message: this.withExecError(`${repo.label} worktree 创建失败`) };
            }
            if (repo.kind === 'mono') {
                this.ensureMonorepoScaffold(repo.worktreeDir);
            }
            expectedWorktrees.push(repo.worktreeDir);
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
        const repos = this.resolveRepoDescriptors(iterationDir);

        for (const repo of repos) {
            const escapedWorktree = repo.worktreeDir.replace(/"/g, '\\"');
            try {
                if (fs.existsSync(repo.mainDir)) {
                    const registered = await this.hasRegisteredWorktreeAtPath(repo.mainDir, repo.worktreeDir);
                    if (registered) {
                        const removed = await this.execCmd(`git worktree remove --force "${escapedWorktree}"`, repo.mainDir);
                        if (!removed && !/not a working tree/i.test(this.lastExecError || '')) {
                            errors.push(`[${repo.label}] git worktree remove 失败：${this.lastExecError}`);
                        }
                    }
                    await this.execCmd('git worktree prune', repo.mainDir);
                }

                this.safeRemovePath(repo.worktreeDir, { recursive: true });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`[${repo.label}] 删除目录失败：${message}`);
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

    private getMainRepoDir(kind: 'frontend' | 'backend' | 'mono'): string {
        return path.join(this.workspaceRoot, 'repos', `${kind}-main`);
    }

    private ensureMonorepoScaffold(rootDir: string): void {
        const dirs = this.config.monorepoDirs || DEFAULT_MONOREPO_DIRS;
        const scaffoldDirs = [
            dirs.frontend || DEFAULT_MONOREPO_DIRS.frontend,
            dirs.docs || DEFAULT_MONOREPO_DIRS.docs,
            dirs.scripts || DEFAULT_MONOREPO_DIRS.scripts,
        ];
        for (const relDir of scaffoldDirs) {
            const name = (relDir || '').trim();
            if (!name) {
                continue;
            }
            fs.mkdirSync(path.join(rootDir, name), { recursive: true });
        }
    }

    private buildCommitMessage(task: Feature): string {
        const raw = (task.desc || task.name || 'update').trim();
        const normalized = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        const truncated = normalized.length > 120 ? normalized.slice(0, 120).trim() : normalized;
        return truncated.replace(/"/g, '\\"') || 'update';
    }

    private async ensureMainRepo(remote: string, repoDir: string, baseBranch: string, requireExactBaseBranch: boolean): Promise<{ success: boolean; baseBranch?: string }> {
        if (fs.existsSync(repoDir) && fs.existsSync(path.join(repoDir, '.git'))) {
            // Verify the configured remote URL matches what is actually cloned here.
            // If it doesn't (e.g., left-over from an old git-init style setup), wipe and re-clone.
            const urlOut = await this.execCmdOutput('git remote get-url origin', repoDir);
            const existingUrl = urlOut.success ? urlOut.stdout.trim() : '';
            const normalise = (u: string) => u.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
            if (!existingUrl || normalise(existingUrl) !== normalise(remote)) {
                this.logGit(`主仓库远端地址不匹配（当前=${existingUrl}，期望=${remote}），删除后重新克隆`);
                this.safeRemovePath(repoDir, { recursive: true });
            }
        }
        if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
            fs.mkdirSync(path.dirname(repoDir), { recursive: true });
            this.logGitToRoot(`正在克隆仓库（可能需要几分钟）：${remote} → ${repoDir}`);
            const cloned = await this.execCmd(`git clone ${remote} "${repoDir}"`, this.workspaceRoot || path.dirname(repoDir));
            if (!cloned) {
                // Clean up any partial clone so the next attempt starts fresh.
                if (fs.existsSync(repoDir)) {
                    this.logGitToRoot(`克隆失败，清理残缺目录：${repoDir}`);
                    this.safeRemovePath(repoDir, { recursive: true });
                }
                return { success: false };
            }
        }
        return this.checkoutAndPullBase(repoDir, baseBranch, requireExactBaseBranch);
    }

    private async prepareWorktree(mainRepoDir: string, worktreeDir: string, branchName: string, baseBranch: string): Promise<boolean> {
        // Empty repos (no commits) cannot create worktrees. Bootstrap with an initial commit first.
        const isEmpty = await this.isEmptyRepo(mainRepoDir);
        if (isEmpty) {
            this.logGit(`空仓库检测：在主仓库创建初始提交以支持 worktree`);
            // Create baseBranch as an orphan branch with one empty commit.
            await this.execCmd(`git checkout --orphan ${baseBranch}`, mainRepoDir);
            await this.execCmd('git commit --allow-empty -m "chore: initial commit by funharness"', mainRepoDir);
        }

        // .harness is written into the iteration dir by saveAndRender() BEFORE git worktree
        // creation. Windows file-system watchers keep handles on that directory, which prevents
        // the OS from deleting it. Move .harness out temporarily so the parent directory becomes
        // empty and deletable, then restore it after git worktree add.
        const harnessDir = path.join(worktreeDir, '.harness');
        const tempHarnessDir = path.join(path.dirname(worktreeDir), `.harness-tmp-${branchName}`);
        let harnessMoved = false;
        if (fs.existsSync(harnessDir)) {
            try {
                if (fs.existsSync(tempHarnessDir)) {
                    this.safeRemovePath(tempHarnessDir, { recursive: true });
                }
                fs.renameSync(harnessDir, tempHarnessDir);
                harnessMoved = true;
                this.logGit(`.harness 已临时移出 ${worktreeDir} 以规避 Windows 文件锁`);
            } catch {
                // Non-fatal: forceRemoveDirAsync will handle the locked dir below.
            }
        }

        if (fs.existsSync(worktreeDir)) {
            const removed = await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
            if (!removed) {
                // When git does not recognize this path as a worktree, treat it as stale folder and continue.
                if (!/not a working tree/i.test(this.lastExecError || '')) {
                    if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
                    return false;
                }
            }
            await this.forceRemoveDirAsync(worktreeDir);
        }

        // Clean stale worktree records before creating a new one.
        await this.execCmd('git worktree prune', mainRepoDir);

        if (await this.hasRegisteredWorktreeAtPath(mainRepoDir, worktreeDir)) {
            // Same path already registered by git worktree metadata, reuse it when valid.
            if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
            return this.hasGitWorktree(worktreeDir);
        }

        fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
        const added = await this.execCmd(`git worktree add "${worktreeDir}" -B ${branchName} ${baseBranch}`, mainRepoDir);
        if (!added) {
            // git reports "already exists" when the target directory still exists on disk
            // (e.g. Windows file locks prevented safeRemovePath from completing).
            // Remove it forcefully and retry once before giving up.
            if (/already exists/i.test(this.lastExecError || '')) {
                await this.forceRemoveDirAsync(worktreeDir);
                await this.execCmd('git worktree prune', mainRepoDir);
                const retried = await this.execCmd(`git worktree add "${worktreeDir}" -B ${branchName} ${baseBranch}`, mainRepoDir);
                if (!retried) {
                    if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
                    return false;
                }
                if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
                return this.hasGitWorktree(worktreeDir);
            }
            const conflictPath = this.extractAlreadyCheckedOutPath(this.lastExecError);
            if (conflictPath && this.isSamePath(conflictPath, worktreeDir)) {
                if (this.hasGitWorktree(worktreeDir)) {
                    if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
                    return true;
                }
                // Clear stale registration and retry once.
                await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
                await this.execCmd('git worktree prune', mainRepoDir);
                const retried = await this.execCmd(`git worktree add "${worktreeDir}" -B ${branchName} ${baseBranch}`, mainRepoDir);
                if (!retried) {
                    if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
                    return false;
                }
                if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
                return this.hasGitWorktree(worktreeDir);
            }
            if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
            return false;
        }
        if (harnessMoved) { this.tryRestoreHarness(tempHarnessDir, harnessDir); }
        return this.hasGitWorktree(worktreeDir);
    }

    /** Move the temp .harness backup back into the worktree dir if the target doesn't exist yet. */
    private tryRestoreHarness(tempDir: string, targetDir: string): void {
        try {
            if (fs.existsSync(tempDir) && !fs.existsSync(targetDir)) {
                fs.mkdirSync(path.dirname(targetDir), { recursive: true });
                fs.renameSync(tempDir, targetDir);
                this.logGit(`.harness 已从临时位置恢复至 ${targetDir}`);
            } else if (fs.existsSync(tempDir)) {
                this.safeRemovePath(tempDir, { recursive: true });
            }
        } catch {
            // Best-effort: if restore fails the dir will be recreated by saveAndRender on next save.
        }
    }

    async pushAll(task: Feature, iterationDir: string): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = iterationDir;
        const failures: Array<{ repo: string; reason: string }> = [];
        const commitMessage = this.buildCommitMessage(task);
        const expectedBranch = deriveIterationBranchName(task);
        const repos = this.resolveRepoDescriptors(iterationDir);

        for (const repo of repos) {
            const branchErr = await this.assertExpectedBranch(repo.worktreeDir, expectedBranch);
            if (branchErr) {
                failures.push({ repo: repo.label, reason: branchErr });
                continue;
            }
            const error = await this.pushRepoChanges(repo.label, repo.worktreeDir, commitMessage);
            if (error) {
                failures.push({ repo: repo.label, reason: error });
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
        const addCmd = await this.execGitAddTolerant(repoDir);
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

    async syncMainCode(task: Feature, iterationDir: string): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = iterationDir;
        this.clearOperationNotices();
        const baseBranch = this.resolveBaseBranch(task);
        const expectedBranch = deriveIterationBranchName(task);
        const failures: Array<{ repo: string; reason: string }> = [];
        const repos = this.resolveRepoDescriptors(iterationDir);

        for (const repo of repos) {
            const result = await this.syncRepoToWorktree(repo.mainDir, repo.worktreeDir, baseBranch, expectedBranch);
            if (!result.ok) { failures.push({ repo: repo.label, reason: result.reason || '未知' }); }
        }

        if (failures.length > 0) {
            const detail = failures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return { success: false, message: `同步失败：\n${detail}` };
        }
        return { success: true, message: `✅ 已同步主仓库最新代码（${baseBranch}）到当前 worktree` };
    }

    /**
     * Commit docs/domains baseline updates on the current branch without pushing.
     */
    async commitDomainBaseline(repoRoot: string): Promise<{ success: boolean; message: string }> {
        this.currentLogDir = repoRoot;
        this.lastExecError = '';
        this.clearOperationNotices();

        const domainsDir = path.join(repoRoot, 'docs', 'domains');
        if (!fs.existsSync(domainsDir)) {
            return { success: false, message: `目录不存在：${domainsDir}` };
        }

        const inRepo = await this.execCmdOutput('git rev-parse --is-inside-work-tree', repoRoot);
        if (!inRepo.success || inRepo.stdout.trim() !== 'true') {
            return { success: false, message: this.withExecError('当前目录不是 Git 仓库') };
        }

        const addOk = await this.execCmd('git add docs/domains', repoRoot);
        if (!addOk) {
            return { success: false, message: this.withExecError('暂存 docs/domains 失败') };
        }

        const status = await this.execCmdOutput('git status --porcelain -- docs/domains', repoRoot);
        if (!status.success) {
            return { success: false, message: this.withExecError('检查 docs/domains 变更失败') };
        }
        if (!status.stdout.trim()) {
            return { success: true, message: 'ℹ️ docs/domains 无待提交变更' };
        }

        const commitMessage = `chore(domain-baseline): update docs/domains ${new Date().toISOString().slice(0, 10)}`;
        const committed = await this.execCmd(`git commit -m "${commitMessage}"`, repoRoot);
        if (!committed) {
            return { success: false, message: this.withExecError('提交领域基线失败') };
        }

        return { success: true, message: `✅ 已提交领域基线：${commitMessage}` };
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
            const addOk = await this.execGitAddTolerant(worktreeDir);
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
        // If origin/<base> doesn't exist, fall back to an available remote default branch
        // (origin/HEAD -> master/main).
        const remoteList = await this.execCmdOutput(`git branch -r --list origin/${baseBranch}`, mainRepoDir);
        const hasRemoteBase = remoteList.success && Boolean((remoteList.stdout || '').trim());
        let mergeSource = `origin/${baseBranch}`;
        if (!hasRemoteBase) {
            const fallbackBranch = await this.findDefaultBranch(mainRepoDir);
            if (!fallbackBranch) {
                return { ok: false, reason: `基线分支不可用：远程不存在 ${baseBranch}，且未找到可用的远程回退分支（master/main）` };
            }
            mergeSource = `origin/${fallbackBranch}`;
            this.logGit(`同步回退：origin/${baseBranch} 不存在，改用远程分支 origin/${fallbackBranch} 合并`);
            this.markLocalBaseFallback(`指定=${baseBranch} -> 使用=${fallbackBranch}`);
        }
        const merged = await this.execCmd(`git merge ${mergeSource} --no-edit`, worktreeDir);
        if (!merged) {
            return { ok: false, reason: `合并主分支代码失败（可能有冲突）：${this.lastExecError}` };
        }
        return { ok: true };
    }

    async mergeIterationToTarget(task: Feature, iterationDir: string, options: { cleanup?: boolean } = {}): Promise<{ success: boolean; message: string; cleanupComplete?: boolean }> {
        this.currentLogDir = iterationDir;
        const cleanup = options.cleanup !== false;
        // Single, consistent baseline resolution (task base → config baseline → main). Previously
        // this read only config.baseBranch and silently returned success when empty, which is why
        // "提交代码" sometimes appeared to succeed without merging.
        const target = this.resolveBaseBranch(task);

        const sourceBranch = deriveIterationBranchName(task);
        this.logGit(`=== 提交代码/合并到基线 开始：task="${task.name}" source=${sourceBranch} target=${target} cleanup=${cleanup} ===`);
        if (!sourceBranch) {
            return { success: false, message: '无法识别迭代分支名' };
        }

        type RepoCtx = { kind: 'frontend' | 'backend' | 'mono'; label: string; mainDir: string; worktreeDir: string };
        const repos: RepoCtx[] = this.resolveRepoDescriptors(iterationDir);

        // Quick check: skip the entire pipeline when no worktree has uncommitted changes
        // AND the iteration branch has no commits ahead of the target baseline.
        let anyChanges = false;
        for (const repo of repos) {
            if (!fs.existsSync(repo.worktreeDir)) continue;
            // 1) Check for uncommitted working-tree changes.
            const quickStatus = await this.execCmdOutput('git status --porcelain', repo.worktreeDir);
            if (quickStatus.success && quickStatus.stdout.trim().length > 0) {
                anyChanges = true;
                break;
            }
            // 2) Check for committed-but-not-merged differences vs the target baseline.
            //    `git log target..HEAD` lists commits on the iteration branch that are not
            //    yet in the target — i.e. exactly what needs to be merged.
            const ahead = await this.execCmdOutput(
                `git log ${target}..HEAD --oneline`,
                repo.worktreeDir,
            );
            if (ahead.success && ahead.stdout.trim().length > 0) {
                anyChanges = true;
                this.logGit(`迭代分支有未合并到 ${target} 的提交：\n${ahead.stdout.trim()}`);
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
                    message: `[${repo.label}] 迭代分支同步到远程失败：${prep.reason}\n\n` +
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
                    message: `[${repo.label}] 合并/推送到远程基线 ${target} 失败：${merged.reason}\n\n` +
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
                cleanupFailures.push({ repo: repo.label, reason: cleanupResult.reason || '未知错误' });
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
    private async prepareIterationForMerge(worktreeDir: string, sourceBranch: string, task: Feature): Promise<{ ok: boolean; reason?: string; sha?: string }> {
        if (!fs.existsSync(worktreeDir)) {
            return { ok: false, reason: `worktree 目录不存在：${worktreeDir}` };
        }

        const branchErr = await this.assertExpectedBranch(worktreeDir, sourceBranch);
        if (branchErr) {
            return { ok: false, reason: branchErr };
        }

        const addCmd = await this.execGitAddTolerant(worktreeDir);
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

        // Verify remote actually advanced.
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
        this.logGitToRoot(`正在 fetch 远端：${repoDir}`);
        const fetched = await this.execCmd('git fetch origin', repoDir);
        if (!fetched) {
            return { success: false };
        }

        // Handle empty repositories (freshly created remote with zero commits).
        // In this case there are no branches at all — just succeed and let the user start working.
        const isEmpty = await this.isEmptyRepo(repoDir);
        if (isEmpty) {
            this.logGit(`仓库为空仓库（无任何提交），跳过基线分支检出，直接视为初始化成功`);
            this.markLocalBaseFallback(`远程仓库为空，将在首次提交时自动创建分支`);
            return { success: true, baseBranch: baseBranch || 'main' };
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
            // Pull failed — check if the remote simply doesn't have this branch.
            // If local checkout succeeded but remote branch is absent, that's OK:
            // the user can start working from the local branch.
            const remoteHasBranch = await this.execCmdOutput(`git branch -r --list origin/${candidate}`, repoDir);
            if (!remoteHasBranch.success || !(remoteHasBranch.stdout || '').trim()) {
                this.logGit(`远程不存在分支 ${candidate}，但本地已切换成功，视为初始化成功`);
                this.markLocalBaseFallback(`远程不存在 ${candidate}，使用本地分支`);
                return { success: true, baseBranch: candidate };
            }
        }

        // Exact base mode fallback: when the configured base branch is unavailable, fall back to
        // an existing remote baseline (origin/HEAD -> master/main).
        if (requireExactBaseBranch) {
            const fallbackBranch = await this.findDefaultBranch(repoDir);
            if (fallbackBranch) {
                const switched = await this.switchToBranch(repoDir, fallbackBranch);
                if (switched) {
                    const pulled = await this.execCmd(`git pull origin ${fallbackBranch}`, repoDir);
                    if (pulled) {
                        this.logGit(`基线回退：指定 ${baseBranch} 不可用，改用远程分支 ${fallbackBranch}`);
                        this.markLocalBaseFallback(`指定=${baseBranch} -> 使用=${fallbackBranch}`);
                        return { success: true, baseBranch: fallbackBranch };
                    }
                }
            }
            // If remote has zero branches (e.g. empty remote repo but local has orphan commits),
            // succeed with the local state — the user can push later when the remote is ready.
            const anyRemote = await this.execCmdOutput('git branch -r', repoDir);
            if (!anyRemote.success || !(anyRemote.stdout || '').trim()) {
                this.logGit(`远程无任何分支可用，使用本地分支 ${baseBranch} 继续`);
                this.markLocalBaseFallback(`远程仓库无分支，使用本地分支`);
                return { success: true, baseBranch };
            }
            this.lastExecError = this.withExecError(`指定基线分支不可用: ${baseBranch}`);
        }

        return { success: false };
    }

    /**
     * Returns true when the repo has no commits at all (empty clone).
     */
    private async isEmptyRepo(repoDir: string): Promise<boolean> {
        const result = await this.execCmdOutput('git rev-parse HEAD', repoDir);
        // In an empty repo, rev-parse HEAD fails with "fatal: bad default revision 'HEAD'"
        return !result.success;
    }

    private async findDefaultBranch(repoDir: string): Promise<string | null> {
        // One call to list all remote branches; parse everything from it.
        const allRemote = await this.execCmdOutput('git branch -r', repoDir);
        if (allRemote.success && allRemote.stdout.trim()) {
            const lines = allRemote.stdout.split('\n').map(l => l.trim()).filter(Boolean);
            // 1. Honour origin/HEAD symbolic pointer when set.
            for (const line of lines) {
                const match = /origin\/HEAD\s*->\s*origin\/(\S+)/.exec(line);
                if (match) {
                    return match[1];
                }
            }
            // 2. Try well-known default branch names.
            const branchNames = lines
                .filter(l => !l.startsWith('origin/HEAD'))
                .map(l => l.replace(/^origin\//, ''));
            for (const candidate of ['master', 'main']) {
                if (branchNames.includes(candidate)) {
                    return candidate;
                }
            }
            // 3. Last resort: use the first available remote branch.
            return branchNames[0] || null;
        }

        // Fallback: local tracking refs absent (e.g., legacy git-init setup) — query the remote
        // directly via ls-remote so we can still find a usable baseline.
        this.logGit('git branch -r 返回空，尝试 git ls-remote --heads origin 直接查询远端');
        const lsRemote = await this.execCmdOutput('git ls-remote --heads origin', repoDir);
        if (lsRemote.success && lsRemote.stdout.trim()) {
            const branchNames = lsRemote.stdout.split('\n')
                .map(l => { const m = /refs\/heads\/(\S+)$/.exec(l.trim()); return m ? m[1] : null; })
                .filter((b): b is string => Boolean(b));
            for (const candidate of ['master', 'main']) {
                if (branchNames.includes(candidate)) {
                    return candidate;
                }
            }
            return branchNames[0] || null;
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
        // Parse origin/HEAD symbolic pointer from the remote-tracking branch list.
        const allRemote = await this.execCmdOutput('git branch -r', repoDir);
        if (!allRemote.success || !allRemote.stdout.trim()) {
            return null;
        }
        for (const line of allRemote.stdout.split('\n')) {
            const match = /origin\/HEAD\s*->\s*origin\/(\S+)/.exec(line.trim());
            if (match) {
                return match[1];
            }
        }
        return null;
    }

    private async switchToBranch(repoDir: string, branch: string): Promise<boolean> {
        const localList = await this.execCmdOutput(`git branch --list ${branch}`, repoDir);
        const localExists = localList.success && Boolean((localList.stdout || '').trim());
        if (localExists) {
            return this.execCmd(`git checkout ${branch}`, repoDir);
        }

        const remoteList = await this.execCmdOutput(`git branch -r --list origin/${branch}`, repoDir);
        const remoteExists = remoteList.success && Boolean((remoteList.stdout || '').trim());
        if (!remoteExists) {
            return false;
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

    /**
     * Async directory removal with OS-shell fallback for Windows file-lock situations.
     * Uses fs.rmSync first; if the directory still exists afterwards, falls back to
     * `cmd /c rd /s /q` (Windows) or `rm -rf` (Unix) via the shell.
     */
    private async forceRemoveDirAsync(dirPath: string): Promise<void> {
        this.safeRemovePath(dirPath, { recursive: true });
        if (!fs.existsSync(dirPath)) {
            return;
        }
        this.logGit(`safeRemovePath 未能删除 ${dirPath}，尝试 shell 强制删除`);
        if (process.platform === 'win32') {
            await this.execCmd(`cmd /c rd /s /q "${dirPath}"`, path.dirname(dirPath));
        } else {
            await this.execCmd(`rm -rf "${dirPath}"`, path.dirname(dirPath));
        }
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

    /**
     * Run `git add` while tolerating the non-zero exit that some Git versions produce
     * when the working tree contains paths ignored by .gitignore.  The actual staging still
     * succeeds for all non-ignored files; the exit code is misleading.
     */
    private async execGitAddTolerant(cwd: string): Promise<boolean> {
        const result = await this.execCmdOutput('git add . -- ":(exclude).harness"', cwd);
        if (result.success) {
            return true;
        }
        // Git exits non-zero when it encounters ignored paths – treat as success.
        if (/ignored by one of your \.gitignore/i.test(result.stderr)) {
            this.logGit(`WARN (tolerated ignored-file warning) [${cwd}] git add\n  stderr: ${result.stderr.trim()}`);
            return true;
        }
        return false;
    }

    /** Default timeout (ms) for network git operations (clone / fetch / push). */
    private static readonly NETWORK_TIMEOUT_MS = 180_000;
    /** Default timeout (ms) for fast local git operations. */
    private static readonly LOCAL_TIMEOUT_MS = 30_000;

    private static isNetworkCmd(cmd: string): boolean {
        return /\b(clone|fetch|pull|push|ls-remote)\b/.test(cmd);
    }

    private static gitEnv(): NodeJS.ProcessEnv {
        // Prevent git from blocking on interactive credential prompts in a headless process.
        return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
    }

    private async execCmd(cmd: string, cwd: string): Promise<boolean> {
        const timeout = GitService.isNetworkCmd(cmd)
            ? GitService.NETWORK_TIMEOUT_MS
            : GitService.LOCAL_TIMEOUT_MS;
        return new Promise((resolve) => {
            exec(cmd, { cwd, timeout, env: GitService.gitEnv() }, (err, stdout, stderr) => {
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
        const timeout = GitService.isNetworkCmd(cmd)
            ? GitService.NETWORK_TIMEOUT_MS
            : GitService.LOCAL_TIMEOUT_MS;
        return new Promise((resolve) => {
            exec(cmd, { cwd, timeout, env: GitService.gitEnv() }, (err, stdout, stderr) => {
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
