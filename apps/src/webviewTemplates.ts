import { Config, CustomButton, ScriptInventory, STAGE, STAGE_LABEL, SubFeature, Feature, FeatureStats, FeatureChangeRequestState, AI_PROVIDERS, DEFAULT_AUTO_POLL_PROMPT, DEFAULT_AUTO_POLL_SKIP_MARKERS, DEFAULT_POLL_SCRIPT, DEFAULT_AUTO_POLL_IDLE_WEEKDAY_START, DEFAULT_AUTO_POLL_IDLE_WEEKDAY_END, normalizeCustomButton } from './models';
import { HarnessConfigMeta } from './services/featureStoreService';
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

/** Badge showing last Spec Delta review status for a task. */
function buildDeltaBadgeHtml(taskId: string, status: MainFeatureViewModel['specDeltaStatus']): string {
    if (status == null) {
        return `<span class="delta-badge delta-none" onclick="specReview('${taskId}')" title="尚未评审，点击执行">Spec Δ 未评审</span>`;
    }
    const cls = status.gateBlocked || status.severity === 'high' ? 'delta-block' : status.severity === 'medium' ? 'delta-warn' : 'delta-pass';
    const label = status.gateBlocked ? '⛔ 阻断' : status.severity === 'high' ? '⚠ 高风险' : status.severity === 'medium' ? '⚡ 告警' : '✓ 通过';
    const tip = escapeHtml(`${status.summary} | ${status.at.slice(0, 16).replace('T', ' ')}`);
    return `<span class="delta-badge ${cls}" onclick="specReview('${taskId}')" title="${tip}">${label}</span>`;
}

function mapChangeRequestStateToTag(state: string): { text: string; cls: string } {
    switch (state) {
        case 'merged':
            return { text: '已合并', cls: 'cr-state--merged' };
        case 'merge-queued':
            return { text: '自动合并排队中', cls: 'cr-state--queued' };
        case 'open':
            return { text: '已创建', cls: 'cr-state--open' };
        case 'closed':
            return { text: '已关闭', cls: 'cr-state--closed' };
        case 'failed':
            return { text: '失败', cls: 'cr-state--failed' };
        case 'unsupported':
            return { text: '平台暂不支持', cls: 'cr-state--unsupported' };
        default:
            return { text: state || '未知', cls: 'cr-state--unknown' };
    }
}

function buildChangeRequestStatusHtml(task: Feature, tokenAutoMergeEnabled: boolean): string {
    const entries: FeatureChangeRequestState[] = Object.values(task.changeRequests || {} as Record<string, FeatureChangeRequestState>);
    if (entries.length === 0) {
        return '';
    }

    const rows = entries.map((entry) => {
        const state = mapChangeRequestStateToTag(String(entry?.state || ''));
        const remoteName = escapeHtml(String(entry?.remoteName || entry?.endpointKey || '-'));
        const platform = escapeHtml(String(entry?.platform || 'generic'));
        const number = typeof entry?.number === 'number' ? `#${entry.number}` : '';
        const link = entry?.url
            ? `<a class="cr-link" href="${escapeHtml(String(entry.url))}" target="_blank" rel="noopener">打开${platform.toUpperCase()} ${number || 'PR/MR'}</a>`
            : `<span class="cr-link cr-link--muted">暂无链接</span>`;
        const err = entry?.lastError ? `<div class="cr-error">${escapeHtml(String(entry.lastError))}</div>` : '';
        const updatedAt = entry?.updatedAt ? escapeHtml(String(entry.updatedAt).replace('T', ' ').slice(0, 19)) : '-';
        return `<div class="cr-row">
<div class="cr-main">
<span class="cr-remote">${remoteName}</span>
<span class="cr-platform">${platform}</span>
<span class="cr-state ${state.cls}">${state.text}</span>
</div>
<div class="cr-meta">${link}<span class="cr-time">更新: ${updatedAt}</span></div>
${err}
</div>`;
    }).join('');

    const autoMergeLabel = tokenAutoMergeEnabled ? '开' : '关';
    return `<details class="cr-panel">
<summary><span class="cr-summary-main">🔀 远程 PR/MR 状态（${entries.length}）</span><span class="cr-summary-hint">自动合并：${autoMergeLabel}</span></summary>
<div class="cr-list">${rows}</div>
</details>`;
}

/** Collapsible cross-task Spec Delta domain overview panel (main panel only). */
/** Worktree-subview card for the exclusive remote-task auto-poller. */
function buildAutoPollPanelHtml(status: AutoPollStatus): string {
    const intervalLabel = `${status.intervalSec}s`;
    const dispatchLine = '<div class="autopoll-hint">🤖 拉取到新内容后会自动把任务派发给当前迭代任务的 AI 执行器（拉取并执行）。</div>';
    const idleGatedLine = status.idleGated
        ? '<div class="autopoll-hint">⏸ 当前不在闲时窗口内，本轮轮询已跳过（仅闲时生效已开启）。</div>'
        : '';
    if (status.enabledHere) {
        return `<div class="autopoll-card on">
<div class="autopoll-title">🟢 自动轮询远程任务并执行：运行中</div>
<div class="autopoll-hint">每 ${intervalLabel} 运行 <b>${escapeHtml(status.script)}</b>，拉取到的新内容写入当前 worktree 的 <b>todo.md</b>（内容为空或无变化时不覆盖）。</div>
${dispatchLine}
${idleGatedLine}
<button class="action-btn action-btn--warning" onclick="toggleAutoPoll(false)">⏸ 关闭自动轮询</button>
</div>`;
    }

    const elsewhereNote = status.activeElsewhereName
        ? `<div class="autopoll-warn">「${escapeHtml(status.activeElsewhereName)}」worktree 已开启自动轮询，请移步该 worktree，或先在那里关闭后再开启。</div>`
        : '';
    const scriptNote = status.scriptExists
        ? ''
        : `<div class="autopoll-warn">未找到拉取脚本 <b>scripts/${escapeHtml(status.script)}</b>，请先在主工作区「高级设置 → 自动轮询」中创建脚本。</div>`;
    return `<div class="autopoll-card">
<div class="autopoll-title">⚪ 自动轮询远程任务并执行：未开启</div>
<div class="autopoll-hint">开启后，本 worktree 每 ${intervalLabel} 运行 <b>${escapeHtml(status.script)}</b>，将拉取到的新内容写入 <b>todo.md</b>，并自动派发给当前迭代任务的 AI 执行器执行。同一时间只能有一个 worktree 开启。</div>
${elsewhereNote}
${scriptNote}
<button class="action-btn action-btn--success" onclick="toggleAutoPoll(true)">▶ 开启自动轮询远程任务并执行</button>
</div>`;
}



export interface MainFeatureViewModel {
    task: Feature;
    stats: FeatureStats;
    pct: number;
    subTasks: SubFeature[];
    latestFailureReason?: string;
    taskOutputPathWarnings?: string[];
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
    specDeltaStatus?: {
        severity: 'low' | 'medium' | 'high';
        gateBlocked: boolean;
        at: string;
        summary: string;
        digestPath: string;
    } | null;
}

export interface RemoteApiTokenStatusView {
    endpointKey: string;
    remoteName: string;
    remoteUrl: string;
    domain: string;
    boundRemotes: string[];
    platform: 'github' | 'gitlab' | 'generic';
    configured: boolean;
}

type PanelMode = 'main' | 'worktree';
type ActionPlacement = 'primary' | 'side' | 'header';

interface FeatureActionContext {
    panelMode: PanelMode;
    isWorktreeSubview: boolean;
    taskView: MainFeatureViewModel;
    task: Feature;
    allSubTasksDone: boolean;
    hasWorktree: boolean;
}

interface FeatureActionConfig {
    key: string;
    placement: ActionPlacement;
    panels: PanelMode[];
    stages: Feature['stage'][] | 'all';
    when?: (ctx: FeatureActionContext) => boolean;
    render: (ctx: FeatureActionContext) => string;
}

function renderPreviousStageButton(taskId: string, step: 'des' | 'tcs' | 'tsk' | 'dev', title: string): string {
    return `<button class="action-btn action-btn--previous" onclick="previousStage('${step}','${taskId}')" title="${title}" aria-label="${title}">&lt; 上一步</button>`;
}

const FEATURE_ACTION_CONFIGS: FeatureActionConfig[] = [
    {
        key: 'req-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="runAgent('req','${ctx.task.id}')">🤖 运行需求 Agent</button>`,
    },
    {
        key: 'req-review',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="triggerStageReview('${ctx.task.id}','requirements')">⚖️ AI 评审</button>`,
    },
    {
        key: 'req-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="action-btn action-btn--primary" onclick="next('req','${ctx.task.id}')">✅ 确认需求并进入设计</button>`,
    },
    {
        key: 'req-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_REQUIREMENT],
        render: () => '',
    },
    {
        key: 'des-previous',
        placement: 'header',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => renderPreviousStageButton(ctx.task.id, 'des', '返回需求阶段'),
    },
    {
        key: 'des-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="runAgent('des','${ctx.task.id}')">🤖 运行设计 Agent</button>`,
    },
    {
        key: 'des-review',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="triggerStageReview('${ctx.task.id}','design')">⚖️ AI 评审</button>`,
    },
    {
        key: 'des-confirm-tcs',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="action-btn action-btn--primary" onclick="next('des','${ctx.task.id}','tcs')">✅ 确认并进入 Testcase</button>`,
    },
    {
        key: 'des-skip-tsk',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="action-btn action-btn--primary" onclick="next('des','${ctx.task.id}','tsk')">✅ 确认并直接进入任务</button>`,
    },
    {
        key: 'des-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_DESIGN],
        render: () => '',
    },
    {
        key: 'tcs-previous',
        placement: 'header',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE],
        render: (ctx) => renderPreviousStageButton(ctx.task.id, 'tcs', '返回设计阶段'),
    },
    {
        key: 'tcs-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="runAgent('tcs','${ctx.task.id}')">🤖 运行测试用例 Agent</button>`,
    },
    {
        key: 'tcs-review',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="triggerStageReview('${ctx.task.id}','testcase')">⚖️ AI 评审</button>`,
    },
    {
        key: 'tcs-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="action-btn action-btn--primary" onclick="next('tcs','${ctx.task.id}')">✅ 确认测试用例</button>`,
    },
    {
        key: 'tcs-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE, STAGE.WRITING_TASKS, STAGE.DEVELOPING],
        render: () => '',
    },
    {
        key: 'test-script-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TESTCASE, STAGE.DEVELOPING],
        render: () => '',
    },
    {
        key: 'tsk-previous',
        placement: 'header',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS],
        render: (ctx) => renderPreviousStageButton(ctx.task.id, 'tsk', '返回测试用例阶段'),
    },
    {
        key: 'tsk-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="runAgent('tsk','${ctx.task.id}')">🤖 运行任务 Agent</button>`,
    },
    {
        key: 'tsk-review',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="triggerStageReview('${ctx.task.id}','tasks')">⚖️ AI 评审</button>`,
    },
    {
        key: 'tsk-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="action-btn action-btn--primary" onclick="next('tsk','${ctx.task.id}')">✅ 确认任务拆解</button>`,
    },
    {
        key: 'tasks-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [STAGE.WRITING_TASKS, STAGE.DEVELOPING, STAGE.READY_FOR_REVIEW],
        render: () => '',
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
            ? `<button class="action-btn action-btn--warning" onclick="pauseAuto('${ctx.task.id}')">⏸ 暂停</button>`
            : `<button class="action-btn action-btn--success" onclick="startAuto('${ctx.task.id}')">▶ 自动执行</button>`,
    },
    {
        key: 'dev-next',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        when: (ctx) => !ctx.allSubTasksDone && !ctx.task.quickMode,
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="nextFeature('${ctx.task.id}')">⏭ 下一个</button>`,
    },
    {
        key: 'dev-run-quick',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        when: (ctx) => Boolean(ctx.task.quickMode),
        render: (ctx) => `<button class="action-btn action-btn--success" onclick="runAgent('dev','${ctx.task.id}')">🤖 运行开发 Agent</button>`,
    },
    {
        key: 'dev-push-primary',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        render: (ctx) => `<button class="action-btn action-btn--primary" onclick="pass('${ctx.task.id}')">✅ 完成</button>`,
    },
    {
        key: 'dev-rollback-to-task-split',
        placement: 'header',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        render: (ctx) => `<button class="action-btn action-btn--subtle-danger" onclick="rollbackDev('${ctx.task.id}')">回滚</button>`,
    },
    {
        key: 'review-spec',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.READY_FOR_REVIEW],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="specReview('${ctx.task.id}')">🧭 Spec 评审报告</button>`,
    },
    {
        key: 'review-pass',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.READY_FOR_REVIEW],
        render: (ctx) => `<button class="action-btn action-btn--success" onclick="pass('${ctx.task.id}')">✅ 完成（检查远程已合并）</button>`,
    },
    {
        key: 'spec-review',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [STAGE.DEVELOPING],
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="specReview('${ctx.task.id}')">🧭 Spec 评审</button>`,
    },
    {
        key: 'sync-code',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="syncMainCode('${ctx.task.id}')">🔄 拉取</button>`,
    },
    {
        key: 'commit-to-baseline',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="commitToBaseline('${ctx.task.id}')">📤 提交PR/MR</button>`,
    },
    {
        key: 'refresh-change-requests',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="refreshChangeRequests('${ctx.task.id}')">🔁 刷新PR/MR</button>`,
    },
    {
        key: 'sync-codegraph',
        placement: 'side',
        panels: ['worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="action-btn action-btn--neutral" onclick="syncCodeGraph('${ctx.task.id}')">🧩 图谱同步</button>`,
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
        render: (ctx) => `<button class="action-btn action-btn--danger" onclick="resetFeature('${ctx.task.id}')">♻ 重置</button>`,
    },
];

function collectTaskActions(ctx: FeatureActionContext): { primaryActions: string[]; sideActions: string[]; headerActions: string[] } {
    const primaryActions: string[] = [];
    const sideActions: string[] = [];
    const headerActions: string[] = [];

    for (const action of FEATURE_ACTION_CONFIGS) {
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
        } else if (action.placement === 'header') {
            headerActions.push(rendered);
        } else {
            sideActions.push(rendered);
        }
    }

    return { primaryActions, sideActions, headerActions };
}

