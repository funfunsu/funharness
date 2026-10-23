import * as path from 'path';

export interface PathResolution {
    input: string;
    normalizedInput: string;
    absolutePath: string;
    relativePath: string | null;
    insideRoot: boolean;
    compareKey: string;
}

function normalizeSlash(value: string): string {
    return value.replace(/\\+/g, '/');
}

function normalizeCaseForCompare(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function resolvePathAgainstRoot(rootDir: string, rawValue: string): PathResolution | null {
    const input = String(rawValue || '').trim();
    if (!input) {
        return null;
    }

    const normalizedInput = normalizeSlash(input);
    const absolutePath = path.isAbsolute(normalizedInput)
        ? path.normalize(normalizedInput)
        : path.resolve(rootDir, normalizedInput);
    const relativeRaw = path.relative(rootDir, absolutePath);
    const insideRoot = relativeRaw === '' || (!relativeRaw.startsWith('..') && !path.isAbsolute(relativeRaw));
    const relativePath = insideRoot ? normalizeSlash(relativeRaw || '.') : null;
    const compareBase = relativePath ?? normalizeSlash(path.normalize(absolutePath));

    return {
        input,
        normalizedInput,
        absolutePath,
        relativePath,
        insideRoot,
        compareKey: normalizeCaseForCompare(compareBase),
    };
}

export function normalizePathForDisplay(rootDir: string, rawValue: string): string {
    const resolved = resolvePathAgainstRoot(rootDir, rawValue);
    if (!resolved) {
        return '';
    }
    if (resolved.insideRoot && resolved.relativePath) {
        return resolved.relativePath;
    }
    return normalizeSlash(resolved.normalizedInput);
}

export function normalizePathForCompare(rootDir: string, rawValue: string): string {
    const resolved = resolvePathAgainstRoot(rootDir, rawValue);
    if (!resolved) {
        return '';
    }
    return resolved.compareKey;
}
