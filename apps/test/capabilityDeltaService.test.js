'use strict';

/**
 * Unit tests for CapabilityDeltaService.
 * Coverage: schema validation, stable hash, deterministic extraction output.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CapabilityDeltaService } = require('../out/services/capabilityDeltaService');

/** Create isolated temp workspace. */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dk-delta-'));
}

/** Remove temp workspace best-effort. */
function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors in tests
    }
}

/** Write registry YAML used by extractor. */
function writeRegistry(repoRoot) {
    const filePath = path.join(repoRoot, 'docs', 'domains', 'registry.yaml');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
        'domains:',
        '  - canonical: billing',
        '    displayName: Billing',
        '    aliases: [payments]',
        '    status: active',
        '',
    ].join('\n'), 'utf8');
}

/** Write minimal requirements/design machine blocks for deterministic extraction. */
function writeIterationArtifacts(repoRoot, iteration) {
    const iterDir = path.join(repoRoot, 'specs', iteration);
    fs.mkdirSync(iterDir, { recursive: true });

    const requirementsContent = [
        '# Requirements',
        '```yaml',
        'artifactType: requirements',
        'requirements:',
        '  - id: Req-billing-1',
        '    domain: billing',
        '    title: Collect invoice status',
        '    userStory: As user I need invoice status',
        '```',
        '',
    ].join('\n');

    const designContent = [
        '# Design',
        '```yaml',
        'artifactType: design',
        'apiContracts:',
        '  - id: API-BILL-1',
        '    requirementIds: [Req-billing-1]',
        '    method: get',
        '    path: /billing/invoices/{id}',
        '    request:',
        '      id: string',
        '    response:',
        '      status: string',
        'invariants:',
        '  - id: INV-BILL-1',
        '    requirementId: Req-billing-1',
        '    rule: invoice id must be non-empty',
        '```',
        '',
    ].join('\n');

    fs.writeFileSync(path.join(iterDir, 'requirements.md'), requirementsContent, 'utf8');
    fs.writeFileSync(path.join(iterDir, 'design.md'), designContent, 'utf8');
    return iterDir;
}

