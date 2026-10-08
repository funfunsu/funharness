'use strict';

/**
 * 覆盖基线（关键流程/顺序敏感）：
 * 1) 守护 DEVELOPING 阶段自动续跑状态机：tasks.md 与 done-* 信号先后顺序变化时，不得卡死。
 * 2) 守护输出门禁路径判定：输出项中的括号说明（如“含 up/rollback”）应视为注释，不得当作字面路径。
 * 3) 守护批处理边界：batch 模式在检查点后必须停顿等待人工确认，避免越权自动推进。
 * 4) 守护任务解析契约：同行/多行验收与裸/方括号追踪均须保留，不能退回通用验收或丢失规格切片依据。
 * 5) YAML 依赖仅补齐缺失字段；Markdown 显式依赖优先，代码围栏不得污染任务验收。
 * 6) 依赖正文按总预算去重，超额仍保留路径；测试清单只省略完整条目，不截断 JSON 或验收。
 * 7) 显式 local 任务先落记录再写信号，成功接入原输出校验；失败暂停且重试不转 AI。
 * 8) 自动修复信号仅触发重验，不能标记完成；重载、去重、预算及人工暂停不能绕过验证或重复派发。
 * 任何改动都不能破坏上述顺序与边界，否则会引发误判失败或自动化中断。
 *
 * FeatureScheduler regression baseline for auto-continue during DEVELOPING.
 *
 * Covered scenarios:
 * 1. tasks.md completion only:
 *    When the current subtask is moved from `doing` to `done` in tasks.md,
 *    the scheduler continues to the next runnable subtask (auto-continue after
 *    manual completion is always on).
 * 2. done-signal arrives after tasks.md already says done:
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
            isTrusted: true,
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

function writeRepairPlan(root, autoRepair) {
    const specDir = path.join(root, 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'source');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(specDir, 'tasks.md'), [
        '- [x] 1.1 实现任务',
        '  - 输出: src/a.ts',
        '  - 追踪: Req-1 + INV-1',
        '- [ ] 1.2 本地验证',
        '  - 执行方式: local',
        '  - 本地操作: verify',
        '  - 检查项: [compile]',
        ...(autoRepair === undefined ? [] : [`  - 自动修复: ${autoRepair}`]),
        '  - 依赖: [1.1]',
        '  - 输出: .harness/process/verify.md',
        '  - 追踪: Req-1 + INV-1',
        '- [ ] 1.3 下游任务',
        '  - 依赖: [1.2]',
    ].join('\n'), 'utf8');
}

function repairHarness(root, results, dispatchOverride) {
    const { LocalProcessTaskService } = require('../out/services/localProcessTaskService');
    const { LocalRepairService } = require('../out/services/localRepairService');
    const { vscodeMock, watchers } = createVscodeMock();
    const FeatureScheduler = loadFeatureScheduler(vscodeMock);
    let runs = 0;
    const queries = [];
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const local = new LocalProcessTaskService(async () => {
        enter();
        return results[Math.min(runs++, results.length - 1)];
    });
    const template = fs.readFileSync(path.join(__dirname, '../system-prompts/local_repair_system_prompt.md'), 'utf8');
    const scheduler = new FeatureScheduler(root, root, { ...DEFAULT_CONFIG, specRootDir: 'specs' },
        async (query, _dir, _source, _provider, context) => {
            queries.push({ query, context });
            if (dispatchOverride) await dispatchOverride(query);
        }, () => {}, () => '', local, () => template);
    return { scheduler, queries, watchers, vscodeMock, entered, state: () => new LocalRepairService(root).read('1.2'), runs: () => runs };
}

async function acknowledgeRepair(root, harness, state = harness.state(), payload) {
    const signal = path.join(root, state.signalFile);
    fs.writeFileSync(signal, JSON.stringify(payload || { taskId: state.taskId, requestId: state.requestId, status: 'repaired' }));
    const watcher = harness.watchers.find(item => item.pattern.pattern === 'repair-*');
    assert.ok(watcher);
    for (const handler of watcher.createHandlers) await handler({ fsPath: signal });
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
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
            { ...DEFAULT_CONFIG, autoAdvanceEnabled: false, specRootDir: 'specs' },
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

    test('auto-advances across batch boundary without a dialog when batch auto-advance is enabled', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const taskPlanPath = writeTaskPlan(tmpDir);
        const { vscodeMock, watchers } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, autoAdvanceEnabled: true, specRootDir: 'specs' },
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
        assert.equal(scheduler.isAutoMode(), true);
        assert.equal(dispatched.length, 1);
        assert.match(fs.readFileSync(taskPlanPath, 'utf8'), /\[doing\]\s*2\.1/);

        scheduler.stopWatching();
    });

    test('同行验收与裸追踪解析后保留规格关联，兼容多行验收与方括号追踪', () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [ ] 1.1 保存配置',
            '  - 验收: GIVEN 有效输入 WHEN 保存 THEN 配置持久化',
            '  - 追踪: Req-1,Req-2 + INV-1,INV-2,Req-1',
            '- [ ] 1.2 校验配置',
            '  - 依赖: [1.1]',
            '  - 验收：',
            '    - 非法输入被拒绝',
            '    - 不产生写入',
            '  - 追踪: [Req-3] + [INV-3]',
        ].join('\n'), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(tmpDir, tmpDir,
            { ...DEFAULT_CONFIG, specRootDir: 'specs' }, async () => {}, () => {}, () => '');
        const tasks = scheduler.parseSubFeaturesMd();
        assert.deepEqual(tasks[0].acceptance, ['GIVEN 有效输入 WHEN 保存 THEN 配置持久化']);
        assert.deepEqual(tasks[0].requirementIds, ['Req-1', 'Req-2']);
        assert.deepEqual(tasks[0].propertyIds, ['INV-1', 'INV-2']);
        assert.deepEqual(tasks[1].acceptance, ['非法输入被拒绝', '不产生写入']);
        assert.deepEqual(tasks[1].requirementIds, ['Req-3']);
        assert.deepEqual(tasks[1].propertyIds, ['INV-3']);
        assert.deepEqual(tasks[1].depends, ['1.1']);
    });

    test('任务输入路径不覆盖设计切片且派发保留具体验收', () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [ ] 1.1 保存配置',
            '  - 输入: specs/design.md#配置',
            '  - 验收: 非法输入被拒绝',
            '  - 追踪: Req-1 + INV-1',
        ].join('\n'), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(tmpDir, tmpDir,
            { ...DEFAULT_CONFIG, specRootDir: 'specs' }, async () => {}, () => {}, () => 'MODE={{taskSplitMode}}');
        scheduler.buildDesignContext = () => 'SELECTED_DESIGN_CONTRACT';
        const query = scheduler.buildDispatchQuery(scheduler.parseSubFeaturesMd()[0], createFeature());
        assert.match(query, /MODE=compact/);
        assert.match(scheduler.buildDispatchQuery(scheduler.parseSubFeaturesMd()[0],
            { ...createFeature(), taskSplitMode: 'standard' }), /MODE=standard/);
        assert.match(query, /specs\/design\.md#配置/);
        assert.match(query, /SELECTED_DESIGN_CONTRACT/);
        assert.match(query, /1\. 非法输入被拒绝/);
    });

    test('依赖正文总预算与路径去重保留验收和超额读取入口', () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        const files = Array.from({ length: 5 }, (_, index) => `依赖-${index}.txt`);
        files.forEach(file => fs.writeFileSync(path.join(tmpDir, file), 'Z'.repeat(3000), 'utf8'));
        fs.mkdirSync(path.join(tmpDir, '目录'));
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [x] 1.1 前置任务',
            `  - 输出: [${files.join(', ')}, 目录, 缺失.txt]`,
            '- [x] 1.2 共享输出',
            `  - 输出: ${files[0]}`,
            '- [ ] 1.3 当前任务',
            '  - 依赖: [1.1, 1.2]',
            '  - 验收: 不可删除的验收标准',
        ].join('\n'), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(tmpDir, tmpDir,
            { ...DEFAULT_CONFIG, specRootDir: 'specs' }, async () => {}, () => {}, () => 'HARD_CONSTRAINT');
        const query = scheduler.buildDispatchQuery(scheduler.parseSubFeaturesMd()[2], createFeature());
        assert.equal((query.match(/Z{100,}/g) || []).reduce((sum, body) => sum + body.length, 0), 6000);
        files.forEach(file => assert.ok(query.includes(file)));
        assert.match(query, /已列出，不重复注入/);
        assert.match(query, /正文未注入/);
        assert.match(query, /目录，按需查找/);
        assert.match(query, /必要依赖缺失时遵循 FAILURE PROTOCOL/);
        assert.match(query, /不可删除的验收标准/);
        assert.match(query, /HARD_CONSTRAINT/);
    });

    test('测试清单按完整条目控制预算并保留按需读取路径', () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'test-manifest.json'), JSON.stringify({
            testCases: Array.from({ length: 20 }, (_, index) => ({
                id: `TC-${index}`, requirementIds: ['Req-1'], description: 'x'.repeat(300),
            })),
        }), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(tmpDir, tmpDir,
            { ...DEFAULT_CONFIG, specRootDir: 'specs' }, async () => {}, () => {}, () => '');
        const context = scheduler.buildManifestContext({ requirementIds: ['Req-1'] });
        const serialized = context.split('\n')[0];
        assert.ok(serialized.length <= 1800);
        assert.ok(JSON.parse(serialized).length > 0);
        assert.ok(JSON.parse(serialized).length < 20);
        assert.match(context, /test-manifest\.json/);
        assert.match(context, /按需读取/);
    });

    test('YAML 补齐缺失依赖，Markdown 显式无依赖优先且围栏不污染验收', () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [ ] 1.1 保存配置',
            '  - 依赖: 无',
            '- [ ] 1.2 校验配置',
            '  - 验收:',
            '    - 非法输入被拒绝',
            '## 机器可读区',
            '```yaml',
            'artifactType: tasks',
            'tasks:',
            '  - id: "1.1"',
            '    dependsOn: ["1.2"]',
            '  - id: "1.2"',
            '    dependsOn:',
            '      - "1.1"',
            '```',
        ].join('\n'), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(tmpDir, tmpDir,
            { ...DEFAULT_CONFIG, specRootDir: 'specs' }, async () => {}, () => {}, () => '');
        const tasks = scheduler.parseSubFeaturesMd();
        assert.deepEqual(tasks[0].depends, []);
        assert.deepEqual(tasks[1].depends, ['1.1']);
        assert.deepEqual(tasks[1].acceptance, ['非法输入被拒绝']);
        assert.equal(scheduler.getNextSubFeature().id, '1.1');
        scheduler.updateSubFeatureStatus('1.1', 'done');
        assert.equal(scheduler.getNextSubFeature().id, '1.2');
    });

    test('显式 local 检查点不派发 AI，信号通过原门禁后续跑编码任务', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(specDir, 'requirements.md'), 'requirements');
        fs.writeFileSync(path.join(specDir, 'design.md'), 'design');
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [ ] 1.1 检查点',
            '  - 执行方式: local',
            '  - 本地操作: checkpoint',
            '  - 输出: [.harness/process/checkpoint.md]',
            '- [ ] 1.2 编码任务',
            '  - 依赖: [1.1]',
        ].join('\n'), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const dispatched = [];
        const scheduler = new FeatureScheduler(tmpDir, tmpDir, { ...DEFAULT_CONFIG, specRootDir: 'specs' },
            async query => dispatched.push(query), () => {}, () => '');
        try {
            await scheduler.startAuto(createFeature());
            assert.equal(scheduler.parseSubFeaturesMd()[0].status, 'done');
            assert.equal(scheduler.getCurrentSubFeature().id, '1.2');
            assert.equal(dispatched.length, 1);
            assert.match(dispatched[0], /任务ID：1\.2/);
            assert.ok(fs.existsSync(path.join(tmpDir, '.harness/process/checkpoint.md')));
            const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, '.harness/process/ai-usage-summary.json')));
            assert.equal(summary.localCompleted, 1);
            assert.equal(summary.aiCalls, 0);
        } finally { scheduler.stopWatching(); }
    });

    test('YAML local 验证失败暂停且重试仍在本地，不生成成功信号', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [ ] 1.1 本地校验',
            '  - 输出: .harness/process/verify.md',
            '```yaml',
            'artifactType: tasks',
            'tasks:',
            '  - id: "1.1"',
            '    execution: local',
            '    localAction: verify',
            '    checks: [compile]',
            '```',
        ].join('\n'), 'utf8');
        const { LocalProcessTaskService } = require('../out/services/localProcessTaskService');
        let attempts = 0;
        const local = new LocalProcessTaskService(async () => ({ exitCode: ++attempts === 1 ? 1 : 0, output: 'check output' }));
        const { vscodeMock } = createVscodeMock();
        vscodeMock.window.showInformationMessage = async () => '确认完成';
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        let dispatched = 0;
        const scheduler = new FeatureScheduler(tmpDir, tmpDir, { ...DEFAULT_CONFIG, specRootDir: 'specs' },
            async () => { dispatched += 1; }, () => {}, () => '', local);
        try {
            await scheduler.startAuto(createFeature());
            assert.equal(scheduler.parseSubFeaturesMd()[0].status, 'failed');
            assert.equal(scheduler.isAutoMode(), false);
            assert.equal(fs.existsSync(path.join(tmpDir, 'signals/done-1.1')), false);
            await scheduler.retrySubFeature('1.1', createFeature());
            assert.equal(scheduler.parseSubFeaturesMd()[0].status, 'done');
            assert.equal(attempts, 2);
            assert.equal(dispatched, 0);
        } finally { scheduler.stopWatching(); }
    });

    test('恢复 doing 本地任务时重跑，执行中禁止重复派发、重试或提前完成', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [doing] 1.1 本地验证',
            '  - 执行方式: local',
            '  - 本地操作: verify',
            '  - 检查项: [compile]',
            '  - 输出: .harness/process/verify.md',
        ].join('\n'), 'utf8');
        const { LocalProcessTaskService } = require('../out/services/localProcessTaskService');
        let release;
        let entered;
        const enteredCheck = new Promise(resolve => { entered = resolve; });
        const completion = new Promise(resolve => { release = resolve; });
        let runs = 0;
        const local = new LocalProcessTaskService(async () => {
            runs += 1;
            entered();
            await completion;
            return { exitCode: 0, output: 'passed' };
        });
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(tmpDir, tmpDir, { ...DEFAULT_CONFIG, specRootDir: 'specs' },
            async () => assert.fail('local task must not dispatch AI'), () => {}, () => '', local);
        let running;
        try {
            running = scheduler.startAuto(createFeature());
            await enteredCheck;
            await scheduler.startAuto(createFeature());
            await scheduler.retrySubFeature('1.1', createFeature());
            await scheduler.manualNext(createFeature());
            assert.equal(scheduler.parseSubFeaturesMd()[0].status, 'doing');
            assert.equal(runs, 1);
            release();
            await running;
            assert.equal(scheduler.parseSubFeaturesMd()[0].status, 'done');
        } finally {
            release();
            if (running) await running;
            scheduler.stopWatching();
        }
    });

    test('Markdown 与 YAML 执行方式冲突时阻断，不运行本地命令也不派发 AI', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        fs.writeFileSync(path.join(specDir, 'tasks.md'), [
            '- [ ] 1.1 冲突任务',
            '  - 执行方式: ai',
            '```yaml',
            'artifactType: tasks',
            'tasks:',
            '  - id: "1.1"',
            '    execution: local',
            '    localAction: verify',
            '    checks: [compile]',
            '```',
        ].join('\n'), 'utf8');
        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        let dispatched = 0;
        const scheduler = new FeatureScheduler(tmpDir, tmpDir, { ...DEFAULT_CONFIG, specRootDir: 'specs' },
            async () => { dispatched += 1; }, () => {}, () => '');
        try {
            await scheduler.startAuto(createFeature());
            assert.equal(scheduler.parseSubFeaturesMd()[0].status, 'failed');
            assert.equal(scheduler.isAutoMode(), false);
            assert.equal(dispatched, 0);
        } finally { scheduler.stopWatching(); }
    });

    test('验证失败自动修复后必须本地重验，陈旧修复信号和 done 信号均不能提前推进', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        const harness = repairHarness(root, [
            { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: literal $& mismatch' },
            { exitCode: 0, output: 'passed' },
        ]);
        try {
            await harness.scheduler.startAuto(createFeature());
            assert.equal(harness.queries.length, 1);
            assert.equal(harness.queries[0].context.stage, 'local-repair');
            assert.match(harness.queries[0].query, /literal \$& mismatch/);
            assert.match(harness.queries[0].query, /src\/a\.ts/);
            assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'failed');
            assert.equal(fs.existsSync(path.join(root, 'signals/done-1.2')), false);
            const state = harness.state();
            await acknowledgeRepair(root, harness, state, { taskId: '1.2', requestId: 'stale', status: 'repaired' });
            await harness.scheduler.handleSignal('1.2', path.join(root, 'signals/done-1.2'), createFeature());
            assert.equal(harness.runs(), 1);
            assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'failed');
            await acknowledgeRepair(root, harness);
            assert.equal(harness.runs(), 2);
            assert.equal(harness.state().status, 'verified');
            assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'done');
            assert.equal(harness.scheduler.getCurrentSubFeature().id, '1.3');
            assert.equal(harness.queries.length, 2);
            assert.match(harness.queries[1].query, /任务ID：1\.3/);
        } finally { harness.scheduler.stopWatching(); }
    });

    test('重验同错误停止修复，错误变化也最多两轮且不推进下游', async () => {
        for (const diagnostics of [['same', 'same'], ['first', 'second', 'third']]) {
            const root = makeTempDir();
            tmpDirs.push(root);
            writeRepairPlan(root);
            const harness = repairHarness(root, diagnostics.map(message => ({ exitCode: 1, output: `error TS2322: ${message}` })));
            try {
                await harness.scheduler.startAuto(createFeature());
                await acknowledgeRepair(root, harness);
                if (diagnostics.length === 3) await acknowledgeRepair(root, harness);
                assert.equal(harness.state().status, 'blocked');
                assert.equal(harness.queries.length, diagnostics.length === 3 ? 2 : 1);
                assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'failed');
                assert.equal(harness.scheduler.parseSubFeaturesMd()[2].status, 'todo');
                assert.equal(fs.existsSync(path.join(root, 'signals/done-1.2')), false);
            } finally { harness.scheduler.stopWatching(); }
        }
    });

    test('环境失败或 autoRepair=false 不触发自动修复', async () => {
        for (const scenario of [
            { output: 'MODULE_NOT_FOUND: missing tool', flag: undefined },
            { output: 'error TS2322: mismatch', flag: false },
        ]) {
            const root = makeTempDir();
            tmpDirs.push(root);
            writeRepairPlan(root, scenario.flag);
            const harness = repairHarness(root, [{ exitCode: 1, output: scenario.output }]);
            try {
                await harness.scheduler.startAuto(createFeature());
                assert.equal(harness.queries.length, 0);
                assert.equal(harness.state(), null);
                assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'failed');
            } finally { harness.scheduler.stopWatching(); }
        }
    });

    test('重载等待中的修复请求不重复派发，正确信号恢复本地验证与续跑', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        const first = repairHarness(root, [{ exitCode: 1, output: 'error TS2322: mismatch' }]);
        await first.scheduler.startAuto(createFeature());
        first.scheduler.stopWatching();
        const restored = repairHarness(root, [{ exitCode: 0, output: 'passed' }]);
        try {
            await restored.scheduler.startAuto(createFeature());
            assert.equal(restored.runs(), 0);
            assert.equal(restored.queries.length, 0);
            await acknowledgeRepair(root, restored);
            assert.equal(restored.runs(), 1);
            assert.equal(restored.state().attempt, 1);
            assert.equal(restored.scheduler.parseSubFeaturesMd()[1].status, 'done');
            assert.equal(restored.queries.length, 1);
        } finally { restored.scheduler.stopWatching(); }
    });

    test('用户暂停等待修复后不自动续跑，修改验证契约或过期信号也不能重验', async () => {
        for (const scenario of ['pause', 'contract', 'expired']) {
            const root = makeTempDir();
            tmpDirs.push(root);
            writeRepairPlan(root);
            const harness = repairHarness(root, [{ exitCode: 1, output: 'error TS2322: mismatch' }, { exitCode: 0, output: 'passed' }]);
            try {
                await harness.scheduler.startAuto(createFeature());
                if (scenario === 'pause') {
                    harness.scheduler.pause();
                    harness.vscodeMock.window.showInformationMessage = async () => '确认完成';
                } else if (scenario === 'contract') {
                    const file = path.join(root, 'specs/tasks.md');
                    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[compile]', '[compile, tests]'));
                } else {
                    const { LocalRepairService } = require('../out/services/localRepairService');
                    const state = harness.state();
                    state.createdAt = Date.now() - LocalRepairService.timeoutMs - 1;
                    new LocalRepairService(root).save(state);
                }
                await acknowledgeRepair(root, harness);
                assert.equal(harness.queries.length, 1);
                assert.equal(harness.scheduler.parseSubFeaturesMd()[2].status, 'todo');
                assert.equal(harness.runs(), scenario === 'pause' ? 2 : 1);
                assert.equal(harness.state().status, scenario === 'pause' ? 'verified' : 'blocked');
            } finally { harness.scheduler.stopWatching(); }
        }
    });

    test('修复没有完成信号时十分钟后停止，不重复派发 AI', async context => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const harness = repairHarness(root, [{ exitCode: 1, output: 'error TS2322: mismatch' }]);
        try {
            await harness.scheduler.startAuto(createFeature());
            const { LocalRepairService } = require('../out/services/localRepairService');
            context.mock.timers.tick(LocalRepairService.timeoutMs);
            assert.equal(harness.state().status, 'blocked');
            assert.match(harness.state().reason, /timed out/);
            assert.equal(harness.queries.length, 1);
            assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'failed');
        } finally {
            harness.scheduler.stopWatching();
            context.mock.timers.reset();
        }
    });

    test('本地验证运行中用户暂停，即使稍后报代码错误也不自动派发修复', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        let release;
        const result = new Promise(resolve => { release = resolve; });
        const harness = repairHarness(root, [result]);
        let running;
        try {
            running = harness.scheduler.startAuto(createFeature());
            await harness.entered;
            assert.equal(harness.runs(), 1);
            harness.scheduler.pause();
            release({ exitCode: 1, output: 'error TS2322: mismatch' });
            await running;
            assert.equal(harness.queries.length, 0);
            assert.equal(harness.state(), null);
        } finally {
            release({ exitCode: 0, output: 'passed' });
            if (running) await running;
            harness.scheduler.stopWatching();
        }
    });

    test('曾经验证通过的本地任务再次失败时失效旧状态，陈旧 done 与旧报告不能完成任务', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        const harness = repairHarness(root, [
            { exitCode: 1, output: 'error TS2322: mismatch' },
            { exitCode: 0, output: 'passed' },
            { exitCode: 1, output: 'EACCES: permission denied' },
        ]);
        try {
            await harness.scheduler.startAuto(createFeature());
            await acknowledgeRepair(root, harness);
            assert.equal(harness.state().status, 'verified');
            harness.scheduler.pause();
            harness.scheduler.updateSubFeatureStatus('1.3', 'todo');
            harness.vscodeMock.window.showInformationMessage = async () => '确认完成';
            await harness.scheduler.retrySubFeature('1.2', createFeature());
            assert.equal(harness.state().status, 'blocked');
            const signal = path.join(root, 'signals/done-1.2');
            fs.writeFileSync(signal, 'files:\n  - .harness/process/verify.md\n');
            await harness.scheduler.handleSignal('1.2', signal, createFeature());
            assert.equal(harness.scheduler.parseSubFeaturesMd()[1].status, 'failed');
            harness.scheduler.updateSubFeatureStatus('1.2', 'done');
            assert.equal(harness.scheduler.getNextSubFeature(), null);
        } finally { harness.scheduler.stopWatching(); }
    });

    test('重载 verifying 且任务仍为 failed 时恢复原本地验证，不等待或重复派发 AI', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        const first = repairHarness(root, [{ exitCode: 1, output: 'error TS2322: mismatch' }]);
        await first.scheduler.startAuto(createFeature());
        const { LocalRepairService } = require('../out/services/localRepairService');
        const state = first.state();
        state.status = 'verifying';
        new LocalRepairService(root).save(state);
        first.scheduler.stopWatching();
        const restored = repairHarness(root, [{ exitCode: 0, output: 'passed' }]);
        try {
            await restored.scheduler.startAuto(createFeature());
            assert.equal(restored.runs(), 1);
            assert.equal(restored.state().status, 'verified');
            assert.equal(restored.scheduler.parseSubFeaturesMd()[1].status, 'done');
            assert.equal(restored.queries.length, 1);
            assert.match(restored.queries[0].query, /任务ID：1\.3/);
        } finally { restored.scheduler.stopWatching(); }
    });

    test('损坏修复状态阻断启动但不影响暂停，人工重试验证通过后才能恢复', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        const first = repairHarness(root, [{ exitCode: 1, output: 'error TS2322: mismatch' }]);
        await first.scheduler.startAuto(createFeature());
        first.scheduler.stopWatching();
        fs.writeFileSync(path.join(root, '.harness/process/local-repair-1.2.json'), '{broken');
        const restored = repairHarness(root, [{ exitCode: 0, output: 'passed' }]);
        try {
            await restored.scheduler.startAuto(createFeature());
            assert.equal(restored.scheduler.isAutoMode(), false);
            assert.equal(restored.runs(), 0);
            restored.scheduler.autoMode = true;
            assert.doesNotThrow(() => restored.scheduler.pause());
            assert.equal(restored.scheduler.isAutoMode(), false);
            restored.vscodeMock.window.showInformationMessage = async () => '确认完成';
            await restored.scheduler.retrySubFeature('1.2', createFeature());
            assert.equal(restored.state().status, 'verified');
            assert.equal(restored.state().reason, undefined);
            assert.equal(restored.scheduler.parseSubFeaturesMd()[1].status, 'done');
            assert.equal(restored.queries.length, 0);
        } finally { restored.scheduler.stopWatching(); }
    });

    test('修复派发异常暂停，不接受后续修复信号也不重验', async () => {
        const root = makeTempDir();
        tmpDirs.push(root);
        writeRepairPlan(root);
        const harness = repairHarness(root, [{ exitCode: 1, output: 'error TS2322: mismatch' }], async () => { throw new Error('provider unavailable'); });
        try {
            await harness.scheduler.startAuto(createFeature());
            assert.equal(harness.state().status, 'blocked');
            await acknowledgeRepair(root, harness);
            assert.equal(harness.runs(), 1);
            assert.equal(harness.scheduler.isAutoMode(), false);
        } finally { harness.scheduler.stopWatching(); }
    });

    test('parses 新建输出/改造输出 into newFiles/modifiedFiles and filters 无 placeholder', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specDir, { recursive: true });
        const taskPlanPath = path.join(specDir, 'tasks.md');
        fs.writeFileSync(taskPlanPath, [
            '- [doing] 1.1 新增检查点行为表单并接线',
            '  - Owner: Frontend',
            '  - 输出: apps/web/src/components/CheckpointBehaviorForm.vue',
            '  - 新建输出: apps/web/src/components/CheckpointBehaviorForm.vue',
            '  - 改造输出: apps/web/src/views/CheckpointManagement.vue',
            '  - 验收: 编辑弹窗表单能记录开发配置',
            '  - 追踪: Req-1',
            '',
            '- [ ] 1.2 纯新建无接线',
            '  - Owner: Backend',
            '  - 新建输出: apps/api/src/Foo.java',
            '  - 改造输出: 无',
            '',
        ].join('\n'), 'utf8');

        const { vscodeMock } = createVscodeMock();
        const FeatureScheduler = loadFeatureScheduler(vscodeMock);
        const scheduler = new FeatureScheduler(
            tmpDir,
            tmpDir,
            { ...DEFAULT_CONFIG, specRootDir: 'specs' },
            async () => {},
            () => {},
            () => 'dev system prompt'
        );

        const subTasks = scheduler.parseSubFeaturesMd();
        const t11 = subTasks.find(t => t.id === '1.1');
        const t12 = subTasks.find(t => t.id === '1.2');

        assert.deepEqual(t11.newFiles, ['apps/web/src/components/CheckpointBehaviorForm.vue']);
        assert.deepEqual(t11.modifiedFiles, ['apps/web/src/views/CheckpointManagement.vue']);
        // output is the union used by downstream dispatch/gate.
        assert.ok(t11.output.includes('apps/web/src/views/CheckpointManagement.vue'));

        assert.deepEqual(t12.newFiles, ['apps/api/src/Foo.java']);
        // The 无 placeholder must be filtered so it never reaches the path gate.
        assert.deepEqual(t12.modifiedFiles, []);
        assert.equal(t12.output.includes('无'), false);
    });
});