'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { DEFAULT_CONFIG, STAGE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-task-path-contract-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup failures
    }
}

function createVscodeMock() {
    return {
        window: {
            async showWarningMessage() { return undefined; },
            async showInformationMessage() { return undefined; },
            async showErrorMessage() { return undefined; },
        },
        commands: {
            async executeCommand() { return undefined; },
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

function createServiceHarness(tmpDir, outputs) {
    const feature = {
        id: 'feature-task-path-contract',
        name: 'feature-task-path-contract',
        desc: 'desc',
        stage: STAGE.WRITING_TASKS,
    };
    const HarnessActionsService = loadHarnessActionsService(createVscodeMock());
    const service = new HarnessActionsService({
        getFeatures: () => [feature],
        getConfig: () => ({ ...DEFAULT_CONFIG }),
        getMasterRoot: () => tmpDir,
        getIterationDir: () => tmpDir,
        ensureIterationDir: () => {},
        saveAndRender: () => {},
        gitService: { consumeLocalBaseFallbackNotice: () => '' },
        getScheduler: () => ({
            parseSubFeaturesMd: () => [{ id: '1.1', output: outputs }],
        }),
        stopScheduler: () => {},
        onPass: () => {},
        isWorktreeSubview: () => false,
        dispatchAi: async () => {},
        copyProjectStructureToIteration: () => {},
        renderAgentPrompt: () => ({ content: '', source: 'none', path: '' }),
    });

    return { service, feature };
}

describe('任务输出路径契约兼容', () => {
    const tmpDirs = [];

    afterEach(() => {
        while (tmpDirs.length > 0) {
            cleanup(tmpDirs.pop());
        }
    });

    test('accepts absolute output paths inside current iteration root', () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);

        const inRootAbsPath = path.join(tmpDir, 'apps', 'risk-control-api', 'src', 'main', 'resources', 'application.yml');
        const { service, feature } = createServiceHarness(tmpDir, [inRootAbsPath]);

        const errors = service.validateTaskOutputPathContract(feature);
        assert.deepEqual(errors, []);
    });

    test('rejects absolute output paths outside current iteration root', () => {
        const tmpDir = makeTempDir();
        const outsideRoot = makeTempDir();
        tmpDirs.push(tmpDir);
        tmpDirs.push(outsideRoot);

        const outsideAbsPath = path.join(outsideRoot, 'application.yml');
        const { service, feature } = createServiceHarness(tmpDir, [outsideAbsPath]);

        const errors = service.validateTaskOutputPathContract(feature);
        assert.equal(errors.some(item => item.includes('禁止引用目录外路径')), true);
    });
});
