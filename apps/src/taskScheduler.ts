import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Config, GateLevel, SubTask, Task, getSpecDocsDir, resolveGateLevel, resolveTaskPlanFileForIteration } from './models';
import { appendHarnessLog } from './services/harnessLog';

export class TaskScheduler {
    private iterDir: string;
    private readonly workspaceRoot: string;
    private readonly docsDir: string;
    private watcher: vscode.FileSystemWatcher | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private autoMode: boolean = false;
    private timeoutTimer: NodeJS.Timeout | null = null;
    private handledSignals: Set<string> = new Set();
    private onStatusChange: () => void;
    private config: Config;
    private readonly dispatchAi: (query: string, iterDir: string, source: 'stage-agent' | 'dev-subtask', providerOverride?: string) => Promise<void>;
    private readonly getDevSystemPrompt: (subTask: SubTask, iterTask: Task) => string;

    constructor(
        iterDir: string,
        workspaceRoot: string,
        config: Config,
        dispatchAi: (query: string, iterDir: string, source: 'stage-agent' | 'dev-subtask') => Promise<void>,
        onStatusChange: () => void,
        getDevSystemPrompt: (subTask: SubTask, iterTask: Task) => string,
    ) {
        this.iterDir = iterDir;
        this.workspaceRoot = workspaceRoot;
        this.docsDir = getSpecDocsDir(iterDir, config);
        this.config = config;
        this.dispatchAi = dispatchAi;
        this.onStatusChange = onStatusChange;
        this.getDevSystemPrompt = getDevSystemPrompt;
    }

    private fillTemplateVars(template: string, vars: Record<string, string>): string {
        let rendered = template;
        for (const [key, value] of Object.entries(vars)) {
            const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rendered = rendered.replace(new RegExp(`{{\\s*${safeKey}\\s*}}`, 'g'), value);
        }
        return rendered;
    }

