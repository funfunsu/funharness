'use strict';

/**
 * Git 回滚（apps-only）集成覆盖基线。
 *
 * 覆盖场景：
 * 1. 同时存在 apps 与 specs 变更时，rollbackIterationAppsOnly 只能回滚 apps。
 * 2. apps 下的已跟踪修改与未跟踪新增都应被回滚/清理。
 * 3. specs 下文件内容与新增文件必须保留，不应被误删。
 *
 * 这组测试守护的是“代码回滚范围被严格限制在 apps 路径”。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { GitService } = require('../out/services/gitService');
const { DEFAULT_CONFIG, STAGE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-git-rollback-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore best-effort cleanup failures
    }
}

function run(cmd, cwd) {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

function normalizeEol(text) {
    return String(text).replace(/\r\n/g, '\n');
}

describe('Git apps-only rollback integration baseline', () => {
    test('rollbackIterationAppsOnly reverts only apps changes and keeps specs changes', async () => {
        const repoRoot = makeTempDir();
        try {
            run('git init', repoRoot);
            run('git config user.email "test@example.com"', repoRoot);
            run('git config user.name "Fun Harness Test"', repoRoot);

            const appsTracked = path.join(repoRoot, 'apps', 'src', 'index.ts');
            const specsTracked = path.join(repoRoot, 'specs', 'requirements.md');
            fs.mkdirSync(path.dirname(appsTracked), { recursive: true });
            fs.mkdirSync(path.dirname(specsTracked), { recursive: true });
            fs.writeFileSync(appsTracked, 'export const v = 1;\n', 'utf8');
            fs.writeFileSync(specsTracked, '# requirements\nbase\n', 'utf8');

            run('git add .', repoRoot);
            run('git commit -m "init"', repoRoot);
            run('git checkout -b task/integration-rollback', repoRoot);

            // Mixed mutations: apps should rollback, specs should stay.
            fs.writeFileSync(appsTracked, 'export const v = 2;\n', 'utf8');
            run('git add apps/src/index.ts', repoRoot);
            fs.writeFileSync(specsTracked, '# requirements\nchanged-spec\n', 'utf8');

            const appsUntracked = path.join(repoRoot, 'apps', 'src', 'new.ts');
            const specsUntracked = path.join(repoRoot, 'specs', 'extra.md');
            fs.writeFileSync(appsUntracked, 'export const n = 1;\n', 'utf8');
            fs.writeFileSync(specsUntracked, '# keep\n', 'utf8');

            const gitService = new GitService({
                ...DEFAULT_CONFIG,
                // Force monorepo descriptor so rollback target is the repo root.
                monorepoGit: 'dummy-remote',
            }, repoRoot);

            const task = {
                id: 'task_git_rollback',
                name: 'integration rollback',
                desc: 'apps only rollback',
                stage: STAGE.DEVELOPING,
                iterationBranch: 'task/integration-rollback',
            };

            const result = await gitService.rollbackIterationAppsOnly(task, repoRoot);
            assert.equal(result.success, true, result.message);

            // apps tracked file should be restored to committed content.
            assert.equal(normalizeEol(fs.readFileSync(appsTracked, 'utf8')), 'export const v = 1;\n');
            // apps untracked file should be cleaned.
            assert.equal(fs.existsSync(appsUntracked), false);

            // specs tracked content should remain mutated.
            assert.equal(normalizeEol(fs.readFileSync(specsTracked, 'utf8')), '# requirements\nchanged-spec\n');
            // specs untracked file should remain.
            assert.equal(fs.existsSync(specsUntracked), true);
        } finally {
            cleanup(repoRoot);
        }
    });
});
