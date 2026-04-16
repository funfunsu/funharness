const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GitService } = require('../out/services/gitService.js');

test('GitService.pushAll stages new files with git add -A', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-pushall-test-'));
  const iterationDir = path.join(tempRoot, 'iteration-1');
  const frontendDir = path.join(iterationDir, 'frontend');
  const backendDir = path.join(iterationDir, 'backend');
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.mkdirSync(backendDir, { recursive: true });

  const git = new GitService(
    {
      frontendGit: 'https://example.com/frontend.git',
      backendGit: 'https://example.com/backend.git',
      mergeTargetBranch: 'main',
      baseSyncBranch: 'main',
      mergeDryRunEnabled: true,
    },
    tempRoot,
  );

  const commands = [];
  git.execCmd = async (cmd, cwd) => {
    commands.push({ cmd, cwd });
    return true;
  };
  git.execCmdOutput = async (cmd, cwd) => {
    commands.push({ cmd, cwd });
    return { success: true, stdout: '', stderr: '' };
  };

  const result = await git.pushAll(
    {
      id: 'task_1',
      name: 'demo-task',
      desc: 'demo task',
      stage: '⚙️ 开发中',
    },
    iterationDir,
  );

  assert.equal(result.success, true);

  const frontendAdd = commands.find((item) => item.cmd === 'git add -A' && item.cwd === frontendDir);
  const backendAdd = commands.find((item) => item.cmd === 'git add -A' && item.cwd === backendDir);
  assert.ok(frontendAdd, 'frontend should use git add -A');
  assert.ok(backendAdd, 'backend should use git add -A');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
