const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GitService } = require('../out/services/gitService.js');
const { TaskStoreService } = require('../out/services/taskStoreService.js');

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const baseConfig = {
  frontendGit: '',
  backendGit: '',
  monorepoGit: '',
  monorepoDirs: { frontend: 'apps', backend: 'apps', docs: 'docs', scripts: 'scripts' },
  baseBranch: '',
  mergeDryRunEnabled: true,
};

test('createIterationBranches in monorepo mode creates a single worktree at the iteration dir root', async () => {
  const root = tempRoot('mono-create-');
  const iterationDir = path.join(root, 'worktrees', 'my-task');
  fs.mkdirSync(iterationDir, { recursive: true });

  const git = new GitService(
    { ...baseConfig, monorepoGit: 'https://example.com/mono.git' },
    root,
  );

  const prepared = [];
  git.ensureMainRepo = async () => ({ success: true, baseBranch: 'main' });
  git.prepareWorktree = async (mainDir, worktreeDir, branch, base) => {
    prepared.push({ mainDir, worktreeDir, branch, base });
    return true;
  };
  git.hasGitWorktree = () => true;

  const result = await git.createIterationBranches(
    { id: 't', name: 'my-task', desc: 'd', stage: 'x' },
    iterationDir,
  );

  assert.equal(result.success, true);
  assert.equal(prepared.length, 1, 'monorepo should prepare exactly one worktree');
  assert.equal(prepared[0].worktreeDir, iterationDir, 'worktree must be the iteration dir root, not a subfolder');
  assert.equal(prepared[0].mainDir, path.join(root, 'repos', 'mono-main'), 'monorepo main repo is the dedicated clone at repos/mono-main');
  assert.equal(result.iterationBranch, 'my-task');

  fs.rmSync(root, { recursive: true, force: true });
});

test('createIterationBranches in multi-repo mode still creates frontend and backend worktrees', async () => {
  const root = tempRoot('multi-create-');
  const iterationDir = path.join(root, 'worktrees', 'my-task');
  fs.mkdirSync(iterationDir, { recursive: true });

  const git = new GitService(
    { ...baseConfig, frontendGit: 'https://example.com/fe.git', backendGit: 'https://example.com/be.git' },
    root,
  );

  const prepared = [];
  git.ensureMainRepo = async () => ({ success: true, baseBranch: 'main' });
  git.prepareWorktree = async (mainDir, worktreeDir, branch, base) => {
    prepared.push({ mainDir, worktreeDir });
    return true;
  };
  git.hasGitWorktree = () => true;

  const result = await git.createIterationBranches(
    { id: 't', name: 'my-task', desc: 'd', stage: 'x' },
    iterationDir,
  );

  assert.equal(result.success, true);
  assert.equal(prepared.length, 2, 'multi-repo should prepare two worktrees');
  assert.equal(prepared[0].worktreeDir, path.join(iterationDir, 'frontend'));
  assert.equal(prepared[1].worktreeDir, path.join(iterationDir, 'backend'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('pushAll in monorepo mode pushes once from the iteration dir root', async () => {
  const root = tempRoot('mono-push-');
  const iterationDir = path.join(root, 'worktrees', 'my-task');
  fs.mkdirSync(iterationDir, { recursive: true });

  const git = new GitService(
    { ...baseConfig, monorepoGit: 'https://example.com/mono.git' },
    root,
  );

  const commands = [];
  git.execCmd = async (cmd, cwd) => { commands.push({ cmd, cwd }); return true; };
  git.execCmdOutput = async (cmd, cwd) => { commands.push({ cmd, cwd }); return { success: true, stdout: '', stderr: '' }; };

  const result = await git.pushAll(
    { id: 't', name: 'my-task', desc: 'demo', stage: 'x' },
    iterationDir,
  );

  assert.equal(result.success, true);
  const pushes = commands.filter((c) => c.cmd === 'git push origin HEAD');
  assert.equal(pushes.length, 1, 'monorepo should push exactly once');
  assert.equal(pushes[0].cwd, iterationDir, 'push must run from the iteration dir root');

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadConfig backfills monorepo defaults for a legacy config without monorepo fields', () => {
  const root = tempRoot('mono-config-');
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'config.json'),
    JSON.stringify({ frontendGit: 'https://example.com/fe.git', backendGit: '' }),
    'utf8',
  );

  const store = new TaskStoreService(root);
  const config = store.loadConfig();

  assert.equal(config.monorepoGit, '');
  assert.equal(config.monorepoDirs.frontend, 'apps');
  assert.equal(config.monorepoDirs.backend, 'apps');
  assert.equal(config.monorepoDirs.docs, 'docs');
  assert.equal(config.monorepoDirs.scripts, 'scripts');

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadConfig deep-merges a partial monorepoDirs with defaults', () => {
  const root = tempRoot('mono-config-partial-');
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'config.json'),
    JSON.stringify({ monorepoGit: 'https://example.com/mono.git', monorepoDirs: { backend: 'server' } }),
    'utf8',
  );

  const store = new TaskStoreService(root);
  const config = store.loadConfig();

  assert.equal(config.monorepoDirs.backend, 'server', 'custom subdir preserved');
  assert.equal(config.monorepoDirs.frontend, 'apps', 'missing subdir falls back to default');

  fs.rmSync(root, { recursive: true, force: true });
});

test('initializeRepos in monorepo mode creates the default apps/docs/scripts scaffold in the main repo', async () => {
  const root = tempRoot('mono-init-scaffold-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });

  const git = new GitService(
    { ...baseConfig, monorepoGit: 'https://example.com/mono.git' },
    root,
  );

  git.ensureMainRepo = async () => ({ success: true, baseBranch: 'main' });

  const result = await git.initializeRepos();

  const mainRepo = path.join(root, 'repos', 'mono-main');
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(path.join(mainRepo, 'apps')), true);
  assert.equal(fs.existsSync(path.join(mainRepo, 'docs')), true);
  assert.equal(fs.existsSync(path.join(mainRepo, 'scripts')), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('createIterationBranches in monorepo mode creates the default apps/docs/scripts scaffold in the worktree', async () => {
  const root = tempRoot('mono-worktree-scaffold-');
  const iterationDir = path.join(root, 'worktrees', 'my-task');
  fs.mkdirSync(iterationDir, { recursive: true });

  const git = new GitService(
    { ...baseConfig, monorepoGit: 'https://example.com/mono.git' },
    root,
  );

  git.ensureMainRepo = async () => ({ success: true, baseBranch: 'main' });
  git.prepareWorktree = async () => true;
  git.hasGitWorktree = () => true;

  const result = await git.createIterationBranches(
    { id: 't', name: 'my-task', desc: 'd', stage: 'x' },
    iterationDir,
  );

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'apps')), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'docs')), true);
  assert.equal(fs.existsSync(path.join(iterationDir, 'scripts')), true);

  fs.rmSync(root, { recursive: true, force: true });
});
