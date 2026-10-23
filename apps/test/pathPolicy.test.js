'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolvePathAgainstRoot,
    normalizePathForDisplay,
    normalizePathForCompare,
} = require('../out/services/pathPolicy');

test('resolvePathAgainstRoot keeps relative path identity', () => {
    const root = path.resolve(process.cwd(), 'fixture-relative-root').replace(/\\/g, '/');
    const resolved = resolvePathAgainstRoot(root, 'apps/src/index.ts');
    assert.ok(resolved);
    assert.equal(resolved.insideRoot, true);
    assert.equal(resolved.relativePath, 'apps/src/index.ts');
    assert.equal(normalizePathForDisplay(root, 'apps\\src\\index.ts'), 'apps/src/index.ts');
});

test('resolvePathAgainstRoot maps absolute in-root paths to relative display', () => {
    const root = path.resolve(process.cwd(), 'fixture-root');
    const absolute = path.join(root, 'apps', 'src', 'main.ts');
    const resolved = resolvePathAgainstRoot(root, absolute);
    assert.ok(resolved);
    assert.equal(resolved.insideRoot, true);
    assert.equal(resolved.relativePath, 'apps/src/main.ts');
    assert.equal(normalizePathForDisplay(root, absolute), 'apps/src/main.ts');
});

test('resolvePathAgainstRoot marks outside-root absolute paths as external', () => {
    const root = path.resolve(process.cwd(), 'fixture-root');
    const outside = path.resolve(process.cwd(), 'outside-root', 'file.ts');
    const resolved = resolvePathAgainstRoot(root, outside);
    assert.ok(resolved);
    assert.equal(resolved.insideRoot, false);
    assert.equal(resolved.relativePath, null);
    assert.notEqual(normalizePathForCompare(root, outside), normalizePathForCompare(root, 'apps/src/file.ts'));
});
