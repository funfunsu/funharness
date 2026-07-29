import * as fs from 'fs';
import * as path from 'path';

export interface HarnessWorkspaceRootResolution {
    workspaceRoot: string;
    detectedProjectRoot: boolean;
}

export function resolveHarnessWorkspaceRoot(openedWorkspacePath: string): HarnessWorkspaceRootResolution {
    const worktreeRoot = findContainingWorktreeRoot(openedWorkspacePath);
    if (worktreeRoot) {
        return {
            workspaceRoot: worktreeRoot,
            detectedProjectRoot: worktreeRoot !== openedWorkspacePath,
        };
    }

    let current = openedWorkspacePath;

    while (current) {
        if (isHarnessProjectRoot(current)) {
            return {
                workspaceRoot: current,
                detectedProjectRoot: current !== openedWorkspacePath,
            };
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return {
        workspaceRoot: openedWorkspacePath,
        detectedProjectRoot: false,
    };
}

function isHarnessProjectRoot(targetPath: string): boolean {
    return fs.existsSync(path.join(targetPath, 'repos')) || fs.existsSync(path.join(targetPath, 'worktrees'));
}

function findContainingWorktreeRoot(openedWorkspacePath: string): string | undefined {
    let current = openedWorkspacePath;
    while (current) {
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        if (path.basename(parent) === 'worktrees') {
            return current;
        }
        current = parent;
    }
    return undefined;
}