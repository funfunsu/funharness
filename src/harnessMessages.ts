export type HarnessStep = 'req' | 'des' | 'tcs' | 'tsk' | 'dev';

export type HarnessMessage =
    | { type: 'page'; page: string }
    | { type: 'refresh' }
    | { type: 'sel'; key: string }
    | { type: 'initAgent' }
    | { type: 'saveGit'; fg: string; bg: string; mb: string; sb: string; dr: boolean }
    | { type: 'saveDevConfig'; bsc: string; bp: number; fsc: string; ts: string; cs: string; mc: number; aa: boolean; ar: boolean; am: boolean; cm: boolean; ad: boolean; sk: string; ck: string; ap: 'copilot-chat' | 'claude-cli' | 'manual'; cct: string; afm: boolean; wsd: string }
    | { type: 'testAiProvider' }
    | { type: 'create'; name: string; desc: string }
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
    | { type: 'openFolderLocation'; id: string; location: 'worktree' | 'frontend' | 'backend' | 'mainFrontend' | 'mainBackend' }
    | { type: 'openArtifact'; id: string; artifact: 'requirements' | 'design' | 'testcase' | 'tasks' | 'testScript' }
    | { type: 'next'; id: string; step: HarnessStep; targetStage?: HarnessStep }
    | { type: 'pass'; id: string }
    | { type: 'syncMainCode'; id: string }
    | { type: 'startService'; id: string; target: 'frontend' | 'backend' }
    | { type: 'completeDevWithPush'; id: string }
    | { type: 'pushAndNextStage'; id: string };
