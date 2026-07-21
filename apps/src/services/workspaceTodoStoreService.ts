import * as fs from 'fs';
import * as path from 'path';
import { appendTodoLog } from './harnessLog';

export type WorkspaceTodoStatus = 'open' | 'done' | 'promoted';
export type WorkspaceTodoSourcePanel = 'master' | 'worktree';
export type WorkspaceTodoPromotionPolicy = 'keep' | 'mark-promoted';

export interface WorkspaceTodoItem {
    id: string;
    title: string;
    description: string | null;
    status: WorkspaceTodoStatus;
    createdAt: string;
    updatedAt: string;
    sourcePanel: WorkspaceTodoSourcePanel;
    linkedTaskId: string | null;
}

export interface WorkspaceTodoDocument {
    schemaVersion: number;
    workspaceId: string;
    todos: WorkspaceTodoItem[];
    lastSyncedAt: string;
}

export interface WorkspaceTodoArchiveItem extends WorkspaceTodoItem {
    archivedAt: string;
    archiveReason: 'completed' | 'legacy-migration';
}

export interface WorkspaceTodoArchiveDocument {
    schemaVersion: number;
    workspaceId: string;
    todos: WorkspaceTodoArchiveItem[];
    lastSyncedAt: string;
}

export interface WorkspaceTodoCreateInput {
    title: string;
    description?: string | null;
    sourcePanel: WorkspaceTodoSourcePanel;
}

export interface WorkspaceTodoUpdateInput {
    id: string;
    title?: string;
    description?: string | null;
    status?: WorkspaceTodoStatus;
}

export interface WorkspaceTodoPromoteInput {
    id: string;
    taskId: string;
    strategy: WorkspaceTodoPromotionPolicy;
}

export interface WorkspaceTodoPromoteResult {
    taskId: string;
    todo: WorkspaceTodoItem;
}

export type WorkspaceTodoListener = (doc: WorkspaceTodoDocument) => void;

const WORKSPACE_TODO_SCHEMA_VERSION = 1;
const WORKSPACE_TODO_ARCHIVE_SCHEMA_VERSION = 1;
const WORKSPACE_TODO_STORE_REL_PATH = path.join('.harness', 'workspace-todos.json');
const WORKSPACE_TODO_ARCHIVE_REL_PATH = path.join('.harness', 'workspace-todos-archive.json');
const SUPPORTED_PROMOTION_POLICIES: WorkspaceTodoPromotionPolicy[] = ['keep', 'mark-promoted'];

/**
 * Workspace-level Todo store with an in-memory authority state and serialized writes.
 */
export class WorkspaceTodoStoreService {
    private readonly storeFilePath: string;
    private readonly archiveFilePath: string;
    private readonly listeners = new Set<WorkspaceTodoListener>();
    private doc: WorkspaceTodoDocument;
    private archiveDoc: WorkspaceTodoArchiveDocument;

    constructor(private readonly workspaceRoot: string) {
        this.storeFilePath = path.join(this.workspaceRoot, WORKSPACE_TODO_STORE_REL_PATH);
        this.archiveFilePath = path.join(this.workspaceRoot, WORKSPACE_TODO_ARCHIVE_REL_PATH);
        this.doc = this.createEmptyDocument();
        this.archiveDoc = this.createEmptyArchiveDocument();
    }

    /**
     * Load the workspace Todo document from disk and update authority state.
     */
    load(): WorkspaceTodoDocument {
        try {
            this.doc = this.readDocumentFromDisk();
            this.archiveDoc = this.readArchiveDocumentFromDisk();
            this.migrateLegacyDoneTodosToArchive();
            return this.cloneDocument(this.doc);
        } catch {
            throw new Error('TODO-IO-001: 待办存储文件读取失败');
        }
    }

    /**
     * List all workspace Todo items from the authority state.
     */
    list(): WorkspaceTodoItem[] {
        return this.doc.todos.map(todo => ({ ...todo }));
    }

    /**
     * Create a Todo item, persist the authority state, and notify subscribers.
     */
    create(input: WorkspaceTodoCreateInput): WorkspaceTodoItem {
        this.validateTodoTitleOrThrow(input.title);
        const now = new Date().toISOString();
        const created: WorkspaceTodoItem = {
            id: `todo_${Date.now()}`,
            title: input.title.trim(),
            description: input.description ?? null,
            status: 'open',
            createdAt: now,
            updatedAt: now,
            sourcePanel: input.sourcePanel,
            linkedTaskId: null,
        };

        this.mutateAndPersist(() => {
            this.doc.todos.push(created);
        });
        return { ...created };
    }

