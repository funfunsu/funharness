import { Config, CustomButton, STAGE, SubTask, Task, TaskStats, AI_PROVIDERS, DEFAULT_AUTO_POLL_PROMPT, DEFAULT_AUTO_POLL_SKIP_MARKERS } from './models';
import { HarnessConfigMeta } from './services/taskStoreService';
import { AutoPollStatus } from './services/autoPollService';

/** Escape a string for safe interpolation into HTML text or a double-quoted attribute. */
function escapeHtml(value: string): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildScriptOptions(selected: string, scriptFiles: string[]): string {
    const opts = ['<option value="">（选择脚本）</option>'];
    let matched = false;
    for (const f of scriptFiles) {
        const sel = f === selected ? ' selected' : '';
        if (sel) {
            matched = true;
        }
        opts.push(`<option value="${escapeHtml(f)}"${sel}>${escapeHtml(f)}</option>`);
    }
    // A previously chosen script that no longer exists is kept (marked 缺失) so the
    // button isn't silently re-pointed when its file is missing.
    if (selected && !matched) {
        opts.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（缺失）</option>`);
    }
    return opts.join('');
}

/** Worktree subfolders a custom button can run in. Empty value = worktree root. */
const CUSTOM_BUTTON_WORKDIRS = ['frontend', 'backend'];

function buildWorkdirOptions(selected: string): string {
    const opts = ['<option value="">根目录</option>'];
    let matched = false;
    for (const d of CUSTOM_BUTTON_WORKDIRS) {
        const sel = d === selected ? ' selected' : '';
        if (sel) {
            matched = true;
        }
        opts.push(`<option value="${escapeHtml(d)}"${sel}>${escapeHtml(d)}</option>`);
    }
    // Keep a previously chosen folder that isn't in the standard set, so a button
    // configured for a custom layout isn't silently reset to the root.
    if (selected && !matched) {
        opts.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（自定义）</option>`);
    }
    return opts.join('');
}

function customButtonRowHtml(name: string, command: string, workdir: string, scriptFiles: string[], disabled: string): string {
    return `<div class="cb-row">
<input class="cb-name" placeholder="按钮名称（如 部署）" value="${escapeHtml(name)}" ${disabled}>
<select class="cb-dir" ${disabled} title="执行目录">${buildWorkdirOptions(workdir)}</select>
<select class="cb-cmd" ${disabled}>${buildScriptOptions(command, scriptFiles)}</select>
<button class="cb-del" onclick="removeCustomButton(this)" ${disabled}>✕</button>
</div>`;
}

/** Worktree-subview card for the exclusive remote-task auto-poller. */
function buildAutoPollPanelHtml(status: AutoPollStatus): string {
    const intervalLabel = `${status.intervalSec}s`;
    const dispatchLine = '<div class="autopoll-hint">🤖 拉取到新内容后会自动把任务派发给当前迭代任务的 AI 执行器（拉取并执行）。</div>';
    if (status.enabledHere) {
        return `<div class="autopoll-card on">
<div class="autopoll-title">🟢 自动轮询远程任务并执行：运行中</div>
<div class="autopoll-hint">每 ${intervalLabel} 运行 <b>${escapeHtml(status.script)}</b>，拉取到的新内容写入当前 worktree 的 <b>todo.md</b>（内容为空或无变化时不覆盖）。</div>
${dispatchLine}
<button class="btn-orange" onclick="toggleAutoPoll(false)">⏸ 关闭自动轮询</button>
</div>`;
    }

    const elsewhereNote = status.activeElsewhereName
        ? `<div class="autopoll-warn">「${escapeHtml(status.activeElsewhereName)}」worktree 已开启自动轮询，请移步该 worktree，或先在那里关闭后再开启。</div>`
        : '';
    const scriptNote = status.scriptExists
        ? ''
        : `<div class="autopoll-warn">未找到拉取脚本 <b>script/${escapeHtml(status.script)}</b>，请先在主工作区「高级设置 → 自动轮询」中创建脚本。</div>`;
    return `<div class="autopoll-card">
<div class="autopoll-title">⚪ 自动轮询远程任务并执行：未开启</div>
<div class="autopoll-hint">开启后，本 worktree 每 ${intervalLabel} 运行 <b>${escapeHtml(status.script)}</b>，将拉取到的新内容写入 <b>todo.md</b>，并自动派发给当前迭代任务的 AI 执行器执行。同一时间只能有一个 worktree 开启。</div>
${elsewhereNote}
${scriptNote}
<button class="btn-green" onclick="toggleAutoPoll(true)">▶ 开启自动轮询远程任务并执行</button>
</div>`;
}

export interface MainTaskViewModel {
    task: Task;
    stats: TaskStats;
    pct: number;
    subTasks: SubTask[];
    latestFailureReason?: string;
    isAuto: boolean;
    artifacts: {
        requirements: boolean;
        requirementsReady: boolean;
        design: boolean;
        designReady: boolean;
        testcase: boolean;
        tasks: boolean;
        testScript: boolean;
    };
    health: {
        worktreeExists: boolean;
        frontendExists: boolean;
        backendExists: boolean;
        mainFrontendExists: boolean;
        mainBackendExists: boolean;
        branchRouteReady: boolean;
        mergeRouteReady: boolean;
        severity: 'good' | 'warn' | 'bad';
        summary: string;
    };
}

type PanelMode = 'main' | 'worktree';
type ActionPlacement = 'primary' | 'side';

interface TaskActionContext {
    panelMode: PanelMode;
    isWorktreeSubview: boolean;
    taskView: MainTaskViewModel;
    task: Task;
    allSubTasksDone: boolean;
    hasWorktree: boolean;
    hasFrontendStartCmd: boolean;
    hasBackendStartCmd: boolean;
}

interface TaskActionConfig {
    key: string;
    placement: ActionPlacement;
    panels: PanelMode[];
    stages: Task['stage'][] | 'all';
    when?: (ctx: TaskActionContext) => boolean;
    render: (ctx: TaskActionContext) => string;
}

