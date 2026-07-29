'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveHarnessWorkspaceRoot } = require('../out/workspaceRoot');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-root-resolve-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore best-effort cleanup failures in tests
    }
}

describe('resolveHarnessWorkspaceRoot', () => {
    test('returns master root when opening a normal subfolder under project root', () => {
        const root = makeTempDir();
        try {
            fs.mkdirSync(path.join(root, 'worktrees'), { recursive: true });
            const nested = path.join(root, 'apps', 'src');
            fs.mkdirSync(nested, { recursive: true });

            const resolved = resolveHarnessWorkspaceRoot(nested);
            assert.equal(resolved.workspaceRoot, root);
            assert.equal(resolved.detectedProjectRoot, true);
        } finally {
            cleanup(root);
        }
    });

    test('keeps opened worktree root instead of climbing to master root', () => {
        const root = makeTempDir();
        try {
            fs.mkdirSync(path.join(root, 'worktrees'), { recursive: true });
            const worktreeRoot = path.join(root, 'worktrees', 'task-a');
            fs.mkdirSync(worktreeRoot, { recursive: true });

            const resolved = resolveHarnessWorkspaceRoot(worktreeRoot);
            assert.equal(resolved.workspaceRoot, worktreeRoot);
            assert.equal(resolved.detectedProjectRoot, false);
        } finally {
            cleanup(root);
        }
    });

    test('normalizes nested paths opened inside a worktree back to that worktree root', () => {
        const root = makeTempDir();
        try {
            fs.mkdirSync(path.join(root, 'worktrees'), { recursive: true });
            const worktreeRoot = path.join(root, 'worktrees', 'task-b');
            const nested = path.join(worktreeRoot, 'apps', 'src');
            fs.mkdirSync(nested, { recursive: true });

            const resolved = resolveHarnessWorkspaceRoot(nested);
            assert.equal(resolved.workspaceRoot, worktreeRoot);
            assert.equal(resolved.detectedProjectRoot, true);
        } finally {
            cleanup(root);
        }
    });
});