describe('CapabilityDeltaService', () => {
    test('validateDelta fails when required fields are missing', () => {
        const service = new CapabilityDeltaService();
        const result = service.validateDelta({
            iteration: '',
            generatedAt: '',
            contentHash: '',
            domains: [
                {
                    canonical: 'billing',
                    rawDomain: null,
                    isSuspectedNew: false,
                    capabilities: [],
                    contracts: [],
                    invariants: [],
                },
            ],
        });

        assert.equal(result.valid, false);
        assert.equal(result.errors.length > 0, true);
    });

    test('validateDelta computes stable content hash regardless of input order', () => {
        const service = new CapabilityDeltaService();

        const deltaA = {
            iteration: 'iter-a',
            generatedAt: '2026-01-01T00:00:00.000Z',
            contentHash: '',
            domains: [
                {
                    canonical: 'platform',
                    rawDomain: null,
                    isSuspectedNew: false,
                    capabilities: [
                        { reqId: 'Req-2', title: 'B', userStory: 'story-b', status: 'active' },
                        { reqId: 'Req-1', title: 'A', userStory: 'story-a', status: 'active' },
                    ],
                    contracts: [],
                    invariants: [],
                },
                {
                    canonical: 'billing',
                    rawDomain: null,
                    isSuspectedNew: false,
                    capabilities: [],
                    contracts: [],
                    invariants: [],
                },
            ],
        };

        const deltaB = {
            iteration: 'iter-a',
            generatedAt: '2026-01-01T00:00:00.000Z',
            contentHash: '',
            domains: [
                {
                    canonical: 'billing',
                    rawDomain: null,
                    isSuspectedNew: false,
                    capabilities: [],
                    contracts: [],
                    invariants: [],
                },
                {
                    canonical: 'platform',
                    rawDomain: null,
                    isSuspectedNew: false,
                    capabilities: [
                        { reqId: 'Req-1', title: 'A', userStory: 'story-a', status: 'active' },
                        { reqId: 'Req-2', title: 'B', userStory: 'story-b', status: 'active' },
                    ],
                    contracts: [],
                    invariants: [],
                },
            ],
        };

        const a = service.validateDelta(deltaA);
        const b = service.validateDelta(deltaB);

        assert.equal(a.valid, true);
        assert.equal(b.valid, true);
        assert.equal(a.contentHash, b.contentHash);
    });

    test('generateForIteration is deterministic for same requirements/design inputs', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const iterDir = writeIterationArtifacts(root, 'iter-deterministic');

            const service = new CapabilityDeltaService();
            const first = service.generateForIteration(root, iterDir);
            const second = service.generateForIteration(root, iterDir);

            assert.equal(first.validation.valid, true);
            assert.equal(second.validation.valid, true);
            assert.equal(first.delta.contentHash, second.delta.contentHash);
            assert.equal(first.delta.generatedAt, second.delta.generatedAt);
            assert.equal(fs.existsSync(first.deltaPath), true);
        } finally {
            cleanup(root);
        }
    });

    test('generateForIteration falls back to specs/<iteration> when iterationPath points to worktree root', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            writeIterationArtifacts(root, 'asset-label');

            const worktreeRoot = path.join(root, 'asset-label');
            fs.mkdirSync(worktreeRoot, { recursive: true });

            const service = new CapabilityDeltaService();
            const result = service.generateForIteration(root, worktreeRoot);

            assert.equal(result.validation.valid, true);
            assert.equal(result.delta.iteration, 'asset-label');
            assert.equal(fs.existsSync(result.deltaPath), true);
            assert.equal(
                result.deltaPath.endsWith(path.join('specs', 'asset-label', 'delta', 'capability-delta.json')),
                true,
            );
        } finally {
            cleanup(root);
        }
    });

    test('generateForIteration normalizes dictionary requirement titles into capability wording', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const iterDir = path.join(root, 'specs', 'dictionary-governance');
            fs.mkdirSync(iterDir, { recursive: true });

            const requirementsContent = [
                '# Requirements',
                '```yaml',
                'artifactType: requirements',
                'requirements:',
                '  - id: Req-1',
                '    domain: billing',
                '    title: 迁移 business_dictionary 数据到统一字典表',
                '    userStory: 作为数据库维护员，我希望将旧表数据迁移到统一字典表',
                '```',
                '',
            ].join('\n');

            const designContent = [
                '# Design',
                '```yaml',
                'artifactType: design',
                'apiContracts: []',
                'invariants: []',
                '```',
                '',
            ].join('\n');

            fs.writeFileSync(path.join(iterDir, 'requirements.md'), requirementsContent, 'utf8');
            fs.writeFileSync(path.join(iterDir, 'design.md'), designContent, 'utf8');

            const service = new CapabilityDeltaService();
            const result = service.generateForIteration(root, iterDir);
            assert.equal(result.validation.valid, true);
            assert.equal(result.delta.domains[0].capabilities[0].title, '字典数据迁移与兼容能力');
        } finally {
            cleanup(root);
        }
    });

    test('generateForIteration preserves suggested rawDomain when domain falls back to uncategorized', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const iterDir = path.join(root, 'specs', 'suggested-domain');
            fs.mkdirSync(iterDir, { recursive: true });

            const requirementsContent = [
                '# Requirements',
                '```yaml',
                'artifactType: requirements',
                'requirements:',
                '  - id: Req-1',
                '    domain: uncategorized',
                '    rawDomain: asset-label-association',
                '    title: 维护资产标签关联关系',
                '    userStory: 作为运营人员，我希望维护资产与标签的关联关系',
                '```',
                '',
            ].join('\n');

            const designContent = [
                '# Design',
                '```yaml',
                'artifactType: design',
                'apiContracts: []',
                'invariants: []',
                '```',
                '',
            ].join('\n');

            fs.writeFileSync(path.join(iterDir, 'requirements.md'), requirementsContent, 'utf8');
            fs.writeFileSync(path.join(iterDir, 'design.md'), designContent, 'utf8');

            const service = new CapabilityDeltaService();
            const result = service.generateForIteration(root, iterDir);

            assert.equal(result.validation.valid, true);
            assert.equal(result.delta.domains.length, 1);
            assert.equal(result.delta.domains[0].canonical, null);
            assert.equal(result.delta.domains[0].rawDomain, 'asset-label-association');
            assert.equal(result.delta.domains[0].isSuspectedNew, true);
        } finally {
            cleanup(root);
        }
    });

    // ── New tests for MergeConflictService (Task 2.3) via domainKnowledgeAggregateService ──

    test('detectDocumentMergeConflicts auto-merges when only draft changed (Req-4, Req-8)', () => {
        const { DomainKnowledgeAggregateService } = require('../out/services/domainKnowledgeAggregateService');
        const service = new DomainKnowledgeAggregateService();

        const baseDoc = { canonicalDomain: 'billing', version: 'v0', capabilities: [{ reqId: 'Req-1', title: 'A', userStory: '', status: 'active' }], contracts: [], invariants: [], markdownContent: '' };
        const currentDoc = { ...baseDoc }; // current unchanged
        const draftDoc = { ...baseDoc, capabilities: [{ reqId: 'Req-1', title: 'A-updated', userStory: '', status: 'active' }] }; // draft changed

        const { conflicts, autoMergedDocuments } = service.detectDocumentMergeConflicts([baseDoc], [currentDoc], [draftDoc]);
        assert.equal(conflicts.length, 0);
        assert.equal(autoMergedDocuments[0].capabilities[0].title, 'A-updated');
    });

    test('detectDocumentMergeConflicts produces document-merge blocking conflict when both changed differently (Req-4, Req-5)', () => {
        const { DomainKnowledgeAggregateService } = require('../out/services/domainKnowledgeAggregateService');
        const service = new DomainKnowledgeAggregateService();

        const baseDoc = { canonicalDomain: 'billing', version: 'v0', capabilities: [{ reqId: 'Req-1', title: 'Original', userStory: '', status: 'active' }], contracts: [], invariants: [], markdownContent: '' };
        const currentDoc = { ...baseDoc, capabilities: [{ reqId: 'Req-1', title: 'Current changed', userStory: '', status: 'active' }] };
        const draftDoc = { ...baseDoc, capabilities: [{ reqId: 'Req-1', title: 'Draft changed', userStory: '', status: 'active' }] };

        const { conflicts } = service.detectDocumentMergeConflicts([baseDoc], [currentDoc], [draftDoc]);
        assert.ok(conflicts.some(c => c.type === 'document-merge' && c.severity === 'blocking'));
    });

    test('detectDocumentMergeConflicts auto-merges when both changed to same value (Req-4, Req-8)', () => {
        const { DomainKnowledgeAggregateService } = require('../out/services/domainKnowledgeAggregateService');
        const service = new DomainKnowledgeAggregateService();

        const baseDoc = { canonicalDomain: 'billing', version: 'v0', capabilities: [{ reqId: 'Req-1', title: 'Original', userStory: '', status: 'active' }], contracts: [], invariants: [], markdownContent: '' };
        const updatedCap = { reqId: 'Req-1', title: 'Same update', userStory: '', status: 'active' };
        const currentDoc = { ...baseDoc, capabilities: [updatedCap] };
        const draftDoc = { ...baseDoc, capabilities: [updatedCap] };

        const { conflicts } = service.detectDocumentMergeConflicts([baseDoc], [currentDoc], [draftDoc]);
        assert.equal(conflicts.length, 0);
    });
});
