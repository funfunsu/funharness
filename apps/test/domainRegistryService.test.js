'use strict';

/**
 * Unit tests for DomainRegistryService.
 * Coverage: registry conflicts, explicit-domain priority, suspected-new behavior.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DomainRegistryService } = require('../out/services/domainRegistryService');

/** Create isolated temp workspace. */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dk-reg-'));
}

/** Remove temp workspace best-effort. */
function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors in tests
    }
}

/** Write registry YAML into docs/domains/registry.yaml. */
function writeRegistry(repoRoot, yaml) {
    const registryPath = path.join(repoRoot, 'docs', 'domains', 'registry.yaml');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, yaml, 'utf8');
    return registryPath;
}

describe('DomainRegistryService', () => {
    test('initializes missing registry.yaml with empty domains array', () => {
        const root = makeTempDir();
        try {
            const service = new DomainRegistryService();
            const result = service.loadRegistry(root);
            assert.equal(result.created, true);
            assert.equal(Array.isArray(result.registry.domains), true);
            assert.equal(result.registry.domains.length, 0);
            assert.equal(fs.existsSync(result.filePath), true);
        } finally {
            cleanup(root);
        }
    });

    test('detects duplicate canonical conflict', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root, [
                'domains:',
                '  - canonical: billing',
                '    displayName: Billing',
                '    aliases: [payments]',
                '    status: active',
                '  - canonical: billing',
                '    displayName: Billing Duplicate',
                '    aliases: [billing2]',
                '    status: active',
                '',
            ].join('\n'));

            const service = new DomainRegistryService();
            const result = service.loadRegistry(root);
            assert.equal(result.validationErrors.some(item => item.code === 'duplicate-canonical'), true);
        } finally {
            cleanup(root);
        }
    });

    test('detects alias mapped to multiple canonicals conflict', () => {
        const root = makeTempDir();
        try {
            writeRegistry(root, [
                'domains:',
                '  - canonical: billing',
                '    displayName: Billing',
                '    aliases: [shared-alias]',
                '    status: active',
                '  - canonical: platform',
                '    displayName: Platform',
                '    aliases: [shared-alias]',
                '    status: active',
                '',
            ].join('\n'));

            const service = new DomainRegistryService();
            const result = service.loadRegistry(root);
            assert.equal(result.validationErrors.some(item => item.code === 'duplicate-alias'), true);
        } finally {
            cleanup(root);
        }
    });

    test('normalizeDomain prefers explicit domain over fallback signals', () => {
        const service = new DomainRegistryService();
        const registry = {
            domains: [
                { canonical: 'billing', displayName: 'Billing', aliases: ['payments'], status: 'active' },
                { canonical: 'platform', displayName: 'Platform', aliases: ['infra'], status: 'active' },
            ],
        };

        const result = service.normalizeDomain(
            registry,
            null,
            'Req-dk-2',
            {
                explicitDomain: 'payments',
                reqIdPrefixDomain: 'platform',
                keywordMapDomain: 'platform',
            },
        );

        assert.equal(result.canonical, 'billing');
        assert.equal(result.matchedBy, 'alias');
        assert.equal(result.isSuspectedNew, false);
    });

    test('normalizeDomain marks suspected-new when no known mapping exists', () => {
        const service = new DomainRegistryService();
        const registry = {
            domains: [
                { canonical: 'billing', displayName: 'Billing', aliases: ['payments'], status: 'active' },
            ],
        };

        const result = service.normalizeDomain(registry, 'unknown-domain', 'Req-dk-x', {});
        assert.equal(result.canonical, null);
        assert.equal(result.matchedBy, 'none');
        assert.equal(result.isSuspectedNew, true);
    });
});
