import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceTodoStoreService } from '../../apps/src/services/workspaceTodoStoreService';

/**
 * Create a temporary workspace root for isolated store tests.
 */
function createTempWorkspaceRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'todo-store-'));
}

/**
 * Validate completed todo is archived and removed from active list.
 */
test('store: mark done archives todo and removes it from active list', () => {
    const root = createTempWorkspaceRoot();
    const store = new WorkspaceTodoStoreService(root);

    const created = store.create({
        title: 'A',
        description: 'B',
        sourcePanel: 'master',
    });

    const updated = store.update({
        id: created.id,
        title: 'A1',
        status: 'done',
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.title, 'A1');
    assert.equal(updated.status, 'done');

    const all = store.list();
    assert.equal(all.length, 0);

    assert.throws(() => {
        store.remove(created.id);
    }, /TODO-VAL-002/);

    const archiveFile = path.join(root, '.harness', 'workspace-todos-archive.json');
    assert.equal(fs.existsSync(archiveFile), true);
    const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8')) as {
        todos: Array<{ id: string; title: string; status: string; archiveReason: string; archivedAt: string }>;
    };
    assert.equal(Array.isArray(archive.todos), true);
    assert.equal(archive.todos.length, 1);
    assert.equal(archive.todos[0].id, created.id);
    assert.equal(archive.todos[0].title, 'A1');
    assert.equal(archive.todos[0].status, 'done');
    assert.equal(archive.todos[0].archiveReason, 'completed');
    assert.equal(typeof archive.todos[0].archivedAt, 'string');
});

/**
 * Validate title-empty validation error code.
 */
test('store: empty title throws TODO-VAL-001', () => {
    const root = createTempWorkspaceRoot();
    const store = new WorkspaceTodoStoreService(root);

    assert.throws(() => {
        store.create({ title: '   ', description: null, sourcePanel: 'worktree' });
    }, /TODO-VAL-001/);
});

/**
 * Validate not-found error code for update and remove.
 */
test('store: missing todo throws TODO-VAL-002 on update/remove', () => {
    const root = createTempWorkspaceRoot();
    const store = new WorkspaceTodoStoreService(root);

    assert.throws(() => {
        store.update({ id: 'todo_missing', title: 'x' });
    }, /TODO-VAL-002/);

    assert.throws(() => {
        store.remove('todo_missing');
    }, /TODO-VAL-002/);
});