function sanitizeTaskPromptDomId(taskId: string): string {
    return String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildTaskPromptActionsHtml(taskId: string): string {
    const domId = sanitizeTaskPromptDomId(taskId);
    const moreId = `taskPromptMore-${domId}`;
    const toggleId = `taskPromptMoreToggle-${domId}`;

    return `
<div class="task-prompt-section">
    <div class="action-label">自定义 Prompt</div>
    <div class="task-prompt-actions">
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openCustomPrompt('req')">需求</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openCustomPrompt('des')">设计</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openCustomPrompt('dev')">开发</button>
        <button class="action-btn action-btn--neutral task-prompt-more-toggle" id="${toggleId}" onclick="toggleTaskPromptMore('${domId}')" aria-label="更多自定义 Prompt" title="更多">更多</button>
    </div>
    <div class="task-prompt-more" id="${moreId}" style="display:none">
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openCustomPrompt('tcs')">测试用例</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openCustomPrompt('tsk')">任务拆解</button>
        <button class="action-btn action-btn--success task-prompt-btn" onclick="openCustomConstitution()">Constitution</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openReviewCustomPrompt('requirements')">需求评审</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openReviewCustomPrompt('design')">设计评审</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openReviewCustomPrompt('testcase')">测试用例评审</button>
        <button class="action-btn action-btn--neutral task-prompt-btn" onclick="openReviewCustomPrompt('tasks')">任务评审</button>
    </div>
</div>`;
}

function buildTaskSideActionsHtml(taskId: string, sideActions: string[]): string {
    if (sideActions.length <= 0) {
        return '';
    }
    const isResetAction = (action: string) => action.includes("resetFeature('");
    const normalActions = sideActions.filter(action => !isResetAction(action));
    const resetActions = sideActions.filter(action => isResetAction(action));
    const orderedActions = [...normalActions, ...resetActions];
    return `<div class="action-label">旁路操作</div><div class="action-group">${orderedActions.join('')}</div>`;
}

function buildIterationArtifactsHtml(taskId: string): string {
    const domId = sanitizeTaskPromptDomId(taskId);
    const artifactActions = [
        `<button class="action-btn action-btn--neutral" onclick="openArtifact('${taskId}','requirements')">📄 需求文档</button>`,
        `<button class="action-btn action-btn--neutral" onclick="openArtifact('${taskId}','design')">📄 设计文档</button>`,
        `<button class="action-btn action-btn--neutral" onclick="openArtifact('${taskId}','tasks')">📋 任务文档</button>`,
        `<button class="action-btn action-btn--neutral" onclick="openArtifact('${taskId}','testcase')">🧪 测试用例文档</button>`,
        `<button class="action-btn action-btn--neutral" onclick="openArtifact('${taskId}','testScript')">🧪 测试脚本</button>`,
    ];
    const primaryActions = artifactActions.slice(0, 3).join('');
    const moreActions = artifactActions.slice(3).join('');
    return `<div class="iteration-artifact-section"><div class="action-label">迭代产物区</div><div class="action-group">${primaryActions}<button class="action-btn action-btn--neutral action-more-toggle" id="iterationArtifactsMoreToggle-${domId}" onclick="toggleIterationArtifactsMore('${domId}')" aria-label="更多迭代产物" title="更多">更多</button></div><div class="action-group" id="iterationArtifactsMore-${domId}" style="display:none">${moreActions}</div></div>`;
}

function buildTaskCustomButtonsHtml(taskId: string, customButtonActions: string[]): string {
    if (customButtonActions.length <= 0) {
        return '';
    }
    const domId = sanitizeTaskPromptDomId(taskId);
    if (customButtonActions.length <= 3) {
        return `<div class="custom-button-header"><div class="action-label">自定义按钮</div><button class="custom-button-gear" onclick="openCustomButtonConfigPanel()" title="设置自定义按钮" aria-label="设置自定义按钮">⚙</button></div><div class="action-group">${customButtonActions.join('')}</div>`;
    }
    const primaryActions = customButtonActions.slice(0, 3).join('');
    const moreActions = customButtonActions.slice(3).join('');
    return `<div class="custom-button-header"><div class="action-label">自定义按钮</div><button class="custom-button-gear" onclick="openCustomButtonConfigPanel()" title="设置自定义按钮" aria-label="设置自定义按钮">⚙</button></div><div class="action-group">${primaryActions}<button class="action-btn action-btn--neutral action-more-toggle" id="customButtonsMoreToggle-${domId}" onclick="toggleTaskCustomButtonsMore('${domId}')" aria-label="更多自定义按钮" title="更多">更多</button></div><div class="action-group" id="customButtonsMore-${domId}" style="display:none">${moreActions}</div>`;
}

/** Map internal task stage to review stage contract used by review messages (Req-1). */
function getReviewStageByTaskStage(stage: Feature['stage']): 'requirements' | 'design' | 'testcase' | 'tasks' | null {
    if (stage === STAGE.WRITING_REQUIREMENT) {
        return 'requirements';
    }
    if (stage === STAGE.WRITING_DESIGN) {
        return 'design';
    }
    if (stage === STAGE.WRITING_TESTCASE) {
        return 'testcase';
    }
    if (stage === STAGE.WRITING_TASKS) {
        return 'tasks';
    }
    return null;
}

/** Human-readable labels for review stages shown in the webview panel. */
function getReviewStageLabel(stage: 'requirements' | 'design' | 'testcase' | 'tasks'): string {
    if (stage === 'requirements') {
        return '需求';
    }
    if (stage === 'design') {
        return '设计';
    }
    if (stage === 'tasks') {
        return '任务拆解';
    }
    return '测试用例';
}

export function buildMainPageHtml(
    taskViews: MainFeatureViewModel[],
    dashboard: Record<string, never>,
    config: {
        isWorktreeSubview: boolean;
        aiProvider: string;
        customButtons: CustomButton[];
        aiQuickChatButtons?: import('./models').AiQuickChatButton[];
        autoPollEnabled: boolean;
        tokenAutoMergeEnabled?: boolean;
        autoPoll?: AutoPollStatus;
        scriptInventory?: ScriptInventory;
        readOnly?: boolean;
        customButtonEditable?: boolean;
    }
): string {
    const customButtons = config.customButtons || [];
    // 'main' buttons render in a dedicated main-panel area belonging to no iteration;
    // everything else (incl. legacy buttons without a placement) stays on task cards.
    const iterationButtons = customButtons;
    // Only valid buttons (non-blank label and content) are eligible for rendering (INV-4).
    const validAiQuickChatButtons = (config.aiQuickChatButtons || []).filter(
        b => b.label.trim().length > 0 && b.content.trim().length > 0
    );
    const isWorktreeSubview = config.isWorktreeSubview === true;
    const inv = config.scriptInventory || { scriptsSubdir: 'scripts', master: [], repoMono: [], dirs: { master: 'script' } };
    const readOnly = config.readOnly === true;
    const customButtonEditable = config.customButtonEditable !== false;
    const disabled = customButtonEditable ? '' : 'disabled';
    const isWin = process.platform === 'win32';
    const scriptExtHint = isWin ? '.ps1 / .bat / .cmd / .js' : '.sh / .bash / .js';
    const scriptsSubdir = inv.scriptsSubdir;
    const initialButtons = customButtons.map(normalizeCustomButton).map(b => ({
        name: b.name,
        scriptSource: b.scriptSource,
        script: b.script,
        args: b.args,
    }));
    const visibleTaskViews = isWorktreeSubview
        ? taskViews.slice(0, 1)
        : taskViews;
    const governanceTaskId = visibleTaskViews[0]?.task.id || '';

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
.refresh{background:transparent;color:#8f8f94;border:none;padding:4px 8px;border-radius:8px;font-size:16px;line-height:1;cursor:pointer}
.refresh:hover{background:#26262b;color:#eee}
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
.action-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.action-group{display:flex;gap:6px;flex-wrap:wrap}
.task-prompt-section{display:flex;flex-direction:column;gap:6px}
.task-prompt-actions{display:flex;gap:6px;flex-wrap:nowrap;align-items:stretch}
.task-prompt-more{display:flex;gap:6px;flex-wrap:wrap}
.task-prompt-btn{flex:1 1 0;min-width:0;padding:7px 8px;font-size:10px;white-space:nowrap}
.task-prompt-more-toggle{flex:0 0 auto;min-width:56px;padding:7px 8px;font-size:10px;white-space:nowrap}
.action-more-toggle{flex:0 0 auto;min-width:56px;padding:7px 8px;font-size:10px;white-space:nowrap}
.ai-interaction-section{display:flex;flex-direction:column;gap:6px}
.action-label{font-size:11px;color:#8f8f94;text-transform:uppercase;letter-spacing:.04em}
.action-btn{flex:1;min-width:80px;padding:8px 10px;border-radius:8px;border:1px solid transparent;font-size:11px;font-weight:600;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .12s ease}
.action-btn:hover{transform:translateY(-1px)}
.action-btn:active{transform:translateY(0)}
.action-btn:focus-visible{outline:1px solid #6aa8ff;outline-offset:1px}
.action-btn[disabled]{opacity:.45;pointer-events:none;transform:none}
.action-btn--primary{background:#007aff;color:#fff}
.action-btn--primary:hover{background:#2a8dff}
.action-btn--success{background:#34c759;color:#fff}
.action-btn--success:hover{background:#45d46a}
.action-btn--neutral{background:#444;color:#eee}
.action-btn--neutral:hover{background:#555}
.action-btn--warning{background:#ff9500;color:#fff}
.action-btn--warning:hover{background:#ffb143}
.action-btn--danger{background:#ff3b30;color:#fff}
.action-btn--danger:hover{background:#ff5550}
.action-btn--subtle-danger{flex:none;min-width:auto;padding:0;background:transparent;border:none;color:#8f8f94}
.action-btn--subtle-danger:hover{background:transparent;color:#ff8b85;transform:none}
.action-btn--icon-only{flex:none;min-width:auto;width:36px;padding:8px}
.action-btn__icon{width:14px;height:14px;display:block}
.action-btn--previous{flex:none;min-width:auto;padding:0;background:transparent;border:none;color:#8f8f94;font-size:11px;line-height:1.2}
.action-btn--previous:hover{background:transparent;color:#d0d0d6;transform:none}
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
.custom-btn-settings{margin:0 0 12px;padding:12px;background:#1c1c1e;border:1px solid #34343a;border-radius:10px}
.custom-btn-settings-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.custom-btn-settings-title{font-weight:600;font-size:13px;color:#f2f2f4}
.custom-btn-settings-toggle{width:auto;padding:6px 10px;border-radius:8px;border:none;background:#2f2f35;color:#ddd;font-size:12px;cursor:pointer}
.custom-btn-settings-body{margin-top:10px}
.custom-btn-settings-body[hidden]{display:none}
.custom-btn-settings .hint{font-size:12px;color:#a9a9b0;line-height:1.5;margin-bottom:8px}
.custom-btn-settings .kv{font-size:12px;color:#c8c8ce;line-height:1.6}
.custom-btn-settings .kv b{color:#fff}
.custom-btn-settings .inline-actions{display:flex;gap:8px;flex-wrap:wrap}
.custom-btn-settings .inline-actions button{flex:1;min-width:160px;width:auto;margin-top:0}
.custom-btn-settings .inline-actions--dual{flex-wrap:nowrap}
.custom-btn-settings .inline-actions--dual .action-btn{min-width:0;flex:1;padding:8px 10px;font-size:11px}
.iteration-artifact-section{display:flex;flex-direction:column;gap:6px}
.custom-button-section{display:flex;flex-direction:column;gap:6px}
.custom-button-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.custom-button-header .action-label{margin:0}
.custom-button-gear{width:auto;min-width:auto;padding:4px 8px;font-size:12px;border-radius:8px;border:none;background:#2f2f35;color:#ddd;cursor:pointer}
.cb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.cb-row input,.cb-row select{margin:0;min-width:0;box-sizing:border-box;padding:8px;border-radius:8px;border:none;background:#2c2c2e;color:#fff}
.cb-name{flex:1 1 120px}
.cb-src{flex:1 1 110px}
.cb-cmd{flex:2 1 150px}
.cb-args{flex:1 1 110px}
.cb-del{width:auto;flex:0 0 auto;margin:0;padding:8px 12px;background:#ff3b30;border:none;border-radius:8px;color:#fff}
.cb-empty{margin:10px 0;padding:10px;border-radius:8px;background:#2b2308;border:1px solid #7a5d00;color:#ffd56a;font-size:12px}

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
.todo-error{margin:0 0 8px;padding:8px 10px;border:1px solid #7a5d00;border-radius:8px;background:#2b2308;color:#ffd56a;font-size:12px;line-height:1.5}
.todo-empty{padding:12px;border:1px dashed #4a4a52;border-radius:8px;color:#a9a9b0;font-size:12px;line-height:1.5;text-align:center}
.todo-editor{display:none;margin:10px 0 8px;padding:10px;background:#232326;border:1px solid #34343a;border-radius:8px}
.todo-editor.open{display:block}
.todo-editor-head{font-size:12px;color:#d6d6dc;margin-bottom:8px}
.todo-editor-actions{display:flex;gap:6px;flex-wrap:wrap}
.todo-editor-actions button{flex:1;min-width:80px;padding:8px;border:none;border-radius:8px;font-size:11px}
.todo-loading{font-size:12px;color:#a9a9b0;margin-bottom:6px}
.delta-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer}
.delta-pass{background:#163a24;color:#7ee2a8}
.delta-warn{background:#4a3412;color:#ffd37a}
.delta-block{background:#4a1818;color:#ff9a9a}
.delta-none{background:#2c2c2e;color:#8f8f94}
.cr-panel{margin-top:8px;background:#1a1a1a;border:1px solid #323238;border-radius:8px;padding:6px 8px}
.cr-panel>summary{cursor:pointer;font-size:12px;color:#cfd6dd;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.cr-panel>summary::-webkit-details-marker{display:none}
.cr-summary-main{display:inline-flex;align-items:center}
.cr-summary-hint{font-size:10px;color:#8f8f94}
.cr-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.cr-row{background:#202026;border:1px solid #323238;border-radius:8px;padding:7px 8px}
.cr-main{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.cr-remote{font-size:11px;font-weight:600;color:#e8e8ec}
.cr-platform{font-size:10px;padding:1px 6px;border-radius:999px;background:#2f2f35;color:#b8b8bf;text-transform:uppercase}
.cr-state{font-size:10px;padding:1px 6px;border-radius:999px;font-weight:600}
.cr-state--merged{background:#163a24;color:#7ee2a8}
.cr-state--queued{background:#17324a;color:#8fc4ff}
.cr-state--open{background:#3d330f;color:#ffd37a}
.cr-state--closed{background:#3a2636;color:#e0a7d3}
.cr-state--failed{background:#4a1818;color:#ff9a9a}
.cr-state--unsupported,.cr-state--unknown{background:#2c2c2e;color:#9f9fa6}
.cr-meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
.cr-link{font-size:11px;color:#8fc4ff;text-decoration:none}
.cr-link:hover{text-decoration:underline}
.cr-link--muted{color:#8f8f94}
.cr-time{font-size:10px;color:#8f8f94}
.cr-error{margin-top:4px;font-size:11px;color:#ffb3b3;line-height:1.4}
.overview-card{margin:0 0 12px;padding:10px 12px;background:#1c1c1e;border:1px solid #34343a;border-radius:10px}
.overview-title{font-weight:600;font-size:13px}
.overview-table{width:100%;border-collapse:collapse;font-size:11px}
.overview-table th{color:#8f8f94;text-align:left;padding:2px 6px}
.overview-table td{color:#ddd;padding:2px 6px}
.overview-table tr.blocked td{color:#ff9a9a}
.overview-table tr.warn td{color:#ffd37a}
.dk-gov-card{margin:0 0 12px;padding:12px;background:#1c1c1e;border:1px solid #34343a;border-radius:10px}
.dk-gov-card--focus{border-color:#34c759;box-shadow:0 0 0 2px rgba(52,199,89,.25)}
.dk-gov-title-wrap{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.dk-gov-title{font-weight:600;font-size:13px;color:#f2f2f4}
.dk-gov-subtitle{font-size:11px;color:#8f8f94;line-height:1.45}
.dk-gov-actions{display:flex;gap:8px;flex-wrap:wrap}
.dk-spin{animation:dk-spin 1s linear infinite}
@keyframes dk-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.domain-workspace-card{margin:0 0 12px;padding:12px;background:#15161a;border:1px solid #2f3a44;border-radius:10px}
.domain-workspace-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.domain-workspace-title{font-weight:700;font-size:13px;color:#d8eaff}
.dw-commit-row{margin-top:10px}
.dw-commit-row:empty{margin-top:0}
.dw-commit-row .action-btn{width:100%;justify-content:center}
.domain-workspace-meta{font-size:11px;color:#93a6b8}
.domain-workspace-status{font-size:12px;color:#d7d7dc;background:#1f232a;border:1px solid #353b45;border-radius:8px;padding:8px;white-space:pre-wrap}
.domain-workspace-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}
.domain-workspace-table th{color:#8f8f94;text-align:left;padding:4px 6px;border-bottom:1px solid #2f3640}
.domain-workspace-table td{color:#ddd;padding:4px 6px;border-bottom:1px solid #242a33;vertical-align:top}
.domain-workspace-empty{font-size:11px;color:#8f8f94;padding:8px;border:1px dashed #39414d;border-radius:8px;margin-top:8px}
.dw-conflict{margin-top:10px;border:1px solid #5a3b3b;background:#241a1a;border-radius:8px;padding:8px}
.dw-conflict--warn{border-color:#5a533b;background:#242116}
.dw-conflict-msg{font-size:12px;color:#f0c9c9;margin-bottom:6px}
.dw-conflict--warn .dw-conflict-msg{color:#e6dca8}
.dw-conflict-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}
.dw-input{background:#12151a;border:1px solid #39414d;border-radius:6px;color:#e6e6e6;padding:4px 6px;font-size:11px}
.dw-select{background:#12151a;border:1px solid #39414d;border-radius:6px;color:#e6e6e6;padding:4px 6px;font-size:11px}
.dw-hint{font-size:10px;color:#8f8f94;margin-top:2px}
.domain-workspace-commit-bar{margin-top:12px;padding-top:10px;border-top:1px solid #2f3640;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dw-commit-note{font-size:11px}
.dw-commit-note--ok{color:#8fd19e}
.dw-commit-note--block{color:#f0a9a9}
.dw-commit-summary{margin-top:8px;font-size:11px;color:#a9d0f0;background:#141b24;border:1px solid #2b4256;border-radius:8px;padding:8px;white-space:pre-wrap}
.dw-details{margin-top:8px}
.dw-summary{cursor:pointer;font-size:11px;color:#8fb6d8;padding:4px 0;user-select:none}
.dw-summary:hover{color:#bcd7ef}
.dw-file-list{margin:6px 0 0;padding-left:18px;font-size:11px;color:#9fc6e8;line-height:1.5}
.dw-file-list li{word-break:break-all}
</style>
</head>
<body>

${!isWorktreeSubview ? `<div class="nav">
<button class="nav-btn active" onclick="p('main')">任务面板</button>
<button class="nav-btn" onclick="p('settings')">高级设置</button>
</div>` : ''}

<div class="header">
<h4>${isWorktreeSubview ? `🎯 ${escapeHtml(visibleTaskViews[0]?.task.name || '当前迭代任务')}` : '📌 迭代任务'}</h4>
<div class="header-actions">
${isWorktreeSubview ? '<button class="refresh" title="回到主工作区" onclick="openMasterWorkspace()">↩</button>' : ''}
<button class="refresh" title="刷新" onclick="refresh()">🔄</button>
</div>
</div>

${isWorktreeSubview && config.autoPollEnabled && config.autoPoll ? buildAutoPollPanelHtml(config.autoPoll) : ''}

<div class="custom-btn-settings" id="customBtnSettingsPanel">
<div class="custom-btn-settings-head">
<div class="custom-btn-settings-title">🧰 自定义按钮设置</div>
<button class="custom-btn-settings-toggle" id="customBtnSettingsToggle" onclick="toggleCustomButtonConfig()">展开</button>
</div>
<div class="custom-btn-settings-body" id="customBtnSettingsBody" hidden>
${readOnly && customButtonEditable ? '<div class="cb-empty" style="margin-bottom:8px">当前窗口为快照视图；保存将写回主窗口并同步，脚本目录为 scripts/。</div>' : ''}
${readOnly && !customButtonEditable ? '<div class="cb-empty" style="margin-bottom:8px">当前窗口为快照视图，且未找到可写主工作区，暂时无法修改自定义按钮。</div>' : ''}
${!readOnly ? '<div class="hint">脚本目录为 scripts/。</div>' : ''}
<div id="cbEmpty" class="cb-empty" style="display:none">未发现可用脚本。请先创建 ${scriptExtHint} 脚本后再添加按钮。</div>
<div id="cbList"></div>
<div class="inline-actions inline-actions--dual">
<button class="action-btn action-btn--neutral" onclick="addCustomButton()" ${disabled}>添加</button>
<button class="action-btn action-btn--primary" onclick="saveCustomButtons()" ${disabled}>保存</button>
</div>
</div>
</div>

${`<div class="todo-card" id="workspace-todo-panel">
<div class="todo-head">
<div class="todo-title">${isWorktreeSubview ? '📝 待办（工作区）' : '📝 待办'}</div>
<button class="action-btn action-btn--primary" style="padding:6px 10px;font-size:11px;min-width:auto;flex:none" onclick="openTodoCreateEditor()">＋ 添加待办</button>
</div>
<div id="todo-loading" class="todo-loading" style="display:none">正在加载待办列表...</div>
<div id="todo-error" class="todo-error" style="display:none"></div>
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
<button class="action-btn action-btn--neutral" onclick="closeTodoEditor()">取消</button>
<button class="action-btn action-btn--primary" onclick="submitTodoEditor()">保存</button>
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
    const taskSpecDriftRepair = t.specDriftRepairEnabled !== false;
    const effectiveSplitMode = t.taskSplitMode || 'compact';
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
    const outputWarnings = view.taskOutputPathWarnings || [];
    const outputWarningsPreview = outputWarnings.slice(0, 2);
    const hasWorktree = Boolean(t.worktreePath) || health.worktreeExists || health.frontendExists || health.backendExists;
    const panelMode: PanelMode = isWorktreeSubview ? 'worktree' : 'main';
    const { primaryActions, sideActions, headerActions } = collectTaskActions({
        panelMode,
        isWorktreeSubview,
        taskView: view,
        task: t,
        allSubTasksDone,
        hasWorktree,
    });
    const aiQuickActions: string[] = [];
    const canRenderTaskExtraActions = isWorktreeSubview || hasWorktree;

    const customButtonActions: string[] = [];
    // User-defined buttons: same visibility rule (worktree subview always,
    // main panel only when an iteration worktree exists). Resolved server-side by id.
    if (canRenderTaskExtraActions && iterationButtons.length > 0) {
        for (const b of iterationButtons) {
            customButtonActions.push(`<button class="action-btn action-btn--neutral" onclick="runCustomButton('${t.id}','${b.id}')">${escapeHtml(b.name)}</button>`);
        }
    }
    // AI quick-chat buttons: render in a dedicated section.
    if (canRenderTaskExtraActions && validAiQuickChatButtons.length > 0) {
        for (const b of validAiQuickChatButtons) {
            aiQuickActions.push(`<button class="action-btn action-btn--neutral" onclick="runAiQuickChatButton('${t.id}','${b.id}')">${escapeHtml(b.label)}</button>`);
        }
    }
    const showAiQuickInteractionSection = aiQuickActions.length > 0;
        const taskPromptActionsHtml = buildTaskPromptActionsHtml(t.id);
        const sideActionsHtml = buildTaskSideActionsHtml(t.id, sideActions);
        const customButtonsHtml = buildTaskCustomButtonsHtml(t.id, customButtonActions);
        const iterationArtifactsHtml = buildIterationArtifactsHtml(t.id);

    const actionHtml = `
<div class="action-stack">
    ${(primaryActions.length > 0 || headerActions.length > 0) ? `<div class="action-header"><div class="action-label">主流程操作</div>${headerActions.length > 0 ? `<div class="action-group">${headerActions.join('')}</div>` : ''}</div>${primaryActions.length > 0 ? `<div class="action-group">${primaryActions.join('')}${t.stage === STAGE.DEVELOPING ? `<!-- STAGE=DEVELOPING, primaryCount=${primaryActions.length} -->` : ''}</div>` : ''}` : ''}
    ${sideActionsHtml}
    ${iterationArtifactsHtml}
    ${customButtonsHtml ? `<div class="custom-button-section">${customButtonsHtml}</div>` : ''}
    ${taskPromptActionsHtml}
  ${showAiQuickInteractionSection ? `<div class="ai-interaction-section"><div class="action-label">AI快捷交互区</div><div class="action-group">${aiQuickActions.join('')}</div></div>` : ''}
</div>`;

    return `
<div class="task-item" data-task-id="${t.id}" data-abnormal="${isAbnormal ? '1' : '0'}">
${!isWorktreeSubview ? `<div style="display:flex;justify-content:space-between;align-items:center">
<div class="task-name">${t.name}</div>
${t.worktreePath ? `<button class="action-btn action-btn--neutral" style="flex:none;padding:4px 10px;font-size:11px;min-width:auto" onclick="openFolderLocation('${t.id}','worktree')">📁 Worktree</button>` : ''}
</div>` : ''}
<div class="task-desc-wrap" id="task-desc-wrap-${t.id}">
<div class="task-desc-view" id="task-desc-view-${t.id}">
<div class="task-desc" id="task-desc-${t.id}">${escapeHtml(t.desc || '')}</div>
<button type="button" class="task-desc-edit-btn" onclick="openFeatureDescEditor('${t.id}')" title="编辑需求描述">✎</button>
</div>
<div class="task-desc-editor-wrap" id="task-desc-editor-wrap-${t.id}">
<textarea
class="task-desc-editor"
id="task-desc-editor-${t.id}"
oninput="autoGrowFeatureDescEditor('${t.id}')"
placeholder="请输入需求描述"
>${escapeHtml(t.desc || '')}</textarea>
<div class="task-desc-editor-actions">
<button type="button" class="action-btn action-btn--neutral" onclick="cancelFeatureDescEditor('${t.id}')">取消</button>
<button type="button" class="action-btn action-btn--primary" onclick="commitFeatureDescEditor('${t.id}')">保存</button>
</div>
</div>
</div>
${!t.quickMode ? `<div>阶段：${STAGE_LABEL[t.stage] || t.stage}</div>
<div class="task-status">原因：${health.summary || '-'}</div>
${(t.stage === STAGE.DEVELOPING || t.stage === STAGE.READY_FOR_REVIEW) ? `<div class="health-line" style="margin:4px 0">${buildDeltaBadgeHtml(t.id, view.specDeltaStatus)}</div>` : ''}
${view.latestFailureReason ? `<div class="task-status">最近失败：${view.latestFailureReason}</div>` : ''}
${outputWarningsPreview.length > 0 ? `<div class="task-status" style="color:#ffb143">输出路径告警：${outputWarningsPreview.map(escapeHtml).join('；')}${outputWarnings.length > outputWarningsPreview.length ? `（+${outputWarnings.length - outputWarningsPreview.length}）` : ''}</div>` : ''}
<div class="task-status">待办:${stats.todo} 执行中:${stats.doing} 完成:${stats.done}${stats.failed > 0 ? ` 失败:${stats.failed}` : ''}</div>
<div class="task-progress"><div class="progress-bar" style="width:${view.pct}%"></div></div>
<div style="font-size:12px">进度：${view.pct}%</div>` : ''}
${isWorktreeSubview ? `<div class="config-actions" style="margin-top:6px">
<button class="action-btn action-btn--neutral" onclick="setFeatureAutomation('${t.id}',${!taskAutoAdvance})">${taskAutoAdvance ? '⛔ 关闭批次自动推进' : '▶ 开启批次自动推进'}</button>
<button class="action-btn action-btn--neutral" onclick="setSpecDriftRepair('${t.id}',${!taskSpecDriftRepair})">${taskSpecDriftRepair ? '⛔ 关闭漂移自动修复' : '▶ 开启漂移自动修复'}</button>
</div>
<div class="task-status">任务自动化：批次自动推进 ${taskAutoAdvance ? '开' : '关'}；Spec 漂移自动修复 ${taskSpecDriftRepair ? '开' : '关'}</div>` : ''}
<div class="toggle-row" style="margin:6px 0">
<span style="font-size:12px">AI 执行器</span>
<select style="width:auto;margin:0;padding:4px 6px;font-size:11px;background:#2c2c2e;color:#fff;border:none;border-radius:6px" onchange="setFeatureAiProvider('${t.id}',this.value)">
${AI_PROVIDERS.map(p => `<option value="${p.id}" ${(t.aiProvider || config.aiProvider) === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
</select>
</div>

${!isWorktreeSubview ? `<details class="task-config">
<summary>⚙ 展开配置</summary>
<div class="task-config-body">
<div class="task-status">Worktree：${t.worktreePath || '-'}</div>
<div class="task-status">拆分模式：${effectiveSplitMode === 'compact' ? '急速模式' : '标准模式'}</div>
<div class="task-status">基线分支：${t.baseBranchUsed || '-'}</div>
<div class="task-status">迭代分支：${t.iterationBranch || '-'}</div>
<div class="health-line"><span class="health-badge ${healthClass}">${healthLabel}</span><span class="task-status">${healthStatus}</span></div>
<div class="task-status">文档：${artifactStatus}</div>
<div class="task-status">任务自动化：批次自动推进 ${taskAutoAdvance ? '开' : '关'}</div>
<div class="config-actions">
<button class="action-btn action-btn--neutral" onclick="setFeatureAutomation('${t.id}',${!taskAutoAdvance})">${taskAutoAdvance ? '⛔ 关闭批次自动推进' : '▶ 开启批次自动推进'}</button>
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
        ? ` <button class="action-btn action-btn--neutral" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="retry('${st.id}','${t.id}')">重做</button>`
        : '';
    const actions = !canOperateSubTasks
        ? ''
        : st.status === 'failed'
        ? ` <button class="action-btn action-btn--neutral" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="retry('${st.id}','${t.id}')">重跑</button> <button class="action-btn action-btn--success" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="setSubStatus('${t.id}','${st.id}','done')">标记完成</button>`
        : st.status === 'doing'
            ? `${redoAction} <button class="action-btn action-btn--success" style="padding:2px 6px;font-size:10px;min-width:auto;flex:none" onclick="setSubStatus('${t.id}','${st.id}','done')">标记完成</button>`
            : '';
    return `<div class="sub-task"><span class="${cls}">${icon} ${st.id}</span> <span>${st.name}</span>${actions}</div>`;
}).join('')}
</div>
</details>
` : ''}

${buildChangeRequestStatusHtml(t, config.tokenAutoMergeEnabled === true)}

<div class="action">
${actionHtml}
</div>
</div>`;
}).join('')}

${isWorktreeSubview ? `<div class="domain-workspace-card" id="domain-workspace-panel" data-task-id="${escapeHtml(governanceTaskId)}" style="display:none">
<div class="domain-workspace-head">
<div class="domain-workspace-title">🏛 领域沉淀维护</div>
<button class="refresh" title="刷新上下文" onclick="reloadDomainWorkspaceContext()">🔄</button>
</div>
<div class="dk-gov-actions">
<button class="action-btn action-btn--primary" data-domain-action="generateCapabilityDelta" onclick="generateCapabilityDelta()" ${governanceTaskId ? '' : 'disabled'}>更新领域能力</button>
<button class="action-btn action-btn--neutral" onclick="triggerDetectDomainConflicts()">检测/裁决</button>
</div>
<div class="domain-workspace-status" id="domain-workspace-status">点击「领域沉淀维护」后将加载上下文…</div>
<div id="domain-workspace-change-set"></div>
<div id="domain-workspace-conflicts"></div>
<div id="domain-workspace-commit-slot" class="dw-commit-row"></div>
<div id="domain-workspace-commit"></div>
</div>` : ''}

${!isWorktreeSubview ? `<div class="fixed-bottom">
<div class="input-card">
<h4>🚀 创建迭代开发版本</h4>
<input id="name" placeholder="迭代名称（英文）">
<textarea id="desc" rows="2" placeholder="功能描述"></textarea>
<label style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px;font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer">
<span>快捷模式（跳过拆解，直接开发）</span>
<input type="checkbox" id="quickMode" style="margin:0;width:16px;height:16px;flex-shrink:0">
</label>
<button class="action-btn action-btn--primary" onclick="create()">创建迭代开发版本</button>
</div>
</div>` : ''}

<script>
const v=acquireVsCodeApi();
const isWorktreeSubview=${isWorktreeSubview ? 'true' : 'false'};
const DOMAIN_GOVERNANCE_TASK_ID='${escapeHtml(governanceTaskId)}';
const TODO_STATE_KEY='workspaceTodoState.v1';
const DOMAIN_WORKSPACE_STATE_KEY='domainWorkspaceState.v1';
const CUSTOM_BUTTON_SETTINGS_STATE_KEY='customButtonSettingsState.v1';
const TODO_SOURCE_PANEL=${isWorktreeSubview ? "'worktree'" : "'master'"};
const TODO_INITIAL_TODOS=[];
let todoState=loadTodoState();
let domainActionLoading='';
let domainWorkspaceState=loadDomainWorkspaceState();
const CUSTOM_BUTTON_SETTINGS_EXPAND_TTL_MS=15000;

/** Restore persisted UI state for custom-button settings drawer. */
function loadCustomButtonSettingsState(){
    const state=v.getState()||{};
    const cached=state[CUSTOM_BUTTON_SETTINGS_STATE_KEY];
    if(!cached||typeof cached!=='object'){
        return { expanded:false };
    }
    const expandedAt=typeof cached.expandedAt==='number'?cached.expandedAt:0;
    const expandedRecently=cached.expanded===true&&expandedAt>0&&(Date.now()-expandedAt)<=CUSTOM_BUTTON_SETTINGS_EXPAND_TTL_MS;
    return {
        expanded:expandedRecently,
    };
}

/** Persist custom-button settings drawer UI state. */
function saveCustomButtonSettingsState(nextState){
    const state=v.getState()||{};
    const expanded=nextState&&nextState.expanded===true;
    state[CUSTOM_BUTTON_SETTINGS_STATE_KEY]={
        expanded,
        expandedAt:expanded?Date.now():0,
    };
    v.setState(state);
}

/** Build a default in-memory state for domain workspace interactions. */
function createDefaultDomainWorkspaceState(){
    return {
        visible:false,
        loading:false,
        taskId:'',
        taskName:'',
        iterationId:'',
        iterationPath:'',
        repoRoot:'',
        baselineVersion:'',
        changeSet:null,
        error:'',
        conflicts:[],
        blocking:false,
        detecting:false,
        committing:false,
        commitSummary:null,
        existingDomains:[],
        notice:'',
    };
}

/** Restore persisted domain workspace state from webview cache. */
function loadDomainWorkspaceState(){
    const state=v.getState()||{};
    const cached=state[DOMAIN_WORKSPACE_STATE_KEY];
    if(!cached||typeof cached!=='object'){
        return createDefaultDomainWorkspaceState();
    }
    return {
        ...createDefaultDomainWorkspaceState(),
        ...cached,
    };
}

/** Persist current domain workspace state to webview cache. */
function saveDomainWorkspaceState(){
    const state=v.getState()||{};
    state[DOMAIN_WORKSPACE_STATE_KEY]=domainWorkspaceState;
    v.setState(state);
}

/** Render domain workspace panel with current state snapshot. */
function renderDomainWorkspacePanel(){
    const panel=document.getElementById('domain-workspace-panel');
    if(!panel){return;}
    panel.style.display=domainWorkspaceState.visible?'block':'none';

    const status=document.getElementById('domain-workspace-status');
    const changeSetWrap=document.getElementById('domain-workspace-change-set');
    if(!status||!changeSetWrap){return;}

    if(domainWorkspaceState.loading){
        status.textContent='正在加载上下文…';
    }else if(domainWorkspaceState.detecting){
        status.textContent='正在检测冲突…';
    }else if(domainWorkspaceState.committing){
        status.textContent='正在写入沉淀…';
    }else if(domainWorkspaceState.error){
        status.textContent='⚠ '+domainWorkspaceState.error;
    }else{
        const parts=[];
        const bv=domainWorkspaceState.baselineVersion;
        if(bv){parts.push('基线 '+bv);}
        const conflicts=domainWorkspaceState.conflicts||[];
        if(conflicts.length>0){parts.push('待裁决 '+conflicts.length+' 项');}
        const s=domainWorkspaceState.commitSummary;
        if(s){
            if(s.skippedAsNoChange){parts.push('无变更');}
            else{parts.push('已沉淀 领域'+(s.processedDomains||0)+'/能力'+(s.processedCapabilities||0));}
        }
        if(domainWorkspaceState.notice){parts.push(domainWorkspaceState.notice);}
        status.textContent=parts.length?parts.join(' · '):'等待加载上下文…';
    }

    const changeSet=domainWorkspaceState.changeSet;
    if(!changeSet||!Array.isArray(changeSet.domainChanges)||changeSet.domainChanges.length===0){
        changeSetWrap.innerHTML='<div class="domain-workspace-empty">当前变更集为空。可先点击上方「更新领域能力」，再回到此处刷新上下文。</div>';
        renderDomainConflicts();
        renderDomainCommitBar();
        return;
    }

    const rows=changeSet.domainChanges.map((item)=>{
        const reqId=escapeTodoHtml(item&&item.reqId?String(item.reqId):'');
        const canonical=item&&item.canonicalDomain?String(item.canonicalDomain):'';
        const rawDomain=item&&item.rawDomain?String(item.rawDomain):'';
        const domainCell=escapeTodoHtml(canonical||rawDomain||'')
            +(canonical?'':' <span class="dw-hint">(未归类)</span>');
        const title=escapeTodoHtml(item&&item.title?String(item.title):'');
        const changeType=escapeTodoHtml(item&&item.changeType?String(item.changeType):'');
        const statusText=escapeTodoHtml(item&&item.status?String(item.status):'');
        return '<tr>'
            +'<td>'+reqId+'</td>'
            +'<td>'+domainCell+'</td>'
            +'<td>'+title+'</td>'
            +'<td>'+changeType+'</td>'
            +'<td>'+statusText+'</td>'
            +'</tr>';
    }).join('');

    changeSetWrap.innerHTML=''
        +'<details class="dw-details">'
        +'<summary class="dw-summary">领域能力明细（'+changeSet.domainChanges.length+' 项）</summary>'
        +'<table class="domain-workspace-table">'
        +'<thead><tr><th>Req-ID</th><th>领域</th><th>能力标题</th><th>变更</th><th>状态</th></tr></thead>'
        +'<tbody>'+rows+'</tbody>'
        +'</table>'
        +'</details>';

    renderDomainConflicts();
    renderDomainCommitBar();
}

/** Sanitize a conflict id into a DOM-safe element id fragment. */
function domainConflictDomId(conflictId){
    return String(conflictId||'').replace(/[^a-zA-Z0-9_-]/g,'_');
}

/** Render the conflict adjudication section (naming / capability-key / baseline-version). */
function renderDomainConflicts(){
    const wrap=document.getElementById('domain-workspace-conflicts');
    if(!wrap){return;}
    const conflicts=domainWorkspaceState.conflicts||[];
    if(conflicts.length===0){
        wrap.innerHTML='';
        return;
    }
    const options=(domainWorkspaceState.existingDomains||[])
        .map((d)=>'<option value="'+escapeTodoHtml(String(d))+'">'+escapeTodoHtml(String(d))+'</option>')
        .join('');
    const blocks=conflicts.map((conflict)=>{
        const cid=String(conflict&&conflict.id?conflict.id:'');
        const domId=domainConflictDomId(cid);
        const type=String(conflict&&conflict.type?conflict.type:'');
        const severity=String(conflict&&conflict.severity?conflict.severity:'blocking');
        const message=escapeTodoHtml(String(conflict&&conflict.message?conflict.message:''));
        const cls=severity==='warning'?'dw-conflict dw-conflict--warn':'dw-conflict';
        let controls='';
        if(type==='domain-name'){
            const suggested=escapeTodoHtml(suggestCanonicalFromConflict(conflict));
            controls=''
                +'<div class="dw-conflict-row">'
                +'<input class="dw-input" id="dw-new-'+domId+'" type="text" placeholder="新 canonical(如 dictionary)" value="'+suggested+'">'
                +'<input class="dw-input" id="dw-dn-'+domId+'" type="text" placeholder="显示名(如 字典治理)">'
                +'<button class="action-btn action-btn--primary" onclick="resolveDomainConflictAction(\\''+cid+'\\',\\'create-canonical\\',\\''+domId+'\\')">创建受控新领域</button>'
                +'</div>'
                +'<div class="dw-conflict-row">'
                +'<select class="dw-select" id="dw-target-'+domId+'">'+options+'</select>'
                +'<button class="action-btn action-btn--neutral" onclick="resolveDomainConflictAction(\\''+cid+'\\',\\'merge-existing\\',\\''+domId+'\\')">合并到已有领域</button>'
                +'<button class="action-btn action-btn--neutral" onclick="resolveDomainConflictAction(\\''+cid+'\\',\\'append-alias\\',\\''+domId+'\\')">登记为别名</button>'
                +'</div>'
                +'<div class="dw-hint">「创建受控新领域」会把该领域写入 docs/domains/registry.yaml 并纳入沉淀。</div>';
        }else if(type==='capability-key'){
            controls='<div class="dw-conflict-row">'
                +'<button class="action-btn action-btn--neutral" onclick="resolveDomainConflictAction(\\''+cid+'\\',\\'choose-value\\',\\''+domId+'\\')">确认保留当前归属</button>'
                +'</div>';
        }else if(type==='baseline-version'){
            controls='<div class="dw-conflict-row">'
                +'<button class="action-btn action-btn--neutral" onclick="triggerRefreshBaseline()">拉取最新基线并重新投影</button>'
                +'</div>';
        }
        return '<div class="'+cls+'">'
            +'<div class="dw-conflict-msg">['+escapeTodoHtml(type)+'] '+message+'</div>'
            +controls
            +'</div>';
    }).join('');
    wrap.innerHTML='<div class="domain-workspace-subtitle" style="font-size:12px;color:#d8eaff;margin-top:12px;font-weight:600">⚖ 领域裁决</div>'+blocks;
}

/** Suggest a canonical slug from the conflict's raw domain / reqIds. */
function suggestCanonicalFromConflict(conflict){
    const changes=(domainWorkspaceState.changeSet&&domainWorkspaceState.changeSet.domainChanges)||[];
    const reqIds=(conflict&&conflict.reqIds)||[];
    for(let i=0;i<changes.length;i++){
        const c=changes[i];
        if(c&&reqIds.indexOf(c.reqId)>=0){
            const raw=String(c.rawDomain||'').trim();
            if(raw&&raw!=='uncategorized'){
                return raw.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
            }
        }
    }
    return '';
}

/** Render the atomic-commit bar gated on unresolved blocking conflicts. */
function renderDomainCommitBar(){
    const slot=document.getElementById('domain-workspace-commit-slot');
    const wrap=document.getElementById('domain-workspace-commit');
    const changeSet=domainWorkspaceState.changeSet;
    const hasChanges=changeSet&&Array.isArray(changeSet.domainChanges)&&changeSet.domainChanges.length>0;
    const conflicts=domainWorkspaceState.conflicts||[];
    const blockingCount=conflicts.filter((c)=>c&&c.severity==='blocking').length;
    const blocked=blockingCount>0||domainWorkspaceState.committing;
    if(slot){
        if(!hasChanges){
            slot.innerHTML='';
        }else if(blocked){
            const tip=blockingCount>0?('仍有 '+blockingCount+' 项阻断冲突需先裁决'):'提交进行中';
            slot.innerHTML='<button class="action-btn action-btn--success" disabled title="'+tip+'">写入沉淀</button>';
        }else{
            slot.innerHTML='<button class="action-btn action-btn--success" onclick="triggerCommitDomainKnowledge()">写入沉淀</button>';
        }
    }
    if(wrap){
        const s=domainWorkspaceState.commitSummary;
        if(s&&!s.skippedAsNoChange&&Array.isArray(s.writtenFiles)&&s.writtenFiles.length>0){
            const items=s.writtenFiles.map((f)=>{
                const full=String(f||'');
                const base=full.split('\\\\').join('/').split('/').pop();
                return '<li title="'+escapeTodoHtml(full)+'">'+escapeTodoHtml(base||full)+'</li>';
            }).join('');
            wrap.innerHTML='<details class="dw-details"><summary class="dw-summary">写入文件（'+s.writtenFiles.length+'）</summary><ul class="dw-file-list">'+items+'</ul></details>';
        }else{
            wrap.innerHTML='';
        }
    }
}

/** Load context for current domain workspace target task. */
function requestDomainWorkspaceContext(){
    if(!domainWorkspaceState.repoRoot||!domainWorkspaceState.iterationId){
        domainWorkspaceState.error='缺少 repoRoot 或 iterationId，无法加载';
        domainWorkspaceState.loading=false;
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    domainWorkspaceState.loading=true;
    domainWorkspaceState.error='';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    v.postMessage({
        type:'loadDomainKnowledgeContext',
        repoRoot:domainWorkspaceState.repoRoot,
        iterationId:domainWorkspaceState.iterationId,
    });
}

/** Handle capability-delta generation completion and refresh domain context. */
function handleCapabilityDeltaGeneratedEvent(message){
    const taskId=String(message&&message.taskId?message.taskId:'');
    if(taskId&&domainWorkspaceState.taskId&&taskId!==domainWorkspaceState.taskId){
        return;
    }
    if(!domainWorkspaceState.visible){
        domainWorkspaceState.visible=true;
    }
    domainWorkspaceState.loading=true;
    domainWorkspaceState.error='';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    requestDomainWorkspaceContext();
}

/** Refresh context manually from the domain workspace panel. */
function reloadDomainWorkspaceContext(){
    requestDomainWorkspaceContext();
}

/** Trigger a stage review; result is surfaced via VS Code notification. */
function triggerStageReview(taskId,stage){
    v.postMessage({type:'runStageReview',stage,context:{taskId:String(taskId||''),taskStage:String(stage||'')}});
}

/** Open the user-custom review prompt file for editing (same convention as other stage prompts). */
function openReviewCustomPrompt(stage){
    v.postMessage({type:'openReviewCustomPrompt',stage});
}

/** Open stage custom prompt file from task card action section. */
function openCustomPrompt(step){
    v.postMessage({type:'openCustomPrompt',step});
}

/** Open constitution prompt file from task card action section. */
function openCustomConstitution(){
    v.postMessage({type:'openCustomConstitution'});
}

/** Toggle task-card custom prompt overflow actions by task-specific DOM id. */
function toggleTaskPromptMore(domId){
    const more=document.getElementById('taskPromptMore-'+domId);
    const toggle=document.getElementById('taskPromptMoreToggle-'+domId);
    if(!more||!toggle)return;
    const open=more.style.display==='none';
    more.style.display=open?'flex':'none';
    toggle.textContent=open?'收起':'更多';
    toggle.title=open?'收起':'更多';
}

/** Toggle task-card side-actions overflow buttons by task-specific DOM id. */
function toggleTaskSideActionsMore(domId){
    const more=document.getElementById('sideActionsMore-'+domId);
    const toggle=document.getElementById('sideActionsMoreToggle-'+domId);
    if(!more||!toggle)return;
    const open=more.style.display==='none';
    more.style.display=open?'flex':'none';
    toggle.textContent=open?'收起':'更多';
    toggle.title=open?'收起':'更多';
}

/** Toggle task-card iteration-artifacts overflow actions by task-specific DOM id. */
function toggleIterationArtifactsMore(domId){
    const more=document.getElementById('iterationArtifactsMore-'+domId);
    const toggle=document.getElementById('iterationArtifactsMoreToggle-'+domId);
    if(!more||!toggle)return;
    const open=more.style.display==='none';
    more.style.display=open?'flex':'none';
    toggle.textContent=open?'收起':'更多';
    toggle.title=open?'收起':'更多';
}

/** Toggle task-card custom-button overflow actions by task-specific DOM id. */
function toggleTaskCustomButtonsMore(domId){
    const more=document.getElementById('customButtonsMore-'+domId);
    const toggle=document.getElementById('customButtonsMoreToggle-'+domId);
    if(!more||!toggle)return;
    const open=more.style.display==='none';
    more.style.display=open?'flex':'none';
    toggle.textContent=open?'收起':'更多';
    toggle.title=open?'收起':'更多';
}

/** Render loading/disabled status for top-level domain-governance actions. */
function setDomainActionLoading(action){
    domainActionLoading=action||'';
    const buttons=document.querySelectorAll('[data-domain-action]');
    buttons.forEach((button)=>{
        const key=button.getAttribute('data-domain-action')||'';
        const shouldLock=!DOMAIN_GOVERNANCE_TASK_ID||!!domainActionLoading;
        button.disabled=shouldLock;
        if(domainActionLoading&&key===domainActionLoading){
            button.innerHTML='<span class="codicon codicon-loading dk-spin" aria-hidden="true"></span><span>'+(button.dataset.label||button.innerText)+'</span>';
        }else if(button.dataset&&button.dataset.label){
            button.innerText=button.dataset.label;
        }
    });
}

/** Post a domain-governance action message to extension host with task context. */
function postDomainGovernanceAction(type){
    if(!DOMAIN_GOVERNANCE_TASK_ID||domainActionLoading){return;}
    setDomainActionLoading(type);
    v.postMessage({type,id:DOMAIN_GOVERNANCE_TASK_ID});
    setTimeout(()=>setDomainActionLoading(''),1500);
}

/** Trigger main-panel domain baseline aggregation route. */
function runDomainBaselineAggregation(){postDomainGovernanceAction('runDomainBaselineAggregation')}

/** Trigger worktree deterministic capability-delta generation route. */
function generateCapabilityDelta(){postDomainGovernanceAction('generateCapabilityDelta')}

/** Trigger main-panel suspected-domain review route. */
function reviewSuspectedDomains(){postDomainGovernanceAction('reviewSuspectedDomains')}

/** Trigger main-panel suspected-domain adjudication route. */
function applyDomainAdjudication(){postDomainGovernanceAction('applyDomainAdjudication')}

/** Trigger main-panel domain baseline commit route. */
function commitDomainBaseline(){postDomainGovernanceAction('commitDomainBaseline')}

/** Trigger main-panel domain index preview route. */
function previewDomainBaselineSummary(){postDomainGovernanceAction('previewDomainBaselineSummary')}

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
        error:null,
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
    const errorBox=document.getElementById('todo-error');
    const empty=document.getElementById('todo-empty');
    const list=document.getElementById('todo-list');
    const editor=document.getElementById('todo-editor');
    const editorHead=document.getElementById('todo-editor-head');
    const titleInput=document.getElementById('todo-title-input');
    const descInput=document.getElementById('todo-desc-input');
    const statusSelect=document.getElementById('todo-status-select');
    if(!loading||!errorBox||!empty||!list||!editor||!editorHead||!titleInput||!descInput||!statusSelect){return;}

    loading.style.display=todoState.loading?'block':'none';
    const inlineError=todoState.error&&todoState.error.message?String(todoState.error.message):'';
    errorBox.style.display=inlineError?'block':'none';
    errorBox.innerText=inlineError;

    const editorOpen=todoState.editor.mode==='create'||todoState.editor.mode==='edit';
    editor.classList.toggle('open',editorOpen);
    editorHead.innerText=todoState.editor.mode==='edit'?'编辑待办':'新增待办';
    titleInput.value=todoState.editor.title||'';
    descInput.value=todoState.editor.description||'';
    statusSelect.value=todoState.editor.status||'open';
    statusSelect.style.display=todoState.editor.mode==='edit'?'block':'none';

    const visibleTodos=isWorktreeSubview
        ? todoState.todos.filter((todo)=>String(todo.sourcePanel||'master')==='worktree')
        : todoState.todos;

    if(visibleTodos.length===0){
        empty.style.display='block';
        list.innerHTML='';
        return;
    }

    empty.style.display='none';
    list.innerHTML=visibleTodos.map((todo)=>{
        const safeId=escapeTodoHtml(todo.id);
        const safeTitle=escapeTodoHtml(todo.title||'');
        const safeDesc=escapeTodoHtml(todo.description||'');
        const statusLabel=todo.status==='done'?'已完成':todo.status==='promoted'?'已进入迭代':'进行中';
        const updatedAt=escapeTodoHtml(todo.updatedAt||'');
        const nextStatus=todo.status==='done'?'open':'done';
        const descHtml=safeDesc?'<div class="todo-item-desc">'+safeDesc+'</div>':'';
        const titleClass=todo.status==='done'?'todo-item-title done':'todo-item-title';
        const toggleLabel=todo.status==='done'?'标记未完成':'标记完成';
        const promoteLabel=todo.status==='promoted'?'再次进入迭代':'进入迭代';
        return '<div class="todo-item">'
            + '<div class="todo-item-head">'
            + '<div class="'+titleClass+'">'+safeTitle+'</div>'
            + '<span class="task-status">'+statusLabel+'</span>'
            + '</div>'
            + descHtml
            + '<div class="todo-item-meta">ID: '+safeId+' · 更新于 '+(updatedAt||'-')+'</div>'
            + '<div class="todo-item-actions">'
            + '<button class="action-btn action-btn--neutral" data-todo-action="toggle" data-todo-id="'+safeId+'" data-todo-next="'+nextStatus+'">'+toggleLabel+'</button>'
            + '<button class="action-btn action-btn--primary" data-todo-action="edit" data-todo-id="'+safeId+'">编辑</button>'
            + '<button class="action-btn action-btn--success" data-todo-action="promote" data-todo-id="'+safeId+'">'+promoteLabel+'</button>'
            + '<button class="action-btn action-btn--danger" data-todo-action="delete" data-todo-id="'+safeId+'">删除</button>'
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

    todoState.error=null;

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
    todoState.error=null;
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
    todoState.error=null;
    saveTodoState();
    renderTodoPanel();
    v.postMessage({type:'todo.delete',id});
}

/** Promote a todo into a new iteration task and remove it from the todo list. */
function promoteTodoToFeature(id){
    const todo=findTodoById(id);
    if(!todo){
        return;
    }
    todoState.todos=todoState.todos.filter((item)=>item.id!==id);
    todoState.error=null;
    saveTodoState();
    renderTodoPanel();
    v.postMessage({
        type:'todo.promoteToFeature',
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
        sourcePanel:todo.sourcePanel==='worktree'?'worktree':'master',
    }));
    todoState.loading=false;
    todoState.error=null;
    saveTodoState();
    renderTodoPanel();
}

/** Consume todo.error events and show an inline prompt in the todo panel. */
function handleTodoErrorEvent(message){
    todoState.loading=false;
    todoState.error={
        code:String(message&&message.code?message.code:'TODO-IO-002'),
        message:String(message&&message.message?message.message:'TODO-IO-002: 待办存储文件写入失败'),
        detail:message&&message.detail?String(message.detail):'',
    };
    saveTodoState();
    renderTodoPanel();
}

/** Handle API-1 success event and activate domain workspace panel. */
function handleDomainWorkspaceOpenedEvent(message){
    domainWorkspaceState.visible=true;
    domainWorkspaceState.loading=true;
    domainWorkspaceState.error='';
    domainWorkspaceState.taskId=message&&message.taskId?String(message.taskId):'';
    domainWorkspaceState.taskName=message&&message.taskName?String(message.taskName):'';
    domainWorkspaceState.iterationId=message&&message.iterationId?String(message.iterationId):domainWorkspaceState.taskId;
    domainWorkspaceState.iterationPath=message&&message.iterationPath?String(message.iterationPath):'';
    domainWorkspaceState.repoRoot=message&&message.repoRoot?String(message.repoRoot):'';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    focusDomainMaintenanceCard(message);
    requestDomainWorkspaceContext();
}

/** Handle API-2 response and render a concrete context snapshot. */
function handleDomainContextLoadedEvent(message){
    domainWorkspaceState.loading=false;
    const errorCode=message&&message.errorCode?String(message.errorCode):'';
    if(errorCode){
        domainWorkspaceState.error=errorCode;
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    const context=message&&message.context?message.context:null;
    if(!context){
        domainWorkspaceState.error='DOMAIN_WORKSPACE_LOAD_FAILED: 上下文为空';
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    domainWorkspaceState.error='';
    domainWorkspaceState.baselineVersion=String(context.baselineVersion||'');
    domainWorkspaceState.changeSet=context.draftChangeSet||null;
    const registryDomains=(context.registry&&Array.isArray(context.registry.domains))?context.registry.domains:[];
    domainWorkspaceState.existingDomains=registryDomains
        .map((d)=>d&&d.canonical?String(d.canonical):'')
        .filter(Boolean);
    domainWorkspaceState.conflicts=[];
    domainWorkspaceState.blocking=false;
    domainWorkspaceState.commitSummary=null;
    domainWorkspaceState.notice='';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    // Immediately surface naming conflicts so adjudication is one click away. Binds Req-4, Req-5.
    triggerDetectDomainConflicts();
}

/** Request conflict detection (naming / capability-key / baseline-version) for the current change set. */
function triggerDetectDomainConflicts(){
    const changeSet=domainWorkspaceState.changeSet;
    if(!changeSet||!Array.isArray(changeSet.domainChanges)||changeSet.domainChanges.length===0){
        domainWorkspaceState.conflicts=[];
        domainWorkspaceState.blocking=false;
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    domainWorkspaceState.detecting=true;
    domainWorkspaceState.notice='';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    v.postMessage({
        type:'detectDomainConflicts',
        changeSet:changeSet,
        baselineVersion:domainWorkspaceState.baselineVersion||(changeSet.basedOnBaselineVersion||''),
    });
}

/** Apply an adjudication decision for one conflict. Binds Req-5. */
function resolveDomainConflictAction(conflictId,action,domId){
    let decision=null;
    if(action==='create-canonical'){
        const canonicalEl=document.getElementById('dw-new-'+domId);
        const displayEl=document.getElementById('dw-dn-'+domId);
        const canonical=canonicalEl&&canonicalEl.value?String(canonicalEl.value).trim():'';
        if(!canonical){
            domainWorkspaceState.notice='请先填写新 canonical 名称';
            saveDomainWorkspaceState();
            renderDomainWorkspacePanel();
            return;
        }
        const displayName=displayEl&&displayEl.value?String(displayEl.value).trim():canonical;
        decision={action:'create-canonical',newCanonical:canonical,displayName:displayName};
    }else if(action==='merge-existing'||action==='append-alias'){
        const targetEl=document.getElementById('dw-target-'+domId);
        const target=targetEl&&targetEl.value?String(targetEl.value).trim():'';
        if(!target){
            domainWorkspaceState.notice='请选择一个已有 canonical 领域';
            saveDomainWorkspaceState();
            renderDomainWorkspacePanel();
            return;
        }
        decision=action==='merge-existing'
            ?{action:'merge-existing',targetCanonical:target}
            :{action:'append-alias',alias:target,targetCanonical:target};
    }else if(action==='choose-value'){
        decision={action:'choose-value',field:'canonicalDomain',chosenValue:''};
    }
    if(!decision){return;}
    v.postMessage({type:'resolveDomainConflict',conflictId:conflictId,decision:decision,changeSet:domainWorkspaceState.changeSet});
}

/** Handle conflict detection results pushed from the extension. */
function handleDomainConflictsDetectedEvent(message){
    domainWorkspaceState.detecting=false;
    if(message&&message.errorCode){
        domainWorkspaceState.notice='冲突检测失败: '+String(message.errorCode);
        domainWorkspaceState.conflicts=[];
        domainWorkspaceState.blocking=false;
    }else{
        domainWorkspaceState.conflicts=(message&&Array.isArray(message.conflicts))?message.conflicts:[];
        domainWorkspaceState.blocking=Boolean(message&&message.blocking);
        if(domainWorkspaceState.conflicts.length===0){
            domainWorkspaceState.notice='未检测到冲突，可直接写入沉淀';
        }else{
            domainWorkspaceState.notice='';
        }
    }
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
}

/** Handle a single conflict resolution result; re-run detection to refresh remaining conflicts. */
function handleDomainConflictResolvedEvent(message){
    if(message&&message.errorCode){
        domainWorkspaceState.notice='裁决失败: '+String(message.errorCode);
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    if(message&&message.updatedChangeSet){
        domainWorkspaceState.changeSet=message.updatedChangeSet;
    }
    domainWorkspaceState.conflicts=(message&&Array.isArray(message.remainingConflicts))?message.remainingConflicts:[];
    domainWorkspaceState.blocking=domainWorkspaceState.conflicts.some((c)=>c&&c.severity==='blocking');
    domainWorkspaceState.notice='已应用裁决，正在复检剩余冲突…';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    // Re-detect against the updated change set + refreshed registry to confirm resolution. Binds Req-4, Req-8.
    triggerDetectDomainConflicts();
}

/** Trigger the atomic commit that writes iteration delta + docs/domains baseline. Binds Req-3. */
function triggerCommitDomainKnowledge(){
    const changeSet=domainWorkspaceState.changeSet;
    if(!changeSet){return;}
    const blockingCount=(domainWorkspaceState.conflicts||[]).filter((c)=>c&&c.severity==='blocking').length;
    if(blockingCount>0){
        domainWorkspaceState.notice='仍有阻断冲突，无法提交';
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    domainWorkspaceState.committing=true;
    domainWorkspaceState.commitSummary=null;
    domainWorkspaceState.notice='';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    v.postMessage({
        type:'commitDomainKnowledgeChanges',
        changeSet:changeSet,
        baselineVersion:domainWorkspaceState.baselineVersion||(changeSet.basedOnBaselineVersion||''),
        expectedRevisions:changeSet.sourceRevisionSet,
        autoRebase:true,
        formatPolicy:'deterministic-v1',
        resolvedConflicts:[],
    });
}

/** Handle atomic commit result and surface the sedimentation summary. Binds Req-3. */
function handleDomainCommitResultEvent(message){
    domainWorkspaceState.committing=false;
    if(message&&message.errorCode){
        domainWorkspaceState.notice='沉淀失败: '+String(message.errorCode);
        domainWorkspaceState.commitSummary=null;
    }else{
        domainWorkspaceState.commitSummary=(message&&message.summary)?message.summary:null;
        domainWorkspaceState.notice='';
    }
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
}

/** Request a baseline rebase + reprojection to resolve a baseline-version conflict. Binds Req-4, Req-8. */
function triggerRefreshBaseline(){
    const changeSet=domainWorkspaceState.changeSet;
    if(!changeSet){return;}
    domainWorkspaceState.detecting=true;
    domainWorkspaceState.notice='正在拉取最新基线并重投影…';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    v.postMessage({
        type:'refreshBaselineAndReproject',
        changeSet:changeSet,
        currentBaselineVersion:domainWorkspaceState.baselineVersion||(changeSet.basedOnBaselineVersion||''),
        expectedRevisions:changeSet.sourceRevisionSet,
    });
}

/** Apply a rebase result: reconcile the change set onto the latest baseline, then re-detect. Binds Req-4, Req-8. */
function handleBaselineReprojectResultEvent(message){
    domainWorkspaceState.detecting=false;
    if(message&&message.errorCode){
        domainWorkspaceState.notice='基线同步失败: '+String(message.errorCode);
        saveDomainWorkspaceState();
        renderDomainWorkspacePanel();
        return;
    }
    const latest=message&&message.latestBaselineVersion?String(message.latestBaselineVersion):'';
    if(latest){
        domainWorkspaceState.baselineVersion=latest;
        if(domainWorkspaceState.changeSet){
            domainWorkspaceState.changeSet.basedOnBaselineVersion=latest;
            if(message.latestRevisions){
                domainWorkspaceState.changeSet.sourceRevisionSet=message.latestRevisions;
            }
        }
    }
    domainWorkspaceState.notice='已同步至最新基线，正在复检冲突…';
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    triggerDetectDomainConflicts();
}

/** Listen to extension pushed events so list can stay consistent without manual refresh. */
window.addEventListener('message',(event)=>{
    const message=event&&event.data?event.data:{};
    if(message.type==='todo.changed'){
        handleTodoChangedEvent(message);
    }else if(message.type==='todo.error'){
        handleTodoErrorEvent(message);
    }else if(message.type==='domainWorkspaceOpened'){
        handleDomainWorkspaceOpenedEvent(message);
    }else if(message.type==='domainContextLoaded'){
        handleDomainContextLoadedEvent(message);
    }else if(message.type==='domainConflictsDetected'){
        handleDomainConflictsDetectedEvent(message);
    }else if(message.type==='domainConflictResolved'){
        handleDomainConflictResolvedEvent(message);
    }else if(message.type==='domainCommitResult'){
        handleDomainCommitResultEvent(message);
    }else if(message.type==='baselineReprojectResult'){
        handleBaselineReprojectResultEvent(message);
    }else if(message.type==='capabilityDeltaGenerated'){
        handleCapabilityDeltaGeneratedEvent(message);
    }
});

/** Focus and highlight the domain-maintenance card after openDomainKnowledgeWorkspace route succeeds. */
function focusDomainMaintenanceCard(message){
    const card=document.getElementById('domain-workspace-panel');
    if(!card){
        return;
    }
    try{card.scrollIntoView({behavior:'smooth',block:'center'});}catch{}
    card.classList.add('dk-gov-card--focus');
    setTimeout(()=>card.classList.remove('dk-gov-card--focus'),1800);
    const taskId=message&&message.taskId?String(message.taskId):'';
    if(taskId){
        try{logWebviewEvent(taskId,'domainWorkspace.opened','focus-card');}catch{}
    }
}

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
    else if(action==='promote'){promoteTodoToFeature(id);}
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
function previousStage(s,id){v.postMessage({type:'previous',step:s,id})}
function rollbackDev(id){v.postMessage({type:'rollbackDev',id})}
function pass(id){v.postMessage({type:'pass',id})}
function refresh(){v.postMessage({type:'refresh'})}
function pushAll(id){v.postMessage({type:'pushAndNextStage',id})}
function commitToBaseline(id){v.postMessage({type:'commitToBaseline',id})}
function refreshChangeRequests(id){v.postMessage({type:'refreshChangeRequests',id})}
function startAuto(id){v.postMessage({type:'startAuto',id})}
function pauseAuto(id){v.postMessage({type:'pauseAuto',id})}
function nextFeature(id){v.postMessage({type:'nextFeature',id})}
function retry(subId,id){v.postMessage({type:'retryFeature',subId,id})}
function syncMainCode(id){v.postMessage({type:'syncMainCode',id})}
function openMasterWorkspace(){v.postMessage({type:'openMasterWorkspace'})}
function runCustomButton(id,buttonId){v.postMessage({type:'runCustomButton',id,buttonId})}
function applyCustomButtonSettingsState(){
    var uiState=loadCustomButtonSettingsState();
    var body=document.getElementById('customBtnSettingsBody');
    var toggle=document.getElementById('customBtnSettingsToggle');
    if(body&&toggle){
        if(uiState.expanded===true){body.removeAttribute('hidden');toggle.textContent='收起';}
        else{body.setAttribute('hidden','hidden');toggle.textContent='展开';}
    }
}
function toggleCustomButtonConfig(){
        var body=document.getElementById('customBtnSettingsBody');
        var toggle=document.getElementById('customBtnSettingsToggle');
        if(!body||!toggle){return;}
        var isHidden=body.hasAttribute('hidden');
    if(isHidden){body.removeAttribute('hidden');toggle.textContent='收起';saveCustomButtonSettingsState({expanded:true});}
    else{body.setAttribute('hidden','hidden');toggle.textContent='展开';saveCustomButtonSettingsState({expanded:false});}
}

function openCustomButtonConfigPanel(){
    var panel=document.getElementById('customBtnSettingsPanel');
    var body=document.getElementById('customBtnSettingsBody');
    var toggle=document.getElementById('customBtnSettingsToggle');
    if(body&&toggle&&body.hasAttribute('hidden')){
        body.removeAttribute('hidden');
        toggle.textContent='收起';
        saveCustomButtonSettingsState({expanded:true});
    }
    if(panel&&typeof panel.scrollIntoView==='function'){
        panel.scrollIntoView({behavior:'smooth',block:'start'});
    }
}
const INV=${JSON.stringify(inv).replace(/</g, '\u003c')};
const INIT_BTNS=${JSON.stringify(initialButtons).replace(/</g, '\u003c')};
const CB_READONLY=${customButtonEditable ? 'false' : 'true'};
function cbEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function cbListFor(){return INV.repoMono||[];}
function cbSlot(script){return script;}
function cbAllScriptCount(){return (INV.repoMono||[]).length;}
function cbRowHtml(b){
    b=b||{};
    var dis=CB_READONLY?' disabled':'';
    return '<div class="cb-row">'+
        '<input class="cb-name" placeholder="按钮名称（如 部署）" value="'+cbEsc(b.name||'')+'"'+dis+'>'+
        '<select class="cb-cmd" title="脚本" data-val="'+cbEsc(b.script||'')+'" onchange="cbOnScriptChange(this)"'+dis+'></select>'+
        '<input class="cb-args" placeholder="参数(可选)" value="'+cbEsc(b.args||'')+'"'+dis+'>'+
        '<button class="cb-del" onclick="removeCustomButton(this)"'+dis+'>✕</button>'+
        '</div>';
}
function cbOnScriptChange(el){el.setAttribute('data-val',el.value);cbRefreshScripts();}
function cbRefreshScripts(){
    var rows=[].slice.call(document.querySelectorAll('#cbList .cb-row'));
    var used={};
    rows.forEach(function(r){
        var cur=r.querySelector('.cb-cmd').getAttribute('data-val')||'';
        if(cur){var k=cbSlot(cur);used[k]=(used[k]||0)+1;}
    });
    rows.forEach(function(r){
        var cmd=r.querySelector('.cb-cmd');
        var cur=cmd.getAttribute('data-val')||'';
        var avail=cbListFor();
        var opts='<option value="">（选择脚本）</option>';
        var matched=false;
        avail.forEach(function(f){
            var isCur=(f===cur);
            if(!isCur){var k=cbSlot(f);if(used[k])return;}
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
    if(CB_READONLY)return;
    if(cbAllScriptCount()===0){var em=document.getElementById('cbEmpty');if(em){em.style.display='block';}return;}
    document.getElementById('cbList').insertAdjacentHTML('beforeend',cbRowHtml({}));
    cbRefreshScripts();
    var rows=[].slice.call(document.querySelectorAll('#cbList .cb-row'));
    if(rows.length>0){
        var newRow=rows[rows.length-1];
        var newCmd=newRow.querySelector('.cb-cmd');
        if(newCmd&&!newCmd.value){
            var firstOpt=[].slice.call(newCmd.options).find(function(o){return o.value;});
            if(firstOpt){newCmd.setAttribute('data-val',firstOpt.value);cbRefreshScripts();}
        }
    }
}
function removeCustomButton(btn){if(CB_READONLY)return;var r=btn.closest('.cb-row');if(r)r.remove();cbRefreshScripts();}
function saveCustomButtons(){
    if(CB_READONLY)return;
    var rows=document.querySelectorAll('#cbList .cb-row');
    var buttons=[];
    rows.forEach(function(r){
        var name=r.querySelector('.cb-name').value.trim();
        var script=r.querySelector('.cb-cmd').value.trim();
        var args=r.querySelector('.cb-args').value.trim();
        if(name&&script){buttons.push({name:name,scriptSource:'worktree',script:script,args:args});}
    });
    saveCustomButtonSettingsState({expanded:false});
    v.postMessage({type:'saveCustomButtons',buttons:buttons});
}
cbRenderAll();
applyCustomButtonSettingsState();
/** Send an AI quick-chat button click to the extension for dispatch. */
function ensureAiQuickChatNoticeBox(){
    var box=document.getElementById('aiQuickChatNotice');
    if(box){return box;}
    box=document.createElement('div');
    box.id='aiQuickChatNotice';
    box.style.cssText='display:none;position:fixed;right:16px;bottom:16px;max-width:320px;padding:10px 12px;border-radius:10px;background:#2b1010;border:1px solid #7a2000;color:#ffb4b4;font-size:12px;line-height:1.5;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.appendChild(box);
    return box;
}
/** Show a transient in-page warning when the quick-chat request cannot be posted from the webview. */
function showAiQuickChatNotice(message){
    var box=ensureAiQuickChatNoticeBox();
    if(!box){return;}
    box.textContent=String(message||'AI 快捷对话发送失败');
    box.style.display='block';
    clearTimeout(showAiQuickChatNotice._timer);
    showAiQuickChatNotice._timer=setTimeout(function(){box.style.display='none';},2600);
}
/** Send an AI quick-chat button click to the extension for dispatch. */
function runAiQuickChatButton(taskId,buttonId){
    if(!taskId||!buttonId){showAiQuickChatNotice('AI 快捷对话按钮参数缺失，无法发送');return;}
    try{v.postMessage({type:'runAiQuickChatButton',taskId,buttonId});}
    catch(error){showAiQuickChatNotice('AI 快捷对话发送请求失败：'+String(error&&error.message?error.message:error||'unknown'));}
}

function toggleAutoPoll(enable){v.postMessage({type:'toggleAutoPoll',enable})}
function setSubStatus(id,subId,status){v.postMessage({type:'setSubFeatureStatus',id,subId,status})}
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
function setFeatureDescEditing(id,editing){
    const nodes=getTaskDescNodes(id);
    if(nodes.root){nodes.root.classList.toggle('editing',editing);}
}
function autoGrowFeatureDescEditor(id){
    const nodes=getTaskDescNodes(id);
    const editor=nodes.editor;
    if(!editor){return;}
    editor.style.height='auto';
    editor.style.height=Math.min(Math.max(editor.scrollHeight,108),260)+'px';
}
function openFeatureDescEditor(id){
    const {root,editor,desc}=getTaskDescNodes(id);
    if(!root||!editor||!desc){logWebviewEvent(id,'taskDescEditor.open.missingNodes');return;}
    logWebviewEvent(id,'taskDescEditor.open');
    setFeatureDescEditing(id,true);
    editor.value=desc.innerText;
    autoGrowFeatureDescEditor(id);
    editor.focus();
    if(typeof editor.selectionStart==='number'){
        const len=editor.value.length;
        editor.selectionStart=len;
        editor.selectionEnd=len;
    }
}
function cancelFeatureDescEditor(id){
    const {root,editor,desc}=getTaskDescNodes(id);
    if(!root||!editor||!desc){logWebviewEvent(id,'taskDescEditor.cancel.missingNodes');return;}
    logWebviewEvent(id,'taskDescEditor.cancel');
    setFeatureDescEditing(id,false);
    editor.value=desc.innerText;
    autoGrowFeatureDescEditor(id);
}
function commitFeatureDescEditor(id){
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
        v.postMessage({type:'updateFeatureDesc',id:id,desc:nextDesc});
        logWebviewEvent(id,'taskDescEditor.save.postMessage','len='+nextDesc.length);
    }catch(error){
        var message=error&&error.message?error.message:String(error);
        try{logWebviewEvent(id,'taskDescEditor.save.error',message);}catch{}
        logWebviewEvent(id,'taskDescEditor.save.error.alert',message);
    }
}
function resetFeature(id){v.postMessage({type:'resetFeature',id})}
function openArtifact(id,artifact){v.postMessage({type:'openArtifact',id,artifact})}
function openFolderLocation(id,location){v.postMessage({type:'openFolderLocation',id,location})}
function syncCodeGraph(id){v.postMessage({type:'syncCodeGraph',id})}
function setFeatureAutomation(id,aa){v.postMessage({type:'setFeatureAutomation',id,aa})}
function setSpecDriftRepair(id,enabled){v.postMessage({type:'setSpecDriftRepair',id,enabled})}
function setFeatureAiProvider(id,ap){v.postMessage({type:'setFeatureAiProvider',id,ap})}
function pushDev(id){v.postMessage({type:'pushAndNextStage',id})}
function specReview(id){v.postMessage({type:'specDeltaReview',id})}
function openDomainKnowledgeWorkspace(id){
    domainWorkspaceState.visible=true;
    domainWorkspaceState.loading=true;
    domainWorkspaceState.error='';
    domainWorkspaceState.taskId=String(id||'');
    saveDomainWorkspaceState();
    renderDomainWorkspacePanel();
    // Send taskId; iterationPath will be resolved server-side from taskId.
    v.postMessage({type:'openDomainKnowledgeWorkspace',taskId:id,iterationPath:''})
}

document.addEventListener('DOMContentLoaded',()=>{
    const governanceButtons=document.querySelectorAll('[data-domain-action]');
    governanceButtons.forEach((button)=>{button.dataset.label=button.innerText;});
    setDomainActionLoading('');
    if(document.getElementById('workspace-todo-panel')){
        todoState.error=null;
        renderTodoPanel();
        v.postMessage({type:'todo.list'});
    }
    const domainPanel=document.getElementById('domain-workspace-panel');
    if(domainPanel){
        const domainTaskId=domainPanel.getAttribute('data-task-id')||'';
        if(domainTaskId&&!domainWorkspaceState.visible){
            openDomainKnowledgeWorkspace(domainTaskId);
        }else{
            renderDomainWorkspacePanel();
        }
    }else{
        renderDomainWorkspacePanel();
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
    remoteApiTokenStatuses: RemoteApiTokenStatusView[] = [],
): string {
    const readOnly = configMeta.readOnly === true;
    const disabled = readOnly ? 'disabled' : '';
    const inv = scriptInventory;
    const scriptsSubdir = inv.scriptsSubdir;
    const apScriptSelected = config.autoPollScript || DEFAULT_POLL_SCRIPT;
    const apScriptChoices = inv.master.includes(apScriptSelected) ? inv.master : [...inv.master, apScriptSelected];
    const apScriptOptions = apScriptChoices.length
        ? apScriptChoices.map(f => `<option value="${escapeHtml(f)}"${f === apScriptSelected ? ' selected' : ''}>${escapeHtml(f)}${inv.master.includes(f) ? '' : '（缺失）'}</option>`).join('')
        : '<option value="">（暂无脚本，请先点「创建/打开脚本」）</option>';
    const initialHooks = (config.lifecycleHooks?.worktreeOpen || []).map(h => ({
        script: h.script || '',
        scriptSource: h.scriptSource || 'worktree',
        args: h.args || '',
    }));
    const monorepoGitValue = config.monorepoGit || '';
    const primaryTokenStatuses = remoteApiTokenStatuses.filter(item => (item.boundRemotes || []).includes('origin'));
    const mirrorTokenStatuses = remoteApiTokenStatuses.filter(item => !(item.boundRemotes || []).includes('origin'));
    const primaryConfigured = primaryTokenStatuses.some(item => item.configured);
    const mirrorConfigured = mirrorTokenStatuses.some(item => item.configured);
    const primaryToggleLabel = primaryConfigured ? '已配置' : '未配置';
    const mirrorToggleLabel = mirrorConfigured ? '已配置' : '未配置';
    const primaryToggleClass = primaryConfigured ? 'git-token-toggle git-token-toggle--configured' : 'git-token-toggle git-token-toggle--unconfigured';
    const mirrorToggleClass = mirrorConfigured ? 'git-token-toggle git-token-toggle--configured' : 'git-token-toggle git-token-toggle--unconfigured';
    const renderTokenRow = (item: RemoteApiTokenStatusView) => {
        const statusText = item.configured ? '已配置' : '未配置';
        const statusClass = item.configured ? 'token-status token-status--ok' : 'token-status token-status--warn';
        const platformLabel = item.platform === 'gitlab' ? 'GitLab' : item.platform === 'github' ? 'GitHub' : 'Generic';
        const remotes = (item.boundRemotes || []).filter(Boolean).join('、');
        const remotesHint = remotes ? `关联远端：${escapeHtml(remotes)}` : '';
        return `<div class="token-row"><div class="token-meta"><div><b>${escapeHtml(item.domain || item.remoteName)}</b> · ${platformLabel}</div><div class="${statusClass}">${statusText}</div></div>${remotesHint ? `<div class="hint" style="margin-bottom:6px">${remotesHint}</div>` : ''}<div class="token-actions"><button type="button" class="token-btn token-btn--set" onclick="setRemoteApiToken('${escapeHtml(item.endpointKey)}')">设置 Token</button><button type="button" class="token-btn token-btn--test" onclick="testRemoteApiToken('${escapeHtml(item.endpointKey)}')">测试连接</button><button type="button" class="token-btn token-btn--clear" onclick="clearRemoteApiToken('${escapeHtml(item.endpointKey)}')">清除</button></div></div>`;
    };
    const primaryTokenRows = primaryTokenStatuses.length > 0
        ? primaryTokenStatuses.map(renderTokenRow).join('')
        : '<div class="hint">未检测到主仓域名，请先保存 Git 配置。</div>';
    const mirrorTokenRows = mirrorTokenStatuses.length > 0
        ? mirrorTokenStatuses.map(renderTokenRow).join('')
        : '<div class="hint">当前镜像地址未形成可配置域名。</div>';
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
.git-input-row{display:flex;gap:8px;align-items:stretch;margin-bottom:8px}
.git-input-row input{flex:1;margin:0}
.git-token-toggle{width:auto;min-width:72px;margin:0;padding:8px 12px;border-radius:8px;background:#2d2d33;color:#fff;border:1px solid #3d3d45;font-size:12px;cursor:pointer}
.git-token-toggle:hover{background:#373740}
.git-token-toggle--configured{background:#185c37;border-color:#2c7a4b;color:#d7fbe4}
.git-token-toggle--configured:hover{background:#1f7244}
.git-token-toggle--unconfigured{background:#6b4e16;border-color:#8a6521;color:#ffecbf}
.git-token-toggle--unconfigured:hover{background:#7d5c1a}
.git-token-panel{display:none;margin:0 0 8px 0;padding:8px;background:#202024;border:1px solid #34343a;border-radius:8px}
.token-row{border:1px solid #34343a;border-radius:8px;padding:10px;background:#232326;margin-bottom:8px}
.token-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;color:#d8d8dd;font-size:12px}
.token-actions{display:flex;gap:8px;flex-wrap:wrap}
.token-actions button{flex:1;min-width:120px;margin-top:0;padding:8px}
.token-btn{color:#fff;border:1px solid transparent}
.token-btn--set{background:#1f6feb;border-color:#2f81f7}
.token-btn--test{background:#0e7490;border-color:#0891b2}
.token-btn--clear{background:#9f1239;border-color:#be123c}
.token-status{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.token-status--ok{background:#163a24;color:#7ee2a8}
.token-status--warn{background:#4a3412;color:#ffd37a}
.fold{margin-top:10px;background:#1a1a1e;border:1px solid #323238;border-radius:8px;padding:8px}
.fold>summary{cursor:pointer;color:#d3d3d8;font-size:13px;list-style:none}
.fold>summary::-webkit-details-marker{display:none}
.fold[open]>summary{margin-bottom:8px;color:#fff}
.cb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.cb-row input,.cb-row select{margin:0;min-width:0;box-sizing:border-box}
.cb-name{flex:1 1 120px}
.cb-src{flex:1 1 110px}
.cb-cmd{flex:2 1 150px}
.cb-args{flex:1 1 110px}
.cb-del{width:auto;flex:0 0 auto;margin:0;padding:10px 14px;background:#ff3b30}
.cb-empty{margin:10px 0;padding:10px;border-radius:8px;background:#2b2308;border:1px solid #7a5d00;color:#ffd56a;font-size:12px}
.hook-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.hook-row input,.hook-row select{margin:0;min-width:0;box-sizing:border-box}
.hook-script{flex:2 1 150px}
.hook-source{flex:1 1 100px}
.hook-args{flex:2 1 150px}
.hook-del{width:auto;flex:0 0 auto;margin:0;padding:10px 14px;background:#ff3b30}
.aqc-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #2c2c30}
.aqc-row:last-child{border-bottom:none}
.aqc-row input,.aqc-row textarea{margin:0;min-width:0;box-sizing:border-box}
.aqc-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.aqc-field--label{flex:1 1 120px}
.aqc-field--content{flex:2 1 220px}
.aqc-label{width:100%}
.aqc-content{width:100%;resize:vertical;min-height:72px}
.aqc-input--invalid{outline:1px solid #ff6b6b;border-color:#ff6b6b}
.aqc-del{width:auto;flex:0 0 auto;margin:0;padding:10px 14px;background:#ff3b30;align-self:flex-start}
.aqc-error{font-size:11px;color:#ff6b6b;margin-top:2px;flex-basis:100%}
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
<h5>单一仓库（Monorepo）Git 地址</h5>
<div class="git-input-row">
<input id="mg" value="${monorepoGitValue}" placeholder="代码、文档、脚本位于同一仓库" ${disabled}>
<button id="tokenTogglePrimary" type="button" class="${primaryToggleClass}" data-collapsed-label="${primaryToggleLabel}" onclick="toggleTokenPanel('tokenPanelPrimary','tokenTogglePrimary')" ${disabled}>${primaryToggleLabel}</button>
</div>
<div id="tokenPanelPrimary" class="git-token-panel">
${primaryTokenRows}
</div>

<h5>基线分支（如 main、master 或 yourname/integration）</h5>
<input id="bb" value="${config.baseBranch || ''}" placeholder="如 main 或 yourname/integration" ${disabled}>
<details class="fold">
<summary>多镜像仓库地址（可选，推送基线分支时会同时推送到该仓库）</summary>
<div class="git-input-row">
<input id="gmg" value="${config.githubMirrorGit || ''}" placeholder="如 https://github.com/yourname/yourrepo.git" ${disabled}>
<button id="tokenToggleMirror" type="button" class="${mirrorToggleClass}" data-collapsed-label="${mirrorToggleLabel}" onclick="toggleTokenPanel('tokenPanelMirror','tokenToggleMirror')" ${disabled}>${mirrorToggleLabel}</button>
</div>
<div id="tokenPanelMirror" class="git-token-panel">
${mirrorTokenRows}
</div>
</details>
<div class="hint">Token 安全存储在 VS Code 凭据库，不写入仓库文件。</div>
<div class="hint">Token 按「平台 + 域名」全局复用：同一 VS Code 用户下，跨项目/跨 workspace 无需重复设置。</div>
<div class="hint">获取方式：GitLab 在 User Settings → Access Tokens；GitHub 在 Settings → Developer settings → Personal access tokens。</div>
<button onclick="saveGit()" style="background:#007aff" ${disabled}>💾 保存 Git 配置并初始化代码</button>
</div>

<div class="section">

<details class="fold" open>
<summary>⚙ 高级策略配置</summary>
<h5>开发会话模式</h5>
<select id="dcm" ${disabled}>
<option value="batch" ${config.devConversationMode !== 'single' ? 'selected' : ''}>按批次会话（1.x/2.x，默认）</option>
<option value="single" ${config.devConversationMode === 'single' ? 'selected' : ''}>只一个会话（全开发阶段复用）</option>
</select>
<div style="font-size:12px;opacity:0.75;margin:4px 0 8px">按批次模式下，跨批次切换（如 2.x → 3.x）会要求人工确认后才继续。</div>
<div class="toggle-row">
<span>命名保留语义（拼音/英文关键词）</span>
<input id="ins" type="checkbox" ${config.iterationNamingSemantic !== false ? 'checked' : ''} ${disabled}>
</div>
<h5>worktree 打开时同步目录（支持多项，按行/逗号/分号分隔）</h5>
<textarea id="wsd" rows="3" placeholder="例如：worktree/.github/instructions" ${disabled}>${config.worktreeSyncPaths || ''}</textarea>
<h5>项目结构提炼模式</h5>
<select id="prm" ${disabled}>
<option value="local" ${config.projectStructureRefineMode === 'local' ? 'selected' : ''}>仅本地规则提炼（快速）</option>
<option value="local+ai" ${config.projectStructureRefineMode !== 'local' ? 'selected' : ''}>本地提炼 + AI 二次审阅（更完整）</option>
</select>
<h5>Spec 产物根目录（默认 specs，人类文档仍在 docs）</h5>
<input id="srd" value="${config.specRootDir || 'specs'}" placeholder="specs" ${disabled}>
<h5>机器门禁力度（gateLevel）</h5>
<select id="gl" ${disabled}>
<option value="relaxed" ${config.gateLevel === 'relaxed' ? 'selected' : ''}>relaxed · 宽松（追溯仅查悬空引用，任务阶段需人工确认）</option>
<option value="standard" ${config.gateLevel === 'strict' || config.gateLevel === 'relaxed' ? '' : 'selected'}>standard · 标准（追溯全量闭环，任务阶段需人工确认）</option>
<option value="strict" ${config.gateLevel === 'strict' ? 'selected' : ''}>strict · 严格（追溯全量 + 更严格执行门禁，任务阶段需人工确认）</option>
</select>
<div class="inline-actions" style="flex-wrap:nowrap">
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
<span>Token 模式自动请求合并（受审批/CI/保护分支约束）</span>
<input id="tam" type="checkbox" ${config.tokenAutoMergeEnabled === true ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>Claude Code (面板) 预填后自动回车发送（仅 macOS，需授予编辑器「辅助功能」权限）</span>
<input id="pas" type="checkbox" ${config.aiPanelAutoSubmit !== false ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>首次创建 worktree 时自动构建 CodeGraph</span>
<input id="acg" type="checkbox" ${config.autoCodeGraphEnabled !== false ? 'checked' : ''} ${disabled}>
</div>
<div class="toggle-row">
<span>CodeGraph 开启时，若本机缺少 CLI 将自动尝试安装（无需单独开关）</span>
</div>
<div class="toggle-row">
<span>启用定期冷归档策略（周级调度）</span>
<input id="cae" type="checkbox" ${config.coldArchiveEnabled !== false ? 'checked' : ''} ${disabled}>
</div>
<h5>冷归档保留迭代数量（最小 1，默认 10）</h5>
<input id="car" type="number" min="1" value="${Math.max(1, Number(config.coldArchiveRetentionCount || 10))}" ${disabled}>
<button onclick="saveAdvancedConfig()" style="background:#007aff" ${disabled}>💾 保存高级策略</button>
</details>
</div>

<div class="section">
<div class="section-title">⚡ AI 快捷对话按钮</div>
<div class="hint">配置可一键发送给 AI 的快捷对话内容。每个按钮需填写<b>名称</b>（最长 64 字符）与<b>对话内容</b>（最长 4000 字符）。点击任务卡片旁路区中对应按钮后，内容将原文发送到当前会话的 AI。</div>
${readOnly ? '<div class="meta-box readonly" style="margin-bottom:8px">当前窗口为只读快照，AI 快捷对话按钮配置无法修改。</div>' : ''}
<div id="aqcList"></div>
<div id="aqcSaveError" style="display:none;margin:6px 0;padding:8px;background:#2b1010;border:1px solid #7a2000;border-radius:8px;color:#ff9090;font-size:12px"></div>
<div class="inline-actions">
<button onclick="addAiQuickChatButton()" style="background:#3a3a3f" ${disabled}>➕ 添加按钮</button>
<button onclick="saveAiQuickChatButtons()" style="background:#007aff" ${disabled}>💾 保存 AI 快捷对话按钮</button>
</div>
</div>

<div class="section">
<div class="section-title">⚡ 生命周期 Hook</div>
<div class="sub-title">Worktree 初始化后（worktree-open）</div>
<div class="hint">脚本在 Worktree 首次初始化完成后自动执行（仅首次，不重复触发）。每条 Hook 按顺序执行，若某条失败，后续仍继续执行。</div>
<div class="hint">脚本来源与自定义按钮一致，统一使用 <b>迭代脚本</b> = Worktree 中已提交的 <code>${escapeHtml(scriptsSubdir)}/</code>。</div>
<div id="hookList"></div>
<div style="margin-top:8px; padding:8px; background:#2a2a2d; border-radius:8px; display:none" id="hookEmpty">暂无配置的 Hook 脚本</div>
<div class="inline-actions">
<button onclick="addLifecycleHook()" style="background:#3a3a3f" ${disabled}>➕ 添加 Hook</button>
<button onclick="saveLifecycleHooks()" style="background:#007aff" ${disabled}>💾 保存 Hook 配置</button>
</div>
</div>

<div class="section">
<div class="section-title">自动轮询远程任务</div>
<div class="toggle-row">
<span>启用自动轮询远程任务</span>
<input id="ap_enabled" type="checkbox" ${config.autoPollEnabled ? 'checked' : ''} ${disabled} onchange="toggleAutoPollDetails()">
</div>
<div class="hint">开启后，到任意 worktree 的<b>子面板</b>即可启动自动轮询（同一时间只能开启一个 worktree）。脚本固定放在主目录的 <b>scripts/</b> 下，约定把拉取到的任务清单<b>打印到 stdout</b>；插件读取后仅当内容非空且与现有 todo.md 不同才覆盖当前 worktree 的 <b>todo.md</b>。</div>
<div id="ap_details" style="display:${config.autoPollEnabled ? 'block' : 'none'}">
<h5>轮询间隔（秒，最小 5）</h5>
<input id="ap_int" type="number" min="5" value="${config.autoPollIntervalSec || 60}" ${disabled}>
<h5>拉取脚本（从主目录 scripts/ 下选择，推荐 Node 脚本 pullTask.js）</h5>
<select id="ap_script" ${disabled}>${apScriptOptions}</select>
<div class="toggle-row" style="margin-top:10px">
<span>仅闲时生效（错峰定价，如 DeepSeek）</span>
<input id="ap_idle_only" type="checkbox" ${config.autoPollIdleOnly ? 'checked' : ''} ${disabled} onchange="toggleAutoPollIdleDetails()">
</div>
<div id="ap_idle_details" style="display:${config.autoPollIdleOnly ? 'block' : 'none'}">
<h5>工作日闲时时间段（可跨零点，默认 18:00–次日 08:00）</h5>
<input id="ap_idle_start" type="time" value="${escapeHtml(config.autoPollIdleWeekdayStart || DEFAULT_AUTO_POLL_IDLE_WEEKDAY_START)}" ${disabled}>
至
<input id="ap_idle_end" type="time" value="${escapeHtml(config.autoPollIdleWeekdayEnd || DEFAULT_AUTO_POLL_IDLE_WEEKDAY_END)}" ${disabled}>
<div class="hint">周末（周六、周日）全天视为闲时，无需设置；命中窗口外的轮询节拍会被静默跳过，不消耗调用。</div>
</div>
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

<script>
const v=acquireVsCodeApi();
function p(x){v.postMessage({type:'page',page:x})}
function saveGit(){v.postMessage({type:'saveGit',bb:document.getElementById('bb').value,mg:document.getElementById('mg').value,gmg:document.getElementById('gmg').value})}
function toggleTokenPanel(panelId,btnId){var panel=document.getElementById(panelId);if(!panel)return;var btn=document.getElementById(btnId);var open=panel.style.display!=='block';panel.style.display=open?'block':'none';if(btn){var collapsed=btn.getAttribute('data-collapsed-label')||'设置';btn.textContent=open?'收起':collapsed;btn.title=open?'收起':collapsed;}}
function setRemoteApiToken(endpointKey){v.postMessage({type:'setRemoteApiToken',endpointKey:endpointKey})}
function testRemoteApiToken(endpointKey){v.postMessage({type:'testRemoteApiToken',endpointKey:endpointKey})}
function clearRemoteApiToken(endpointKey){v.postMessage({type:'clearRemoteApiToken',endpointKey:endpointKey})}
function saveAdvancedConfig(){v.postMessage({type:'saveAdvancedConfig',dcm:document.getElementById('dcm').value,ins:document.getElementById('ins').checked,wsd:document.getElementById('wsd').value,prm:document.getElementById('prm').value,srd:document.getElementById('srd').value,gl:document.getElementById('gl').value,cct:document.getElementById('cct').value,afm:document.getElementById('afm').checked,tam:document.getElementById('tam').checked,pas:document.getElementById('pas').checked,acg:document.getElementById('acg').checked,cae:document.getElementById('cae').checked,car:parseInt(document.getElementById('car').value,10)||10})}
function initProjectStructure(){v.postMessage({type:'initProjectStructure'})}
function applyProjectStructurePreview(){v.postMessage({type:'applyProjectStructurePreview'})}
function openArtifactsIndex(){v.postMessage({type:'openArtifactsIndex'})}
function testAiProvider(){v.postMessage({type:'testAiProvider'})}
function saveAutoPollConfig(){v.postMessage({type:'saveAutoPollConfig',enabled:document.getElementById('ap_enabled').checked,interval:parseInt(document.getElementById('ap_int').value)||60,script:document.getElementById('ap_script').value.trim(),prompt:document.getElementById('ap_prompt').value,skipMarkers:document.getElementById('ap_skip').value,idleOnly:document.getElementById('ap_idle_only').checked,idleWeekdayStart:document.getElementById('ap_idle_start').value,idleWeekdayEnd:document.getElementById('ap_idle_end').value})}
function toggleAutoPollDetails(){const d=document.getElementById('ap_details');if(d)d.style.display=document.getElementById('ap_enabled').checked?'block':'none'}
function toggleAutoPollIdleDetails(){const d=document.getElementById('ap_idle_details');if(d)d.style.display=document.getElementById('ap_idle_only').checked?'block':'none'}
function createPollScriptTemplate(){v.postMessage({type:'createPollScriptTemplate'})}
const INV=${JSON.stringify(inv).replace(/</g, '\\u003c')};
const INIT_HOOKS=${JSON.stringify(initialHooks).replace(/</g, '\\u003c')};
const INIT_AQC_BTNS=${JSON.stringify((config.aiQuickChatButtons || []).map(b => ({ label: b.label, content: b.content }))).replace(/</g, '\\u003c')};
const CB_READONLY=${readOnly ? 'true' : 'false'};
function cbEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function cbListFor(source){
  if(source==='master')return INV.master||[];
  return INV.repoMono||[];
}
function hookSourceOptions(selected){
    return '<option value="worktree"'+(selected==='worktree'?' selected':'')+'>迭代脚本(scripts)</option>';
}
// Lifecycle Hooks (worktree-open)
function hookOnScriptChange(el){el.setAttribute('data-val',el.value);}
function hookOnSourceChange(el){var s=el.closest('.hook-row').querySelector('.hook-script');s.setAttribute('data-val','');hookRefreshScripts();}
function hookRefreshScripts(){
  var rows=[].slice.call(document.querySelectorAll('#hookList .hook-row'));
  rows.forEach(function(r){
    var src=r.querySelector('.hook-source').value;
    var cmd=r.querySelector('.hook-script');
    var cur=cmd.getAttribute('data-val')||'';
    var avail=cbListFor(src);
    var opts='<option value="">（选择脚本）</option>';
    var matched=false;
    avail.forEach(function(f){
      var isCur=(f===cur);
      if(isCur)matched=true;
      opts+='<option value="'+cbEsc(f)+'"'+(isCur?' selected':'')+'>'+cbEsc(f)+'</option>';
    });
    if(cur&&!matched){opts+='<option value="'+cbEsc(cur)+'" selected>'+cbEsc(cur)+'（缺失）</option>';}
    cmd.innerHTML=opts;
    cmd.value=cur;
    cmd.setAttribute('data-val',cmd.value);
  });
}
function hookRowHtml(h){
  h=h||{};
  var dis=CB_READONLY?' disabled':'';
  return '<div class="hook-row">'+
    '<select class="hook-script" title="脚本" data-val="'+cbEsc(h.script||'')+'" onchange="hookOnScriptChange(this)"'+dis+'></select>'+
    '<select class="hook-source" title="脚本来源" onchange="hookOnSourceChange(this)"'+dis+'>'+hookSourceOptions(h.scriptSource||'worktree')+'</select>'+
    '<input class="hook-args" placeholder="参数(可选，如 --legacy-peer-deps)" value="'+cbEsc(h.args||'')+'"'+dis+'>'+
    '<button class="hook-del" onclick="removeLifecycleHook(this)"'+dis+'>✕</button>'+
    '</div>';
}
function renderLifecycleHooks(){
  var list=document.getElementById('hookList');
  if(!list)return;
  list.innerHTML='';
  (INIT_HOOKS||[]).forEach(function(h){list.insertAdjacentHTML('beforeend',hookRowHtml(h));});
  hookRefreshScripts();
  updateHookEmpty();
}
function updateHookEmpty(){var e=document.getElementById('hookEmpty');if(e)e.style.display=(INIT_HOOKS||[]).length===0?'block':'none';}
function addLifecycleHook(){
  var list=document.getElementById('hookList');
  if(!list)return;
    INIT_HOOKS.push({script:'',scriptSource:'worktree',args:''});
  list.insertAdjacentHTML('beforeend',hookRowHtml({}));
  hookRefreshScripts();
  updateHookEmpty();
}
function removeLifecycleHook(btn){
  var r=btn.closest('.hook-row');
  if(r){
    var idx=[].slice.call(document.querySelectorAll('#hookList .hook-row')).indexOf(r);
    if(idx>=0)INIT_HOOKS.splice(idx,1);
    r.remove();
    updateHookEmpty();
  }
}
function saveLifecycleHooks(){
  var rows=document.querySelectorAll('#hookList .hook-row');
  var hooks=[];
  rows.forEach(function(r){
    var script=r.querySelector('.hook-script').value.trim();
    var scriptSource=r.querySelector('.hook-source').value;
    var args=r.querySelector('.hook-args').value.trim();
    if(script){hooks.push({script:script,scriptSource:scriptSource,args:args});}
  });
  v.postMessage({type:'saveLifecycleHooks',hooks:hooks});
}
// ── AI 快捷对话按钮 ──────────────────────────────────────────────────
function aqcRowHtml(b){
  b=b||{};
  var dis=CB_READONLY?' disabled':'';
  return '<div class="aqc-row">'+
        '<div class="aqc-field aqc-field--label">'+
            '<input class="aqc-label" placeholder="按钮名称（最长 64 字符）" maxlength="64" value="'+cbEsc(b.label||'')+'"'+dis+'>'+
            '<div class="aqc-error aqc-error--label" style="display:none"></div>'+
        '</div>'+
        '<div class="aqc-field aqc-field--content">'+
            '<textarea class="aqc-content" placeholder="对话内容（最长 4000 字符）" maxlength="4000"'+dis+'>'+cbEsc(b.content||'')+'</textarea>'+
            '<div class="aqc-error aqc-error--content" style="display:none"></div>'+
        '</div>'+
    '<button class="aqc-del" onclick="removeAiQuickChatButton(this)"'+dis+'>✕</button>'+
    '</div>';
}
/** Reset summary banner and field-level validation state before each save attempt. */
function clearAiQuickChatValidationState(){
    [].slice.call(document.querySelectorAll('#aqcList .aqc-label,#aqcList .aqc-content')).forEach(function(field){
        field.classList.remove('aqc-input--invalid');
    });
    [].slice.call(document.querySelectorAll('#aqcList .aqc-error')).forEach(function(box){
        box.style.display='none';
        box.textContent='';
    });
}
/** Render one field-level validation error next to its owning control. */
function setAiQuickChatFieldError(field,message){
    if(!field){return;}
    field.classList.add('aqc-input--invalid');
    var wrap=field.parentElement;
    var errorBox=wrap?wrap.querySelector('.aqc-error'):null;
    if(errorBox){errorBox.style.display='block';errorBox.textContent=message;}
}
/** Update the shared save banner for quick-chat validation or request failures. */
function setAiQuickChatSaveError(message){
    var errBox=document.getElementById('aqcSaveError');
    if(!errBox){return;}
    if(message){errBox.style.display='block';errBox.textContent=message;return;}
    errBox.style.display='none';
    errBox.textContent='';
}
function renderAiQuickChatButtons(){
  var list=document.getElementById('aqcList');
  if(!list)return;
  list.innerHTML='';
  (INIT_AQC_BTNS||[]).forEach(function(b){list.insertAdjacentHTML('beforeend',aqcRowHtml(b));});
    setAiQuickChatSaveError('');
}
function addAiQuickChatButton(){
  var list=document.getElementById('aqcList');
    setAiQuickChatSaveError('');
  if(list){list.insertAdjacentHTML('beforeend',aqcRowHtml({}));}
}
function removeAiQuickChatButton(btn){
  var r=btn.closest('.aqc-row');
    setAiQuickChatSaveError('');
  if(r)r.remove();
}
/** Validate rows client-side and send saveAiQuickChatButtons message if all pass. */
function saveAiQuickChatButtons(){
  var rows=[].slice.call(document.querySelectorAll('#aqcList .aqc-row'));
  var errors=[];
  var buttons=[];
    clearAiQuickChatValidationState();
  rows.forEach(function(r,i){
        var labelField=r.querySelector('.aqc-label');
        var contentField=r.querySelector('.aqc-content');
        var label=labelField.value;
        var content=contentField.value;
    var labelTrim=label.trim();
    var contentTrim=content.trim();
    var rowOk=true;
        if(labelTrim.length===0){
            errors.push('第'+(i+1)+'项名称不能为空白');
            setAiQuickChatFieldError(labelField,'名称不能为空白');
            rowOk=false;
        }else if(labelTrim.length>64){
            errors.push('第'+(i+1)+'项名称超过上限 64 字符');
            setAiQuickChatFieldError(labelField,'名称超过上限 64 字符');
            rowOk=false;
        }
        if(contentTrim.length===0){
            errors.push('第'+(i+1)+'项对话内容不能为空白');
            setAiQuickChatFieldError(contentField,'对话内容不能为空白');
            rowOk=false;
        }else if(contentTrim.length>4000){
            errors.push('第'+(i+1)+'项对话内容超过上限 4000 字符');
            setAiQuickChatFieldError(contentField,'对话内容超过上限 4000 字符');
            rowOk=false;
        }
    if(rowOk){buttons.push({label:label,content:content});}
  });
  if(errors.length>0){
        setAiQuickChatSaveError(errors.join('；'));
    return;
  }
    setAiQuickChatSaveError('');
    try{v.postMessage({type:'saveAiQuickChatButtons',taskId:'',buttons:buttons});}
    catch(error){setAiQuickChatSaveError('AI 快捷对话按钮保存请求失败：'+String(error&&error.message?error.message:error||'unknown'));}
}
renderLifecycleHooks();
renderAiQuickChatButtons();
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

// ── Domain Knowledge Workspace UI (Req-1..Req-4) ──────────────────

import {
    BaselineSyncState,
    CommitSummary,
    DomainChangeSet,
    DomainConflict,
    DomainProjectionResult,
    DomainRegistryEntry,
} from './models';

/**
 * UI-2: Render the DomainChangeEditor panel HTML.
 * Displays all change entries in the current iteration change set with inline editing support.
 * Binds Req-2, Req-6.
 */
export function buildDomainChangeEditorHtml(
    changeSet: DomainChangeSet,
    registryDomains: DomainRegistryEntry[],
    readOnly: boolean,
): string {
    const domainOptions = registryDomains
        .filter(d => d.status === 'active')
        .map(d => `<option value="${escapeHtml(d.canonical)}">${escapeHtml(d.displayName || d.canonical)}</option>`)
        .join('');
    const changeTypeOptions = ['add', 'update', 'deprecate', 'remove', 'move']
        .map(ct => `<option value="${escapeHtml(ct)}">${escapeHtml(ct)}</option>`)
        .join('');

    const changeRows = (changeSet.domainChanges || []).map((change, idx) => {
        const reqId = escapeHtml(change.reqId || '');
        const title = escapeHtml(change.title || '');
        const rawDomain = escapeHtml(change.rawDomain || '');
        const changeType = escapeHtml(change.changeType || 'add');
        const status = escapeHtml(change.status || 'active');
        if (readOnly) {
            return `<tr>
  <td>${reqId}</td>
  <td>${rawDomain}</td>
  <td>${title}</td>
  <td>${changeType}</td>
  <td>${status}</td>
</tr>`;
        }
        return `<tr data-idx="${idx}">
  <td><input class="dc-input" type="text" value="${reqId}" placeholder="Req-*" onchange="onChangeSetFieldChange(${idx},'reqId',this.value)"></td>
  <td><select class="dc-select" onchange="onChangeSetFieldChange(${idx},'rawDomain',this.value)">
    <option value="${rawDomain}">${rawDomain || '-- 选择领域 --'}</option>${domainOptions}
  </select></td>
  <td><input class="dc-input" type="text" value="${title}" placeholder="能力标题" onchange="onChangeSetFieldChange(${idx},'title',this.value)"></td>
  <td><select class="dc-select" onchange="onChangeSetFieldChange(${idx},'changeType',this.value)">
    ${changeTypeOptions.replace(`value="${changeType}"`, `value="${changeType}" selected`)}
  </select></td>
  <td>${status}</td>
</tr>`;
    }).join('');

    const addRowBtn = readOnly ? '' : `<button class="action-btn action-btn--primary" onclick="addDomainChange()">新增变更</button>`;
    const previewBtn = `<button class="action-btn action-btn--neutral" onclick="triggerPreviewProjection()">预览投影</button>`;

    return `<div class="domain-change-editor">
<div class="domain-editor-header">
  <span class="domain-editor-title">📝 领域变更编辑</span>
  <span class="domain-editor-meta">迭代: ${escapeHtml(changeSet.iterationId)} · 基线: ${escapeHtml(changeSet.basedOnBaselineVersion)}</span>
</div>
<table class="domain-change-table">
  <thead><tr><th>Req-ID</th><th>领域</th><th>能力标题</th><th>变更类型</th><th>状态</th></tr></thead>
  <tbody>${changeRows || '<tr><td colspan="5" class="dc-empty">暂无变更，点击"新增变更"开始</td></tr>'}</tbody>
</table>
<div class="domain-editor-actions">
  ${addRowBtn}
  ${previewBtn}
</div>
</div>`;
}

/**
 * UI-3: Render the DomainProjectionPreview panel HTML.
 * Displays the current baseline projection result with warnings and conflict indicators.
 * Read-only; must not trigger any file writes. Binds Req-2, Req-4.
 */
export function buildDomainProjectionPreviewHtml(
    projection: DomainProjectionResult | null,
    conflicts: DomainConflict[],
    warnings: string[],
): string {
    if (!projection) {
        return `<div class="domain-projection-preview">
<div class="domain-preview-empty">尚未生成投影，请点击"预览投影"。</div>
</div>`;
    }

    const blockingConflicts = conflicts.filter(c => c.severity === 'blocking');
    const conflictHtml = conflicts.length > 0
        ? `<div class="domain-conflicts${blockingConflicts.length > 0 ? ' domain-conflicts--blocking' : ''}">
  <div class="domain-conflicts-title">${blockingConflicts.length > 0 ? '⛔ 存在阻断冲突' : '⚠ 存在警告冲突'}</div>
  ${conflicts.map(c => `<div class="domain-conflict-item ${c.severity === 'blocking' ? 'conflict-blocking' : 'conflict-warn'}">
    [${escapeHtml(c.type)}] ${escapeHtml(c.message)}
  </div>`).join('')}
</div>` : '';

    const warningHtml = warnings.length > 0
        ? `<div class="domain-warnings">${warnings.map(w => `<div class="domain-warning-item">⚡ ${escapeHtml(w)}</div>`).join('')}</div>`
        : '';

    const domainSections = (projection.projectedDomains || []).map(doc => {
        const capRows = (doc.capabilities || [])
            .map(cap => `<tr><td>${escapeHtml(cap.reqId)}</td><td>${escapeHtml(cap.title)}</td><td>${escapeHtml(cap.status)}</td></tr>`)
            .join('');
        const contractRows = (doc.contracts || [])
            .map(c => `<tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.method)}</td><td>${escapeHtml(c.path)}</td><td>${escapeHtml(c.reqId)}</td></tr>`)
            .join('');
        const invariantRows = (doc.invariants || [])
            .map(inv => `<li>[${escapeHtml(inv.id)}] (${escapeHtml(inv.reqId)}) ${escapeHtml(inv.text)}</li>`)
            .join('');
        return `<details class="domain-doc-section" open>
  <summary>${escapeHtml(doc.canonicalDomain)}</summary>
  <div class="domain-doc-body">
    ${capRows ? `<table class="domain-mini-table"><thead><tr><th>Req-ID</th><th>能力标题</th><th>状态</th></tr></thead><tbody>${capRows}</tbody></table>` : '<p class="dc-empty">无能力项</p>'}
    ${contractRows ? `<table class="domain-mini-table"><thead><tr><th>契约 ID</th><th>Method</th><th>Path</th><th>Req-ID</th></tr></thead><tbody>${contractRows}</tbody></table>` : ''}
    ${invariantRows ? `<ul class="domain-invariant-list">${invariantRows}</ul>` : ''}
  </div>
</details>`;
    }).join('');

    return `<div class="domain-projection-preview">
<div class="domain-preview-header">
  <span class="domain-preview-title">🔍 基线投影预览</span>
  <span class="domain-preview-meta">基线版本: ${escapeHtml(projection.baselineVersion)}</span>
</div>
${conflictHtml}
${warningHtml}
<div class="domain-docs">${domainSections || '<div class="dc-empty">投影结果为空</div>'}</div>
</div>`;
}

/**
 * UI-4: Render the DomainConflictPanel HTML.
 * Blocking conflicts must remain explicitly visible until fully resolved.
 * Supports domain-name (merge-existing, append-alias, create-canonical),
 * capability-key (choose-value), and document-merge (keep-draft, keep-current, manual-merge).
 * Binds Req-4, Req-5.
 */
export function buildDomainConflictPanelHtml(
    conflicts: DomainConflict[],
    blocking: boolean,
    registryDomains: DomainRegistryEntry[],
): string {
    if (conflicts.length === 0) {
        return `<div class="domain-conflict-panel domain-conflict-panel--empty">
<div class="conflict-empty-msg">✅ 无冲突，可执行提交。</div>
</div>`;
    }

    const conflictItems = conflicts.map(conflict => {
        const isBlocking = conflict.severity === 'blocking';
        const typeBadge = isBlocking
            ? `<span class="conflict-badge conflict-badge--blocking">⛔ 阻断</span>`
            : `<span class="conflict-badge conflict-badge--warn">⚠ 警告</span>`;

        const decisionHtml = buildConflictDecisionHtml(conflict, registryDomains);

        return `<div class="conflict-item conflict-item--${isBlocking ? 'blocking' : 'warn'}" data-conflict-id="${escapeHtml(conflict.id)}">
  <div class="conflict-header">
    ${typeBadge}
    <span class="conflict-type">[${escapeHtml(conflict.type)}]</span>
    <span class="conflict-msg">${escapeHtml(conflict.message)}</span>
  </div>
  ${conflict.conflictingSections && conflict.conflictingSections.length > 0
    ? `<div class="conflict-sections">冲突分段：${conflict.conflictingSections.map(s => `<code>${escapeHtml(s)}</code>`).join(', ')}</div>`
    : ''}
  <div class="conflict-decision">
    ${decisionHtml}
  </div>
</div>`;
    }).join('');

    const panelClass = blocking ? 'domain-conflict-panel--blocking' : 'domain-conflict-panel--warn';
    const panelTitle = blocking ? '⛔ 存在阻断冲突，提交已锁定' : '⚠ 存在警告冲突';

    return `<div class="domain-conflict-panel ${panelClass}">
<div class="conflict-panel-title">${panelTitle}</div>
${conflictItems}
</div>`;
}

/**
 * Build the decision controls for one conflict based on its type.
 * Binds Req-5.
 */
function buildConflictDecisionHtml(conflict: DomainConflict, registryDomains: DomainRegistryEntry[]): string {
    const cid = escapeHtml(conflict.id);

    if (conflict.type === 'domain-name') {
        const canonicalOptions = registryDomains
            .filter(d => d.status === 'active')
            .map(d => `<option value="${escapeHtml(d.canonical)}">${escapeHtml(d.displayName || d.canonical)}</option>`)
            .join('');
        return `<div class="conflict-decision-row">
  <select id="dc-target-${cid}" class="dc-select">${canonicalOptions}</select>
  <button class="action-btn action-btn--neutral" onclick="resolveConflict('${cid}','merge-existing',document.getElementById('dc-target-${cid}').value)">合并到已有 canonical</button>
  <button class="action-btn action-btn--neutral" onclick="resolveConflict('${cid}','append-alias',document.getElementById('dc-target-${cid}').value)">追加别名</button>
  <input id="dc-new-${cid}" class="dc-input" type="text" placeholder="新 canonical slug">
  <input id="dc-dn-${cid}" class="dc-input" type="text" placeholder="displayName">
  <button class="action-btn action-btn--primary" onclick="resolveConflict('${cid}','create-canonical',null,document.getElementById('dc-new-${cid}').value,document.getElementById('dc-dn-${cid}').value)">创建受控新领域</button>
</div>`;
    }

    if (conflict.type === 'capability-key') {
        return `<div class="conflict-decision-row">
  <button class="action-btn action-btn--neutral" onclick="resolveConflict('${cid}','choose-value',null,null,null,'reqId')">确认能力主键</button>
</div>`;
    }

    if (conflict.type === 'baseline-version') {
        return `<div class="conflict-decision-row">
  <span class="conflict-hint">请先点击"同步基线并重投影"以解决版本漂移，无法手动裁决。</span>
</div>`;
    }

    if (conflict.type === 'document-merge') {
        const sections = (conflict.conflictingSections || []);
        const sectionDecisions = sections.map(sectionId => {
            const sid = escapeHtml(sectionId);
            return `<div class="section-decision">
  <code>${sid}</code>
  <button class="action-btn action-btn--neutral" onclick="resolveConflictSection('${cid}','${sid}','keep-draft')">保留草稿</button>
  <button class="action-btn action-btn--neutral" onclick="resolveConflictSection('${cid}','${sid}','keep-current')">保留当前</button>
  <button class="action-btn action-btn--primary" onclick="resolveConflictSection('${cid}','${sid}','manual-merge')">手工合并</button>
</div>`;
        }).join('');
        return `<div class="conflict-decision-row">${sectionDecisions || '<span class="conflict-hint">逐段裁决文档冲突。</span>'}</div>`;
    }

    return '';
}

/**
 * UI-5: Render the DomainCommitBar HTML.
 * Fixed at the bottom of the subpanel; commit is blocked when blocking conflicts exist.
 * Button labels must be Chinese: 写入沉淀 / 无变更 / 最近摘要. Binds Req-3, Req-8.
 */
export function buildDomainCommitBarHtml(
    canCommit: boolean,
    loading: boolean,
    summary: CommitSummary | null,
): string {
    const commitBtn = canCommit && !loading
        ? `<button class="action-btn action-btn--success" onclick="triggerCommitDomainKnowledge()">写入沉淀</button>`
        : `<button class="action-btn action-btn--success" disabled title="${loading ? '提交中…' : '存在未解决的阻断冲突，无法提交'}">写入沉淀</button>`;

    const noChangeBtn = `<button class="action-btn action-btn--neutral" onclick="triggerCommitDomainKnowledge()" title="本次没有实际领域变更，系统将返回无变更结果">无变更</button>`;

    const summaryBtn = summary
        ? `<button class="action-btn action-btn--neutral" onclick="showDomainCommitSummary()" title="处理领域: ${summary.processedDomains} 个，能力: ${summary.processedCapabilities} 个">最近摘要</button>`
        : '';

    const loadingIndicator = loading
        ? `<span class="commit-loading">提交中…</span>`
        : '';

    return `<div class="domain-commit-bar">
${loadingIndicator}
${commitBtn}
${noChangeBtn}
${summaryBtn}
</div>`;
}

/**
 * UI-6: Render the BaselineSyncBanner HTML.
 * Shows baseline staleness state and triggers refreshBaselineAndReproject.
 * Button label must be Chinese: 同步基线并重投影. Binds Req-4, Req-8.
 */
export function buildBaselineSyncBannerHtml(syncState: BaselineSyncState): string {
    if (!syncState.stale && !syncState.rebaseInProgress) {
        return '';
    }

    const statusMsg = syncState.rebaseInProgress
        ? `<span class="sync-status sync-status--active">正在自动 rebase 并重投影…</span>`
        : `<span class="sync-status sync-status--stale">基线已漂移，需要重新同步后才能提交</span>`;

    const syncBtn = syncState.rebaseInProgress
        ? `<button class="action-btn action-btn--neutral" disabled>同步基线并重投影</button>`
        : `<button class="action-btn action-btn--warning" onclick="triggerRefreshBaselineAndReproject()">同步基线并重投影</button>`;

    const latestVersionNote = syncState.latestBaselineVersion
        ? `<span class="sync-version">最新基线: ${escapeHtml(syncState.latestBaselineVersion)}</span>`
        : '';

    return `<div class="baseline-sync-banner${syncState.rebaseInProgress ? ' baseline-sync-banner--active' : ''}">
${statusMsg}
${latestVersionNote}
${syncBtn}
</div>`;
}
