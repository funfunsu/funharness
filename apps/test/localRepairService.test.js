'use strict';

/**
 * 修复策略覆盖基线：只有依赖声明的实现文件可进入修复范围，最多两轮且同错误不重复派发。
 * 唯一请求信号不能替代验证；陈旧/伪造/损坏信号不接收，持久化状态守护重载预算。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRepairService } = require('../out/services/localRepairService');
const { LocalVerificationError } = require('../out/services/localProcessTaskService');

test('修复状态持久化、范围裁剪、信号关联与两轮预算', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-repair-'));
    try {
        const service = new LocalRepairService(root);
        fs.mkdirSync(path.join(root, 'src'));
        const task = { id: '1.2', execution: 'local', localAction: 'verify', checks: ['compile'], depends: ['1.1'],
            output: ['.harness/process/verify.md'], acceptance: [], requirementIds: [], propertyIds: [] };
        const tasks = [{ id: '1.1', depends: [], output: ['src/中文.ts', 'src', 'package.json', '.harness/state.json', 'specs/design.md'],
            newFiles: [], modifiedFiles: [], status: 'done' }];
        const failure = diagnostic => new LocalVerificationError('compile', { exitCode: 1, output: `src/中文.ts(1,1): error TS2322: ${diagnostic}` });
        const first = service.prepare(task, tasks, failure('first'), true);
        assert.deepEqual(first.allowedFiles, ['src/中文.ts']);
        assert.equal(new LocalRepairService(root).read(task.id).attempt, 1);
        fs.mkdirSync(path.join(root, 'signals'));
        fs.writeFileSync(path.join(root, first.signalFile), JSON.stringify({ taskId: task.id, requestId: 'stale', status: 'repaired' }));
        assert.equal(service.acknowledge(first), false);
        fs.writeFileSync(path.join(root, first.signalFile), JSON.stringify({ taskId: task.id, requestId: first.requestId, status: 'repaired' }));
        assert.equal(service.acknowledge(first), true);
        const second = service.prepare(task, tasks, failure('second'), true);
        assert.equal(second.attempt, 2);
        second.status = 'verifying';
        service.save(second);
        assert.throws(() => service.prepare(task, tasks, failure('third'), true), /budget exhausted/);
        assert.equal(service.read(task.id).status, 'blocked');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('重验同错误停止修复，没有实现范围也不能调用 AI', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-repeat-'));
    try {
        const service = new LocalRepairService(root);
        const task = { id: '1.2', depends: ['1.1'], checks: ['compile'], output: [], acceptance: [], requirementIds: [], propertyIds: [] };
        const tasks = [{ id: '1.1', depends: [], output: ['src/a.ts'], newFiles: [], modifiedFiles: [] }];
        const failure = new LocalVerificationError('compile', { exitCode: 1, output: 'error TS2322: unchanged' });
        const state = service.prepare(task, tasks, failure, true);
        state.status = 'verifying';
        service.save(state);
        assert.throws(() => service.prepare(task, tasks, failure, true), /Same diagnostic/);
        assert.throws(() => service.prepare({ ...task, id: '1.3' }, [], failure, true), /No implementation/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('损坏 JSON 或缺少超时字段的状态按 blocked 返回，不能重置修复预算', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-corrupt-'));
    try {
        const service = new LocalRepairService(root);
        fs.mkdirSync(path.join(root, '.harness/process'), { recursive: true });
        const file = path.join(root, '.harness/process/local-repair-1.2.json');
        for (const content of ['{broken', JSON.stringify({ taskId: '1.2', status: 'waiting' })]) {
            fs.writeFileSync(file, content);
            assert.equal(service.read('1.2').status, 'blocked');
            assert.match(service.read('1.2').reason, /Corrupt/);
            assert.throws(() => service.prepare({ id: '1.2' }, [],
                new LocalVerificationError('compile', { exitCode: 1, output: 'error TS2322: mismatch' }), true), /Corrupt/);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});