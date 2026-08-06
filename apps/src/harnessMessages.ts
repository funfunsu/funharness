export type HarnessStep = 'req' | 'des' | 'tcs' | 'tsk' | 'dev';

/** Key stages supported by stage-review workflow. */
export type ReviewStage = 'requirements' | 'design' | 'testcase' | 'tasks';

/** Minimal stage-review context passed from webview panel. */
export interface StageContext {
    taskId: string;
    stage: string;
    taskName: string;
    taskDesc: string;
    taskStage: string;
}

/** API-1 output: open stage review metadata. */
export interface StageReviewOpenResult {
    reviewEnabled: boolean;
    defaultExecuted: boolean;
}

/** API-2 output: resolved prompt source + composed prompt. */
export interface StageReviewPromptResult {
    source: 'custom' | 'default';
    promptBody: string;
    composedPrompt: string;
}

/** API-3 output: saved custom prompt version metadata. */
export interface StageReviewSaveResult {
    savedVersion: number;
    updatedAt: string;
}

/** API-4 output: async stage review trigger status. */
export interface StageReviewRunResult {
    reviewId: string;
    status: 'running' | 'failed';
    errorReason?: string;
}

/** API-5 output: latest informational review status. */
export interface StageReviewStatusResult {
    status: 'idle' | 'running' | 'completed' | 'failed';
    summary?: string;
    errorReason?: string;
}

export type TodoSourcePanel = 'master' | 'worktree';
export type TodoStatus = 'open' | 'done' | 'promoted';
export type TodoPromotionPolicy = 'keep' | 'mark-promoted' | 'remove';

export interface TodoMessageItem {
    id: string;
    title: string;
    description: string | null;
    status: TodoStatus;
    createdAt: string;
    updatedAt: string;
    sourcePanel: TodoSourcePanel;
}

