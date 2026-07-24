'use strict';

/**
 * Flow tests for domain-knowledge orchestration and UI/route constraints.
 * Coverage: Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-10, Req-dk-11, Req-dk-12.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMainPageHtml } = require('../out/webviewTemplates');
const { STAGE } = require('../out/models');
const { CapabilityDeltaService } = require('../out/services/capabilityDeltaService');
const { DomainKnowledgeAggregateService } = require('../out/services/domainKnowledgeAggregateService');

/** Create isolated temp workspace. */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dk-flow-'));
}

/** Remove temp workspace best-effort. */
function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors in tests
    }
}

/** Write minimal domain registry for aggregation tests. */
function writeRegistry(repoRoot) {
    const registryPath = path.join(repoRoot, 'docs', 'domains', 'registry.yaml');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, [
        'domains:',
        '  - canonical: billing',
        '    displayName: Billing',
        '    aliases: [payments]',
        '    status: active',
        '',
    ].join('\n'), 'utf8');
}

/** Persist one valid capability-delta payload under specs/<iteration>/delta. */
function writeDelta(repoRoot, iteration, domainDelta) {
    const capabilityDeltaService = new CapabilityDeltaService();
    const draft = {
        iteration,
        generatedAt: '2026-01-01T00:00:00.000Z',
        contentHash: '',
        domains: [domainDelta],
    };
    const validation = capabilityDeltaService.validateDelta(draft);
    assert.equal(validation.valid, true);

    const payload = {
        ...draft,
        contentHash: validation.contentHash,
    };

    const deltaPath = path.join(repoRoot, 'specs', iteration, 'delta', 'capability-delta.json');
    fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
    fs.writeFileSync(deltaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
}

/** Build one minimal main-page task view for HTML rendering assertions. */
function buildTaskView() {
    return {
        task: {
            id: 'task-1',
            name: 'Task One',
            desc: 'desc',
            stage: STAGE.DEVELOPING,
            quickMode: false,
            autoAdvanceEnabled: true,
            autoRepairEnabled: false,
            aiProvider: 'copilot',
        },
        stats: { todo: 0, doing: 0, done: 0, failed: 0, total: 0 },
        pct: 0,
        subTasks: [],
        latestFailureReason: '',
        isAuto: false,
        artifacts: {
            requirements: true,
            requirementsReady: true,
            design: true,
            designReady: true,
            testcase: false,
            tasks: false,
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

describe('DomainKnowledge flow constraints', () => {
    test('main panel renders exactly the three governance entries, worktree panel does not render them', () => {
        const view = buildTaskView();

        const mainHtml = buildMainPageHtml([view], {}, {
            compactTaskDecomposition: false,
            isWorktreeSubview: false,
            aiProvider: 'copilot',
            customButtons: [],
            autoPollEnabled: false,
        });

        assert.equal(mainHtml.includes('Aggregate domain baselines'), true);
        assert.equal(mainHtml.includes('Review suspected domains'), true);
        assert.equal(mainHtml.includes('Preview domain index'), true);

        const worktreeHtml = buildMainPageHtml([view], {}, {
            compactTaskDecomposition: false,
            isWorktreeSubview: true,
            aiProvider: 'copilot',
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

        assert.equal(worktreeHtml.includes('Aggregate domain baselines'), false);
        assert.equal(worktreeHtml.includes('Review suspected domains'), false);
        assert.equal(worktreeHtml.includes('Preview domain index'), false);
    });

    test('message/command route contract keeps aggregation routes out of worktree-allowlist', () => {
        const controllerPath = path.join(__dirname, '..', 'src', 'harnessMessageController.ts');
        const extensionPath = path.join(__dirname, '..', 'src', 'extension.ts');

        const controllerSource = fs.readFileSync(controllerPath, 'utf8');
        const extensionSource = fs.readFileSync(extensionPath, 'utf8');

        assert.equal(controllerSource.includes("case 'runDomainBaselineAggregation':"), true);
        assert.equal(controllerSource.includes("case 'reviewSuspectedDomains':"), true);
        assert.equal(controllerSource.includes("case 'previewDomainBaselineSummary':"), true);

        const allowListMatch = controllerSource.match(/switch \(msg\.type\) \{([\s\S]*?)\n\s*\}/);
        const allowListSegment = allowListMatch ? allowListMatch[1] : '';
        assert.equal(allowListSegment.includes("case 'runDomainBaselineAggregation':"), false);
        assert.equal(allowListSegment.includes("case 'reviewSuspectedDomains':"), false);
        assert.equal(allowListSegment.includes("case 'previewDomainBaselineSummary':"), false);

        assert.equal(extensionSource.includes("registerCommand('fun-harness.runDomainBaselineAggregation'"), true);
        assert.equal(extensionSource.includes("registerCommand('fun-harness.reviewSuspectedDomains'"), true);
        assert.equal(extensionSource.includes("registerCommand('fun-harness.previewDomainBaselineSummary'"), true);
        assert.equal(extensionSource.includes("缺少 testcase 产物"), false);
    });

    test('aggregation consumes only delta files and ignores unrelated source code files', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const randomCodePath = path.join(root, 'apps', 'src', 'random.ts');
            fs.mkdirSync(path.dirname(randomCodePath), { recursive: true });
            fs.writeFileSync(randomCodePath, 'export const x = 1;\n', 'utf8');

            const service = new DomainKnowledgeAggregateService();
            const result = service.aggregatePendingDeltas(root, false);

            assert.equal(result.processed.length, 0);
            assert.equal(result.skipped.length, 0);
            assert.equal(result.suspectedDomains.length, 0);
            assert.equal(fs.existsSync(path.join(root, 'docs', 'domains', 'billing.md')), false);
        } finally {
            cleanup(root);
        }
    });

    test('unknown domain in delta enters suspected-domain queue', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            writeDelta(root, 'iter-suspected', {
                canonical: null,
                rawDomain: 'new-domain-x',
                isSuspectedNew: true,
                capabilities: [
                    {
                        reqId: 'Req-new-1',
                        title: 'New capability',
                        userStory: 'story',
                        status: 'active',
                    },
                ],
                contracts: [],
                invariants: [],
            });

            const service = new DomainKnowledgeAggregateService();
            const result = service.aggregatePendingDeltas(root, false);

            assert.equal(result.suspectedDomains.length, 1);
            assert.equal(result.suspectedDomains[0].rawDomain, 'new-domain-x');
            assert.equal(result.suspectedDomains[0].relatedReqIds.includes('Req-new-1'), true);
        } finally {
            cleanup(root);
        }
    });

    test('AI refinement failure does not block aggregation and falls back to structured output', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            writeDelta(root, 'iter-ai-fallback', {
                canonical: 'billing',
                rawDomain: 'payments',
                isSuspectedNew: false,
                capabilities: [
                    {
                        reqId: 'Req-ai-1',
                        title: 'Original title',
                        userStory: 'story',
                        status: 'active',
                    },
                ],
                contracts: [],
                invariants: [],
            });

            const service = new DomainKnowledgeAggregateService(
                undefined,
                undefined,
                () => {
                    throw new Error('AI unavailable');
                },
            );

            const result = service.aggregatePendingDeltas(root, true);
            assert.equal(result.processed.length, 1);

            const domainDoc = fs.readFileSync(path.join(root, 'docs', 'domains', 'billing.md'), 'utf8');
            assert.equal(domainDoc.includes('Req-ai-1'), true);
            assert.equal(domainDoc.includes('Original title'), true);
        } finally {
            cleanup(root);
        }
    });
});
