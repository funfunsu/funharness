'use strict';

/**
 * workspaceRoot 解析回归覆盖基线。
 *
 * 覆盖场景：
 * 1. 从普通项目子目录打开时，应向上解析回主工作区根目录。
 * 2. 从 worktree 根目录打开时，不应误回退到 master root。
 * 3. 从 worktree 内部更深层目录打开时，应归一化回当前 worktree 根，而不是跨出 worktree。
 *
 * 这组测试守护的是“主仓库与迭代 worktree 的边界解析稳定，不因打开位置不同而串根目录”。
 */

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

describe('workspaceRoot 解析覆盖基线', () => {
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

    test('worktree snapshot config keeps aiQuickChatButtons readable without crossing the worktree boundary', () => {
        const root = makeTempDir();
        try {
            const worktreeRoot = path.join(root, 'worktrees', 'task-c');
            const cfgDir = path.join(worktreeRoot, '.harness');
            fs.mkdirSync(cfgDir, { recursive: true });
            fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
                aiQuickChatButtons: [{ id: 'aqc_1', label: '回顾', content: '请回顾本次修改', order: 0 }],
                customButtons: [],
            }, null, 2), 'utf8');

            const resolved = resolveHarnessWorkspaceRoot(worktreeRoot);
            const raw = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
            assert.equal(resolved.workspaceRoot, worktreeRoot);
            assert.equal(raw.aiQuickChatButtons[0].content, '请回顾本次修改');
        } finally {
            cleanup(root);
        }
    });
});
