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
});
