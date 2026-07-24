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
