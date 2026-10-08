'use strict';

/**
 * 计量覆盖基线：派发返回后记录结果，不能当成模型完成；同任务尝试递增。
 * 中文输入按字符和字节分别汇总，未知 token/费用必须为空，损坏记录不得破坏汇总。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiUsageService } = require('../out/services/aiUsageService');

test('派发计量按任务递增尝试并汇总中文输入，不伪造 token', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-'));
    try {
        const service = new AiUsageService();
        const query = '规则\n## 编码任务指令\n- 任务ID：1.1\n## 验收标准\n正确保存\n';
        const first = service.begin(query, root, 'dev-subtask', 'copilot-chat', 'scope', null);
        assert.equal(first.attempt, 1);
        assert.equal(first.taskId, '1.1');
        assert.equal(first.stage, 'dev');
        assert.equal(first.sections.reduce((sum, section) => sum + section.chars, 0), query.length);
        service.finish(root, first, 'dispatched', Date.now());
        const second = service.begin(query, root, 'dev-subtask', 'copilot-chat', 'scope', null);
        assert.equal(second.attempt, 2);
        assert.notEqual(first.id, second.id);
        service.finish(root, second, 'failed', Date.now());
        fs.appendFileSync(path.join(root, '.harness/process/ai-calls.jsonl'), '{broken\n');
        fs.appendFileSync(path.join(root, '.harness/process/ai-calls.jsonl'), '{"id":"malformed","inputBytes":2}\n');
        const summary = service.summarize(root);
        assert.equal(summary.dispatchCalls, 2);
        assert.equal(summary.inputBytes, Buffer.byteLength(query) * 2);
        assert.equal(summary.groups[0].failed, 1);
        assert.equal(summary.actualTokens, null);
        assert.equal(summary.cost, null);
        assert.equal(Object.values(summary.sections).reduce((sum, section) => sum + section.chars, 0), query.length * 2);
        assert.ok(fs.existsSync(path.join(root, '.harness/process/ai-usage-summary.json')));
        const planning = service.begin('planning', root, 'stage-agent', 'copilot-chat', null, null,
            { stage: 'tsk', taskId: 'iteration-1' });
        service.finish(root, planning, 'prepared', Date.now());
        assert.equal(service.summarize(root).groups.find(group => group.stage === 'tsk').prepared, 1);
        const special = service.begin('## __proto__\n正文', root, 'stage-agent', 'copilot-chat', null, null);
        service.finish(root, special, 'dispatched', Date.now());
        assert.ok(service.summarize(root).sections.__proto__.chars > 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});