'use strict';

/**
 * Unit tests for PromptService.
 * Coverage: domain summary prompt includes explicit domain context.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PromptService } = require('../out/services/promptService');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-prompt-service-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore best-effort cleanup failures in tests
    }
}

describe('PromptService', () => {
    test('buildDomainSummaryPrompt includes explicit domain context', () => {
        const prompt = PromptService.buildDomainSummaryPrompt({
            canonical: 'billing',
            displayName: 'Billing',
            capabilities: [
                { reqId: 'Req-1', title: 'Collect invoice status', status: 'active' },
            ],
            registryCanonicals: ['billing', 'auth'],
        });

        assert.equal(prompt.includes('领域：Billing（billing）'), true);
        assert.equal(prompt.includes('"domain"'), true);
        assert.equal(prompt.includes('"canonical": "billing"'), true);
        assert.equal(prompt.includes('"displayName": "Billing"'), true);
    });

    test('task prompt includes strict output path contract', () => {
        const appsRoot = path.join(__dirname, '..');
        const service = new PromptService(appsRoot, appsRoot);
        const rendered = service.getRenderedPromptWithSource('tsk', '指标统计', '数据库迁移任务', appsRoot);

        assert.equal(rendered.content.includes('OUTPUT PATH CONTRACT (MANDATORY)'), true);
        assert.equal(rendered.content.includes('`输出` 字段必须填写“仓库相对路径”'), true);
        assert.equal(rendered.content.includes('`apps/risk-control-api/db/migration（含 up/rollback）`'), true);
        assert.equal(rendered.content.includes('输出: [仓库相对路径列表（仅路径，不含任何说明文字）]'), true);
    });

    test('requirement prompt injects missing registry context and forbids placeholder domains', () => {
        const workspaceRoot = makeTempDir();
        try {
            const appsRoot = path.join(__dirname, '..');
            const service = new PromptService(workspaceRoot, appsRoot);
            const rendered = service.getRenderedPromptWithSource('req', '资产标签联想', '为标签关联需求生成文档', workspaceRoot);

            assert.equal(rendered.content.includes('当前领域注册表状态：missing'), true);
            assert.equal(rendered.content.includes('当前已登记 canonical 领域：(none)'), true);
            assert.equal(rendered.content.includes('Forbidden placeholder values for `domain` or `rawDomain`'), true);
            assert.equal(rendered.content.includes('If registry is `missing` or `empty`, derive `domain` by semantic extraction'), true);
            assert.equal(rendered.content.includes('If registry is `available` but no existing canonical or alias fits the requirement semantics, still derive a proposed `domain` slug'), true);
        } finally {
            cleanup(workspaceRoot);
        }
    });

    test('requirement prompt injects available registry canonicals', () => {
        const workspaceRoot = makeTempDir();
        try {
            const registryPath = path.join(workspaceRoot, 'docs', 'domains', 'registry.yaml');
            fs.mkdirSync(path.dirname(registryPath), { recursive: true });
            fs.writeFileSync(registryPath, [
                'domains:',
                '  - canonical: billing',
                '    displayName: Billing',
                '    aliases: [payments]',
                '    status: active',
                '  - canonical: asset-label',
                '    displayName: Asset Label',
                '    aliases: []',
                '    status: active',
                '',
            ].join('\n'), 'utf8');

            const appsRoot = path.join(__dirname, '..');
            const service = new PromptService(workspaceRoot, appsRoot);
            const rendered = service.getRenderedPromptWithSource('req', '资产标签联想', '为标签关联需求生成文档', workspaceRoot);

            assert.equal(rendered.content.includes('当前领域注册表状态：available'), true);
            assert.equal(rendered.content.includes('当前已登记 canonical 领域：asset-label, billing'), true, rendered.content);
        } finally {
            cleanup(workspaceRoot);
        }
    });
});