    private splitOutputEntries(raw: string): string[] {
        const text = String(raw || '').trim();
        if (!text) {
            return [];
        }
        return text
            .split(/[\n,，、;；]+/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    private parseDependencyEntries(raw: string): string[] {
        const text = String(raw || '').trim();
        if (!text) {
            return [];
        }

        const normalized = text.replace(/^[\[]|[\]]$/g, '').trim();
        if (!normalized) {
            return [];
        }

        const emptyTokens = new Set(['无', 'none', 'n/a', 'na', '[]', 'nil', 'null', '无依赖']);
        if (emptyTokens.has(normalized.toLowerCase())) {
            return [];
        }

        return normalized
            .split(/[,，]/)
            .map(item => item.trim())
            .filter(item => item.length > 0)
            .filter(item => !emptyTokens.has(item.toLowerCase()));
    }

    private parseInlineTracking(raw: string): { requirementIds: string[]; propertyIds: string[] } {
        const text = String(raw || '').trim();
        if (!text) {
            return { requirementIds: [], propertyIds: [] };
        }

        const blocks = Array.from(text.matchAll(/\[([^\]]*)\]/g)).map(match => match[1] || '');
        if (blocks.length === 0) {
            return { requirementIds: [], propertyIds: [] };
        }

        const parseIds = (block: string): string[] => block
            .split(/[,，]/)
            .map(item => item.trim())
            .filter(Boolean);

        const requirementIds = parseIds(blocks[0]).filter(id => /^Req-/i.test(id));
        const propertyIds = (blocks.length > 1 ? parseIds(blocks[1]) : [])
            .filter(id => /^INV-/i.test(id));

        return { requirementIds, propertyIds };
    }

    parseTasksMd(): SubTask[] {
        const file = this.resolveTaskPlanFile();
        if (!fs.existsSync(file)) return [];

        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        const tasks: SubTask[] = [];
        let current: SubTask | null = null;
        let currentField = '';

        for (const line of lines) {
            const taskMatch = line.match(/^\-\s*\[([ xX]|doing|failed)\]\s*(\d+\.\d+)\s+(.+)/i);
            if (taskMatch) {
                if (current) tasks.push(current);
                const statusRaw = taskMatch[1].trim().toLowerCase();
                let status: SubTask['status'] = 'todo';
                if (statusRaw === 'x') status = 'done';
                else if (statusRaw === 'doing') status = 'doing';
                else if (statusRaw === 'failed') status = 'failed';

                current = {
                    id: taskMatch[2],
                    name: taskMatch[3].trim(),
                    owner: '',
                    depends: [],
                    input: '',
                    output: [],
                    acceptance: [],
                    requirementIds: [],
                    propertyIds: [],
                    status,
                    rawLine: line
                };
                currentField = '';
                continue;
            }

            if (!current) continue;

            const trimmed = line.trim();
            if (trimmed.startsWith('- Owner:')) {
                current.owner = trimmed.replace('- Owner:', '').trim();
                currentField = '';
            } else if (trimmed.startsWith('- 依赖:') || trimmed.startsWith('- 依赖：')) {
                const depStr = trimmed.replace(/^- 依赖[：:]/, '').trim();
                current.depends = this.parseDependencyEntries(depStr);
                currentField = '';
            } else if (trimmed.startsWith('- 输入:') || trimmed.startsWith('- 输入：')) {
                current.input = trimmed.replace(/^- 输入[：:]/, '').trim();
                currentField = '';
            } else if (trimmed.startsWith('- 输出:') || trimmed.startsWith('- 输出：')) {
                const val = trimmed.replace(/^- 输出[：:]/, '').trim();
                if (val) current.output.push(...this.splitOutputEntries(val));
                currentField = 'output';
            } else if (trimmed.startsWith('- 验收:') || trimmed.startsWith('- 验收：')) {
                currentField = 'acceptance';
            } else if (trimmed.startsWith('- 追踪:') || trimmed.startsWith('- 追踪：')) {
                const trackingRaw = trimmed.replace(/^- 追踪[：:]/, '').trim();
                const parsed = this.parseInlineTracking(trackingRaw);
                if (parsed.requirementIds.length > 0) {
                    current.requirementIds = parsed.requirementIds;
                }
                if (parsed.propertyIds.length > 0) {
                    current.propertyIds = parsed.propertyIds;
                }
                currentField = 'tracking';
            } else if (trimmed.startsWith('- ') && currentField === 'output') {
                current.output.push(...this.splitOutputEntries(trimmed.replace(/^- /, '')));
            } else if (trimmed.startsWith('- ') && currentField === 'acceptance') {
                current.acceptance.push(trimmed.replace(/^- /, ''));
            } else if (trimmed.startsWith('- Requirements:') && currentField === 'tracking') {
                const raw = trimmed.replace('- Requirements:', '').trim();
                current.requirementIds = raw
                    .replace(/[\[\]]/g, '')
                    .split(/[,，]/)
                    .map(s => s.trim())
                    .filter(Boolean);
            } else if (trimmed.startsWith('- Properties:') && currentField === 'tracking') {
                const raw = trimmed.replace('- Properties:', '').trim();
                current.propertyIds = raw
                    .replace(/[\[\]]/g, '')
                    .split(/[,，]/)
                    .map(s => s.trim())
                    .filter(Boolean);
            }
        }

        if (current) tasks.push(current);
        return tasks;
    }

    getNextTask(): SubTask | null {
        const subTasks = this.parseTasksMd();
        const doneIds = new Set(subTasks.filter(t => t.status === 'done').map(t => t.id));
        return subTasks.find(t =>
            t.status === 'todo' &&
            t.depends.every(depId => doneIds.has(depId))
        ) || null;
    }

    getCurrentTask(): SubTask | null {
        const subTasks = this.parseTasksMd();
        return subTasks.find(t => t.status === 'doing') || null;
    }

    updateSubTaskStatus(taskId: string, newStatus: 'todo' | 'doing' | 'done' | 'failed'): void {
        const file = this.resolveTaskPlanFile();
        if (!fs.existsSync(file)) return;

        let content = fs.readFileSync(file, 'utf8');
        const statusMap: { [key: string]: string } = {
            todo: ' ',
            doing: 'doing',
            done: 'x',
            failed: 'failed'
        };
        const marker = statusMap[newStatus];

        content = content.replace(
            new RegExp(`^(-\\s*\\[)[^\\]]*?(\\]\\s*${taskId.replace('.', '\\.')}\\s)`, 'm'),
            `$1${marker}$2`
        );

        fs.writeFileSync(file, content, 'utf8');
    }

    buildDispatchQuery(subTask: SubTask, iterTask: Task): string {
        const signalsDir = path.join(this.iterDir, 'signals');
        const windowsTestScriptPath = path.join(this.iterDir, 'tests', `test-${subTask.id}.ps1`).replace(/\\/g, '/');
        const nonWindowsTestScriptPath = path.join(this.iterDir, 'tests', `test-${subTask.id}.sh`).replace(/\\/g, '/');

        const designFile = path.join(this.docsDir, 'design.md');
        const testcaseFile = path.join(this.docsDir, 'testcase.md');
        const docsRel = (path.relative(this.iterDir, this.docsDir).replace(/\\/g, '/')) || 'docs';
        const designContext = this.buildDesignContext(subTask);
        const requirementsContext = this.buildRequirementsContext(subTask);
        const testcaseContext = fs.existsSync(testcaseFile) ? this.buildTestcaseContext(subTask) : '';
        const manifestContext = this.buildManifestContext(subTask);
        const instructionContext = this.buildProjectInstructionContext();

        const outputFiles = subTask.output.length > 0
            ? subTask.output.map(f => `- ${f}`).join('\n')
            : '- (按任务描述生成对应文件)';

        const acceptanceCriteria = subTask.acceptance.length > 0
            ? subTask.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')
            : '- 代码可正常编译运行';

        const techStack = this.config.techStack || '(按项目现有技术栈)';
        const codingStandards = this.config.codingStandards || '变量采用小驼峰命名，方法需加注释';

        let dependencySection = '';
        if (subTask.depends.length > 0) {
            const allTasks = this.parseTasksMd();
            const depTasks = allTasks.filter(t => subTask.depends.includes(t.id));
            const depParts: string[] = [];

            for (const dep of depTasks) {
                let depInfo = `### 依赖任务 ${dep.id}: ${dep.name}\n- 状态：${dep.status}\n- 输出文件：`;
                const fileContents: string[] = [];

                for (const outputFile of dep.output) {
                    const candidates = [
                        path.join(this.iterDir, outputFile),
                        outputFile,
                    ];
                    let found = false;
                    for (const candidate of candidates) {
                        if (fs.existsSync(candidate)) {
                            const content = fs.readFileSync(candidate, 'utf8');
                            const truncated = content.length > 2000
                                ? content.substring(0, 2000) + '\n... (truncated)'
                                : content;
                            fileContents.push(`\n#### 文件: \`${outputFile}\`\n\`\`\`\n${truncated}\n\`\`\``);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        fileContents.push(`\n- \`${outputFile}\` (文件尚未生成，请根据设计文档推断)`);
                    }
                }

                depInfo += fileContents.join('\n');
                depParts.push(depInfo);
            }

            dependencySection = `\n## 前置依赖任务及其产出物\n\n**以下是本任务依赖的前置任务。它们的输出文件（如 API 协议、接口定义、数据模型等）是本任务的输入约束，请严格遵循。**\n\n${depParts.join('\n\n')}\n`;
        }

        const devSystemPrompt = this.fillTemplateVars(this.getDevSystemPrompt(subTask, iterTask), {
            taskName: subTask.name,
            taskDesc: iterTask.desc || '',
            subTaskId: subTask.id,
            subTaskName: subTask.name,
            subTaskOwner: subTask.owner,
            currentWorkSpace: this.iterDir,
            docsDir: docsRel,
            signalsDir,
            designContext: subTask.input || designContext,
            outputFiles,
            acceptanceCriteria,
            techStack,
            codingStandards,
            taskSplitMode: iterTask.taskSplitMode || 'standard',
        }).trim();
        const systemPromptSection = devSystemPrompt
            ? `${devSystemPrompt}\n\n=====================================================================\n# 当前要执行的具体任务（请严格按以下指令完成本次编码）\n\n`
            : '';
        const testcaseSection = testcaseContext
            ? `\n## 测试用例上下文（裁剪）\n${testcaseContext}\n`
            : '';

        return `${systemPromptSection}## 编码任务指令

- 任务ID：${subTask.id}
- 任务名称：${subTask.name}
- 任务描述：${iterTask.desc || '(无任务描述)'}
- 任务类型：${subTask.owner}
- 技术栈：${techStack}
- 当前工作空间（currentWorkSpace）：${this.iterDir}${subTask.depends.length > 0 ? `\n- 前置依赖任务：${subTask.depends.join(', ')}` : ''}

**重要：所有依赖的上下文文件（${docsRel}/design.md、${docsRel}/requirements.md、 ${docsRel}/tasks.md）均位于当前工作空间目录下，请优先在当前迭代目录内查找，不要去 workspace 根目录查找。**
${dependencySection}
## 输入依据
文件路径：\`${designFile}\`
${subTask.input || designContext}

## 需求上下文（裁剪）
${requirementsContext}
${testcaseSection}

## 测试清单上下文（裁剪）
${manifestContext}

## 项目规范上下文（workspaceRoot/.github/instructions）
${instructionContext}

**重要：若项目规范与通用规范冲突，以 workspaceRoot/.github/instructions 中的规则为最高优先级。**

## 输出要求
${outputFiles}

## 验收标准
${acceptanceCriteria}

## 编码规范
${codingStandards}

## 完成后必须执行
所有代码文件写完后，在 \`${signalsDir}/\` 目录下创建信号文件 \`done-${subTask.id}\`，内容为：
\`\`\`
taskId: ${subTask.id}
status: done
timestamp: {当前时间}
files:
  - {实际创建的文件路径列表}
\`\`\`
${subTask.owner === 'Backend' ? `\n如果验收标准包含接口验证条件，请生成验收脚本（平台差异如下）：\n- Windows: \`${windowsTestScriptPath}\`\n- Non-Windows: \`${nonWindowsTestScriptPath}\`\n脚本仅供人工触发验证，不自动执行。` : ''}`;
    }

    private buildRequirementsContext(subTask: SubTask): string {
        const reqFile = path.join(this.docsDir, 'requirements.md');
        if (!fs.existsSync(reqFile)) {
            return '(无 docs/requirements.md)';
        }
        const content = fs.readFileSync(reqFile, 'utf8');
        const machineReadable = this.extractRequirementsMachineReadableContext(content, subTask.requirementIds, 1800);
        if (machineReadable) {
            return machineReadable;
        }
        return this.extractContextByKeywords(content, subTask.requirementIds, 1200);
    }

    private extractRequirementsMachineReadableContext(content: string, requirementIds: string[], maxLen: number): string {
        const sectionIdx = content.indexOf('## 机器可读区');
        const scanText = sectionIdx >= 0 ? content.slice(sectionIdx) : content;
        const fenceMatch = scanText.match(/```ya?ml\s*([\s\S]*?)```/i);
        if (!fenceMatch) {
            return '';
        }

        const yamlBody = fenceMatch[1].trim();
        if (!yamlBody) {
            return '';
        }

        const lines = yamlBody.split('\n');
        const reqHeaderIdx = lines.findIndex(line => /^\s*requirements\s*:\s*$/.test(line));
        if (reqHeaderIdx < 0) {
            const raw = `\`\`\`yaml\n${yamlBody}\n\`\`\``;
            return raw.length > maxLen ? raw.substring(0, maxLen) : raw;
        }

        const reqSet = new Set((requirementIds || []).map(id => id.trim()).filter(Boolean));
        if (reqSet.size === 0) {
            const raw = `\`\`\`yaml\n${yamlBody}\n\`\`\``;
            return raw.length > maxLen ? raw.substring(0, maxLen) : raw;
        }

        const metaLines = lines.slice(0, reqHeaderIdx);
        const reqLine = lines[reqHeaderIdx];
        const selectedBlocks: string[] = [];

        let currentId = '';
        let currentBlock: string[] = [];
        const flushBlock = () => {
            if (currentId && reqSet.has(currentId) && currentBlock.length > 0) {
                selectedBlocks.push(currentBlock.join('\n'));
            }
            currentId = '';
            currentBlock = [];
        };

        for (let i = reqHeaderIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            const idMatch = line.match(/^\s*-\s*id\s*:\s*([^\s#]+)\s*$/i);
            if (idMatch) {
                flushBlock();
                currentId = idMatch[1].trim();
                currentBlock = [line];
                continue;
            }
            if (currentBlock.length > 0) {
                currentBlock.push(line);
            }
        }
        flushBlock();

        if (selectedBlocks.length === 0) {
            return '';
        }

        const selectedYaml = [
            ...metaLines,
            reqLine,
            ...selectedBlocks,
        ].join('\n').trim();

        const wrapped = `\`\`\`yaml\n${selectedYaml}\n\`\`\``;
        return wrapped.length > maxLen ? wrapped.substring(0, maxLen) : wrapped;
    }

    private buildDesignContext(subTask: SubTask): string {
        const designFile = path.join(this.docsDir, 'design.md');
        if (!fs.existsSync(designFile)) {
            return '(无设计文档)';
        }

        const content = fs.readFileSync(designFile, 'utf8');
        const yamlBody = this.extractMachineReadableYamlBody(content);
        const keywordIds = Array.from(new Set([...(subTask.requirementIds || []), ...(subTask.propertyIds || [])]));

        if (yamlBody) {
            const idSet = new Set(keywordIds.map(id => id.trim()).filter(Boolean));
            const apiBlocks = this.extractYamlListBlocksForIds(yamlBody, 'apiContracts', idSet, ['requirementIds', 'requirementId', 'id']);
            const invariantBlocks = this.extractYamlListBlocksForIds(yamlBody, 'invariants', idSet, ['requirementIds', 'requirementId', 'propertyIds', 'propertyId', 'id']);
            const selectedYaml = this.composeSelectedYaml(yamlBody, [
                { key: 'apiContracts', blocks: apiBlocks },
                { key: 'invariants', blocks: invariantBlocks },
            ]);

            if (selectedYaml) {
                const wrapped = `\`\`\`yaml\n${selectedYaml}\n\`\`\``;
                return wrapped.length > 1800 ? wrapped.substring(0, 1800) : wrapped;
            }

            const raw = `\`\`\`yaml\n${yamlBody}\n\`\`\``;
            return raw.length > 1800 ? raw.substring(0, 1800) : raw;
        }

        return this.extractContextByKeywords(content, keywordIds, 1200);
    }

    private buildTestcaseContext(subTask: SubTask): string {
        const testcaseFile = path.join(this.docsDir, 'testcase.md');
        if (!fs.existsSync(testcaseFile)) {
            return '(无 docs/testcase.md)';
        }
        const content = fs.readFileSync(testcaseFile, 'utf8');
        const yamlBody = this.extractMachineReadableYamlBody(content);
        if (yamlBody) {
            const reqSet = new Set((subTask.requirementIds || []).map(id => id.trim()).filter(Boolean));
            const testBlocks = [
                ...this.extractYamlListBlocksForIds(yamlBody, 'testCases', reqSet, ['requirementIds', 'requirementId', 'id']),
                ...this.extractYamlListBlocksForIds(yamlBody, 'testcases', reqSet, ['requirementIds', 'requirementId', 'id']),
            ];
            const selectedYaml = this.composeSelectedYaml(yamlBody, [{ key: 'testCases', blocks: testBlocks }]);
            if (selectedYaml) {
                const wrapped = `\`\`\`yaml\n${selectedYaml}\n\`\`\``;
                return wrapped.length > 1600 ? wrapped.substring(0, 1600) : wrapped;
            }

            // When tracked requirement IDs exist, never fall back to full testcase YAML.
            // Returning the whole file pollutes subtask prompts with unrelated Req contexts.
            if (reqSet.size > 0) {
                const ids = Array.from(reqSet).join(', ');
                return `(未在 docs/testcase.md 机器可读区匹配到追踪需求的测试用例: ${ids})`;
            }

            const raw = `\`\`\`yaml\n${yamlBody}\n\`\`\``;
            return raw.length > 1600 ? raw.substring(0, 1600) : raw;
        }
        return this.extractContextByKeywords(content, subTask.requirementIds, 1200);
    }

    private extractMachineReadableYamlBody(content: string): string {
        const sectionIdx = content.indexOf('## 机器可读区');
        const scanText = sectionIdx >= 0 ? content.slice(sectionIdx) : content;
        const fenceMatch = scanText.match(/```ya?ml\s*([\s\S]*?)```/i);
        return fenceMatch ? fenceMatch[1].trim() : '';
    }

    private extractYamlListBlocksForIds(
        yamlBody: string,
        listKey: string,
        ids: Set<string>,
        candidateFields: string[],
    ): string[] {
        const lines = yamlBody.split('\n');
        const headerIdx = lines.findIndex(line => new RegExp(`^\\s*${listKey}\\s*:\\s*$`).test(line));
        if (headerIdx < 0) {
            return [];
        }

        const blocks: string[] = [];
        let currentBlock: string[] = [];
        const flush = () => {
            if (currentBlock.length === 0) {
                return;
            }
            const blockText = currentBlock.join('\n');
            if (this.blockMatchesIds(blockText, ids, candidateFields)) {
                blocks.push(blockText);
            }
            currentBlock = [];
        };

        for (let i = headerIdx + 1; i < lines.length; i++) {
            const line = lines[i];

            // End when reaching the next top-level yaml key.
            if (/^[A-Za-z_][\w-]*\s*:\s*$/.test(line)) {
                break;
            }

            if (/^\s*-\s+/.test(line)) {
                flush();
                currentBlock = [line];
                continue;
            }

            if (currentBlock.length > 0) {
                currentBlock.push(line);
            }
        }
        flush();
        return blocks;
    }

    private blockMatchesIds(block: string, ids: Set<string>, candidateFields: string[]): boolean {
        if (ids.size === 0) {
            return true;
        }
        for (const id of ids) {
            const idEscaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const direct = new RegExp(`\\b${idEscaped}\\b`);
            if (!direct.test(block)) {
                continue;
            }
            // Prefer matches that appear in known id-related fields.
            for (const field of candidateFields) {
                const fieldEscaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const inField = new RegExp(`${fieldEscaped}\\s*:\\s*(\\[[^\\]]*${idEscaped}[^\\]]*\\]|${idEscaped})`, 'i');
                if (inField.test(block)) {
                    return true;
                }
            }
            // Fallback: id appears in block text.
            return true;
        }
        return false;
    }

    private composeSelectedYaml(yamlBody: string, sections: Array<{ key: string; blocks: string[] }>): string {
        const pickedSections = sections.filter(section => section.blocks.length > 0);
        if (pickedSections.length === 0) {
            return '';
        }

        const lines = yamlBody.split('\n');
        const meta = lines.filter(line => /^\s*(artifactType|taskName)\s*:/.test(line));
        const out: string[] = [...meta];

        for (const section of pickedSections) {
            out.push(`${section.key}:`);
            out.push(...section.blocks);
        }

        return out.join('\n').trim();
    }

    private buildManifestContext(subTask: SubTask): string {
        const manifestFile = path.join(this.iterDir, 'tests', 'test-manifest.json');
        if (!fs.existsSync(manifestFile)) {
            return '(无 tests/test-manifest.json)';
        }
        try {
            const data = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
                testCases?: Array<{ id?: string; requirementIds?: string[]; api?: { method?: string; path?: string } }>;
            };
            const reqSet = new Set(subTask.requirementIds);
            const filtered = (data.testCases || []).filter(tc =>
                (tc.requirementIds || []).some(id => reqSet.has(id))
            );
            const view = filtered.length > 0 ? filtered : (data.testCases || []).slice(0, 5);
            return view.length > 0 ? JSON.stringify(view, null, 2) : '(manifest 中无可用测试用例)';
        } catch {
            return '(test-manifest.json 解析失败)';
        }
    }

    private extractContextByKeywords(content: string, keywords: string[], maxLen: number): string {
        if (!keywords || keywords.length === 0) {
            return content.substring(0, maxLen);
        }

        const lines = content.split('\n');
        const snippets: string[] = [];
        const seen = new Set<string>();

        for (const keyword of keywords) {
            const idx = lines.findIndex(line => line.includes(keyword));
            if (idx < 0) {
                continue;
            }
            const start = Math.max(0, idx - 8);
            const end = Math.min(lines.length, idx + 9);
            const snippet = lines.slice(start, end).join('\n').trim();
            if (snippet && !seen.has(snippet)) {
                seen.add(snippet);
                snippets.push(snippet);
            }
        }

        if (snippets.length === 0) {
            return content.substring(0, maxLen);
        }
        const merged = snippets.join('\n\n---\n\n');
        return merged.length > maxLen ? merged.substring(0, maxLen) : merged;
    }

    private buildProjectInstructionContext(maxLen: number = 2600): string {
        const instructionsDir = path.join(this.workspaceRoot, '.github', 'instructions');
        if (!fs.existsSync(instructionsDir)) {
            return `(未发现规范目录：${instructionsDir})`;
        }

        const files = this.collectMarkdownFiles(instructionsDir, 3);
        if (files.length === 0) {
            return '(.github/instructions 下无 markdown 规范文件)';
        }

        const sections: string[] = [];
        let used = 0;
        for (const file of files) {
            const rel = path.relative(this.iterDir, file).replace(/\\/g, '/');
            const raw = fs.readFileSync(file, 'utf8').trim();
            if (!raw) {
                continue;
            }
            const body = raw.length > 700 ? `${raw.substring(0, 700)}\n... (truncated)` : raw;
            const block = `### ${rel}\n${body}`;
            if (used + block.length > maxLen) {
                break;
            }
            sections.push(block);
            used += block.length;
        }

        return sections.length > 0
            ? sections.join('\n\n')
            : '(.github/instructions 存在，但未读取到可用规范内容)';
    }

    private collectMarkdownFiles(dir: string, maxDepth: number, currentDepth: number = 0): string[] {
        if (currentDepth > maxDepth || !fs.existsSync(dir)) {
            return [];
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];

        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...this.collectMarkdownFiles(full, maxDepth, currentDepth + 1));
                continue;
            }
            if (entry.isFile() && /\.md$/i.test(entry.name)) {
                files.push(full);
            }
        }

