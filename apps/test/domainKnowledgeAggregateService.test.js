'use strict';

/**
 * Unit tests for DomainKnowledgeAggregateService.
 * Coverage: marker upsert behavior, idempotent aggregation skip, removed/deprecated retention.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DomainKnowledgeAggregateService } = require('../out/services/domainKnowledgeAggregateService');
const { CapabilityDeltaService } = require('../out/services/capabilityDeltaService');

/** Create isolated temp workspace. */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dk-agg-'));
}

/** Remove temp workspace best-effort. */
function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors in tests
    }
}

/** Write registry YAML with one active canonical. */
function writeRegistry(root) {
    const filePath = path.join(root, 'docs', 'domains', 'registry.yaml');
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

/** Build a valid delta payload and persist under specs/<iteration>/delta/capability-delta.json. */
function writeDelta(root, iteration, domainDelta) {
    const service = new CapabilityDeltaService();
    const draft = {
        iteration,
        generatedAt: '2026-01-01T00:00:00.000Z',
        contentHash: '',
        domains: [domainDelta],
    };
    const validation = service.validateDelta(draft);
    assert.equal(validation.valid, true);
    const payload = { ...draft, contentHash: validation.contentHash };

    const deltaPath = path.join(root, 'specs', iteration, 'delta', 'capability-delta.json');
    fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
    fs.writeFileSync(deltaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
}

/** Read generated domain markdown. */
function readDomainDoc(root, canonical) {
    return fs.readFileSync(path.join(root, 'docs', 'domains', `${canonical}.md`), 'utf8');
}

describe('DomainKnowledgeAggregateService', () => {
    test('upsertDomainDocument preserves HUMAN blocks after AUTO updates', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const service = new DomainKnowledgeAggregateService();

            const docPath = path.join(root, 'docs', 'domains', 'billing.md');
            fs.mkdirSync(path.dirname(docPath), { recursive: true });
            fs.writeFileSync(docPath, [
                '---',
                'domain: billing',
                'displayName: Billing',
                'lastUpdatedAt: 2026-01-01T00:00:00.000Z',
                'contributingIterations: []',
                '---',
                '',
                '## 领域概述',
                '<!-- HUMAN:overview:start -->',
                'HUMAN_OVERVIEW_KEEP_ME',
                '<!-- HUMAN:overview:end -->',
                '',
                '## 能力清单',
                '<!-- AUTO:capabilities:start -->',
                '| Req-ID | Title | Status | First Introduced | Last Changed |',
                '| --- | --- | --- | --- | --- |',
                '<!-- AUTO:capabilities:end -->',
                '',
                '## API 契约',
                '<!-- AUTO:contracts:start -->',
                '| Key | Req-ID | Method | Path | Request | Response |',
                '| --- | --- | --- | --- | --- | --- |',
                '<!-- AUTO:contracts:end -->',
                '',
                '## 关键规则与不变量',
                '<!-- AUTO:invariants:start -->',
                '- 暂无',
                '<!-- AUTO:invariants:end -->',
                '',
                '## 补充说明',
                '<!-- HUMAN:notes:start -->',
                'HUMAN_NOTES_KEEP_ME',
                '<!-- HUMAN:notes:end -->',
                '',
                '## 变更历史',
                '<!-- AUTO:changelog:start -->',
                '- 初始化',
                '<!-- AUTO:changelog:end -->',
                '',
            ].join('\n'), 'utf8');

            service.upsertDomainDocument({
                repoRoot: root,
                canonical: 'billing',
                registryEntry: { canonical: 'billing', displayName: 'Billing', aliases: ['payments'], status: 'active' },
                iteration: 'iter-human',
                generatedAt: '2026-01-02T00:00:00.000Z',
                domainDelta: {
                    canonical: 'billing',
                    rawDomain: 'payments',
                    isSuspectedNew: false,
                    capabilities: [
                        { reqId: 'Req-1', title: 'Track billing summary', userStory: 'story', status: 'active' },
                    ],
                    contracts: [],
                    invariants: [],
                },
            });

            const content = readDomainDoc(root, 'billing');
            assert.equal(content.includes('HUMAN_OVERVIEW_KEEP_ME'), true);
            assert.equal(content.includes('HUMAN_NOTES_KEEP_ME'), true);
            assert.equal(content.includes('Req-1'), true);
        } finally {
            cleanup(root);
        }
    });

    test('aggregatePendingDeltas skips already aggregated iteration+contentHash', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            writeDelta(root, 'iter-skip', {
                canonical: 'billing',
                rawDomain: 'payments',
                isSuspectedNew: false,
                capabilities: [
                    { reqId: 'Req-skip-1', title: 'Keep one changelog entry', userStory: 'story', status: 'active' },
                ],
                contracts: [],
                invariants: [],
            });

            const service = new DomainKnowledgeAggregateService();
            const first = service.aggregatePendingDeltas(root, false);
            const second = service.aggregatePendingDeltas(root, false);

            assert.equal(first.processed.length, 1);
            assert.equal(second.processed.length, 0);
            assert.equal(second.skipped.some(item => item.reason === 'already-aggregated'), true);

            const content = readDomainDoc(root, 'billing');
            const changelogLines = content
                .split(/\r?\n/)
                .filter(line => line.includes('iter-skip') && line.trim().startsWith('- '));
            assert.equal(changelogLines.length, 1);
        } finally {
            cleanup(root);
        }
    });

    test('removed/deprecated capability rows are retained and updated, not deleted', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root);
            const service = new DomainKnowledgeAggregateService();

            const baseEntry = { canonical: 'billing', displayName: 'Billing', aliases: ['payments'], status: 'active' };

            service.upsertDomainDocument({
                repoRoot: root,
                canonical: 'billing',
                registryEntry: baseEntry,
                iteration: 'iter-a',
                generatedAt: '2026-01-01T00:00:00.000Z',
                domainDelta: {
                    canonical: 'billing',
                    rawDomain: 'payments',
                    isSuspectedNew: false,
                    capabilities: [
                        { reqId: 'Req-keep', title: 'Keep capability row', userStory: 'story', status: 'active' },
                        { reqId: 'Req-remove', title: 'Will become removed', userStory: 'story', status: 'active' },
                    ],
                    contracts: [],
                    invariants: [],
                },
            });

            service.upsertDomainDocument({
                repoRoot: root,
                canonical: 'billing',
                registryEntry: baseEntry,
                iteration: 'iter-b',
                generatedAt: '2026-01-02T00:00:00.000Z',
                domainDelta: {
                    canonical: 'billing',
                    rawDomain: 'payments',
                    isSuspectedNew: false,
                    capabilities: [
                        { reqId: 'Req-remove', title: 'Will become removed', userStory: 'story', status: 'removed' },
                    ],
                    contracts: [],
                    invariants: [],
                },
            });

            const content = readDomainDoc(root, 'billing');
            assert.equal(content.includes('Req-keep'), true);
            assert.equal(content.includes('Req-remove'), true);
            assert.equal(content.includes('| Req-remove | Will become removed | removed |'), true);
        } finally {
            cleanup(root);
        }
    });
});
