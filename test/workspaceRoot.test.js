const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveHarnessWorkspaceRoot } = require('../out/workspaceRoot.js');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fun-harness-root-'));
}

test('resolveHarnessWorkspaceRoot keeps opened workspace when no harness root markers exist', () => {
    const openedWorkspacePath = makeTempDir();

    const resolved = resolveHarnessWorkspaceRoot(openedWorkspacePath);

    assert.equal(resolved.workspaceRoot, openedWorkspacePath);
    assert.equal(resolved.detectedProjectRoot, false);
});

test('resolveHarnessWorkspaceRoot walks up to nearest harness project root', () => {
    const rootDir = makeTempDir();
    const nestedDir = path.join(rootDir, 'worktrees', 'feature-a');
    fs.mkdirSync(path.join(rootDir, 'repos'), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    const resolved = resolveHarnessWorkspaceRoot(nestedDir);

    assert.equal(resolved.workspaceRoot, rootDir);
    assert.equal(resolved.detectedProjectRoot, true);
});