        return files.sort();
    }

    private resolveTaskPlanFile(): string {
        return resolveTaskPlanFileForIteration(this.iterDir, this.config);
    }

    private clearStaleSignal(taskId: string): void {
        const signalFile = path.join(this.iterDir, 'signals', `done-${taskId}`);
        if (!fs.existsSync(signalFile)) {
            return;
        }
        try {
            fs.unlinkSync(signalFile);
            this.writeLog(taskId, `🧹 已清理陈旧信号文件: done-${taskId}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeLog(taskId, `⚠️ 清理陈旧信号失败: done-${taskId} | ${message}`);
        }
    }

    async dispatchTask(subTask: SubTask, iterTask: Task): Promise<void> {
        fs.mkdirSync(path.join(this.iterDir, 'signals'), { recursive: true });
        fs.mkdirSync(path.join(this.iterDir, 'tests'), { recursive: true });
        fs.mkdirSync(path.join(this.iterDir, 'logs'), { recursive: true });

        this.handledSignals.delete(subTask.id);
        this.clearStaleSignal(subTask.id);

        this.updateSubTaskStatus(subTask.id, 'doing');
        this.onStatusChange();

        const query = this.buildDispatchQuery(subTask, iterTask);
        await this.dispatchAi(query, this.iterDir, 'dev-subtask', iterTask.aiProvider);

        this.startTimeout(subTask.id);
    }

    async dispatchNext(iterTask: Task): Promise<boolean> {
        const next = this.getNextTask();
        if (next) {
            await this.dispatchTask(next, iterTask);
            return true;
        }
        // No 'todo' available. Only celebrate when literally everything is done.
        // If there are still 'doing' tasks, stay silent and wait — they'll trigger
        // dispatchNext again on completion. If there are 'failed' or dependency-blocked
        // tasks, also stay silent so the user doesn't get a misleading "全部完成".
        const subTasks = this.parseTasksMd();
        const allDone = subTasks.length > 0 && subTasks.every(t => t.status === 'done');
        if (allDone) {
            vscode.window.showInformationMessage('🎉 所有编码任务已完成！');
            this.autoMode = false;
        }
        return false;
    }

    startWatching(iterTask: Task): void {
        if (this.watcher) return;

        const signalsDir = path.join(this.iterDir, 'signals');
        fs.mkdirSync(signalsDir, { recursive: true });

        // 1) FileSystemWatcher — event-based, fires immediately on file creation.
        const pattern = new vscode.RelativePattern(signalsDir, 'done-*');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidCreate(async (uri) => {
            const taskId = path.basename(uri.fsPath).replace('done-', '');
            await this.handleSignal(taskId, uri.fsPath, iterTask);
        });

        // 2) Polling fallback — catches signals that the watcher missed.
        this.startPolling(signalsDir, iterTask);
    }

    stopWatching(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
        this.stopPolling();
        this.clearTimeout();
        this.handledSignals.clear();
        this.autoMode = false;
    }

    private startPolling(signalsDir: string, iterTask: Task): void {
        this.stopPolling();
        this.pollTimer = setInterval(async () => {
            if (!fs.existsSync(signalsDir)) return;
            let entries: string[];
            try {
                entries = fs.readdirSync(signalsDir).filter(f => f.startsWith('done-'));
            } catch {
                return;
            }
            for (const fileName of entries) {
                const taskId = fileName.replace('done-', '');
                if (this.handledSignals.has(taskId)) continue;
                const filePath = path.join(signalsDir, fileName);
                await this.handleSignal(taskId, filePath, iterTask);
            }
        }, 15_000);
    }

    private stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async handleSignal(taskId: string, signalFilePath: string, iterTask: Task): Promise<void> {
        if (this.handledSignals.has(taskId)) return;

        // Only handle signals for known subtasks in the current tasks.md.
        // This prevents stale done-* files from previous runs/specs from causing false prompts.
        const currentTasks = this.parseTasksMd();
        const currentTask = currentTasks.find(t => t.id === taskId);
        if (!currentTask) {
            this.handledSignals.add(taskId);
            this.writeLog(taskId, `ℹ 忽略未知信号: done-${taskId}（当前 tasks.md 不包含该子任务）`);
            return;
        }

        // Skip signals for non-active subtasks to avoid replaying old files.
        // Expected lifecycle: a subtask becomes 'doing' before its done signal is emitted.
        if (currentTask.status !== 'doing') {
            this.handledSignals.add(taskId);
            this.writeLog(taskId, `ℹ 忽略非进行中任务信号: done-${taskId}（status=${currentTask.status}）`);
            return;
        }

        this.handledSignals.add(taskId);
        this.clearTimeout();
        this.writeLog(taskId, `信号文件检测到: done-${taskId}`);

        const subTasks = this.parseTasksMd();
        const subTask = subTasks.find(t => t.id === taskId);
        let outputOk = true;
        const expectedOutputFiles = this.getPathLikeOutputs(subTask);
        const signalFiles = this.readSignalFiles(signalFilePath)
            .map(item => this.normalizePotentialPath(item))
            .filter(item => this.looksLikeFilePath(item));
        const filesToCheck = expectedOutputFiles.length > 0 ? expectedOutputFiles : signalFiles;
        const missingPaths: string[] = [];
        const existingPaths: string[] = [];

        for (const f of filesToCheck) {
            const fullPath = path.isAbsolute(f) ? f : path.join(this.iterDir, f);
            if (!fs.existsSync(fullPath)) {
                outputOk = false;
                missingPaths.push(f);
                continue;
            }
            existingPaths.push(f);
        }

        if (outputOk) {
            const source = expectedOutputFiles.length > 0 ? 'tasks.md' : 'signal file';
            this.writeLog(taskId, `📦 输出校验详情 expected=${expectedOutputFiles.length} signal=${signalFiles.length} checked=${filesToCheck.length} source=${source}`);

            // Real-execution Hard Gate: run task/acceptance scripts instead of merely
            // noting they exist. Controlled by gateLevel (relaxed = skip, standard =
            // per-task script, strict = per-task + iteration acceptance script).
            const gate = resolveGateLevel(this.config);
            const gateResults = await this.runExecutionGate(taskId, gate);
            const gateFailed = gateResults.some(r => !r.passed);

            if (this.autoMode) {
                if (gateFailed) {
                    this.updateSubTaskStatus(taskId, 'failed');
                    const summary = gateResults.filter(r => !r.passed).map(r => `${r.name}(exit=${r.code})`).join('、');
                    this.writeLog(taskId, `❌ 执行门禁未通过（gateLevel=${gate}）：${summary}`);
                    appendHarnessLog(this.iterDir, 'scheduler', `[${taskId}] 执行门禁失败 gate=${gate} | ${summary}`);
                    this.onStatusChange();
                    this.autoMode = false;
                    vscode.window.showWarningMessage(`❌ 任务 ${taskId} 执行门禁未通过：${summary}`);
                    return;
                }
                this.updateSubTaskStatus(taskId, 'done');
                const passNote = gateResults.length > 0
                    ? `，执行门禁通过（${gateResults.map(r => r.name).join('、')}）`
                    : '';
                this.writeLog(taskId, `✅ 输出校验通过（检查文件数: ${filesToCheck.length}）${passNote}，自动标记完成`);
                this.onStatusChange();
                await this.dispatchNext(iterTask);
            } else {
                const gateNote = gateResults.length === 0
                    ? ''
                    : gateFailed
                        ? `（⚠ 执行门禁未通过：${gateResults.filter(r => !r.passed).map(r => r.name).join('、')}）`
                        : `（✅ 执行门禁通过：${gateResults.map(r => r.name).join('、')}）`;
                const choice = await vscode.window.showInformationMessage(
                    `✅ 任务 ${taskId} 信号已到达${gateNote}，确认推进？`,
                    '确认完成', '人工检查'
                );
                if (choice === '确认完成') {
                    this.updateSubTaskStatus(taskId, 'done');
                    this.writeLog(taskId, '✅ 用户确认完成');
                    this.onStatusChange();
                }
            }
        } else {
            this.updateSubTaskStatus(taskId, 'failed');
            const source = expectedOutputFiles.length > 0 ? 'tasks.md' : 'signal file';
            const detail = [
                `source=${source}`,
                `expectedOutputFiles=${JSON.stringify(expectedOutputFiles)}`,
                `signalFiles=${JSON.stringify(signalFiles)}`,
                `missing=${JSON.stringify(missingPaths)}`,
                `existing=${JSON.stringify(existingPaths)}`,
            ].join(' | ');
            this.writeLog(taskId, `❌ 输出文件不完整（来源: ${source}, 检查文件数: ${filesToCheck.length}，缺失: ${missingPaths.join(', ') || '(unknown)'}）`);
            this.writeLog(taskId, `❌ 诊断: ${detail}`);
            appendHarnessLog(this.iterDir, 'scheduler', `[${taskId}] 输出验证失败 | ${detail}`);
            this.onStatusChange();
            
            // Ask user if they want to retry or ignore this failure
            const choice = await vscode.window.showWarningMessage(
                `❌ 任务 ${taskId} 输出文件不完整（缺失: ${missingPaths.join(', ')}）`,
                '查看日志', '忽略并继续', '标记重试'
            );
            
            if (choice === '查看日志') {
                appendHarnessLog(this.iterDir, 'scheduler', `[${taskId}] 用户查看日志以诊断问题`);
            } else if (choice === '忽略并继续') {
                this.updateSubTaskStatus(taskId, 'done');
                this.writeLog(taskId, '⚠️ 用户选择忽略验证继续推进');
                this.onStatusChange();
                if (this.autoMode) {
                    await this.dispatchNext(iterTask);
                }
            } else if (choice === '标记重试') {
                this.updateSubTaskStatus(taskId, 'todo');
                this.handledSignals.delete(taskId);
                this.writeLog(taskId, '🔄 用户标记重试');
                this.onStatusChange();
            } else {
                this.autoMode = false;
            }
        }
    }

    /**
     * Real-execution Hard Gate: run the task/acceptance scripts and require exit code 0.
     * relaxed → no scripts run; standard → per-task script; strict → per-task + acceptance.
     * Absence of scripts is non-blocking (falls back to file-existence gate).
     */
    private async runExecutionGate(taskId: string, gate: GateLevel): Promise<Array<{ name: string; passed: boolean; code: number }>> {
        const results: Array<{ name: string; passed: boolean; code: number }> = [];
        if (gate === 'relaxed') {
            return results;
        }

        const isWin = process.platform === 'win32';
        const scripts: Array<{ name: string; file: string }> = [];

        const perTask = path.join(this.iterDir, 'tests', isWin ? `test-${taskId}.ps1` : `test-${taskId}.sh`);
        if (fs.existsSync(perTask)) {
            scripts.push({ name: `test-${taskId}`, file: perTask });
        }

        if (gate === 'strict') {
            const acceptance = path.join(this.iterDir, 'tests', isWin ? 'test-api.ps1' : 'test-api.sh');
            if (fs.existsSync(acceptance)) {
                scripts.push({ name: 'test-api', file: acceptance });
            }
        }

        if (scripts.length === 0) {
            this.writeLog(taskId, `ℹ 执行门禁(gate=${gate})：未发现可执行测试脚本，按文件存在放行`);
            return results;
        }

        for (const s of scripts) {
            this.writeLog(taskId, `▶ 执行门禁运行脚本: ${s.file}`);
            const { code, timedOut, output } = await this.runScript(s.file);
            const passed = code === 0 && !timedOut;
            this.writeLog(taskId, `${passed ? '✅' : '❌'} 脚本 ${s.name} 结束 exit=${code}${timedOut ? '（超时）' : ''}`);
            if (!passed && output.trim()) {
                this.writeLog(taskId, `脚本 ${s.name} 输出(尾部): ${output.trim().slice(-1500)}`);
            }
            results.push({ name: s.name, passed, code: timedOut ? -1 : code });
        }
        return results;
    }

    /** Execute a single .ps1/.sh script, capturing exit code and (truncated) output, with a hard timeout. */
    private runScript(scriptFile: string): Promise<{ code: number; timedOut: boolean; output: string }> {
        return new Promise((resolve) => {
            const isPs = scriptFile.toLowerCase().endsWith('.ps1');
            const cmd = isPs ? 'powershell' : (process.platform === 'win32' ? 'bash' : 'sh');
            const args = isPs
                ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile]
                : [scriptFile];

            let settled = false;
            let output = '';
            const capture = (buf: Buffer): void => {
                output += buf.toString();
                if (output.length > 8000) {
                    output = output.slice(-8000);
                }
            };

            let child;
            try {
                child = spawn(cmd, args, { cwd: this.iterDir, shell: false });
            } catch {
                resolve({ code: -1, timedOut: false, output });
                return;
            }

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { child.kill(); } catch { /* ignore */ }
                    resolve({ code: -1, timedOut: true, output });
                }
            }, 120_000);

            child.stdout?.on('data', capture);
            child.stderr?.on('data', capture);
            child.on('error', () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: -1, timedOut: false, output });
                }
            });
            child.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: code ?? -1, timedOut: false, output });
                }
            });
        });
    }

    async startAuto(iterTask: Task): Promise<void> {
        this.autoMode = true;
        this.startWatching(iterTask);
        const currentDoing = this.getCurrentTask();
        if (currentDoing) {
            this.handledSignals.delete(currentDoing.id);
            this.clearStaleSignal(currentDoing.id);
            vscode.window.showInformationMessage(`⏳ 等待任务 ${currentDoing.id} 完成...`);
            this.startTimeout(currentDoing.id);
            return;
        }

        await this.dispatchNext(iterTask);
    }

    pause(): void {
        this.autoMode = false;
        this.clearTimeout();
        vscode.window.showInformationMessage('⏸ 自动执行已暂停');
    }

    isAutoMode(): boolean {
        return this.autoMode;
    }

    async manualNext(iterTask: Task): Promise<void> {
        const current = this.getCurrentTask();
        if (current) {
            this.updateSubTaskStatus(current.id, 'done');
            this.writeLog(current.id, '⏭ 用户手动标记完成');
        }
        this.clearTimeout();
        this.onStatusChange();

        this.startWatching(iterTask);
        await this.dispatchNext(iterTask);
    }

    async retryTask(taskId: string, iterTask: Task): Promise<void> {
        this.updateSubTaskStatus(taskId, 'todo');
        // Allow the retried task's new done signal to be consumed again.
        this.handledSignals.delete(taskId);
        this.onStatusChange();

        const signalFile = path.join(this.iterDir, 'signals', `done-${taskId}`);
        if (fs.existsSync(signalFile)) {
            fs.unlinkSync(signalFile);
        }

        const subTasks = this.parseTasksMd();
        const subTask = subTasks.find(t => t.id === taskId);
        if (subTask) {
            this.startWatching(iterTask);
            await this.dispatchTask(subTask, iterTask);
        }
    }

    private startTimeout(taskId: string): void {
        this.clearTimeout();
        this.timeoutTimer = setTimeout(() => {
            // Timeout is now a soft warning: keep watching for the signal,
            // but notify the user so they can manually mark done if needed.
            this.writeLog(taskId, '⏰ 超时提醒（5分钟无信号），仍在监听中');
            this.onStatusChange();
            vscode.window.showWarningMessage(
                `⏰ 任务 ${taskId} 已超过5分钟无信号，你可以手动标记完成或继续等待。系统仍在监听信号文件。`,
            );
            // Do NOT mark failed or stop auto mode — the watcher stays active.
        }, 5 * 60 * 1000);
    }

    private clearTimeout(): void {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }

    private writeLog(taskId: string, message: string): void {
        const logPath = path.join(this.iterDir, 'logs', `task-${taskId}.log`);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    }

    private getPathLikeOutputs(subTask: SubTask | undefined): string[] {
        if (!subTask || subTask.output.length === 0) {
            return [];
        }
        return subTask.output
            .flatMap(item => this.splitOutputEntries(item))
            .map(item => this.normalizePotentialPath(item))
            .filter(item => this.looksLikeFilePath(item));
    }

    /**
     * Normalizes path-like tokens copied from markdown/YAML by removing common wrappers
     * (backticks or quotes), so existence checks remain stable across formatting styles.
     */
    private normalizePotentialPath(value: string): string {
        const raw = String(value || '').trim();
        if (!raw) {
            return '';
        }

        let normalized = raw;

        // Strip one surrounding markdown inline-code wrapper: `path/to/file`
        if (/^`[^`]+`$/.test(normalized)) {
            normalized = normalized.slice(1, -1).trim();
        }

        // Strip one surrounding quote pair: "path/to/file" or 'path/to/file'
        if ((/^"[^"]+"$/.test(normalized)) || (/^'[^']+'$/.test(normalized))) {
            normalized = normalized.slice(1, -1).trim();
        }

        return normalized;
    }

    private looksLikeFilePath(value: string): boolean {
        if (!value) {
            return false;
        }
        // Extract the path part before any parenthetical remark.
        // Supports formats like: "apps/src/file.ts" or "apps/src/file.ts（仅新增方法）" or "apps/src/file.ts (additional method only)"
        let pathPart = value.split('（')[0].split('(')[0].trim();
        
        if (!pathPart) {
            return false;
        }
        
        // Reject values where the PATH PART contains Chinese characters — these are descriptions, not paths.
        // e.g. "修改 backend/schedule-service 模块以实现..." is NOT a file path.
        if (/[\u4e00-\u9fa5]/.test(pathPart)) {
            return false;
        }
        
        if (/[\\/]/.test(pathPart)) {
            return true;
        }
        return /^[\w.-]+\.[a-zA-Z0-9]+$/.test(pathPart);
    }

    private readSignalFiles(signalPath: string): string[] {
        if (!fs.existsSync(signalPath)) {
            return [];
        }
        try {
            const content = fs.readFileSync(signalPath, 'utf8');
            const lines = content.split('\n');
            const files: string[] = [];
            let inFiles = false;

            for (const raw of lines) {
                const line = raw.trimEnd();
                if (!inFiles) {
                    if (/^files\s*:\s*$/i.test(line.trim())) {
                        inFiles = true;
                    }
                    continue;
                }

                const match = line.match(/^\s*-\s+(.+)$/);
                if (match) {
                    const candidate = match[1].trim();
                    // Ignore placeholder markers that mean "no file outputs".
                    if (!/^(?:\(none\)|none|n\/a|na|无|无新文件|\(无\)|-)$/.test(candidate.toLowerCase())) {
                        files.push(candidate);
                    }
                    continue;
                }

                if (line.trim()) {
                    break;
                }
            }

            return files;
        } catch {
            return [];
        }
    }
}
