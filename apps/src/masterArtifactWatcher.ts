import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface ArtifactSyncConfig {
    workspaceRoot: string;
    baseDirName: string;
}

export function startMasterArtifactWatcher(
    context: vscode.ExtensionContext,
    config: ArtifactSyncConfig
): void {
    const harnessRoot = path.join(config.workspaceRoot, config.baseDirName);
    const pattern = new vscode.RelativePattern(harnessRoot, 'iteration-*/*/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const syncToMaster = (uri: vscode.Uri): void => {
        const fsPath = uri.fsPath;
        const relativePath = path.relative(harnessRoot, fsPath);
        const parts = relativePath.split(path.sep);

        if (parts.length <= 2 || !parts[0].startsWith('iteration-')) {
            return;
        }

        const subDir = parts[1];
        if (subDir !== 'api' && subDir !== 'schema') {
            return;
        }

        const targetRoot = path.join(harnessRoot, subDir);
        const relFilePath = parts.slice(2).join(path.sep);
        const targetFile = path.join(targetRoot, relFilePath);

        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.copyFileSync(fsPath, targetFile);
    };

    const removeFromMaster = (uri: vscode.Uri): void => {
        const fsPath = uri.fsPath;
        const relativePath = path.relative(harnessRoot, fsPath);
        const parts = relativePath.split(path.sep);

        if (parts.length <= 2 || !parts[0].startsWith('iteration-')) {
            return;
        }

        const subDir = parts[1];
        if (subDir !== 'api' && subDir !== 'schema') {
            return;
        }

        const relFilePath = parts.slice(2).join(path.sep);
        const targetFile = path.join(harnessRoot, subDir, relFilePath);
        if (fs.existsSync(targetFile)) {
            fs.unlinkSync(targetFile);
        }
    };

    watcher.onDidCreate(syncToMaster);
    watcher.onDidChange(syncToMaster);
    watcher.onDidDelete(removeFromMaster);

    context.subscriptions.push(watcher);
}
