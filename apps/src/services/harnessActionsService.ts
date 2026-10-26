import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { HarnessStep } from '../harnessMessages';
import {
    BASE,
    AiQuickChatButton,
    Config,
    CustomButton,
    CUSTOM_SCRIPT_DIR,
    DEFAULT_MONOREPO_DIRS,
    HARNESS_STATE_FILE,
    HARNESS_STATE_FILE_LEGACY,
    HookEntry,
    STAGE,
    FEATURE_PLAN_LEGACY_REL_PATH,
    FEATURE_PLAN_PRIMARY_REL_PATH,
    Feature,
    DevRollbackSnapshot,
    getScriptsSubdir,
    getSpecFile,
    getSpecFileRel,
    getLegacySpecDocsRelSegments,
    resolveGateLevel,
    resolveSpecFile,
    resolveFeaturePlanFileForIteration,
    getDocsRootDirName,
    isOsScriptFile,
    isAiQuickChatButtonValid,
    normalizeCustomButton,
} from '../models';
import { FeatureScheduler } from '../featureScheduler';
import { GitService } from './gitService';
import { appendHarnessLog } from './harnessLog';
import { extractMachineBlock, validateTraceability } from '../specTrace';
import { readTextIfExists, safeRemovePath, writeTextAtomic } from './fileOps';
import { SpecDeltaService } from './specDeltaService';
import { CapabilityDeltaService } from './capabilityDeltaService';
import { DomainKnowledgeAggregateService, SuspectedDomainRecord } from './domainKnowledgeAggregateService';
import { DomainAdjudicationDecision, DomainRegistryService } from './domainRegistryService';
import { CodeGraphEvidenceSnapshotWriter } from './codegraph/codeGraphEvidenceSnapshotWriter';
import { isCodeGraphInitialized } from './codegraph/codeGraphState';
import { resolvePathAgainstRoot } from './pathPolicy';
import { sanitizePopupText, showErrorMessageSafe, showWarningMessageSafe } from './popupMessage';

interface HarnessActionsDeps {
    getFeatures: () => Feature[];
    getConfig: () => Config;
    reloadConfig?: () => void;
    /** Master workspace root (the "主目录"), even when invoked from a worktree subview window. */
    getMasterRoot: () => string;
    getIterationDir: (task: Feature) => string;
    ensureIterationDir: (task: Feature) => void;
    saveAndRender: () => void;
    gitService: GitService;
    getScheduler: (task: Feature) => FeatureScheduler;
    stopScheduler: (featureId: string) => void;
    onPass: (task: Feature) => void;
    isWorktreeSubview: () => boolean;
    dispatchAi: (query: string, iterDir: string, source: 'stage-agent' | 'dev-subtask' | 'quick-chat-button', providerOverride?: string, context?: { stage?: string; taskId?: string }) => Promise<void>;
    runDomainSummaryAiRefiner?: (prompt: string) => string | null;
    copyProjectStructureToIteration: (iterDir: string) => void;
    renderAgentPrompt: (step: HarnessStep, featureName: string, featureDesc: string, iterDir: string) => { content: string; source: string; path: string };
    runCodeGraphInitOnFirstCreate?: (input: {
        featureId: string;
        taskName: string;
        worktreePath: string;
        entryPoint: 'openFolderLocationByFeatureId' | 'runCustomButtonByFeatureId' | 'syncCodeGraphByFeatureId';
    }) => Promise<void>;
}

export class HarnessActionsService {
    constructor(private readonly deps: HarnessActionsDeps) {}
    private specDeltaService?: SpecDeltaService;
    private capabilityDeltaService?: CapabilityDeltaService;
    private domainKnowledgeAggregateService?: DomainKnowledgeAggregateService;
    private domainRegistryService?: DomainRegistryService;
    /** Prevent duplicate prompt dispatch for the same (task, step) while one is in-flight. */
    private readonly inFlightStageDispatchKeys: Set<string> = new Set();
    /** Prevent duplicate git/push/merge actions for the same task while one is in-flight. */
    private readonly inFlightGitActionKeys: Set<string> = new Set();
    /** Prevent duplicate manual-complete auto-resume clicks while next subtask dispatch is in-flight. */
    private readonly inFlightManualResumeFeatureIds: Set<string> = new Set();
    private readonly artifactRepairTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly codeGraphEvidenceSnapshotWriter = new CodeGraphEvidenceSnapshotWriter();
    private static readonly DOMAIN_BLOCK_AUTO_FIX = '自动补';
    private static readonly DOMAIN_BLOCK_MANUAL_FIX = '去处理';

    isManualResumeInFlight(featureId: string): boolean {
        return this.inFlightManualResumeFeatureIds.has(featureId);
    }

    private readonly stageArtifacts = {
        req: 'requirements',
        des: 'design',
        tcs: 'testcase',
        tsk: 'tasks',
    } as const;

    private getSpecDeltaService(): SpecDeltaService {
        if (!this.specDeltaService) {
            this.specDeltaService = new SpecDeltaService(
                this.deps.getMasterRoot(),
                () => this.deps.getConfig(),
            );
        }
        return this.specDeltaService;
    }

    private getDomainKnowledgeAggregateService(): DomainKnowledgeAggregateService {
        if (!this.domainKnowledgeAggregateService) {
            this.domainKnowledgeAggregateService = new DomainKnowledgeAggregateService(
                undefined,
                undefined,
                (prompt) => this.deps.runDomainSummaryAiRefiner?.(prompt) || '',
            );
        }
        return this.domainKnowledgeAggregateService;
    }

    private getCapabilityDeltaService(): CapabilityDeltaService {
        if (!this.capabilityDeltaService) {
            this.capabilityDeltaService = new CapabilityDeltaService(this.getDomainRegistryService());
        }
        return this.capabilityDeltaService;
    }

    private getDomainRegistryService(): DomainRegistryService {
        if (!this.domainRegistryService) {
            this.domainRegistryService = new DomainRegistryService();
        }
        return this.domainRegistryService;
    }

    /**
     * Build a targeted drift-repair prompt that instructs the AI which spec documents
     * need to be updated to match the current code implementation.
     */
    private buildDriftRepairPrompt(task: Feature, iterDir: string, driftErrors: string[]): string {
        const cfg = this.deps.getConfig();
        const errorList = driftErrors.map((e, i) => `${i + 1}. ${e}`).join('\n');
        const reqPath = resolveSpecFile(iterDir, cfg, 'requirements.md');
        const desPath = resolveSpecFile(iterDir, cfg, 'design.md');
        const tcsPath = resolveSpecFile(iterDir, cfg, 'testcase.md');
        return [
            '## Spec 漂移修复指令（最高优先，覆盖其他指令）',
            '',
            `任务「${task.name}」的代码实现与 Spec 文档发生了不一致（漂移）。请根据下面的检测结果，最小化更新对应 Spec 文档，使文档与当前代码实现保持一致。`,
            '',
            '**检测到的漂移问题：**',
            errorList,
            '',
            '**目标文件：**',
            `- ${reqPath}`,
            `- ${desPath}`,
            `- ${tcsPath}`,
            '',
            '**修复要求：**',
            '1. 根据代码实际实现，更新对应文档的相关章节（requirements / design / testcase）',
            '2. 若 API 接口变更，更新 design.md 的 API 契约章节及机器可读 YAML 区的 apiContracts 字段',
            '3. 若行为/业务规则变更，更新 requirements.md 的验收标准（GIVEN/WHEN/THEN 格式）',
            '4. 若测试逻辑变更，更新 testcase.md 的用例清单',
            '5. 保持 Req-* 追溯闭环：所有引用的 Req-* 必须在 requirements.md 中有定义，不得引入悬空引用',
            '6. 只修改必要内容，不重写无关章节，不改变文档结构',
            '7. 更新完成后，在每份文档的机器可读 YAML 区确保 artifactType 字段正确',
        ].join('\n');
    }

    /**
     * Run the drift gate and:
     * - If passed: show warnings (non-blocking) and return true.
     * - If blocked and task-level repair is enabled: auto-dispatch the repair Agent (no confirmation), return false.
     */
    private async runDevDriftGateWithRepair(task: Feature): Promise<boolean> {
        if (task.specDriftRepairEnabled === false) {
            return true;
        }

        const iterDir = this.deps.getIterationDir(task);
        const result = this.getSpecDeltaService().evaluateDriftGate(task, iterDir);

        if (result.warnings.length > 0) {
            showWarningMessageSafe(`Spec Delta 漂移告警：${result.warnings.slice(0, 2).join('；')}`);
        }
        if (result.passed) {
            return true;
        }

        const repairPrompt = this.buildDriftRepairPrompt(task, iterDir, result.errors);
        const briefErrors = result.errors.slice(0, 3).join('；');

        // Auto-repair is enabled by default (specDriftRepairEnabled !== false), so dispatch
        // the repair Agent immediately instead of asking the user to confirm every time.
        try {
            await this.deps.dispatchAi(repairPrompt, iterDir, 'stage-agent', task.aiProvider);
            vscode.window.showInformationMessage(`Spec Delta 漂移门禁阻断：${briefErrors}\n已自动派发 Spec 文档修复 Agent，请在 AI 完成后重新触发本操作。`);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            showWarningMessageSafe(`Spec Delta 漂移门禁阻断：${briefErrors} 自动修复派发失败：${msg}`);
        }
        return false;
    }

    private runDevDriftGateOrNotify(task: Feature): { passed: boolean; errors: string[]; warnings: string[]; digestPath: string } {
        const iterDir = this.deps.getIterationDir(task);
        const result = this.getSpecDeltaService().evaluateDriftGate(task, iterDir);
        if (result.warnings.length > 0) {
            showWarningMessageSafe(`Spec Delta 漂移告警：${result.warnings.slice(0, 2).join('；')}（详情见 ${result.digestPath}）`);
        }
        return result;
    }

