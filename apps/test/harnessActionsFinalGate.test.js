'use strict';

/**
 * 最终执行门禁覆盖基线（顺序敏感）：
 * 1. 开发子任务完成不再触发测试脚本，脚本执行迁移到最终通过/合并环节。
 * 2. gateLevel=standard 下，若 test-api 脚本失败，必须阻断合并并保留 ready_for_review。
 * 3. gateLevel=standard 下，若不存在脚本，按“无脚本非阻断”兼容策略放行。
 *
 * 这组测试守护“开发门禁与最终验收门禁解耦”的行为边界，避免回归到开发阶段误跑集成测试。
 */

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { DEFAULT_CONFIG, STAGE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-final-gate-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
}

function createVscodeMock(sink = {}) {
    const errors = sink.errors || [];
    const infos = sink.infos || [];
    return {
        window: {
            async showErrorMessage(message) {
                errors.push(String(message || ''));
                return undefined;
            },
            async showInformationMessage(message) {
                infos.push(String(message || ''));
                return undefined;
            },
            async showWarningMessage() {
                return undefined;
            },
        },
        commands: {
            async executeCommand() {
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

function createServiceHarness(tmpDir, overrideConfig = {}, sink = {}) {
    const feature = {
        id: 'feature-1',
        name: 'feature 1',
        desc: 'desc',
        stage: STAGE.READY_FOR_REVIEW,
    };
    const features = [feature];

    const calls = {
        merge: 0,
        onPass: 0,
        saveAndRender: 0,
    };

    const gitService = {
        async mergeIterationToTarget() {
            calls.merge += 1;
            return { success: true, message: '', cleanupComplete: false };
        },
    };

    const HarnessActionsService = loadHarnessActionsService(createVscodeMock(sink));
    const service = new HarnessActionsService({
        getFeatures: () => features,
        getConfig: () => ({ ...DEFAULT_CONFIG, gateLevel: 'standard', ...overrideConfig }),
        getMasterRoot: () => tmpDir,
        getIterationDir: () => tmpDir,
        ensureIterationDir: () => {},
        saveAndRender: () => { calls.saveAndRender += 1; },
        gitService,
        getScheduler: () => ({ parseSubFeaturesMd: () => [] }),
        stopScheduler: () => {},
        onPass: () => { calls.onPass += 1; },
        isWorktreeSubview: () => false,
        dispatchAi: async () => {},
        copyProjectStructureToIteration: () => {},
        renderAgentPrompt: () => ({ content: '', source: 'none', path: '' }),
    });

    // Avoid unrelated spec-delta drift dependencies in this focused gate test.
    service.runDevDriftGateWithRepair = async () => true;

    return { service, feature, calls };
}

describe('最终执行门禁回归覆盖基线', () => {
    const tmpDirs = [];

    afterEach(() => {
        while (tmpDirs.length > 0) {
            cleanup(tmpDirs.pop());
        }
    });

    test('blocks merge when test-api script fails under standard gate', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);

        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'test-api.ps1'), 'Write-Error "boom"; exit 1\n', 'utf8');

        const sink = { errors: [], infos: [] };
        const { service, feature, calls } = createServiceHarness(tmpDir, { gateLevel: 'standard' }, sink);

        await service.passByFeatureId(feature.id);

        assert.equal(calls.merge, 0);
        assert.equal(feature.stage, STAGE.READY_FOR_REVIEW);
        assert.equal(calls.onPass, 0);
        assert.equal(sink.errors.some(msg => msg.includes('执行门禁未通过')), true);
    });

    test('allows merge when no final test script exists under standard gate', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);

        const sink = { errors: [], infos: [] };
        const { service, feature, calls } = createServiceHarness(tmpDir, { gateLevel: 'standard' }, sink);

        await service.passByFeatureId(feature.id);

        assert.equal(calls.merge, 1);
        assert.equal(feature.stage, STAGE.DONE);
        assert.equal(calls.onPass, 1);
        assert.equal(sink.errors.length, 0);
    });
});
