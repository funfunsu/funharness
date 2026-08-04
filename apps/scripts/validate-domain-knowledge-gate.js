'use strict';
// Gate script: domain-knowledge aggregate optimization.
// Validates traceability, route contracts, and subpanel boundary invariants.
// Exit 0 if all checks pass; exit 1 and print failures otherwise.
// Binds design §6 门禁测试 · HC-01 · INV-1 · Req-1..Req-8.

const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');
const testDir = path.join(__dirname, '..', 'test');

/** Read a source file relative to apps/src/. */
function readSrc(relPath) {
    return fs.readFileSync(path.join(srcDir, relPath), 'utf8');
}

const failures = [];
const passes = [];

/** Record a gate check result. */
function check(id, description, pass) {
    if (pass) {
        passes.push(`PASS [${id}] ${description}`);
    } else {
        failures.push(`FAIL [${id}] ${description}`);
    }
}

// ── Gate checks ────────────────────────────────────────────────────

// GATE-1: Legacy main-panel domain commands must NOT be registered (INV-1, Req-1)
const extensionSrc = readSrc('extension.ts');
const legacyCommands = [
    'fun-harness.runDomainBaselineAggregation',
    'fun-harness.reviewSuspectedDomains',
    'fun-harness.applyDomainAdjudication',
    'fun-harness.commitDomainBaseline',
    'fun-harness.previewDomainBaselineSummary',
];
for (const cmd of legacyCommands) {
    check(
        'GATE-1',
        `registerCommand('${cmd}') must NOT appear in extension.ts`,
        !extensionSrc.includes(`registerCommand('${cmd}'`),
    );
}

// GATE-2: New subpanel command must be registered (INV-2, Req-1)
check(
    'GATE-2',
    "registerCommand('fun-harness.openDomainKnowledgeWorkspace') must be present",
    extensionSrc.includes("registerCommand('fun-harness.openDomainKnowledgeWorkspace'"),
);

// GATE-3: unregisterLegacyDomainActions must be called at startup (ROUTE-7, INV-1)
check(
    'GATE-3',
    'unregisterLegacyDomainActions() must be called in extension.ts',
    extensionSrc.includes('unregisterLegacyDomainActions'),
);

// GATE-4: Legacy domain message cases must NOT exist in controller (INV-1, Req-1)
const controllerSrc = readSrc('harnessMessageController.ts');
const legacyCases = [
    "case 'runDomainBaselineAggregation':",
    "case 'reviewSuspectedDomains':",
    "case 'applyDomainAdjudication':",
    "case 'commitDomainBaseline':",
    "case 'previewDomainBaselineSummary':",
];
for (const c of legacyCases) {
    check(
        'GATE-4',
        `${c} must NOT appear in harnessMessageController.ts`,
        !controllerSrc.includes(c),
    );
}

// GATE-5: All 9 subpanel domain message routes must be present in controller (ROUTE-1..ROUTE-9)
const requiredRoutes = [
    "case 'openDomainKnowledgeWorkspace':",
    "case 'loadDomainKnowledgeContext':",
    "case 'updateDomainChangeSet':",
    "case 'previewDomainProjection':",
    "case 'detectDomainConflicts':",
    "case 'resolveDomainConflict':",
    "case 'commitDomainKnowledgeChanges':",
    "case 'refreshBaselineAndReproject':",
    "case 'detectDocumentMergeConflicts':",
];
for (const route of requiredRoutes) {
    check(
        'GATE-5',
        `${route} must be present in harnessMessageController.ts`,
        controllerSrc.includes(route),
    );
}

// GATE-6: commitDomainKnowledgeChanges handler must perform blocking-conflict check before commit (INV-5, Req-3, Req-4)
const commitCaseStart = controllerSrc.indexOf("case 'commitDomainKnowledgeChanges':");
const commitCaseEnd = controllerSrc.indexOf('return;', commitCaseStart);
const commitCaseBody = commitCaseStart >= 0 ? controllerSrc.slice(commitCaseStart, commitCaseEnd) : '';
check(
    'GATE-6',
    'commitDomainKnowledgeChanges handler must call detectConflicts before commitChangeSet',
    commitCaseBody.includes('detectConflicts'),
);
check(
    'GATE-6',
    'commitDomainKnowledgeChanges handler must check blocking before commitChangeSet',
    commitCaseBody.includes('blocking'),
);