    /**
     * Update a Todo item in authority state, persist changes, and notify subscribers.
     */
    update(input: WorkspaceTodoUpdateInput): WorkspaceTodoItem {
        const idx = this.doc.todos.findIndex(todo => todo.id === input.id);
        if (idx < 0) {
            throw new Error('TODO-VAL-002: 待办不存在');
        }

        const existing = this.doc.todos[idx];
        if (input.title !== undefined) {
            this.validateTodoTitleOrThrow(input.title);
        }
        const updated: WorkspaceTodoItem = {
            ...existing,
            title: input.title !== undefined ? input.title.trim() : existing.title,
            description: input.description !== undefined ? input.description : existing.description,
            status: input.status !== undefined ? input.status : existing.status,
            updatedAt: new Date().toISOString(),
        };

        this.mutateAndPersist(() => {
            if (updated.status === 'done' && existing.status !== 'done') {
                this.doc.todos = this.doc.todos.filter(todo => todo.id !== input.id);
                this.archiveDoc.todos.push(this.createArchiveItem(updated, 'completed'));
                return;
            }
            this.doc.todos[idx] = updated;
        });
        return { ...updated };
    }

    /**
     * Remove a Todo item by id, persist authority state, and notify subscribers.
     */
    remove(id: string): void {
        const idx = this.doc.todos.findIndex(todo => todo.id === id);
        if (idx < 0) {
            throw new Error('TODO-VAL-002: 待办不存在');
        }
        this.mutateAndPersist(() => {
            this.doc.todos = this.doc.todos.filter(todo => todo.id !== id);
        });
    }

    /**
     * Mark or keep a Todo while linking it to an iteration task, then persist and broadcast.
     */
    promoteToTask(input: WorkspaceTodoPromoteInput): WorkspaceTodoPromoteResult {
        const idx = this.doc.todos.findIndex(todo => todo.id === input.id);
        if (idx < 0) {
            throw new Error('TODO-VAL-002: 待办不存在');
        }

        this.validatePromotionPolicyOrThrow(input.strategy);

        const existing = this.doc.todos[idx];
        const nextStatus: WorkspaceTodoStatus = input.strategy === 'mark-promoted' ? 'promoted' : existing.status;
        const updated: WorkspaceTodoItem = {
            ...existing,
            linkedTaskId: input.taskId,
            status: nextStatus,
            updatedAt: new Date().toISOString(),
        };

        this.mutateAndPersist(() => {
            this.doc.todos[idx] = updated;
        });

        return {
            taskId: input.taskId,
            todo: { ...updated },
        };
    }

    /**
     * Subscribe to authority-state changes; returns an unsubscribe function.
     */
    subscribe(listener: WorkspaceTodoListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Persist in-memory authority state through the serialized file path.
     */
    private persistAndBroadcast(): void {
        this.doc = this.normalizeDocument(this.doc);
        this.archiveDoc = this.normalizeArchiveDocument(this.archiveDoc);
        this.doc.lastSyncedAt = new Date().toISOString();
        this.archiveDoc.lastSyncedAt = new Date().toISOString();
        try {
            this.writeDocumentToDisk(this.doc);
            this.writeArchiveDocumentToDisk(this.archiveDoc);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error || 'unknown');
            appendTodoLog(this.workspaceRoot, 'TODO-IO-002', '待办存储文件写入失败', detail);
            throw new Error('TODO-IO-002: 待办存储文件写入失败');
        }
        this.broadcast();
    }

    /**
     * Apply in-memory mutation and rollback authority state if persistence fails.
     */
    private mutateAndPersist(mutator: () => void): void {
        const previous = this.cloneDocument(this.doc);
        const previousArchive = this.cloneArchiveDocument(this.archiveDoc);
        mutator();
        try {
            this.persistAndBroadcast();
        } catch (error) {
            this.doc = previous;
            this.archiveDoc = previousArchive;
            throw error;
        }
    }