const TASK_ACTION_CONFIGS: TaskActionConfig[] = [
    {
        key: 'req-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('req','${ctx.task.id}')">🤖 运行需求 Agent</button>`,
    },
    {
        key: 'req-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="btn-blue" onclick="next('req','${ctx.task.id}')">✅ 确认需求并进入设计</button>`,
    },
    {
        key: 'req-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','requirements')">📄 查看需求产物</button>`,
    },
    {
        key: 'des-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('des','${ctx.task.id}')">🤖 运行设计 Agent</button>`,
    },
    {
        key: 'des-confirm-tcs',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-blue" onclick="next('des','${ctx.task.id}','tcs')">✅ 确认设计并进入测试</button>`,
    },
    {
        key: 'des-skip-tsk',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-blue" onclick="next('des','${ctx.task.id}','tsk')">⏭ 跳过测试直达任务</button>`,
    },
    {
        key: 'des-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','design')">📄 查看设计产物</button>`,
    },
    {
        key: 'tcs-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('tcs','${ctx.task.id}')">🤖 运行测试用例 Agent</button>`,
    },
    {
        key: 'tcs-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="btn-blue" onclick="next('tcs','${ctx.task.id}')">✅ 确认测试用例</button>`,
    },
    {
        key: 'tcs-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE, STAGE.WRITING_TASKS, STAGE.DEVELOPING],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','testcase')">📄 查看测试用例</button>`,
    },
    {
        key: 'test-script-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE, STAGE.DEVELOPING],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','testScript')">🧪 查看测试脚本</button>`,
    },
    {
        key: 'tsk-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('tsk','${ctx.task.id}')">🤖 运行任务 Agent</button>`,
    },
    {
        key: 'tsk-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="btn-blue" onclick="next('tsk','${ctx.task.id}')">✅ 确认任务拆解</button>`,
    },
    {
        key: 'tasks-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS, STAGE.DEVELOPING, STAGE.READY_FOR_REVIEW],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','tasks')">📋 查看任务产物</button>`,
    },
    {
        key: 'dev-auto-toggle',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        // Quick-mode tasks have no subtask plan, so the auto-scheduler / "next" buttons
        // wouldn't have anything to dispatch — hide them and show "运行开发 Agent" instead.
        when: (ctx) => !ctx.allSubTasksDone && !ctx.task.quickMode,
        render: (ctx) => ctx.taskView.isAuto
            ? `<button class="btn-orange" onclick="pauseAuto('${ctx.task.id}')">⏸ 暂停</button>`
            : `<button class="btn-green" onclick="startAuto('${ctx.task.id}')">▶ 自动执行</button>`,
    },
    {
        key: 'dev-next',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        when: (ctx) => !ctx.allSubTasksDone && !ctx.task.quickMode,
        render: (ctx) => `<button class="btn-gray" onclick="nextTask('${ctx.task.id}')">⏭ 下一个</button>`,
    },
    {
        key: 'dev-run-quick',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        when: (ctx) => Boolean(ctx.task.quickMode),
        render: (ctx) => `<button class="btn-green" onclick="runAgent('dev','${ctx.task.id}')">🤖 运行开发 Agent</button>`,
    },
    {
        key: 'dev-push-primary',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        render: (ctx) => `<button class="btn-blue" onclick="${ctx.isWorktreeSubview ? 'pushDev' : 'pushAll'}('${ctx.task.id}')">🚀 推送</button>`,
    },
    {
        key: 'review-pass',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.READY_FOR_REVIEW],
        render: (ctx) => `<button class="btn-green" onclick="pass('${ctx.task.id}')">🏁 完成任务并合并</button>`,
    },
    {
        key: 'sync-code',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="btn-gray" onclick="syncMainCode('${ctx.task.id}')">🔄 从基线同步代码</button>`,
    },
    {
        key: 'start-services',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        // Always show in worktree subview; show in main panel when an iteration worktree exists.
        // Click handler walks frontend/ + backend/ under the iter dir, runs fun_harness_start.{sh,ps1}
        // if present, otherwise materializes config cmd or dispatches AI to generate the script.
        when: (ctx) => ctx.isWorktreeSubview || ctx.hasWorktree,
        render: (ctx) => `<button class="btn-gray" onclick="startServices('${ctx.task.id}')">▶ 启动服务</button>`,
    },
    {
        key: 'commit-to-baseline',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="btn-gray" onclick="commitToBaseline('${ctx.task.id}')">📤 提交代码</button>`,
    },
    // 'open-worktree' is rendered as a fixed button in the task card header, not via the action system.
    {
        key: 'edit-desc',
        placement: 'side',
        panels: ['main'],
        stages: 'all',
        render: (ctx) => `<button class="btn-gray" onclick="editTaskDesc('${ctx.task.id}')">📝 编辑需求描述</button>`,
    },
    {
        key: 'reset-task',
        placement: 'side',
        panels: ['main'],
        stages: 'all',
        render: (ctx) => `<button class="btn-red" onclick="resetTask('${ctx.task.id}')">♻ 重置任务</button>`,
    },
];

function collectTaskActions(ctx: TaskActionContext): { primaryActions: string[]; sideActions: string[] } {
    const primaryActions: string[] = [];
    const sideActions: string[] = [];

    for (const action of TASK_ACTION_CONFIGS) {
        if (!action.panels.includes(ctx.panelMode)) {
            continue;
        }
        if (action.stages !== 'all' && !action.stages.includes(ctx.task.stage)) {
            continue;
        }
        if (action.when && !action.when(ctx)) {
            continue;
        }
        const rendered = action.render(ctx);
        if (!rendered) {
            continue;
        }
        if (action.placement === 'primary') {
            primaryActions.push(rendered);
        } else {
            sideActions.push(rendered);
        }
    }

    return { primaryActions, sideActions };
}

