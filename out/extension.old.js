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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
let harness;
let workspaceRoot;
let extensionPath;
const BASE = '.harness';
const PROMPTS_DIR = 'prompts';
const STAGE = {
    INITIALIZING: '⌛ 初始化中',
    WRITING_REQUIREMENT: '📝 撰写需求',
    WRITING_DESIGN: '📘 技术设计',
    WRITING_TASKS: '📋 任务拆解',
    DEVELOPING: '⚙️ 开发中',
    READY_FOR_REVIEW: '⏳ 待审核',
    DONE: '✅ 已完成'
};
const AGENT_DIR = '.github/agents';
const PROMPT_CONFIGS = [
    { key: 'req', name: '需求生成 Agent', file: 'requirements_agent.md' },
    { key: 'des', name: '技术设计 Agent', file: 'design_agent.md' },
    { key: 'tsk', name: '任务拆解 Agent', file: 'tasks_agent.md' },
    { key: 'dev', name: '全栈开发 Agent', file: 'dev_agent.md' }
];
function activate(context) {
    extensionPath = context.extensionPath;
    harness = new Harness(context);
    harness.init();
    context.subscriptions.push(vscode.commands.registerCommand('fun-harness.open', () => {
        harness.panel ? harness.panel.reveal() : harness.createPanel();
    }), vscode.commands.registerCommand('fun-harness.runAgent', async (args) => {
        if (harness && args.step && args.id) {
            const task = harness.tasks.find(t => t.id === args.id);
            if (task) {
                const prompt = harness.getRenderedPrompt(args.step, task);
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: prompt,
                    isPartial: false,
                });
            }
        }
    }));
}
class Harness {
    constructor(context) {
        this.panel = null;
        this.tasks = [];
        this.currentPage = 'main';
        this.selectedPromptKey = 'req';
        this.config = { frontendGit: '', backendGit: '' };
        this.context = context;
    }
    init() {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root)
            return;
        workspaceRoot = root.uri.fsPath;
        this.ensurePromptsInHarness();
        this.createAgentDefinitions();
        this.loadTasks();
        this.loadConfig();
        this.createPanel();
        this.bindMessages();
        setInterval(() => {
            if (this.currentPage === 'main')
                this.render();
        }, 2000);
    }
    /** Copy bundled prompts to .harness/prompts/ if not already present */
    ensurePromptsInHarness() {
        const targetDir = this.getProjectPromptsDir();
        fs.mkdirSync(targetDir, { recursive: true });
        for (const cfg of PROMPT_CONFIGS) {
            const target = path.join(targetDir, cfg.file);
            if (!fs.existsSync(target)) {
                const source = this.getBundledPromptFile(cfg.key);
                if (fs.existsSync(source)) {
                    fs.copyFileSync(source, target);
                }
            }
        }
    }
    /** Create .prompt.md files for each agent */
    createAgentDefinitions() {
        const agentDir = path.join(workspaceRoot, AGENT_DIR);
        fs.mkdirSync(agentDir, { recursive: true });
        for (const cfg of PROMPT_CONFIGS) {
            const agentFile = path.join(agentDir, `fun-harness-${cfg.key}.agent.md`);
            const promptContent = this.getBundledPromptContent(cfg.key);
            const agentDefinition = `---
name: fun-harness-${cfg.key}
description: ${cfg.name}
argument-hint: "The task name, description, and output path"
---

${promptContent}
`;
            fs.writeFileSync(agentFile, agentDefinition, 'utf8');
        }
    }
    /** Directory where project-level (user-editable) prompts live */
    getProjectPromptsDir() {
        return path.join(workspaceRoot, BASE, PROMPTS_DIR);
    }
    /** Path to the bundled (original) prompt inside the extension */
    getBundledPromptFile(key) {
        const item = PROMPT_CONFIGS.find(i => i.key === key);
        return path.join(extensionPath, PROMPTS_DIR, item.file);
    }
    getBundledPromptContent(key) {
        const file = this.getBundledPromptFile(key);
        if (fs.existsSync(file)) {
            return fs.readFileSync(file, 'utf8');
        }
        return '';
    }
    /** Path to the user-editable prompt in .harness/prompts/ */
    getPromptFile(key) {
        const item = PROMPT_CONFIGS.find(i => i.key === key);
        return path.join(this.getProjectPromptsDir(), item.file);
    }
    getConfigPath() {
        return path.join(workspaceRoot, BASE, 'config.json');
    }
    loadConfig() {
        const p = this.getConfigPath();
        if (fs.existsSync(p)) {
            this.config = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
    }
    saveConfig() {
        const p = this.getConfigPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(this.config, null, 2), 'utf8');
    }
    getRenderedPrompt(step, task) {
        const file = this.getPromptFile(step);
        if (!fs.existsSync(file))
            return '';
        let content = fs.readFileSync(file, 'utf8');
        const dir = this.getIterationDir(task);
        return content
            .replace(/{{taskName}}/g, task.name)
            .replace(/{{taskDesc}}/g, task.desc)
            .replace(/{{outputPath}}/g, dir);
    }
    /** Reset a single prompt back to the bundled original */
    resetPromptToOriginal(key) {
        const bundled = this.getBundledPromptFile(key);
        const target = this.getPromptFile(key);
        if (fs.existsSync(bundled)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(bundled, target);
        }
    }
    async execCmd(cmd, cwd) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(cmd, { cwd }, (err) => {
                if (err)
                    console.error(`EXEC ERROR: ${err.message}`);
                resolve(!err);
            });
        });
    }
    async createGitBranch(task) {
        const branchName = task.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        if (!branchName || branchName.length < 2) {
            vscode.window.showErrorMessage('迭代名称必须使用英文');
            return;
        }
        if (!this.config.frontendGit && !this.config.backendGit) {
            vscode.window.showErrorMessage('请先在高级设置配置至少一个 Git 地址');
            return;
        }
        task.stage = STAGE.INITIALIZING;
        this.saveAndRender();
        const iterDir = this.getIterationDir(task);
        if (this.config.frontendGit) {
            const frontendDir = path.join(iterDir, 'frontend');
            if (!fs.existsSync(frontendDir)) {
                fs.mkdirSync(frontendDir, { recursive: true });
                await this.execCmd(`git clone ${this.config.frontendGit} .`, frontendDir);
            }
            await this.execCmd(`git checkout main`, frontendDir);
            await this.execCmd(`git pull`, frontendDir);
            await this.execCmd(`git checkout -b ${branchName}`, frontendDir);
        }
        if (this.config.backendGit) {
            const backendDir = path.join(iterDir, 'backend');
            if (!fs.existsSync(backendDir)) {
                fs.mkdirSync(backendDir, { recursive: true });
                await this.execCmd(`git clone ${this.config.backendGit} .`, backendDir);
            }
            await this.execCmd(`git checkout main`, backendDir);
            await this.execCmd(`git pull`, backendDir);
            await this.execCmd(`git checkout -b ${branchName}`, backendDir);
        }
        task.stage = STAGE.WRITING_REQUIREMENT;
        this.saveAndRender();
        vscode.window.showInformationMessage(`✅ 迭代初始化完成，分支：${branchName}`);
    }
    async pushAllCode(task) {
        const iterDir = this.getIterationDir(task);
        if (this.config.frontendGit) {
            const frontendDir = path.join(iterDir, 'frontend');
            await this.execCmd(`git add . && git commit -m "AI auto commit" && git push origin HEAD`, frontendDir);
        }
        if (this.config.backendGit) {
            const backendDir = path.join(iterDir, 'backend');
            await this.execCmd(`git add . && git commit -m "AI auto commit" && git push origin HEAD`, backendDir);
        }
        vscode.window.showInformationMessage('✅ 代码已全部推送');
    }
    getTaskJson() {
        return path.join(workspaceRoot, BASE, 'tasks.json');
    }
    loadTasks() {
        const file = this.getTaskJson();
        if (fs.existsSync(file)) {
            this.tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    }
    saveTasks() {
        const file = this.getTaskJson();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(this.tasks, null, 2), 'utf8');
    }
    getIterationDir(task) {
        return path.join(workspaceRoot, BASE, `iteration-${task.name}`);
    }
    getTaskStats(task) {
        const iterDir = this.getIterationDir(task);
        const tasksFile = path.join(iterDir, 'tasks.md');
        if (!fs.existsSync(tasksFile)) {
            return { total: 0, todo: 0, doing: 0, done: 0 };
        }
        const content = fs.readFileSync(tasksFile, 'utf8');
        const total = (content.match(/^-\s*\[/gm) || []).length;
        const done = (content.match(/^-\s*\[\s*x\s*\]/gim) || []).length;
        const doing = (content.match(/^-\s*\[\s*doing\s*\]/gim) || []).length;
        const todo = total - done - doing;
        return { total, todo, doing, done };
    }
    render() {
        if (!this.panel)
            return;
        if (this.currentPage === 'settings')
            return this.renderSettings();
        const running = this.tasks.filter(t => t.stage !== STAGE.DONE);
        this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#111;color:#eee;padding:14px;font-family:-apple-system;padding-bottom:170px}
.nav{display:flex;gap:8px;margin-bottom:10px}
.nav-btn{flex:1;padding:8px;border-radius:8px;border:none;background:#222;color:#eee}
.nav-btn.active{background:#007aff}
.header{display:flex;justify-content:space-between;align-items:center}
.refresh{background:#007aff;color:white;border:none;padding:6px 10px;border-radius:8px;font-size:12px}
.task-item{background:#222;border-radius:10px;padding:12px;margin-bottom:10px}
.task-name{font-weight:600;margin-bottom:6px}
.task-desc{font-size:12px;color:#999}
.task-progress{height:6px;background:#333;border-radius:3px;margin:6px 0}
.progress-bar{height:100%;background:#34c759}
.task-status{font-size:12px;color:#ccc;margin-top:4px}
.action{display:flex;gap:8px;margin-top:10px}
.action button{flex:1;padding:8px;border-radius:8px;border:none;font-size:12px}
.btn-blue{background:#007aff;color:white}
.btn-green{background:#34c759;color:white}
.btn-gray{background:#444}
.fixed-bottom{position:fixed;left:14px;right:14px;bottom:10px}
.input-card{background:#1c1c1e;border-radius:12px;padding:12px}
input,textarea{width:100%;padding:10px;border-radius:8px;border:none;background:#2c2c2e;color:#fff;margin-bottom:8px}
.btn-primary{background:#007aff;color:white;padding:10px;border:none;border-radius:8px;width:100%}
</style>
</head>
<body>

<div class="nav">
<button class="nav-btn active" onclick="p('main')">任务面板</button>
<button class="nav-btn" onclick="p('settings')">高级设置</button>
</div>

<div class="header">
<h4>📌 迭代任务</h4>
<button class="refresh" onclick="refresh()">🔄 刷新</button>
</div>

${running.map(t => {
            const { total, todo, doing, done } = this.getTaskStats(t);
            const p = total > 0 ? Math.round((done / total) * 100) : 0;
            return `
<div class="task-item">
<div class="task-name">${t.name}</div>
<div class="task-desc">${t.desc}</div>
<div>阶段：${t.stage}</div>
<div class="task-status">待办:${todo} 执行中:${doing} 完成:${done}</div>
<div class="task-progress"><div class="progress-bar" style="width:${p}%"></div></div>
<div style="font-size:12px">进度：${p}%</div>
<div class="action">
${t.stage === STAGE.WRITING_REQUIREMENT ? `<button class="btn-gray" onclick="runAgent('req','${t.id}')">🤖 运行需求 Agent</button><button class="btn-blue" onclick="next('req','${t.id}')">✅ 确认需求</button>` : ''}
${t.stage === STAGE.WRITING_DESIGN ? `<button class="btn-gray" onclick="runAgent('des','${t.id}')">🤖 运行设计 Agent</button><button class="btn-blue" onclick="next('des','${t.id}')">✅ 确认设计</button>` : ''}
${t.stage === STAGE.WRITING_TASKS ? `<button class="btn-gray" onclick="runAgent('tsk','${t.id}')">🤖 运行任务 Agent</button><button class="btn-blue" onclick="next('tsk','${t.id}')">✅ 确认任务</button>` : ''}
${t.stage === STAGE.DEVELOPING ? `<button class="btn-gray" onclick="runAgent('dev','${t.id}')">🤖 运行开发 Agent</button><button class="btn-green" onclick="pushAll('${t.id}')">🚀 推送代码</button><button class="btn-blue" onclick="next('dev','${t.id}')">✅ 完成开发</button>` : ''}
${t.stage === STAGE.READY_FOR_REVIEW ? `<button class="btn-green" onclick="pass('${t.id}')">🏁 结束</button>` : ''}
</div>
</div>`;
        }).join('')}

<div class="fixed-bottom">
<div class="input-card">
<h4>🚀 创建迭代开发版本</h4>
<input id="name" placeholder="迭代名称（英文）">
<textarea id="desc" rows="2" placeholder="功能描述"></textarea>
<button class="btn-primary" onclick="create()">创建迭代开发版本</button>
</div>
</div>

<script>
const v=acquireVsCodeApi();
function p(x){v.postMessage({type:'page',page:x})}
function create(){
    const name = document.getElementById('name').value.trim();
    const desc = document.getElementById('desc').value.trim();
    if(!name){alert('请输入迭代名称（英文）');return;}
    v.postMessage({type:'create',name,desc});
    document.getElementById('name').value='';
    document.getElementById('desc').value='';
}
function runAgent(s,id){v.postMessage({type:'runAgent',step:s,id})}
function next(s,id){v.postMessage({type:'next',step:s,id})}
function pass(id){v.postMessage({type:'pass',id})}
function refresh(){v.postMessage({type:'refresh'})}
function pushAll(id){v.postMessage({type:'pushAll',id})}
</script>
</body>
</html>`;
    }
    renderSettings() {
        if (!this.panel)
            return;
        const opts = PROMPT_CONFIGS.map(o => `<option value="${o.key}" ${o.key === this.selectedPromptKey ? 'selected' : ''}>${o.name}</option>`).join('');
        this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{background:#111;color:#eee;padding:14px}
.nav{display:flex;gap:8px;margin-bottom:10px}
.nav-btn{flex:1;padding:8px;border-radius:8px;border:none;background:#222}
.nav-btn.active{background:#007aff}
h5{margin:10px 0 4px}
input, select{width:100%;padding:10px;border-radius:8px;border:none;background:#222;color:#fff;margin-bottom:8px}
button{width:100%;padding:10px;border-radius:8px;border:none;color:white;margin-top:10px}
.btn-init{background:#ff3b30}
</style>
</head>
<body>

<div class="nav">
<button class="nav-btn" onclick="p('main')">任务面板</button>
<button class="nav-btn active" onclick="p('settings')">高级设置</button>
</div>

<h5>前端 Git 地址（可选）</h5>
<input id="fg" value="${this.config.frontendGit || ''}">

<h5>后端 Git 地址（可选）</h5>
<input id="bg" value="${this.config.backendGit || ''}">

<button onclick="saveGit()" style="background:#007aff">💾 保存Git配置</button>

<h5 style="margin-top:16px">恢复 Agent Prompt</h5>
<select id="sel" onchange="sel()">${opts}</select>
<button onclick="init()" class="btn-init">恢复选定的 Agent Prompt 出厂设置</button>

<script>
const v=acquireVsCodeApi();
function p(x){v.postMessage({type:'page',page:x})}
function sel(){v.postMessage({type:'sel',key:document.getElementById('sel').value})}
function init(){if(confirm('确定恢复选定的 Agent Prompt 出厂设置？'))v.postMessage({type:'initAgent'})}
function saveGit(){v.postMessage({type:'saveGit',fg:document.getElementById('fg').value,bg:document.getElementById('bg').value})}
</script>
</body>
</html>`;
    }
    bindMessages() {
        if (!this.panel)
            return;
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            const task = this.tasks.find(x => x.id === msg.id);
            switch (msg.type) {
                case 'page':
                    this.currentPage = msg.page;
                    this.render();
                    break;
                case 'refresh':
                    this.loadTasks();
                    this.render();
                    break;
                case 'sel':
                    this.selectedPromptKey = msg.key;
                    break;
                case 'initAgent': {
                    const agentDir = path.join(workspaceRoot, AGENT_DIR);
                    const agentFile = path.join(agentDir, `fun-harness-${this.selectedPromptKey}.agent.md`);
                    const promptContent = this.getBundledPromptContent(this.selectedPromptKey);
                    const agentDefinition = `---
name: fun-harness-${this.selectedPromptKey}
description: ${PROMPT_CONFIGS.find(c => c.key === this.selectedPromptKey)?.name}
argument-hint: "The task name, description, and output path"
---

${promptContent}
`;
                    fs.writeFileSync(agentFile, agentDefinition, 'utf8');
                    vscode.window.showInformationMessage('✅ Agent Prompt 已恢复出厂设置');
                    break;
                }
                case 'saveGit':
                    this.config.frontendGit = msg.fg;
                    this.config.backendGit = msg.bg;
                    this.saveConfig();
                    vscode.window.showInformationMessage('✅ Git 配置已保存');
                    break;
                case 'create': {
                    const id = 'task_' + Date.now();
                    const newTask = { id, name: msg.name, desc: msg.desc, stage: STAGE.INITIALIZING };
                    this.tasks.push(newTask);
                    fs.mkdirSync(this.getIterationDir(newTask), { recursive: true });
                    this.saveAndRender();
                    await this.createGitBranch(newTask);
                    break;
                }
                case 'pushAll':
                    if (task)
                        await this.pushAllCode(task);
                    break;
                case 'runAgent': {
                    if (!task)
                        break;
                    const slashCommands = {
                        req: 'fun-harness-requirement',
                        des: 'fun-harness-design',
                        tsk: 'fun-harness-task',
                        dev: 'fun-harness-dev'
                    };
                    const slashCommand = slashCommands[msg.step];
                    if (!slashCommand)
                        break;
                    const iterDir = this.getIterationDir(task);
                    const query = `/${slashCommand} taskName=${task.name} taskDesc='${task.desc}' outputPath=${iterDir}`;
                    await vscode.commands.executeCommand('workbench.action.chat.open', {
                        query: query,
                        isPartial: false,
                    });
                    break;
                }
                case 'next':
                    if (!task)
                        break;
                    if (msg.step === 'req')
                        task.stage = STAGE.WRITING_DESIGN;
                    if (msg.step === 'des')
                        task.stage = STAGE.WRITING_TASKS;
                    if (msg.step === 'tsk')
                        task.stage = STAGE.DEVELOPING;
                    if (msg.step === 'dev')
                        task.stage = STAGE.READY_FOR_REVIEW;
                    this.saveAndRender();
                    break;
                case 'pass':
                    if (!task)
                        break;
                    task.stage = STAGE.DONE;
                    this.saveAndRender();
                    vscode.window.showInformationMessage(`✅ ${task.name} 完成`);
                    break;
            }
        });
    }
    createPanel() {
        this.panel = vscode.window.createWebviewPanel('harness', '🤖 AI 研发流程', vscode.ViewColumn.Beside, { enableScripts: true });
        this.render();
        this.panel.onDidDispose(() => this.panel = null);
    }
    saveAndRender() {
        this.saveTasks();
        this.render();
    }
}
function deactivate() { }
//# sourceMappingURL=extension.old.js.map