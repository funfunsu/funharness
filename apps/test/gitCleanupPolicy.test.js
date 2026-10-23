'use strict';

/**
 * Git 清理策略覆盖基线。
 *
 * 覆盖场景：
 * 1. READY_FOR_REVIEW 的最终完成链路，在远程已合并后必须保留 worktree 目录。
 * 2. 完成链路应显式把 keepWorktreeDir 传给底层清理函数，防止回归到硬删除目录。
 *
 * 这组测试守护“先温归档、后冷归档”的目录生命周期边界，避免完成即删目录导致温归档失效。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { GitService } = require('../out/services/gitService');
const { DEFAULT_CONFIG, STAGE } = require('../out/models');

describe('Git cleanup warm-archive policy baseline', () => {
    test('cleanupIterationAfterRemoteMerge preserves worktree dir by passing keepWorktreeDir=true', async () => {
        const service = new GitService({
            ...DEFAULT_CONFIG,
            monorepoGit: 'https://example.com/mono.git',
        }, '/tmp/fun-harness');

        const task = {
            id: 'feature-keep-worktree',
            name: 'feature keep worktree',
            desc: 'desc',
            stage: STAGE.READY_FOR_REVIEW,
        };

        const repo = {
            kind: 'mono',
            label: 'mono-main',
            remote: 'https://example.com/mono.git',
            mainDir: '/tmp/main',
            worktreeDir: '/tmp/worktree',
        };

        let capturedOptions;
        service.resolveRepoDescriptors = () => [repo];
        service.cleanupMergedBranch = async (_main, _worktree, _source, _target, options) => {
            capturedOptions = options;
            return { ok: true };
        };

        const result = await service.cleanupIterationAfterRemoteMerge(task, '/tmp/worktree');

        assert.equal(result.success, true);
        assert.equal(result.cleanupComplete, true);
        assert.equal(capturedOptions && capturedOptions.keepWorktreeDir, true);
        assert.match(result.message, /worktree 目录保留/);
    });
});
