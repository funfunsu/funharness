'use strict';

/**
 * 本地执行覆盖基线：仅可信工作区及白名单检查可执行，过程输出不可逃逸。
 * 记录与检查必须先成功再写 done 信号，失败不得伪造完成；无任意 shell 输入。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalProcessTaskService, LocalVerificationError } = require('../out/services/localProcessTaskService');

test('仅代码诊断允许自动修复，环境失败与无成功标记不能触发 AI', () => {
    for (const output of ['src/a.ts(1,2): error TS2322: incompatible type', 'SyntaxError: Unexpected token', 'AssertionError [ERR_ASSERTION]: mismatch']) {
        assert.equal(new LocalVerificationError('compile', { exitCode: 1, output }).repairable, true);
    }
    for (const output of ['ENOENT node', 'Missing script: compile:guard', 'Local check timed out', 'Error: Cannot find module x\ncode: MODULE_NOT_FOUND', 'unknown failure']) {
        assert.equal(new LocalVerificationError('tests', { exitCode: 1, output }).repairable, false);
    }
    assert.equal(new LocalVerificationError('webview', { exitCode: 0, output: 'no success marker' }).repairable, false);
    assert.equal(new LocalVerificationError('compile', { exitCode: 1, output: 'error TS2322: mismatch', failureKind: 'infrastructure' }).repairable, false);
});

function task(overrides = {}) {
    return { id: '1.1', name: '验证', execution: 'local', localAction: 'verify', checks: ['compile'],
        depends: [], output: ['.harness/process/验证.md'], requirementIds: [], propertyIds: [], ...overrides };
}

test('白名单检查成功后先写过程记录再写 done，失败与不可信工作区不写信号', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-process-'));
    try {
        fs.writeFileSync(path.join(root, 'package.json'), '{}');
        const signal = path.join(root, 'signals/done-1.1');
        const checks = [];
        const service = new LocalProcessTaskService(async check => {
            assert.equal(fs.existsSync(signal), false);
            checks.push(check);
            return { exitCode: 0, output: 'passed' };
        });
        await assert.rejects(service.execute(task(), [], root, root, false), /trusted/);
        await assert.rejects(service.execute(task({ output: ['.harness/process/../../escape.md'] }), [], root, root, true), /escapes/);
        await assert.rejects(service.execute(task({ checks: ['echo injected'] }), [], root, root, true), /allowlisted/);
        assert.deepEqual(checks, []);
        await service.execute(task(), [], root, root, true);
        assert.ok(fs.existsSync(signal));
        assert.match(fs.readFileSync(path.join(root, '.harness/process/验证.md'), 'utf8'), /passed/);
        fs.unlinkSync(signal);
        const failed = new LocalProcessTaskService(async () => ({ exitCode: 1, output: 'test failure' }));
        await assert.rejects(failed.execute(task(), [], root, root, true), /test failure/);
        assert.equal(fs.existsSync(signal), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('追踪矩阵必须映射到实现任务，检查点仅记录快照哈希不声称评审通过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-trace-'));
    try {
        fs.writeFileSync(path.join(root, 'requirements.md'), '```yaml\nrequirements:\n  - id: Req-1\n```');
        fs.writeFileSync(path.join(root, 'design.md'), 'design');
        fs.writeFileSync(path.join(root, 'tasks.md'), 'tasks');
        const service = new LocalProcessTaskService();
        const trace = task({ localAction: 'traceability' });
        await assert.rejects(service.execute(trace, [], root, root, true), /no implementation/);
        await service.execute(trace, [{ id: '2.1', requirementIds: ['Req-1'], propertyIds: ['INV-1'] }], root, root, true);
        assert.match(fs.readFileSync(path.join(root, '.harness/process/验证.md'), 'utf8'), /Req-1 \| 2.1/);
        await service.execute(task({ localAction: 'checkpoint' }), [], root, root, true);
        const report = fs.readFileSync(path.join(root, '.harness/process/验证.md'), 'utf8');
        assert.match(report, /sha256=/);
        assert.match(report, /not an AI review/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('默认执行器在真实临时项目运行编译、Webview 与 Node 测试，再写成功信号', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.mkdirSync(path.join(root, 'test'));
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            scripts: { 'compile:guard': 'node scripts/validate-webview.js' },
        }));
        fs.writeFileSync(path.join(root, 'scripts/validate-webview.js'), "console.log('Webview script validation passed');");
        fs.writeFileSync(path.join(root, 'test/example.test.js'), "require('node:test')('local fixture', () => {});");
        const service = new LocalProcessTaskService();
        await service.execute(task({ checks: ['compile', 'webview', 'tests'] }), [], root, root, true);
        const report = fs.readFileSync(path.join(root, '.harness/process/验证.md'), 'utf8');
        assert.match(report, /## compile/);
        assert.match(report, /## webview/);
        assert.match(report, /local fixture/);
        assert.ok(fs.existsSync(path.join(root, 'signals/done-1.1')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('只声明 tests 或先声明 tests 时均先编译一次，禁止使用旧产物验证', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-order-'));
    try {
        fs.writeFileSync(path.join(root, 'package.json'), '{}');
        for (const declared of [['tests'], ['tests', 'compile']]) {
            const checks = [];
            const service = new LocalProcessTaskService(async check => {
                checks.push(check);
                return { exitCode: 0, output: 'passed' };
            });
            await service.execute(task({ checks: declared }), [], root, root, true);
            assert.deepEqual(checks, ['compile', 'tests']);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});