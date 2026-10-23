import * as fs from 'fs';
import * as path from 'path';

/**
 * Treat CodeGraph as initialized only when real artifacts exist.
 * A placeholder .codegraph/.gitignore is not enough.
 */
export function isCodeGraphInitialized(worktreePath: string): boolean {
    const codeGraphDir = path.join(worktreePath, '.codegraph');
    if (!fs.existsSync(codeGraphDir)) {
        return false;
    }

    const dbPath = path.join(codeGraphDir, 'codegraph.db');
    if (fs.existsSync(dbPath)) {
        return true;
    }

    try {
        const entries = fs.readdirSync(codeGraphDir, { withFileTypes: true });
        return entries.some(entry => entry.name !== '.gitignore');
    } catch {
        return false;
    }
}
