export type HarnessStep = 'req' | 'des' | 'tcs' | 'tsk' | 'dev';

export type TodoSourcePanel = 'master' | 'worktree';
export type TodoStatus = 'open' | 'done' | 'promoted';
export type TodoPromotionPolicy = 'keep' | 'mark-promoted';

export interface TodoMessageItem {
    id: string;
    title: string;
    description: string | null;
    status: TodoStatus;
    createdAt: string;
    updatedAt: string;
}

export type HarnessMessage =
    | { type: 'page'; page: string }
    | { type: 'refresh' }
    | { type: 'openCustomPrompt'; step: HarnessStep }
    | { type: 'saveGit'; fg: string; bg: string; bb: string; dr: boolean; mg?: string; md?: { frontend?: string; backend?: string; docs?: string; scripts?: string }; mode?: 'mono' | 'multi' }
    | { type: 'saveAdvancedConfig'; pc: string; mc: number; am: boolean; cm: boolean; ad: boolean; sk: string; ck: string; wsd: string; cps: string; prm: 'local' | 'local+ai'; cct: string; afm: boolean; pas: boolean }
    | { type: 'initProjectStructure' }
    | { type: 'applyProjectStructurePreview' }
    | { type: 'openArtifactsIndex' }
    | { type: 'openMasterWorkspace' }
    | { type: 'testAiProvider' }
    | { type: 'create'; name: string; desc: string; quickMode?: boolean }
    | { type: 'logWebviewEvent'; id: string; event: string; detail?: string }
    | { type: 'requestEditTaskDesc'; id: string }
    | { type: 'updateTaskDesc'; id: string; desc: string }
    | { type: 'resetTask'; id: string }
    | { type: 'pushAll'; id: string }
    | { type: 'runAgent'; id: string; step: HarnessStep }
    | { type: 'startAuto'; id: string }
    | { type: 'pauseAuto'; id: string }
    | { type: 'nextTask'; id: string }
    | { type: 'retryTask'; id: string; subId: string }
    | { type: 'setSubTaskStatus'; id: string; subId: string; status: 'todo' | 'doing' | 'done' | 'failed' }
    | { type: 'setTaskAutomation'; id: string; aa: boolean; ar: boolean }
    | { type: 'setTaskAiProvider'; id: string; ap: string }
    | { type: 'openFolderLocation'; id: string; location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend' | 'mono' | 'mainMono' }
    | { type: 'openArtifact'; id: string; artifact: 'requirements' | 'design' | 'testcase' | 'tasks' | 'testScript' }
    | { type: 'next'; id: string; step: HarnessStep; targetStage?: HarnessStep }
    | { type: 'pass'; id: string }
    | { type: 'syncMainCode'; id: string }
    | { type: 'completeDevWithPush'; id: string }
    | { type: 'pushAndNextStage'; id: string }
    | { type: 'commitToBaseline'; id: string }
    | { type: 'saveCustomButtons'; buttons: { name: string; script?: string; args?: string; scriptSource?: string; command?: string; placement?: 'iteration' | 'main' }[] }
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
    | { type: 'todo.promoteToTask'; todoId: string; promotionPolicy: TodoPromotionPolicy }
    | { type: 'todo.changed'; reason: 'created' | 'updated' | 'deleted' | 'promoted' | 'reloaded'; todos: TodoMessageItem[] };
