'use strict';
/**
 * Regression tests for iteration archive behaviour introduced by after-iteration feature.
 * Covers Req-2, Req-3, Req-4, Req-5, Req-6, Req-7 via TaskStoreService integration tests.
 *
 * Test runner: Node.js built-in test runner (`node --test`).
 * Prerequisite: `npm run compile` must have been run so that `../out/src/` contains compiled JS.
 *
 * Each test creates an isolated tmp directory and cleans it up on completion so runs are
 * independent and idempotent.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskStoreService } = require('../out/src/services/taskStoreService');
const {
    STAGE,
    BASE,
    HARNESS_STATE_FILE,
    HARNESS_STATE_ARCHIVE_FILE,
} = require('../out/src/models');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary workspace directory and return its path.
 * @returns {string} absolute path to temp dir
 */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-arc-'));
}

/**
 * Recursively remove a directory. Best-effort, never throws.
 * @param {string} dir
 */
function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Build a minimal Task-shaped object for testing.
 * @param {string} id
 * @param {string} stage
 * @returns {object}
 */
function makeTask(id, stage) {
    return { id, name: `task-${id}`, desc: 'test', stage };
}

/**
 * Write a harness config.json so that TaskStoreService reads the desired origin.
 * @param {string} workspaceRoot
 * @param {'master'|'worktreeSnapshot'|'unknown'} origin
 * @param {string|undefined} masterRoot
 */
function writeHarnessConfig(workspaceRoot, origin, masterRoot) {
    const harnessDir = path.join(workspaceRoot, BASE);
    fs.mkdirSync(harnessDir, { recursive: true });
    const payload = { __harnessConfigOrigin: origin };
    if (masterRoot) { payload.__harnessMasterRoot = masterRoot; }
    fs.writeFileSync(path.join(harnessDir, 'config.json'), JSON.stringify(payload), 'utf8');
}

/**
 * Read the active state file for a root directory.
 * @param {string} root
 * @returns {object[]}
 */
