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
exports.TaskScheduler = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const models_1 = require("./models");
class TaskScheduler {
    constructor(iterDir, workspaceRoot, config, dispatchAi, onStatusChange) {
        this.watcher = null;
        this.autoMode = false;
        this.timeoutTimer = null;
        this.iterDir = iterDir;
        this.workspaceRoot = workspaceRoot;
        this.docsDir = path.join(iterDir, 'docs');
        this.config = config;
        this.dispatchAi = dispatchAi;
        this.onStatusChange = onStatusChange;
    }
    parseTasksMd() {
        const file = this.resolveTaskPlanFile();
        if (!fs.existsSync(file))
            return [];
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        const tasks = [];
        let current = null;
        let currentField = '';
        for (const line of lines) {
            const taskMatch = line.match(/^\-\s*\[([ xX]|doing|failed)\]\s*(\d+\.\d+)\s+(.+)/i);
            if (taskMatch) {
                if (current)
                    tasks.push(current);
                const statusRaw = taskMatch[1].trim().toLowerCase();
                let status = 'todo';
                if (statusRaw === 'x')
                    status = 'done';
                else if (statusRaw === 'doing')
                    status = 'doing';
                else if (statusRaw === 'failed')
                    status = 'failed';
                current = {
                    id: taskMatch[2],
                    name: taskMatch[3].trim(),
                    owner: '',
                    depends: [],
                    input: '',
                    output: [],
                    acceptance: [],
                    requirementIds: [],
                    propertyIds: [],
                    status,
                    rawLine: line
                };
                currentField = '';
                continue;
            }
            if (!current)
                continue;
            const trimmed = line.trim();
            if (trimmed.startsWith('- Owner:')) {
                current.owner = trimmed.replace('- Owner:', '').trim();
                currentField = '';
            }
            else if (trimmed.startsWith('- 依赖:') || trimmed.startsWith('- 依赖：')) {
                const depStr = trimmed.replace(/^- 依赖[：:]/, '').trim();
                if (depStr) {
                    current.depends = depStr.split(/[,，]/).map(d => d.trim()).filter(Boolean);
                }
                currentField = '';
            }
            else if (trimmed.startsWith('- 输入:') || trimmed.startsWith('- 输入：')) {
                current.input = trimmed.replace(/^- 输入[：:]/, '').trim();
                currentField = '';
            }
            else if (trimmed.startsWith('- 输出:') || trimmed.startsWith('- 输出：')) {
                const val = trimmed.replace(/^- 输出[：:]/, '').trim();
                if (val)
                    current.output.push(val);
                currentField = 'output';
            }
            else if (trimmed.startsWith('- 验收:') || trimmed.startsWith('- 验收：')) {
                currentField = 'acceptance';
            }
            else if (trimmed.startsWith('- 追踪:') || trimmed.startsWith('- 追踪：')) {
                currentField = 'tracking';
            }
            else if (trimmed.startsWith('- ') && currentField === 'output') {
                current.output.push(trimmed.replace(/^- /, ''));
            }
            else if (trimmed.startsWith('- ') && currentField === 'acceptance') {
                current.acceptance.push(trimmed.replace(/^- /, ''));
            }
            else if (trimmed.startsWith('- Requirements:') && currentField === 'tracking') {
                const raw = trimmed.replace('- Requirements:', '').trim();
                current.requirementIds = raw
                    .replace(/[\[\]]/g, '')
                    .split(/[,，]/)
                    .map(s => s.trim())
                    .filter(Boolean);
            }
            else if (trimmed.startsWith('- Properties:') && currentField === 'tracking') {
                const raw = trimmed.replace('- Properties:', '').trim();
                current.propertyIds = raw
                    .replace(/[\[\]]/g, '')
                    .split(/[,，]/)
                    .map(s => s.trim())
                    .filter(Boolean);
            }
        }
        if (current)
            tasks.push(current);
        return tasks;
    }
    getNextTask() {
        const subTasks = this.parseTasksMd();
        const doneIds = new Set(subTasks.filter(t => t.status === 'done').map(t => t.id));
        return subTasks.find(t => t.status === 'todo' &&
            t.depends.every(depId => doneIds.has(depId))) || null;
    }
    getCurrentTask() {
        const subTasks = this.parseTasksMd();
        return subTasks.find(t => t.status === 'doing') || null;
    }
    updateSubTaskStatus(taskId, newStatus) {
        const file = this.resolveTaskPlanFile();
        if (!fs.existsSync(file))
            return;
        let content = fs.readFileSync(file, 'utf8');
        const statusMap = {
            todo: ' ',
            doing: 'doing',
            done: 'x',
            failed: 'failed'
        };
        const marker = statusMap[newStatus];
        content = content.replace(new RegExp(`^(-\\s*\\[)[^\\]]*?(\\]\\s*${taskId.replace('.', '\\.')}\\s)`, 'm'), `$1${marker}$2`);
        fs.writeFileSync(file, content, 'utf8');
    }
    buildDispatchQuery(subTask, _iterTask) {
        const signalsDir = path.join(this.iterDir, 'signals');
        const testsDir = path.join(this.iterDir, 'tests');
        const testScriptSuffix = process.platform === 'win32' ? 'ps1' : 'sh';
        const designFile = path.join(this.docsDir, 'design.md');
        const designContext = fs.existsSync(designFile)
            ? fs.readFileSync(designFile, 'utf8').substring(0, 1800)
            : '(无设计文档)';
        const requirementsContext = this.buildRequirementsContext(subTask);
        const testcaseContext = this.buildTestcaseContext(subTask);
        const manifestContext = this.buildManifestContext(subTask);
        const instructionContext = this.buildProjectInstructionContext();
        const outputFiles = subTask.output.length > 0
            ? subTask.output.map(f => `- ${f}`).join('\n')
            : '- (按任务描述生成对应文件)';
        const acceptanceCriteria = subTask.acceptance.length > 0
            ? subTask.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')
            : '- 代码可正常编译运行';
        const techStack = this.config.techStack || '(按项目现有技术栈)';
        const codingStandards = this.config.codingStandards || '变量采用小驼峰命名，方法需加注释';
        let dependencySection = '';
        if (subTask.depends.length > 0) {
            const allTasks = this.parseTasksMd();
            const depTasks = allTasks.filter(t => subTask.depends.includes(t.id));
            const depParts = [];
            for (const dep of depTasks) {
                let depInfo = `### 依赖任务 ${dep.id}: ${dep.name}\n- 状态：${dep.status}\n- 输出文件：`;
                const fileContents = [];
                for (const outputFile of dep.output) {
                    const candidates = [
                        path.join(this.iterDir, outputFile),
                        outputFile,
                    ];
                    let found = false;
                    for (const candidate of candidates) {
                        if (fs.existsSync(candidate)) {
                            const content = fs.readFileSync(candidate, 'utf8');
                            const truncated = content.length > 2000
                                ? content.substring(0, 2000) + '\n... (truncated)'
                                : content;
                            fileContents.push(`\n#### 文件: \`${outputFile}\`\n\`\`\`\n${truncated}\n\`\`\``);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        fileContents.push(`\n- \`${outputFile}\` (文件尚未生成，请根据设计文档推断)`);
                    }
                }
                depInfo += fileContents.join('\n');
                depParts.push(depInfo);
            }
            dependencySection = `\n## 前置依赖任务及其产出物\n\n**以下是本任务依赖的前置任务。它们的输出文件（如 API 协议、接口定义、数据模型等）是本任务的输入约束，请严格遵循。**\n\n${depParts.join('\n\n')}\n`;
        }
        return `@fun-harness-dev

## 编码任务指令

- 任务ID：${subTask.id}
- 任务名称：${subTask.name}
- 任务类型：${subTask.owner}
- 技术栈：${techStack}
- 当前工作空间（currentWorkSpace）：${this.iterDir}${subTask.depends.length > 0 ? `\n- 前置依赖任务：${subTask.depends.join(', ')}` : ''}

**重要：所有依赖的上下文文件（docs/design.md、docs/requirements.md、doc/task.md；兼容历史 docs/tasks.md）均位于当前工作空间目录下，请优先在当前迭代目录内查找，不要去 workspace 根目录查找。**
${dependencySection}
## 输入依据
文件路径：\`${designFile}\`
${subTask.input || designContext}

## 需求上下文（裁剪）
${requirementsContext}

## 测试用例上下文（裁剪）
${testcaseContext}

## 测试清单上下文（裁剪）
${manifestContext}

## 项目规范上下文（workspaceRoot/.github/instructions）
${instructionContext}

**重要：若项目规范与通用规范冲突，以 workspaceRoot/.github/instructions 中的规则为最高优先级。**

## 输出要求
${outputFiles}

## 验收标准
${acceptanceCriteria}

## 编码规范
${codingStandards}

## 完成后必须执行
所有代码文件写完后，在 \`${signalsDir}/\` 目录下创建信号文件 \`done-${subTask.id}\`，内容为：
\`\`\`
taskId: ${subTask.id}
status: done
timestamp: {当前时间}
files:
  - {实际创建的文件路径列表}
\`\`\`
${subTask.owner === 'Backend' ? `\n如果验收标准包含接口验证条件，请在 \`${testsDir}/\` 目录下生成验收脚本 \`test-${subTask.id}.${testScriptSuffix}\`（Windows 生成 .ps1，其他系统生成 .sh）。脚本仅供人工触发验证，不自动执行。` : ''}`;
    }
    buildRequirementsContext(subTask) {
        const reqFile = path.join(this.docsDir, 'requirements.md');
        if (!fs.existsSync(reqFile)) {
            return '(无 docs/requirements.md)';
        }
        const content = fs.readFileSync(reqFile, 'utf8');
        return this.extractContextByKeywords(content, subTask.requirementIds, 1200);
    }
    buildTestcaseContext(subTask) {
        const testcaseFile = path.join(this.docsDir, 'testcase.md');
        if (!fs.existsSync(testcaseFile)) {
            return '(无 docs/testcase.md)';
        }
        const content = fs.readFileSync(testcaseFile, 'utf8');
        return this.extractContextByKeywords(content, subTask.requirementIds, 1200);
    }
    buildManifestContext(subTask) {
        const manifestFile = path.join(this.iterDir, 'tests', 'test-manifest.json');
        if (!fs.existsSync(manifestFile)) {
            return '(无 tests/test-manifest.json)';
        }
        try {
            const data = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
            const reqSet = new Set(subTask.requirementIds);
            const filtered = (data.testCases || []).filter(tc => (tc.requirementIds || []).some(id => reqSet.has(id)));
            const view = filtered.length > 0 ? filtered : (data.testCases || []).slice(0, 5);
            return view.length > 0 ? JSON.stringify(view, null, 2) : '(manifest 中无可用测试用例)';
        }
        catch {
            return '(test-manifest.json 解析失败)';
        }
    }
    extractContextByKeywords(content, keywords, maxLen) {
        if (!keywords || keywords.length === 0) {
            return content.substring(0, maxLen);
        }
        const lines = content.split('\n');
        const snippets = [];
        const seen = new Set();
        for (const keyword of keywords) {
            const idx = lines.findIndex(line => line.includes(keyword));
            if (idx < 0) {
                continue;
            }
            const start = Math.max(0, idx - 8);
            const end = Math.min(lines.length, idx + 9);
            const snippet = lines.slice(start, end).join('\n').trim();
            if (snippet && !seen.has(snippet)) {
                seen.add(snippet);
                snippets.push(snippet);
            }
        }
        if (snippets.length === 0) {
            return content.substring(0, maxLen);
        }
        const merged = snippets.join('\n\n---\n\n');
        return merged.length > maxLen ? merged.substring(0, maxLen) : merged;
    }
    buildProjectInstructionContext(maxLen = 2600) {
        const instructionsDir = path.join(this.workspaceRoot, '.github', 'instructions');
        if (!fs.existsSync(instructionsDir)) {
            return `(未发现规范目录：${instructionsDir})`;
        }
        const files = this.collectMarkdownFiles(instructionsDir, 3);
        if (files.length === 0) {
            return '(.github/instructions 下无 markdown 规范文件)';
        }
        const sections = [];
        let used = 0;
        for (const file of files) {
            const rel = path.relative(this.iterDir, file).replace(/\\/g, '/');
            const raw = fs.readFileSync(file, 'utf8').trim();
            if (!raw) {
                continue;
            }
            const body = raw.length > 700 ? `${raw.substring(0, 700)}\n... (truncated)` : raw;
            const block = `### ${rel}\n${body}`;
            if (used + block.length > maxLen) {
                break;
            }
            sections.push(block);
            used += block.length;
        }
        return sections.length > 0
            ? sections.join('\n\n')
            : '(.github/instructions 存在，但未读取到可用规范内容)';
    }
    collectMarkdownFiles(dir, maxDepth, currentDepth = 0) {
        if (currentDepth > maxDepth || !fs.existsSync(dir)) {
            return [];
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...this.collectMarkdownFiles(full, maxDepth, currentDepth + 1));
                continue;
            }
            if (entry.isFile() && /\.md$/i.test(entry.name)) {
                files.push(full);
            }
        }
        return files.sort();
    }
    resolveTaskPlanFile() {
        const preferred = path.join(this.iterDir, ...models_1.TASK_PLAN_PRIMARY_REL_PATH.split('/'));
        const legacy = path.join(this.iterDir, ...models_1.TASK_PLAN_LEGACY_REL_PATH.split('/'));
        if (fs.existsSync(preferred)) {
            return preferred;
        }
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return preferred;
    }
    async dispatchTask(subTask, iterTask) {
        fs.mkdirSync(path.join(this.iterDir, 'signals'), { recursive: true });
        fs.mkdirSync(path.join(this.iterDir, 'tests'), { recursive: true });
        fs.mkdirSync(path.join(this.iterDir, 'logs'), { recursive: true });
        this.updateSubTaskStatus(subTask.id, 'doing');
        this.onStatusChange();
        const query = this.buildDispatchQuery(subTask, iterTask);
        await this.dispatchAi(query, this.iterDir, 'dev-subtask');
        this.startTimeout(subTask.id);
    }
    async dispatchNext(iterTask) {
        const next = this.getNextTask();
        if (!next) {
            vscode.window.showInformationMessage('🎉 所有编码任务已完成！');
            this.autoMode = false;
            return false;
        }
        await this.dispatchTask(next, iterTask);
        return true;
    }
    startWatching(iterTask) {
        if (this.watcher)
            return;
        const signalsDir = path.join(this.iterDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });
        const pattern = new vscode.RelativePattern(signalsDir, 'done-*');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidCreate(async (uri) => {
            const fileName = path.basename(uri.fsPath);
            const taskId = fileName.replace('done-', '');
            this.clearTimeout();
            this.writeLog(taskId, `信号文件检测到: ${fileName}`);
            const testScript = path.join(this.iterDir, 'tests', `test-${taskId}.sh`);
            const testScriptPs = path.join(this.iterDir, 'tests', `test-${taskId}.ps1`);
            const subTasks = this.parseTasksMd();
            const subTask = subTasks.find(t => t.id === taskId);
            let outputOk = true;
            const expectedOutputFiles = this.getPathLikeOutputs(subTask);
            const signalFiles = this.readSignalFiles(uri.fsPath);
            const filesToCheck = expectedOutputFiles.length > 0 ? expectedOutputFiles : signalFiles;
            for (const f of filesToCheck) {
                const fullPath = path.isAbsolute(f) ? f : path.join(this.iterDir, f);
                if (!fs.existsSync(fullPath)) {
                    outputOk = false;
                    break;
                }
            }
            if (outputOk) {
                if (fs.existsSync(testScriptPs)) {
                    this.writeLog(taskId, `ℹ 检测到测试脚本，可按需手动执行: ${testScriptPs}`);
                }
                else if (fs.existsSync(testScript)) {
                    this.writeLog(taskId, `ℹ 检测到测试脚本，可按需手动执行: ${testScript}`);
                }
                if (this.autoMode) {
                    this.updateSubTaskStatus(taskId, 'done');
                    this.writeLog(taskId, `✅ 输出校验通过（检查文件数: ${filesToCheck.length}），自动标记完成`);
                    this.onStatusChange();
                    await this.dispatchNext(iterTask);
                }
                else {
                    const choice = await vscode.window.showInformationMessage(`✅ 任务 ${taskId} 信号已到达，确认推进？`, '确认完成', '人工检查');
                    if (choice === '确认完成') {
                        this.updateSubTaskStatus(taskId, 'done');
                        this.writeLog(taskId, '✅ 用户确认完成');
                        this.onStatusChange();
                    }
                }
            }
            else {
                this.updateSubTaskStatus(taskId, 'failed');
                this.writeLog(taskId, `❌ 输出文件不完整（检查文件数: ${filesToCheck.length}）`);
                this.onStatusChange();
                this.autoMode = false;
                vscode.window.showWarningMessage(`❌ 任务 ${taskId} 输出文件不完整`);
            }
        });
    }
    stopWatching() {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
        this.clearTimeout();
        this.autoMode = false;
    }
    async startAuto(iterTask) {
        this.autoMode = true;
        this.startWatching(iterTask);
        const currentDoing = this.getCurrentTask();
        if (currentDoing) {
            vscode.window.showInformationMessage(`⏳ 等待任务 ${currentDoing.id} 完成...`);
            this.startTimeout(currentDoing.id);
            return;
        }
        await this.dispatchNext(iterTask);
    }
    pause() {
        this.autoMode = false;
        this.clearTimeout();
        vscode.window.showInformationMessage('⏸ 自动执行已暂停');
    }
    isAutoMode() {
        return this.autoMode;
    }
    async manualNext(iterTask) {
        const current = this.getCurrentTask();
        if (current) {
            this.updateSubTaskStatus(current.id, 'done');
            this.writeLog(current.id, '⏭ 用户手动标记完成');
        }
        this.clearTimeout();
        this.onStatusChange();
        this.startWatching(iterTask);
        await this.dispatchNext(iterTask);
    }
    async retryTask(taskId, iterTask) {
        this.updateSubTaskStatus(taskId, 'todo');
        this.onStatusChange();
        const signalFile = path.join(this.iterDir, 'signals', `done-${taskId}`);
        if (fs.existsSync(signalFile)) {
            fs.unlinkSync(signalFile);
        }
        const subTasks = this.parseTasksMd();
        const subTask = subTasks.find(t => t.id === taskId);
        if (subTask) {
            this.startWatching(iterTask);
            await this.dispatchTask(subTask, iterTask);
        }
    }
    startTimeout(taskId) {
        this.clearTimeout();
        this.timeoutTimer = setTimeout(() => {
            this.updateSubTaskStatus(taskId, 'failed');
            this.writeLog(taskId, '⏰ 超时（5分钟无信号）');
            this.onStatusChange();
            this.autoMode = false;
            vscode.window.showWarningMessage(`⏰ 任务 ${taskId} 超时（5分钟无信号），已标记失败`);
        }, 5 * 60 * 1000);
    }
    clearTimeout() {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }
    writeLog(taskId, message) {
        const logPath = path.join(this.iterDir, 'logs', `task-${taskId}.log`);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    }
    getPathLikeOutputs(subTask) {
        if (!subTask || subTask.output.length === 0) {
            return [];
        }
        return subTask.output
            .map(item => item.trim())
            .filter(item => this.looksLikeFilePath(item));
    }
    looksLikeFilePath(value) {
        if (!value) {
            return false;
        }
        if (/[\u4e00-\u9fa5]/.test(value) && !/[\\/]/.test(value)) {
            return false;
        }
        if (/[\\/]/.test(value)) {
            return true;
        }
        return /^[\w.-]+\.[a-zA-Z0-9]+$/.test(value);
    }
    readSignalFiles(signalPath) {
        if (!fs.existsSync(signalPath)) {
            return [];
        }
        try {
            const content = fs.readFileSync(signalPath, 'utf8');
            const lines = content.split('\n');
            const files = [];
            let inFiles = false;
            for (const raw of lines) {
                const line = raw.trimEnd();
                if (!inFiles) {
                    if (/^files\s*:\s*$/i.test(line.trim())) {
                        inFiles = true;
                    }
                    continue;
                }
                const match = line.match(/^\s*-\s+(.+)$/);
                if (match) {
                    files.push(match[1].trim());
                    continue;
                }
                if (line.trim()) {
                    break;
                }
            }
            return files;
        }
        catch {
            return [];
        }
    }
}
exports.TaskScheduler = TaskScheduler;
//# sourceMappingURL=taskScheduler.js.map