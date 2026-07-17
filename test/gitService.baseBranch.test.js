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
      baseBranch: 'release/2026.04',
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
    { id: 'task_1', name: 'demo-feature', desc: 'demo', stage: 'initializing' },
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
      baseBranch: 'config-branch',
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
      stage: 'developing',
      baseBranchUsed: 'task-recorded-branch',
    },
    iterationDir,
  );

  assert.equal(result.success, true);
  assert.equal(usedBranch, 'task-recorded-branch');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.initializeRepos does not require exact base branch during settings save', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-init-base-branch-test-'));
  const service = new GitService(
    {
      frontendGit: '',
      backendGit: '',
      monorepoGit: 'https://example.com/mono.git',
      baseBranch: 'sue-dev',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const calls = [];
  service.ensureMainRepo = async (_remote, _repoDir, baseBranch, requireExactBaseBranch) => {
    calls.push({ baseBranch, requireExactBaseBranch });
    return { success: true, baseBranch: 'main' };
  };

  const result = await service.initializeRepos();

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseBranch, 'sue-dev');
  assert.equal(calls[0].requireExactBaseBranch, false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.checkoutAndPullBase falls back to remote master/main when preferred branch is absent (non-exact mode)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-remote-fallback-non-exact-test-'));
  const service = new GitService(
    {
      frontendGit: '',
      backendGit: '',
      monorepoGit: 'https://example.com/mono.git',
      baseBranch: 'sue-dev',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const executed = [];
  service.execCmd = async (cmd) => {
    executed.push(cmd);
    if (cmd === 'git fetch origin') return true;
    if (cmd === 'git checkout -b master origin/master') return true;
    if (cmd === 'git pull origin master') return true;
    return false;
  };

  service.execCmdOutput = async (cmd) => {
    if (cmd === 'git rev-parse HEAD') {
      return { success: true, stdout: 'abc123\n', stderr: '' };
    }
    if (cmd === 'git branch -r') {
      // resolveRemoteDefaultBranch + findDefaultBranch both call this
      return { success: true, stdout: '  origin/master\n', stderr: '' };
    }
    if (cmd === 'git branch -r --list origin/master') {
      // switchToBranch remote-existence probe
      return { success: true, stdout: '  origin/master\n', stderr: '' };
    }
    if (cmd.startsWith('git branch --list ') || cmd.startsWith('git branch -r --list ')) {
      return { success: true, stdout: '', stderr: '' };
    }
    return { success: false, stdout: '', stderr: '' };
  };

  const result = await service.checkoutAndPullBase(tempRoot, 'sue-dev', false);

  assert.equal(result.success, true);
  assert.equal(result.baseBranch, 'master');
  assert.equal(executed.includes('git checkout -b master origin/master'), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.checkoutAndPullBase falls back to remote master/main when exact base branch is unavailable', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-exact-remote-fallback-test-'));
  const service = new GitService(
    {
      frontendGit: '',
      backendGit: '',
      monorepoGit: 'https://example.com/mono.git',
      baseBranch: 'sue-dev',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const executed = [];
  service.execCmd = async (cmd) => {
    executed.push(cmd);
    if (cmd === 'git fetch origin') return true;
    if (cmd === 'git checkout -b master origin/master') return true;
    if (cmd === 'git pull origin master') return true;
    if (cmd === 'git pull origin sue-dev') return false;
    return false;
  };

  service.execCmdOutput = async (cmd) => {
    if (cmd === 'git rev-parse HEAD') {
      return { success: true, stdout: 'abc123\n', stderr: '' };
    }
    if (cmd === 'git branch -r') {
      // used by findDefaultBranch and resolveRemoteDefaultBranch
      return { success: true, stdout: '  origin/master\n', stderr: '' };
    }
    if (cmd === 'git branch -r --list origin/master') {
      // used by switchToBranch remote-existence probe
      return { success: true, stdout: '  origin/master\n', stderr: '' };
    }
    if (cmd === 'git branch --list sue-dev') {
      return { success: true, stdout: '', stderr: '' };
    }
    if (cmd.startsWith('git branch --list ') || cmd.startsWith('git branch -r --list ')) {
      return { success: true, stdout: '', stderr: '' };
    }
    return { success: true, stdout: '', stderr: '' };
  };

  const result = await service.checkoutAndPullBase(tempRoot, 'sue-dev', true);

  assert.equal(result.success, true);
  assert.equal(result.baseBranch, 'master');
  assert.equal(executed.includes('git checkout -b master origin/master'), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.syncRepoToWorktree falls back to remote master/main when remote base is absent', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-remote-fallback-test-'));
  const mainRepoDir = path.join(tempRoot, 'repos', 'mono-main');
  const worktreeDir = path.join(tempRoot, 'worktrees', 'demo');
  fs.mkdirSync(mainRepoDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });

  const service = new GitService(
    {
      frontendGit: '',
      backendGit: '',
      monorepoGit: 'https://example.com/mono.git',
      baseBranch: 'sue-dev',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const executed = [];
  service.execCmd = async (cmd) => {
    executed.push(cmd);
    if (cmd === 'git add . -- :(exclude).harness') return true;
    if (cmd === 'git fetch origin') return true;
    if (cmd === 'git merge origin/master --no-edit') return true;
    return false;
  };

  service.execCmdOutput = async (cmd) => {
    if (cmd === 'git status --porcelain') {
      return { success: true, stdout: '', stderr: '' };
    }
    if (cmd === 'git branch -r') {
      return { success: true, stdout: '  origin/master\n', stderr: '' };
    }
    if (cmd === 'git branch -r --list origin/sue-dev') {
      return { success: true, stdout: '', stderr: '' };
    }
    return { success: true, stdout: '', stderr: '' };
  };

  const result = await service.syncRepoToWorktree(mainRepoDir, worktreeDir, 'sue-dev');

  assert.equal(result.ok, true);
  assert.equal(executed.includes('git merge origin/master --no-edit'), true);
  assert.equal(executed.includes('git merge origin/sue-dev --no-edit'), false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.checkoutAndPullBase succeeds for empty repository (no commits)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-empty-repo-test-'));
  const service = new GitService(
    {
      frontendGit: '',
      backendGit: '',
      monorepoGit: 'https://example.com/mono.git',
      baseBranch: 'sue-dev',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  service.execCmd = async (cmd) => {
    if (cmd === 'git fetch origin') return true;
    return false;
  };

  service.execCmdOutput = async (cmd) => {
    if (cmd === 'git rev-parse HEAD') {
      // Empty repo — rev-parse HEAD fails
      return { success: false, stdout: '', stderr: "fatal: bad default revision 'HEAD'" };
    }
    return { success: false, stdout: '', stderr: '' };
  };

  const result = await service.checkoutAndPullBase(tempRoot, 'sue-dev', false);

  assert.equal(result.success, true);
  assert.equal(result.baseBranch, 'sue-dev');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('GitService.checkoutAndPullBase succeeds when local branch exists but remote does not (exact mode)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-local-only-branch-test-'));
  const service = new GitService(
    {
      frontendGit: '',
      backendGit: '',
      monorepoGit: 'https://example.com/mono.git',
      baseBranch: 'sue-dev',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const executed = [];
  service.execCmd = async (cmd) => {
    executed.push(cmd);
    if (cmd === 'git fetch origin') return true;
    if (cmd === 'git checkout sue-dev') return true;
    // git pull origin sue-dev fails — remote doesn't have this branch
    if (cmd === 'git pull origin sue-dev') return false;
    return false;
  };

  service.execCmdOutput = async (cmd) => {
    if (cmd === 'git rev-parse HEAD') {
      return { success: true, stdout: 'abc123\n', stderr: '' };
    }
    // Local branch sue-dev exists (from previous orphan bootstrap)
    if (cmd === 'git branch --list sue-dev') {
      return { success: true, stdout: '  sue-dev\n', stderr: '' };
    }
    // Remote does NOT have sue-dev
    if (cmd === 'git branch -r --list origin/sue-dev') {
      return { success: true, stdout: '', stderr: '' };
    }
    return { success: true, stdout: '', stderr: '' };
  };

  const result = await service.checkoutAndPullBase(tempRoot, 'sue-dev', true);

  assert.equal(result.success, true);
  assert.equal(result.baseBranch, 'sue-dev');
  // Should have checked out locally and accepted it without needing pull
  assert.equal(executed.includes('git checkout sue-dev'), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
