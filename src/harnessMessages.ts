export type HarnessStep = 'req' | 'des' | 'tcs' | 'tsk' | 'dev';

export type HarnessMessage =
    | { type: 'page'; page: string }
    | { type: 'refresh' }
    | { type: 'restoreFactoryPrompts' }
    | { type: 'saveGit'; fg: string; bg: string; bb: string; dr: boolean }
    | { type: 'saveAdvancedConfig'; pc: string; mc: number; aa: boolean; ar: boolean; am: boolean; cm: boolean; ad: boolean; sk: string; ck: string; wsd: string; cps: string; prm: 'local' | 'local+ai'; cct: string; afm: boolean; pas: boolean }
    | { type: 'initProjectStructure' }
    | { type: 'applyProjectStructurePreview' }
    | { type: 'openArtifactsIndex' }
    | { type: 'openMasterWorkspace' }
    | { type: 'testAiProvider' }
    | { type: 'create'; name: string; desc: string; quickMode?: boolean }
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
    | { type: 'openFolderLocation'; id: string; location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend' }
    | { type: 'openArtifact'; id: string; artifact: 'requirements' | 'design' | 'testcase' | 'tasks' | 'testScript' }
    | { type: 'next'; id: string; step: HarnessStep; targetStage?: HarnessStep }
    | { type: 'pass'; id: string }
    | { type: 'syncMainCode'; id: string }
    | { type: 'completeDevWithPush'; id: string }
    | { type: 'pushAndNextStage'; id: string }
    | { type: 'commitToBaseline'; id: string }
    | { type: 'saveCustomButtons'; buttons: { name: string; command: string; workdir?: string }[] }
    | { type: 'runCustomButton'; id: string; buttonId: string }
    | { type: 'openScriptDir' }
    | { type: 'openHarnessLog' }
    | { type: 'saveAutoPollConfig'; interval: number; script: string; prompt: string; skipMarkers: string; enabled: boolean }
    | { type: 'createPollScriptTemplate' }
    | { type: 'toggleAutoPoll'; enable: boolean };
