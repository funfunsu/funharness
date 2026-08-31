'use strict';

/**
 * 需求->设计领域预检覆盖基线。
 *
 * 覆盖场景：
 * 1. req->des 前，若 requirements 机器块 domain 未登记到 registry，必须阻断推进。
 * 2. 用户选择“自动补”时，系统自动写入 registry 并继续推进，无需用户手动找文件。
 * 3. 用户选择“去处理”时，系统打开 registry 文件并保持当前阶段不变。
 *
 * 这组测试守护“阻断可介入但不要求用户理解目录结构”的回归边界。
 */

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { DEFAULT_CONFIG, STAGE } = require('../out/models');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-domain-preflight-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup failures
    }
}

function writeRequirements(iterDir, domain) {
    const filePath = path.join(iterDir, 'specs', 'requirements.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = [
        '# 需求文档',
        '',
        '## 机器可读区',
        '```yaml',
        'artifactType: requirements',
        'taskName: Demo',
        'requirements:',
        '  - id: Req-1',
        `    domain: ${domain}`,
        '    rawDomain: AI快捷对话',
        '    title: demo',
        '    userStory: demo',
        '    acceptanceCriteria:',
        '      - GIVEN A WHEN B THEN C',
        '```',
        '',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
}

function createVscodeMock(sink = {}, userChoice = '去处理') {
    const opened = sink.opened || [];
    return {
        window: {
            async showWarningMessage(message) {
                if (String(message).includes('领域未登记')) {
                    return userChoice;
                }
                return undefined;
            },
            async showInformationMessage() {
                return undefined;
            },
            async showErrorMessage() {
                return undefined;
            },
        },
        commands: {
            async executeCommand(command, uri) {
                opened.push({ command, path: uri && uri.fsPath ? uri.fsPath : '' });
                return undefined;
            },
        },
        Uri: {
            file(filePath) {
                return { fsPath: filePath };
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

function createServiceHarness(tmpDir, userChoice) {
    const feature = {
        id: 'feature-domain-gate',
        name: 'feature-domain-gate',
        desc: 'desc',
        stage: STAGE.WRITING_REQUIREMENT,
        quickMode: false,
        autoAdvanceEnabled: true,
        autoRepairEnabled: false,
        aiProvider: 'copilot-chat',
    };
    const features = [feature];
    const sink = { opened: [] };
    const calls = { saveAndRender: 0, runAgent: 0 };

    const HarnessActionsService = loadHarnessActionsService(createVscodeMock(sink, userChoice));
    const service = new HarnessActionsService({
        getFeatures: () => features,
        getConfig: () => ({ ...DEFAULT_CONFIG }),
        getMasterRoot: () => tmpDir,
        getIterationDir: () => tmpDir,
        ensureIterationDir: () => {},
        saveAndRender: () => { calls.saveAndRender += 1; },
        gitService: {},
        getScheduler: () => ({ isAutoMode: () => false, parseSubFeaturesMd: () => [] }),
        stopScheduler: () => {},
        onPass: () => {},
        isWorktreeSubview: () => false,
        dispatchAi: async () => {},
        copyProjectStructureToIteration: () => {},
        renderAgentPrompt: () => ({ content: '', source: 'none', path: '' }),
    });

    service.runAgentByFeatureId = async () => {
        calls.runAgent += 1;
    };

    return { service, feature, sink, calls };
}

function writeRegistry(root, domains) {
    const registryPath = path.join(root, 'docs', 'domains', 'registry.yaml');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const lines = ['domains:'];
    for (const domain of domains) {
        lines.push(`  - canonical: ${domain}`);
        lines.push(`    displayName: ${domain}`);
        lines.push('    aliases: []');
        lines.push('    status: active');
    }
    fs.writeFileSync(registryPath, `${lines.join('\n')}\n`, 'utf8');
}

describe('领域预检阻断与引导', () => {
    const tmpDirs = [];

    afterEach(() => {
        while (tmpDirs.length > 0) {
            cleanup(tmpDirs.pop());
        }
    });

    test('选择去处理时阻断推进并打开 registry', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        writeRequirements(tmpDir, 'ai-quick-chat');

        const { service, feature, sink, calls } = createServiceHarness(tmpDir, '去处理');
        await service.nextStageByFeatureId(feature.id, 'req');

        assert.equal(feature.stage, STAGE.WRITING_REQUIREMENT);
        assert.equal(calls.runAgent, 0);
        assert.equal(sink.opened.some(item => item.command === 'vscode.open' && item.path.endsWith(path.join('docs', 'domains', 'registry.yaml'))), true);
    });

    test('选择自动补时自动写 registry 并继续推进', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);
        writeRequirements(tmpDir, 'ai-quick-chat');

        const { service, feature, calls } = createServiceHarness(tmpDir, '自动补');
        await service.nextStageByFeatureId(feature.id, 'req');

        const registryPath = path.join(tmpDir, 'docs', 'domains', 'registry.yaml');
        const registryText = fs.readFileSync(registryPath, 'utf8');

        assert.equal(feature.stage, STAGE.WRITING_DESIGN);
        assert.equal(calls.runAgent, 1);
        assert.equal(registryText.includes('canonical: ai-quick-chat'), true);
        assert.equal(registryText.includes('status: active'), true);
    });

    test('AI 快捷对话按钮按原文内容派发且使用 quick-chat-button 源', async () => {
        const tmpDir = makeTempDir();
        tmpDirs.push(tmpDir);

        const feature = {
            id: 'feature-ai-quick-chat',
            name: 'feature-ai-quick-chat',
            desc: 'desc',
            stage: STAGE.DEVELOPING,
            quickMode: false,
            autoAdvanceEnabled: true,
            autoRepairEnabled: false,
            aiProvider: 'copilot-chat',
        };

        const dispatchCalls = [];
        const HarnessActionsService = loadHarnessActionsService(createVscodeMock({ opened: [] }, '自动补'));
        const service = new HarnessActionsService({
            getFeatures: () => [feature],
            getConfig: () => ({
                ...DEFAULT_CONFIG,
                aiQuickChatButtons: [{ id: 'aqc_1', label: '概述', content: '请按\n当前任务总览', order: 0 }],
            }),
            getMasterRoot: () => tmpDir,
            getIterationDir: () => tmpDir,
            ensureIterationDir: () => {},
            saveAndRender: () => {},
            gitService: {},
            getScheduler: () => ({ isAutoMode: () => false, parseSubFeaturesMd: () => [] }),
            stopScheduler: () => {},
            onPass: () => {},
            isWorktreeSubview: () => false,
            dispatchAi: async (query, iterDir, source, providerOverride) => {
                dispatchCalls.push({ query, iterDir, source, providerOverride });
            },
            copyProjectStructureToIteration: () => {},
            renderAgentPrompt: () => ({ content: '', source: 'none', path: '' }),
        });

        const result = await service.runAiQuickChatButtonByFeatureId(feature.id, 'aqc_1');

        assert.equal(result.accepted, true);
        assert.equal(dispatchCalls.length, 1);
        assert.equal(dispatchCalls[0].query, '请按\n当前任务总览');
        assert.equal(dispatchCalls[0].iterDir, tmpDir);
        assert.equal(dispatchCalls[0].source, 'quick-chat-button');
        assert.equal(dispatchCalls[0].providerOverride, 'copilot-chat');
    });

    test('预检以迭代目录 registry 为准，不被 master registry 误放行', async () => {
        const iterDir = makeTempDir();
        const masterRoot = makeTempDir();
        tmpDirs.push(iterDir);
        tmpDirs.push(masterRoot);

        writeRequirements(iterDir, 'ai-quick-chat');
        writeRegistry(masterRoot, ['ai-quick-chat']);
        writeRegistry(iterDir, ['domain-knowledge']);

        const feature = {
            id: 'feature-domain-root-boundary',
            name: 'feature-domain-root-boundary',
            desc: 'desc',
            stage: STAGE.WRITING_REQUIREMENT,
            quickMode: false,
            autoAdvanceEnabled: true,
            autoRepairEnabled: false,
            aiProvider: 'copilot-chat',
        };
        const features = [feature];
        const sink = { opened: [] };
        const calls = { runAgent: 0 };
        const HarnessActionsService = loadHarnessActionsService(createVscodeMock(sink, '去处理'));
        const service = new HarnessActionsService({
            getFeatures: () => features,
            getConfig: () => ({ ...DEFAULT_CONFIG }),
            getMasterRoot: () => masterRoot,
            getIterationDir: () => iterDir,
            ensureIterationDir: () => {},
            saveAndRender: () => {},
            gitService: {},
            getScheduler: () => ({ isAutoMode: () => false, parseSubFeaturesMd: () => [] }),
            stopScheduler: () => {},
            onPass: () => {},
            isWorktreeSubview: () => false,
            dispatchAi: async () => {},
            copyProjectStructureToIteration: () => {},
            renderAgentPrompt: () => ({ content: '', source: 'none', path: '' }),
        });
        service.runAgentByFeatureId = async () => { calls.runAgent += 1; };

        await service.nextStageByFeatureId(feature.id, 'req');

        assert.equal(feature.stage, STAGE.WRITING_REQUIREMENT);
        assert.equal(calls.runAgent, 0);
        assert.equal(sink.opened.some(item => item.path.includes(path.join('docs', 'domains', 'registry.yaml'))), true);
    });
});
