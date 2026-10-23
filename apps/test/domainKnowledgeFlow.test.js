'use strict';

/**
 * 领域知识流转回归覆盖基线。
 * Coverage: Req-dk-5, Req-dk-6, Req-dk-7, Req-dk-10, Req-dk-11, Req-dk-12.
 *
 * 覆盖场景：
 * 1. 主面板不得回流展示旧版 domain governance 入口，避免与新子面板流程混用。
 * 2. 子面板上下文、路由可达性、聚合入口与 UI 约束必须保持一致。
 * 3. capability-delta 聚合链路要能在最小有效输入下跑通，并对阻断条件维持稳定行为。
 *
 * 这组测试守护的是“领域知识能力只能沿既定子面板/聚合链路流转，不被旧入口或 UI 旁路破坏”。
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
const { CodeGraphDedupeGuard } = require('../out/services/codegraph/codeGraphDedupeGuard');
const { CodeGraphInitOrchestrator } = require('../out/services/codegraph/codeGraphInitOrchestrator');

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

describe('领域知识流转覆盖基线', () => {
    test('CodeGraph 自动安装失败时返回 warning 且不抛异常，主流程可继续（Req-3, Req-4）', async () => {
        const records = [];
        const orchestrator = new CodeGraphInitOrchestrator(
            new CodeGraphDedupeGuard(),
            {
                ensureCli() {
                    return {
                        ready: false,
                        installedNow: false,
                        summary: 'auto install failed: missing permissions',
                    };
                },
            },
            {
                runInitBuild() {
                    throw new Error('build should not run when ensureCli is not ready');
                },
            },
            {
                appendRunRecord(record) {
                    records.push(record);
                    return { persisted: true, logPath: 'mock-log' };
                },
            },
        );

        const first = await orchestrator.runOnce({
            sessionId: 'session-a',
            worktreePath: '/tmp/worktree-a',
            featureId: 'feature-a',
            taskName: 'task-a',
            entryPoint: 'openFolderLocationByFeatureId',
            autoCodeGraphEnabled: true,
            autoInstallEnabled: true,
        });
        const second = await orchestrator.runOnce({
            sessionId: 'session-a',
            worktreePath: '/tmp/worktree-b',
            featureId: 'feature-b',
            taskName: 'task-b',
            entryPoint: 'runCustomButtonByFeatureId',
            autoCodeGraphEnabled: true,
            autoInstallEnabled: true,
        });

        assert.equal(first.status, 'warning');
        assert.equal(second.status, 'warning');
        assert.equal(first.summary.includes('auto install failed'), true);
        assert.equal(second.summary.includes('auto install failed'), true);
        assert.equal(records.length, 2);
        assert.deepEqual(
            records.map(item => item.entryPoint).sort(),
            ['openFolderLocationByFeatureId', 'runCustomButtonByFeatureId'],
        );
    });

    test('已存在 .codegraph 时跳过重建且不触发安装/构建（Req-4）', async () => {
        const tmpDir = makeTempDir();
        try {
            fs.mkdirSync(path.join(tmpDir, '.codegraph'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codegraph', 'codegraph.db'), 'mock');

            let ensureCliCalls = 0;
            let buildCalls = 0;
            let snapshotCalls = 0;
            const records = [];
            const orchestrator = new CodeGraphInitOrchestrator(
                new CodeGraphDedupeGuard(),
                {
                    ensureCli() {
                        ensureCliCalls += 1;
                        return {
                            ready: true,
                            installedNow: false,
                            summary: 'ready',
                        };
                    },
                },
                {
                    runInitBuild() {
                        buildCalls += 1;
                        return {
                            status: 'success',
                            summary: 'unexpected build run',
                            startedAt: new Date().toISOString(),
                            endedAt: new Date().toISOString(),
                        };
                    },
                },
                {
                    appendRunRecord(record) {
                        records.push(record);
                        return { persisted: true, logPath: 'mock-log' };
                    },
                },
                {
                    writeSnapshot() {
                        snapshotCalls += 1;
                        return {
                            persisted: true,
                            bundlePath: path.join(tmpDir, '.harness', 'process', 'codegraph-evidence.json'),
                            summary: 'evidence snapshot refreshed',
                        };
                    },
                },
            );

            const result = await orchestrator.runOnce({
                sessionId: 'session-skip',
                worktreePath: tmpDir,
                featureId: 'feature-skip',
                taskName: 'task-skip',
                entryPoint: 'openFolderLocationByFeatureId',
                autoCodeGraphEnabled: true,
                autoInstallEnabled: true,
            });

            assert.equal(result.status, 'deduped');
            assert.equal(result.summary.includes('already initialized'), true);
            assert.equal(result.summary.includes('evidence snapshot refreshed'), true);
            assert.equal(result.summary.includes('AGENTS.md'), true);
            assert.equal(ensureCliCalls, 0);
            assert.equal(buildCalls, 0);
            assert.equal(snapshotCalls, 1);
            assert.equal(records.length, 1);
            assert.equal(records[0].status, 'deduped');
        } finally {
            cleanup(tmpDir);
        }
    });

    test('CodeGraph 初始化成功后自动写入 AGENTS.md 复用说明且幂等（Req-4）', async () => {
        const tmpDir = makeTempDir();
        try {
            const records = [];
            const orchestrator = new CodeGraphInitOrchestrator(
                new CodeGraphDedupeGuard(),
                {
                    ensureCli() {
                        return {
                            ready: true,
                            installedNow: false,
                            summary: 'ready',
                        };
                    },
                },
                {
                    runInitBuild() {
                        fs.mkdirSync(path.join(tmpDir, '.codegraph', 'evidence'), { recursive: true });
                        return {
                            status: 'success',
                            summary: 'build ok',
                            startedAt: new Date().toISOString(),
                            endedAt: new Date().toISOString(),
                        };
                    },
                },
                {
                    appendRunRecord(record) {
                        records.push(record);
                        return { persisted: true, logPath: 'mock-log' };
                    },
                },
                {
                    writeSnapshot() {
                        return {
                            persisted: true,
                            bundlePath: path.join(tmpDir, '.harness', 'process', 'codegraph-evidence.json'),
                            summary: 'evidence snapshot refreshed',
                        };
                    },
                },
            );

            const first = await orchestrator.runOnce({
                sessionId: 'session-guide',
                worktreePath: tmpDir,
                featureId: 'feature-guide',
                taskName: 'task-guide',
                entryPoint: 'openFolderLocationByFeatureId',
                autoCodeGraphEnabled: true,
                autoInstallEnabled: true,
            });

            const agentsPath = path.join(tmpDir, 'AGENTS.md');
            const firstContent = fs.readFileSync(agentsPath, 'utf8');
            assert.equal(first.status, 'success');
            assert.equal(first.summary.includes('AGENTS.md'), true);
            assert.equal(firstContent.includes('FUN_HARNESS_CODEGRAPH_USAGE_START'), true);
            assert.equal(firstContent.includes('CodeGraph 复用方法（自动写入）'), true);

            const second = await orchestrator.runOnce({
                sessionId: 'session-guide-2',
                worktreePath: tmpDir,
                featureId: 'feature-guide-2',
                taskName: 'task-guide-2',
                entryPoint: 'syncCodeGraphByFeatureId',
                autoCodeGraphEnabled: true,
                autoInstallEnabled: true,
            });

            const secondContent = fs.readFileSync(agentsPath, 'utf8');
            const markerMatches = secondContent.match(/FUN_HARNESS_CODEGRAPH_USAGE_START/g) || [];
            assert.equal(second.status, 'deduped');
            assert.equal(markerMatches.length, 1);
            assert.equal(second.summary.includes('AGENTS.md already exists; skip auto write to avoid growth'), true);
            assert.equal(records.length, 2);
        } finally {
            cleanup(tmpDir);
        }
    });

    // ── Updated: legacy main-panel domain actions must be absent (INV-1, Req-1) ──
    test('main panel DOES NOT render legacy domain governance actions (INV-1, Req-1)', () => {
        const view = buildTaskView();

        const mainHtml = buildMainPageHtml([view], {}, {
            isWorktreeSubview: false,
            aiProvider: 'copilot',
            customButtons: [],
            autoPollEnabled: false,
        });

        // Legacy actions must be absent from main panel (INV-1, Req-1).
        assert.equal(mainHtml.includes('data-domain-action="runDomainBaselineAggregation"'), false);
        assert.equal(mainHtml.includes('data-domain-action="applyDomainAdjudication"'), false);
        assert.equal(mainHtml.includes('data-domain-action="commitDomainBaseline"'), false);
        assert.equal(mainHtml.includes('data-domain-action="previewDomainBaselineSummary"'), false);

        const worktreeHtml = buildMainPageHtml([view], {}, {
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

        assert.equal(worktreeHtml.includes('data-domain-action="runDomainBaselineAggregation"'), false);
        assert.equal(worktreeHtml.includes('data-domain-action="applyDomainAdjudication"'), false);
        assert.equal(worktreeHtml.includes('data-domain-action="commitDomainBaseline"'), false);
        assert.equal(worktreeHtml.includes('data-domain-action="previewDomainBaselineSummary"'), false);
    });

    // ── Updated: route contract now uses subpanel message routes (INV-1, Req-1) ──
    test('message/command route contract: legacy domain routes removed, new subpanel routes present (INV-1, Req-1)', () => {
        const controllerPath = path.join(__dirname, '..', 'src', 'harnessMessageController.ts');
        const extensionPath = path.join(__dirname, '..', 'src', 'extension.ts');

        const controllerSource = fs.readFileSync(controllerPath, 'utf8');
        const extensionSource = fs.readFileSync(extensionPath, 'utf8');

        // Legacy domain cases must be gone (INV-1).
        assert.equal(controllerSource.includes("case 'runDomainBaselineAggregation':"), false);
        assert.equal(controllerSource.includes("case 'reviewSuspectedDomains':"), false);
        assert.equal(controllerSource.includes("case 'commitDomainBaseline':"), false);
        assert.equal(controllerSource.includes("case 'previewDomainBaselineSummary':"), false);

        // New subpanel domain routes must be present (ROUTE-1..ROUTE-9).
        assert.equal(controllerSource.includes("case 'openDomainKnowledgeWorkspace':"), true);
        assert.equal(controllerSource.includes("case 'loadDomainKnowledgeContext':"), true);
        assert.equal(controllerSource.includes("case 'updateDomainChangeSet':"), true);
        assert.equal(controllerSource.includes("case 'previewDomainProjection':"), true);
        assert.equal(controllerSource.includes("case 'detectDomainConflicts':"), true);
        assert.equal(controllerSource.includes("case 'resolveDomainConflict':"), true);
        assert.equal(controllerSource.includes("case 'commitDomainKnowledgeChanges':"), true);
        assert.equal(controllerSource.includes("case 'refreshBaselineAndReproject':"), true);
        assert.equal(controllerSource.includes("case 'detectDocumentMergeConflicts':"), true);

        // Legacy commands must be absent from extension.ts (INV-1).
        assert.equal(extensionSource.includes("registerCommand('fun-harness.runDomainBaselineAggregation'"), false);
        assert.equal(extensionSource.includes("registerCommand('fun-harness.reviewSuspectedDomains'"), false);
        assert.equal(extensionSource.includes("registerCommand('fun-harness.commitDomainBaseline'"), false);
        assert.equal(extensionSource.includes("registerCommand('fun-harness.previewDomainBaselineSummary'"), false);

        // New subpanel command must be registered (ROUTE-1).
        assert.equal(extensionSource.includes("registerCommand('fun-harness.openDomainKnowledgeWorkspace'"), true);

        // unregisterLegacyDomainActions must be called at startup (ROUTE-7).
        assert.equal(extensionSource.includes('unregisterLegacyDomainActions'), true);
    });

    // ── Existing tests unchanged below ──

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

    // ── Integration tests: full subpanel flow (design §6) ──

    /**
     * Full subpanel flow: loadDomainKnowledgeContext → saveDraftChangeSet → previewProjection → commitChangeSet.
     * Validates Req-1..Req-5.
     */
    test('subpanel full flow: load context → draft → project → commit writes three artifact files (Req-1..Req-5)', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const service = new DomainKnowledgeAggregateService();

            // Step 1: loadDomainKnowledgeContext (Req-1, Req-2, Req-7)
            const context = service.loadDomainKnowledgeContext(root, 'subpanel-iter');
            assert.ok(context.baselineVersion);
            assert.ok(Array.isArray(context.registry.domains));
            assert.ok(context.draftChangeSet);
            assert.equal(context.draftChangeSet.iterationId, 'subpanel-iter');

            // Step 2: Build change set (simulate saveDraftChangeSet) (Req-2, Req-6)
            const changeSet = {
                iterationId: 'subpanel-iter',
                basedOnBaselineVersion: context.baselineVersion,
                sourceRevisionSet: context.draftChangeSet.sourceRevisionSet,
                updatedAt: new Date().toISOString(),
                domainChanges: [
                    { reqId: 'Req-401', canonicalDomain: 'billing', rawDomain: 'billing', title: 'Flow capability', userStory: 'As user…', changeType: 'add', status: 'active', contracts: [], invariants: [] },
                ],
            };
            const { savedDraft, dirty } = service.saveDraftChangeSet(root, 'subpanel-iter', changeSet);
            assert.equal(dirty, true);
            assert.equal(savedDraft.domainChanges.length, 1);

            // Step 3: previewProjection – no write side effect (Req-2, INV-3)
            const projection = service.previewProjection(
                savedDraft,
                context.baselineVersion,
                context.baselineSnapshot,
                context.registry,
            );
            assert.equal(projection.conflicts.filter(c => c.severity === 'blocking').length, 0);
            assert.ok(projection.projectedDomains.some(d => d.canonicalDomain === 'billing'));

            // Step 4: commitChangeSet produces domain-change-set.json + domain.md + _index.md (Req-3, Req-6)
            const indexPath = path.join(root, 'docs', 'domains', '_index.md');
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            fs.writeFileSync(indexPath, '<!-- AUTO:index:start -->\n<!-- AUTO:index:end -->\n<!-- HUMAN:notes:start -->\n<!-- HUMAN:notes:end -->\n', 'utf8');

            const summary = service.commitChangeSet(
                root, savedDraft, context.baselineVersion,
                savedDraft.sourceRevisionSet, false, 'deterministic-v1', [],
            );
            assert.equal(summary.skippedAsNoChange, false);
            assert.equal(summary.processedDomains, 1);
            assert.ok(summary.processedCapabilities >= 1);
            assert.ok(summary.writtenFiles.some(f => f.endsWith('domain-change-set.json')));
            assert.ok(summary.writtenFiles.some(f => f.endsWith('billing.md')));
            assert.ok(summary.writtenFiles.some(f => f.endsWith('_index.md')));

            // Verify domain doc contains Req-* traceable field (Req-6).
            const domainDocPath = path.join(root, 'docs', 'domains', 'billing.md');
            const domainContent = fs.readFileSync(domainDocPath, 'utf8');
            assert.ok(domainContent.includes('Req-401'));
        } finally {
            cleanup(root);
        }
    });

    test('subpanel baseline drift blocks commit and requires refreshBaselineAndReproject (Req-4, Req-8)', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const service = new DomainKnowledgeAggregateService();
            const context = service.loadDomainKnowledgeContext(root, 'drift-iter');

            // Use a stale baselineVersion in the changeSet.
            const changeSet = {
                iterationId: 'drift-iter',
                basedOnBaselineVersion: 'v-STALE-VERSION',
                sourceRevisionSet: context.draftChangeSet.sourceRevisionSet,
                updatedAt: new Date().toISOString(),
                domainChanges: [
                    { reqId: 'Req-501', canonicalDomain: 'billing', rawDomain: 'billing', title: 'Drift test', userStory: '', changeType: 'add', status: 'active', contracts: [], invariants: [] },
                ],
            };

            // Commit must be blocked due to baseline-version mismatch (Req-4, Req-8, INV-12).
            assert.throws(
                () => service.commitChangeSet(root, changeSet, context.baselineVersion, changeSet.sourceRevisionSet, false, 'deterministic-v1', []),
                /DOMAIN_COMMIT_BLOCKED/,
            );

            // refreshBaselineAndReproject must return latest version (Req-4, INV-12).
            const refresh = service.refreshBaselineAndReproject(root, changeSet, 'v-STALE-VERSION', changeSet.sourceRevisionSet);
            assert.equal(refresh.latestBaselineVersion, context.baselineVersion);
            assert.ok(refresh.projection);
        } finally {
            cleanup(root);
        }
    });

    test('subpanel idempotent: equivalent commits do not produce duplicate writes (Req-3, Req-8, INV-11)', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const service = new DomainKnowledgeAggregateService();
            const context = service.loadDomainKnowledgeContext(root, 'idem-flow');

            const changeSet = {
                iterationId: 'idem-flow',
                basedOnBaselineVersion: context.baselineVersion,
                sourceRevisionSet: context.draftChangeSet.sourceRevisionSet,
                updatedAt: new Date().toISOString(),
                domainChanges: [
                    { reqId: 'Req-601', canonicalDomain: 'billing', rawDomain: 'billing', title: 'Idem flow', userStory: '', changeType: 'add', status: 'active', contracts: [], invariants: [] },
                ],
            };

            const indexPath = path.join(root, 'docs', 'domains', '_index.md');
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            fs.writeFileSync(indexPath, '<!-- AUTO:index:start -->\n<!-- AUTO:index:end -->\n<!-- HUMAN:notes:start -->\n<!-- HUMAN:notes:end -->\n', 'utf8');

            const first = service.commitChangeSet(root, changeSet, context.baselineVersion, changeSet.sourceRevisionSet, false, 'deterministic-v1', []);
            assert.equal(first.skippedAsNoChange, false);

            // Second equivalent commit must return skippedAsNoChange=true (INV-11).
            const second = service.commitChangeSet(root, changeSet, context.baselineVersion, changeSet.sourceRevisionSet, false, 'deterministic-v1', []);
            assert.equal(second.skippedAsNoChange, true);
            assert.equal(first.commitId, second.commitId);
        } finally {
            cleanup(root);
        }
    });

    test('subpanel load: loadDomainKnowledgeContext fails with DOMAIN_REGISTRY_INVALID when registry is broken (Req-1, Req-7)', () => {
        const root = makeTempDir();
        try {
            // Write deliberately invalid registry: duplicate canonical.
            const registryPath = path.join(root, 'docs', 'domains', 'registry.yaml');
            fs.mkdirSync(path.dirname(registryPath), { recursive: true });
            fs.writeFileSync(registryPath, [
                'domains:',
                '  - canonical: billing',
                '    displayName: Billing',
                '    aliases: []',
                '    status: active',
                '  - canonical: billing',
                '    displayName: Billing Dup',
                '    aliases: []',
                '    status: active',
                '',
            ].join('\n'), 'utf8');

            const service = new DomainKnowledgeAggregateService();
            assert.throws(
                () => service.loadDomainKnowledgeContext(root, 'broken-iter'),
                /DOMAIN_REGISTRY_INVALID/,
            );
        } finally {
            cleanup(root);
        }
    });
});
