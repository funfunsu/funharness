import * as path from 'path';

/**
 * Error thrown when a path falls outside the allowed repository root boundary.
 * Binds INV-10, Req-7.
 */
export class DomainPathOutOfScopeError extends Error {
    readonly code = 'DOMAIN_PATH_OUT_OF_SCOPE';

    constructor(
        public readonly offendingPath: string,
        repoRoot: string,
    ) {
        super(
            `DOMAIN_PATH_OUT_OF_SCOPE: "${offendingPath}" is outside repo root "${repoRoot}"`,
        );
        this.name = 'DomainPathOutOfScopeError';
    }
}

/**
 * Normalize repoRoot to an absolute path and throw DOMAIN_WORKSPACE_LOAD_FAILED when empty.
 * Must be called at every domain knowledge service boundary that accepts a repoRoot parameter.
 * Binds Req-7, INV-10.
 */
export function normalizeAndValidateRepoRoot(rawRepoRoot: string): string {
    const trimmed = (rawRepoRoot || '').trim();
    if (!trimmed) {
        throw new Error('DOMAIN_WORKSPACE_LOAD_FAILED: repoRoot must not be empty');
    }
    return path.resolve(trimmed);
}

/**
 * Assert that targetPath is strictly within repoRoot after both are resolved.
 * Throws DomainPathOutOfScopeError when targetPath escapes the repo boundary.
 * All domain knowledge write operations must call this before touching the file system.
 * Binds INV-10, Req-7.
 */
export function assertPathInRepoRoot(repoRoot: string, targetPath: string): void {
    const normalizedRoot = path.resolve(repoRoot).replace(/\\/g, '/');
    const normalizedTarget = path.resolve(targetPath).replace(/\\/g, '/');
    const inScope =
        normalizedTarget === normalizedRoot ||
        normalizedTarget.startsWith(normalizedRoot + '/');
    if (!inScope) {
        throw new DomainPathOutOfScopeError(targetPath, repoRoot);
    }
}

/**
 * Collect all paths that fall outside repoRoot.
 * Returns an empty array when every path is within scope.
 * Binds INV-10, Req-7.
 */
export function collectOutOfScopePaths(repoRoot: string, paths: string[]): string[] {
    const normalizedRoot = path.resolve(repoRoot).replace(/\\/g, '/');
    return paths.filter(p => {
        const normalizedTarget = path.resolve(p).replace(/\\/g, '/');
        return (
            normalizedTarget !== normalizedRoot &&
            !normalizedTarget.startsWith(normalizedRoot + '/')
        );
    });
}
