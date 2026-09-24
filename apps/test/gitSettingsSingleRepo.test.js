'use strict';

/**
 * Git 配置单仓库覆盖基线。
 *
 * 覆盖场景：
 * 1. 只保留单一仓库模式，前端/后端分离 Git 仅作为历史兼容字段被忽略。
 * 2. 无 monorepoGit 时，不再返回多仓库 descriptor，避免再次触发前后端双仓库分支。
 *
 * 这组测试守护的是“Git 设置页与初始化逻辑只承认单仓库配置”，后续改动不能重新引入多仓库模式。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { GitService } = require('../out/services/gitService');
const { DEFAULT_CONFIG } = require('../out/models');

describe('Git settings single-repo baseline', () => {
    test('legacy frontend/backend remotes are ignored in single-repo mode', () => {
        const gitService = new GitService({
            ...DEFAULT_CONFIG,
            monorepoGit: '',
            frontendGit: 'https://example.com/frontend.git',
            backendGit: 'https://example.com/backend.git',
        }, '/tmp/fun-harness');

        const descriptors = gitService.resolveRepoDescriptors('');
        assert.deepEqual(descriptors, []);
    });

    test('monorepo remote remains the only active repo descriptor', () => {
        const gitService = new GitService({
            ...DEFAULT_CONFIG,
            monorepoGit: 'https://example.com/mono.git',
            frontendGit: 'https://example.com/frontend.git',
            backendGit: 'https://example.com/backend.git',
        }, '/tmp/fun-harness');

        const descriptors = gitService.resolveRepoDescriptors('');
        assert.equal(descriptors.length, 1);
        assert.equal(descriptors[0].kind, 'mono');
        assert.equal(descriptors[0].remote, 'https://example.com/mono.git');
    });
});
