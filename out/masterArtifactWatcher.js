"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMasterArtifactWatcher = startMasterArtifactWatcher;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function startMasterArtifactWatcher(context, config) {
    const harnessRoot = path.join(config.workspaceRoot, config.baseDirName);
    const pattern = new vscode.RelativePattern(harnessRoot, 'iteration-*/*/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const syncToMaster = (uri) => {
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
    const removeFromMaster = (uri) => {
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
//# sourceMappingURL=masterArtifactWatcher.js.map