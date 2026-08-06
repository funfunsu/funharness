'use strict';

/**
 * FeatureStore / worktree 命名回归覆盖基线。
 *
 * 覆盖场景：
 * 1. 中文任务名必须派生出纯 ASCII 的 branch / worktree 名，避免路径编码问题。
 * 2. 默认命名应优先使用安全英文 worktree 目录，但对已存在的旧中文目录保留兼容回退。
 * 3. 命名前缀、语义 slug 开关、最大长度等配置项必须真实生效。
 * 4. FeatureStoreService 从保存后的 config.json 读取命名配置时，行为必须与命名工具函数一致。
 *
 * 这组测试守护的是“命名策略变更不会破坏已有 worktree 路径解析与兼容回退”。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deriveIterationBranchName, deriveIterationWorktreeName, deriveIterationBranchNameWithOptions, deriveIterationWorktreeNameWithOptions } = require('../out/services/branchName');
const { FeatureStoreService } = require('../out/services/featureStoreService');
const { BASE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-feature-store-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore best-effort cleanup failures in tests
    }
}

describe('worktree 命名覆盖基线', () => {
    test('derives ASCII-safe branch and worktree names for Chinese task titles', () => {
        const task = {
            id: 'task_1001',
            name: '风控系统优化',
            desc: '处理中文路径兼容与构建稳定性',
            stage: 'writing_requirement',
        };

        const branchName = deriveIterationBranchName(task);
        const worktreeName = deriveIterationWorktreeName(task);

        assert.match(branchName, /^task\/[a-z0-9-]+$/);
        assert.match(worktreeName, /^task-[a-z0-9-]+$/);
        assert.ok(!/[^\x00-\x7F]/.test(branchName), 'branch should be ASCII only');
        assert.ok(!/[^\x00-\x7F]/.test(worktreeName), 'worktree name should be ASCII only');
    });

    test('uses English-safe worktree path for new tasks even when legacy folder exists', () => {
        const root = makeTempDir();
        try {
            const service = new FeatureStoreService(root);
            const task = {
                id: 'task_1002',
                name: '目录中文测试',
                desc: 'legacy compatibility',
                stage: 'writing_requirement',
            };

            const defaultPath = service.getIterationDir(task);
            const defaultBase = path.basename(defaultPath);
            assert.match(defaultBase, /^task-[a-z0-9-]+$/);

            const legacyPath = path.join(root, 'worktrees', task.name);
            fs.mkdirSync(legacyPath, { recursive: true });

            const resolvedPath = service.getIterationDir(task);
            assert.notEqual(resolvedPath, legacyPath);
            assert.match(path.basename(resolvedPath), /^task-[a-z0-9-]+$/);
        } finally {
            cleanup(root);
        }
    });

    test('keeps persisted legacy Chinese worktreePath when legacy folder exists', () => {
        const root = makeTempDir();
        try {
            const service = new FeatureStoreService(root);
            const legacyPath = path.join(root, 'worktrees', '指标统计和查询');
            fs.mkdirSync(legacyPath, { recursive: true });

            const task = {
                id: 'task_1003',
                name: '指标统计和查询',
                desc: 'compatibility for already-created legacy directory',
                stage: 'writing_requirement',
                worktreePath: legacyPath,
            };

            const resolved = service.getIterationDir(task);
            assert.equal(resolved, legacyPath);
        } finally {
            cleanup(root);
        }
    });

    test('supports configurable naming prefix and semantic toggle', () => {
        const task = {
            id: 'task_2001',
            name: '统一风控策略中心',
            desc: '仅保留稳定标识',
            stage: 'writing_requirement',
        };

        const branchName = deriveIterationBranchNameWithOptions(task, {
            branchPrefix: 'iter',
            semanticSlug: false,
        });
        const worktreeName = deriveIterationWorktreeNameWithOptions(task, {
            worktreePrefix: 'wt',
            semanticSlug: false,
            worktreeNameMaxLength: 30,
        });

        assert.match(branchName, /^iter\/[a-z0-9-]+$/);
        assert.match(worktreeName, /^wt-[a-z0-9-]+$/);
        assert.ok(worktreeName.length <= 30, 'worktree name should respect configured max length');
    });

    test('FeatureStoreService uses naming config from saved config file', () => {
        const root = makeTempDir();
        try {
            const harnessDir = path.join(root, BASE);
            fs.mkdirSync(harnessDir, { recursive: true });
            fs.writeFileSync(path.join(harnessDir, 'config.json'), JSON.stringify({
                iterationBranchPrefix: 'iter',
                iterationWorktreePrefix: 'wt',
                iterationNamingSemantic: false,
                iterationWorktreeNameMaxLength: 28,
            }, null, 2), 'utf8');

            const service = new FeatureStoreService(root);
            const task = {
                id: 'task_3001',
                name: '中文任务名',
                desc: '测试命名配置',
                stage: 'writing_requirement',
            };

            const dir = service.getIterationDir(task);
            assert.equal(path.dirname(dir), path.join(root, 'worktrees'));
            assert.match(path.basename(dir), /^wt-[a-z0-9-]+$/);
            assert.ok(path.basename(dir).length <= 28, 'configured max length should apply');
        } finally {
            cleanup(root);
        }
    });

    test('migrates persisted legacy Chinese worktreePath when legacy folder is missing', () => {
        const root = makeTempDir();
        try {
            const service = new FeatureStoreService(root);
            const task = {
                id: 'task_4001',
                name: '指标统计和查询',
                desc: 'legacy persisted path should migrate',
                stage: 'writing_requirement',
                worktreePath: path.join(root, 'worktrees', '指标统计和查询'),
            };

            const migrated = service.getIterationDir(task);
            assert.notEqual(migrated, task.worktreePath);
            assert.match(path.basename(migrated), /^task-[a-z0-9-]+$/);
            assert.equal(path.dirname(migrated), path.join(root, 'worktrees'));
        } finally {
            cleanup(root);
        }
    });
});
