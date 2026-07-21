import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceTodoStoreService } from '../../apps/src/services/workspaceTodoStoreService';

/**
 * Create a temporary workspace root for promotion tests.
 */
function createTempWorkspaceRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'todo-promotion-'));
}

/**
 * Validate keep strategy retains status while linking task id.
 */
test('promotion: keep strategy links task without forcing promoted status', () => {
    const root = createTempWorkspaceRoot();
    const store = new WorkspaceTodoStoreService(root);
    const created = store.create({ title: 'todo', description: null, sourcePanel: 'master' });

    const result = store.promoteToTask({
        id: created.id,
        taskId: 'task_keep_1',
        strategy: 'keep',
    });

    assert.equal(result.taskId, 'task_keep_1');
    assert.equal(result.todo.id, created.id);
    assert.equal(result.todo.linkedTaskId, 'task_keep_1');
    assert.equal(result.todo.status, 'open');
});

/**
 * Validate mark-promoted strategy sets promoted status.
 */
test('promotion: mark-promoted strategy sets promoted status', () => {
    const root = createTempWorkspaceRoot();
    const store = new WorkspaceTodoStoreService(root);
    const created = store.create({ title: 'todo', description: null, sourcePanel: 'worktree' });

    const result = store.promoteToTask({
        id: created.id,
        taskId: 'task_promoted_1',
        strategy: 'mark-promoted',
    });

    assert.equal(result.todo.status, 'promoted');
    assert.equal(result.todo.linkedTaskId, 'task_promoted_1');
});

/**
 * Validate invalid policy and missing todo error codes.
 */
test('promotion: invalid policy and missing todo emit expected error codes', () => {
    const root = createTempWorkspaceRoot();
    const store = new WorkspaceTodoStoreService(root);
    const created = store.create({ title: 'todo', description: null, sourcePanel: 'master' });

    assert.throws(() => {
        store.promoteToTask({
            id: created.id,
            taskId: 'task_invalid_policy',
            strategy: 'invalid-policy' as never,
        });
    }, /TODO-POLICY-001/);

    assert.throws(() => {
        store.promoteToTask({
            id: 'todo_not_found',
            taskId: 'task_none',
            strategy: 'keep',
        });
    }, /TODO-VAL-002/);
});
