'use strict';

/**
 * 覆盖基线（关键流程/顺序敏感）：
 * 1) 守护 DEVELOPING 阶段自动续跑状态机：tasks.md 与 done-* 信号先后顺序变化时，不得卡死。
 * 2) 守护输出门禁路径判定：输出项中的括号说明（如“含 up/rollback”）应视为注释，不得当作字面路径。
 * 3) 守护批处理边界：batch 模式在检查点后必须停顿等待人工确认，避免越权自动推进。
 * 任何改动都不能破坏上述顺序与边界，否则会引发误判失败或自动化中断。
 *
 * FeatureScheduler regression baseline for auto-continue during DEVELOPING.
 *
 * Covered scenarios:
 * 1. tasks.md completion only:
 *    When the current subtask is moved from `doing` to `done` in tasks.md,
 *    the scheduler should continue to the next runnable subtask if
 *    `autoContinueAfterManualDone` is enabled.
 * 2. tasks.md completion with auto-continue disabled:
 *    The same status transition must NOT dispatch the next subtask when the
 *    config toggle is off.
 * 3. done-signal arrives after tasks.md already says done:
 *    If the agent first writes `[x]` in tasks.md and only then creates
 *    `signals/done-*`, the scheduler must still accept that signal and resume.
 *
 * This file intentionally focuses on ordering-sensitive recovery paths that can
 * stall unattended auto execution after checkpoint-style subtasks such as 1.5.
 */

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { DEFAULT_CONFIG, STAGE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'feature-scheduler-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
}

function createVscodeMock() {
    const watchers = [];
    const vscodeMock = {
        workspace: {
            createFileSystemWatcher(pattern) {
                const watcher = {
                    pattern,
                    changeHandlers: [],
                    createHandlers: [],
                    onDidChange(handler) {
                        this.changeHandlers.push(handler);
                        return { dispose() {} };
                    },
                    onDidCreate(handler) {
                        this.createHandlers.push(handler);
                        return { dispose() {} };
                    },
                    dispose() {
                        this.disposed = true;
                    },
                };
                watchers.push(watcher);
                return watcher;
            },
        },
        RelativePattern: class RelativePattern {
            constructor(base, pattern) {
                this.base = base;
                this.pattern = pattern;
            }
        },
        window: {
            async showInformationMessage() {
                return undefined;
            },
            async showWarningMessage() {
                return undefined;
            },
        },
    };

    return { vscodeMock, watchers };
}

function loadFeatureScheduler(vscodeMock) {
    const featureSchedulerPath = require.resolve('../out/featureScheduler');
    delete require.cache[featureSchedulerPath];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../out/featureScheduler').FeatureScheduler;
    } finally {
        Module._load = originalLoad;
    }
}