export type HarnessMessage =
    | { type: 'page'; page: string }
    | { type: 'refresh' }
    | { type: 'generateCapabilityDelta'; id: string }
    // ── Domain Knowledge Workspace (Req-1..Req-8) ──────────────────
    /** API-1: Open the subpanel domain knowledge workspace. Binds Req-1. */
    | { type: 'openDomainKnowledgeWorkspace'; taskId: string; iterationPath: string }
    /** API-2: Load subpanel context (registry, baseline snapshot, draft change set). Binds Req-1, Req-2, Req-7. */
    | { type: 'loadDomainKnowledgeContext'; repoRoot: string; iterationId: string }
    /** API-3: Update the current iteration domain change set draft. Binds Req-2, Req-6. */
    | { type: 'updateDomainChangeSet'; changeSet: import('./models').DomainChangeSet }
    /** API-4: Preview the domain baseline projection (read-only, no file writes). Binds Req-2, Req-4, Req-8. */
    | { type: 'previewDomainProjection'; changeSet: import('./models').DomainChangeSet; baselineVersion: string }
    /** API-5: Detect and classify conflicts before commit. Binds Req-4, Req-5, Req-8. */
    | { type: 'detectDomainConflicts'; changeSet: import('./models').DomainChangeSet; baselineVersion: string }
    /** API-6: Apply a conflict resolution decision in the subpanel. Binds Req-4, Req-5. */
    | { type: 'resolveDomainConflict'; conflictId: string; decision: import('./models').ConflictDecision; changeSet?: import('./models').DomainChangeSet }
    /** API-7: Atomic commit of the domain change set. Binds Req-3, Req-6, Req-8. */
    | { type: 'commitDomainKnowledgeChanges'; changeSet: import('./models').DomainChangeSet; baselineVersion: string; expectedRevisions: import('./models').DomainRevisionSet; autoRebase: boolean; formatPolicy: 'deterministic-v1'; resolvedConflicts: import('./models').DomainConflictResolution[] }
    /** API-11: Refresh baseline and re-project after drift detection. Binds Req-4, Req-5, Req-8. */
    | { type: 'refreshBaselineAndReproject'; changeSet: import('./models').DomainChangeSet; currentBaselineVersion: string; expectedRevisions: import('./models').DomainRevisionSet }
    /** API-12: Detect three-way document merge conflicts. Binds Req-4, Req-5, Req-8. */
    | { type: 'detectDocumentMergeConflicts'; baseDocuments: import('./models').ProjectedDomainDocument[]; currentDocuments: import('./models').ProjectedDomainDocument[]; draftDocuments: import('./models').ProjectedDomainDocument[] }
    // ──────────────────────────────────────────────────────────────
    | { type: 'openCustomPrompt'; step: HarnessStep }
    | { type: 'openReviewCustomPrompt'; stage: ReviewStage }
    | { type: 'openStageReview'; stage: ReviewStage }
    | { type: 'saveStagePrompt'; stage: ReviewStage; promptBody: string }
    | { type: 'runStageReview'; stage: ReviewStage; context: StageContext }
    | { type: 'getLatestReviewStatus'; stage: ReviewStage }
    | { type: 'openCustomConstitution' }
    | { type: 'saveGit'; fg: string; bg: string; bb: string; dr: boolean; mg?: string; md?: { frontend?: string; backend?: string; docs?: string; scripts?: string }; mode?: 'mono' | 'multi' }
    | { type: 'saveAdvancedConfig'; pc: string; mc: number; am: boolean; dcm: 'batch' | 'single'; cm: boolean; ad: boolean; ibp: string; iwp: string; ins: boolean; iwl: number; sk: string; ck: string; wsd: string; cps: string; prm: 'local' | 'local+ai'; srd: string; gl: 'relaxed' | 'standard' | 'strict'; cct: string; afm: boolean; pas: boolean }
    | { type: 'initProjectStructure' }
    | { type: 'applyProjectStructurePreview' }
    | { type: 'openArtifactsIndex' }
    | { type: 'openMasterWorkspace' }
    | { type: 'testAiProvider' }
    | { type: 'create'; name: string; desc: string; quickMode?: boolean }
    | { type: 'logWebviewEvent'; id: string; event: string; detail?: string }
    | { type: 'requestEditFeatureDesc'; id: string }
    | { type: 'updateFeatureDesc'; id: string; desc: string }
    | { type: 'resetFeature'; id: string }
    | { type: 'pushAll'; id: string }
    | { type: 'runAgent'; id: string; step: HarnessStep }
    | { type: 'specDeltaReview'; id: string }
    | { type: 'startAuto'; id: string }
    | { type: 'pauseAuto'; id: string }
    | { type: 'nextFeature'; id: string }
    | { type: 'retryFeature'; id: string; subId: string }
    | { type: 'setSubFeatureStatus'; id: string; subId: string; status: 'todo' | 'doing' | 'done' | 'failed' }
    | { type: 'setFeatureAutomation'; id: string; aa: boolean; ar: boolean }
    | { type: 'setFeatureAiProvider'; id: string; ap: string }
    | { type: 'openFolderLocation'; id: string; location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend' | 'mono' | 'mainMono' }
    | { type: 'openArtifact'; id: string; artifact: 'requirements' | 'design' | 'testcase' | 'tasks' | 'testScript' }
    | { type: 'next'; id: string; step: HarnessStep; targetStage?: HarnessStep }
    | { type: 'previous'; id: string; step: HarnessStep }
    | { type: 'rollbackDev'; id: string }
    | { type: 'pass'; id: string }
    | { type: 'syncMainCode'; id: string }
    | { type: 'completeDevWithPush'; id: string }
    | { type: 'pushAndNextStage'; id: string }
    | { type: 'commitToBaseline'; id: string }
    | { type: 'saveCustomButtons'; buttons: { name: string; script?: string; args?: string; scriptSource?: string; command?: string }[] }
    | { type: 'saveLifecycleHooks'; hooks: { script: string; scriptSource?: string; args?: string }[] }
    | { type: 'runCustomButton'; id: string; buttonId: string }
    | { type: 'openScriptDir' }
    | { type: 'openHarnessLog' }
    | { type: 'saveAutoPollConfig'; interval: number; script: string; prompt: string; skipMarkers: string; enabled: boolean }
    | { type: 'createPollScriptTemplate' }
    | { type: 'toggleAutoPoll'; enable: boolean }
    | { type: 'todo.create'; sourcePanel: TodoSourcePanel; title: string; description: string | null }
    | { type: 'todo.update'; id: string; title: string; description: string | null; status: TodoStatus }
    | { type: 'todo.delete'; id: string }
    | { type: 'todo.list' }
    | { type: 'todo.promoteToFeature'; todoId: string; promotionPolicy: TodoPromotionPolicy }
    | { type: 'todo.changed'; reason: 'created' | 'updated' | 'deleted' | 'promoted' | 'reloaded'; todos: TodoMessageItem[] }
    | { type: 'todo.error'; code: string; message: string; detail?: string };
