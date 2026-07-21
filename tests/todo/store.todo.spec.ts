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
 * Validate create/update/remove persistence flow and id stability.
 */
test('store: create update remove flow persists and keeps id stable', () => {
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

    store.remove(created.id);
    const all = store.list();
    assert.equal(all.length, 0);
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
