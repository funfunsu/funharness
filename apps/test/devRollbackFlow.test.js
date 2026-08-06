'use strict';

/**
 * 开发阶段“回退到任务拆分后”回归覆盖基线。
 *
 * 覆盖场景：
 * 1. 开发阶段必须渲染独立回退按钮，避免用户误用“上一步”替代。
 * 2. Webview 消息契约、控制器分发、扩展依赖注入链路必须连通。
 * 3. 动作服务与 Git 回滚入口必须存在，确保“仅回滚 apps + 子任务状态重置”能力可达。
 *
 * 这组测试守护的是“开发回退链路不被后续重构删改或断连”。
 */

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { buildMainPageHtml } = require('../out/webviewTemplates');
const { DEFAULT_CONFIG, STAGE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-dev-rollback-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore best-effort cleanup failures
    }
}

function createVscodeMock(sink = {}) {
    const errors = sink.errors || [];
    return {
        window: {
            async showWarningMessage(message, _options, confirmLabel) {
                if (String(message).includes('将回退任务')) {
                    return confirmLabel;
                }
                return undefined;
            },
            async showInformationMessage() {
                return undefined;
            },
            async showErrorMessage(message) {
                errors.push(String(message || ''));
                return undefined;
            },
        },
    };
}

function loadHarnessActionsService(vscodeMock) {
    const servicePath = require.resolve('../out/services/harnessActionsService');
    delete require.cache[servicePath];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../out/services/harnessActionsService').HarnessActionsService;
    } finally {
        Module._load = originalLoad;
    }
}

function buildDevelopingTaskView() {
    return {
        task: {
            id: 'task-dev-rollback',
            name: 'Dev rollback task',
            desc: 'desc',
            stage: STAGE.DEVELOPING,
            quickMode: false,
            autoAdvanceEnabled: true,
            autoRepairEnabled: false,
            aiProvider: 'copilot-chat',
        },
        stats: { todo: 1, doing: 0, done: 1, failed: 0, total: 2 },
        pct: 50,
        subTasks: [],
        latestFailureReason: '',
        taskOutputPathWarnings: [],
        isAuto: false,
        artifacts: {
            requirements: true,
            requirementsReady: true,
            design: true,
            designReady: true,
            testcase: true,
            tasks: true,
            testScript: false,
        },
        health: {
            worktreeExists: true,
            frontendExists: true,
            backendExists: true,
            mainFrontendExists: true,
            mainBackendExists: true,
            branchRouteReady: true,
            mergeRouteReady: true,
            severity: 'good',
            summary: 'ok',
        },
        specDeltaStatus: null,
    };
}

