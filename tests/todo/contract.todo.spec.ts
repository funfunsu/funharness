import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessMessage } from '../../apps/src/harnessMessages';

/**
 * Validate API-1 todo.create request contract fields.
 */
test('contract: API-1 todo.create request shape', () => {
    const msg: HarnessMessage = {
        type: 'todo.create',
        sourcePanel: 'master',
        title: 'todo title',
        description: 'todo desc',
    };

    assert.equal(msg.type, 'todo.create');
    assert.equal(msg.sourcePanel, 'master');
    assert.equal(typeof msg.title, 'string');
    assert.ok(msg.title.length > 0);
});

/**
 * Validate API-2 todo.update request contract fields.
 */
test('contract: API-2 todo.update request shape', () => {
    const msg: HarnessMessage = {
        type: 'todo.update',
        id: 'todo_1',
        title: 'updated',
        description: null,
        status: 'done',
    };

    assert.equal(msg.type, 'todo.update');
    assert.equal(msg.id, 'todo_1');
    assert.equal(msg.status, 'done');
});

/**
 * Validate API-3 and API-4 minimal request shapes.
 */
test('contract: API-3 todo.delete and API-4 todo.list request shape', () => {
    const deleteMsg: HarnessMessage = { type: 'todo.delete', id: 'todo_2' };
    const listMsg: HarnessMessage = { type: 'todo.list' };

    assert.equal(deleteMsg.type, 'todo.delete');
    assert.equal(deleteMsg.id, 'todo_2');
    assert.equal(listMsg.type, 'todo.list');
});

/**
 * Validate API-5 todo.promoteToTask request policy set.
 */
test('contract: API-5 todo.promoteToTask request policy values', () => {
    const keepMsg: HarnessMessage = {
        type: 'todo.promoteToTask',
        todoId: 'todo_3',
        promotionPolicy: 'keep',
    };
    const markPromotedMsg: HarnessMessage = {
        type: 'todo.promoteToTask',
        todoId: 'todo_3',
        promotionPolicy: 'mark-promoted',
    };

    assert.equal(keepMsg.promotionPolicy, 'keep');
    assert.equal(markPromotedMsg.promotionPolicy, 'mark-promoted');
});

/**
 * Validate API-6 todo.changed event payload shape.
 */
test('contract: API-6 todo.changed payload shape', () => {
    const msg: HarnessMessage = {
        type: 'todo.changed',
        reason: 'created',
        todos: [
            {
                id: 'todo_4',
                title: 'new',
                description: null,
                status: 'open',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ],
    };

    assert.equal(msg.type, 'todo.changed');
    assert.equal(msg.reason, 'created');
    assert.equal(Array.isArray(msg.todos), true);
    assert.equal(msg.todos[0].status, 'open');
});
