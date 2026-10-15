'use strict';

/**
 * Unit tests for PromptService.
 * Coverage: domain summary prompt includes explicit domain context.
 * 覆盖基线：修复使用独立模板及宪法，缺少模板时不得派发通用开发 Prompt 或绕过 done 信号边界。
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

/** Inject a mock evidence provider into PromptService for deterministic assertions. */
function setEvidenceProviderMock(service, mockImpl) {
    service.codeGraphEvidenceProvider = mockImpl;
}

describe('PromptService', () => {
    test('本地修复独立模板注入宪法并保留运行时占位符，缺失模板则返回空', () => {
        const root = makeTempDir();
        try {
            fs.mkdirSync(path.join(root, 'specs'));
            fs.writeFileSync(path.join(root, 'specs/constitution.md'), 'LOCAL_REPAIR_CONSTITUTION');
            const service = new PromptService(root, path.join(__dirname, '..'));
            const prompt = service.getLocalRepairPrompt('验证修复', '描述', root);
            assert.match(prompt, /Local Validation Repair Agent/);
            assert.match(prompt, /Never create or overwrite any `done-\*` signal/);
            assert.match(prompt, /工程宪法/);
            assert.match(prompt, /LOCAL_REPAIR_CONSTITUTION/);
            assert.ok(prompt.includes('{{repairSignalContent}}'));
            assert.ok(prompt.includes(root));
            assert.equal(new PromptService(root, root).getLocalRepairPrompt('验证', '描述', root), '');
        } finally { cleanup(root); }
    });

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

    test('四阶段 req/des/tsk/dev 在证据可用时注入锚点与接缝信息', () => {
        const workspaceRoot = makeTempDir();
        try {
            const appsRoot = path.join(__dirname, '..');
            const service = new PromptService(workspaceRoot, appsRoot);
            setEvidenceProviderMock(service, {
                getStageEvidence(input) {
                    return {
                        usable: true,
                        freshness: 'fresh',
                        anchors: [`anchor-${input.stage}`],
                        seams: [{ caller: `caller-${input.stage}`, callee: `callee-${input.stage}`, relation: 'calls' }],
                        impactSet: [`impact-${input.stage}`],
                        bundlePath: path.join(workspaceRoot, '.codegraph', 'evidence.json'),
                    };
                },
            });

            const stageMap = {
                req: 'requirements',
                des: 'design',
                tsk: 'tasks',
                dev: 'development',
            };

            for (const [stage, stageName] of Object.entries(stageMap)) {
                const rendered = service.getRenderedPromptWithSource(stage, '任务A', '描述A', workspaceRoot);
                assert.equal(rendered.content.includes(`## CodeGraph 证据注入（${stageName}）`), true);
                assert.equal(rendered.content.includes(`anchor-${stage}`), true);
                assert.equal(rendered.content.includes(`caller-${stage} -> callee-${stage} (calls)`), true);
                assert.equal(rendered.content.includes(`impact-${stage}`), true);
                assert.equal(rendered.content.includes('usable: true'), true);
            }
        } finally {
            cleanup(workspaceRoot);
        }
    });

    test('证据 stale 或 missing 时注入降级告警并禁止否定性推断', () => {
        const workspaceRoot = makeTempDir();
        try {
            const appsRoot = path.join(__dirname, '..');
            const service = new PromptService(workspaceRoot, appsRoot);
            let callCount = 0;
            setEvidenceProviderMock(service, {
                getStageEvidence() {
                    callCount += 1;
                    return {
                        usable: false,
                        freshness: callCount === 1 ? 'stale' : 'missing',
                        anchors: [],
                        seams: [],
                        impactSet: [],
                        bundlePath: path.join(workspaceRoot, '.codegraph', 'evidence.json'),
                        warning: callCount === 1 ? 'evidence is stale' : 'evidence missing',
                    };
                },
            });

            const staleRendered = service.getRenderedPromptWithSource('des', '任务B', '描述B', workspaceRoot);
            const missingRendered = service.getRenderedPromptWithSource('dev', '任务C', '描述C', workspaceRoot);

            for (const content of [staleRendered.content, missingRendered.content]) {
                assert.equal(content.includes('usable: false'), true);
                assert.equal(content.includes('downgradePolicy'), true);
                assert.equal(content.includes('不得将“未查询到节点”推断为“不存在业务关系”'), true);
            }
            assert.equal(staleRendered.content.includes('freshness: stale'), true);
            assert.equal(missingRendered.content.includes('freshness: missing'), true);
        } finally {
            cleanup(workspaceRoot);
        }
    });
});