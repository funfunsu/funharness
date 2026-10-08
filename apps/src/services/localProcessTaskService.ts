import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { parseDocument } from 'yaml';
import { SubFeature } from '../models';

export type LocalCheck = 'compile' | 'webview' | 'tests';
type CheckResult = { exitCode: number; output: string; failureKind?: 'infrastructure' };

export class LocalVerificationError extends Error {
    readonly repairable: boolean;

    constructor(readonly check: LocalCheck, readonly result: CheckResult) {
        super(`${check} failed (exit ${result.exitCode})\n${result.output}`);
        this.name = 'LocalVerificationError';
        const infrastructure = result.failureKind === 'infrastructure' ||
            /MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|Missing script|not recognized|无法将.*识别|Local check timed out|No test files found/i.test(result.output);
        const codeFailure = /error TS\d+\s*:|SyntaxError|ERR_ASSERTION|AssertionError|(?:^|\n)not ok \d+/i.test(result.output);
        this.repairable = result.exitCode !== 0 && !infrastructure && codeFailure;
    }
}

export class LocalProcessTaskService {
    constructor(private readonly runCheck: (check: LocalCheck, cwd: string) => Promise<CheckResult> = runLocalCheck) {}

    private safePath(iterDir: string, relative: string): string {
        const root = path.resolve(iterDir);
        const target = path.resolve(root, relative);
        const rel = path.relative(root, target);
        if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
            throw new Error(`Local output escapes iteration: ${relative}`);
        }
        let cursor = target;
        while (cursor !== root) {
            if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
                throw new Error(`Local output traverses a symbolic link: ${relative}`);
            }
            cursor = path.dirname(cursor);
        }
        return target;
    }

    async execute(task: SubFeature, tasks: SubFeature[], iterDir: string, docsDir: string, trusted: boolean): Promise<void> {
        if (!trusted) throw new Error('Local tasks require a trusted workspace');
        if (!/^\d+\.\d+$/.test(task.id)) throw new Error('Invalid local task ID');
        if (!['checkpoint', 'traceability', 'verify'].includes(task.localAction || '')) {
            throw new Error(`Unsupported local action: ${task.localAction || '(missing)'}`);
        }
        for (const dependency of task.depends) {
            if (tasks.find(item => item.id === dependency)?.status !== 'done') {
                throw new Error(`Local task dependency is not done: ${dependency}`);
            }
        }
        const outputs = [...new Set(task.output.map(value => value.trim().replace(/^[\[`]|[\]`]$/g, '').replace(/\\/g, '/')))];
        if (outputs.some(value => value.split('/').includes('..'))) {
            throw new Error('Local output escapes process directory');
        }
        if (outputs.length === 0 || outputs.some(value => !/^\.harness\/process\/.+\.md$/i.test(value))) {
            throw new Error('Local tasks must declare Markdown records under .harness/process/');
        }
        const targets = outputs.map(value => this.safePath(iterDir, value));
        const signal = this.safePath(iterDir, `signals/done-${task.id}`);
        const startedAt = new Date().toISOString();
        const evidence: string[] = [];
        if (task.localAction === 'verify') {
            const checks = task.checks || [];
            if (!Array.isArray(checks) || checks.length === 0 || checks.some(check => !['compile', 'webview', 'tests'].includes(check))) {
                throw new Error('Verification requires allowlisted checks: compile, webview, tests');
            }
            const cwd = fs.existsSync(path.join(iterDir, 'apps', 'package.json')) ? path.join(iterDir, 'apps') : iterDir;
            if (!fs.existsSync(path.join(cwd, 'package.json'))) throw new Error('Verification package.json not found');
            const orderedChecks = checks.includes('tests')
                ? ['compile' as LocalCheck, ...checks.filter(check => check !== 'compile')]
                : checks;
            for (const check of [...new Set(orderedChecks)]) {
                const result = await this.runCheck(check, cwd);
                evidence.push(`## ${check}\nExit code: ${result.exitCode}\n\n\`\`\`text\n${result.output}\n\`\`\``);
                if (result.exitCode !== 0 || (check === 'webview' && !result.output.includes('Webview script validation passed'))) {
                    throw new LocalVerificationError(check, result);
                }
            }
        } else if (task.localAction === 'traceability') {
            const requirements = fs.readFileSync(path.join(docsDir, 'requirements.md'), 'utf8');
            const fence = requirements.match(/```ya?ml\s*\r?\n([\s\S]*?)```/i);
            if (!fence) throw new Error('Traceability requires machine-readable requirements');
            const document = parseDocument(fence[1]);
            if (document.errors.length) throw new Error('Invalid requirements YAML');
            const entries = document.toJS()?.requirements;
            if (!Array.isArray(entries) || entries.length === 0) throw new Error('No requirements for traceability');
            const implementationTasks = tasks.filter(item => item.execution !== 'local');
            evidence.push('| Requirement | Implementation tasks |', '| --- | --- |');
            for (const entry of entries) {
                const id = String(entry.id || '');
                const mapped = implementationTasks.filter(item => item.requirementIds.includes(id));
                if (!id || mapped.length === 0) throw new Error(`Requirement has no implementation task: ${id}`);
                evidence.push(`| ${id} | ${mapped.map(item => item.id).join(', ')} |`);
            }
            evidence.push('\n## Invariant mappings');
            for (const item of implementationTasks) evidence.push(`- ${item.id}: ${item.propertyIds.join(', ') || '(none declared)'}`);
        } else {
            evidence.push('Snapshot only; not an AI review or human approval.', '\n## Artifact hashes');
            for (const name of ['requirements.md', 'design.md', 'tasks.md']) {
                const file = path.join(docsDir, name);
                if (!fs.existsSync(file)) throw new Error(`Checkpoint artifact missing: ${name}`);
                evidence.push(`- ${name}: sha256=${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
            }
            evidence.push('\n## Dependencies', ...task.depends.map(id => `- ${id}: done`));
        }
        const report = `# Local process task ${task.id}\n\nAction: ${task.localAction}\nStarted: ${startedAt}\nCompleted: ${new Date().toISOString()}\n\n${evidence.join('\n')}\n`;
        for (const target of targets) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, report, 'utf8');
        }
        fs.mkdirSync(path.dirname(signal), { recursive: true });
        fs.writeFileSync(signal, `taskId: ${task.id}\nstatus: done\ntimestamp: ${new Date().toISOString()}\nfiles:\n${outputs.map(file => `  - ${file}`).join('\n')}\n`, 'utf8');
    }
}

function runLocalCheck(check: LocalCheck, cwd: string): Promise<CheckResult> {
    const commands: Record<LocalCheck, { executable: string; args: string[]; windows: string }> = {
        compile: { executable: 'npm', args: ['run', 'compile:guard'], windows: '& npm.cmd run compile:guard; exit $LASTEXITCODE' },
        webview: { executable: 'node', args: ['scripts/validate-webview.js'], windows: '& node scripts/validate-webview.js; exit $LASTEXITCODE' },
        tests: { executable: 'node', args: ['--test', ...collectTestFiles(path.join(cwd, 'test'))],
            windows: '$tests = @(Get-ChildItem -LiteralPath test -Recurse -Filter *.test.js | ForEach-Object { $_.FullName }); if ($tests.Count -eq 0) { exit 1 }; & node --test $tests; exit $LASTEXITCODE' },
    };
    const command = commands[check];
    if (check === 'tests' && command.args.length === 1) return Promise.resolve({ exitCode: 1, output: 'No test files found' });
    return new Promise(resolve => {
        const windows = process.platform === 'win32';
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn(windows ? 'powershell.exe' : command.executable,
            windows ? ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; Invoke-Expression (fnm env --shell powershell | Out-String); ${command.windows}`] : command.args,
            { cwd, shell: false, windowsHide: true, env });
        let output = '';
        const capture = (data: Buffer) => { output = (output + data.toString('utf8')).slice(-16000); };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        const timer = setTimeout(() => {
            if (windows && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else child.kill('SIGKILL');
            resolve({ exitCode: 1, output: `${output}\nLocal check timed out`, failureKind: 'infrastructure' });
        }, 300000);
        child.on('error', error => { clearTimeout(timer); resolve({ exitCode: 1, output: error.message, failureKind: 'infrastructure' }); });
        child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output, failureKind: code === null ? 'infrastructure' : undefined }); });
    });
}

function collectTestFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? collectTestFiles(file) : entry.isFile() && entry.name.endsWith('.test.js') ? [file] : [];
    });
}