    /**
     * Notify all listeners with a defensive copy of the current document.
     */
    private broadcast(): void {
        const snapshot = this.cloneDocument(this.doc);
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    /**
     * Read the Todo document from disk and fallback to an empty document on parse/file errors.
     */
    private readDocumentFromDisk(): WorkspaceTodoDocument {
        if (!fs.existsSync(this.storeFilePath)) {
            return this.createEmptyDocument();
        }

        try {
            const raw = fs.readFileSync(this.storeFilePath, 'utf8');
            const parsed = JSON.parse(raw) as WorkspaceTodoDocument;
            return this.normalizeDocument(parsed);
        } catch {
            return this.createEmptyDocument();
        }
    }

    /**
     * Read archive document from disk and fallback to an empty archive on parse/file errors.
     */
    private readArchiveDocumentFromDisk(): WorkspaceTodoArchiveDocument {
        if (!fs.existsSync(this.archiveFilePath)) {
            return this.createEmptyArchiveDocument();
        }

        try {
            const raw = fs.readFileSync(this.archiveFilePath, 'utf8');
            const parsed = JSON.parse(raw) as WorkspaceTodoArchiveDocument;
            return this.normalizeArchiveDocument(parsed);
        } catch {
            return this.createEmptyArchiveDocument();
        }
    }

    /**
     * Write the Todo document to disk as the serialized persistence entry point.
     */
    private writeDocumentToDisk(doc: WorkspaceTodoDocument): void {
        const normalizedDoc = this.normalizeDocument(doc);
        fs.mkdirSync(path.dirname(this.storeFilePath), { recursive: true });
        this.ensureTodoStoreIgnoredByGit();
        fs.writeFileSync(this.storeFilePath, JSON.stringify(normalizedDoc, null, 2), 'utf8');
    }

    /**
     * Write archive document to disk as the serialized persistence entry point.
     */
    private writeArchiveDocumentToDisk(doc: WorkspaceTodoArchiveDocument): void {
        const normalizedDoc = this.normalizeArchiveDocument(doc);
        fs.mkdirSync(path.dirname(this.archiveFilePath), { recursive: true });
        this.ensureTodoStoreIgnoredByGit();
        fs.writeFileSync(this.archiveFilePath, JSON.stringify(normalizedDoc, null, 2), 'utf8');
    }

    /**
     * Ensure the workspace-level Todo store file is locally ignored by git.
     */
    private ensureTodoStoreIgnoredByGit(): void {
        const gitDir = path.join(this.workspaceRoot, '.git');
        if (!fs.existsSync(gitDir)) {
            return;
        }

        const infoDir = path.join(gitDir, 'info');
        const excludeFile = path.join(infoDir, 'exclude');
        const ignoreEntries = [
            '/.harness/workspace-todos.json',
            '/.harness/workspace-todos-archive.json',
        ];

        fs.mkdirSync(infoDir, { recursive: true });
        const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
        const lines = current
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        const missing = ignoreEntries.filter(entry => !lines.includes(entry));
        if (missing.length === 0) {
            return;
        }

        const prefix = current && !current.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(excludeFile, `${current}${prefix}${missing.join('\n')}\n`, 'utf8');
    }

    /**
     * Build an empty Todo document for first-load and fallback scenarios.
     */
    private createEmptyDocument(): WorkspaceTodoDocument {
        return {
            schemaVersion: WORKSPACE_TODO_SCHEMA_VERSION,
            workspaceId: this.workspaceRoot,
            todos: [],
            lastSyncedAt: new Date().toISOString(),
        };
    }

    /**
     * Build an empty Todo archive document for first-load and fallback scenarios.
     */
    private createEmptyArchiveDocument(): WorkspaceTodoArchiveDocument {
        return {
            schemaVersion: WORKSPACE_TODO_ARCHIVE_SCHEMA_VERSION,
            workspaceId: this.workspaceRoot,
            todos: [],
            lastSyncedAt: new Date().toISOString(),
        };
    }

    /**
     * Validate and normalize the full Todo document according to schema M-2.
     */
    private normalizeDocument(input: WorkspaceTodoDocument): WorkspaceTodoDocument {
        const todos = Array.isArray(input?.todos)
            ? input.todos
                .map(todo => this.normalizeTodoItem(todo))
                .filter((todo): todo is WorkspaceTodoItem => todo !== null)
            : [];

        return {
            schemaVersion: WORKSPACE_TODO_SCHEMA_VERSION,
            workspaceId: typeof input?.workspaceId === 'string' && input.workspaceId.trim() ? input.workspaceId : this.workspaceRoot,
            todos,
            lastSyncedAt: typeof input?.lastSyncedAt === 'string' && input.lastSyncedAt ? input.lastSyncedAt : new Date().toISOString(),
        };
    }

    /**
     * Validate and normalize the archive document according to schema A-1.
     */
    private normalizeArchiveDocument(input: WorkspaceTodoArchiveDocument): WorkspaceTodoArchiveDocument {
        const todos = Array.isArray(input?.todos)
            ? input.todos
                .map(todo => this.normalizeArchiveItem(todo))
                .filter((todo): todo is WorkspaceTodoArchiveItem => todo !== null)
            : [];

        return {
            schemaVersion: WORKSPACE_TODO_ARCHIVE_SCHEMA_VERSION,
            workspaceId: typeof input?.workspaceId === 'string' && input.workspaceId.trim() ? input.workspaceId : this.workspaceRoot,
            todos,
            lastSyncedAt: typeof input?.lastSyncedAt === 'string' && input.lastSyncedAt ? input.lastSyncedAt : new Date().toISOString(),
        };
    }

    /**
     * Normalize a Todo item and drop malformed rows.
     */
    private normalizeTodoItem(input: WorkspaceTodoItem): WorkspaceTodoItem | null {
        const id = typeof input?.id === 'string' ? input.id.trim() : '';
        const title = typeof input?.title === 'string' ? input.title.trim() : '';
        if (!id || !title) {
            return null;
        }

        const status: WorkspaceTodoStatus = input.status === 'done' || input.status === 'promoted' ? input.status : 'open';
        const sourcePanel: WorkspaceTodoSourcePanel = input.sourcePanel === 'worktree' ? 'worktree' : 'master';

        return {
            id,
            title,
            description: typeof input.description === 'string' ? input.description : null,
            status,
            createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : new Date().toISOString(),
            updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : new Date().toISOString(),
            sourcePanel,
            linkedTaskId: typeof input.linkedTaskId === 'string' && input.linkedTaskId ? input.linkedTaskId : null,
        };
    }

    /**
     * Normalize an archive item and drop malformed rows.
     */
    private normalizeArchiveItem(input: WorkspaceTodoArchiveItem): WorkspaceTodoArchiveItem | null {
        const normalized = this.normalizeTodoItem(input);
        if (!normalized) {
            return null;
        }
        return {
            ...normalized,
            archivedAt: typeof input.archivedAt === 'string' && input.archivedAt ? input.archivedAt : new Date().toISOString(),
            archiveReason: input.archiveReason === 'legacy-migration' ? 'legacy-migration' : 'completed',
        };
    }

    /**
     * Build an archive record from a todo item.
     */
    private createArchiveItem(todo: WorkspaceTodoItem, reason: WorkspaceTodoArchiveItem['archiveReason']): WorkspaceTodoArchiveItem {
        return {
            ...todo,
            status: 'done',
            archivedAt: new Date().toISOString(),
            archiveReason: reason,
        };
    }

    /**
     * One-time compatibility migration: move legacy done items from active store to archive.
     */
    private migrateLegacyDoneTodosToArchive(): void {
        const doneTodos = this.doc.todos.filter(todo => todo.status === 'done');
        if (doneTodos.length === 0) {
            return;
        }

        this.doc.todos = this.doc.todos.filter(todo => todo.status !== 'done');
        this.archiveDoc.todos.push(...doneTodos.map(todo => this.createArchiveItem(todo, 'legacy-migration')));
        this.persistAndBroadcast();
    }

    /**
     * Enforce non-empty title invariant and throw TODO-VAL-001 on violation.
     */
    private validateTodoTitleOrThrow(title: string): void {
        if (!title || !title.trim()) {
            throw new Error('TODO-VAL-001: 标题不能为空');
        }
    }

    /**
     * Enforce promotion strategy invariant and throw TODO-POLICY-001 on invalid policy.
     */
    private validatePromotionPolicyOrThrow(strategy: string): void {
        if (!SUPPORTED_PROMOTION_POLICIES.includes(strategy as WorkspaceTodoPromotionPolicy)) {
            throw new Error(`TODO-POLICY-001: 不支持的转化策略，可选值为 ${SUPPORTED_PROMOTION_POLICIES.join('|')}`);
        }
    }

    /**
     * Clone the Todo document to avoid exposing mutable internal references.
     */
    private cloneDocument(doc: WorkspaceTodoDocument): WorkspaceTodoDocument {
        return {
            schemaVersion: doc.schemaVersion,
            workspaceId: doc.workspaceId,
            todos: doc.todos.map(todo => ({ ...todo })),
            lastSyncedAt: doc.lastSyncedAt,
        };
    }

    /**
     * Clone archive document to avoid exposing mutable internal references.
     */
    private cloneArchiveDocument(doc: WorkspaceTodoArchiveDocument): WorkspaceTodoArchiveDocument {
        return {
            schemaVersion: doc.schemaVersion,
            workspaceId: doc.workspaceId,
            todos: doc.todos.map(todo => ({ ...todo })),
            lastSyncedAt: doc.lastSyncedAt,
        };
    }
}