    /**
     * Final execution gate runs at pass/merge time instead of subtask completion.
     * - relaxed: skip
     * - standard: run acceptance script `tests/test-api.*` when present
     * - strict: run acceptance + all `tests/test-<id>.*` scripts for current OS
     * Missing scripts are non-blocking.
     */
    private async runFinalExecutionGate(task: Feature, iterDir: string): Promise<{
        passed: boolean;
        skipped: boolean;
        summary: string;
        outputTail: string;
    }> {
        const gate = resolveGateLevel(this.deps.getConfig());
        if (gate === 'relaxed') {
            return {
                passed: true,
                skipped: true,
                summary: 'gateLevel=relaxed，跳过最终执行门禁',
                outputTail: '',
            };
        }

        const isWin = process.platform === 'win32';
        const ext = isWin ? '.ps1' : '.sh';
        const testsDir = path.join(iterDir, 'tests');
        const scriptMap = new Map<string, string>();

        const acceptance = path.join(testsDir, `test-api${ext}`);
        if (fs.existsSync(acceptance)) {
            scriptMap.set('test-api', acceptance);
        }

        if (gate === 'strict' && fs.existsSync(testsDir)) {
            for (const name of fs.readdirSync(testsDir)) {
                if (!name.toLowerCase().endsWith(ext)) {
                    continue;
                }
                if (!/^test-\d+\.\d+/.test(name)) {
                    continue;
                }
                const key = name.slice(0, -ext.length);
                scriptMap.set(key, path.join(testsDir, name));
            }
        }

        const scripts = Array.from(scriptMap.entries())
            .map(([name, file]) => ({ name, file }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (scripts.length === 0) {
            return {
                passed: true,
                skipped: true,
                summary: `gateLevel=${gate}，未发现可执行脚本`,
                outputTail: '',
            };
        }

        const failed: Array<{ name: string; code: number; timedOut: boolean; output: string }> = [];
        for (const script of scripts) {
            appendHarnessLog(iterDir, 'execution-gate', `[${task.id}] ▶ final-gate run ${script.name} (${script.file})`);
            const result = await this.runScriptForGate(script.file, iterDir);
            if (result.code !== 0 || result.timedOut) {
                failed.push({
                    name: script.name,
                    code: result.code,
                    timedOut: result.timedOut,
                    output: result.output,
                });
            }
            appendHarnessLog(
                iterDir,
                'execution-gate',
                `[${task.id}] ${result.code === 0 && !result.timedOut ? '✅' : '❌'} final-gate ${script.name} exit=${result.code}${result.timedOut ? ' timeout' : ''}`,
            );
        }

        if (failed.length === 0) {
            return {
                passed: true,
                skipped: false,
                summary: `执行门禁通过（${scripts.map(item => item.name).join('、')}）`,
                outputTail: '',
            };
        }

        const summary = failed.map(item => `${item.name}(exit=${item.code}${item.timedOut ? ',timeout' : ''})`).join('、');
        const outputTail = failed
            .map(item => `# ${item.name}\n${(item.output || '').trim().slice(-1200)}`)
            .filter(Boolean)
            .join('\n\n');

        return {
            passed: false,
            skipped: false,
            summary,
            outputTail,
        };
    }

    private runScriptForGate(scriptFile: string, cwd: string): Promise<{ code: number; timedOut: boolean; output: string }> {
        return new Promise((resolve) => {
            const isPs = scriptFile.toLowerCase().endsWith('.ps1');
            const cmd = isPs ? 'powershell' : (process.platform === 'win32' ? 'bash' : 'sh');
            const args = isPs
                ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile]
                : [scriptFile];

            let settled = false;
            let output = '';
            const capture = (buf: Buffer): void => {
                output += buf.toString();
                if (output.length > 8000) {
                    output = output.slice(-8000);
                }
            };

            let child;
            try {
                child = spawn(cmd, args, { cwd, shell: false });
            } catch {
                resolve({ code: -1, timedOut: false, output });
                return;
            }

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { child.kill(); } catch { /* ignore */ }
                    resolve({ code: -1, timedOut: true, output });
                }
            }, 180_000);

            child.stdout?.on('data', capture);
            child.stderr?.on('data', capture);
            child.on('error', () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: -1, timedOut: false, output });
                }
            });
            child.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: code ?? -1, timedOut: false, output });
                }
            });
        });
    }

    private showLocalBaseFallbackNoticeIfAny(): void {
        const notice = this.deps.gitService.consumeLocalBaseFallbackNotice();
        if (notice) {
            vscode.window.showInformationMessage(notice);
        }
    }

    private replaceTemplateVars(template: string, vars: Record<string, string>): string {
        let rendered = template;
        for (const [key, value] of Object.entries(vars)) {
            const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rendered = rendered.replace(new RegExp(`{{\\s*${safeKey}\\s*}}`, 'g'), value ?? '');
        }
        return rendered;
    }

    private renderQuickDevPrompt(template: string, task: Feature, iterDir: string): string {
        const signalsDir = path.join(iterDir, 'signals');
        const techStack = (this.deps.getConfig().techStack || '').trim();
        const codingStandards = (this.deps.getConfig().codingStandards || '').trim();
        const docsRel = getSpecFileRel(iterDir, this.deps.getConfig(), '').replace(/[/\\]+$/, '') || 'docs';
        const vars: Record<string, string> = {
            currentWorkSpace: iterDir,
            docsDir: docsRel,
            signalsDir,
            taskName: task.name || '',
            taskDesc: task.desc || '',
            subTaskId: task.id,
            subTaskName: task.name || '',
            subTaskOwner: 'FullStack',
            techStack,
            codingStandards,
            designContext: task.desc || '',
            outputFiles: '- (快捷模式未拆分子任务，请按任务描述输出实现文件)',
            acceptanceCriteria: '- 代码可正常编译运行并满足任务描述',
            'current ISO timestamp': new Date().toISOString(),
            'list each file you created, one per line': '请按实际创建文件填写',
            'real Task ID from the instruction': task.id,
            'signals directory from the instruction': signalsDir,
        };
        const rendered = this.replaceTemplateVars(template, vars);
        // Final fallback: clear any unreplaced handlebars token so the dispatched prompt
        // never leaks literal {{token}} to the AI when users add custom placeholders.
        return rendered.replace(/{{\s*([^{}]+?)\s*}}/g, (_m, key) => vars[String(key).trim()] ?? '');
    }

    /**
     * Add explicit stage marker so downstream prompt consumers can audit stage-aware evidence injection.
     */
    private buildStageRuntimeSection(step: HarnessStep): string {
        return [
            '---',
            `运行时阶段标识：${step}`,
        ].join('\n');
    }

    private hasTaskPlan(iterDir: string): boolean {
        const canonical = resolveFeaturePlanFileForIteration(iterDir, this.deps.getConfig());
        const legacyFlat = path.join(iterDir, ...FEATURE_PLAN_PRIMARY_REL_PATH.split('/'));
        const legacyOld = path.join(iterDir, ...FEATURE_PLAN_LEGACY_REL_PATH.split('/'));
        return fs.existsSync(canonical) || fs.existsSync(legacyFlat) || fs.existsSync(legacyOld);
    }

    async createFeature(name: string, desc: string, quickMode?: boolean): Promise<void> {
        const id = `task_${Date.now()}`;
        const newTask: Feature = {
            id,
            name,
            desc,
            stage: STAGE.INITIALIZING,
            autoAdvanceEnabled: true,
            specDriftRepairEnabled: true,
            quickMode: Boolean(quickMode),
        };
        this.deps.getFeatures().push(newTask);
        this.deps.ensureIterationDir(newTask);
        // Lazy-init mode: do not auto-create git worktree here.
        // Worktree/checkout is created only when user explicitly opens the task worktree.
        if (newTask.quickMode) {
            newTask.stage = STAGE.DEVELOPING;
        } else {
            newTask.stage = STAGE.WRITING_REQUIREMENT;
        }
        this.deps.saveAndRender();
        if (newTask.quickMode) {
            // Skip requirements/design/testcase/task-split — jump straight to DEVELOPING.
            // Dev Agent runs with only task.desc and project context.
            vscode.window.showInformationMessage('已使用快捷模式：跳过文档生成，直接进入开发');
        } else {
            vscode.window.showInformationMessage('提示：代码目录将在点击任务的 Worktree 按钮时初始化');
        }
    }

    /**
     * Create an iteration task from a workspace todo and return the created task identity.
     */
    async createFeatureFromTodo(title: string, description: string): Promise<Feature> {
        const normalizedTitle = (title || '').trim();
        if (!normalizedTitle) {
            throw new Error('TODO-PROMOTE-001: 待办标题为空，无法创建迭代任务');
        }

        const normalizedDesc = (description || '').trim();
        const id = `task_${Date.now()}`;
        const newTask: Feature = {
            id,
            name: normalizedTitle,
            desc: normalizedDesc,
            stage: STAGE.INITIALIZING,
            autoAdvanceEnabled: true,
            specDriftRepairEnabled: true,
            quickMode: false,
        };

        this.deps.getFeatures().push(newTask);
        this.deps.ensureIterationDir(newTask);
        newTask.stage = STAGE.WRITING_REQUIREMENT;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`已从待办创建迭代任务：${newTask.name}`);
        return newTask;
    }

    async resetFeatureByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const iterDir = this.deps.getIterationDir(task);
        this.logTaskReset(task, `收到重置请求，当前阶段=${task.stage}`);

        const confirmLabel = '确认重置';
        const answer = await vscode.window.showWarningMessage(
            `重置任务「${task.name}」是不可回滚操作。将清空当前迭代代码与阶段进度，并回到需求阶段起点。是否继续？`,
            { modal: true, detail: '该操作会尝试移除当前迭代 worktree、重建代码目录，并重新从基线初始化。' },
            confirmLabel,
        );
        if (answer !== confirmLabel) {
            this.logTaskReset(task, '用户取消重置');
            return;
        }

        try {
            this.logTaskReset(task, '用户已确认，开始执行重置');
            vscode.window.showInformationMessage(`正在重置任务：${task.name}`);

            this.deps.stopScheduler(task.id);
            this.logTaskReset(task, '已停止自动调度器');

            const detachResult = await this.deps.gitService.detachIterationWorktrees(iterDir);
            if (!detachResult.success && detachResult.errors.length > 0) {
                this.logTaskReset(task, `worktree 清理告警：${detachResult.errors.join('；')}`);
                showWarningMessageSafe(`重置前 worktree 清理存在告警：${detachResult.errors.join('；')}`);
            }

            if (fs.existsSync(iterDir)) {
                if (this.deps.isWorktreeSubview()) {
                    this.logTaskReset(task, '当前为子面板模式，保留 .harness 并清空其余内容');
                    this.clearIterationDirContentsForSubview(iterDir);
                } else {
                    this.logTaskReset(task, `删除迭代目录：${iterDir}`);
                    this.deps.gitService.safeRemovePath(iterDir, { recursive: true });
                }
            }

            task.iterationBranch = undefined;
            task.baseBranchUsed = undefined;
            task.devRollbackSnapshot = undefined;
            task.stage = STAGE.INITIALIZING;
            this.logTaskReset(task, '任务状态已重置为 initializing，等待用户打开 Worktree 时重建代码');

            this.deps.ensureIterationDir(task);
            this.deps.saveAndRender();
            task.stage = STAGE.WRITING_REQUIREMENT;
            this.deps.saveAndRender();
            this.logTaskReset(task, `重置完成（懒初始化），当前阶段=${task.stage}`);
            vscode.window.showInformationMessage(`任务已重置：${task.name}（点击 Worktree 按钮时初始化代码）`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendHarnessLog(this.resolveTaskLogDir(task), 'reset', `重置失败：${message}`);
            showErrorMessageSafe('重置任务失败', { detail: message });
        }
    }

    /**
     * In a worktree subview the iteration dir is the current VS Code workspace root,
     * so deleting the folder itself is unsafe. Clear child entries and preserve .harness.
     */
    private clearIterationDirContentsForSubview(iterDir: string): void {
        this.deps.gitService.clearDirChildrenPreserving(iterDir, [BASE]);
    }

    private resolveTaskLogDir(task: Feature): string {
        const iterDir = this.deps.getIterationDir(task);
        // Lazy-init safety: before worktree attach, avoid creating iterDir/.harness via logs.
        if (iterDir && fs.existsSync(path.join(iterDir, '.git'))) {
            return iterDir;
        }
        return this.deps.getMasterRoot();
    }

    private logTaskReset(task: Feature, message: string): void {
        appendHarnessLog(this.resolveTaskLogDir(task), 'reset', `[${task.id}] ${message}`);
    }

    logUiEventByFeatureId(featureId: string, event: string, detail?: string): void {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const suffix = detail ? ` | ${detail}` : '';
        appendHarnessLog(this.resolveTaskLogDir(task), 'webview', `[${task.id}] ${event}${suffix}`);
    }

    updateFeatureDescByFeatureId(featureId: string, desc: string): void {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const trimmed = desc.trim();
        if (!trimmed) {
            this.logUiEventByFeatureId(featureId, 'updateTaskDesc.rejected', 'empty description');
            vscode.window.showWarningMessage('需求描述不能为空');
            return;
        }
        const oldLen = (task.desc || '').length;
        task.desc = trimmed;
        this.deps.saveAndRender();
        this.logUiEventByFeatureId(featureId, 'updateTaskDesc.saved', `oldLen=${oldLen};newLen=${trimmed.length}`);
        vscode.window.showInformationMessage(`已更新任务需求描述：${task.name}`);
    }

    async promptUpdateFeatureDescByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        const input = await vscode.window.showInputBox({
            title: `编辑需求描述：${task.name}`,
            value: task.desc ?? '',
            prompt: '请输入新的需求描述',
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() ? undefined : '需求描述不能为空',
        });

        if (input === undefined) {
            return;
        }

        this.updateFeatureDescByFeatureId(featureId, input);
    }

    setFeatureAutomationByFeatureId(featureId: string, aa: boolean): void {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        task.autoAdvanceEnabled = aa;
        this.deps.saveAndRender();
    }

    setSpecDriftRepairByFeatureId(featureId: string, enabled: boolean): void {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        task.specDriftRepairEnabled = enabled;
        this.deps.saveAndRender();
    }

    private async runExclusiveGitAction(task: Feature, action: string, runner: () => Promise<void>): Promise<void> {
        const key = `${task.id}:${action}`;
        if (this.inFlightGitActionKeys.has(key)) {
            showWarningMessageSafe(`已忽略重复触发：${task.name} 的 ${action} 正在执行中`);
            return;
        }
        this.inFlightGitActionKeys.add(key);
        try {
            await runner();
        } finally {
            this.inFlightGitActionKeys.delete(key);
        }
    }

    async pushAllByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        await this.runExclusiveGitAction(task, 'pushAll', async () => {
            const iterDir = this.deps.getIterationDir(task);
            vscode.window.showInformationMessage('正在推送代码...');
            const result = await this.deps.gitService.pushAll(task, iterDir);
            if (!result.success) {
                showErrorMessageSafe(result.message, { modal: true });
            } else {
                vscode.window.showInformationMessage(result.message);
            }
        });
    }

    private async submitBranchForReview(task: Feature, featureId: string): Promise<boolean> {
        // Reuse existing manual "Sync CodeGraph" implementation before submit,
        // but run it asynchronously so submit flow is never blocked.
        void this.syncCodeGraphByFeatureId(featureId, false).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error || 'unknown');
            showWarningMessageSafe(`CodeGraph 异步同步失败：${detail}`);
        });
        const passed = await this.runDevDriftGateWithRepair(task);
        if (!passed) {
            return false;
        }
        const domainSedimentation = await this.runDomainSedimentationWritable(task);
        if (!domainSedimentation.passed) {
            showErrorMessageSafe(`领域沉淀门禁未通过：${domainSedimentation.summary}`, { modal: true });
            return false;
        }
        vscode.window.showInformationMessage(domainSedimentation.summary);

        const iterDir = this.deps.getIterationDir(task);
        vscode.window.showInformationMessage('正在提交代码并创建/更新各远程 PR/MR...');
        const result = await this.deps.gitService.submitBranchForChangeRequests(task, iterDir);
        task.changeRequests = result.entries;
        this.deps.saveAndRender();
        if (!result.success) {
            const lines = (result.message || '未知错误').split('\n');
            const brief = sanitizePopupText(lines[0]);
            const extra = lines.slice(1).join('\n');
            showErrorMessageSafe(brief, { detail: extra || undefined, modal: true });
            return false;
        }
        vscode.window.showInformationMessage(result.message);
        return true;
    }

    private async runDomainSedimentationWritable(task: Feature): Promise<{ passed: boolean; summary: string }> {
        try {
            const workspaceRoot = this.deps.getMasterRoot();
            const docsRepoRoot = this.resolveDomainBaselineRepoRoot(workspaceRoot);
            this.ensureDomainRegistrySeed(workspaceRoot, docsRepoRoot);

            const iterDir = this.deps.getIterationDir(task);
            const iterationId = path.basename(path.resolve(iterDir));

            const capabilityDelta = this.getCapabilityDeltaService().generateForIteration(workspaceRoot, iterDir);
            const aggregateService = this.getDomainKnowledgeAggregateService();
            const context = aggregateService.loadDomainKnowledgeContext(docsRepoRoot, iterationId);
            const changeSet = context.draftChangeSet;

            const projection = aggregateService.previewProjection(
                changeSet,
                context.baselineVersion,
                context.baselineSnapshot,
                context.registry,
            );
            const { conflicts, blocking } = aggregateService.detectConflicts(
                changeSet,
                projection,
                context.baselineVersion,
            );
            if (blocking) {
                const blockingSummary = conflicts
                    .filter(item => item.severity === 'blocking')
                    .slice(0, 3)
                    .map(item => item.message)
                    .join('；');
                return {
                    passed: false,
                    summary: blockingSummary || '存在未解决的阻断冲突',
                };
            }

            const commitSummary = aggregateService.commitChangeSet(
                docsRepoRoot,
                changeSet,
                context.baselineVersion,
                changeSet.sourceRevisionSet,
                true,
                'deterministic-v1',
                [],
            );

            const baselineCommit = await this.deps.gitService.commitDomainBaseline(docsRepoRoot);
            if (!baselineCommit.success) {
                return {
                    passed: false,
                    summary: baselineCommit.message || '提交领域基线失败',
                };
            }

            const relDeltaPath = path.relative(workspaceRoot, capabilityDelta.deltaPath).replace(/\\/g, '/');
            const writeSummary = commitSummary.skippedAsNoChange
                ? '领域沉淀无新增变更'
                : `领域沉淀已更新 ${commitSummary.processedDomains} 个领域`;
            const fallbackSummary = capabilityDelta.warnings.length > 0
                ? `；降级告警 ${capabilityDelta.warnings.length} 条（已放行）`
                : '';
            return {
                passed: true,
                summary: `${writeSummary}${fallbackSummary}；${baselineCommit.message}；delta=${relDeltaPath}`,
            };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error || 'unknown');
            return {
                passed: false,
                summary: detail,
            };
        }
    }

    private async verifyDomainSedimentationReadOnly(task: Feature): Promise<{ passed: boolean; summary: string }> {
        try {
            const workspaceRoot = this.deps.getMasterRoot();
            const docsRepoRoot = this.resolveDomainBaselineRepoRoot(workspaceRoot);
            this.ensureDomainRegistrySeed(workspaceRoot, docsRepoRoot);

            const iterDir = this.deps.getIterationDir(task);
            const iterationId = path.basename(path.resolve(iterDir));
            const aggregateService = this.getDomainKnowledgeAggregateService();
            const context = aggregateService.loadDomainKnowledgeContext(docsRepoRoot, iterationId);
            const changeSet = context.draftChangeSet;

            const projection = aggregateService.previewProjection(
                changeSet,
                context.baselineVersion,
                context.baselineSnapshot,
                context.registry,
            );
            const { conflicts, blocking } = aggregateService.detectConflicts(
                changeSet,
                projection,
                context.baselineVersion,
            );
            if (blocking) {
                const blockingSummary = conflicts
                    .filter(item => item.severity === 'blocking')
                    .slice(0, 3)
                    .map(item => item.message)
                    .join('；');
                return {
                    passed: false,
                    summary: blockingSummary || '存在未解决的阻断冲突',
                };
            }

            const count = (changeSet.domainChanges || []).length;
            return {
                passed: true,
                summary: count > 0
                    ? `领域沉淀只读复核通过（${count} 条变更）`
                    : '领域沉淀只读复核通过（无待复核变更）',
            };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error || 'unknown');
            return {
                passed: false,
                summary: detail,
            };
        }
    }

    private runWarmArchiveCleanup(iterDir: string): { removedCount: number; failures: string[] } {
        const normalizedRoot = path.resolve(iterDir);
        const targetDirs = [
            'node_modules',
            '.pnpm-store',
            '.yarn',
            '.turbo',
            '.cache',
            'dist',
            'build',
            'out',
            'coverage',
        ];
        const scanRoots = [
            normalizedRoot,
            path.join(normalizedRoot, 'apps'),
            path.join(normalizedRoot, 'frontend'),
            path.join(normalizedRoot, 'backend'),
        ];
        const candidatePaths = new Set<string>();
        for (const root of scanRoots) {
            for (const dirName of targetDirs) {
                candidatePaths.add(path.join(root, dirName));
            }
        }

        let removedCount = 0;
        const failures: string[] = [];
        for (const targetPath of candidatePaths) {
            if (!fs.existsSync(targetPath)) {
                continue;
            }
            const normalizedTarget = path.resolve(targetPath);
            if (!normalizedTarget.startsWith(normalizedRoot + path.sep)) {
                failures.push(`${targetPath}（超出迭代目录边界）`);
                continue;
            }
            try {
                this.removeWarmArchiveTargetSafely(normalizedTarget);
                removedCount += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || 'unknown');
                failures.push(`${targetPath}（${message}）`);
            }
        }

        return { removedCount, failures };
    }

    /**
     * Warm-archive safety: when target is a junction/symlink, remove only the link entry.
     * This prevents recursive deletion of shared dependency directories outside the worktree.
     */
    private removeWarmArchiveTargetSafely(targetPath: string): void {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
            fs.rmSync(targetPath, { recursive: false, force: true });
            return;
        }
        safeRemovePath(targetPath, { recursive: true });
    }

    async commitToBaselineByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        await this.runExclusiveGitAction(task, 'commitToBaseline', async () => {
            await this.submitBranchForReview(task, featureId);
        });
    }

    async refreshChangeRequestsByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        await this.runExclusiveGitAction(task, 'refreshChangeRequests', async () => {
            const hasEntries = task.changeRequests && Object.keys(task.changeRequests).length > 0;
            if (!hasEntries) {
                vscode.window.showInformationMessage('当前任务尚未创建任何远程 PR/MR，请先执行「提交并创建/更新 PR/MR」。');
                return;
            }

            const iterDir = this.deps.getIterationDir(task);
            vscode.window.showInformationMessage('正在刷新各远程 PR/MR 状态...');
            const refreshed = await this.deps.gitService.refreshChangeRequestStatuses(task.changeRequests, iterDir);
            task.changeRequests = refreshed.entries;
            this.deps.saveAndRender();

            if (refreshed.allRequiredMerged) {
                vscode.window.showInformationMessage('✅ 所有必需远程端点均已合并。');
                return;
            }

            const pending = Object.values(refreshed.entries)
                .filter(entry => entry.state !== 'merged')
                .map(entry => `${entry.remoteName}: ${entry.state}${entry.lastError ? `（${entry.lastError}）` : ''}`)
                .join('；');
            showWarningMessageSafe(`仍有未合并端点：${pending || '请查看任务卡状态面板'}`);
        });
    }

    async runAgentByFeatureId(featureId: string, step: HarnessStep, repairFeedback?: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        const dispatchKey = `${task.id}:${step}`;
        if (this.inFlightStageDispatchKeys.has(dispatchKey)) {
            showWarningMessageSafe(`已忽略重复触发：${task.name} 的 ${step.toUpperCase()} Agent 正在执行中`);
            return;
        }
        this.inFlightStageDispatchKeys.add(dispatchKey);

        try {

            const iterDir = this.deps.getIterationDir(task);
            const shouldUseSchedulerForDev = step === 'dev' && this.hasTaskPlan(iterDir);

            if (step === 'dev' && (!task.quickMode || shouldUseSchedulerForDev)) {
                const scheduler = this.deps.getScheduler(task);
                await scheduler.startAuto(task);
                this.deps.saveAndRender();
                vscode.window.showInformationMessage('已按 tasks.md 子任务链启动开发调度（自动检查并继续下一个）。');
                return;
            }

            if (step === 'des') {
                this.deps.copyProjectStructureToIteration(iterDir);
            }

            this.reconcileStageArtifactPath(task, step);

            const rendered = this.deps.renderAgentPrompt(step, task.name, task.desc, iterDir);
            if (!rendered.content.trim()) {
                showErrorMessageSafe(`未找到可用的 ${step} Prompt，请检查扩展内置 prompts/ 目录。`);
                return;
            }

            const promptContent = step === 'dev' ? this.renderQuickDevPrompt(rendered.content, task, iterDir) : rendered.content;
            const repairSection = this.buildRepairFeedbackSection(repairFeedback);
            const stageRuntimeSection = this.buildStageRuntimeSection(step);
            const query = `${promptContent}${repairSection}\n\n${stageRuntimeSection}`;
            await this.deps.dispatchAi(query, iterDir, 'stage-agent', task.aiProvider, { stage: step, taskId: task.id });
            vscode.window.showInformationMessage(`已派发 ${step.toUpperCase()} Agent（Prompt来源: ${rendered.source}）`);
            this.startArtifactRepairWatch(task, step);

            if (step === 'tcs') {
                await this.openArtifactByFeatureId(featureId, 'testcase');
            } else if (step === 'tsk') {
                await this.openArtifactByFeatureId(featureId, 'tasks');
            }
        } finally {
            this.inFlightStageDispatchKeys.delete(dispatchKey);
        }
    }

    async openArtifactByFeatureId(featureId: string, artifact: 'requirements' | 'design' | 'testcase' | 'tasks' | 'testScript'): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        if (artifact === 'requirements') {
            this.reconcileStageArtifactPath(task, 'req');
        } else if (artifact === 'design') {
            this.reconcileStageArtifactPath(task, 'des');
        } else if (artifact === 'testcase') {
            this.reconcileStageArtifactPath(task, 'tcs');
        } else if (artifact === 'tasks') {
            this.reconcileStageArtifactPath(task, 'tsk');
        }
        const testScriptName = process.platform === 'win32' ? 'test-api.ps1' : 'test-api.sh';
        const cfg = this.deps.getConfig();
        const fileMap = {
            requirements: getSpecFile(iterDir, cfg, 'requirements.md'),
            design: getSpecFile(iterDir, cfg, 'design.md'),
            testcase: getSpecFile(iterDir, cfg, 'testcase.md'),
            tasks: this.resolveTaskPlanFile(iterDir),
            testScript: path.join(iterDir, 'tests', testScriptName),
        } as const;
        const filePath = fileMap[artifact];

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '', 'utf8');
        }

        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    }

    async openFolderLocationByFeatureId(
        featureId: string,
        location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend' | 'mono' | 'mainMono'
    ): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        const cfg = this.deps.getConfig();
        const dirs = cfg.monorepoDirs || DEFAULT_MONOREPO_DIRS;
        const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const iterDir = this.deps.getIterationDir(task);
        const feSub = dirs.frontend || DEFAULT_MONOREPO_DIRS.frontend;
        const beSub = dirs.backend || DEFAULT_MONOREPO_DIRS.backend;
        const locationMap = {
            worktree: iterDir,
            mono: iterDir,
            frontend: path.join(iterDir, feSub),
            backend: path.join(iterDir, beSub),
            mainMono: path.join(rootDir, 'repos', 'mono-main'),
            mainFrontend: path.join(rootDir, 'repos', 'mono-main'),
            mainBackend: path.join(rootDir, 'repos', 'mono-main'),
        } as const;

        // Lazy-init entry point: initialize only when user explicitly opens iteration folders.
        if (location === 'worktree' || location === 'mono' || location === 'frontend' || location === 'backend') {
            const initResult = await this.ensureIterationCodeBeforeOpen(task, iterDir);
            if (!initResult.ok) {
                return;
            }

            await this.runCodeGraphInitOnFirstCreate(task, iterDir, initResult.wasNewlyCreated, 'openFolderLocationByFeatureId');

            // When newly initialized (first time), run worktree-open hooks before opening the window.
            // This keeps first-open behavior consistent for worktree/mono/frontend/backend entries.
            if (initResult.wasNewlyCreated) {
                await this.runWorktreeOpenHooks(task, iterDir);
            }
        }

        const targetPath = locationMap[location];
        if (!fs.existsSync(targetPath)) {
            showWarningMessageSafe(`目录不存在：${targetPath}`);
            return;
        }

        if (location === 'worktree' || location === 'mono') {
            this.syncConfiguredPathsForWorktree(iterDir);
            this.seedWorktreeHarnessState(task, iterDir);
        }

        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetPath), {
            forceNewWindow: true,
        });
    }

    async syncCodeGraphByFeatureId(featureId: string, notifyOnSuccess: boolean = true): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) {
            return;
        }

        const iterDir = this.deps.getIterationDir(task);
        const initResult = await this.ensureIterationCodeBeforeOpen(task, iterDir);
        if (!initResult.ok) {
            return;
        }

        if (!isCodeGraphInitialized(iterDir)) {
            await this.runCodeGraphInitOnFirstCreate(task, iterDir, initResult.wasNewlyCreated, 'syncCodeGraphByFeatureId');
        }

        if (!isCodeGraphInitialized(iterDir)) {
            vscode.window.showWarningMessage('CodeGraph 自动初始化未完成，暂无法同步。请根据提示先完成初始化后重试。');
            return;
        }

        let sync = spawnSync('codegraph', ['sync', '-q'], {
            cwd: iterDir,
            encoding: 'utf8',
            shell: false,
            timeout: 30_000,
        });
        if (sync.status !== 0 && process.platform === 'win32') {
            const script = 'Invoke-Expression (fnm env --shell powershell | Out-String); codegraph sync -q';
            const plans: Array<{ command: string; args: string[] }> = [
                {
                    command: 'powershell',
                    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
                },
                {
                    command: 'pwsh',
                    args: ['-NoProfile', '-Command', script],
                },
            ];

            for (const plan of plans) {
                const fallback = spawnSync(plan.command, plan.args, {
                    cwd: iterDir,
                    encoding: 'utf8',
                    shell: false,
                    timeout: 30_000,
                });
                if (fallback.status === 0) {
                    sync = fallback;
                    break;
                }
            }
        }
        const stderr = (sync.stderr || '').trim();
        const stdout = (sync.stdout || '').trim();
        const digest = stderr || stdout || '';

        if (sync.status !== 0) {
            appendHarnessLog(iterDir, 'codegraph-sync', `FAILED: ${digest || 'codegraph sync failed'}`);
            showWarningMessageSafe(`CodeGraph 同步失败：${digest || 'codegraph sync failed'}`);
            return;
        }

        const snapshot = this.codeGraphEvidenceSnapshotWriter.writeSnapshot(iterDir);
        appendHarnessLog(
            iterDir,
            'codegraph-sync',
            snapshot.persisted
                ? `OK: sync completed; evidence=${snapshot.bundlePath}`
                : `OK: sync completed; evidence write failed: ${snapshot.summary}`,
        );

        if (!snapshot.persisted) {
            showWarningMessageSafe(`CodeGraph 已同步，但证据快照写入失败：${snapshot.summary}`);
            return;
        }

        if (notifyOnSuccess) {
            vscode.window.showInformationMessage('CodeGraph 已同步并刷新证据快照。');
        }
    }

    private syncConfiguredPathsForWorktree(worktreePath: string): void {
        try {
            const sourceRoot = this.resolveMasterWorkspaceRoot();
            if (!sourceRoot) {
                return;
            }

            const entries = this.parseWorktreeSyncEntries(this.deps.getConfig().worktreeSyncPaths || '');
            if (entries.length === 0) {
                return;
            }

            for (const relPath of entries) {
                const sourcePath = path.join(sourceRoot, ...relPath.split('/'));
                const targetPath = path.join(worktreePath, ...relPath.split('/'));
                if (!fs.existsSync(sourcePath)) {
                    continue;
                }
                if (this.normalizePath(sourcePath) === this.normalizePath(targetPath)) {
                    continue;
                }

                if (fs.existsSync(targetPath)) {
                    this.deps.gitService.safeRemovePath(targetPath, { recursive: true });
                }

                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.cpSync(sourcePath, targetPath, {
                    recursive: true,
                    force: true,
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showWarningMessageSafe(`同步配置目录到 worktree 失败：${message}`);
        }
    }

    private parseWorktreeSyncEntries(raw: string): string[] {
        const input = (raw || '').trim();
        if (!input) {
            return ['.github/instructions', '.spec'];
        }

        const parsed = input
            .split(/[\n,;]+/)
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => item.replace(/\\/g, '/'))
            .map(item => item.replace(/^\.?\//, ''))
            .map(item => item.replace(/^worktree\//i, ''))
            .map(item => item.replace(/^\/+/, ''))
            .map(item => item.replace(/\/+$/, ''))
            .filter(Boolean);

        return Array.from(new Set(parsed));
    }

    private resolveMasterWorkspaceRoot(): string {
        const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (!current) {
            return '';
        }

        const marker = `${path.sep}worktrees${path.sep}`;
        const markerIdx = current.indexOf(marker);
        if (markerIdx >= 0) {
            return current.slice(0, markerIdx);
        }

        return current;
    }

    private normalizePath(inputPath: string): string {
        return inputPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    private seedWorktreeHarnessState(task: Feature, worktreePath: string): void {
        try {
            const harnessDir = path.join(worktreePath, BASE);
            fs.mkdirSync(harnessDir, { recursive: true });

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

            const configPath = path.join(harnessDir, 'config.json');
            const configPayload = {
                ...this.deps.getConfig(),
                __harnessConfigOrigin: 'worktreeSnapshot',
                __harnessMasterRoot: workspaceRoot,
            };
            fs.writeFileSync(configPath, JSON.stringify(configPayload, null, 2), 'utf8');

            const snapshot: Feature = {
                ...task,
                // Keep absolute path so the worktree window can locate the same iteration folder.
                worktreePath,
            };
            const taskPath = path.join(harnessDir, HARNESS_STATE_FILE);
            fs.writeFileSync(taskPath, JSON.stringify([snapshot], null, 2), 'utf8');
            const legacyTaskPath = path.join(harnessDir, HARNESS_STATE_FILE_LEGACY);
            if (fs.existsSync(legacyTaskPath)) {
                safeRemovePath(legacyTaskPath);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showWarningMessageSafe(`写入 worktree 面板状态失败：${message}`);
        }
    }

    private async ensureIterationCodeBeforeOpen(
        task: Feature,
        iterDir: string
    ): Promise<{ ok: boolean; wasNewlyCreated: boolean }> {
        const cfg = this.deps.getConfig();
        let missing: boolean;
        if (cfg.monorepoGit?.trim()) {
            // Monorepo: the iteration dir root itself is the single git worktree.
            missing = !fs.existsSync(path.join(iterDir, '.git'));
        } else {
            missing = false;
        }

        if (!missing) {
            return { ok: true, wasNewlyCreated: false };
        }

        vscode.window.showInformationMessage(`检测到代码目录缺失，正在补偿重建：${task.name}`);
        const result = await this.deps.gitService.createIterationBranches(task, iterDir);
        if (!result.success) {
            showErrorMessageSafe('补偿拉取失败', {
                detail: result.message || '未知错误',
            });
            return { ok: false, wasNewlyCreated: false };
        }

        if (result.baseBranch) {
            task.baseBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(`代码补偿完成：${task.name}`);
        this.showLocalBaseFallbackNoticeIfAny();
        return { ok: true, wasNewlyCreated: true };
    }

    async startAutoByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const activeAutoCount = this.deps.getFeatures()
            .map(item => this.deps.getScheduler(item))
            .filter(scheduler => scheduler.isAutoMode())
            .length;
        const currentScheduler = this.deps.getScheduler(task);
        const maxConcurrent = 2;
        if (!currentScheduler.isAutoMode() && activeAutoCount >= maxConcurrent) {
            showWarningMessageSafe(`自动执行槽位已满（${activeAutoCount}/${maxConcurrent}），请先暂停其他任务`);
            return;
        }
        const scheduler = this.deps.getScheduler(task);
        await scheduler.startAuto(task);
        this.deps.saveAndRender();
    }

    pauseAutoByFeatureId(featureId: string): void {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        scheduler.pause();
        this.deps.saveAndRender();
    }

    async nextFeatureByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        if (this.inFlightManualResumeFeatureIds.has(task.id)) {
            showWarningMessageSafe('正在派发下一子任务，请稍候。');
            return;
        }
        const scheduler = this.deps.getScheduler(task);
        this.inFlightManualResumeFeatureIds.add(task.id);
        this.deps.saveAndRender();
        try {
            await scheduler.manualNext(task);
        } finally {
            this.inFlightManualResumeFeatureIds.delete(task.id);
            this.deps.saveAndRender();
        }
    }

    async retryFeatureByFeatureId(featureId: string, subId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        await scheduler.retrySubFeature(subId, task);
        this.deps.saveAndRender();
    }

    async setSubFeatureStatusByFeatureId(featureId: string, subId: string, status: 'todo' | 'doing' | 'done' | 'failed'): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        const scheduler = this.deps.getScheduler(task);
        if (status === 'done' && task.stage === STAGE.DEVELOPING) {
            const checked = scheduler.tryMarkDoneWithOutputVerification(subId, 'manual-status');
            if (!checked.verificationPassed) {
                showWarningMessageSafe(`任务 ${subId} 输出校验未通过，但已按手工决策标记完成。`);
            }
        } else {
            scheduler.updateSubFeatureStatus(subId, status);
        }
        this.deps.saveAndRender();

        if (status === 'done' && task.stage === STAGE.DEVELOPING) {
            if (this.inFlightManualResumeFeatureIds.has(task.id)) {
                showWarningMessageSafe('正在派发下一子任务，请稍候。');
                return;
            }

            this.inFlightManualResumeFeatureIds.add(task.id);
            this.deps.saveAndRender();
            vscode.window.showInformationMessage(`已手动修正子任务 ${subId} 为完成，正在自动派发下一子任务...`);
            void scheduler.startAuto(task)
                .then(() => {
                    this.deps.saveAndRender();
                    vscode.window.showInformationMessage(`子任务 ${subId} 已完成，下一子任务已触发。`);
                })
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    showWarningMessageSafe(`自动派发下一子任务失败：${message}`);
                })
                .finally(() => {
                    this.inFlightManualResumeFeatureIds.delete(task.id);
                    this.deps.saveAndRender();
                });
            return;
        }

        vscode.window.showInformationMessage(`已手动修正子任务 ${subId} 状态为 ${status}`);
    }

    async nextStageByFeatureId(featureId: string, step: HarnessStep, targetStage?: HarnessStep): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        if (step === 'req') {
            const iterDir = this.deps.getIterationDir(task);
            const passed = await this.ensureDesignDomainRegistryReady(task, iterDir);
            if (!passed) {
                return;
            }
        }

        if (step === 'tsk') {
            const validation = this.validateStageArtifact(task, 'tsk');
            if (!validation.valid) {
                showErrorMessageSafe('任务拆解产物校验未通过，无法进入开发阶段', {
                    modal: true,
                    detail: validation.errors.map(item => `- ${item}`).join('\n'),
                });
                return;
            }
        }

        const nextAgentStep: Partial<Record<HarnessStep, HarnessStep>> = {
            req: 'des',
            des: 'tcs',
            tcs: 'tsk',
        };

        if (targetStage) {
            // 根据targetStage设置下一个阶段
            if (targetStage === 'tcs') task.stage = STAGE.WRITING_TESTCASE;
            if (targetStage === 'tsk') task.stage = STAGE.WRITING_TASKS;
            if (targetStage === 'dev') task.stage = STAGE.DEVELOPING;

            // Save first to persist stage, then run agent, then render.
            // Calling saveAndRender() before dispatch replaces the webview HTML
            // which can interfere with the subsequent command execution.
            this.deps.saveAndRender();

            // 运行targetStage对应的agent
            try {
                await this.runAgentByFeatureId(featureId, targetStage);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                showErrorMessageSafe(`跳转到 ${targetStage.toUpperCase()} 后自动派发 Agent 失败`, {
                    detail: message,
                });
            }

            this.deps.saveAndRender();
            return;
        }

        if (step === 'req') task.stage = STAGE.WRITING_DESIGN;
        if (step === 'des') task.stage = STAGE.WRITING_TESTCASE;
        if (step === 'tcs') task.stage = STAGE.WRITING_TASKS;
        if (step === 'tsk') {
            await this.captureDevRollbackSnapshot(task);
            task.stage = STAGE.DEVELOPING;
        }
        if (step === 'dev') {
            const passed = await this.runDevDriftGateWithRepair(task);
            if (!passed) {
                return;
            }
            task.stage = STAGE.READY_FOR_REVIEW;
            this.deps.stopScheduler(task.id);
        }

        this.deps.saveAndRender();

        const followupStep = nextAgentStep[step];
        if (followupStep) {
            await this.runAgentByFeatureId(featureId, followupStep);
            vscode.window.showInformationMessage(`已推进到下一阶段，并自动打开 ${followupStep.toUpperCase()} Agent`);
        }
    }

    /**
     * Preflight gate for req -> des transition.
     * Ensures all requirement machine-block domains exist in registry.yaml, so users
     * can resolve domain governance with one-click actions instead of manual file hunting.
     */
    private async ensureDesignDomainRegistryReady(task: Feature, iterDir: string): Promise<boolean> {
        const cfg = this.deps.getConfig();
        const requirementsPath = resolveSpecFile(iterDir, cfg, 'requirements.md');
        if (!fs.existsSync(requirementsPath)) {
            return true;
        }

        const requirementsContent = fs.readFileSync(requirementsPath, 'utf8');
        const requirementDomains = this.collectRequirementDomainSpecs(requirementsContent);
        if (requirementDomains.length === 0) {
            return true;
        }

        // IMPORTANT: design-stage prompt reads registry from the current iteration workspace.
        // Preflight must validate/fix the same root, otherwise it can "pass" against another
        // registry file and still be blocked in design generation.
        const repoRoot = this.resolveDomainBaselineRepoRoot(iterDir);
        this.ensureDomainRegistrySeed(iterDir, repoRoot);
        const registryService = this.getDomainRegistryService();
        const load = registryService.loadRegistry(repoRoot);
        if (load.validationErrors.length > 0) {
            showErrorMessageSafe('领域注册表异常', {
                modal: true,
                detail: load.validationErrors.map(item => item.message).join('；'),
            });
            return false;
        }

        const existingCanonicals = new Set(
            (load.registry.domains || [])
                .map(item => (item.canonical || '').trim().toLowerCase())
                .filter(Boolean),
        );
        const missing = requirementDomains.filter(item => !existingCanonicals.has(item.domain.toLowerCase()));
        if (missing.length === 0) {
            return true;
        }

        const invalid = missing.filter(item => !this.isValidCanonicalDomainSlug(item.domain));
        const choice = await vscode.window.showWarningMessage(
            `领域未登记，无法进入设计（${missing.length}）`,
            {
                modal: true,
                detail: this.buildDomainBlockDetail(requirementsPath, load.filePath, missing, invalid),
            },
            HarnessActionsService.DOMAIN_BLOCK_AUTO_FIX,
            HarnessActionsService.DOMAIN_BLOCK_MANUAL_FIX,
        );

        if (choice === HarnessActionsService.DOMAIN_BLOCK_AUTO_FIX) {
            if (invalid.length > 0) {
                showWarningMessageSafe(`存在非 canonical 领域名，无法自动补齐：${invalid.map(item => item.domain).join('、')}`);
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(load.filePath));
                return false;
            }

            const added = this.appendMissingDomainsToRegistry(load.registry, missing);
            registryService.saveRegistry(repoRoot, load.registry);

            // Re-load and verify persisted canonicals for deterministic user feedback.
            const verified = registryService.loadRegistry(repoRoot);
            const finalCanonicals = new Set(
                (verified.registry.domains || [])
                    .map(item => (item.canonical || '').trim().toLowerCase())
                    .filter(Boolean),
            );
            const unresolved = missing.filter(item => !finalCanonicals.has(item.domain.toLowerCase()));
            if (unresolved.length > 0) {
                showErrorMessageSafe(`自动补失败：仍有未登记领域（${unresolved.length}）`, {
                    modal: true,
                    detail: this.buildDomainBlockDetail(requirementsPath, verified.filePath, unresolved, []),
                });
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(verified.filePath));
                return false;
            }

            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(verified.filePath));
            const addedInfo = added.length > 0 ? `新增 ${added.length} 项` : '无新增（已存在）';
            vscode.window.showInformationMessage(`已补齐领域（${addedInfo}）：${verified.filePath}`);
            return true;
        }

        if (choice === HarnessActionsService.DOMAIN_BLOCK_MANUAL_FIX) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(load.filePath));
            return false;
        }

        return false;
    }

    private buildDomainBlockDetail(
        requirementsPath: string,
        registryPath: string,
        missing: Array<{ reqId: string; domain: string; rawDomain: string | null }>,
        invalid: Array<{ reqId: string; domain: string; rawDomain: string | null }>,
    ): string {
        const preview = missing
            .slice(0, 8)
            .map(item => `${item.reqId}: ${item.domain}${item.rawDomain ? ` (${item.rawDomain})` : ''}`)
            .join('\n');
        const lines = [
            `requirements: ${requirementsPath}`,
            `registry: ${registryPath}`,
            '缺失领域：',
            preview,
        ];
        if (missing.length > 8) {
            lines.push(`... 其余 ${missing.length - 8} 项`);
        }
        if (invalid.length > 0) {
            lines.push(`非 canonical 命名：${invalid.map(item => item.domain).join('、')}`);
        }
        return lines.join('\n');
    }

    private collectRequirementDomainSpecs(content: string): Array<{ reqId: string; domain: string; rawDomain: string | null }> {
        const block = extractMachineBlock(content) || content;
        const result: Array<{ reqId: string; domain: string; rawDomain: string | null }> = [];
        const sections = block.match(/-\s*id\s*:\s*Req-[\w-]+[\s\S]*?(?=\n\s*-\s*id\s*:|$)/g) || [];

        for (const section of sections) {
            const reqIdMatch = section.match(/-\s*id\s*:\s*(Req-[\w-]+)/i);
            const domainMatch = section.match(/\n\s*domain\s*:\s*([^\n]+)/i);
            if (!reqIdMatch || !domainMatch) {
                continue;
            }

            const reqId = (reqIdMatch[1] || '').trim();
            const domain = this.cleanYamlScalar(domainMatch[1]);
            if (!reqId || !domain || domain.toLowerCase() === 'uncategorized') {
                continue;
            }

            const rawDomainMatch = section.match(/\n\s*rawDomain\s*:\s*([^\n]+)/i);
            const rawDomain = rawDomainMatch ? this.cleanYamlScalar(rawDomainMatch[1]) : '';
            result.push({ reqId, domain, rawDomain: rawDomain || null });
        }

        const seen = new Set<string>();
        return result.filter(item => {
            const key = `${item.reqId}|${item.domain.toLowerCase()}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    private cleanYamlScalar(raw: string): string {
        const text = String(raw || '').trim();
        if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
            return text.slice(1, -1).trim();
        }
        return text.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
    }

    private isValidCanonicalDomainSlug(domain: string): boolean {
        return /^[a-z0-9][a-z0-9-]*$/.test((domain || '').trim());
    }

    private appendMissingDomainsToRegistry(
        registry: import('../models').DomainRegistry,
        missing: Array<{ reqId: string; domain: string; rawDomain: string | null }>,
    ): string[] {
        const existing = new Set(
            (registry.domains || [])
                .map(item => (item.canonical || '').trim().toLowerCase())
                .filter(Boolean),
        );
        const added: string[] = [];

        for (const item of missing) {
            const canonical = (item.domain || '').trim();
            if (!canonical) {
                continue;
            }
            const key = canonical.toLowerCase();
            if (existing.has(key)) {
                continue;
            }

            registry.domains.push({
                canonical,
                displayName: (item.rawDomain || canonical).trim() || canonical,
                aliases: [],
                status: 'active',
            });
            existing.add(key);
            added.push(canonical);
        }

        return added;
    }

    async previousStageByFeatureId(featureId: string, step: HarnessStep): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        let previousStage: Feature['stage'] | undefined;
        let previousLabel = '';

        if (step === 'des') {
            previousStage = STAGE.WRITING_REQUIREMENT;
            previousLabel = '需求阶段';
        }
        if (step === 'tcs') {
            previousStage = STAGE.WRITING_DESIGN;
            previousLabel = '设计阶段';
        }
        if (step === 'tsk') {
            previousStage = STAGE.WRITING_TESTCASE;
            previousLabel = '测试用例阶段';
        }

        if (!previousStage) {
            return;
        }

        task.allowStageRegressionOnce = true;
        task.stage = previousStage;
        this.deps.saveAndRender();
        delete task.allowStageRegressionOnce;
        vscode.window.showInformationMessage(`已回到${previousLabel}`);
    }

    async rollbackDevByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        if (task.stage !== STAGE.DEVELOPING) {
            vscode.window.showWarningMessage('仅支持在开发阶段执行该回退操作');
            return;
        }

        const confirmLabel = '确认回退';
        const answer = await vscode.window.showWarningMessage(
            `将回退任务「${task.name}」的任务进度到任务拆分刚结束状态。该操作仅重置 tasks.md 子任务状态，是否继续？`,
            {
                modal: true,
                detail: '执行内容：1) 回滚 apps/ 目录代码变更；2) 将 tasks.md 中 done/doing/failed 重置为未完成；3) 清理 signals/done-*；4) requirements/design/testcase 文档保持不变。',
            },
            confirmLabel,
        );
        if (answer !== confirmLabel) {
            return;
        }

        const iterDir = this.deps.getIterationDir(task);
        const taskPlanPath = this.resolveTaskPlanFile(iterDir);

        this.deps.stopScheduler(task.id);

        const rollbackResult = await this.deps.gitService.rollbackIterationAppsOnly(task, iterDir);
        if (!rollbackResult.success) {
            showErrorMessageSafe('开发回退失败', {
                modal: true,
                detail: rollbackResult.message,
            });
            return;
        }

        const changedTaskCount = this.resetTaskPlanStatusesToTodo(taskPlanPath);

        const removedSignals = this.clearDoneSignals(iterDir);
        await this.captureDevRollbackSnapshot(task, true);
        task.allowStageRegressionOnce = true;
        task.stage = STAGE.WRITING_TASKS;
        this.deps.saveAndRender();
        delete task.allowStageRegressionOnce;

        vscode.window.showInformationMessage(`${rollbackResult.message}；已重置 ${changedTaskCount} 个子任务为未完成；已清理 ${removedSignals} 个 done 信号；阶段已回到任务拆解`);
    }

    async autoAdvanceReadyTasks(): Promise<boolean> {
        let changed = false;
        for (const task of this.deps.getFeatures()) {
            const step = this.stageToStep(task.stage);
            if (!step) {
                continue;
            }
            if (!this.isTaskAutoAdvanceEnabled(task)) {
                continue;
            }

            // Requirement/Design stages must be manually confirmed by user.
            if (step === 'req' || step === 'des') {
                continue;
            }

            // Task decomposition is an explicit human gate. Do not run automatic
            // validation/repair dispatch here, otherwise entering TSK can trigger
            // repeated background AI sessions before the user confirms.
            if (step === 'tsk') {
                continue;
            }

            const validation = this.validateStageArtifact(task, step);
            if (!validation.valid) {
                continue;
            }

            if (step === 'tcs') task.stage = STAGE.WRITING_TASKS;
            changed = true;
        }

        if (changed) {
            this.deps.saveAndRender();
        }
        return changed;
    }

    async passByFeatureId(featureId: string, directComplete = false): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        await this.runExclusiveGitAction(task, 'pass', async () => {
            let activeTask: Feature = task;
            let skipReadyDriftGate = false;

            if (activeTask.stage === STAGE.DEVELOPING) {
                const submitted = await this.submitBranchForReview(activeTask, featureId);
                if (!submitted) {
                    return;
                }

                await this.nextStageByFeatureId(featureId, 'dev');
                const latest = this.getFeatureById(featureId);
                if (latest?.stage === STAGE.READY_FOR_REVIEW) {
                    if (!directComplete) {
                        vscode.window.showInformationMessage('提交完成，已进入待评审阶段。');
                    }
                    activeTask = latest;
                } else {
                    vscode.window.showWarningMessage('已提交 PR/MR，但当前阶段未进入待评审，请检查门禁或手动重试。');
                    return;
                }

                if (!directComplete) {
                    return;
                }

                skipReadyDriftGate = true;
                vscode.window.showInformationMessage('正在执行直接完成：检查远程合并与最终门禁...');
            }

            if (activeTask.stage !== STAGE.READY_FOR_REVIEW) {
                vscode.window.showWarningMessage('仅开发中或待评审阶段支持「完成」操作。');
                return;
            }

            if (!skipReadyDriftGate) {
                const passed = await this.runDevDriftGateWithRepair(activeTask);
                if (!passed) {
                    return;
                }
            }

            const iterDir = this.deps.getIterationDir(activeTask);
            const finalGate = await this.runFinalExecutionGate(task, iterDir);
            if (!finalGate.passed) {
                appendHarnessLog(iterDir, 'execution-gate', `[${activeTask.id}] ❌ final-gate failed: ${finalGate.summary}`);
                showErrorMessageSafe(`执行门禁未通过：${finalGate.summary}`, {
                    modal: true,
                    detail: finalGate.outputTail || '请先启动依赖服务并重试。',
                });
                return;
            }
            if (!finalGate.skipped) {
                appendHarnessLog(iterDir, 'execution-gate', `[${activeTask.id}] ✅ final-gate passed: ${finalGate.summary}`);
                vscode.window.showInformationMessage(finalGate.summary);
            }

            const refreshed = await this.deps.gitService.refreshChangeRequestStatuses(activeTask.changeRequests, iterDir);
            activeTask.changeRequests = refreshed.entries;
            this.deps.saveAndRender();

            if (!refreshed.allRequiredMerged) {
                const unresolved = Object.values(refreshed.entries)
                    .filter(entry => entry.state !== 'merged')
                    .map(entry => `${entry.remoteName}: ${entry.state}${entry.lastError ? `（${entry.lastError}）` : ''}`)
                    .join('\n');
                showErrorMessageSafe('尚未全部合并到远程主干，请稍后重试通过', {
                    modal: true,
                    detail: unresolved || '存在未完成端点',
                });
                return;
            }

            const readOnlyVerify = await this.verifyDomainSedimentationReadOnly(activeTask);
            if (!readOnlyVerify.passed) {
                appendHarnessLog(iterDir, 'domain-gate', `[${activeTask.id}] ❌ read-only verify failed: ${readOnlyVerify.summary}`);
                showErrorMessageSafe(
                    `领域沉淀只读复核未通过：${readOnlyVerify.summary}`,
                    {
                        modal: true,
                        detail: '请回到开发阶段并重新执行「推进」，完成可写沉淀后再重试完成。',
                    },
                );
                return;
            }
            appendHarnessLog(iterDir, 'domain-gate', `[${activeTask.id}] ✅ read-only verify passed`);

            const cleanupResult = await this.deps.gitService.cleanupIterationAfterRemoteMerge(activeTask, iterDir);
            activeTask.stage = STAGE.DONE;
            this.deps.onPass(activeTask);
            this.deps.saveAndRender();
            if (cleanupResult.message) {
                vscode.window.showInformationMessage(cleanupResult.message);
            }

            const warmArchive = this.runWarmArchiveCleanup(iterDir);
            if (warmArchive.failures.length > 0) {
                appendHarnessLog(iterDir, 'archive', `[${activeTask.id}] ⚠ warm-archive failure: ${warmArchive.failures.join('；')}`);
                showWarningMessageSafe(`温归档有部分目录清理失败：${warmArchive.failures[0]}`);
            } else if (warmArchive.removedCount > 0) {
                appendHarnessLog(iterDir, 'archive', `[${activeTask.id}] ✅ warm-archive cleaned ${warmArchive.removedCount} directories`);
                vscode.window.showInformationMessage(`温归档完成：已清理 ${warmArchive.removedCount} 个可再生目录。`);
            }

            if (cleanupResult.cleanupComplete) {
                appendHarnessLog(iterDir, 'archive', `[${activeTask.id}] ℹ git cleanups finished; iteration folder kept for warm-archive policy`);
            }

            if (this.deps.isWorktreeSubview()) {
                await vscode.window.showInformationMessage('当前 worktree 任务已结束，正在关闭窗口...');
                await vscode.commands.executeCommand('workbench.action.closeWindow');
            }
        });
    }

    private scheduleDetachedIterDirCleanup(iterDir: string): void {
        // Sanity: refuse to schedule deletion of suspicious paths (root, cwd of master, etc.).
        const normalized = path.resolve(iterDir);
        if (!normalized || normalized === path.sep || normalized.split(path.sep).filter(Boolean).length < 3) {
            return;
        }
        const escaped = normalized.replace(/"/g, '\\"');
        try {
            const command = this.buildDetachedCleanupCommand(escaped);
            const child = spawn(command.bin, command.args, {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
        } catch {
            // Best-effort: if scheduling fails, the user can manually delete the dir.
        }
    }

    private buildDetachedCleanupCommand(escapedPath: string): { bin: string; args: string[] } {
        if (process.platform === 'win32') {
            const script = `Start-Sleep -Seconds 3; Remove-Item -LiteralPath \"${escapedPath}\" -Recurse -Force -ErrorAction SilentlyContinue`;
            return { bin: 'powershell', args: ['-NoProfile', '-Command', script] };
        }
        return { bin: 'sh', args: ['-c', `sleep 3 && rm -rf "${escapedPath}"`] };
    }

    async syncMainCodeByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        vscode.window.showInformationMessage(`正在同步主仓库代码到 ${task.name}...`);
        const iterDir = this.deps.getIterationDir(task);
        const result = await this.deps.gitService.syncMainCode(task, iterDir);
        if (!result.success) {
            showErrorMessageSafe('同步主仓库代码失败', {
                modal: true,
                detail: result.message,
            });
        } else {
            vscode.window.showInformationMessage(result.message);
            this.showLocalBaseFallbackNoticeIfAny();
        }
    }

    async syncMainMonoRepo(): Promise<void> {
        vscode.window.showInformationMessage('正在更新本地 mono-main 代码...');
        const result = await this.deps.gitService.syncMainMonoRepo();
        if (!result.success) {
            showErrorMessageSafe('更新本地 mono-main 失败', {
                modal: true,
                detail: result.message,
            });
            return;
        }

        vscode.window.showInformationMessage(result.message);
        this.showLocalBaseFallbackNoticeIfAny();
    }

    /**
     * Runs a user-defined custom button. The script is resolved from the button's configured
     * source ('master' shared dir, or this iteration's committed 'worktree' scripts). Clicking
     * opens a terminal whose cwd is THIS task's worktree iteration directory and runs the
     * resolved script there.
     */
    async runCustomButtonByFeatureId(featureId: string, buttonId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        let raw = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        if (!raw || !normalizeCustomButton(raw).script) {
            // Config may be stale in worktree subview — reload from disk and retry.
            this.deps.reloadConfig?.();
            raw = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        }
        if (!raw) {
            vscode.window.showWarningMessage('未找到对应的自定义按钮，请在「高级设置」中重新配置');
            return;
        }
        const button = normalizeCustomButton(raw);
        if (!button.script) {
            showWarningMessageSafe(`自定义按钮「${button.name}」未选择脚本`);
            return;
        }

        const iterDir = this.deps.getIterationDir(task);
        const initResult = await this.ensureIterationCodeBeforeOpen(task, iterDir);
        if (!initResult.ok) return;
        await this.runCodeGraphInitOnFirstCreate(task, iterDir, initResult.wasNewlyCreated, 'runCustomButtonByFeatureId');
        if (!fs.existsSync(iterDir)) {
            showWarningMessageSafe(`迭代目录不存在，无法执行：${iterDir}`);
            return;
        }

        // Run the script from the worktree iteration dir.
        this.launchCustomButton(button, iterDir, true, `迭代目录不存在：{dir}`, task.name);
    }

    /**
     * Resolve a configured AI quick-chat button for the target task and dispatch its raw content
     * into the current AI conversation without rewriting the prompt text.
     */
    async runAiQuickChatButtonByFeatureId(
        featureId: string,
        buttonId: string,
    ): Promise<{ accepted: boolean; failureReason?: 'not_found_or_invalid' | 'dispatch_failed' }> {
        const task = this.getFeatureById(featureId);
        if (!task) {
            vscode.window.showWarningMessage('未找到当前任务，无法发送 AI 快捷对话');
            return { accepted: false, failureReason: 'not_found_or_invalid' };
        }

        const button = this.resolveAiQuickChatButton(buttonId);
        if (!button) {
            vscode.window.showWarningMessage('未找到可用的 AI 快捷对话按钮，请在设置中检查配置');
            return { accepted: false, failureReason: 'not_found_or_invalid' };
        }

        const iterDir = this.deps.getIterationDir(task);
        if (!iterDir || !fs.existsSync(iterDir)) {
            showWarningMessageSafe(`当前任务迭代目录不可用，无法发送 AI 快捷对话：${iterDir || '(empty)'}`);
            return { accepted: false, failureReason: 'dispatch_failed' };
        }

        try {
            await this.deps.dispatchAi(button.content, iterDir, 'quick-chat-button', task.aiProvider || undefined);
            return { accepted: true };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error || 'unknown');
            showWarningMessageSafe(`AI 快捷对话发送失败：${detail}`);
            return { accepted: false, failureReason: 'dispatch_failed' };
        }
    }

    /**
     * Reload config on demand and return a still-valid quick-chat button, if one exists.
     */
    private resolveAiQuickChatButton(buttonId: string): AiQuickChatButton | undefined {
        let button = (this.deps.getConfig().aiQuickChatButtons || []).find(candidate => candidate.id === buttonId);
        if (!button || !isAiQuickChatButtonValid(button)) {
            this.deps.reloadConfig?.();
            button = (this.deps.getConfig().aiQuickChatButtons || []).find(candidate => candidate.id === buttonId);
        }
        if (!button || !isAiQuickChatButtonValid(button)) {
            return undefined;
        }
        return button;
    }

    /**
     * Trigger shared CodeGraph init flow when opening a worktree, and keep
     * custom-button wiring on first-create only for backward-compatible pacing.
     */
    private async runCodeGraphInitOnFirstCreate(
        task: Feature,
        iterDir: string,
        wasNewlyCreated: boolean,
        entryPoint: 'openFolderLocationByFeatureId' | 'runCustomButtonByFeatureId' | 'syncCodeGraphByFeatureId',
    ): Promise<void> {
        if (entryPoint === 'openFolderLocationByFeatureId' && !wasNewlyCreated) {
            if (isCodeGraphInitialized(iterDir)) {
                return;
            }
        }
        const shouldRun = entryPoint === 'openFolderLocationByFeatureId' || entryPoint === 'syncCodeGraphByFeatureId' || wasNewlyCreated;
        if (!shouldRun) {
            return;
        }
        if (!this.deps.runCodeGraphInitOnFirstCreate) {
            return;
        }
        await this.deps.runCodeGraphInitOnFirstCreate({
            featureId: task.id,
            taskName: task.name,
            worktreePath: iterDir,
            entryPoint,
        });
    }

    /**
     * Runs a 'main' placement custom button — one that belongs to no task iteration. It is
     * rendered in the main panel's dedicated area and runs against the master workspace root.
     */
    async runStandaloneCustomButton(buttonId: string): Promise<void> {
        const raw = (this.deps.getConfig().customButtons || []).find(b => b.id === buttonId);
        if (!raw) {
            vscode.window.showWarningMessage('未找到对应的自定义按钮，请在「高级设置」中重新配置');
            return;
        }
        const button = normalizeCustomButton(raw);
        if (!button.script) {
            showWarningMessageSafe(`自定义按钮「${button.name}」未选择脚本`);
            return;
        }

        const masterRoot = this.deps.getMasterRoot();
        if (!fs.existsSync(masterRoot)) {
            showWarningMessageSafe(`主工作区目录不存在，无法执行：${masterRoot}`);
            return;
        }
        this.launchCustomButton(button, masterRoot, false, `主工作区目录不存在：{dir}`, '主面板');
    }

    /**
     * Resolve the absolute directory a button's script lives in, honoring its scriptSource:
     * - 'master':   `<masterRoot>/script/`.
     * - 'worktree': the committed scripts dir inside THIS iteration worktree (iteration context),
     *               falling back to the main clone for 'main'-placement buttons.
     * `runBaseDir` is the iteration worktree dir for iteration buttons, else the master root.
     */
    private resolveScriptDir(button: CustomButton, runBaseDir: string, isIterationContext: boolean): string {
        const masterRoot = this.deps.getMasterRoot();
        const config = this.deps.getConfig();
        const scriptsSubdir = getScriptsSubdir(config);
        const source = button.scriptSource || 'master';

        if (source === 'master') {
            return path.join(masterRoot, CUSTOM_SCRIPT_DIR);
        }

        const repoScriptsDir = (): string => path.join(masterRoot, 'repos', 'mono-main', scriptsSubdir);

        if (source === 'worktree' && isIterationContext) {
            return path.join(runBaseDir, scriptsSubdir);
        }
        // 'worktree' with no worktree (main-panel button): use the main clone.
        return repoScriptsDir();
    }

    /**
     * Shared launcher for custom buttons. The terminal cwd is always `baseDir` (the iteration
     * worktree dir or master root); the script itself handles any sub-navigation.
     */
    private launchCustomButton(button: CustomButton, baseDir: string, isIterationContext: boolean, missingDirTpl: string, label: string): void {
        const script = (button.script || '').trim();
        const extraArgs = (button.args || '').trim();
        const runDir = baseDir;

        const scriptDir = this.resolveScriptDir(button, baseDir, isIterationContext);
        const scriptPath = path.join(scriptDir, script);

        if (!fs.existsSync(scriptPath)) {
            showWarningMessageSafe(`脚本不存在：${scriptPath}。请确认脚本仍位于所选来源目录中。`);
            return;
        }

        const runCmd = this.buildCustomButtonCommand(scriptPath, extraArgs ? ` ${extraArgs}` : '');
        const terminalName = `Fun Harness ${label} ${button.name}`;
        const existing = vscode.window.terminals.find(t => t.name === terminalName);
        if (existing) {
            // Force-stop any currently running process in this named terminal, then run fresh.
            existing.dispose();
        }
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: runDir,
        });
        terminal.show(true);
        terminal.sendText(runCmd, true);
        vscode.window.showInformationMessage(`已在 ${label} 执行「${button.name}」：${runCmd}`);
    }

    /**
     * Build the shell invocation for a master script per the current OS, keeping spaces
     * in the path safe. The same script file yields a different launch command on
     * Windows vs. macOS/Linux.
     */
    private buildCustomButtonCommand(scriptPath: string, extraArgs: string): string {
        const quoted = `"${scriptPath}"`;
        const lower = scriptPath.toLowerCase();
        const isWin = process.platform === 'win32';
        if (lower.endsWith('.ps1')) {
            // Windows ships powershell.exe; elsewhere fall back to PowerShell Core (pwsh).
            return isWin
                ? `powershell -ExecutionPolicy Bypass -File ${quoted}${extraArgs}`
                : `pwsh -File ${quoted}${extraArgs}`;
        }
        if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
            // Batch files run on Windows shells; invoke by path directly.
            return `${quoted}${extraArgs}`;
        }
        if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
            // Prefix bash so the script runs even without the executable bit
            // (and via Git Bash / WSL when on Windows).
            return `bash ${quoted}${extraArgs}`;
        }
        return `${quoted}${extraArgs}`;
    }

    async completeDevWithPush(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        await this.runExclusiveGitAction(task, 'completeDevWithPush', async () => {
            const iterDir = this.deps.getIterationDir(task);

            // First: Push all code to remote
            vscode.window.showInformationMessage('正在推送代码...');
            const result = await this.deps.gitService.pushAll(task, iterDir);
            if (!result.success) {
                showErrorMessageSafe(result.message, { modal: true });
                return;
            }

            // Then: Mark as complete development (change to READY_FOR_REVIEW)
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.nextStageByFeatureId(featureId, 'dev');
        });
    }

    async pushAndNextStage(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;
        await this.runExclusiveGitAction(task, 'pushAndNextStage', async () => {
            const iterDir = this.deps.getIterationDir(task);

            // First: Push all code to remote
            vscode.window.showInformationMessage('正在推送代码...');
            const result = await this.deps.gitService.pushAll(task, iterDir);
            if (!result.success) {
                showErrorMessageSafe(result.message, { modal: true });
                return;
            }

            // Then: Change to READY_FOR_REVIEW stage
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.nextStageByFeatureId(featureId, 'dev');
        });
    }

    getFeatureSpecDeltaStatus(featureId: string): { severity: 'low' | 'medium' | 'high'; gateBlocked: boolean; at: string; summary: string; digestPath: string } | null {
        const task = this.getFeatureById(featureId);
        if (!task) { return null; }
        const iterDir = this.deps.getIterationDir(task);
        try {
            return this.getSpecDeltaService().getLastReviewStatus(task, iterDir);
        } catch {
            return null;
        }
    }

    getSpecDeltaOverview(): Array<{ domain: string; total: number; high: number; blocked: number; lastAt: string }> {
        try {
            const inputs = this.deps.getFeatures()
                .filter(t => t.stage !== STAGE.DONE)
                .map(t => ({ task: t, iterDir: this.deps.getIterationDir(t) }));
            return this.getSpecDeltaService().getSpecDeltaOverview(inputs);
        } catch {
            return [];
        }
    }

    async reviewSpecDeltaByFeatureId(featureId: string): Promise<void> {
        const task = this.getFeatureById(featureId);
        if (!task) return;

        const iterDir = this.deps.getIterationDir(task);
        const review = this.getSpecDeltaService().runFullSpecReview(task, iterDir);
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(review.digestPath));

        if (!review.passed) {
            const repairPrompt = this.buildDriftRepairPrompt(task, iterDir, review.errors);

            const choice = await vscode.window.showWarningMessage(
                `Spec 评审发现漂移问题（${review.errors.length} 个），详情已打开`,
                { modal: true, detail: review.errors.slice(0, 5).join('\\n') },
                '派发修复 Agent',
            );
            if (choice === '派发修复 Agent') {
                try {
                    await this.deps.dispatchAi(repairPrompt, iterDir, 'stage-agent', task.aiProvider);
                    vscode.window.showInformationMessage('已派发 Spec 文档修复 Agent，请在 AI 完成后重新评审');
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    showWarningMessageSafe(`修复派发失败：${msg}`);
                }
            }
            return;
        }

        if (review.warnings.length > 0) {
            showWarningMessageSafe(`Spec 评审完成：${review.warnings.slice(0, 2).join('；')}（详情已打开）`);
            return;
        }

        vscode.window.showInformationMessage('Spec 评审完成：未发现阻断项（详情 已打开）');
    }

    /**
     * Apply one manual adjudication decision and write back to registry.
     */
    async applyDomainAdjudicationByFeatureId(featureId: string): Promise<void> {
        if (this.deps.isWorktreeSubview()) {
            vscode.window.showWarningMessage('疑似新领域裁决仅支持主面板执行');
            return;
        }

        const task = this.getFeatureById(featureId);
        if (!task) {
            return;
        }

        const pending = this.readSuspectedDomainStore();
        if (pending.length === 0) {
            vscode.window.showInformationMessage('当前没有待裁决的新领域');
            return;
        }

        const picked = await vscode.window.showQuickPick(
            pending.map(item => ({
                label: item.rawDomain,
                description: `${item.iteration} | ${item.relatedReqIds.join(', ')}`,
                detail: item.suggestedCanonical ? `suggested=${item.suggestedCanonical}` : 'suggested=(none)',
                item,
            })),
            { title: '选择待裁决领域', ignoreFocusOut: true },
        );
        if (!picked) {
            return;
        }

        const decisionPick = await vscode.window.showQuickPick([
            { label: '合并到已有领域', value: 'mergeExisting' as DomainAdjudicationDecision },
            { label: '创建新 canonical', value: 'createCanonical' as DomainAdjudicationDecision },
            { label: '作为别名追加', value: 'appendAlias' as DomainAdjudicationDecision },
        ], { title: '选择裁决动作', ignoreFocusOut: true });
        if (!decisionPick) {
            return;
        }

        const repoRoot = this.resolveDomainBaselineRepoRoot(this.deps.getMasterRoot());
        this.ensureDomainRegistrySeed(this.deps.getMasterRoot(), repoRoot);
        const registryService = this.getDomainRegistryService();
        const load = registryService.loadRegistry(repoRoot);
        if (load.validationErrors.length > 0) {
            throw new Error(`Invalid registry: ${load.validationErrors.map(item => item.message).join('; ')}`);
        }

        const canonicalChoices = load.registry.domains.map(item => item.canonical);
        let targetCanonical = picked.item.suggestedCanonical || '';
        if (decisionPick.value === 'mergeExisting' || decisionPick.value === 'appendAlias') {
            const target = await vscode.window.showQuickPick(
                canonicalChoices.map(item => ({ label: item, value: item })),
                { title: '选择目标 canonical', ignoreFocusOut: true },
            );
            if (!target) {
                return;
            }
            targetCanonical = target.value;
        }

        if (decisionPick.value === 'createCanonical') {
            const created = await vscode.window.showInputBox({
                title: '输入新 canonical',
                value: (picked.item.rawDomain || '').toLowerCase().replace(/\s+/g, '-'),
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : 'canonical 不能为空',
            });
            if (!created) {
                return;
            }
            targetCanonical = created.trim();
        }

        registryService.applyAdjudication(repoRoot, {
            decision: decisionPick.value,
            rawDomain: picked.item.rawDomain,
            targetCanonical,
            displayName: targetCanonical,
        });

        const remaining = pending.filter(item => !(item.iteration === picked.item.iteration && item.rawDomain === picked.item.rawDomain));
        this.writeSuspectedDomainStore(remaining);
        vscode.window.showInformationMessage(`领域裁决已写回：${picked.item.rawDomain} -> ${targetCanonical || '(no change)'}`);
    }

    /**
     * Load pending suspected domains from workspace store file.
     */
    private readSuspectedDomainStore(): SuspectedDomainRecord[] {
        const filePath = this.resolveSuspectedDomainStorePath();
        const content = readTextIfExists(filePath);
        if (!content) {
            return [];
        }
        try {
            const parsed = JSON.parse(content) as { suspectedDomains?: SuspectedDomainRecord[] };
            return Array.isArray(parsed.suspectedDomains) ? parsed.suspectedDomains : [];
        } catch {
            return [];
        }
    }

    /**
     * Persist pending suspected domains into workspace store file.
     */
    private writeSuspectedDomainStore(records: SuspectedDomainRecord[]): void {
        const filePath = this.resolveSuspectedDomainStorePath();
        writeTextAtomic(filePath, `${JSON.stringify({ suspectedDomains: records }, null, 2)}\n`);
    }

    /**
     * Merge suspected-domain records using iteration+rawDomain as stable dedupe key.
     */
    private mergeSuspectedDomainRecords(
        existing: SuspectedDomainRecord[],
        incoming: SuspectedDomainRecord[],
    ): SuspectedDomainRecord[] {
        const merged = new Map<string, SuspectedDomainRecord>();

        for (const item of [...existing, ...incoming]) {
            const rawDomain = (item.rawDomain || '').trim();
            const iteration = (item.iteration || '').trim();
            if (!rawDomain || !iteration) {
                continue;
            }

            const key = `${iteration}|${rawDomain.toLowerCase()}`;
            const prev = merged.get(key);
            if (!prev) {
                merged.set(key, {
                    iteration,
                    rawDomain,
                    relatedReqIds: Array.from(new Set(item.relatedReqIds || [])).sort((a, b) => a.localeCompare(b)),
                    suggestedCanonical: item.suggestedCanonical || null,
                });
                continue;
            }

            merged.set(key, {
                iteration,
                rawDomain,
                relatedReqIds: Array.from(new Set([...(prev.relatedReqIds || []), ...(item.relatedReqIds || [])])).sort((a, b) => a.localeCompare(b)),
                suggestedCanonical: prev.suggestedCanonical || item.suggestedCanonical || null,
            });
        }

        return Array.from(merged.values()).sort((a, b) => {
            if (a.iteration !== b.iteration) {
                return a.iteration.localeCompare(b.iteration);
            }
            return a.rawDomain.localeCompare(b.rawDomain);
        });
    }

    /**
     * Resolve workspace-level suspected domain store path.
     */
    private resolveSuspectedDomainStorePath(): string {
        return path.join(this.deps.getMasterRoot(), BASE, 'domain-suspected.json');
    }

    /** Resolve the tracked repository root that should own docs/domains. */
    private resolveDomainBaselineRepoRoot(workspaceRoot: string): string {
        const monoMainRoot = path.join(workspaceRoot, 'repos', 'mono-main');
        if (fs.existsSync(monoMainRoot)) {
            return monoMainRoot;
        }

        return workspaceRoot;
    }

    /**
     * Seed mono-main registry from workspace registry when mono-main is empty.
     */
    private ensureDomainRegistrySeed(workspaceRoot: string, docsRepoRoot: string): void {
        if (workspaceRoot === docsRepoRoot) {
            return;
        }

        const registryService = this.getDomainRegistryService();
        const sourcePath = registryService.resolveRegistryPath(workspaceRoot);
        if (!fs.existsSync(sourcePath)) {
            return;
        }

        const targetLoad = registryService.loadRegistry(docsRepoRoot);
        if (targetLoad.validationErrors.length > 0) {
            return;
        }
        if ((targetLoad.registry.domains || []).length > 0) {
            return;
        }

        const sourceLoad = registryService.loadRegistry(workspaceRoot);
        if (sourceLoad.validationErrors.length > 0) {
            return;
        }
        if ((sourceLoad.registry.domains || []).length === 0) {
            return;
        }

        const targetPath = registryService.resolveRegistryPath(docsRepoRoot);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
    }

    /**
     * Persist unresolved registry coverage issues for quick diagnosis of canonical=null cases.
     */
    private writeRegistryCoverageReport(workspaceRoot: string, docsRepoRoot?: string): void {
        const issues = this.getDomainKnowledgeAggregateService().getRegistryCoverageIssues(workspaceRoot, docsRepoRoot);
        const filePath = path.join(workspaceRoot, BASE, 'domain-registry-coverage.json');
        writeTextAtomic(filePath, `${JSON.stringify({ issues }, null, 2)}\n`);
    }

    private async initializeTaskGit(task: Feature): Promise<void> {
        task.stage = STAGE.INITIALIZING;
        this.deps.saveAndRender();

        const iterDir = this.deps.getIterationDir(task);
        const result = await this.deps.gitService.createIterationBranches(task, iterDir);
        if (!result.success) {
            showErrorMessageSafe('迭代初始化失败', {
                detail: result.message || '未知错误',
            });
            return;
        }

        if (result.baseBranch) {
            task.baseBranchUsed = result.baseBranch;
        }
        if (result.iterationBranch) {
            task.iterationBranch = result.iterationBranch;
        }

        task.stage = STAGE.WRITING_REQUIREMENT;
        this.deps.saveAndRender();
        vscode.window.showInformationMessage(result.message || '✅ 迭代初始化完成');
        this.showLocalBaseFallbackNoticeIfAny();
    }

    private getFeatureById(featureId: string): Feature | undefined {
        return this.deps.getFeatures().find((task) => task.id === featureId);
    }

    private stageToStep(stage: Feature['stage']): Exclude<HarnessStep, 'dev'> | null {
        if (stage === STAGE.WRITING_REQUIREMENT) return 'req';
        if (stage === STAGE.WRITING_DESIGN) return 'des';
        if (stage === STAGE.WRITING_TESTCASE) return 'tcs';
        if (stage === STAGE.WRITING_TASKS) return 'tsk';
        return null;
    }

    private validateStageArtifact(task: Feature, step: Exclude<HarnessStep, 'dev'>): { valid: boolean; errors: string[] } {
        this.reconcileStageArtifactPath(task, step);
        const iterDir = this.deps.getIterationDir(task);
        const cfg = this.deps.getConfig();
        const fileNameMap = {
            req: 'requirements.md',
            des: 'design.md',
            tcs: 'testcase.md',
        } as const;
        const filePath = step === 'tsk'
            ? this.resolveTaskPlanFile(iterDir)
            : getSpecFile(iterDir, cfg, fileNameMap[step]);
        const errors: string[] = [];

        if (!fs.existsSync(filePath)) {
            if (step === 'tsk') {
                return { valid: false, errors: [`缺少文件 ${getSpecFileRel(iterDir, cfg, 'tasks.md')}（兼容 ${FEATURE_PLAN_LEGACY_REL_PATH}）`] };
            }
            return { valid: false, errors: [`缺少文件 ${getSpecFileRel(iterDir, cfg, fileNameMap[step])}`] };
        }

        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) {
            const relPath = step === 'tsk'
                ? this.toRelativeIterationPath(iterDir, filePath)
                : getSpecFileRel(iterDir, cfg, fileNameMap[step]);
            return { valid: false, errors: [`${relPath} 为空`] };
        }

        const rules: Record<Exclude<HarnessStep, 'dev'>, Array<{ test: RegExp; message: string }>> = {
            req: [
                { test: /^#\s*需求文档/m, message: '缺少“需求文档”标题' },
                { test: /^##\s*需求清单/m, message: '缺少“需求清单”章节' },
                { test: /^###\s*需求-\d+[：:]/m, message: '缺少至少一个需求条目' },
                { test: /^####\s*验收标准/m, message: '缺少“验收标准”小节' },
                { test: /artifactType:\s*requirements/m, message: '缺少 requirements 机器块' },
                { test: /requirements:\s*/m, message: '机器块中缺少 requirements 列表' },
            ],
            des: [
                { test: /^#\s*设计文档/m, message: '缺少“设计文档”标题' },
                { test: /^###\s*3\.1\s*API\s*契约|^##\s*3\.1\s*API\s*契约/m, message: '缺少 API 契约章节' },
                { test: /^##\s*4\.\s*正确性属性|^##\s*4\s*正确性属性/m, message: '缺少正确性属性章节' },
                { test: /artifactType:\s*design/m, message: '缺少 design 机器块' },
                { test: /apiContracts:\s*/m, message: '机器块中缺少 apiContracts 列表' },
                { test: /invariants:\s*/m, message: '机器块中缺少 invariants 列表' },
            ],
            tcs: [
                { test: /^#\s*测试用例文档/m, message: '缺少“测试用例文档”标题' },
                { test: /^##\s*3\.\s*用例清单|^##\s*3\s*用例清单/m, message: '缺少用例清单章节' },
                { test: /^###\s*TC-\d+/m, message: '缺少至少一个测试用例' },
                { test: /artifactType:\s*testcase/m, message: '缺少 testcase 机器块' },
                { test: /testCases:\s*/m, message: '机器块中缺少 testCases 列表' },
            ],
            tsk: [
                { test: /^#\s*任务拆解文档/m, message: '缺少“任务拆解文档”标题' },
                { test: /^##\s*任务清单/m, message: '缺少任务清单章节' },
                { test: /^-\s*\[([ xX]|doing|failed)\]\s*\d+\.\d+/m, message: '缺少至少一个任务项' },
                { test: /artifactType:\s*tasks/m, message: '缺少 tasks 机器块' },
                { test: /tasks:\s*/m, message: '机器块中缺少 tasks 列表' },
            ],
        };

        for (const rule of rules[step]) {
            if (!rule.test.test(content)) {
                errors.push(rule.message);
            }
        }

        if (step === 'tcs') {
            const iterDir = this.deps.getIterationDir(task);
            const manifestPath = path.join(iterDir, 'tests', 'test-manifest.json');
            if (!fs.existsSync(manifestPath)) {
                errors.push('缺少 tests/test-manifest.json');
            } else {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
                    errors.push(...this.validateTestManifestSchema(manifest));
                    const scriptRequired = this.isTestScriptRequired(manifest);
                    if (scriptRequired) {
                        if (!/BEGIN_SCRIPT/m.test(content)) {
                            errors.push('缺少 BEGIN_SCRIPT 脚本块');
                        }
                        if (!/END_SCRIPT/m.test(content)) {
                            errors.push('缺少 END_SCRIPT 脚本块');
                        }
                    }
                    errors.push(...this.validateTestScriptFromManifest(iterDir, manifest));
                } catch {
                    errors.push('test-manifest.json 不是合法 JSON');
                }
            }
        }

        if (step === 'tsk') {
            errors.push(...this.validateTaskOutputPathContract(task));
        }

        // Semantic traceability hard gate: cross-artifact Req-* ID closure.
        if ((step === 'des' || step === 'tcs' || step === 'tsk')) {
            const reqPath = getSpecFile(iterDir, cfg, 'requirements.md');
            if (!fs.existsSync(reqPath)) {
                errors.push('缺少 requirements.md，无法完成追溯闭环校验');
            } else {
                const reqContent = fs.readFileSync(reqPath, 'utf8');
                // relaxed gate only enforces reference integrity (no dangling); coverage closure is off.
                const enforceCoverage = resolveGateLevel(cfg) !== 'relaxed';
                errors.push(...validateTraceability(reqContent, content, step, enforceCoverage));
            }
        }

        if (errors.length === 0) {
            try {
                const digestPath = this.getSpecDeltaService().recordStageSnapshot(task, iterDir, step, filePath, content);
                appendHarnessLog(
                    this.deps.getIterationDir(task),
                    'spec-delta',
                    `[${task.id}] snapshot stage=${step} digest=${digestPath}`,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`Spec Delta 快照沉淀失败：${message}`);
            }
        }

        return { valid: errors.length === 0, errors };
    }

    private validateTaskOutputPathContract(task: Feature): string[] {
        const scheduler = this.deps.getScheduler(task);
        const subTasks = scheduler.parseSubFeaturesMd();
        const errors: string[] = [];
        const iterDir = this.deps.getIterationDir(task);

        for (const st of subTasks) {
            for (const raw of st.output) {
                const token = this.normalizeOutputPathToken(raw);
                if (!token) {
                    continue;
                }

                if (/\s*[（(][^（）()]*[）)]\s*$/.test(token)) {
                    errors.push(`任务 ${st.id} 输出项包含括号注释，禁止使用：${raw}`);
                    continue;
                }

                if (/\s+\[[^\]]*\]\s*$/.test(token) || /\s+\{[^}]*\}\s*$/.test(token)) {
                    errors.push(`任务 ${st.id} 输出项包含注释后缀，禁止使用：${raw}`);
                    continue;
                }

                if (/(?:\s|^)[：:]\s+\S+/.test(token)) {
                    errors.push(`任务 ${st.id} 输出项包含说明性后缀，禁止使用：${raw}`);
                    continue;
                }

                if (/^\.\.?[\\/]/.test(token)) {
                    errors.push(`任务 ${st.id} 输出项必须从仓库根相对路径开始，禁止 ./ 或 ../：${raw}`);
                    continue;
                }

                const resolved = resolvePathAgainstRoot(iterDir, token);
                if (!resolved) {
                    errors.push(`任务 ${st.id} 输出项为空或非法：${raw}`);
                    continue;
                }
                if (!resolved.insideRoot) {
                    errors.push(`任务 ${st.id} 输出项必须位于当前迭代目录内，禁止引用目录外路径：${raw}`);
                    continue;
                }

                if (!/[\\/]/.test(token)) {
                    errors.push(`任务 ${st.id} 输出项必须为完整相对路径（至少包含一级目录）：${raw}`);
                }
            }
        }

        return errors;
    }

    private normalizeOutputPathToken(value: string): string {
        let token = String(value || '').trim();
        if (!token) {
            return '';
        }
        if ((/^\[[^\[\]]+\]$/.test(token)) || (/^\{[^{}]+\}$/.test(token))) {
            token = token.slice(1, -1).trim();
        }
        if (/^`[^`]+`$/.test(token)) {
            token = token.slice(1, -1).trim();
        }
        if ((/^"[^"]+"$/.test(token)) || (/^'[^']+'$/.test(token))) {
            token = token.slice(1, -1).trim();
        }
        return token;
    }

    private validateTestManifestSchema(manifest: Record<string, unknown>): string[] {
        const errors: string[] = [];
        if (manifest.artifactType !== 'test-manifest') {
            errors.push('test-manifest.json 缺少 artifactType=test-manifest');
        }

        const taskName = manifest.taskName;
        if (typeof taskName !== 'string' || !taskName.trim()) {
            errors.push('test-manifest.json 缺少 taskName');
        }

        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            errors.push('test-manifest.json 缺少 script 对象');
        } else {
            const scriptObj = script as Record<string, unknown>;
            const required = scriptObj.required;
            const scriptRequired = required === undefined ? true : required === true;
            if (required !== undefined && typeof required !== 'boolean') {
                errors.push('test-manifest.json script.required 必须是布尔值');
            }

            if (scriptRequired) {
                if (scriptObj.os !== 'windows' && scriptObj.os !== 'non-windows') {
                    errors.push('test-manifest.json script.os 必须是 windows 或 non-windows');
                }
                if (typeof scriptObj.path !== 'string' || !String(scriptObj.path).startsWith('tests/')) {
                    errors.push('test-manifest.json script.path 必须位于 tests/ 目录');
                }
            } else {
                const reason = scriptObj.reason;
                if (typeof reason !== 'string' || !reason.trim()) {
                    errors.push('script.required=false 时必须提供 script.reason');
                }
            }
        }

        const testCases = manifest.testCases;
        if (!Array.isArray(testCases) || testCases.length === 0) {
            errors.push('test-manifest.json 缺少 testCases 列表');
            return errors;
        }

        testCases.forEach((item, idx) => {
            const prefix = `testCases[${idx}]`;
            if (!item || typeof item !== 'object') {
                errors.push(`${prefix} 必须是对象`);
                return;
            }
            const tc = item as Record<string, unknown>;
            if (typeof tc.id !== 'string' || !tc.id.startsWith('TC-')) {
                errors.push(`${prefix}.id 必须是 TC- 开头`);
            }
            if (!Array.isArray(tc.requirementIds) || tc.requirementIds.length === 0) {
                errors.push(`${prefix}.requirementIds 不能为空`);
            }

            const api = tc.api;
            if (!api || typeof api !== 'object') {
                errors.push(`${prefix}.api 缺失`);
            } else {
                const apiObj = api as Record<string, unknown>;
                if (typeof apiObj.method !== 'string' || !apiObj.method.trim()) {
                    errors.push(`${prefix}.api.method 缺失`);
                }
                if (typeof apiObj.path !== 'string' || !String(apiObj.path).startsWith('/')) {
                    errors.push(`${prefix}.api.path 必须以 / 开头`);
                }
            }

            if (!['normal', 'boundary', 'exception'].includes(String(tc.scenario || ''))) {
                errors.push(`${prefix}.scenario 必须是 normal|boundary|exception`);
            }
            if (typeof tc.expectedStatus !== 'number') {
                errors.push(`${prefix}.expectedStatus 必须是数字`);
            }
        });

        return errors;
    }

    private validateTestScriptFromManifest(iterDir: string, manifest: Record<string, unknown>): string[] {
        const errors: string[] = [];
        if (!this.isTestScriptRequired(manifest)) {
            return errors;
        }
        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            return errors;
        }

        const scriptObj = script as Record<string, unknown>;
        const scriptRel = typeof scriptObj.path === 'string' ? scriptObj.path : '';
        if (!scriptRel.startsWith('tests/')) {
            return errors;
        }

        const scriptPath = path.join(iterDir, scriptRel);
        if (!fs.existsSync(scriptPath)) {
            errors.push(`缺少 ${scriptRel}（请由 testcase Agent 直接生成脚本文件）`);
            return errors;
        }

        const content = fs.readFileSync(scriptPath, 'utf8');
        if (!content.trim()) {
            errors.push(`${scriptRel} 为空`);
            return errors;
        }

        if (!/(PASS|FAIL)/i.test(content)) {
            errors.push(`${scriptRel} 缺少 PASS/FAIL 输出`);
        }
        if (!/exit\s+0|exit\s+1/i.test(content)) {
            errors.push(`${scriptRel} 缺少明确退出码（exit 0/1）`);
        }

        return errors;
    }

    private isTestScriptRequired(manifest: Record<string, unknown>): boolean {
        const script = manifest.script;
        if (!script || typeof script !== 'object') {
            return true;
        }
        const required = (script as Record<string, unknown>).required;
        if (required === undefined) {
            return true;
        }
        return required === true;
    }

    /** Wrap repair feedback as a clearly-delimited section for injection into the agent query. */
    private buildRepairFeedbackSection(repairFeedback?: string): string {
        const trimmed = (repairFeedback || '').trim();
        if (!trimmed) {
            return '';
        }
        return `\n\n---\n## 回修指令（最高优先，针对性修复）\n${trimmed}`;
    }

    private resolveTaskPlanFile(iterDir: string): string {
        return resolveFeaturePlanFileForIteration(iterDir, this.deps.getConfig());
    }

    private async captureDevRollbackSnapshot(task: Feature, force: boolean = false): Promise<void> {
        if (!force && task.devRollbackSnapshot) {
            return;
        }

        const iterDir = this.deps.getIterationDir(task);
        const taskPlanPath = this.resolveTaskPlanFile(iterDir);
        const relPath = path.relative(iterDir, taskPlanPath).replace(/\\/g, '/');
        const taskPlanContent = readTextIfExists(taskPlanPath) || '';
        const repoHeadByKind = await this.deps.gitService.captureIterationRepoHeads(iterDir);
        const snapshot: DevRollbackSnapshot = {
            createdAt: new Date().toISOString(),
            taskPlanRelPath: relPath || 'tasks.md',
            taskPlanContent,
            repoHeadByKind,
        };
        task.devRollbackSnapshot = snapshot;
    }

    private resetTaskPlanStatusesToTodo(taskPlanPath: string): number {
        const existing = readTextIfExists(taskPlanPath);
        if (!existing) {
            return 0;
        }

        let changed = 0;
        const rewritten = existing.split(/\r?\n/).map((line) => {
            const next = line.replace(/^(\s*-\s*\[)\s*(x|X|doing|failed)(\]\s*\d+\.\d+\s+)/, '$1 $3');
            if (next !== line) {
                changed += 1;
            }
            return next;
        }).join('\n');

        if (changed > 0) {
            fs.writeFileSync(taskPlanPath, rewritten, 'utf8');
        }
        return changed;
    }

    private clearDoneSignals(iterDir: string): number {
        const signalsDir = path.join(iterDir, 'signals');
        if (!fs.existsSync(signalsDir)) {
            return 0;
        }
        const entries = fs.readdirSync(signalsDir);
        let removed = 0;
        for (const name of entries) {
            if (!name.startsWith('done-')) {
                continue;
            }
            const fullPath = path.join(signalsDir, name);
            try {
                if (fs.statSync(fullPath).isFile()) {
                    fs.unlinkSync(fullPath);
                    removed += 1;
                }
            } catch {
                // Ignore best-effort cleanup failures for individual files.
            }
        }
        return removed;
    }

    private stageArtifactFileName(step: Exclude<HarnessStep, 'dev'>): string {
        const fileMap = {
            req: 'requirements.md',
            des: 'design.md',
            tcs: 'testcase.md',
            tsk: 'tasks.md',
        } as const;
        return fileMap[step];
    }

    private reconcileStageArtifactPath(task: Feature, step: HarnessStep): boolean {
        if (step === 'dev') {
            return false;
        }

        const iterDir = this.deps.getIterationDir(task);
        const cfg = this.deps.getConfig();
        const fileName = this.stageArtifactFileName(step);
        const canonicalAbs = getSpecFile(iterDir, cfg, fileName);
        const canonicalRel = getSpecFileRel(iterDir, cfg, fileName);
        fs.mkdirSync(path.dirname(canonicalAbs), { recursive: true });
        const canonicalReady = fs.existsSync(canonicalAbs) && fs.readFileSync(canonicalAbs, 'utf8').trim().length > 0;
        if (canonicalReady) {
            return true;
        }

        const candidates = [
            path.join(iterDir, fileName),
            path.join(iterDir, 'doc', fileName),
            path.join(iterDir, '.harness', 'staging', fileName),
            path.join(iterDir, '.harness', 'artifacts', fileName),
        ];

        // Legacy docs-based spec location (docs/<file> or docs/<task>/<file>), used to migrate
        // iterations created before specRootDir. Task-scoped in mono mode, so always safe to include.
        const legacySpecCandidate = path.join(iterDir, ...getLegacySpecDocsRelSegments(iterDir, cfg), fileName);
        if (this.normalize(legacySpecCandidate) !== this.normalize(canonicalAbs)) {
            candidates.unshift(legacySpecCandidate);
        }

        const docsRootCandidate = path.join(iterDir, getDocsRootDirName(cfg), fileName);
        if (this.isLegacyMonoArtifactForTask(docsRootCandidate, fileName, path.basename(iterDir))) {
            // Only migrate docs-root files that clearly belong to this iteration task
            // to avoid consuming repository-level project documents.
            candidates.unshift(docsRootCandidate);
        }

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate) || this.normalize(candidate) === this.normalize(canonicalAbs)) {
                continue;
            }
            const content = fs.readFileSync(candidate, 'utf8');
            if (!content.trim()) {
                continue;
            }
            fs.writeFileSync(canonicalAbs, content, 'utf8');
            try {
                safeRemovePath(candidate);
            } catch {
                // ignore delete errors and keep canonical copy.
            }
            vscode.window.showInformationMessage(`已自动修复 ${fileName} 路径到 ${canonicalRel}`);
            return true;
        }

        return false;
    }

    private isLegacyMonoArtifactForTask(filePath: string, fileName: string, taskName: string): boolean {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            return false;
        }
        if (!content.trim()) {
            return false;
        }

        const artifactTypeMap: Record<string, string> = {
            'requirements.md': 'requirements',
            'design.md': 'design',
            'testcase.md': 'testcase',
            'tasks.md': 'tasks',
        };
        const artifactType = artifactTypeMap[fileName];
        if (!artifactType) {
            return false;
        }

        const escapedTaskName = taskName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const typePattern = new RegExp(`artifactType\\s*:\\s*${artifactType}\\b`, 'i');
        const taskPattern = new RegExp(`taskName\\s*:\\s*["']?${escapedTaskName}["']?\\b`, 'i');
        return typePattern.test(content) && taskPattern.test(content);
    }

    private startArtifactRepairWatch(task: Feature, step: HarnessStep): void {
        if (step === 'dev' || step === 'tsk') {
            return;
        }
        const key = `${task.id}:${step}`;
        const existing = this.artifactRepairTimers.get(key);
        if (existing) {
            clearInterval(existing);
        }

        const startedAt = Date.now();
        const timer = setInterval(() => {
            const fixed = this.reconcileStageArtifactPath(task, step);
            if (fixed || Date.now() - startedAt > 180000) {
                clearInterval(timer);
                this.artifactRepairTimers.delete(key);
            }
        }, 2000);
        this.artifactRepairTimers.set(key, timer);
    }

    private normalize(inputPath: string): string {
        return inputPath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    }

    private toRelativeIterationPath(iterDir: string, absPath: string): string {
        return path.relative(iterDir, absPath).replace(/\\/g, '/');
    }

    private isTaskAutoAdvanceEnabled(task: Feature): boolean {
        if (typeof task.autoAdvanceEnabled === 'boolean') {
            return task.autoAdvanceEnabled;
        }
        return this.deps.getConfig().autoAdvanceEnabled;
    }

    /**
     * Resolve the absolute path to a Hook script based on its scriptSource.
     * Mirrors the CustomButton path resolution logic.
     * - master: <masterRoot>/script/<entry.script>
     * - worktree: iteration-context scripts directory (from resolveScriptDir)
     */
    private resolveHookScriptPath(entry: HookEntry, iterDir: string): string {
        const masterRoot = this.deps.getMasterRoot();
        const config = this.deps.getConfig();
        const source = entry.scriptSource || 'master';

        if (source === 'master') {
            return path.join(masterRoot, CUSTOM_SCRIPT_DIR, entry.script);
        }

        // For 'worktree' source, reuse resolveScriptDir by adapting HookEntry to CustomButton shape
        const adaptedButton: CustomButton = {
            id: 'hook-temp',
            name: 'hook-temp',
            script: entry.script,
            scriptSource: 'worktree',
            placement: 'iteration',
        };
        const scriptDir = this.resolveScriptDir(adaptedButton, iterDir, true);
        return path.join(scriptDir, entry.script);
    }

    /**
     * Spawn and execute a single Hook script asynchronously.
     * Handles missing files, OS incompatibility, and non-zero exit codes gracefully.
     * All errors are non-blocking: the promise always resolves (never rejects).
     */
    private spawnHookAsync(
        entry: HookEntry,
        iterDir: string,
        taskName: string,
        logDir: string
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            const scriptName = entry.script;
            const scriptArgs = (entry.args || '').trim();

            // Skip scripts incompatible with the current OS
            if (!isOsScriptFile(scriptName)) {
                appendHarnessLog(logDir, 'hook', `SKIP_OS: ${scriptName}`);
                resolve();
                return;
            }

            const scriptPath = this.resolveHookScriptPath(entry, iterDir);

            // Check if script file exists
            if (!fs.existsSync(scriptPath)) {
                const msg = `脚本不存在：${scriptPath}`;
                appendHarnessLog(logDir, 'hook', `MISSING: ${scriptPath}`);
                showWarningMessageSafe(msg);
                resolve();
                return;
            }

            // Parse script arguments
            const args = scriptArgs ? scriptArgs.split(/\s+/) : [];

            // Spawn the script process
            let stdout = '';
            let stderr = '';
            const proc = spawn(scriptPath, args, {
                cwd: iterDir,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('error', (error) => {
                const errMsg = error instanceof Error ? error.message : String(error);
                appendHarnessLog(logDir, 'hook', `SPAWN_ERROR: ${scriptName} ${errMsg}`);
                showWarningMessageSafe(`Hook 脚本执行失败：${scriptName} - ${errMsg}`);
                resolve();
            });

            proc.on('exit', (exitCode) => {
                if (exitCode === 0) {
                    appendHarnessLog(logDir, 'hook', `OK: ${scriptName} exit=0`);
                    resolve();
                } else {
                    const stderrSnippet = stderr.trim().split('\n').slice(0, 3).join(' | ');
                    appendHarnessLog(logDir, 'hook', `FAILED: ${scriptName} exit=${exitCode} stderr=${stderrSnippet}`);
                    showWarningMessageSafe(`Hook 脚本执行失败：${scriptName} (exit=${exitCode})`);
                    resolve();
                }
            });
        });
    }

    /**
     * Execute all worktree-open Hook scripts in sequence when Worktree is first initialized.
     * Reads hooks from config.lifecycleHooks.worktreeOpen and runs them under a progress notification.
     * Single hook failures do not stop subsequent hooks (all are independent).
     */
    private async runWorktreeOpenHooks(task: Feature, iterDir: string): Promise<void> {
        const config = this.deps.getConfig();
        const hooks = config.lifecycleHooks?.worktreeOpen || [];

        // Silent skip if no hooks configured (INV-6)
        if (hooks.length === 0) {
            return;
        }

        const logDir = iterDir;
        const taskName = task.name;

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `正在执行 Worktree 初始化 Hook...`,
                cancellable: false,
            },
            async (progress) => {
                for (let i = 0; i < hooks.length; i++) {
                    const hook = hooks[i];
                    progress.report({
                        message: `[${i + 1}/${hooks.length}] ${hook.script}`,
                    });
                    await this.spawnHookAsync(hook, iterDir, taskName, logDir);
                }
            }
        );
    }
}
