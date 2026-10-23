'use strict';

/**
 * Git 配置单仓库覆盖基线。
 *
 * 覆盖场景：
 * 1. 只保留单一仓库模式，无 monorepoGit 时不返回任何 descriptor。
 * 2. 有 monorepoGit 时仅返回 mono 仓库 descriptor。
 *
 * 这组测试守护“Git 设置页与初始化逻辑只承认 monorepo 配置”，后续改动不能重新引入分仓路径。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { GitService } = require('../out/services/gitService');
const { DEFAULT_CONFIG } = require('../out/models');

describe('Git settings single-repo baseline', () => {
    test('returns no descriptors when monorepo remote is empty', () => {
        const gitService = new GitService({
            ...DEFAULT_CONFIG,
            monorepoGit: '',
        }, '/tmp/fun-harness');

        const descriptors = gitService.resolveRepoDescriptors('');
        assert.deepEqual(descriptors, []);
    });

    test('monorepo remote remains the only active repo descriptor', () => {
        const gitService = new GitService({
            ...DEFAULT_CONFIG,
            monorepoGit: 'https://example.com/mono.git',
        }, '/tmp/fun-harness');

        const descriptors = gitService.resolveRepoDescriptors('');
        assert.equal(descriptors.length, 1);
        assert.equal(descriptors[0].kind, 'mono');
        assert.equal(descriptors[0].remote, 'https://example.com/mono.git');
    });
});