// GATE-7: commitDomainKnowledgeChanges handler must call refreshBaselineAndReproject before commit (ROUTE-8, Req-4, Req-8)
check(
    'GATE-7',
    'commitDomainKnowledgeChanges handler must call refreshBaselineAndReproject when autoRebase',
    commitCaseBody.includes('refreshBaselineAndReproject'),
);

// GATE-8: harnessMessages.ts must NOT contain legacy domain message types (INV-1, Req-1)
const messagesSrc = readSrc('harnessMessages.ts');
const legacyMessageTypes = [
    'runDomainBaselineAggregation',
    'reviewSuspectedDomains',
    'applyDomainAdjudication',
    'commitDomainBaseline',
    'previewDomainBaselineSummary',
];
for (const t of legacyMessageTypes) {
    check(
        'GATE-8',
        `type: '${t}' must NOT appear in harnessMessages.ts`,
        !messagesSrc.includes(`type: '${t}'`),
    );
}

// GATE-9: DomainChange.reqId must be validated as non-empty Req-* pattern (INV-9, Req-6)
const aggregateSrc = readSrc('services/domainKnowledgeAggregateService.ts');
check(
    'GATE-9',
    'validateDomainChangeSetInput must enforce Req-* pattern on reqId',
    aggregateSrc.includes("reqId pattern") || aggregateSrc.includes('/^Req-\\d+$/') || aggregateSrc.includes("'Req-'") || aggregateSrc.includes("Req-<number>"),
);

// GATE-10: Path boundary assertion must guard every domain doc write (INV-10, Req-7)
check(
    'GATE-10',
    'assertPathInRepoRoot must be called in upsertDomainDocument',
    aggregateSrc.includes('assertPathInRepoRoot'),
);

// GATE-11: DomainChangeSet model must bind DomainRevisionSet for concurrency detection (Req-4, Req-8)
const modelsSrc = readSrc('models.ts');
check(
    'GATE-11',
    'DomainChangeSet must include sourceRevisionSet: DomainRevisionSet',
    modelsSrc.includes('sourceRevisionSet') && modelsSrc.includes('DomainRevisionSet'),
);

// GATE-12: CommitSummary must include writtenFiles field (Req-3, INV-7)
check(
    'GATE-12',
    'CommitSummary must include writtenFiles field',
    modelsSrc.includes('writtenFiles'),
);

// GATE-13: No Git-sync / branch-switch / code-commit routes in subpanel (Req-1)
const subpanelRoutes = [
    'syncMainCode',
    'commitToBaseline',
    'pushAll',
    'completeDevWithPush',
    'pushAndNextStage',
];
// These should NOT be in the worktree-allowlist of the controller.
// The worktree allowlist is the switch block in ensureWorktreeAllowed.
const allowListMatch = controllerSrc.match(/ensureWorktreeAllowed[\s\S]*?switch\s*\(msg\.type\)\s*\{([\s\S]*?)vscode\.window\.showWarningMessage/);
const allowListBlock = allowListMatch ? allowListMatch[1] : '';
for (const route of subpanelRoutes) {
    // These git-flow routes may appear in the controller but must not be in the subpanel domain section.
    // We only check that domain workspace section doesn't re-add git routes. This is a soft check.
    check(
        'GATE-13',
        `Git route '${route}' must not appear in domain knowledge section of controller`,
        !controllerSrc.slice(controllerSrc.indexOf("'openDomainKnowledgeWorkspace':")).includes(`'${route}'`),
    );
}

// GATE-14: Integration test file must exist and cover subpanel flow (Req-1..Req-5)
check(
    'GATE-14',
    'apps/test/domainKnowledgeFlow.test.js must exist',
    fs.existsSync(path.join(testDir, 'domainKnowledgeFlow.test.js')),
);
check(
    'GATE-14',
    'domainKnowledgeFlow.test.js must cover subpanel full flow integration test',
    (() => {
        const flowSrc = fs.readFileSync(path.join(testDir, 'domainKnowledgeFlow.test.js'), 'utf8');
        return flowSrc.includes('loadDomainKnowledgeContext') && flowSrc.includes('commitChangeSet');
    })(),
);

// ── Summary ────────────────────────────────────────────────────────

for (const p of passes) {
    console.log(p);
}
for (const f of failures) {
    console.error(f);
}

console.log(`\nTotal: ${passes.length + failures.length} checks — ${passes.length} passed, ${failures.length} failed.`);

if (failures.length > 0) {
    process.exit(1);
}
process.exit(0);
