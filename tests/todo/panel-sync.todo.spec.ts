import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceTodoStoreService } from '../../apps/src/services/workspaceTodoStoreService';

/**
 * Create a temporary workspace root for panel-sync simulation.
 */
function createTempWorkspaceRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'todo-sync-'));
}

/**
 * Simulate master panel and worktree panel reading the same workspace Todo document.
 */
test('panel-sync: two store instances converge after reload', () => {
    const root = createTempWorkspaceRoot();
    const masterPanelStore = new WorkspaceTodoStoreService(root);
    const worktreePanelStore = new WorkspaceTodoStoreService(root);

    const created = masterPanelStore.create({
        title: 'sync-case',
        description: 'from master',
        sourcePanel: 'master',
    });

    const reloaded = worktreePanelStore.load();
    assert.equal(reloaded.todos.length, 1);
    assert.equal(reloaded.todos[0].id, created.id);

    worktreePanelStore.update({
        id: created.id,
        title: 'sync-case-updated',
        status: 'done',
    });

    const masterReload = masterPanelStore.load();
    assert.equal(masterReload.todos.length, 1);
    assert.equal(masterReload.todos[0].title, 'sync-case-updated');
    assert.equal(masterReload.todos[0].status, 'done');
});
