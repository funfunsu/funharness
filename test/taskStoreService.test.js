const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStoreService } = require('../out/services/taskStoreService.js');

function makeTempWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fun-harness-test-'));
}

test('TaskStoreService should save/load tasks and config', () => {
    const workspaceRoot = makeTempWorkspace();
    const store = new TaskStoreService(workspaceRoot);

    const tasks = [
        { id: 'task_1', name: 'demo', desc: 'desc', stage: '⌛ 初始化中' }
    ];

    store.saveTasks(tasks);
    const loadedTasks = store.loadTasks();
    assert.equal(loadedTasks.length, 1);
    assert.equal(loadedTasks[0].id, 'task_1');

    const config = {
        frontendGit: 'https://example.com/fe.git',
        backendGit: 'https://example.com/be.git',
        mergeTargetBranch: 'me/integration',
        baseSyncBranch: 'me/integration',
        mergeDryRunEnabled: true,
        backendStartCmd: 'npm run dev',
        backendPort: 3000,
        frontendStartCmd: 'npm run ui',
        techStack: 'ts',
        codingStandards: 'camelCase',
        maxConcurrentAutoTasks: 3,
        autoAdvanceEnabled: true,
        autoRepairEnabled: false,
        autoContinueAfterManualDone: true,
        compactTaskDecomposition: false,
        autoDetectTaskSplitMode: true,
        simpleTaskKeywords: 'blacklist,crud',
        complexTaskKeywords: 'workflow,审批',
    };

    store.saveConfig(config);
    const loadedConfig = store.loadConfig();
    assert.equal(loadedConfig.frontendGit, config.frontendGit);
    assert.equal(loadedConfig.backendPort, 3000);
    assert.equal(loadedConfig.codingStandards, 'camelCase');
});

test('TaskStoreService should resolve and create iteration directory', () => {
    const workspaceRoot = makeTempWorkspace();
    const store = new TaskStoreService(workspaceRoot);

    const task = { id: 'task_2', name: 'feature-a', desc: 'desc', stage: '⌛ 初始化中' };
    const iterDir = store.getIterationDir(task);

    assert.ok(iterDir.endsWith(path.join('worktrees', 'feature-a')));
    assert.equal(fs.existsSync(iterDir), false);

    store.ensureIterationDir(task);
    assert.equal(fs.existsSync(iterDir), true);
    assert.equal(task.worktreePath, iterDir);
});

test('TaskStoreService should fall back to defaults when config json is malformed', () => {
    const workspaceRoot = makeTempWorkspace();
    const harnessDir = path.join(workspaceRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(path.join(harnessDir, 'config.json'), '{invalid json', 'utf8');

    const store = new TaskStoreService(workspaceRoot);
    const config = store.loadConfig();

    assert.equal(config.backendPort, 8080);
    assert.equal(config.aiProvider, 'copilot-chat');
});

test('TaskStoreService should return empty tasks when state json is malformed', () => {
    const workspaceRoot = makeTempWorkspace();
    const harnessDir = path.join(workspaceRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(path.join(harnessDir, 'iteration-state.json'), '{invalid json', 'utf8');

    const store = new TaskStoreService(workspaceRoot);
    const tasks = store.loadTasks();

    assert.deepEqual(tasks, []);
});
