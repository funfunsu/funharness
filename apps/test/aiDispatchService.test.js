'use strict';

/**
 * AI 会话复用回归覆盖基线。
 *
 * 覆盖场景：
 * 1. 开发子任务首次派发（无历史 scope）应新开会话。
 * 2. 已有开发会话时，即便本次 scope 解析失败，也必须复用当前会话。
 * 3. 明确跨批次（scope 变化）时，才允许新开会话。
 * 4. 生产派发成功/异常均写计量，派发成功不等于模型完成；异常不能吞掉或冒充零 token。
 *
 * 这组测试守护的是“同批次手工标记完成后继续派发，不会误开新会话”。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadAiDispatchService() {
    const servicePath = require.resolve('../out/services/aiDispatchService');
    delete require.cache[servicePath];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return {
                workspace: { workspaceFolders: [] },
                commands: {
                    async executeCommand() {
                        return undefined;
                    },
                    async getCommands() {
                        return [];
                    },
                },
                env: {
                    clipboard: {
                        async writeText() {
                            return undefined;
                        },
                    },
                },
                window: {
                    showInformationMessage() {},
                    showWarningMessage() {},
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../out/services/aiDispatchService').AiDispatchService;
    } finally {
        Module._load = originalLoad;
    }
}

function buildConfig() {
    return {
        aiProvider: 'copilot-chat',
    };
}

describe('AiDispatchService 会话复用覆盖基线', () => {
    test('生产派发成功与异常均进入阶段计量汇总', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-usage-'));
        try {
            const AiDispatchService = loadAiDispatchService();
            const service = new AiDispatchService(() => buildConfig());
            await service.dispatch('需求正文', root, 'stage-agent', undefined, { stage: 'req', taskId: 'iteration' });
            service.dispatchVscodeChat = async () => { throw new Error('dispatch failed'); };
            await assert.rejects(service.dispatch('需求正文', root, 'stage-agent', undefined,
                { stage: 'req', taskId: 'iteration' }), /dispatch failed/);
            const { AiUsageService } = require('../out/services/aiUsageService');
            const records = new AiUsageService().readCalls(root);
            assert.equal(records.length, 2);
            assert.equal(records[0].status, 'dispatched');
            assert.equal(records[1].status, 'failed');
            assert.equal(records[1].attempt, 2);
            assert.equal(records[1].error, 'dispatch failed');
            assert.equal(records[0].usage, null);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test('first dev-subtask dispatch opens a new chat when no previous scope exists', () => {
        const AiDispatchService = loadAiDispatchService();
        const service = new AiDispatchService(() => buildConfig());
        const shouldOpen = service.shouldOpenNewVscodeChat('dev-subtask', 'dev-batch:/repo:1', undefined);
        assert.equal(shouldOpen, true);
    });

    test('dev-subtask reuses current chat when scope parsing fails but previous scope exists', () => {
        const AiDispatchService = loadAiDispatchService();
        const service = new AiDispatchService(() => buildConfig());
        const shouldOpen = service.shouldOpenNewVscodeChat('dev-subtask', null, 'dev-batch:/repo:1');
        assert.equal(shouldOpen, false);
    });

    test('dev-subtask opens new chat only when parsed scope changes', () => {
        const AiDispatchService = loadAiDispatchService();
        const service = new AiDispatchService(() => buildConfig());
        const shouldOpenSame = service.shouldOpenNewVscodeChat('dev-subtask', 'dev-batch:/repo:1', 'dev-batch:/repo:1');
        const shouldOpenCross = service.shouldOpenNewVscodeChat('dev-subtask', 'dev-batch:/repo:2', 'dev-batch:/repo:1');
        assert.equal(shouldOpenSame, false);
        assert.equal(shouldOpenCross, true);
    });

    test('quick-chat dispatch never opens a new VS Code chat and keeps the raw query untouched', () => {
        const AiDispatchService = loadAiDispatchService();
        const service = new AiDispatchService(() => buildConfig());
        const shouldOpen = service.shouldOpenNewVscodeChat('quick-chat-button', '请按\n当前任务总览', 'previous-scope');
        const scope = service.resolveConversationScope('quick-chat-button', '/tmp/task', '请按\n当前任务总览');

        assert.equal(shouldOpen, false);
        assert.equal(scope, null);
    });
});