function writeTaskPlan(rootDir, firstTaskMarker = 'doing') {
    const specDir = path.join(rootDir, 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const taskPlanPath = path.join(specDir, 'tasks.md');
    fs.writeFileSync(taskPlanPath, [
        `- [${firstTaskMarker}] 1.5 检查点：DDD 分层与领域命名一致性评审`,
        '  - Owner: FullStack',
        '  - 输入: specs/指标统计/design.md 第 2.2 章节，apps/risk-control-api/CODING.md',
        '  - 输出: 评审记录（可附注于 specs/指标统计/tasks.md）',
        '  - 验收: 后端新增对象全部位于 metric 领域对应分层目录，无跨层逆向依赖',
        '  - 追踪: Req-1, Req-2, Req-3, Req-5',
        '  - 评审记录:',
        '    - 评审时间: 2026-08-04',
        '',
        '- [ ] 2.1 实现配置管理 API 与应用编排',
        '  - Owner: Backend',
        '  - 输入: specs/指标统计/design.md 第 2.3、3.1 章节',
        '  - 输出: MetricConfigController、MetricConfigApplicationService、MetricConfigCreateRequest、MetricConfigResponse、MetricApplicationConvertor',
        '  - 验收: 创建/查询/启停配置可用；同名配置重复创建稳定失败',
        '  - 追踪: Req-1, Req-6',
        '',
    ].join('\n'), 'utf8');
    return taskPlanPath;
}

function createFeature() {
    return {
        id: 'metric-feature',
        name: '指标统计',
        desc: 'metric config workflow',
        stage: STAGE.DEVELOPING,
    };
}

async function triggerTaskPlanChange(watchers, taskPlanPath) {
    const taskWatcher = watchers.find(watcher => watcher.pattern && watcher.pattern.pattern === 'tasks.md');
    assert.ok(taskWatcher, 'should register a watcher for tasks.md');
    for (const handler of taskWatcher.changeHandlers) {
        await handler({ fsPath: taskPlanPath });
    }
}

async function triggerSignalCreate(watchers, signalPath) {
    const signalWatcher = watchers.find(watcher => watcher.pattern && watcher.pattern.pattern === 'done-*');
    assert.ok(signalWatcher, 'should register a watcher for done-*');
    for (const handler of signalWatcher.createHandlers) {
        await handler({ fsPath: signalPath });
    }
}

describe('FeatureScheduler auto-continue recovery coverage', () => {
    const tmpDirs = [];

    afterEach(() => {
        while (tmpDirs.length > 0) {
            cleanup(tmpDirs.pop());
        }
    });

    test('continues when tasks.md marks the current subtask done and auto-continue is enabled', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir);
        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: true, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());

        const updated = fs.readFileSync(taskPlanPath, 'utf8').replace('[doing] 1.5', '[x] 1.5');
        fs.writeFileSync(taskPlanPath, updated, 'utf8');
        await triggerTaskPlanChange(watchers, taskPlanPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '2.1');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('does not continue from tasks.md completion when autoContinueAfterManualDone is disabled', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir);
        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());

        const updated = fs.readFileSync(taskPlanPath, 'utf8').replace('[doing] 1.5', '[x] 1.5');
        fs.writeFileSync(taskPlanPath, updated, 'utf8');
        await triggerTaskPlanChange(watchers, taskPlanPath);

        assert.equal(scheduler.getCurrentSubFeature(), null);
        assert.equal(dispatched.length, 0);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[ \]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('accepts done-* when tasks.md is already done for the same subtask', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir);
        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const signalPath = path.join(signalsDir, 'done-1.5');
        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());

        const updated = fs.readFileSync(taskPlanPath, 'utf8').replace('[doing] 1.5', '[x] 1.5');
        fs.writeFileSync(taskPlanPath, updated, 'utf8');
        fs.writeFileSync(signalPath, ['taskId: 1.5', 'status: done', 'timestamp: 2026-08-05T00:00:00Z'].join('\n'), 'utf8');
        await triggerSignalCreate(watchers, signalPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '2.1');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('accepts done-* when tasks.md is failed for the same subtask to support recovery', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir, 'failed');
        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const signalPath = path.join(signalsDir, 'done-1.5');
        const outputPath = path.join(tmpDir, 'specs', 'task-5-checkpoint-review.md');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, '# checkpoint', 'utf8');

        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());

        fs.writeFileSync(signalPath, [
            'taskId: 1.5',
            'status: done',
            'timestamp: 2026-08-05T00:00:00Z',
            'files:',
            '  - specs/task-5-checkpoint-review.md',
        ].join('\n'), 'utf8');
        await triggerSignalCreate(watchers, signalPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '2.1');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('accepts bare file names in done-* when they uniquely match nested outputs', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir);
        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const signalPath = path.join(signalsDir, 'done-1.5');
        const nestedJavaDir = path.join(tmpDir, 'apps', 'risk-control-api', 'src', 'main', 'java', 'com', 'example', 'metric');
        const nestedScriptDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(nestedJavaDir, { recursive: true });
        fs.mkdirSync(nestedScriptDir, { recursive: true });
        fs.writeFileSync(path.join(nestedJavaDir, 'MetricIngestController.java'), 'class MetricIngestController {}', 'utf8');
        fs.writeFileSync(path.join(nestedScriptDir, 'test-2.2.ps1'), 'Write-Host ok', 'utf8');

        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());

        fs.writeFileSync(signalPath, [
            'taskId: 1.5',
            'status: done',
            'timestamp: 2026-08-05T00:00:00Z',
            'files:',
            '  - MetricIngestController.java',
            '  - test-2.2.ps1',
        ].join('\n'), 'utf8');
        await triggerSignalCreate(watchers, signalPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '2.1');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('treats trailing parenthetical notes in output paths as annotations', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        const taskPlanPath = path.join(specDir, 'tasks.md');
        fs.writeFileSync(taskPlanPath, [
            '- [doing] 1.1 数据库迁移脚本落盘',
            '  - 输出: apps/risk-control-api/ddl/task_redis_metric_statistics_ddl.sql, apps/risk-control-api/ddl/db_create.sql, apps/risk-control-api/db/migration（含 up/rollback）, specs/task-redis-zhi-biao-tong-f748d9/verification/db-migration-rehearsal.md',
            '',
            '- [ ] 1.2 后续任务',
            '  - 输出: specs/next.md',
            '',
        ].join('\n'), 'utf8');

        const ddlDir = path.join(tmpDir, 'apps', 'risk-control-api', 'ddl');
        const migrationDir = path.join(tmpDir, 'apps', 'risk-control-api', 'db', 'migration');
        const verificationDir = path.join(tmpDir, 'specs', 'task-redis-zhi-biao-tong-f748d9', 'verification');
        fs.mkdirSync(ddlDir, { recursive: true });
        fs.mkdirSync(migrationDir, { recursive: true });
        fs.mkdirSync(verificationDir, { recursive: true });
        fs.writeFileSync(path.join(ddlDir, 'task_redis_metric_statistics_ddl.sql'), '-- ddl', 'utf8');
        fs.writeFileSync(path.join(ddlDir, 'db_create.sql'), '-- create', 'utf8');
        fs.writeFileSync(path.join(migrationDir, 'V002__create_metric_statistics_tables.sql'), '-- up', 'utf8');
        fs.writeFileSync(path.join(migrationDir, 'ROLLBACK__drop_metric_statistics_tables.sql'), '-- rollback', 'utf8');
        fs.writeFileSync(path.join(verificationDir, 'db-migration-rehearsal.md'), '# rehearsal', 'utf8');

        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const signalPath = path.join(signalsDir, 'done-1.1');
        fs.writeFileSync(signalPath, [
            'taskId: 1.1',
            'status: done',
            'timestamp: 2026-08-05T00:00:00Z',
            'files:',
            '  - apps/risk-control-api/ddl/task_redis_metric_statistics_ddl.sql',
            '  - apps/risk-control-api/ddl/db_create.sql',
            '  - apps/risk-control-api/db/migration/V002__create_metric_statistics_tables.sql',
            '  - apps/risk-control-api/db/migration/ROLLBACK__drop_metric_statistics_tables.sql',
            '  - specs/task-redis-zhi-biao-tong-f748d9/verification/db-migration-rehearsal.md',
        ].join('\n'), 'utf8');

        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());
        await triggerSignalCreate(watchers, signalPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '1.2');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*1\.2/);

        scheduler.stopWatching();
    });

    test('normalizes bracketed outputs and markdown-wrapped signal file paths', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        const taskPlanPath = path.join(specDir, 'tasks.md');
        fs.writeFileSync(taskPlanPath, [
            '- [doing] 1.2 检查点-需求与设计冻结',
            '  - 输出: [.harness/process/checkpoint-1.2-requirements-design-freeze.md]',
            '',
            '- [ ] 2.1 后续任务',
            '  - 输出: specs/next.md',
            '',
        ].join('\n'), 'utf8');

        const processDir = path.join(tmpDir, '.harness', 'process');
        fs.mkdirSync(processDir, { recursive: true });
        fs.writeFileSync(path.join(processDir, 'checkpoint-1.2-requirements-design-freeze.md'), '# freeze', 'utf8');

        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const signalPath = path.join(signalsDir, 'done-1.2');
        fs.writeFileSync(signalPath, [
            'taskId: 1.2',
            'status: done',
            'files:',
            '  - [.harness/process/checkpoint-1.2-requirements-design-freeze.md](.harness/process/checkpoint-1.2-requirements-design-freeze.md)',
        ].join('\n'), 'utf8');

        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());
        await triggerSignalCreate(watchers, signalPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '2.1');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('accepts bracketed multi-output lists after split (handles dangling [ and ])', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        const taskPlanPath = path.join(specDir, 'tasks.md');
        fs.writeFileSync(taskPlanPath, [
            '- [doing] 2.1 扩展消息契约与类型模型',
            '  - 输出: [apps/src/harnessMessages.ts, apps/src/models.ts]',
            '',
            '- [ ] 2.2 后续任务',
            '  - 输出: specs/next.md',
            '',
        ].join('\n'), 'utf8');

        const srcDir = path.join(tmpDir, 'apps', 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'harnessMessages.ts'), 'export {}', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'models.ts'), 'export {}', 'utf8');

        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const signalPath = path.join(signalsDir, 'done-2.1');
        fs.writeFileSync(signalPath, [
            'taskId: 2.1',
            'status: done',
            'files:',
            '  - apps/src/harnessMessages.ts',
            '  - apps/src/models.ts',
        ].join('\n'), 'utf8');

        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: false, devConversationMode: 'single', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());
        await triggerSignalCreate(watchers, signalPath);

        assert.equal(scheduler.getCurrentSubFeature()?.id, '2.2');
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.2/);

        scheduler.stopWatching();
    });

    test('pauses at batch boundary in batch mode until manual confirmation', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir);
        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoContinueAfterManualDone: true, devConversationMode: 'batch', specRootDir: 'specs' },
            async (query) => {
                dispatched.push(query);
            },
            () => {},
            () => 'dev system prompt'
        );

        await scheduler.startAuto(createFeature());

        const updated = fs.readFileSync(taskPlanPath, 'utf8').replace('[doing] 1.5', '[x] 1.5');
        fs.writeFileSync(taskPlanPath, updated, 'utf8');
        await triggerTaskPlanChange(watchers, taskPlanPath);

        assert.equal(scheduler.getCurrentSubFeature(), null);
        assert.equal(scheduler.isAutoMode(), false);
        assert.equal(dispatched.length, 0);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[ \]\s*2\.1/);

        scheduler.stopWatching();
    });
});