function readActive(root) {
    const file = path.join(root, BASE, HARNESS_STATE_FILE);
    if (!fs.existsSync(file)) { return []; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Read the archive document for a root directory.
 * @param {string} root
 * @returns {object|null}
 */
function readArchive(root) {
    const file = path.join(root, BASE, HARNESS_STATE_ARCHIVE_FILE);
    if (!fs.existsSync(file)) { return null; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('TaskStoreService – archive regression (Req-2, Req-3, Req-4, Req-5, Req-6)', () => {

    // ── Req-1 / Req-2 / INV-1 ─────────────────────────────────────────────

    test('done task is removed from active state file after save (Req-2, INV-1)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            const doneTask = makeTask('t1', STAGE.DONE);
            svc.saveTasks([doneTask]);

            const active = readActive(root);
            assert.equal(active.length, 0, 'active state must be empty after archiving the only done task');
        } finally { cleanup(root); }
    });

    test('non-done task is preserved unchanged in active state file (Req-1)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            const activeTask = makeTask('t2', STAGE.DEVELOPING);
            svc.saveTasks([activeTask]);

            const active = readActive(root);
            assert.equal(active.length, 1, 'non-done task must remain in active state');
            assert.equal(active[0].id, 't2');
            assert.equal(active[0].stage, STAGE.DEVELOPING);
        } finally { cleanup(root); }
    });

    test('mixed save: only done tasks archived, non-done tasks preserved (Req-2)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            const doneTask = makeTask('done-1', STAGE.DONE);
            const activeTask = makeTask('active-1', STAGE.DEVELOPING);
            svc.saveTasks([doneTask, activeTask]);

            const active = readActive(root);
            assert.equal(active.length, 1, 'only non-done task must remain in active state');
            assert.equal(active[0].id, 'active-1', 'non-done task identity must be preserved');

            const archive = readArchive(root);
            assert.ok(archive, 'archive file must be created');
            assert.equal(archive.tasks.length, 1, 'done task must be in archive');
            assert.equal(archive.tasks[0].id, 'done-1');
        } finally { cleanup(root); }
    });

    test('loadTasks after archive does not return archived task id (Req-2, INV-2)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            svc.saveTasks([makeTask('archived-t', STAGE.DONE), makeTask('alive-t', STAGE.DEVELOPING)]);

            const loaded = svc.loadTasks();
            const ids = loaded.map(t => t.id);
            assert.ok(!ids.includes('archived-t'), 'loadTasks must not return archived task id');
            assert.ok(ids.includes('alive-t'), 'loadTasks must return non-done task');
        } finally { cleanup(root); }
    });

    // ── Req-3 / Req-4 ─────────────────────────────────────────────────────

    test('first archive creates file with valid JSON, schemaVersion, and tasks array (Req-3, Req-4)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            svc.saveTasks([makeTask('t-first', STAGE.DONE)]);

            const archive = readArchive(root);
            assert.ok(archive, 'archive file must exist after first archive');
            assert.equal(typeof archive.schemaVersion, 'number', 'schemaVersion must be a number');
            assert.ok(Array.isArray(archive.tasks), 'tasks must be an array');
            assert.equal(archive.tasks.length, 1, 'archive must contain the done task');
        } finally { cleanup(root); }
    });

    test('archived item has archivedAt ISO-8601 and archiveReason=completed (Req-3)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            svc.saveTasks([makeTask('t-meta', STAGE.DONE)]);

            const archive = readArchive(root);
            const item = archive.tasks[0];
            assert.ok(typeof item.archivedAt === 'string' && item.archivedAt.length > 0,
                'archivedAt must be a non-empty string');
            // Validate ISO-8601 parsability
            assert.ok(!isNaN(new Date(item.archivedAt).getTime()), 'archivedAt must be a valid ISO-8601 timestamp');
            assert.equal(item.archiveReason, 'completed', 'archiveReason must be "completed"');
        } finally { cleanup(root); }
    });

    test('second archive appends without overwriting existing items (Req-3)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            svc.saveTasks([makeTask('t-old', STAGE.DONE)]);
            svc.saveTasks([makeTask('t-new', STAGE.DONE)]);

            const archive = readArchive(root);
            assert.equal(archive.tasks.length, 2, 'both items must be in archive');
            const ids = archive.tasks.map(i => i.id);
            assert.ok(ids.includes('t-old'), 'first archived task must still be present');
            assert.ok(ids.includes('t-new'), 'second archived task must be present');
        } finally { cleanup(root); }
    });

    test('original task fields are preserved in archive item (Req-3)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            const doneTask = makeTask('t-fields', STAGE.DONE);
            svc.saveTasks([doneTask]);

            const archive = readArchive(root);
            const item = archive.tasks[0];
            assert.equal(item.id, 't-fields');
            assert.equal(item.name, 'task-t-fields');
            assert.equal(item.stage, STAGE.DONE);
        } finally { cleanup(root); }
    });

    // ── Req-5 / INV-5 ─────────────────────────────────────────────────────

    test('archiving the same task twice does not create duplicate entries (Req-5, INV-5)', () => {
        const root = makeTempDir();
        try {
            const svc = new TaskStoreService(root);
            const doneTask = makeTask('dup-id', STAGE.DONE);
            svc.saveTasks([doneTask]);
            svc.saveTasks([doneTask]); // second run: same task, already archived

            const archive = readArchive(root);
            const matchingIds = archive.tasks.filter(i => i.id === 'dup-id');
            assert.equal(matchingIds.length, 1, 'archived item must appear exactly once (idempotent)');
        } finally { cleanup(root); }
    });

    test('corrupt archive file: saveTasks does not throw and done task is retained in active state (Req-4, Req-5)', () => {
        const root = makeTempDir();
        try {
            // Pre-create a corrupt archive file
            const harnessDir = path.join(root, BASE);
            fs.mkdirSync(harnessDir, { recursive: true });
            fs.writeFileSync(path.join(harnessDir, HARNESS_STATE_ARCHIVE_FILE), 'NOT_JSON', 'utf8');

            const svc = new TaskStoreService(root);
            const doneTask = makeTask('t-safe', STAGE.DONE);

            // Must not throw
            assert.doesNotThrow(() => { svc.saveTasks([doneTask]); },
                'saveTasks must not throw on corrupt archive file');

            // Done task must NOT be lost — it should remain in active state since archive failed
            const active = readActive(root);
            const retained = active.some(t => t.id === 't-safe');
            assert.ok(retained, 'done task must be retained in active state when archive is corrupt (data safety)');
        } finally { cleanup(root); }
    });

    // ── Req-6 / INV-7 ─────────────────────────────────────────────────────

    test('worktreeSnapshot propagation: done task is removed from master active state (Req-6, INV-7)', () => {
        const masterRoot = makeTempDir();
        const worktreeRoot = makeTempDir();
        try {
            writeHarnessConfig(worktreeRoot, 'worktreeSnapshot', masterRoot);

            const svc = new TaskStoreService(worktreeRoot);
            svc.saveTasks([makeTask('wt-done', STAGE.DONE), makeTask('wt-active', STAGE.DEVELOPING)]);

            const masterActive = readActive(masterRoot);
            const masterIds = masterActive.map(t => t.id);
            assert.ok(!masterIds.includes('wt-done'),
                'done task must be absent from master active state after propagation');
            assert.ok(masterIds.includes('wt-active'),
                'non-done task must appear in master active state after propagation');
        } finally { cleanup(masterRoot); cleanup(worktreeRoot); }
    });

    test('worktreeSnapshot propagation: done task is archived in master archive file (Req-6, INV-7)', () => {
        const masterRoot = makeTempDir();
        const worktreeRoot = makeTempDir();
        try {
            writeHarnessConfig(worktreeRoot, 'worktreeSnapshot', masterRoot);

            const svc = new TaskStoreService(worktreeRoot);
            svc.saveTasks([makeTask('wt-arc', STAGE.DONE)]);

            const masterArchive = readArchive(masterRoot);
            assert.ok(masterArchive, 'master archive file must be created after propagation');
            const ids = masterArchive.tasks.map(i => i.id);
            assert.ok(ids.includes('wt-arc'),
                'done task must appear in master archive file after propagation');
        } finally { cleanup(masterRoot); cleanup(worktreeRoot); }
    });

    test('worktreeSnapshot propagation: repeated propagation does not duplicate master archive (Req-6, INV-7)', () => {
        const masterRoot = makeTempDir();
        const worktreeRoot = makeTempDir();
        try {
            writeHarnessConfig(worktreeRoot, 'worktreeSnapshot', masterRoot);

            const svc = new TaskStoreService(worktreeRoot);
            const doneTask = makeTask('wt-dedup', STAGE.DONE);
            svc.saveTasks([doneTask]);
            svc.saveTasks([doneTask]); // repeat

            const masterArchive = readArchive(masterRoot);
            const matches = masterArchive.tasks.filter(i => i.id === 'wt-dedup');
            assert.equal(matches.length, 1,
                'master archive must contain at most one entry per task id (idempotent propagation)');
        } finally { cleanup(masterRoot); cleanup(worktreeRoot); }
    });

});