describe('开发回退链路覆盖基线', () => {
    const tmpDirs = [];

    afterEach(() => {
        while (tmpDirs.length > 0) {
            cleanup(tmpDirs.pop());
        }
    });

    test('developing stage renders dedicated rollback action', () => {
        const html = buildMainPageHtml([buildDevelopingTaskView()], {}, {
            compactTaskDecomposition: false,
            isWorktreeSubview: true,
            aiProvider: 'copilot-chat',
            customButtons: [],
            autoPollEnabled: false,
            autoPoll: {
                enabledHere: false,
                activeElsewhereName: '',
                intervalSec: 30,
                script: 'poll.ps1',
                scriptExists: true,
            },
        });

        assert.equal(html.includes('>回滚</button>'), true);
        assert.equal(html.includes("type:'rollbackDev'"), true);
    });

    test('renders output-path warning text when task output has annotation suffix', () => {
        const view = buildDevelopingTaskView();
        view.taskOutputPathWarnings = ['[1.1] 输出项含括号注释: apps/risk-control-api/db/migration（含 up/rollback）'];
        const html = buildMainPageHtml([view], {}, {
            compactTaskDecomposition: false,
            isWorktreeSubview: true,
            aiProvider: 'copilot-chat',
            customButtons: [],
            autoPollEnabled: false,
            autoPoll: {
                enabledHere: false,
                activeElsewhereName: '',
                intervalSec: 30,
                script: 'poll.ps1',
                scriptExists: true,
            },
        });

        assert.equal(html.includes('输出路径告警：'), true);
    });

    test('message contract and dispatch chain include rollbackDev', () => {
        const messagesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'harnessMessages.ts'), 'utf8');
        const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'harnessMessageController.ts'), 'utf8');
        const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
        const actionsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'harnessActionsService.ts'), 'utf8');
        const gitSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'gitService.ts'), 'utf8');

        assert.equal(messagesSource.includes("| { type: 'rollbackDev'; id: string }"), true);
        assert.equal(controllerSource.includes("case 'rollbackDev':"), true);
        assert.equal(controllerSource.includes('rollbackDev: (featureId: string) => Promise<void>;'), true);
        assert.equal(extensionSource.includes('rollbackDev: async (featureId) => this.actionsService.rollbackDevByFeatureId(featureId),'), true);
        assert.equal(actionsSource.includes('async rollbackDevByFeatureId(featureId: string): Promise<void>'), true);
        assert.equal(gitSource.includes('async rollbackIterationAppsOnly('), true);
    });

    test('rollbackDev resets done/doing/failed tasks to todo and cleans done signals', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);

        const specsDir = path.join(tmpDir, 'specs');
        const signalsDir = path.join(tmpDir, 'signals');
        fs.mkdirSync(specsDir, { recursive: true });
        fs.mkdirSync(signalsDir, { recursive: true });

        const tasksPath = path.join(specsDir, 'tasks.md');
        const reqPath = path.join(specsDir, 'requirements.md');
        const desPath = path.join(specsDir, 'design.md');
        const tcsPath = path.join(specsDir, 'testcase.md');
        fs.writeFileSync(tasksPath, [
            '- [x] 1.1 已完成任务',
            '- [doing] 1.2 进行中任务',
            '- [failed] 1.3 失败任务',
            '- [ ] 1.4 未开始任务',
            '',
        ].join('\n'), 'utf8');
        fs.writeFileSync(reqPath, '# requirements\nkeep-requirements\n', 'utf8');
        fs.writeFileSync(desPath, '# design\nkeep-design\n', 'utf8');
        fs.writeFileSync(tcsPath, '# testcase\nkeep-testcase\n', 'utf8');

        fs.writeFileSync(path.join(signalsDir, 'done-1.1'), 'taskId: 1.1\nstatus: done\n', 'utf8');
        fs.writeFileSync(path.join(signalsDir, 'done-1.2'), 'taskId: 1.2\nstatus: done\n', 'utf8');
        fs.writeFileSync(path.join(signalsDir, 'keep-me.txt'), 'preserve', 'utf8');

        const feature = {
            id: 'task-dev-reset',
            name: 'Dev reset task',
            desc: 'desc',
            stage: STAGE.DEVELOPING,
        };
        const features = [feature];

        const calls = {
            stopScheduler: 0,
            saveAndRender: 0,
            rollback: 0,
            captureHeads: 0,
        };

        const gitService = {
            async rollbackIterationAppsOnly() {
                calls.rollback += 1;
                return { success: true, message: 'ok' };
            },
            async captureIterationRepoHeads() {
                calls.captureHeads += 1;
                return { mono: 'abc123' };
            },
        };

        const vscodeMock = createVscodeMock();
        const HarnessActionsService = loadHarnessActionsService(vscodeMock);
        const service = new HarnessActionsService({
            getFeatures: () => features,
            getConfig: () => ({ ...DEFAULT_CONFIG, specRootDir: 'specs' }),
            getMasterRoot: () => tmpDir,
            getIterationDir: () => tmpDir,
            ensureIterationDir: () => {},
            saveAndRender: () => { calls.saveAndRender += 1; },
            gitService,
            getScheduler: () => ({
                startAuto: async () => {},
                pause: () => {},
                manualNext: async () => {},
                retrySubFeature: async () => {},
                updateSubFeatureStatus: () => {},
                isAutoMode: () => false,
            }),
            stopScheduler: () => { calls.stopScheduler += 1; },
            onPass: () => {},
            isWorktreeSubview: () => false,
            dispatchAi: async () => {},
            copyProjectStructureToIteration: () => {},
            renderAgentPrompt: () => ({ content: '', source: '', path: '' }),
        });

        await service.rollbackDevByFeatureId('task-dev-reset');

        const updated = fs.readFileSync(tasksPath, 'utf8');
        assert.match(updated, /^- \[ \] 1\.1 已完成任务/m);
        assert.match(updated, /^- \[ \] 1\.2 进行中任务/m);
        assert.match(updated, /^- \[ \] 1\.3 失败任务/m);
        assert.match(updated, /^- \[ \] 1\.4 未开始任务/m);

        assert.equal(fs.existsSync(path.join(signalsDir, 'done-1.1')), false);
        assert.equal(fs.existsSync(path.join(signalsDir, 'done-1.2')), false);
        assert.equal(fs.existsSync(path.join(signalsDir, 'keep-me.txt')), true);
        assert.equal(fs.readFileSync(reqPath, 'utf8'), '# requirements\nkeep-requirements\n');
        assert.equal(fs.readFileSync(desPath, 'utf8'), '# design\nkeep-design\n');
        assert.equal(fs.readFileSync(tcsPath, 'utf8'), '# testcase\nkeep-testcase\n');

        assert.equal(calls.rollback, 1);
        assert.equal(calls.stopScheduler, 1);
        assert.equal(calls.saveAndRender, 1);
        assert.equal(calls.captureHeads, 1);
        assert.ok(feature.devRollbackSnapshot, 'rollback should refresh dev snapshot after cleanup');
        assert.equal(feature.stage, STAGE.WRITING_TASKS, 'rollback should bring task stage back to task-split stage');
    });

    test('auto advance never auto-repairs task-split stage', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);

        const feature = {
            id: 'task-no-auto-repair-tsk',
            name: 'No auto repair in tsk',
            desc: 'desc',
            stage: STAGE.WRITING_TASKS,
            quickMode: false,
            autoAdvanceEnabled: true,
            autoRepairEnabled: true,
            aiProvider: 'copilot-chat',
        };
        const features = [feature];
        let dispatchCount = 0;

        const vscodeMock = createVscodeMock();
        const HarnessActionsService = loadHarnessActionsService(vscodeMock);
        const service = new HarnessActionsService({
            getFeatures: () => features,
            getConfig: () => ({ ...DEFAULT_CONFIG, specRootDir: 'specs', autoAdvanceEnabled: true, autoRepairEnabled: true }),
            getMasterRoot: () => tmpDir,
            getIterationDir: () => tmpDir,
            ensureIterationDir: () => {},
            saveAndRender: () => {},
            gitService: {
                async rollbackIterationAppsOnly() { return { success: true, message: 'ok' }; },
                async captureIterationRepoHeads() { return { mono: 'abc123' }; },
            },
            getScheduler: () => ({
                startAuto: async () => {},
                pause: () => {},
                manualNext: async () => {},
                retrySubFeature: async () => {},
                updateSubFeatureStatus: () => {},
                isAutoMode: () => false,
            }),
            stopScheduler: () => {},
            onPass: () => {},
            isWorktreeSubview: () => false,
            dispatchAi: async () => { dispatchCount += 1; },
            copyProjectStructureToIteration: () => {},
            renderAgentPrompt: () => ({ content: 'prompt', source: 'default', path: '' }),
        });

        const changed = await service.autoAdvanceReadyTasks();

        assert.equal(changed, false, 'tsk stage should stay as explicit manual gate');
        assert.equal(dispatchCount, 0, 'tsk stage should not trigger auto-repair AI dispatch');
    });

    test('next tsk->dev is blocked when output path contains annotation suffix', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        const specsDir = path.join(tmpDir, 'specs');
        fs.mkdirSync(specsDir, { recursive: true });

        fs.writeFileSync(path.join(specsDir, 'requirements.md'), [
            '# 需求文档',
            '## 需求清单',
            '### 需求-1：数据库迁移',
            '#### 验收标准',
            '- 通过',
            '```yaml',
            'artifactType: requirements',
            'requirements:',
            '  - id: Req-1',
            '    title: 数据库迁移',
            '```',
            '',
        ].join('\n'), 'utf8');

        fs.writeFileSync(path.join(specsDir, 'tasks.md'), [
            '# 任务拆解文档',
            '## 任务清单',
            '- [ ] 1.1 落盘迁移脚本',
            '  - Owner: Backend',
            '  - 输入: specs/design.md#2.1',
            '  - 输出: apps/risk-control-api/db/migration（含 up/rollback）',
            '  - 验收: 通过',
            '  - 追踪: [Req-1][INV-1]',
            '## 机器可读区',
            '```yaml',
            'artifactType: tasks',
            'tasks:',
            '  - id: 1.1',
            '    name: 落盘迁移脚本',
            '    owner: Backend',
            '    domain: metric',
            '    dependsOn: []',
            '    inputs: [specs/design.md#2.1]',
            '    outputs: [apps/risk-control-api/db/migration（含 up/rollback）]',
            '    requirementIds: [Req-1]',
            '```',
            '',
        ].join('\n'), 'utf8');

        const feature = {
            id: 'task-block-invalid-output',
            name: 'block invalid output path',
            desc: 'desc',
            stage: STAGE.WRITING_TASKS,
        };
        const features = [feature];
        const sink = { errors: [] };
        const vscodeMock = createVscodeMock(sink);
        const HarnessActionsService = loadHarnessActionsService(vscodeMock);
        const service = new HarnessActionsService({
            getFeatures: () => features,
            getConfig: () => ({ ...DEFAULT_CONFIG, specRootDir: 'specs' }),
            getMasterRoot: () => tmpDir,
            getIterationDir: () => tmpDir,
            ensureIterationDir: () => {},
            saveAndRender: () => {},
            gitService: {
                async rollbackIterationAppsOnly() { return { success: true, message: 'ok' }; },
                async captureIterationRepoHeads() { return { mono: 'abc123' }; },
            },
            getScheduler: () => ({
                startAuto: async () => {},
                pause: () => {},
                manualNext: async () => {},
                retrySubFeature: async () => {},
                updateSubFeatureStatus: () => {},
                isAutoMode: () => false,
                parseSubFeaturesMd: () => ([{
                    id: '1.1',
                    name: '落盘迁移脚本',
                    owner: 'Backend',
                    depends: [],
                    input: 'specs/design.md#2.1',
                    output: ['apps/risk-control-api/db/migration（含 up/rollback）'],
                    acceptance: ['通过'],
                    requirementIds: ['Req-1'],
                    propertyIds: ['INV-1'],
                    status: 'todo',
                    rawLine: '- [ ] 1.1 落盘迁移脚本',
                }]),
            }),
            stopScheduler: () => {},
            onPass: () => {},
            isWorktreeSubview: () => false,
            dispatchAi: async () => {},
            copyProjectStructureToIteration: () => {},
            renderAgentPrompt: () => ({ content: 'prompt', source: 'default', path: '' }),
        });

        await service.nextStageByFeatureId('task-block-invalid-output', 'tsk');

        assert.equal(feature.stage, STAGE.WRITING_TASKS, 'invalid output path should block entering developing stage');
        assert.equal(sink.errors.some(msg => msg.includes('无法进入开发阶段')), true);
    });
});
