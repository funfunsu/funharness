export type HarnessStep = 'req' | 'des' | 'tcs' | 'tsk' | 'dev';
export type ReviewStage = 'requirements' | 'design' | 'testcase';
export type ReviewPromptSource = 'custom' | 'default';
export type ReviewExecutionStatus = 'idle' | 'running' | 'completed' | 'failed';
export type ReviewExecutionResultStatus = 'running' | 'completed' | 'failed';

export interface StageContext {
    [key: string]: unknown;
}

export interface StageReviewOpenResult {
    reviewEnabled: true;
    defaultExecuted: false;
}

export interface StageReviewPromptResult {
    source: ReviewPromptSource;
    promptBody: string;
    composedPrompt: string;
}

export interface StageReviewSaveResult {
    savedVersion: number;
    updatedAt: string;
}

export interface StageReviewRunResult {
    reviewId: string;
    status: ReviewExecutionResultStatus;
    summary?: string;
    errorReason?: string;
}

export interface StageReviewStatusResult {
    status: ReviewExecutionStatus;
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
    | { type: 'runDomainBaselineAggregation'; id: string }
    | { type: 'reviewSuspectedDomains'; id: string }
    | { type: 'applyDomainAdjudication'; id: string }
    | { type: 'commitDomainBaseline'; id: string }
    | { type: 'previewDomainBaselineSummary'; id: string }
    | { type: 'openCustomPrompt'; step: HarnessStep }
    | { type: 'openStageReview'; stage: ReviewStage }
    | { type: 'saveStagePrompt'; stage: ReviewStage; promptBody: string }
    | { type: 'runStageReview'; stage: ReviewStage; context: StageContext }
    | { type: 'getLatestReviewStatus'; stage: ReviewStage }
    | { type: 'openCustomConstitution' }
    | { type: 'saveGit'; fg: string; bg: string; bb: string; dr: boolean; mg?: string; md?: { frontend?: string; backend?: string; docs?: string; scripts?: string }; mode?: 'mono' | 'multi' }
    | { type: 'saveAdvancedConfig'; pc: string; mc: number; am: boolean; cm: boolean; ad: boolean; sk: string; ck: string; wsd: string; cps: string; prm: 'local' | 'local+ai'; srd: string; gl: 'relaxed' | 'standard' | 'strict'; cct: string; afm: boolean; pas: boolean }
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
    | { type: 'pass'; id: string }
    | { type: 'syncMainCode'; id: string }
    | { type: 'completeDevWithPush'; id: string }
    | { type: 'pushAndNextStage'; id: string }
    | { type: 'commitToBaseline'; id: string }
    | { type: 'saveCustomButtons'; buttons: { name: string; script?: string; args?: string; scriptSource?: string; command?: string; placement?: 'iteration' | 'main' }[] }
    | { type: 'saveLifecycleHooks'; hooks: { script: string; scriptSource?: string; args?: string }[] }
    | { type: 'runCustomButton'; id: string; buttonId: string }
    | { type: 'runMainCustomButton'; buttonId: string }
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
