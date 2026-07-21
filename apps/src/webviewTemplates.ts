import { Config, CustomButton, ScriptInventory, STAGE, STAGE_LABEL, SubTask, Task, TaskStats, AI_PROVIDERS, DEFAULT_AUTO_POLL_PROMPT, DEFAULT_AUTO_POLL_SKIP_MARKERS, normalizeCustomButton } from './models';
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
        render: (ctx) => `<button class="btn-blue" onclick="next('des','${ctx.task.id}','tcs')">✅ 确认设计并进入 Testcase</button>`,
    },
    {
        key: 'des-skip-tsk',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-blue" onclick="next('des','${ctx.task.id}','tsk')">✅ 确认设计并进入任务（跳过 Testcase）</button>`,
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
        render: (ctx) => `<button class="btn-gray" onclick="syncMainCode('${ctx.task.id}')">🔄 拉取代码</button>`,
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
        panels: ['main', 'worktree'],
        stages: 'all',
        render: () => '',
    },
    {
        key: 'reset-task',
        placement: 'side',
        panels: ['main', 'worktree'],
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
    dashboard: Record<string, never>,
    config: { compactTaskDecomposition: boolean; isWorktreeSubview: boolean; aiProvider: string; customButtons: CustomButton[]; autoPollEnabled: boolean; autoPoll?: AutoPollStatus }
): string {
    const customButtons = config.customButtons || [];
    // 'main' buttons render in a dedicated main-panel area belonging to no iteration;
    // everything else (incl. legacy buttons without a placement) stays on task cards.
    const iterationButtons = customButtons.filter(b => b.placement !== 'main');
    const mainButtons = customButtons.filter(b => b.placement === 'main');
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
.task-desc-wrap{margin-top:4px}
.task-desc-view{display:flex;align-items:flex-start;gap:8px}
.task-desc{flex:1;font-size:12px;color:#999;white-space:pre-wrap;line-height:1.55;word-break:break-word}
.task-desc-edit-btn{flex:none;width:24px;height:24px;border:none;border-radius:6px;background:#34343a;color:#d7d7dc;font-size:12px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.task-desc-edit-btn:hover{background:#45454d}
.task-desc-wrap.editing .task-desc-view{display:none}
.task-desc-editor-wrap{display:none}
.task-desc-wrap.editing .task-desc-editor-wrap{display:block}
.task-desc-editor{width:100%;min-height:108px;max-height:260px;overflow-y:auto;padding:10px;border-radius:8px;background:#232326;border:1px solid #3a3a42;color:#f4f4f6;font-size:12px;line-height:1.6;white-space:pre-wrap;outline:none;resize:vertical;margin:0}
.task-desc-editor-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.task-desc-editor-actions button{width:auto;min-width:72px;padding:7px 12px;border-radius:8px;border:none;font-size:11px;color:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
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
.main-actions-card{margin:0 0 12px;padding:10px 12px;background:#1c1c1e;border:1px solid #34343a;border-radius:10px}
.main-actions-title{font-weight:600;font-size:13px;margin-bottom:8px}
.main-actions{display:flex;gap:6px;flex-wrap:wrap}
.main-actions button{flex:1;padding:8px;border-radius:8px;border:none;font-size:11px;min-width:80px}
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
.todo-card{margin:0 0 12px;padding:12px;background:#1c1c1e;border:1px solid #34343a;border-radius:10px}
.todo-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.todo-title{font-weight:600;font-size:13px}
.todo-list{display:flex;flex-direction:column;gap:8px}
.todo-item{background:#232326;border:1px solid #34343a;border-radius:8px;padding:8px}
.todo-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.todo-item-title{font-size:13px;font-weight:600;line-height:1.45;word-break:break-word}
.todo-item-title.done{text-decoration:line-through;color:#a0a0a7}
.todo-item-desc{margin-top:4px;font-size:12px;color:#b8b8bf;white-space:pre-wrap;line-height:1.5;word-break:break-word}
.todo-item-meta{margin-top:6px;font-size:11px;color:#8f8f96}
.todo-item-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.todo-item-actions button{flex:1;min-width:72px;padding:6px 8px;border:none;border-radius:7px;font-size:11px}
.todo-empty{padding:12px;border:1px dashed #4a4a52;border-radius:8px;color:#a9a9b0;font-size:12px;line-height:1.5;text-align:center}
.todo-editor{display:none;margin:10px 0 8px;padding:10px;background:#232326;border:1px solid #34343a;border-radius:8px}
.todo-editor.open{display:block}
.todo-editor-head{font-size:12px;color:#d6d6dc;margin-bottom:8px}
.todo-editor-actions{display:flex;gap:6px;flex-wrap:wrap}
.todo-editor-actions button{flex:1;min-width:80px;padding:8px;border:none;border-radius:8px;font-size:11px}
.todo-loading{font-size:12px;color:#a9a9b0;margin-bottom:6px}
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
<button class="refresh" onclick="refresh()">🔄 刷新</button>
</div>
</div>

${isWorktreeSubview ? '<div class="mode-banner">子面板仅保留当前迭代任务操作，不提供高级设置与创建迭代功能。<button class="toolbar-btn" style="margin-left:8px" onclick="openMasterWorkspace()">↩ 回到主工作区</button></div>' : ''}

${!isWorktreeSubview && mainButtons.length > 0 ? `<div class="main-actions-card">
<div class="main-actions-title">🛠 自定义操作（主面板）</div>
<div class="main-actions">${mainButtons.map(b => `<button class="btn-gray" onclick="runMainCustomButton('${b.id}')">${escapeHtml(b.name)}</button>`).join('')}</div>
</div>` : ''}

${isWorktreeSubview && config.autoPollEnabled && config.autoPoll ? buildAutoPollPanelHtml(config.autoPoll) : ''}

${`<div class="todo-card" id="workspace-todo-panel">
<div class="todo-head">
<div class="todo-title">${isWorktreeSubview ? '📝 共享待办（工作区）' : '📝 工作区待办'}</div>
<button class="btn-blue" style="padding:6px 10px;font-size:11px;min-width:auto;flex:none" onclick="openTodoCreateEditor()">＋ 添加待办</button>
</div>
<div id="todo-loading" class="todo-loading" style="display:none">正在加载待办列表...</div>
<div class="todo-editor" id="todo-editor">
<div class="todo-editor-head" id="todo-editor-head">新增待办</div>
<input id="todo-title-input" placeholder="标题（必填）">
<textarea id="todo-desc-input" rows="3" placeholder="描述（可选）"></textarea>
<select id="todo-status-select" style="display:none">
<option value="open">open</option>
<option value="done">done</option>
<option value="promoted">promoted</option>
</select>
<div class="todo-editor-actions">
<button class="btn-gray" onclick="closeTodoEditor()">取消</button>
<button class="btn-blue" onclick="submitTodoEditor()">保存</button>
</div>
</div>
<div id="todo-empty" class="todo-empty" style="display:none">
暂无待办，点击「添加待办」创建第一条记录。
</div>
<div id="todo-list" class="todo-list"></div>
</div>`}

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
    const panelMode: PanelMode = isWorktreeSubview ? 'worktree' : 'main';
    const { primaryActions, sideActions } = collectTaskActions({
        panelMode,
        isWorktreeSubview,
        taskView: view,
        task: t,
        allSubTasksDone,
        hasWorktree,
    });

    // User-defined buttons: same visibility rule (worktree subview always,
    // main panel only when an iteration worktree exists). Resolved server-side by id.
    if ((isWorktreeSubview || hasWorktree) && iterationButtons.length > 0) {
        for (const b of iterationButtons) {
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
<div class="task-desc-wrap" id="task-desc-wrap-${t.id}">
<div class="task-desc-view" id="task-desc-view-${t.id}">
<div class="task-desc" id="task-desc-${t.id}">${escapeHtml(t.desc || '')}</div>
<button type="button" class="task-desc-edit-btn" onclick="openTaskDescEditor('${t.id}')" title="编辑需求描述">✎</button>
</div>
<div class="task-desc-editor-wrap" id="task-desc-editor-wrap-${t.id}">
<textarea
class="task-desc-editor"
id="task-desc-editor-${t.id}"
oninput="autoGrowTaskDescEditor('${t.id}')"
placeholder="请输入需求描述"
>${escapeHtml(t.desc || '')}</textarea>
<div class="task-desc-editor-actions">
<button type="button" class="btn-gray" onclick="cancelTaskDescEditor('${t.id}')">取消</button>
<button type="button" class="btn-blue" onclick="commitTaskDescEditor('${t.id}')">保存</button>
</div>
</div>
</div>
${!t.quickMode ? `<div>阶段：${STAGE_LABEL[t.stage] || t.stage}</div>
<div class="task-status">原因：${health.summary || '-'}</div>
${view.latestFailureReason ? `<div class="task-status">最近失败：${view.latestFailureReason}</div>` : ''}
<div class="task-status">待办:${stats.todo} 执行中:${stats.doing} 完成:${stats.done}${stats.failed > 0 ? ` 失败:${stats.failed}` : ''}</div>
<div class="task-progress"><div class="progress-bar" style="width:${view.pct}%"></div></div>
<div style="font-size:12px">进度：${view.pct}%</div>` : ''}
${isWorktreeSubview ? `<div class="config-actions" style="margin-top:6px">
<button class="btn-gray" onclick="setTaskAutomation('${t.id}',${!taskAutoAdvance},${taskAutoRepair})">${taskAutoAdvance ? '⛔ 关闭自动推进' : '▶ 开启自动推进'}</button>
<button class="btn-gray" onclick="setTaskAutomation('${t.id}',${taskAutoAdvance},${!taskAutoRepair})">${taskAutoRepair ? '⛔ 关闭自动回修' : '🛠 开启自动回修'}</button>
</div>
<div class="task-status">任务自动化：推进 ${taskAutoAdvance ? '开' : '关'} / 回修 ${taskAutoRepair ? '开' : '关'}</div>` : ''}
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
    const redoAction = canOperateSubTasks && st.status === 'doing'
        ? ` <button class="btn-gray" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="retry('${st.id}','${t.id}')">重做</button>`
        : '';
    const actions = !canOperateSubTasks
        ? ''
        : st.status === 'failed'
        ? ` <button class="btn-gray" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="retry('${st.id}','${t.id}')">重跑</button> <button class="btn-green" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="setSubStatus('${t.id}','${st.id}','done')">标记完成</button>`
        : st.status === 'doing'
            ? `${redoAction} <button class="btn-green" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="setSubStatus('${t.id}','${st.id}','done')">标记完成</button>`
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
<label style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px;font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer">
<span>快捷模式（跳过拆解，直接开发）</span>
<input type="checkbox" id="quickMode" style="margin:0;width:16px;height:16px;flex-shrink:0">
</label>
<button class="btn-primary" onclick="create()">创建迭代开发版本</button>
</div>
</div>` : ''}

<script>
const v=acquireVsCodeApi();
const TODO_STATE_KEY='workspaceTodoState.v1';
const TODO_SOURCE_PANEL=${isWorktreeSubview ? "'worktree'" : "'master'"};
const TODO_INITIAL_TODOS=[];
let todoState=loadTodoState();

/** Escape raw text before writing into todo item HTML slots. */
function escapeTodoHtml(value){
    return String(value??'')
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}

/** Build a clean default client state for the main-panel todo widget. */
function createDefaultTodoState(){
    return {
        todos:Array.isArray(TODO_INITIAL_TODOS)?TODO_INITIAL_TODOS:[],
        loading:false,
        editor:{mode:'',id:'',title:'',description:'',status:'open'},
    };
}

/** Read persisted todo widget state from VS Code webview storage. */
function loadTodoState(){
    const state=v.getState()||{};
    const cached=state[TODO_STATE_KEY];
    const fallback=createDefaultTodoState();
    if(!cached||typeof cached!=='object'){
        return fallback;
    }
    return {
        todos:Array.isArray(TODO_INITIAL_TODOS)?TODO_INITIAL_TODOS:(Array.isArray(cached.todos)?cached.todos:[]),
        loading:cached.loading===true,
        editor:cached.editor&&typeof cached.editor==='object'
            ? {
                mode:cached.editor.mode==='edit'||cached.editor.mode==='create'?cached.editor.mode:'',
                id:String(cached.editor.id||''),
                title:String(cached.editor.title||''),
                description:String(cached.editor.description||''),
                status:cached.editor.status==='done'||cached.editor.status==='promoted'?cached.editor.status:'open',
            }
            : fallback.editor,
    };
}

/** Persist todo widget state so re-rendered pages can restore current draft/UI context. */
function saveTodoState(){
    const state=v.getState()||{};
    state[TODO_STATE_KEY]=todoState;
    v.setState(state);
}

/** Ask extension host for latest workspace todo list snapshot. */
function requestTodoList(){
    todoState.loading=true;
    saveTodoState();
    renderTodoPanel();
    v.postMessage({type:'todo.list'});
}

/** Return current todo item by id from local widget state. */
function findTodoById(id){
    return todoState.todos.find((todo)=>todo.id===id);
}

/** Render todo list, empty state and editor based on current local state. */
function renderTodoPanel(){
    const panel=document.getElementById('workspace-todo-panel');
    if(!panel){return;}

    const loading=document.getElementById('todo-loading');
    const empty=document.getElementById('todo-empty');
    const list=document.getElementById('todo-list');
    const editor=document.getElementById('todo-editor');
    const editorHead=document.getElementById('todo-editor-head');
    const titleInput=document.getElementById('todo-title-input');
    const descInput=document.getElementById('todo-desc-input');
    const statusSelect=document.getElementById('todo-status-select');
    if(!loading||!empty||!list||!editor||!editorHead||!titleInput||!descInput||!statusSelect){return;}

    loading.style.display=todoState.loading?'block':'none';

    const editorOpen=todoState.editor.mode==='create'||todoState.editor.mode==='edit';
    editor.classList.toggle('open',editorOpen);
    editorHead.innerText=todoState.editor.mode==='edit'?'编辑待办':'新增待办';
    titleInput.value=todoState.editor.title||'';
    descInput.value=todoState.editor.description||'';
    statusSelect.value=todoState.editor.status||'open';
    statusSelect.style.display=todoState.editor.mode==='edit'?'block':'none';

    if(todoState.todos.length===0){
        empty.style.display='block';
        list.innerHTML='';
        return;
    }

    empty.style.display='none';
    list.innerHTML=todoState.todos.map((todo)=>{
        const safeId=escapeTodoHtml(todo.id);
        const safeTitle=escapeTodoHtml(todo.title||'');
        const safeDesc=escapeTodoHtml(todo.description||'');
        const statusLabel=todo.status==='done'?'已完成':todo.status==='promoted'?'已转任务':'进行中';
        const updatedAt=escapeTodoHtml(todo.updatedAt||'');
        const nextStatus=todo.status==='done'?'open':'done';
        const descHtml=safeDesc?'<div class="todo-item-desc">'+safeDesc+'</div>':'';
        const titleClass=todo.status==='done'?'todo-item-title done':'todo-item-title';
        const toggleLabel=todo.status==='done'?'标记未完成':'标记完成';
        const promoteLabel=todo.status==='promoted'?'再次转任务':'转任务';
        return '<div class="todo-item">'
            + '<div class="todo-item-head">'
            + '<div class="'+titleClass+'">'+safeTitle+'</div>'
            + '<span class="task-status">'+statusLabel+'</span>'
            + '</div>'
            + descHtml
            + '<div class="todo-item-meta">ID: '+safeId+' · 更新于 '+(updatedAt||'-')+'</div>'
            + '<div class="todo-item-actions">'
            + '<button class="btn-gray" data-todo-action="toggle" data-todo-id="'+safeId+'" data-todo-next="'+nextStatus+'">'+toggleLabel+'</button>'
            + '<button class="btn-blue" data-todo-action="edit" data-todo-id="'+safeId+'">编辑</button>'
            + '<button class="btn-green" data-todo-action="promote" data-todo-id="'+safeId+'">'+promoteLabel+'</button>'
            + '<button class="btn-red" data-todo-action="delete" data-todo-id="'+safeId+'">删除</button>'
            + '</div>'
            + '</div>';
    }).join('');
}

/** Open create editor with cleared draft fields. */
function openTodoCreateEditor(){
    todoState.editor={mode:'create',id:'',title:'',description:'',status:'open'};
    saveTodoState();
    renderTodoPanel();
}

/** Open edit editor and load selected todo as initial values. */
function openTodoEditEditor(id){
    const todo=findTodoById(id);
    if(!todo){
        return;
    }
    todoState.editor={
        mode:'edit',
        id:todo.id,
        title:todo.title||'',
        description:todo.description||'',
        status:todo.status||'open',
    };
    saveTodoState();
    renderTodoPanel();
}

/** Close editor and keep current todo list unchanged. */
function closeTodoEditor(){
    todoState.editor={mode:'',id:'',title:'',description:'',status:'open'};
    saveTodoState();
    renderTodoPanel();
}

/** Submit create/edit operation and sync changes through todo message contracts. */
function submitTodoEditor(){
    const titleInput=document.getElementById('todo-title-input');
    const descInput=document.getElementById('todo-desc-input');
    const statusSelect=document.getElementById('todo-status-select');
    if(!titleInput||!descInput||!statusSelect){return;}

    const title=String(titleInput.value||'').trim();
    const description=String(descInput.value||'').trim();
    const status=String(statusSelect.value||'open');
    if(!title){
        var ti=document.getElementById('todo-title-input');
        if(ti){ti.style.outline='2px solid #ff3b30';ti.placeholder='标题不能为空';setTimeout(function(){ti.style.outline='';ti.placeholder='标题（必填）';},2000);}
        return;
    }

    if(todoState.editor.mode==='edit'&&todoState.editor.id){
        const nextTodos=todoState.todos.map((todo)=>todo.id===todoState.editor.id
            ? {...todo,title,description:description||null,status,updatedAt:new Date().toISOString()}
            : todo);
        todoState.todos=nextTodos;
        v.postMessage({
            type:'todo.update',
            id:todoState.editor.id,
            title,
            description:description||null,
            status,
        });
    }else{
        v.postMessage({
            type:'todo.create',
            sourcePanel:TODO_SOURCE_PANEL,
            title,
            description:description||null,
        });
    }
    closeTodoEditor();
}

/** Toggle item status between open and done from the list card action. */
function toggleTodoStatus(id,nextStatus){
    const todo=findTodoById(id);
    if(!todo){
        return;
    }
    todoState.todos=todoState.todos.map((item)=>item.id===id
        ? {...item,status:nextStatus,updatedAt:new Date().toISOString()}
        : item);
    saveTodoState();
    renderTodoPanel();
    v.postMessage({
        type:'todo.update',
        id,
        title:todo.title,
        description:todo.description,
        status:nextStatus,
    });
}

/** Delete item from current list and notify extension host for persistence. */
function deleteTodo(id){
    const todo=findTodoById(id);
    if(!todo){
        return;
    }
    todoState.todos=todoState.todos.filter((item)=>item.id!==id);
    saveTodoState();
    renderTodoPanel();
    v.postMessage({type:'todo.delete',id});
}

/** Promote a todo into a new iteration task and remove it from the todo list. */
function promoteTodoToTask(id){
    const todo=findTodoById(id);
    if(!todo){
        return;
    }
    todoState.todos=todoState.todos.filter((item)=>item.id!==id);
    saveTodoState();
    renderTodoPanel();
    v.postMessage({
        type:'todo.promoteToTask',
        todoId:id,
        promotionPolicy:'remove',
    });
}

/** Consume todo.changed events and refresh panel with authoritative host payload. */
function handleTodoChangedEvent(message){
    if(!message||!Array.isArray(message.todos)){
        todoState.loading=false;
        saveTodoState();
        renderTodoPanel();
        return;
    }
    todoState.todos=message.todos.map((todo)=>({
        id:String(todo.id||''),
        title:String(todo.title||''),
        description:todo.description==null?null:String(todo.description),
        status:todo.status==='done'||todo.status==='promoted'?todo.status:'open',
        createdAt:String(todo.createdAt||''),
        updatedAt:String(todo.updatedAt||''),
    }));
    todoState.loading=false;
    saveTodoState();
    renderTodoPanel();
}

/** Listen to extension pushed events so list can stay consistent without manual refresh. */
window.addEventListener('message',(event)=>{
    const message=event&&event.data?event.data:{};
    if(message.type==='todo.changed'){
        handleTodoChangedEvent(message);
    }
});

/** Delegated handler for dynamically rendered todo-item actions (avoids fragile inline onclick escaping). */
document.addEventListener('click',(event)=>{
    const origin=event.target;
    if(!origin||typeof origin.closest!=='function'){return;}
    const btn=origin.closest('[data-todo-action]');
    if(!btn){return;}
    const action=btn.getAttribute('data-todo-action');
    const id=btn.getAttribute('data-todo-id')||'';
    if(action==='toggle'){toggleTodoStatus(id,btn.getAttribute('data-todo-next')||'done');}
    else if(action==='edit'){openTodoEditEditor(id);}
    else if(action==='promote'){promoteTodoToTask(id);}
    else if(action==='delete'){deleteTodo(id);}
});

function p(x){v.postMessage({type:'page',page:x})}
function create(){
    const name=document.getElementById('name').value.trim();
    const desc=document.getElementById('desc').value.trim();
    if(!name){var ni=document.getElementById('name');if(ni){ni.style.outline='2px solid #ff3b30';ni.placeholder='请输入迭代名称（英文）';setTimeout(function(){ni.style.outline='';ni.placeholder='迭代名称（英文）';},2000);}return;}
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
function runCustomButton(id,buttonId){v.postMessage({type:'runCustomButton',id,buttonId})}
function runMainCustomButton(buttonId){v.postMessage({type:'runMainCustomButton',buttonId})}
function toggleAutoPoll(enable){v.postMessage({type:'toggleAutoPoll',enable})}
function setSubStatus(id,subId,status){v.postMessage({type:'setSubTaskStatus',id,subId,status})}
function logWebviewEvent(id,event,detail){
    try{v.postMessage({type:'logWebviewEvent',id,event,detail});}catch{}
}
function getTaskDescNodes(id){
    return {
        root:document.getElementById('task-desc-wrap-'+id),
        wrap:document.getElementById('task-desc-editor-wrap-'+id),
        editor:document.getElementById('task-desc-editor-'+id),
        desc:document.getElementById('task-desc-'+id),
    };
}
function setTaskDescEditing(id,editing){
    const nodes=getTaskDescNodes(id);
    if(nodes.root){nodes.root.classList.toggle('editing',editing);}
}
function autoGrowTaskDescEditor(id){
    const nodes=getTaskDescNodes(id);
    const editor=nodes.editor;
    if(!editor){return;}
    editor.style.height='auto';
    editor.style.height=Math.min(Math.max(editor.scrollHeight,108),260)+'px';
}
function openTaskDescEditor(id){
    const {root,editor,desc}=getTaskDescNodes(id);
    if(!root||!editor||!desc){logWebviewEvent(id,'taskDescEditor.open.missingNodes');return;}
    logWebviewEvent(id,'taskDescEditor.open');
    setTaskDescEditing(id,true);
    editor.value=desc.innerText;
    autoGrowTaskDescEditor(id);
    editor.focus();
    if(typeof editor.selectionStart==='number'){
        const len=editor.value.length;
        editor.selectionStart=len;
        editor.selectionEnd=len;
    }
}
function cancelTaskDescEditor(id){
    const {root,editor,desc}=getTaskDescNodes(id);
    if(!root||!editor||!desc){logWebviewEvent(id,'taskDescEditor.cancel.missingNodes');return;}
    logWebviewEvent(id,'taskDescEditor.cancel');
    setTaskDescEditing(id,false);
    editor.value=desc.innerText;
    autoGrowTaskDescEditor(id);
}
function commitTaskDescEditor(id){
    try{
        var nodes=getTaskDescNodes(id);
        var root=nodes.root;
        var editor=nodes.editor;
        var desc=nodes.desc;
        if(!editor||!desc){
            logWebviewEvent(id,'taskDescEditor.save.missingNodes');
            logWebviewEvent(id,'taskDescEditor.save.missingNodes.alert');
            return;
        }
        var nextDesc=String(editor.value||'').trim();
        logWebviewEvent(id,'taskDescEditor.save.click','len='+nextDesc.length);
        if(!nextDesc){
            if(editor){editor.style.outline='2px solid #ff3b30';setTimeout(function(){editor.style.outline='';},2000);}
            return;
        }
        desc.innerText=nextDesc;
        if(root){root.classList.remove('editing');}
        v.postMessage({type:'updateTaskDesc',id:id,desc:nextDesc});
        logWebviewEvent(id,'taskDescEditor.save.postMessage','len='+nextDesc.length);
    }catch(error){
        var message=error&&error.message?error.message:String(error);
        try{logWebviewEvent(id,'taskDescEditor.save.error',message);}catch{}
        logWebviewEvent(id,'taskDescEditor.save.error.alert',message);
    }
}
function resetTask(id){v.postMessage({type:'resetTask',id})}
function openArtifact(id,artifact){v.postMessage({type:'openArtifact',id,artifact})}
function openFolderLocation(id,location){v.postMessage({type:'openFolderLocation',id,location})}
function setTaskAutomation(id,aa,ar){v.postMessage({type:'setTaskAutomation',id,aa,ar})}
function setTaskAiProvider(id,ap){v.postMessage({type:'setTaskAiProvider',id,ap})}
function pushDev(id){v.postMessage({type:'pushAndNextStage',id})}

document.addEventListener('DOMContentLoaded',()=>{
    if(document.getElementById('workspace-todo-panel')){
        renderTodoPanel();
        v.postMessage({type:'todo.list'});
    }
    const taskItems=document.querySelectorAll('.task-item[data-task-id]');
    taskItems.forEach((item)=>{
        const id=item.getAttribute('data-task-id');
        if(id){logWebviewEvent(id,'taskDescEditor.boot','dom-ready');}
    });
});
window.addEventListener('error',(event)=>{
    try{v.postMessage({type:'logWebviewEvent',id:'__global__',event:'webview.error',detail:String(event.message||'unknown')});}catch{}
});
window.addEventListener('unhandledrejection',(event)=>{
    try{v.postMessage({type:'logWebviewEvent',id:'__global__',event:'webview.unhandledrejection',detail:String(event.reason||'unknown')});}catch{}
});
</script>
</body>
</html>`;
}

export function buildSettingsPageHtml(
    config: Config,
    configMeta: HarnessConfigMeta,
    scriptInventory: ScriptInventory,
): string {
    const readOnly = configMeta.readOnly === true;
    const disabled = readOnly ? 'disabled' : '';
    const inv = scriptInventory;
    const isWin = process.platform === 'win32';
    const osLabel = isWin ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : 'Linux');
    const scriptExtHint = isWin ? '.ps1 / .bat / .cmd / .js' : '.sh / .bash / .js';
    const scriptsSubdir = inv.scriptsSubdir;
    const initialButtons = (config.customButtons || []).map(normalizeCustomButton).map(b => ({
        name: b.name,
        scriptSource: b.scriptSource,
        script: b.script,
        args: b.args,
        placement: b.placement,
    }));
    const monorepoGitValue = config.monorepoGit || '';
    // Initial active Git-mode tab: monorepo when a single-repo URL is configured;
    // multi-repo only when the user has front/back URLs but no monorepo URL.
    const initialGitMode = config.monorepoGit
        ? 'mono'
        : (config.frontendGit || config.backendGit ? 'multi' : 'mono');
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
.git-tabs{display:flex;gap:6px;margin-bottom:10px}
.git-tab{flex:1;padding:8px;border-radius:8px;border:1px solid #3a3a3f;background:#222;color:#bbb;font-size:13px;margin:0}
.git-tab.active{background:#0a2a4a;border-color:#007aff;color:#fff}
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
.custom-prompt-actions{display:flex;gap:6px;flex-wrap:nowrap;align-items:stretch}
.custom-prompt-more{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.custom-prompt-btn{flex:1 1 0;min-width:0;height:28px;padding:0 8px;border-radius:8px;border:none;font-size:10px;line-height:1;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}
.custom-prompt-more-toggle{flex:0 0 28px;width:28px;height:28px;padding:0;border-radius:999px;border:none;color:#fff;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}
.fold{margin-top:10px;background:#1a1a1e;border:1px solid #323238;border-radius:8px;padding:8px}
.fold>summary{cursor:pointer;color:#d3d3d8;font-size:13px;list-style:none}
.fold>summary::-webkit-details-marker{display:none}
.fold[open]>summary{margin-bottom:8px;color:#fff}
.cb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.cb-row input,.cb-row select{margin:0;min-width:0;box-sizing:border-box}
.cb-name{flex:1 1 120px}
.cb-place{flex:1 1 100px}
.cb-src{flex:1 1 110px}
.cb-cmd{flex:2 1 150px}
.cb-args{flex:1 1 110px}
.cb-del{width:auto;flex:0 0 auto;margin:0;padding:10px 14px;background:#ff3b30}
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
<div class="git-tabs">
<button type="button" class="git-tab" id="gitTabMono" onclick="switchGitMode('mono')" ${disabled}>单一仓库 (Monorepo)</button>
<button type="button" class="git-tab" id="gitTabMulti" onclick="switchGitMode('multi')" ${disabled}>多仓库 (前后端分离)</button>
</div>

<div id="gitPaneMono" class="git-pane">
<h5>单一仓库（Monorepo）Git 地址</h5>
<input id="mg" value="${monorepoGitValue}" placeholder="代码、文档、脚本位于同一仓库" ${disabled}>
<div style="font-size:12px;opacity:0.7;margin:4px 0 8px">该模式下，funharness 会将仓库克隆到 <b>repos/mono-main</b> 作为主仓库，并在主仓库与每个迭代 worktree 中按需补齐目录骨架（默认：<b>apps/</b> 代码、<b>docs/</b> 文档、<b>scripts/</b> 项目脚本）。迭代任务以 git worktree 形式生成在 <b>worktrees/&lt;task&gt;/</b>（根即迭代目录）。你可继续在 apps/ 下组织前后端，也可按项目规范调整。若填写了基线分支但远程不存在，系统会在本地主仓库自动创建该分支。</div>
</div>

<div id="gitPaneMulti" class="git-pane">
<h5>前端 Git 地址（可选）</h5>
<input id="fg" value="${config.frontendGit || ''}" ${disabled}>
<h5>后端 Git 地址（可选）</h5>
<input id="bg" value="${config.backendGit || ''}" ${disabled}>
</div>

<h5>基线分支（如 main、master 或 yourname/integration）</h5>
<input id="bb" value="${config.baseBranch || ''}" placeholder="如 main 或 yourname/integration" ${disabled}>
<div class="toggle-row">
<span>合并前 dry-run 冲突检查</span>
<input id="dr" type="checkbox" ${config.mergeDryRunEnabled ? 'checked' : ''} ${disabled}>
</div>
<button onclick="saveGit()" style="background:#007aff" ${disabled}>💾 保存 Git 配置并初始化代码</button>
</div>

<div class="section">

<details class="fold" open>
<summary>⚙ 高级策略配置</summary>
<h5>项目自定义约定（多行，完全自定义）</h5>
<textarea id="pc" rows="6" placeholder="例如：\n1. 前端入口开关必须由后端配置中心下发\n2. 功能入口统一展示在“更多”页\n3. 跳转链接由后端返回并经过白名单校验" ${disabled}>${config.projectConventions || ''}</textarea>
<h5>最大自动执行并发槽位</h5>
<input id="mc" type="number" min="1" value="${config.maxConcurrentAutoTasks || 2}" ${disabled}>
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
<button onclick="saveAdvancedConfig()" style="background:#007aff" ${disabled}>💾 保存高级策略</button>
</details>
</div>

<div class="section">
<div class="section-title">自定义按钮</div>
<div class="hint">为每个按钮选择<b>脚本来源</b>、<b>显示位置</b>和一个<b>脚本</b>；插件会按当前操作系统（${osLabel}，脚本类型：${scriptExtHint}）自动拼接执行命令。已被其它按钮占用的脚本不会重复出现在下拉框中。</div>
<div class="hint">脚本来源：<b>主目录(不提交)</b> = <code>script/</code>（随主工作区，不进 git）；<b>迭代脚本</b> = 当前迭代 worktree 中已提交的 <code>${escapeHtml(scriptsSubdir)}/</code>（点哪个任务就用哪个 worktree 的脚本；主面板按钮会回退到主克隆的同名目录）。</div>
<div class="hint">显示位置：<b>子面板（迭代）</b>显示在每个迭代任务卡片上，终端 cd 到该任务 worktree 迭代目录再运行脚本；<b>主面板</b>显示在主面板顶部独立区域，终端 cd 到主工作区根目录再运行脚本。脚本内部可自行 cd 到具体子目录（如 frontend/backend）。</div>
<div class="kv">主目录脚本：<b>${escapeHtml(inv.dirs.master)}</b></div>
${inv.dirs.repoMono ? `<div class="kv">迭代脚本(候选，来自主克隆)：<b>${escapeHtml(inv.dirs.repoMono)}</b></div>` : ''}
${inv.dirs.repoFrontend ? `<div class="kv">前端迭代脚本(候选)：<b>${escapeHtml(inv.dirs.repoFrontend)}</b></div>` : ''}
${inv.dirs.repoBackend ? `<div class="kv">后端迭代脚本(候选)：<b>${escapeHtml(inv.dirs.repoBackend)}</b></div>` : ''}
<div class="inline-actions" style="margin-top:8px">
<button onclick="openScriptDir()" style="background:#6d6d72" ${disabled}>📂 打开主目录 script/</button>
<button onclick="openHarnessLog()" style="background:#6d6d72" ${disabled}>📋 打开日志</button>
<button onclick="p('settings')" style="background:#8e8e93">🔄 刷新脚本列表</button>
</div>
<div id="cbEmpty" class="cb-empty" style="display:none">未发现可用脚本。请在上面任一脚本目录中创建 ${scriptExtHint} 脚本，然后点「🔄 刷新脚本列表」。</div>
<div id="cbList"></div>
<div class="inline-actions">
<button onclick="addCustomButton()" style="background:#3a3a3f" ${disabled}>➕ 添加按钮</button>
<button onclick="saveCustomButtons()" style="background:#007aff" ${disabled}>💾 保存自定义按钮</button>
</div>
</div>

<div class="section">
<div class="section-title">自动轮询远程任务</div>
<div class="toggle-row">
<span>启用自动轮询远程任务</span>
<input id="ap_enabled" type="checkbox" ${config.autoPollEnabled ? 'checked' : ''} ${disabled} onchange="toggleAutoPollDetails()">
</div>
<div class="hint">开启后，到任意 worktree 的<b>子面板</b>即可启动自动轮询（同一时间只能开启一个 worktree）。脚本固定放在主目录的 <b>script/</b> 下，约定把拉取到的任务清单<b>打印到 stdout</b>；插件读取后仅当内容非空且与现有 todo.md 不同才覆盖当前 worktree 的 <b>todo.md</b>。</div>
<div id="ap_details" style="display:${config.autoPollEnabled ? 'block' : 'none'}">
<h5>轮询间隔（秒，最小 5）</h5>
<input id="ap_int" type="number" min="5" value="${config.autoPollIntervalSec || 60}" ${disabled}>
<h5>拉取脚本文件名（位于 script/ 下，推荐 Node 脚本 pullTask.js）</h5>
<input id="ap_script" value="${escapeHtml(config.autoPollScript || 'pullTask.js')}" placeholder="pullTask.js" ${disabled}>
<div class="kv" style="margin:6px 0">脚本状态：<b>${inv.master.includes(config.autoPollScript || 'pullTask.js') ? '✅ 已存在' : '⚠ 未找到，请点「创建/打开脚本」'}</b></div>
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
</div>

<div class="section">
<div class="section-title">自定义 Prompt</div>
<div class="hint">点击即可打开对应的 custom prompt 文档。</div>
<div class="custom-prompt-actions">
<button class="custom-prompt-btn" onclick="openCustomPrompt('req')" style="background:#007aff" ${disabled}>需求</button>
<button class="custom-prompt-btn" onclick="openCustomPrompt('des')" style="background:#007aff" ${disabled}>设计</button>
<button class="custom-prompt-btn" onclick="openCustomPrompt('dev')" style="background:#007aff" ${disabled}>开发</button>
<button class="custom-prompt-more-toggle" id="customPromptMoreToggle" onclick="toggleCustomPromptMore()" style="background:#444" aria-label="更多 custom prompt" title="更多" ${disabled}>⋯</button>
</div>
<div class="custom-prompt-more" id="customPromptMore" style="display:none">
<button class="custom-prompt-btn" onclick="openCustomPrompt('tcs')" style="background:#007aff" ${disabled}>测试用例</button>
<button class="custom-prompt-btn" onclick="openCustomPrompt('tsk')" style="background:#007aff" ${disabled}>任务拆解</button>
</div>
</div>

<script>
const v=acquireVsCodeApi();
function p(x){v.postMessage({type:'page',page:x})}
function openCustomPrompt(step){v.postMessage({type:'openCustomPrompt',step})}
function toggleCustomPromptMore(){
    const more=document.getElementById('customPromptMore');
    const toggle=document.getElementById('customPromptMoreToggle');
    if(!more||!toggle)return;
    const open=more.style.display==='none';
    more.style.display=open?'flex':'none';
    toggle.textContent=open?'收起':'更多';
}
function saveGit(){v.postMessage({type:'saveGit',mode:gitMode,fg:document.getElementById('fg').value,bg:document.getElementById('bg').value,bb:document.getElementById('bb').value,dr:document.getElementById('dr').checked,mg:document.getElementById('mg').value,md:{frontend:'apps',backend:'apps',docs:'docs',scripts:'scripts'}})}
let gitMode='${initialGitMode}';
function switchGitMode(m){
    gitMode=m;
    var mono=document.getElementById('gitPaneMono');
    var multi=document.getElementById('gitPaneMulti');
    if(mono)mono.style.display=m==='mono'?'block':'none';
    if(multi)multi.style.display=m==='multi'?'block':'none';
    var tm=document.getElementById('gitTabMono');
    var tx=document.getElementById('gitTabMulti');
    if(tm)tm.classList.toggle('active',m==='mono');
    if(tx)tx.classList.toggle('active',m==='multi');
}
switchGitMode(gitMode);
function saveAdvancedConfig(){v.postMessage({type:'saveAdvancedConfig',pc:document.getElementById('pc').value,mc:parseInt(document.getElementById('mc').value)||2,am:document.getElementById('am').checked,cm:document.getElementById('cm').checked,ad:document.getElementById('ad').checked,sk:document.getElementById('sk').value,ck:document.getElementById('ck').value,wsd:document.getElementById('wsd').value,cps:document.getElementById('cps').value,prm:document.getElementById('prm').value,cct:document.getElementById('cct').value,afm:document.getElementById('afm').checked,pas:document.getElementById('pas').checked})}
function initProjectStructure(){v.postMessage({type:'initProjectStructure'})}
function applyProjectStructurePreview(){v.postMessage({type:'applyProjectStructurePreview'})}
function openArtifactsIndex(){v.postMessage({type:'openArtifactsIndex'})}
function testAiProvider(){v.postMessage({type:'testAiProvider'})}
function saveAutoPollConfig(){v.postMessage({type:'saveAutoPollConfig',enabled:document.getElementById('ap_enabled').checked,interval:parseInt(document.getElementById('ap_int').value)||60,script:document.getElementById('ap_script').value.trim(),prompt:document.getElementById('ap_prompt').value,skipMarkers:document.getElementById('ap_skip').value})}
function toggleAutoPollDetails(){const d=document.getElementById('ap_details');if(d)d.style.display=document.getElementById('ap_enabled').checked?'block':'none'}
function createPollScriptTemplate(){v.postMessage({type:'createPollScriptTemplate'})}
const INV=${JSON.stringify(inv).replace(/</g, '\\u003c')};
const INIT_BTNS=${JSON.stringify(initialButtons).replace(/</g, '\\u003c')};
const CB_READONLY=${readOnly ? 'true' : 'false'};
function cbEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function cbListFor(source){
  if(source==='master')return INV.master||[];
  if(INV.mode==='mono')return INV.repoMono||[];
  var combined=(INV.repoFrontend||[]).concat(INV.repoBackend||[]);
  var seen={};return combined.filter(function(f){if(seen[f])return false;seen[f]=true;return true;});
}
function cbSlot(source,script){return source+'::'+script;}
function cbAllScriptCount(){return (INV.master||[]).length+(INV.repoMono||[]).length+(INV.repoFrontend||[]).length+(INV.repoBackend||[]).length;}
function cbSourceOptions(selected){
  var arr=[['master','主目录(不提交)'],['worktree','迭代脚本(worktree)']];
  var opts='';
  arr.forEach(function(p){opts+='<option value="'+p[0]+'"'+(p[0]===selected?' selected':'')+'>'+p[1]+'</option>';});
  return opts;
}
function cbPlacementOptions(selected){
  var place=selected==='main'?'main':'iteration';
  return '<option value="iteration"'+(place==='iteration'?' selected':'')+'>子面板（迭代）</option>'+
    '<option value="main"'+(place==='main'?' selected':'')+'>主面板</option>';
}
function cbRowHtml(b){
  b=b||{};
  var dis=CB_READONLY?' disabled':'';
  return '<div class="cb-row">'+
    '<input class="cb-name" placeholder="按钮名称（如 部署）" value="'+cbEsc(b.name||'')+'"'+dis+'>'+
    '<select class="cb-place" title="显示位置"'+dis+'>'+cbPlacementOptions(b.placement||'iteration')+'</select>'+
    '<select class="cb-src" title="脚本来源" onchange="cbOnSourceChange(this)"'+dis+'>'+cbSourceOptions(b.scriptSource||'master')+'</select>'+
    '<select class="cb-cmd" title="脚本" data-val="'+cbEsc(b.script||'')+'" onchange="cbOnScriptChange(this)"'+dis+'></select>'+
    '<input class="cb-args" placeholder="参数(可选)" value="'+cbEsc(b.args||'')+'"'+dis+'>'+
    '<button class="cb-del" onclick="removeCustomButton(this)"'+dis+'>✕</button>'+
    '</div>';
}
function cbOnScriptChange(el){el.setAttribute('data-val',el.value);cbRefreshScripts();}
function cbOnSourceChange(el){var cmd=el.closest('.cb-row').querySelector('.cb-cmd');cmd.setAttribute('data-val','');cbRefreshScripts();}
// Rebuild every row's script dropdown from the inventory for its source, hiding any
// script already bound by ANOTHER row (same source), and preserving a now-missing
// selection with a （缺失) marker so buttons aren't silently re-pointed.
function cbRefreshScripts(){
  var rows=[].slice.call(document.querySelectorAll('#cbList .cb-row'));
  var used={};
  rows.forEach(function(r){
    var src=r.querySelector('.cb-src').value;
    var cur=r.querySelector('.cb-cmd').getAttribute('data-val')||'';
    if(cur){var k=cbSlot(src,cur);used[k]=(used[k]||0)+1;}
  });
  rows.forEach(function(r){
    var src=r.querySelector('.cb-src').value;
    var cmd=r.querySelector('.cb-cmd');
    var cur=cmd.getAttribute('data-val')||'';
    var avail=cbListFor(src);
    var opts='<option value="">（选择脚本）</option>';
    var matched=false;
    avail.forEach(function(f){
      var isCur=(f===cur);
      if(!isCur){var k=cbSlot(src,f);if(used[k])return;}
      if(isCur)matched=true;
      opts+='<option value="'+cbEsc(f)+'"'+(isCur?' selected':'')+'>'+cbEsc(f)+'</option>';
    });
    if(cur&&!matched){opts+='<option value="'+cbEsc(cur)+'" selected>'+cbEsc(cur)+'（缺失）</option>';}
    cmd.innerHTML=opts;
    cmd.value=cur;
    cmd.setAttribute('data-val',cmd.value);
  });
}
function cbUpdateEmpty(){var e=document.getElementById('cbEmpty');if(e)e.style.display=cbAllScriptCount()===0?'block':'none';}
function cbRenderAll(){
  var list=document.getElementById('cbList');
  if(!list)return;
  list.innerHTML='';
  (INIT_BTNS||[]).forEach(function(b){list.insertAdjacentHTML('beforeend',cbRowHtml(b));});
  cbRefreshScripts();
  cbUpdateEmpty();
}
function addCustomButton(){
  if(cbAllScriptCount()===0){var em=document.getElementById('cbEmpty');if(em){em.style.display='block';}return;}
  document.getElementById('cbList').insertAdjacentHTML('beforeend',cbRowHtml({}));
  cbRefreshScripts();
}
function removeCustomButton(btn){var r=btn.closest('.cb-row');if(r)r.remove();cbRefreshScripts();}
function openScriptDir(){v.postMessage({type:'openScriptDir'});}
function openHarnessLog(){v.postMessage({type:'openHarnessLog'});}
function saveCustomButtons(){
  var rows=document.querySelectorAll('#cbList .cb-row');
  var buttons=[];
  rows.forEach(function(r){
    var name=r.querySelector('.cb-name').value.trim();
    var scriptSource=r.querySelector('.cb-src').value;
    var script=r.querySelector('.cb-cmd').value.trim();
    var args=r.querySelector('.cb-args').value.trim();
    var placeEl=r.querySelector('.cb-place');
    var placement=(placeEl&&placeEl.value==='main')?'main':'iteration';
    if(name&&script){buttons.push({name:name,scriptSource:scriptSource,script:script,args:args,placement:placement});}
  });
  v.postMessage({type:'saveCustomButtons',buttons:buttons});
}
cbRenderAll();
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
