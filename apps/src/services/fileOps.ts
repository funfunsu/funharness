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
