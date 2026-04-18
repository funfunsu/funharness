"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMainPageHtml = buildMainPageHtml;
exports.buildSettingsPageHtml = buildSettingsPageHtml;
exports.buildErrorPageHtml = buildErrorPageHtml;
const models_1 = require("./models");
const TASK_ACTION_CONFIGS = [
    {
        key: 'req-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('req','${ctx.task.id}')">🤖 运行需求 Agent</button>`,
    },
    {
        key: 'req-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="btn-blue" onclick="next('req','${ctx.task.id}')">✅ 确认需求并进入设计</button>`,
    },
    {
        key: 'req-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_REQUIREMENT],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','requirements')">📄 查看需求产物</button>`,
    },
    {
        key: 'des-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('des','${ctx.task.id}')">🤖 运行设计 Agent</button>`,
    },
    {
        key: 'des-confirm-tcs',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-blue" onclick="next('des','${ctx.task.id}','tcs')">✅ 确认设计并进入测试</button>`,
    },
    {
        key: 'des-skip-tsk',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-blue" onclick="next('des','${ctx.task.id}','tsk')">⏭ 跳过测试直达任务</button>`,
    },
    {
        key: 'des-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_DESIGN],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','design')">📄 查看设计产物</button>`,
    },
    {
        key: 'tcs-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('tcs','${ctx.task.id}')">🤖 运行测试用例 Agent</button>`,
    },
    {
        key: 'tcs-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TESTCASE],
        render: (ctx) => `<button class="btn-blue" onclick="next('tcs','${ctx.task.id}')">✅ 确认测试用例</button>`,
    },
    {
        key: 'tcs-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TESTCASE, models_1.STAGE.WRITING_TASKS, models_1.STAGE.DEVELOPING],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','testcase')">📄 查看测试用例</button>`,
    },
    {
        key: 'test-script-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TESTCASE, models_1.STAGE.DEVELOPING],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','testScript')">🧪 查看测试脚本</button>`,
    },
    {
        key: 'tsk-run',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="btn-gray" onclick="runAgent('tsk','${ctx.task.id}')">🤖 运行任务 Agent</button>`,
    },
    {
        key: 'tsk-confirm',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TASKS],
        render: (ctx) => `<button class="btn-blue" onclick="next('tsk','${ctx.task.id}')">✅ 确认任务拆解</button>`,
    },
    {
        key: 'tasks-view',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.WRITING_TASKS, models_1.STAGE.DEVELOPING, models_1.STAGE.READY_FOR_REVIEW],
        render: (ctx) => `<button class="btn-gray" onclick="openArtifact('${ctx.task.id}','tasks')">📋 查看任务产物</button>`,
    },
    {
        key: 'dev-auto-toggle',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.DEVELOPING],
        when: (ctx) => !ctx.allSubTasksDone,
        render: (ctx) => ctx.taskView.isAuto
            ? `<button class="btn-orange" onclick="pauseAuto('${ctx.task.id}')">⏸ 暂停</button>`
            : `<button class="btn-green" onclick="startAuto('${ctx.task.id}')">▶ 自动执行</button>`,
    },
    {
        key: 'dev-next',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.DEVELOPING],
        when: (ctx) => !ctx.allSubTasksDone,
        render: (ctx) => `<button class="btn-gray" onclick="nextTask('${ctx.task.id}')">⏭ 下一个</button>`,
    },
    {
        key: 'dev-push-primary',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.DEVELOPING],
        render: (ctx) => `<button class="btn-blue" onclick="${ctx.isWorktreeSubview ? 'pushDev' : 'pushAll'}('${ctx.task.id}')">🚀 推送</button>`,
    },
    {
        key: 'review-pass',
        placement: 'primary',
        panels: ['main', 'worktree'],
        stages: [models_1.STAGE.READY_FOR_REVIEW],
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
        key: 'start-frontend',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree && ctx.hasFrontendStartCmd,
        render: (ctx) => `<button class="btn-gray" onclick="startService('${ctx.task.id}','frontend')">▶ 启动前端</button>`,
    },
    {
        key: 'start-backend',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree && ctx.hasBackendStartCmd,
        render: (ctx) => `<button class="btn-gray" onclick="startService('${ctx.task.id}','backend')">▶ 启动后端</button>`,
    },
    {
        key: 'manual-push',
        placement: 'side',
        panels: ['main', 'worktree'],
        stages: 'all',
        when: (ctx) => ctx.hasWorktree,
        render: (ctx) => `<button class="btn-gray" onclick="manualPush('${ctx.task.id}')">📤 手动提交代码</button>`,
    },
    {
        key: 'open-worktree',
        placement: 'side',
        panels: ['main'],
        stages: 'all',
        when: (ctx) => Boolean(ctx.task.worktreePath),
        render: (ctx) => `<button class="btn-gray" onclick="openFolderLocation('${ctx.task.id}','worktree')">📁 打开 Worktree</button>`,
    },
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
function collectTaskActions(ctx) {
    const primaryActions = [];
    const sideActions = [];
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
        }
        else {
            sideActions.push(rendered);
        }
    }
    return { primaryActions, sideActions };
}
function buildMainPageHtml(taskViews, dashboard, config) {
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

${isWorktreeSubview ? '<div class="mode-banner">子面板仅保留当前迭代任务操作，不提供高级设置与创建迭代功能。</div>' : ''}

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
        const showSubTasks = (t.stage === models_1.STAGE.WRITING_TASKS || t.stage === models_1.STAGE.DEVELOPING) && subTasks.length > 0;
        const canOperateSubTasks = t.stage === models_1.STAGE.DEVELOPING;
        const allSubTasksDone = t.stage === models_1.STAGE.DEVELOPING && stats.total > 0 && stats.done >= stats.total;
        const hasWorktree = Boolean(t.worktreePath) || health.worktreeExists || health.frontendExists || health.backendExists;
        const hasFrontendStartCmd = Boolean((config.frontendStartCmd || '').trim());
        const hasBackendStartCmd = Boolean((config.backendStartCmd || '').trim());
        const panelMode = isWorktreeSubview ? 'worktree' : 'main';
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
        const actionHtml = `
<div class="action-stack">
  ${primaryActions.length > 0 ? `<div class="action-label">主流程操作</div><div class="action-group">${primaryActions.join('')}</div>` : ''}
  ${sideActions.length > 0 ? `<div class="action-label">旁路操作</div><div class="action-group">${sideActions.join('')}</div>` : ''}
</div>`;
        return `
<div class="task-item" data-task-id="${t.id}" data-abnormal="${isAbnormal ? '1' : '0'}">
<div class="task-name">${t.name}</div>
<div class="task-desc">${t.desc}</div>
<div>阶段：${t.stage}</div>
<div class="task-status">原因：${health.summary || '-'}</div>
${view.latestFailureReason ? `<div class="task-status">最近失败：${view.latestFailureReason}</div>` : ''}
<div class="task-status">待办:${stats.todo} 执行中:${stats.doing} 完成:${stats.done}${stats.failed > 0 ? ` 失败:${stats.failed}` : ''}</div>
<div class="task-progress"><div class="progress-bar" style="width:${view.pct}%"></div></div>
<div style="font-size:12px">进度：${view.pct}%</div>

${!isWorktreeSubview ? `<details class="task-config">
<summary>⚙ 展开配置</summary>
<div class="task-config-body">
<div class="task-status">Worktree：${t.worktreePath || '-'}</div>
<div class="task-status">拆分模式：${effectiveSplitMode === 'compact' ? '急速模式' : '标准模式'}${config.compactTaskDecomposition ? '（全局配置）' : ''}</div>
<div class="task-status">基线分支：${t.baseSyncBranchUsed || '-'}</div>
<div class="task-status">分支路由：${t.iterationBranch || '-'} -> ${t.mergeTargetBranchUsed || '-'}</div>
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
    v.postMessage({type:'create',name,desc});
    document.getElementById('name').value='';
    document.getElementById('desc').value='';
}
function runAgent(s,id){v.postMessage({type:'runAgent',step:s,id})}
function next(s,id,ts){v.postMessage({type:'next',step:s,id,...(ts?{targetStage:ts}:{})})}
function pass(id){v.postMessage({type:'pass',id})}
function refresh(){v.postMessage({type:'refresh'})}
function pushAll(id){v.postMessage({type:'pushAndNextStage',id})}
function manualPush(id){v.postMessage({type:'pushAll',id})}
function startAuto(id){v.postMessage({type:'startAuto',id})}
function pauseAuto(id){v.postMessage({type:'pauseAuto',id})}
function nextTask(id){v.postMessage({type:'nextTask',id})}
function retry(subId,id){v.postMessage({type:'retryTask',subId,id})}
function syncMainCode(id){v.postMessage({type:'syncMainCode',id})}
function startService(id,target){v.postMessage({type:'startService',id,target})}
function setSubStatus(id,subId,status){v.postMessage({type:'setSubTaskStatus',id,subId,status})}
function editTaskDesc(id){v.postMessage({type:'requestEditTaskDesc',id})}
function resetTask(id){v.postMessage({type:'resetTask',id})}
function openArtifact(id,artifact){v.postMessage({type:'openArtifact',id,artifact})}
function openFolderLocation(id,location){v.postMessage({type:'openFolderLocation',id,location})}
function setTaskAutomation(id,aa,ar){v.postMessage({type:'setTaskAutomation',id,aa,ar})}
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
function buildSettingsPageHtml(config, selectedPromptKey, promptConfigs, configMeta) {
    const readOnly = configMeta.readOnly === true;
    const disabled = readOnly ? 'disabled' : '';
    const originLabel = configMeta.origin === 'worktreeSnapshot'
        ? '子 worktree 快照配置'
        : configMeta.origin === 'master'
            ? '主窗口配置'
            : '未标记配置';
    const opts = promptConfigs.map(o => `<option value="${o.key}" ${o.key === selectedPromptKey ? 'selected' : ''}>${o.name}</option>`).join('');
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
input,select{width:100%;padding:10px;border-radius:8px;border:none;background:#222;color:#fff;margin-bottom:8px}
button{width:100%;padding:10px;border-radius:8px;border:none;color:white;margin-top:10px}
.section{background:#1c1c1e;border-radius:10px;padding:12px;margin-bottom:12px}
.section-title{font-weight:600;margin-bottom:8px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;margin:8px 0;color:#ddd;font-size:13px}
.toggle-row input{width:auto;margin:0}
.meta-box{background:#2a2a2d;border:1px solid #3a3a3f;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;color:#ddd}
.meta-box.readonly{border-color:#7a5d00;background:#2b2308;color:#ffd56a}
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
<h5>个人合并分支（可选，如 yourname/integration）</h5>
<input id="mb" value="${config.mergeTargetBranch || ''}" ${disabled}>
<h5>任务初始化拉取基线分支（可选，优先于个人合并分支）</h5>
<input id="sb" value="${config.baseSyncBranch || ''}" placeholder="如 yourname/integration 或 main" ${disabled}>
<div class="toggle-row">
<span>合并前 dry-run 冲突检查</span>
<input id="dr" type="checkbox" ${config.mergeDryRunEnabled ? 'checked' : ''} ${disabled}>
</div>
<button onclick="saveGit()" style="background:#007aff" ${disabled}>💾 保存 Git 配置并初始化代码</button>
</div>

<div class="section">
<div class="section-title">开发环境配置</div>
<h5>后端启动命令（如 mvn spring-boot:run）</h5>
<input id="bsc" value="${config.backendStartCmd || ''}" ${disabled}>
<h5>后端端口（默认 8080）</h5>
<input id="bp" type="number" value="${config.backendPort || 8080}" ${disabled}>
<h5>前端启动命令（如 npm run dev）</h5>
<input id="fsc" value="${config.frontendStartCmd || ''}" ${disabled}>
<h5>技术栈描述</h5>
<input id="ts" value="${config.techStack || ''}" placeholder="如：前端 Vue3+TS，后端 SpringBoot3" ${disabled}>
<h5>编码规范</h5>
<input id="cs" value="${config.codingStandards || ''}" placeholder="如：小驼峰命名，方法加注释" ${disabled}>
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
<h5>AI 协作执行器</h5>
<select id="ap" ${disabled}>
<option value="copilot-chat" ${config.aiProvider === 'copilot-chat' ? 'selected' : ''}>Copilot Chat（默认）</option>
<option value="claude-cli" ${config.aiProvider === 'claude-cli' ? 'selected' : ''}>Claude CLI</option>
<option value="manual" ${config.aiProvider === 'manual' ? 'selected' : ''}>手工模式（仅生成提示词）</option>
</select>
<h5>Claude CLI 命令模板（可选）</h5>
<input id="cct" value="${config.claudeCliCommandTemplate || ''}" placeholder="例如：cat \"{promptFile}\" | claude" ${disabled}>
<div class="toggle-row">
<span>Claude CLI 失败时自动降级到手工模式</span>
<input id="afm" type="checkbox" ${config.aiFallbackToManual !== false ? 'checked' : ''} ${disabled}>
</div>
<h5>worktree 打开时同步目录（支持多项，按行/逗号/分号分隔）</h5>
<textarea id="wsd" rows="3" placeholder="例如：worktree/.github/instructions" ${disabled}>${config.worktreeSyncPaths || ''}</textarea>
<button onclick="testAiProvider()" style="background:#34c759" ${disabled}>🧪 测试当前 AI 执行器</button>
<button onclick="saveDevConfig()" style="background:#007aff" ${disabled}>💾 保存开发配置</button>
</div>

<div class="section">
<div class="section-title">恢复 Agent Prompt</div>
<select id="sel" onchange="sel()" ${disabled}>${opts}</select>
<button onclick="init()" style="background:#ff3b30" ${disabled}>恢复选定的 Agent Prompt 出厂设置</button>
</div>

<script>
const v=acquireVsCodeApi();
function p(x){v.postMessage({type:'page',page:x})}
function sel(){v.postMessage({type:'sel',key:document.getElementById('sel').value})}
function init(){if(confirm('确定恢复选定的 Agent Prompt 出厂设置？'))v.postMessage({type:'initAgent'})}
function saveGit(){v.postMessage({type:'saveGit',fg:document.getElementById('fg').value,bg:document.getElementById('bg').value,mb:document.getElementById('mb').value,sb:document.getElementById('sb').value,dr:document.getElementById('dr').checked})}
function saveDevConfig(){v.postMessage({type:'saveDevConfig',bsc:document.getElementById('bsc').value,bp:parseInt(document.getElementById('bp').value)||8080,fsc:document.getElementById('fsc').value,ts:document.getElementById('ts').value,cs:document.getElementById('cs').value,mc:parseInt(document.getElementById('mc').value)||2,aa:document.getElementById('aa').checked,ar:document.getElementById('ar').checked,am:document.getElementById('am').checked,cm:document.getElementById('cm').checked,ad:document.getElementById('ad').checked,sk:document.getElementById('sk').value,ck:document.getElementById('ck').value,ap:document.getElementById('ap').value,cct:document.getElementById('cct').value,afm:document.getElementById('afm').checked,wsd:document.getElementById('wsd').value})}
function testAiProvider(){v.postMessage({type:'testAiProvider'})}
</script>
</body>
</html>`;
}
function buildErrorPageHtml(title, details, context) {
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
//# sourceMappingURL=webviewTemplates.js.map