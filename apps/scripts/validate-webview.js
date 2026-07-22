// Build-time guard: ensure every inline <script> block in generated webview HTML
// parses as valid JavaScript. A single syntax error in these large inline scripts
// silently disables ALL webview button handlers (they become undefined globals),
// so this check runs after every compile to prevent shipping a broken panel.
//
// Root-cause background: the webview HTML is assembled from TypeScript template
// literals. Hand-escaped nested quotes (e.g. \\' inside a template literal) are
// easy to get wrong and collapse into invalid JS. This guard catches that class of
// regression automatically instead of relying on manual testing in the panel.

const templates = require('../out/webviewTemplates.js');

/** Pull every <script>...</script> body out of an HTML string. */
function extractScripts(html) {
    const scripts = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = re.exec(html)) !== null) {
        scripts.push(match[1]);
    }
    return scripts;
}

/** Validate all script blocks in one generated page; collect any syntax errors. */
function validatePage(label, html, failures, options) {
    const requireScript = !options || options.requireScript !== false;
    const scripts = extractScripts(html);
    if (scripts.length === 0) {
        if (requireScript) {
            failures.push(`[${label}] expected at least one <script> block, found none`);
        }
        return;
    }
    scripts.forEach((body, index) => {
        try {
            // eslint-disable-next-line no-new-func
            new Function(body);
        } catch (error) {
            failures.push(`[${label}] script block #${index} syntax error: ${error.message}`);
        }
    });
}

const sampleTaskView = {
    task: {
        id: "t'1", name: 'demo', stage: 'req', desc: 'hello', worktreePath: '',
        autoAdvanceEnabled: true, autoRetryEnabled: false, aiProvider: 'copilot',
    },
    stats: { total: 1, done: 0, doing: 0, failed: 0, todo: 1 },
    pct: 0,
    subTasks: [{ id: 's1', title: 'sub', status: 'todo' }],
    isAuto: false,
    artifacts: {
        requirements: true, requirementsReady: true, design: true, designReady: true,
        testcase: true, tasks: true, testScript: true,
    },
    health: {
        worktreeExists: true, frontendExists: true, backendExists: true,
        mainFrontendExists: true, mainBackendExists: true, branchRouteReady: true,
        mergeRouteReady: true, severity: 'good', summary: 'ok',
    },
};

const customButtons = [
    { id: 'b1', name: 'Deploy', scriptSource: 'master', script: 'deploy.ps1', args: '', placement: 'iteration' },
    { id: 'b2', name: 'Main Btn', scriptSource: 'master', script: 'main.ps1', args: '', placement: 'main' },
];

const autoPoll = {
    enabledHere: false, intervalSec: 30, script: 'poll.ps1', scriptExists: true,
    activeElsewhereName: '', activeElsewhere: false,
};

const config = {
    frontendGit: '', backendGit: '', monorepoGit: 'https://example.com/repo.git',
    monorepoDirs: { frontend: 'apps', backend: 'apps', docs: 'docs', scripts: 'scripts' },
    baseBranch: 'main', mergeDryRunEnabled: true, techStack: '', codingStandards: '',
    projectConventions: '', maxConcurrentAutoTasks: 2, autoAdvanceEnabled: true,
    autoRepairEnabled: true, autoContinueAfterManualDone: true, compactTaskDecomposition: false,
    autoDetectTaskSplitMode: false, simpleTaskKeywords: '', complexTaskKeywords: '',
    aiProvider: 'copilot', cliCommandTemplate: '', aiFallbackToManual: true, aiPanelAutoSubmit: false,
    worktreeSyncPaths: '', projectStructureRefineMode: 'local',
    customButtons, autoPollEnabled: false, autoPollIntervalSec: 30, autoPollScript: 'poll.ps1',
    autoPoll,
};

const configMeta = { origin: 'master', masterRoot: 'C:/root', readOnly: false };
const scriptInventory = {
    mode: 'mono', scriptsSubdir: 'scripts', master: ['a.ps1'], repoMono: ['b.ps1'],
    repoFrontend: [], repoBackend: [], dirs: { master: 'C:/root/script', repoMono: 'C:/root/repos/mono-main/scripts' },
};

const failures = [];

const mainCfgBase = {
    compactTaskDecomposition: false, aiProvider: 'copilot', customButtons,
};
validatePage('main:empty', templates.buildMainPageHtml([], {}, { ...mainCfgBase, isWorktreeSubview: false }), failures);
validatePage('main:withTask', templates.buildMainPageHtml([sampleTaskView], {}, { ...mainCfgBase, isWorktreeSubview: false }), failures);
validatePage('main:worktree', templates.buildMainPageHtml([sampleTaskView], {}, { ...mainCfgBase, isWorktreeSubview: true, autoPoll }), failures);
validatePage('settings', templates.buildSettingsPageHtml(config, configMeta, scriptInventory), failures);
validatePage('settings:readonly', templates.buildSettingsPageHtml(config, { ...configMeta, readOnly: true, origin: 'worktreeSnapshot' }, scriptInventory), failures);
validatePage('error', templates.buildErrorPageHtml('Boom', 'details', 'ctx'), failures, { requireScript: false });

if (failures.length > 0) {
    console.error('\u274c Webview script validation FAILED:');
    for (const line of failures) {
        console.error('   - ' + line);
    }
    process.exit(1);
}

console.log('\u2705 Webview script validation passed (all inline scripts parse).');
