'use strict';

/**
 * CodeGraph CLI 自动安装覆盖基线。
 *
 * 覆盖场景：
 * 1. Windows 环境自动安装必须走 npm.cmd。
 * 2. macOS 环境自动安装必须走 npm。
 *
 * 这组测试守护的是“自动安装命令按操作系统分流”，避免跨平台命令误用。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { CodeGraphInstallProbe } = require('../out/services/codegraph/codeGraphInstallProbe');

describe('CodeGraphInstallProbe 自动安装命令分流', () => {
    test('Windows 使用 npm.cmd 执行自动安装', () => {
        const calls = [];
        const fakeSpawn = (command, args) => {
            calls.push({ command, args });
            if (command === 'codegraph' && args[0] === '--version' && calls.length === 1) {
                return { status: 1, stdout: '', stderr: 'not found' };
            }
            if (command === 'npm.cmd') {
                return { status: 0, stdout: 'installed', stderr: '' };
            }
            if (command === 'codegraph' && args[0] === '--version') {
                return { status: 0, stdout: '1.2.3', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'unexpected command' };
        };

        const probe = new CodeGraphInstallProbe(fakeSpawn, 'win32');
        const result = probe.ensureCli({ worktreePath: 'C:/tmp/worktree', autoInstallEnabled: true });

        assert.equal(result.ready, true);
        assert.equal(result.attemptedInstall, true);
        assert.equal(result.installedNow, true);
        assert.equal(calls.some(call => call.command === 'npm.cmd'), true);
        assert.equal(
            calls.some(call => call.command === 'npm.cmd' && Array.isArray(call.args) && call.args.includes('@colbymchenry/codegraph')),
            true,
        );
    });

    test('macOS 使用 npm 执行自动安装', () => {
        const calls = [];
        const fakeSpawn = (command, args) => {
            calls.push({ command, args });
            if (command === 'codegraph' && args[0] === '--version' && calls.length === 1) {
                return { status: 1, stdout: '', stderr: 'not found' };
            }
            if (command === 'npm') {
                return { status: 0, stdout: 'installed', stderr: '' };
            }
            if (command === 'codegraph' && args[0] === '--version') {
                return { status: 0, stdout: '1.2.3', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'unexpected command' };
        };

        const probe = new CodeGraphInstallProbe(fakeSpawn, 'darwin');
        const result = probe.ensureCli({ worktreePath: '/tmp/worktree', autoInstallEnabled: true });

        assert.equal(result.ready, true);
        assert.equal(result.attemptedInstall, true);
        assert.equal(result.installedNow, true);
        assert.equal(calls.some(call => call.command === 'npm'), true);
        assert.equal(calls.some(call => call.command === 'npm.cmd'), false);
        assert.equal(
            calls.some(call => call.command === 'npm' && Array.isArray(call.args) && call.args.includes('@colbymchenry/codegraph')),
            true,
        );
    });

    test('Windows 下 npm.cmd 失败时回退到 npm 并继续安装', () => {
        const calls = [];
        const fakeSpawn = (command, args) => {
            calls.push({ command, args });
            if (command === 'codegraph' && args[0] === '--version' && calls.filter(c => c.command === 'codegraph').length === 1) {
                return { status: 1, stdout: '', stderr: 'not found' };
            }
            if (command === 'npm.cmd') {
                return { status: 1, stdout: '', stderr: 'ENOENT npm.cmd' };
            }
            if (command === 'npm') {
                return { status: 0, stdout: 'installed by npm fallback', stderr: '' };
            }
            if (command === 'codegraph' && args[0] === '--version') {
                return { status: 0, stdout: '1.6.2', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'unexpected command' };
        };

        const probe = new CodeGraphInstallProbe(fakeSpawn, 'win32');
        const result = probe.ensureCli({ worktreePath: 'C:/tmp/worktree', autoInstallEnabled: true });

        assert.equal(result.ready, true);
        assert.equal(result.attemptedInstall, true);
        assert.equal(calls.some(call => call.command === 'npm.cmd'), true);
        assert.equal(calls.some(call => call.command === 'npm'), true);
    });

    test('Windows 直连命令不可用时通过 powershell+fnm 探测到已安装 CLI', () => {
        const calls = [];
        const fakeSpawn = (command, args) => {
            calls.push({ command, args });
            if (command === 'codegraph') {
                return { status: 1, stdout: '', stderr: 'ENOENT codegraph' };
            }
            if (command === 'powershell') {
                return { status: 0, stdout: '1.6.2', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'unexpected command' };
        };

        const probe = new CodeGraphInstallProbe(fakeSpawn, 'win32');
        const result = probe.ensureCli({ worktreePath: 'C:/tmp/worktree', autoInstallEnabled: true });

        assert.equal(result.ready, true);
        assert.equal(result.attemptedInstall, false);
        assert.equal(result.installedNow, false);
        assert.equal(calls.some(call => call.command === 'powershell'), true);
        assert.equal(calls.some(call => call.command === 'npm.cmd'), false);
    });
});
