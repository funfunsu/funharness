const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GitService } = require('../out/services/gitService.js');

test('GitService.createIterationBranches fails when explicit baseSyncBranch cannot be prepared', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-base-branch-test-'));
  const service = new GitService(
    {
      frontendGit: 'https://example.com/frontend.git',
      backendGit: '',
      mergeTargetBranch: 'my-target',
      baseSyncBranch: 'release/2026.04',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const calls = [];
  service.ensureMainRepo = async (_remote, _repoDir, baseBranch, requireExactBaseBranch) => {
    calls.push({ baseBranch, requireExactBaseBranch });
    return { success: false };
  };

  const result = await service.createIterationBranches(
    { id: 'task_1', name: 'demo-feature', desc: 'demo', stage: '⌛ 初始化中' },
    path.join(tempRoot, 'worktrees', 'demo-feature'),
  );

  assert.equal(result.success, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseBranch, 'release/2026.04');
  assert.equal(calls[0].requireExactBaseBranch, true);
  assert.match(result.message || '', /release\/2026\.04/);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.syncMainCode uses task baseSyncBranchUsed before global config', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-branch-test-'));
  const iterationDir = path.join(tempRoot, 'worktrees', 'demo-feature');
  fs.mkdirSync(path.join(iterationDir, 'frontend'), { recursive: true });

  const service = new GitService(
    {
      frontendGit: 'https://example.com/frontend.git',
      backendGit: '',
      mergeTargetBranch: 'target-branch',
      baseSyncBranch: 'config-branch',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  let usedBranch = '';
  service.syncRepoToWorktree = async (_mainRepoDir, _worktreeDir, baseBranch) => {
    usedBranch = baseBranch;
    return { ok: true };
  };

  const result = await service.syncMainCode(
    {
      id: 'task_2',
      name: 'demo-feature',
      desc: 'demo',
      stage: '⚙️ 开发中',
      baseSyncBranchUsed: 'task-recorded-branch',
    },
    iterationDir,
  );

  assert.equal(result.success, true);
  assert.equal(usedBranch, 'task-recorded-branch');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
