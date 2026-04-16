const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Provide a minimal vscode runtime stub for Node-only test execution.
const originalLoad = Module._load;
Module._load = function mockVsCode(request, parent, isMain) {
    if (request === 'vscode') {
        return {
            commands: {
                executeCommand: async () => {}
            },
            window: {
                showInformationMessage: () => {},
                showErrorMessage: () => {}
            }
        };
    }
    return originalLoad(request, parent, isMain);
};

const { HarnessActionsService } = require('../out/services/harnessActionsService.js');

function createDeps() {
    const tasks = [];
    const calls = {
        ensureIterationDir: 0,
        saveAndRender: 0,
        stopScheduler: 0,
        onPass: 0,
        pushAll: 0,
        createBranches: 0,
        runAgentQueries: []
    };

    const scheduler = {
        startAuto: async () => {},
        pause: () => {},
        manualNext: async () => {},
        retryTask: async () => {}
    };

    const deps = {
        getTasks: () => tasks,
        getConfig: () => ({
            frontendGit: '',
            backendGit: '',
            mergeTargetBranch: '',
            backendStartCmd: '',
            backendPort: 8080,
            frontendStartCmd: '',
            techStack: '',
            codingStandards: '',
            autoAdvanceEnabled: true,
            autoRepairEnabled: false,
            autoContinueAfterManualDone: true,
            compactTaskDecomposition: false,
            autoDetectTaskSplitMode: true,
            simpleTaskKeywords: 'blacklist,crud,管理',
            complexTaskKeywords: 'workflow,审批,跨系统',
        }),
        getIterationDir: (task) => `/tmp/iteration-${task.name}`,
        ensureIterationDir: () => { calls.ensureIterationDir += 1; },
        saveAndRender: () => { calls.saveAndRender += 1; },
        gitService: {
            createIterationBranches: async () => {
                calls.createBranches += 1;
                return { success: true, message: 'ok' };
            },
            pushAll: async () => { calls.pushAll += 1; },
            mergeIterationToTarget: async () => ({ success: true, message: 'merged' })
        },
        getScheduler: () => scheduler,
        stopScheduler: () => { calls.stopScheduler += 1; },
        onPass: () => { calls.onPass += 1; },
        isWorktreeSubview: () => false,
        dispatchAi: async (query) => { calls.runAgentQueries.push(query); }
    };

    return { deps, tasks, calls };
}

test('HarnessActionsService should create task and initialize git flow', async () => {
    const { deps, tasks, calls } = createDeps();
    const service = new HarnessActionsService(deps);

    await service.createTask('featureA', 'desc');

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'featureA');
    assert.equal(calls.ensureIterationDir, 1);
    assert.ok(calls.saveAndRender >= 2); // before and after init branch
    assert.equal(calls.createBranches, 1);
});

test('HarnessActionsService should transition stage and stop scheduler at dev finish', () => {
    const { deps, tasks, calls } = createDeps();
    const service = new HarnessActionsService(deps);

    tasks.push({ id: 'task_100', name: 'n', desc: 'd', stage: '⚙️ 开发中' });
    service.nextStageByTaskId('task_100', 'dev');

    assert.equal(tasks[0].stage, '⏳ 待审核');
    assert.equal(calls.stopScheduler, 1);
});

test('HarnessActionsService should mark task done on pass', async () => {
    const { deps, tasks, calls } = createDeps();
    const service = new HarnessActionsService(deps);

    tasks.push({ id: 'task_200', name: 'n', desc: 'd', stage: '⏳ 待审核' });
    await service.passByTaskId('task_200');

    assert.equal(tasks[0].stage, '✅ 已完成');
    assert.equal(calls.onPass, 1);
});
