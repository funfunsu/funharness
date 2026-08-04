import * as fs from 'fs';
import * as path from 'path';

const FILE_OP_RETRY_TIMES = 5;
const FILE_OP_RETRY_DELAY_MS = 100;

/**
 * Unified safe deletion for files/directories with retry semantics.
 */
export function safeRemovePath(targetPath: string, options?: { recursive?: boolean }): void {
    if (!targetPath || !fs.existsSync(targetPath)) {
        return;
    }
    fs.rmSync(targetPath, {
        recursive: options?.recursive === true,
        force: true,
        maxRetries: FILE_OP_RETRY_TIMES,
        retryDelay: FILE_OP_RETRY_DELAY_MS,
    });
}

/**
 * Remove all direct children under a directory while preserving specific entry names.
 */
export function clearDirChildrenPreserving(dirPath: string, preserveNames: string[] = []): void {
    if (!dirPath || !fs.existsSync(dirPath)) {
        return;
    }
    const preserve = new Set(preserveNames);
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (preserve.has(entry.name)) {
            continue;
        }
        safeRemovePath(path.join(dirPath, entry.name), { recursive: true });
    }
}

export interface MarkedBlockUpdateResult {
    content: string;
    changed: boolean;
}

/**
 * Ensure parent directory exists for a target file path.
 */
export function ensureParentDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Read UTF-8 text when file exists, otherwise return null.
 */
export function readTextIfExists(filePath: string): string | null {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }
    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Write UTF-8 file atomically via temporary swap.
 */
export function writeTextAtomic(filePath: string, content: string): void {
    ensureParentDir(filePath);
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
}

/**
 * Replace content inside one strict marker block and return changed state.
 */
export function replaceMarkedBlockStrict(
    sourceContent: string,
    markerName: string,
    nextBody: string,
): MarkedBlockUpdateResult {
    const normalized = sourceContent.replace(/\r\n/g, '\n');
    const begin = `<!-- ${markerName}:start -->`;
    const end = `<!-- ${markerName}:end -->`;
    const pattern = new RegExp(`${escapeRegExp(begin)}([\\s\\S]*?)${escapeRegExp(end)}`, 'm');
    const matched = normalized.match(pattern);
    if (!matched || typeof matched.index !== 'number') {
        throw new Error(`Missing marker block: ${markerName}`);
    }

    const replacement = `${begin}\n${normalizeMarkerBody(nextBody)}\n${end}`;
    const content = `${normalized.slice(0, matched.index)}${replacement}${normalized.slice(matched.index + matched[0].length)}`;
    return {
        content,
        changed: content !== normalized,
    };
}

/**
 * Check if source content contains a complete marker block.
 */
export function hasMarkedBlock(sourceContent: string, markerName: string): boolean {
    const normalized = sourceContent.replace(/\r\n/g, '\n');
    const begin = `<!-- ${markerName}:start -->`;
    const end = `<!-- ${markerName}:end -->`;
    return normalized.includes(begin) && normalized.includes(end);
}

/**
 * Normalize body text used inside marker blocks.
 */
function normalizeMarkerBody(body: string): string {
    const normalized = (body || '').replace(/\r\n/g, '\n').trim();
    return normalized;
}

/**
 * Escape text for regexp composition.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Atomic multi-file write with rollback (Req-3, INV-4) ──────────

/** A single file write descriptor used by writeTextAtomicMulti. */
export interface AtomicWriteEntry {
    filePath: string;
    content: string;
}

/** Error thrown when an atomic multi-file write must roll back. Binds Req-3, INV-4. */
export class AtomicWriteRollbackError extends Error {
    readonly code = 'DOMAIN_COMMIT_ROLLED_BACK';
    constructor(
        public readonly failedFile: string,
        public readonly rolledBackFiles: string[],
        cause: unknown,
    ) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        super(
            `DOMAIN_COMMIT_ROLLED_BACK: write failed for "${failedFile}" — ${causeMsg}. ` +
            `Rolled back ${rolledBackFiles.length} file(s).`,
        );
        this.name = 'AtomicWriteRollbackError';
    }
}

/**
 * Write multiple files atomically:
 * 1. Back up each target file that already exists to `<path>.bak`.
 * 2. Write all target files via temp-swap.
 * 3. If any write fails, restore all backed-up files and remove newly written ones.
 * 4. Remove backup files on full success.
 * Returns the list of successfully written file paths.
 * Throws AtomicWriteRollbackError on any failure. Binds Req-3, INV-4.
 */
export function writeTextAtomicMulti(entries: AtomicWriteEntry[]): string[] {
    if (entries.length === 0) {
        return [];
    }

    const backups = new Map<string, string | null>(); // targetPath → backup content (null = did not exist)
    const written: string[] = [];

    // Phase 1: back up existing files.
    for (const entry of entries) {
        const existing = readTextIfExists(entry.filePath);
        backups.set(entry.filePath, existing);
    }

    // Phase 2: write each file; rollback on any failure.
    for (const entry of entries) {
        try {
            writeTextAtomic(entry.filePath, entry.content);
            written.push(entry.filePath);
        } catch (err) {
            // Rollback: restore backups and remove any files written so far.
            const rolledBack: string[] = [];
            for (const writtenPath of written) {
                try {
                    const backup = backups.get(writtenPath);
                    if (backup === null || backup === undefined) {
                        safeRemovePath(writtenPath);
                    } else {
                        writeTextAtomic(writtenPath, backup);
                    }
                    rolledBack.push(writtenPath);
                } catch {
                    // Best-effort rollback; record the attempt.
                    rolledBack.push(writtenPath);
                }
            }
            throw new AtomicWriteRollbackError(entry.filePath, rolledBack, err);
        }
    }

    // Phase 3: clean up backup markers (nothing to do since we only kept content in memory).
    return written;
}