export function buildMainPageHtml(
    taskViews: MainTaskViewModel[],
    dashboard: { activeAutoCount: number; maxConcurrentAutoTasks: number; abnormalCount: number },
    config: { compactTaskDecomposition: boolean; isWorktreeSubview: boolean; frontendStartCmd: string; backendStartCmd: string; aiProvider: string; customButtons: CustomButton[]; autoPoll?: AutoPollStatus }
): string {
    const customButtons = config.customButtons || [];
    const isWorktreeSubview = config.isWorktreeSubview === true;
    const visibleTaskViews = isWorktreeSubview
        ? taskViews.slice(0, 1)
        : taskViews;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#111;color:#eee;padding:14px;font-family:-apple-system;padding-bottom:20px}
.nav{display:flex;gap:8px;margin-bottom:10px}
.nav-btn{flex:1;padding:8px;border-radius:8px;border:none;background:#222;color:#eee}
.nav-btn.active{background:#007aff}
.header{display:flex;justify-content:space-between;align-items:center}
.header-actions{display:flex;gap:8px;align-items:center}
.refresh{background:#007aff;color:white;border:none;padding:6px 10px;border-radius:8px;font-size:12px}
.toolbar-btn{background:#2c2c2e;color:#eee;border:none;padding:6px 10px;border-radius:8px;font-size:12px}
.task-item{background:#222;border-radius:10px;padding:12px;margin-bottom:10px}
.task-name{font-weight:600;margin-bottom:6px}
.task-desc{font-size:12px;color:#999}
.task-progress{height:6px;background:#333;border-radius:3px;margin:6px 0}
.progress-bar{height:100%;background:#34c759;border-radius:3px}
.task-status{font-size:12px;color:#ccc;margin-top:4px}
.action{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.action button{flex:1;padding:8px;border-radius:8px;border:none;font-size:11px;min-width:80px}
.action-stack{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.action-group{display:flex;gap:6px;flex-wrap:wrap}
.action-label{font-size:11px;color:#8f8f94;text-transform:uppercase;letter-spacing:.04em}
.btn-blue{background:#007aff;color:white}
.btn-green{background:#34c759;color:white}
.btn-gray{background:#444;color:#eee}
.btn-orange{background:#ff9500;color:white}
.btn-red{background:#ff3b30;color:white}
.fixed-bottom{position:sticky;bottom:0;background:#111;padding-top:8px;padding-bottom:4px;margin-top:10px}
.input-card{background:#1c1c1e;border-radius:12px;padding:12px}
input,textarea{width:100%;padding:10px;border-radius:8px;border:none;background:#2c2c2e;color:#fff;margin-bottom:8px}
.btn-primary{background:#007aff;color:white;padding:10px;border:none;border-radius:8px;width:100%}
.sub-task-list{margin-top:8px;font-size:11px;max-height:200px;overflow-y:auto}
.sub-task{padding:4px 0;display:flex;align-items:center;gap:6px}
.st-done{color:#34c759}.st-doing{color:#007aff}.st-failed{color:#ff3b30}.st-todo{color:#666}
.health-line{display:flex;align-items:center;gap:8px;margin-top:4px}
.health-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.health-good{background:#163a24;color:#7ee2a8}
.health-warn{background:#4a3412;color:#ffd37a}
.health-bad{background:#4a1818;color:#ff9a9a}
.task-config{margin-top:8px;background:#1a1a1a;border-radius:8px;padding:6px 8px}
.task-config>summary{cursor:pointer;font-size:12px;color:#bbb;list-style:none}
.task-config>summary::-webkit-details-marker{display:none}
.task-config[open]>summary{color:#fff}
.task-config-body{margin-top:6px}
.config-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.config-actions button{flex:1;padding:6px;border-radius:8px;border:none;font-size:11px;min-width:120px}
.stage-more{margin-top:6px}
.stage-more>summary{cursor:pointer;font-size:12px;color:#aaa;list-style:none}
.stage-more>summary::-webkit-details-marker{display:none}
.stage-more-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.stage-more-actions button{flex:1;padding:8px;border-radius:8px;border:none;font-size:11px;min-width:120px}
.task-hidden{display:none}
.mode-banner{margin:10px 0 12px;padding:8px 10px;background:#1d2e3b;border:1px solid #2f556f;border-radius:8px;color:#9ecff0;font-size:12px}
.autopoll-card{margin:0 0 12px;padding:10px 12px;background:#1c1c1e;border:1px solid #34343a;border-radius:10px}
.autopoll-card.on{border-color:#1f6b3a;background:#13251a}
.autopoll-title{font-weight:600;font-size:13px;margin-bottom:6px}
.autopoll-hint{font-size:12px;color:#a9a9b0;line-height:1.5;margin-bottom:8px}
.autopoll-warn{font-size:12px;color:#ffd56a;background:#2b2308;border:1px solid #7a5d00;border-radius:8px;padding:8px;margin-bottom:8px}
.autopoll-card button{width:100%;padding:8px;border-radius:8px;border:none;font-size:12px}
.sub-task-panel{margin-top:8px;background:#1a1a1a;border-radius:8px;padding:6px 8px}
.sub-task-panel>summary{cursor:pointer;font-size:12px;color:#bbb;list-style:none}
.sub-task-panel>summary::-webkit-details-marker{display:none}
.sub-task-panel[open]>summary{color:#fff}
</style>
</head>
<body>

${!isWorktreeSubview ? `<div class="nav">
<button class="nav-btn active" onclick="p('main')">任务面板</button>
<button class="nav-btn" onclick="p('settings')">高级设置</button>
</div>` : ''}

<div class="header">
<h4>${isWorktreeSubview ? '🎯 当前迭代任务' : '📌 迭代任务'}</h4>
<div class="header-actions">
${!isWorktreeSubview ? `
<span class="task-status">并发槽位：${dashboard.activeAutoCount}/${dashboard.maxConcurrentAutoTasks}</span>
<span class="task-status">异常任务：${dashboard.abnormalCount}</span>
<button class="toolbar-btn" onclick="toggleAbnormalOnly()">⚠ 只看异常</button>
<button class="toolbar-btn" onclick="openAbnormalTasks()">📂 打开异常任务</button>
` : ''}
<button class="refresh" onclick="refresh()">🔄 刷新</button>
</div>
</div>

${isWorktreeSubview ? '<div class="mode-banner">子面板仅保留当前迭代任务操作，不提供高级设置与创建迭代功能。<button class="toolbar-btn" style="margin-left:8px" onclick="openMasterWorkspace()">↩ 回到主工作区</button></div>' : ''}

${isWorktreeSubview && config.autoPoll ? buildAutoPollPanelHtml(config.autoPoll) : ''}

${visibleTaskViews.map(view => {
    const t = view.task;
    const stats = view.stats;
    const subTasks = view.subTasks;
    const isAuto = view.isAuto;
    const artifacts = view.artifacts;
    const health = view.health;
    const taskAutoAdvance = t.autoAdvanceEnabled !== false;
    const taskAutoRepair = t.autoRepairEnabled === true;
    const effectiveSplitMode = config.compactTaskDecomposition ? 'compact' : (t.taskSplitMode || 'standard');
    const artifactStatus = [
        `REQ:${artifacts.requirements ? 'Y' : 'N'}`,
        `DES:${artifacts.design ? 'Y' : 'N'}`,
        `TCS:${artifacts.testcase ? 'Y' : 'N'}`,
        `TSK:${artifacts.tasks ? 'Y' : 'N'}`,
        `TEST:${artifacts.testScript ? 'Y' : 'N'}`,
    ].join('  ');
    const healthStatus = [
        `WT:${health.worktreeExists ? 'Y' : 'N'}`,
        `FE:${health.frontendExists ? 'Y' : 'N'}`,
        `BE:${health.backendExists ? 'Y' : 'N'}`,
        `MFE:${health.mainFrontendExists ? 'Y' : 'N'}`,
        `MBE:${health.mainBackendExists ? 'Y' : 'N'}`,
        `BR:${health.branchRouteReady ? 'Y' : 'N'}`,
        `MR:${health.mergeRouteReady ? 'Y' : 'N'}`,
    ].join('  ');
    const healthClass = health.severity === 'bad' ? 'health-bad' : health.severity === 'warn' ? 'health-warn' : 'health-good';
    const healthLabel = health.severity === 'bad' ? '异常' : health.severity === 'warn' ? '注意' : '正常';
    const isAbnormal = health.severity !== 'good';
    const showSubTasks = (t.stage === STAGE.WRITING_TASKS || t.stage === STAGE.DEVELOPING) && subTasks.length > 0;
    const canOperateSubTasks = t.stage === STAGE.DEVELOPING;
    const allSubTasksDone = t.stage === STAGE.DEVELOPING && stats.total > 0 && stats.done >= stats.total;
    const hasWorktree = Boolean(t.worktreePath) || health.worktreeExists || health.frontendExists || health.backendExists;
    const hasFrontendStartCmd = Boolean((config.frontendStartCmd || '').trim());
    const hasBackendStartCmd = Boolean((config.backendStartCmd || '').trim());
    const panelMode: PanelMode = isWorktreeSubview ? 'worktree' : 'main';
    const { primaryActions, sideActions } = collectTaskActions({
        panelMode,
        isWorktreeSubview,
        taskView: view,
        task: t,
        allSubTasksDone,
        hasWorktree,
        hasFrontendStartCmd,
        hasBackendStartCmd,
    });

    // User-defined buttons: same visibility rule as 启动服务 (worktree subview always,
    // main panel only when an iteration worktree exists). Resolved server-side by id.
    if ((isWorktreeSubview || hasWorktree) && customButtons.length > 0) {
        for (const b of customButtons) {
            sideActions.push(`<button class="btn-gray" onclick="runCustomButton('${t.id}','${b.id}')">${escapeHtml(b.name)}</button>`);
        }
    }

    const actionHtml = `
<div class="action-stack">
  ${primaryActions.length > 0 ? `<div class="action-label">主流程操作</div><div class="action-group">${primaryActions.join('')}</div>` : ''}
  ${sideActions.length > 0 ? `<div class="action-label">旁路操作</div><div class="action-group">${sideActions.join('')}</div>` : ''}
</div>`;

    return `
<div class="task-item" data-task-id="${t.id}" data-abnormal="${isAbnormal ? '1' : '0'}">
<div style="display:flex;justify-content:space-between;align-items:center">
<div class="task-name">${t.name}</div>
${!isWorktreeSubview && t.worktreePath ? `<button class="btn-gray" style="flex:none;padding:4px 10px;font-size:11px;min-width:auto" onclick="openFolderLocation('${t.id}','worktree')">📁 Worktree</button>` : ''}
</div>
<div class="task-desc">${t.desc}</div>
<div>阶段：${t.stage}</div>
<div class="task-status">原因：${health.summary || '-'}</div>
${view.latestFailureReason ? `<div class="task-status">最近失败：${view.latestFailureReason}</div>` : ''}
<div class="task-status">待办:${stats.todo} 执行中:${stats.doing} 完成:${stats.done}${stats.failed > 0 ? ` 失败:${stats.failed}` : ''}</div>
<div class="task-progress"><div class="progress-bar" style="width:${view.pct}%"></div></div>
<div style="font-size:12px">进度：${view.pct}%</div>
<div class="toggle-row" style="margin:6px 0">
<span style="font-size:12px">AI 执行器</span>
<select style="width:auto;margin:0;padding:4px 6px;font-size:11px;background:#2c2c2e;color:#fff;border:none;border-radius:6px" onchange="setTaskAiProvider('${t.id}',this.value)">
${AI_PROVIDERS.map(p => `<option value="${p.id}" ${(t.aiProvider || config.aiProvider) === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
</select>
</div>

${!isWorktreeSubview ? `<details class="task-config">
<summary>⚙ 展开配置</summary>
<div class="task-config-body">
<div class="task-status">Worktree：${t.worktreePath || '-'}</div>
<div class="task-status">拆分模式：${effectiveSplitMode === 'compact' ? '急速模式' : '标准模式'}${config.compactTaskDecomposition ? '（全局配置）' : ''}</div>
<div class="task-status">基线分支：${t.baseBranchUsed || '-'}</div>
<div class="task-status">迭代分支：${t.iterationBranch || '-'}</div>
<div class="health-line"><span class="health-badge ${healthClass}">${healthLabel}</span><span class="task-status">${healthStatus}</span></div>
<div class="task-status">文档：${artifactStatus}</div>
<div class="task-status">任务自动化：推进 ${taskAutoAdvance ? '开' : '关'} / 回修 ${taskAutoRepair ? '开' : '关'}</div>
<div class="config-actions">
<button class="btn-gray" onclick="setTaskAutomation('${t.id}',${!taskAutoAdvance},${taskAutoRepair})">${taskAutoAdvance ? '⛔ 关闭自动推进' : '▶ 开启自动推进'}</button>
<button class="btn-gray" onclick="setTaskAutomation('${t.id}',${taskAutoAdvance},${!taskAutoRepair})">${taskAutoRepair ? '⛔ 关闭自动回修' : '🛠 开启自动回修'}</button>
</div>
</div>
</details>` : ''}

${showSubTasks ? `
<details class="sub-task-panel" ${isWorktreeSubview ? 'open' : ''}>
<summary>🧩 子任务（${subTasks.length}）</summary>
<div class="sub-task-list">
${subTasks.map(st => {
    const icon = st.status === 'done' ? '✅' : st.status === 'doing' ? '⏳' : st.status === 'failed' ? '❌' : '⬜';
    const cls = `st-${st.status}`;
    const actions = !canOperateSubTasks
        ? ''
        : st.status === 'failed'
        ? ` <button class="btn-red" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="retry('${st.id}','${t.id}')">重试</button> <button class="btn-green" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="setSubStatus('${t.id}','${st.id}','done')">标记完成</button>`
        : st.status === 'doing'
            ? ` <button class="btn-green" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="setSubStatus('${t.id}','${st.id}','done')">标记完成</button>`
            : '';
    return `<div class="sub-task"><span class="${cls}">${icon} ${st.id}</span> <span>${st.name}</span>${actions}</div>`;
}).join('')}
</div>
</details>
` : ''}

<div class="action">
${actionHtml}
</div>
</div>`;
}).join('')}

${!isWorktreeSubview ? `<div class="fixed-bottom">
<div class="input-card">
<h4>🚀 创建迭代开发版本</h4>
<input id="name" placeholder="迭代名称（英文）">
<textarea id="desc" rows="2" placeholder="功能描述"></textarea>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0 8px;font-size:12px;color:var(--vscode-descriptionForeground)">
<input type="checkbox" id="quickMode"> 快捷模式（跳过需求/设计/任务拆解，直接进入开发）
</label>
<button class="btn-primary" onclick="create()">创建迭代开发版本</button>
</div>
</div>` : ''}

<script>
const v=acquireVsCodeApi();
let abnormalOnly=false;
function p(x){v.postMessage({type:'page',page:x})}
function create(){
    const name=document.getElementById('name').value.trim();
    const desc=document.getElementById('desc').value.trim();
    if(!name){alert('请输入迭代名称（英文）');return;}
    const quickMode=document.getElementById('quickMode').checked;
    v.postMessage({type:'create',name,desc,quickMode});
    document.getElementById('name').value='';
    document.getElementById('desc').value='';
    document.getElementById('quickMode').checked=false;
}
function runAgent(s,id){v.postMessage({type:'runAgent',step:s,id})}
function next(s,id,ts){v.postMessage({type:'next',step:s,id,...(ts?{targetStage:ts}:{})})}
function pass(id){v.postMessage({type:'pass',id})}
function refresh(){v.postMessage({type:'refresh'})}
function pushAll(id){v.postMessage({type:'pushAndNextStage',id})}
function commitToBaseline(id){v.postMessage({type:'commitToBaseline',id})}
function startAuto(id){v.postMessage({type:'startAuto',id})}
function pauseAuto(id){v.postMessage({type:'pauseAuto',id})}
function nextTask(id){v.postMessage({type:'nextTask',id})}
function retry(subId,id){v.postMessage({type:'retryTask',subId,id})}
function syncMainCode(id){v.postMessage({type:'syncMainCode',id})}
function openMasterWorkspace(){v.postMessage({type:'openMasterWorkspace'})}
function startService(id,target){v.postMessage({type:'startService',id,target})}
function startServices(id){v.postMessage({type:'startServices',id})}
function runCustomButton(id,buttonId){v.postMessage({type:'runCustomButton',id,buttonId})}
function toggleAutoPoll(enable){v.postMessage({type:'toggleAutoPoll',enable})}
function setSubStatus(id,subId,status){v.postMessage({type:'setSubTaskStatus',id,subId,status})}
function editTaskDesc(id){v.postMessage({type:'requestEditTaskDesc',id})}
function resetTask(id){v.postMessage({type:'resetTask',id})}
function openArtifact(id,artifact){v.postMessage({type:'openArtifact',id,artifact})}
function openFolderLocation(id,location){v.postMessage({type:'openFolderLocation',id,location})}
function setTaskAutomation(id,aa,ar){v.postMessage({type:'setTaskAutomation',id,aa,ar})}
function setTaskAiProvider(id,ap){v.postMessage({type:'setTaskAiProvider',id,ap})}
function pushDev(id){v.postMessage({type:'pushAndNextStage',id})}
function toggleAbnormalOnly(){
    abnormalOnly=!abnormalOnly;
    const items=document.querySelectorAll('.task-item[data-task-id]');
    items.forEach((item)=>{
        const abnormal=item.getAttribute('data-abnormal')==='1';
        item.classList.toggle('task-hidden', abnormalOnly && !abnormal);
    });
}
function openAbnormalTasks(){
    const items=document.querySelectorAll('.task-item[data-task-id][data-abnormal="1"]');
    items.forEach((item)=>{
        const id=item.getAttribute('data-task-id');
        if(id){openFolderLocation(id,'worktree');}
    });
}
</script>
</body>
</html>`;
}

export function buildSettingsPageHtml(
    config: Config,
    configMeta: HarnessConfigMeta,
    scriptFiles: string[],
    scriptDir: string
): string {
    const readOnly = configMeta.readOnly === true;
    const disabled = readOnly ? 'disabled' : '';
    const originLabel = configMeta.origin === 'worktreeSnapshot'
        ? '子 worktree 快照配置'
        : configMeta.origin === 'master'
            ? '主窗口配置'
            : '未标记配置';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{background:#111;color:#eee;padding:14px}
.nav{display:flex;gap:8px;margin-bottom:10px}
.nav-btn{flex:1;padding:8px;border-radius:8px;border:none;background:#222;color:#eee}
.nav-btn.active{background:#007aff}
h5{margin:10px 0 4px;color:#aaa;font-size:12px}
input,select,textarea{width:100%;padding:10px;border-radius:8px;border:none;background:#222;color:#fff;margin-bottom:8px}
button{width:100%;padding:10px;border-radius:8px;border:none;color:white;margin-top:10px}
.section{background:#1c1c1e;border-radius:10px;padding:12px;margin-bottom:12px}
.section-title{font-weight:600;margin-bottom:8px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;margin:8px 0;color:#ddd;font-size:13px}
.toggle-row input{width:auto;margin:0}
.meta-box{background:#2a2a2d;border:1px solid #3a3a3f;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;color:#ddd}
.meta-box.readonly{border-color:#7a5d00;background:#2b2308;color:#ffd56a}
.sub-card{background:#232326;border:1px solid #34343a;border-radius:8px;padding:10px;margin-top:10px}
.sub-title{font-weight:600;font-size:13px;color:#d8d8dd;margin-bottom:8px}
.hint{font-size:12px;color:#a9a9b0;line-height:1.5;margin-bottom:8px}
.kv{font-size:12px;color:#c8c8ce;line-height:1.6}
.kv b{color:#fff}
.inline-actions{display:flex;gap:8px;flex-wrap:wrap}
.inline-actions button{flex:1;min-width:160px}
.fold{margin-top:10px;background:#1a1a1e;border:1px solid #323238;border-radius:8px;padding:8px}
.fold>summary{cursor:pointer;color:#d3d3d8;font-size:13px;list-style:none}
.fold>summary::-webkit-details-marker{display:none}
.fold[open]>summary{margin-bottom:8px;color:#fff}
.cb-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.cb-row input{margin:0}
.cb-name{flex:1}
.cb-dir{flex:1}
.cb-cmd{flex:2}
.cb-del{width:auto;flex:none;margin:0;padding:10px 14px;background:#ff3b30}
.cb-empty{margin:10px 0;padding:10px;border-radius:8px;background:#2b2308;border:1px solid #7a5d00;color:#ffd56a;font-size:12px}
</style>
</head>
<body>

<div class="nav">
<button class="nav-btn" onclick="p('main')">任务面板</button>
<button class="nav-btn active" onclick="p('settings')">高级设置</button>
</div>

<div class="meta-box ${readOnly ? 'readonly' : ''}">
<div>配置来源：${originLabel}</div>
${configMeta.masterRoot ? `<div>主窗口路径：${configMeta.masterRoot}</div>` : ''}
${readOnly ? '<div>当前窗口仅用于查看，不允许修改配置。</div>' : ''}
</div>

<div class="section">
<div class="section-title">Git 配置</div>
<h5>前端 Git 地址（可选）</h5>
<input id="fg" value="${config.frontendGit || ''}" ${disabled}>
<h5>后端 Git 地址（可选）</h5>
<input id="bg" value="${config.backendGit || ''}" ${disabled}>
<h5>基线分支（如 main、master 或 yourname/integration）</h5>
<input id="bb" value="${config.baseBranch || ''}" placeholder="如 main 或 yourname/integration" ${disabled}>
<div class="toggle-row">
<span>合并前 dry-run 冲突检查</span>
<input id="dr" type="checkbox" ${config.mergeDryRunEnabled ? 'checked' : ''} ${disabled}>
</div>
<button onclick="saveGit()" style="background:#007aff" ${disabled}>💾 保存 Git 配置并初始化代码</button>
</div>

<div class="section">
<div class="section-title">开发环境配置</div>
<div class="sub-card">
<div class="sub-title">自动检测结果</div>
<div class="hint">推荐先自动检测环境配置，再按需手工微调。自动检测会回填前后端启动命令和后端端口。</div>
<div class="kv">
<div><b>前端启动命令：</b>${config.frontendStartCmd || '（未配置）'}</div>
<div><b>后端启动命令：</b>${config.backendStartCmd || '（未配置）'}</div>
<div><b>后端端口：</b>${config.backendPort || 8080}</div>
<div><b>启动链模式：</b>${config.startupChainMode === 'light' ? '轻量（更快）' : '完整（更稳）'}</div>
<div><b>Java Profile：</b>${config.javaRuntimeProfile || '（未配置）'}</div>
</div>
<div class="hint">来源说明：自动检测会按项目类型生成基础命令，再套用你配置的启动模板。模板占位符支持 {install} / {offline} / {clean} / {run}。</div>
<div class="inline-actions">
<button onclick="autoDetectDevEnv()" style="background:#30b0c7" ${disabled}>🤖 自动检测并回填</button>
<button onclick="openArtifactsIndex()" style="background:#6d6d72" ${disabled}>📚 打开文档归档索引</button>
</div>
</div>

<div class="sub-card">
<div class="sub-title">手动覆盖（运行参数）</div>
<h5>前端启动命令（如 npm run dev）</h5>
<input id="fsc" value="${config.frontendStartCmd || ''}" ${disabled}>
<h5>后端启动命令（如 mvn spring-boot:run）</h5>
<input id="bsc" value="${config.backendStartCmd || ''}" ${disabled}>
<h5>后端端口（默认 8080）</h5>
<input id="bp" type="number" value="${config.backendPort || 8080}" ${disabled}>
<h5>启动链模式</h5>
<select id="sm" ${disabled}>
<option value="full" ${config.startupChainMode !== 'light' ? 'selected' : ''}>完整模式（安装/预热依赖 + 清理 + 启动）</option>
<option value="light" ${config.startupChainMode === 'light' ? 'selected' : ''}>轻量模式（尽量直接启动）</option>
</select>
<h5>Java 运行 Profile（可选）</h5>
<input id="jp" value="${config.javaRuntimeProfile || ''}" placeholder="如 dev、sit、local" ${disabled}>
<h5>前端启动模板</h5>
<textarea id="fst" rows="2" placeholder="例如：{install} && {run}" ${disabled}>${config.frontendStartupTemplate || '{install} && {run}'}</textarea>
<h5>后端启动模板</h5>
<textarea id="bst" rows="2" placeholder="例如：{install} && {offline} && {clean} && {run}" ${disabled}>${config.backendStartupTemplate || '{install} && {offline} && {clean} && {run}'}</textarea>
<h5>CLI 命令模板（CLI 类执行器可选，AI 执行器在各任务卡片上独立设置）</h5>
<input id="cct" value="${config.cliCommandTemplate || config.claudeCliCommandTemplate || ''}" placeholder="例如：cat \"{promptFile}\" | claude" ${disabled}>
<div class="toggle-row">
<span>CLI 执行器失败时自动降级到手工模式</span>
<input id="afm" type="checkbox" ${config.aiFallbackToManual !== false ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>Claude Code (面板) 预填后自动回车发送（仅 macOS，需授予编辑器「辅助功能」权限）</span>
<input id="pas" type="checkbox" ${config.aiPanelAutoSubmit !== false ? 'checked' : ''} ${disabled}>
</div>
<div class="inline-actions">
<button onclick="saveRuntimeConfig()" style="background:#007aff" ${disabled}>💾 保存运行参数</button>
</div>
</div>

<details class="fold">
<summary>⚙ 高级策略配置（折叠）</summary>
<h5>技术栈描述</h5>
<input id="ts" value="${config.techStack || ''}" placeholder="如：前端 Vue3+TS，后端 SpringBoot3" ${disabled}>
<h5>通用编码规范（简要）</h5>
<input id="cs" value="${config.codingStandards || ''}" placeholder="如：小驼峰命名，方法加注释" ${disabled}>
<h5>项目自定义约定（多行，完全自定义）</h5>
<textarea id="pc" rows="6" placeholder="例如：\n1. 前端入口开关必须由后端配置中心下发\n2. 功能入口统一展示在“更多”页\n3. 跳转链接由后端返回并经过白名单校验" ${disabled}>${config.projectConventions || ''}</textarea>
<h5>最大自动执行并发槽位</h5>
<input id="mc" type="number" min="1" value="${config.maxConcurrentAutoTasks || 2}" ${disabled}>
<div class="toggle-row">
<span>自动阶段推进</span>
<input id="aa" type="checkbox" ${config.autoAdvanceEnabled ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>校验失败自动回修</span>
<input id="ar" type="checkbox" ${config.autoRepairEnabled ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>人工修正为完成后自动继续</span>
<input id="am" type="checkbox" ${config.autoContinueAfterManualDone !== false ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>任务拆分精简模式</span>
<input id="cm" type="checkbox" ${config.compactTaskDecomposition ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>按需求描述自动判别拆分模式</span>
<input id="ad" type="checkbox" ${config.autoDetectTaskSplitMode !== false ? 'checked' : ''} ${disabled}>
</div>
<h5>简单需求关键词（逗号分隔）</h5>
<input id="sk" value="${config.simpleTaskKeywords || ''}" placeholder="如 blacklist,crud,管理,配置" ${disabled}>
<h5>复杂需求关键词（逗号分隔）</h5>
<input id="ck" value="${config.complexTaskKeywords || ''}" placeholder="如 workflow,审批,跨系统,并发" ${disabled}>
<h5>worktree 打开时同步目录（支持多项，按行/逗号/分号分隔）</h5>
<textarea id="wsd" rows="3" placeholder="例如：worktree/.github/instructions" ${disabled}>${config.worktreeSyncPaths || ''}</textarea>
<h5>项目结构提炼模式</h5>
<select id="prm" ${disabled}>
<option value="local" ${config.projectStructureRefineMode === 'local' ? 'selected' : ''}>仅本地规则提炼（快速）</option>
<option value="local+ai" ${config.projectStructureRefineMode !== 'local' ? 'selected' : ''}>本地提炼 + AI 二次审阅（更完整）</option>
</select>
<h5>自定义项目目录结构（可选，优先级最高）</h5>
<textarea id="cps" rows="12" placeholder="填写团队约定的目录结构。留空时：已有项目会自动提炼；新项目回退到默认模板。" ${disabled}>${config.customProjectStructure || ''}</textarea>
<div class="inline-actions">
<button onclick="initProjectStructure()" style="background:#8e8e93" ${disabled}>🧭 自动检测并初始化项目结构</button>
<button onclick="applyProjectStructurePreview()" style="background:#5ac8fa" ${disabled}>✅ 应用预览结构</button>
</div>
<button onclick="saveAdvancedConfig()" style="background:#007aff" ${disabled}>💾 保存高级策略</button>
</details>
</div>

<div class="section">
<div class="section-title">自定义按钮</div>
<div class="hint">脚本统一维护在主目录的 <b>script/</b> 目录下（如 deploy.sh）。为按钮选择「执行目录」（根目录 / frontend / backend）和一个脚本即可；点击按钮时先 cd 到该任务 worktree 迭代目录下的所选文件夹，再运行所选脚本（插件会按你的操作系统自动拼接执行命令）。可配置多个。</div>
<div class="kv">脚本目录：<b>${escapeHtml(scriptDir)}</b></div>
<div class="inline-actions" style="margin-top:8px">
<button onclick="openScriptDir()" style="background:#6d6d72" ${disabled}>📂 打开 script 目录</button>
<button onclick="p('settings')" style="background:#8e8e93">🔄 刷新脚本列表</button>
</div>
${scriptFiles.length === 0 ? '<div class="cb-empty">script/ 目录下暂无脚本文件。请先在上面的脚本目录中创建脚本（如 deploy.sh），然后点「🔄 刷新脚本列表」。</div>' : ''}
<div id="cbList">
${(config.customButtons || []).map(b => customButtonRowHtml(b.name, b.command, b.workdir || '', scriptFiles, disabled)).join('')}
</div>
<div class="inline-actions">
<button onclick="addCustomButton()" style="background:#3a3a3f" ${scriptFiles.length === 0 ? 'disabled' : disabled}>➕ 添加按钮</button>
<button onclick="saveCustomButtons()" style="background:#007aff" ${disabled}>💾 保存自定义按钮</button>
</div>
</div>

<div class="section">
<div class="section-title">自动轮询远程任务</div>
<div class="hint">设置轮询间隔与拉取脚本后，到任意 worktree 的<b>子面板</b>即可开启自动轮询（同一时间只能开启一个 worktree）。脚本固定放在主目录的 <b>script/</b> 下，约定把拉取到的任务清单<b>打印到 stdout</b>；插件读取后仅当内容非空且与现有 todo.md 不同才覆盖当前 worktree 的 <b>todo.md</b>。</div>
<h5>轮询间隔（秒，最小 5）</h5>
<input id="ap_int" type="number" min="5" value="${config.autoPollIntervalSec || 60}" ${disabled}>
<h5>拉取脚本文件名（位于 script/ 下，推荐 Node 脚本 pullTask.js）</h5>
<input id="ap_script" value="${escapeHtml(config.autoPollScript || 'pullTask.js')}" placeholder="pullTask.js" ${disabled}>
<div class="kv" style="margin:6px 0">脚本状态：<b>${scriptFiles.includes(config.autoPollScript || 'pullTask.js') ? '✅ 已存在' : '⚠ 未找到，请点「创建/打开脚本」'}</b></div>
<h5>自动任务 Prompt（派发给 AI 执行器时，会以「此 Prompt + 换行 + todo.md 内容」拼接后填入）</h5>
<textarea id="ap_prompt" rows="5" placeholder="${escapeHtml(DEFAULT_AUTO_POLL_PROMPT)}" ${disabled}>${escapeHtml(config.autoPollPrompt || DEFAULT_AUTO_POLL_PROMPT)}</textarea>
<div class="hint">留空保存则恢复为默认 Prompt。todo.md 内容会附在此 Prompt 之后一并发送（过长会在深链中截断，但完整内容已复制到剪贴板）。</div>
<h5>无任务跳过标记（每行一个；拉取结果整体 trim 后与某行完全相同，则视为"无任务"，不更新 todo.md 也不派发 AI）</h5>
<textarea id="ap_skip" rows="3" placeholder="${escapeHtml(DEFAULT_AUTO_POLL_SKIP_MARKERS)}" ${disabled}>${escapeHtml(config.autoPollSkipMarkers ?? DEFAULT_AUTO_POLL_SKIP_MARKERS)}</textarea>
<div class="hint">例如 get_next_todo_task 无任务时输出「没有未完成的待办任务」。匹配不区分大小写；留空表示不做跳过判断（任何非空输出都会触发执行）。</div>
<div class="hint">开启自动轮询即「拉取并执行」：每当 todo.md 拉取到新内容，自动把任务派发给「当前迭代任务卡片上选择的 AI 执行器」。选 <b>Claude Code (CLI 终端)</b> 可全自动在终端运行；选 <b>Claude Code (面板)</b> 会打开面板并预填提示词（需手动按回车发送）。在任意 worktree 子面板点「▶ 开启自动轮询远程任务并执行」即可。</div>
<div class="inline-actions">
<button onclick="createPollScriptTemplate()" style="background:#30b0c7" ${disabled}>📝 创建/打开脚本</button>
<button onclick="saveAutoPollConfig()" style="background:#007aff" ${disabled}>💾 保存轮询设置</button>
</div>
</div>

<div class="section">
<div class="section-title">Prompt 出厂设置</div>
<div class="hint">Prompt 内置于扩展中，默认即用。如需自定义，可点下方按钮把内置 Prompt 写入本项目 <code>.harness/prompts/</code> 后编辑；若改坏了，再次点击即可一键恢复出厂。</div>
<button onclick="restoreFactoryPrompts()" style="background:#ff3b30" ${disabled}>♻️ 恢复 Prompt 出厂设置（写入 .harness/prompts/）</button>
</div>

<script>
const v=acquireVsCodeApi();
function p(x){v.postMessage({type:'page',page:x})}
function restoreFactoryPrompts(){if(confirm('确定用内置出厂 Prompt 覆盖 .harness/prompts/ 中的副本？此操作会覆盖你在该目录下的修改。'))v.postMessage({type:'restoreFactoryPrompts'})}
function saveGit(){v.postMessage({type:'saveGit',fg:document.getElementById('fg').value,bg:document.getElementById('bg').value,bb:document.getElementById('bb').value,dr:document.getElementById('dr').checked})}
function saveDevConfig(){v.postMessage({type:'saveDevConfig',bsc:document.getElementById('bsc').value,bp:parseInt(document.getElementById('bp').value)||8080,fsc:document.getElementById('fsc').value,sm:document.getElementById('sm').value,jp:document.getElementById('jp').value,fst:document.getElementById('fst').value,bst:document.getElementById('bst').value,ts:document.getElementById('ts').value,cs:document.getElementById('cs').value,pc:document.getElementById('pc').value,mc:parseInt(document.getElementById('mc').value)||2,aa:document.getElementById('aa').checked,ar:document.getElementById('ar').checked,am:document.getElementById('am').checked,cm:document.getElementById('cm').checked,ad:document.getElementById('ad').checked,sk:document.getElementById('sk').value,ck:document.getElementById('ck').value,ap:'${config.aiProvider}',cct:document.getElementById('cct').value,afm:document.getElementById('afm').checked,pas:document.getElementById('pas').checked,wsd:document.getElementById('wsd').value,cps:document.getElementById('cps').value,prm:document.getElementById('prm').value})}
function saveRuntimeConfig(){v.postMessage({type:'saveRuntimeConfig',bsc:document.getElementById('bsc').value,bp:parseInt(document.getElementById('bp').value)||8080,fsc:document.getElementById('fsc').value,sm:document.getElementById('sm').value,jp:document.getElementById('jp').value,fst:document.getElementById('fst').value,bst:document.getElementById('bst').value,ap:'${config.aiProvider}',cct:document.getElementById('cct').value,afm:document.getElementById('afm').checked,pas:document.getElementById('pas').checked})}
function saveAdvancedConfig(){v.postMessage({type:'saveAdvancedConfig',ts:document.getElementById('ts').value,cs:document.getElementById('cs').value,pc:document.getElementById('pc').value,mc:parseInt(document.getElementById('mc').value)||2,aa:document.getElementById('aa').checked,ar:document.getElementById('ar').checked,am:document.getElementById('am').checked,cm:document.getElementById('cm').checked,ad:document.getElementById('ad').checked,sk:document.getElementById('sk').value,ck:document.getElementById('ck').value,wsd:document.getElementById('wsd').value,cps:document.getElementById('cps').value,prm:document.getElementById('prm').value})}
function initProjectStructure(){v.postMessage({type:'initProjectStructure'})}
function applyProjectStructurePreview(){v.postMessage({type:'applyProjectStructurePreview'})}
function openArtifactsIndex(){v.postMessage({type:'openArtifactsIndex'})}
function autoDetectDevEnv(){v.postMessage({type:'autoDetectDevEnv'})}
function testAiProvider(){v.postMessage({type:'testAiProvider'})}
function saveAutoPollConfig(){v.postMessage({type:'saveAutoPollConfig',interval:parseInt(document.getElementById('ap_int').value)||60,script:document.getElementById('ap_script').value.trim(),prompt:document.getElementById('ap_prompt').value,skipMarkers:document.getElementById('ap_skip').value})}
function createPollScriptTemplate(){v.postMessage({type:'createPollScriptTemplate'})}
const scriptFiles=${JSON.stringify(scriptFiles).replace(/</g, '\\u003c')};
const cbWorkdirs=${JSON.stringify(CUSTOM_BUTTON_WORKDIRS)};
function cbEscAttr(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
function cbScriptOptions(selected){
  let opts='<option value="">（选择脚本）</option>';
  scriptFiles.forEach(function(f){opts+='<option value="'+cbEscAttr(f)+'"'+(f===selected?' selected':'')+'>'+cbEscAttr(f)+'</option>';});
  return opts;
}
function cbWorkdirOptions(selected){
  let opts='<option value="">根目录</option>';
  cbWorkdirs.forEach(function(d){opts+='<option value="'+cbEscAttr(d)+'"'+(d===selected?' selected':'')+'>'+cbEscAttr(d)+'</option>';});
  return opts;
}
function cbEmptyRow(){return '<div class="cb-row"><input class="cb-name" placeholder="按钮名称（如 部署）"><select class="cb-dir" title="执行目录">'+cbWorkdirOptions('')+'</select><select class="cb-cmd">'+cbScriptOptions('')+'</select><button class="cb-del" onclick="removeCustomButton(this)">✕</button></div>';}
function addCustomButton(){if(scriptFiles.length===0){alert('请先在 script/ 目录下创建脚本，再点「刷新脚本列表」');return;}document.getElementById('cbList').insertAdjacentHTML('beforeend',cbEmptyRow());}
function removeCustomButton(btn){const r=btn.closest('.cb-row');if(r)r.remove();}
function openScriptDir(){v.postMessage({type:'openScriptDir'});}
function saveCustomButtons(){
  const rows=document.querySelectorAll('#cbList .cb-row');
  const buttons=[];
  rows.forEach(function(r){
    const name=r.querySelector('.cb-name').value.trim();
    const command=r.querySelector('.cb-cmd').value.trim();
    const workdir=r.querySelector('.cb-dir').value.trim();
    if(name&&command){buttons.push({name:name,command:command,workdir:workdir});}
  });
  v.postMessage({type:'saveCustomButtons',buttons:buttons});
}
</script>
</body>
</html>`;
}

export function buildErrorPageHtml(title: string, details: string, context?: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{background:#111;color:#eee;padding:14px;font-family:-apple-system}
.card{background:#1c1c1e;border:1px solid #3a3a3f;border-radius:12px;padding:14px}
.title{font-size:16px;font-weight:600;margin-bottom:8px}
.text{font-size:13px;line-height:1.5;color:#ddd;white-space:pre-wrap}
.meta{margin-top:10px;padding:10px;border-radius:8px;background:#232326;color:#aaa;font-size:12px;white-space:pre-wrap}
</style>
</head>
<body>
<div class="card">
<div class="title">${title}</div>
<div class="text">${details}</div>
${context ? `<div class="meta">${context}</div>` : ''}
</div>
</body>
</html>`;
}
