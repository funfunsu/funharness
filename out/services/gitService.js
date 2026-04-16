"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
class GitService {
    constructor(config, workspaceRoot = '') {
        this.lastExecError = '';
        this.config = config;
        this.workspaceRoot = workspaceRoot;
    }
    setConfig(config) {
        this.config = config;
    }
    setWorkspaceRoot(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }
    async createIterationBranches(task, iterationDir) {
        this.lastExecError = '';
        const branchName = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        const explicitBaseBranch = (this.config.baseSyncBranch || '').trim();
        const baseBranch = (explicitBaseBranch || this.config.mergeTargetBranch || 'main').trim();
        const requireExactBaseBranch = Boolean(explicitBaseBranch);
        const mergeTargetBranchUsed = (this.config.mergeTargetBranch || '').trim();
        let resolvedBaseBranch = baseBranch;
        if (!branchName || branchName.length < 2) {
            return { success: false, message: '迭代名称必须使用英文' };
        }
        if (!this.config.frontendGit && !this.config.backendGit) {
            return { success: false, message: '请先在高级设置配置至少一个 Git 地址' };
        }
        const expectedWorktrees = [];
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
            mergeTargetBranchUsed,
        };
    }
    getMainRepoDir(kind) {
        return path.join(this.workspaceRoot, 'repos', `${kind}-main`);
    }
    buildCommitMessage(task) {
        const raw = (task.desc || task.name || 'update').trim();
        const normalized = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        const truncated = normalized.length > 120 ? normalized.slice(0, 120).trim() : normalized;
        return truncated.replace(/"/g, '\\"') || 'update';
    }
    async ensureMainRepo(remote, repoDir, baseBranch, requireExactBaseBranch) {
        if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
            fs.mkdirSync(path.dirname(repoDir), { recursive: true });
            const cloned = await this.execCmd(`git clone ${remote} "${repoDir}"`, this.workspaceRoot || path.dirname(repoDir));
            if (!cloned) {
                return { success: false };
            }
        }
        return this.checkoutAndPullBase(repoDir, baseBranch, requireExactBaseBranch);
    }
    async prepareWorktree(mainRepoDir, worktreeDir, branchName, baseBranch) {
        if (fs.existsSync(worktreeDir)) {
            const removed = await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
            if (!removed) {
                // When git does not recognize this path as a worktree, treat it as stale folder and continue.
                if (!/not a working tree/i.test(this.lastExecError || '')) {
                    return false;
                }
            }
            fs.rmSync(worktreeDir, { recursive: true, force: true });
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
    async pushAll(task, iterationDir) {
        const failures = [];
        const commitMessage = this.buildCommitMessage(task);
        if (this.config.frontendGit) {
            const frontendDir = path.join(iterationDir, 'frontend');
            const frontendError = await this.pushRepoChanges('frontend', frontendDir, commitMessage);
            if (frontendError) {
                failures.push({ repo: 'frontend', reason: frontendError });
            }
        }
        if (this.config.backendGit) {
            const backendDir = path.join(iterationDir, 'backend');
            const backendError = await this.pushRepoChanges('backend', backendDir, commitMessage);
            if (backendError) {
                failures.push({ repo: 'backend', reason: backendError });
            }
        }
        if (failures.length > 0) {
            const detail = failures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return { success: false, message: `推送失败：\n${detail}` };
        }
        return { success: true, message: '✅ 代码已全部推送' };
    }
    async pushRepoChanges(repoName, repoDir, commitMessage) {
        if (!fs.existsSync(repoDir)) {
            return `目录不存在: ${repoDir}`;
        }
        // Use -A to stage tracked changes plus newly created files.
        const addCmd = await this.execCmd('git add -A', repoDir);
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
    async syncMainCode(task, iterationDir) {
        const baseBranch = (task.baseSyncBranchUsed || this.config.baseSyncBranch || this.config.mergeTargetBranch || 'main').trim();
        const failures = [];
        if (this.config.frontendGit) {
            const mainDir = this.getMainRepoDir('frontend');
            const worktreeDir = path.join(iterationDir, 'frontend');
            const result = await this.syncRepoToWorktree(mainDir, worktreeDir, baseBranch);
            if (!result.ok) {
                failures.push({ repo: 'frontend', reason: result.reason || '未知' });
            }
        }
        if (this.config.backendGit) {
            const mainDir = this.getMainRepoDir('backend');
            const worktreeDir = path.join(iterationDir, 'backend');
            const result = await this.syncRepoToWorktree(mainDir, worktreeDir, baseBranch);
            if (!result.ok) {
                failures.push({ repo: 'backend', reason: result.reason || '未知' });
            }
        }
        if (failures.length > 0) {
            const detail = failures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return { success: false, message: `同步失败：\n${detail}` };
        }
        return { success: true, message: `✅ 已同步主仓库最新代码（${baseBranch}）到当前 worktree` };
    }
    async syncRepoToWorktree(mainRepoDir, worktreeDir, baseBranch) {
        if (!fs.existsSync(mainRepoDir)) {
            return { ok: false, reason: `主仓库目录不存在：${mainRepoDir}` };
        }
        if (!fs.existsSync(worktreeDir)) {
            return { ok: false, reason: `worktree 目录不存在：${worktreeDir}` };
        }
        const fetched = await this.execCmd('git fetch origin', mainRepoDir);
        if (!fetched) {
            return { ok: false, reason: `fetch 失败：${this.lastExecError}` };
        }
        await this.execCmd(`git pull origin ${baseBranch}`, mainRepoDir);
        const merged = await this.execCmd(`git merge origin/${baseBranch} --no-edit`, worktreeDir);
        if (!merged) {
            return { ok: false, reason: `合并主分支代码失败（可能有冲突）：${this.lastExecError}` };
        }
        return { ok: true };
    }
    async mergeIterationToTarget(task, iterationDir) {
        const target = (this.config.mergeTargetBranch || '').trim();
        if (!target) {
            return { success: true, message: '未配置个人合并分支，跳过自动合并' };
        }
        const sourceBranch = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        if (!sourceBranch) {
            return { success: false, message: '无法识别迭代分支名' };
        }
        const failures = [];
        if (this.config.frontendGit) {
            // Merge must happen in the main repo, not the worktree dir.
            // A worktree is locked to its iteration branch; switching branches there is rejected by git.
            const frontendMainDir = this.getMainRepoDir('frontend');
            const result = await this.mergeRepoBranch(frontendMainDir, sourceBranch, target);
            if (!result.ok) {
                failures.push({ repo: 'frontend', reason: result.reason || '未知错误' });
            }
        }
        if (this.config.backendGit) {
            const backendMainDir = this.getMainRepoDir('backend');
            const result = await this.mergeRepoBranch(backendMainDir, sourceBranch, target);
            if (!result.ok) {
                failures.push({ repo: 'backend', reason: result.reason || '未知错误' });
            }
        }
        if (failures.length > 0) {
            const detail = failures
                .map(f => `[${f.repo}] ${f.reason}`)
                .join('\n');
            return { success: false, message: `自动合并失败：\n${detail}` };
        }
        const cleanupFailures = [];
        if (this.config.frontendGit) {
            const frontendMainDir = this.getMainRepoDir('frontend');
            const frontendWorktreeDir = path.join(iterationDir, 'frontend');
            const cleanup = await this.cleanupMergedBranch(frontendMainDir, frontendWorktreeDir, sourceBranch);
            if (!cleanup.ok) {
                cleanupFailures.push({ repo: 'frontend', reason: cleanup.reason || '未知错误' });
            }
        }
        if (this.config.backendGit) {
            const backendMainDir = this.getMainRepoDir('backend');
            const backendWorktreeDir = path.join(iterationDir, 'backend');
            const cleanup = await this.cleanupMergedBranch(backendMainDir, backendWorktreeDir, sourceBranch);
            if (!cleanup.ok) {
                cleanupFailures.push({ repo: 'backend', reason: cleanup.reason || '未知错误' });
            }
        }
        if (cleanupFailures.length > 0) {
            const detail = cleanupFailures.map(f => `[${f.repo}] ${f.reason}`).join('\n');
            return { success: true, message: `已自动合并到个人分支 ${target}，但分支清理未完全成功：\n${detail}` };
        }
        return { success: true, message: `已自动合并到个人分支 ${target}，并已删除迭代分支 ${sourceBranch}` };
    }
    async mergeRepoBranch(repoDir, sourceBranch, targetBranch) {
        if (!fs.existsSync(repoDir)) {
            return { ok: false, reason: `目录不存在：${repoDir}` };
        }
        await this.execCmd('git fetch origin', repoDir);
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
                }
                else {
                    const createLocal = await this.execCmd(`git checkout -b ${targetBranch}`, repoDir);
                    if (!createLocal) {
                        return { ok: false, reason: `无法切换到目标分支 ${targetBranch}：${this.lastExecError}` };
                    }
                }
            }
        }
        await this.execCmd(`git pull origin ${targetBranch}`, repoDir);
        if (this.config.mergeDryRunEnabled) {
            const dryRunOk = await this.execCmd(`git merge --no-commit --no-ff ${sourceBranch}`, repoDir);
            if (!dryRunOk) {
                const dryRunError = this.lastExecError;
                await this.execCmd('git merge --abort', repoDir);
                return { ok: false, reason: `干运行冲突检测失败（与 ${targetBranch} 有冲突），请手动解决：${dryRunError}` };
            }
            await this.execCmd('git merge --abort', repoDir);
        }
        const merged = await this.execCmd(`git merge --no-ff ${sourceBranch} -m "chore: merge ${sourceBranch} into ${targetBranch}"`, repoDir);
        if (!merged) {
            return { ok: false, reason: `合并命令执行失败：${this.lastExecError}` };
        }
        const pushed = await this.execCmd(`git push origin ${targetBranch}`, repoDir);
        if (!pushed) {
            return { ok: false, reason: `push 到 ${targetBranch} 失败：${this.lastExecError}` };
        }
        return { ok: true };
    }
    async cleanupMergedBranch(mainRepoDir, worktreeDir, sourceBranch) {
        if (!fs.existsSync(mainRepoDir)) {
            return { ok: false, reason: `主仓库目录不存在：${mainRepoDir}` };
        }
        const registered = await this.hasRegisteredWorktreeAtPath(mainRepoDir, worktreeDir);
        if (registered) {
            const removed = await this.execCmd(`git worktree remove --force "${worktreeDir}"`, mainRepoDir);
            if (!removed) {
                return { ok: false, reason: `移除 worktree 失败：${this.lastExecError}` };
            }
        }
        const deletedLocal = await this.execCmd(`git branch -d ${sourceBranch}`, mainRepoDir);
        if (!deletedLocal) {
            if (!/not found|unknown branch|does not exist/i.test(this.lastExecError)) {
                return { ok: false, reason: `删除本地分支失败：${this.lastExecError}` };
            }
        }
        const deletedRemote = await this.execCmd(`git push origin --delete ${sourceBranch}`, mainRepoDir);
        if (!deletedRemote) {
            if (!/remote ref does not exist|not found|unable to delete/i.test(this.lastExecError)) {
                return { ok: false, reason: `删除远程分支失败：${this.lastExecError}` };
            }
        }
        return { ok: true };
    }
    async checkoutAndPullBase(repoDir, baseBranch, requireExactBaseBranch) {
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
        if (requireExactBaseBranch) {
            this.lastExecError = this.withExecError(`指定基线分支不可用: ${baseBranch}`);
        }
        return { success: false };
    }
    async buildBaseBranchCandidates(repoDir, preferred) {
        const list = [];
        const pushUnique = (name) => {
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
    async resolveRemoteDefaultBranch(repoDir) {
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
    async switchToBranch(repoDir, branch) {
        const checkout = await this.execCmd(`git checkout ${branch}`, repoDir);
        if (checkout) {
            return true;
        }
        return this.execCmd(`git checkout -b ${branch} origin/${branch}`, repoDir);
    }
    hasGitWorktree(worktreeDir) {
        return fs.existsSync(worktreeDir) && fs.existsSync(path.join(worktreeDir, '.git'));
    }
    async hasRegisteredWorktreeAtPath(mainRepoDir, worktreeDir) {
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
    extractAlreadyCheckedOutPath(errorText) {
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
    isSamePath(left, right) {
        return this.normalizePath(left) === this.normalizePath(right);
    }
    normalizePath(input) {
        return (input || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .toLowerCase();
    }
    withExecError(prefix) {
        if (!this.lastExecError) {
            return prefix;
        }
        return `${prefix}；${this.lastExecError}`;
    }
    async execCmd(cmd, cwd) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(cmd, { cwd }, (err, _stdout, stderr) => {
                if (err) {
                    const stderrText = (stderr || '').toString().trim();
                    this.lastExecError = `命令失败: ${cmd} | 目录: ${cwd}${stderrText ? ` | 错误: ${stderrText}` : ''}`;
                    console.error(`EXEC ERROR: ${this.lastExecError}`);
                }
                else {
                    this.lastExecError = '';
                }
                resolve(!err);
            });
        });
    }
    async execCmdOutput(cmd, cwd) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(cmd, { cwd }, (err, stdout, stderr) => {
                const out = (stdout || '').toString();
                const errText = (stderr || '').toString();
                if (err) {
                    const compactErr = errText.trim();
                    this.lastExecError = `命令失败: ${cmd} | 目录: ${cwd}${compactErr ? ` | 错误: ${compactErr}` : ''}`;
                    resolve({ success: false, stdout: out, stderr: errText });
                    return;
                }
                resolve({ success: true, stdout: out, stderr: errText });
            });
        });
    }
}
exports.GitService = GitService;
//# sourceMappingURL=gitService.js.map