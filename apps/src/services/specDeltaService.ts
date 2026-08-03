import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { BASE, Config, getSpecDocsDir, getSpecFile, getSpecFileRel, resolveGateLevel, resolveFeaturePlanFileForIteration, Feature } from '../models';
import { collectDefinedReqIds, collectReferencedReqIds, extractMachineBlock } from '../specTrace';

type StageKey = 'req' | 'des' | 'tcs' | 'tsk';

interface DomainDefinition {
    id: string;
    name: string;
    reqIdPrefixes: string[];
    artifactPathPatterns: string[];
    contractPatterns: string[];
    keywords: string[];
}

interface DomainRules {
    unknownDomain: string;
    maxCandidateDomains: number;
    denyIfUncategorized: boolean;
    denyIfDomainChangedWithoutSpecDelta: boolean;
    denyIfContractDomainAndRequirementDomainMismatch: boolean;
    domainDefinitions: DomainDefinition[];
}

interface StageSnapshot {
    stage: StageKey;
    hash: string;
    reqIds: string[];
    referencedReqIds: string[];
    gwtCount: number;
    requirementDomainMap: Record<string, string>;
    sourcePath: string;
    at: string;
}

interface SpecDeltaState {
    version: 1;
    stageHashes: Partial<Record<StageKey, string>>;
    stageSnapshots: Partial<Record<StageKey, StageSnapshot>>;
}

type LedgerType = 'stage-snapshot' | 'drift-gate';

interface LedgerEntry {
    type: LedgerType;
    at: string;
    taskId: string;
    taskName: string;
    stage: StageKey | 'dev';
    severity: 'low' | 'medium' | 'high';
    summary: string;
    domains: string[];
    details: string[];
    gateBlocked: boolean;
}

interface DriftEvaluation {
    passed: boolean;
    errors: string[];
    warnings: string[];
    digestPath: string;
}

export interface StructureGateViolation {
    ruleId: string;
    location: string;
    message: string;
    suggestion: string;
}

export interface StructureGateDecision {
    passed: boolean;
    gateStatus: 'passed' | 'failed';
    gateId: string;
    violations: StructureGateViolation[];
}

const DEFAULT_RULES: DomainRules = {
    unknownDomain: 'uncategorized',
    maxCandidateDomains: 3,
    denyIfUncategorized: true,
    denyIfDomainChangedWithoutSpecDelta: true,
    denyIfContractDomainAndRequirementDomainMismatch: true,
    domainDefinitions: [
        {
            id: 'auth',
            name: 'Authentication',
            reqIdPrefixes: ['Req-auth-', 'Req-login-', 'Req-session-'],
            artifactPathPatterns: ['/auth/', '/identity/', '/session/'],
            contractPatterns: ['^/api/auth', '^/api/session'],
            keywords: ['signin', 'sign-in', 'token', 'session', 'remember me'],
        },
        {
            id: 'order',
            name: 'Order',
            reqIdPrefixes: ['Req-order-', 'Req-checkout-'],
            artifactPathPatterns: ['/order/', '/checkout/', '/fulfillment/'],
            contractPatterns: ['^/api/orders', '^/api/checkout'],
            keywords: ['order', 'checkout', 'cart', 'shipment'],
        },
        {
            id: 'payment',
            name: 'Payment',
            reqIdPrefixes: ['Req-payment-', 'Req-billing-'],
            artifactPathPatterns: ['/payment/', '/billing/', '/invoice/'],
            contractPatterns: ['^/api/payments', '^/api/billing'],
            keywords: ['payment', 'billing', 'refund', 'invoice'],
        },
        {
            id: 'notification',
            name: 'Notification',
            reqIdPrefixes: ['Req-notify-', 'Req-message-'],
            artifactPathPatterns: ['/notification/', '/message/', '/alert/'],
            contractPatterns: ['^/api/notifications', '^/api/messages'],
            keywords: ['notify', 'notification', 'email', 'sms', 'push'],
        },
    ],
};

export class SpecDeltaService {
    constructor(
        private readonly masterRoot: string,
        private readonly getConfig: () => Config,
    ) {}

    recordStageSnapshot(task: Feature, iterDir: string, stage: StageKey, sourcePath: string, content: string): string {
        const rules = this.loadDomainRules(iterDir);
        const state = this.loadState(iterDir);
        const snapshot = this.buildSnapshot(stage, sourcePath, content, this.getConfig());
        const cfg = this.getConfig();
        const latestDigest = path.join(getSpecDocsDir(iterDir, cfg), 'delta', 'domain-digest.latest.md');
        if (state.stageHashes[stage] && state.stageHashes[stage] === snapshot.hash) {
            // Content unchanged — skip all I/O, just return existing digest path.
            return fs.existsSync(latestDigest) ? latestDigest : this.generateDomainDigest(task, iterDir, rules);
        }

        const previous = state.stageSnapshots[stage];
        const details = this.computeStageDeltaDetails(stage, previous, snapshot);
        const domains = this.resolveDomains({
            reqIds: snapshot.reqIds,
            referencedReqIds: snapshot.referencedReqIds,
            paths: [sourcePath],
            text: content,
            requirementDomainMap: snapshot.requirementDomainMap,
        }, rules);

        const severity: LedgerEntry['severity'] = details.some(d => d.includes('removed')) ? 'high' : details.length > 0 ? 'medium' : 'low';
        this.persistSnapshot(iterDir, stage, snapshot);
        this.appendLedger(iterDir, {
            type: 'stage-snapshot',
            at: new Date().toISOString(),
            taskId: task.id,
            taskName: task.name,
            stage,
            severity,
            summary: `${stage.toUpperCase()} snapshot updated`,
            domains,
            details,
            gateBlocked: false,
        });

        state.stageHashes[stage] = snapshot.hash;
        state.stageSnapshots[stage] = snapshot;
        this.saveState(iterDir, state);
        return this.generateDomainDigest(task, iterDir, rules);
    }

    evaluateDriftGate(task: Feature, iterDir: string): DriftEvaluation {
        const cfg = this.getConfig();
        const rules = this.loadDomainRules(iterDir);
        const changedFiles = this.collectChangedFiles(iterDir);
        if (changedFiles.length === 0) {
            const digestPath = this.generateDomainDigest(task, iterDir, rules);
            return { passed: true, errors: [], warnings: [], digestPath };
        }

        const normalized = changedFiles.map(v => v.replace(/\\/g, '/').toLowerCase());
        const codeChanged = normalized.some(v => this.isCodeLikeFile(v));
        const specChanged = normalized.some(v => this.isSpecArtifactFile(v));
        const designChanged = normalized.some(v => /(^|\/)design\.md$/.test(v));
        const testcaseChanged = normalized.some(v => /(^|\/)testcase\.md$/.test(v));
        const contractSensitiveChanged = normalized.some(v => /(controller|route|handler|dto|schema|model|api|contract)/.test(v));
        const testFileChanged = normalized.some(v => /(\/tests?\/|\.spec\.|\.test\.)/.test(v));

        const errors: string[] = [];
        const warnings: string[] = [];

        if (codeChanged && !specChanged) {
            errors.push('DEV-DRIFT-001: 开发验收阶段检测到代码变更，但 requirements/design/testcase/tasks 未同步更新');
        }
        if (contractSensitiveChanged && !designChanged) {
            errors.push('DEV-DRIFT-002: 检测到契约敏感代码变更（controller/route/dto/schema/model），但 design.md 未更新');
        }
        if (testFileChanged && !testcaseChanged && !task.quickMode) {
            warnings.push('DEV-DRIFT-003: 检测到测试脚本/测试代码变更，但 testcase.md 未更新');
        }

        const domains = this.resolveDomains({
            reqIds: [],
            referencedReqIds: [],
            paths: changedFiles,
            text: changedFiles.join('\n'),
            requirementDomainMap: {},
        }, rules);

        const gate = resolveGateLevel(cfg);
        const gateErrors: string[] = [];
        if (gate === 'strict') {
            gateErrors.push(...errors);
            if (rules.denyIfUncategorized && domains.includes(rules.unknownDomain)) {
                gateErrors.push('DEV-DRIFT-004: strict 模式下存在未分类领域变更（uncategorized），需先补齐领域归属后再推进');
            }
            if (warnings.length > 0) {
                gateErrors.push(...warnings);
            }
        } else if (gate === 'standard') {
            gateErrors.push(...errors);
        }

        this.appendLedger(iterDir, {
            type: 'drift-gate',
            at: new Date().toISOString(),
            taskId: task.id,
            taskName: task.name,
            stage: 'dev',
            severity: gateErrors.length > 0 ? 'high' : warnings.length > 0 ? 'medium' : 'low',
            summary: gateErrors.length > 0 ? 'Development drift gate blocked' : 'Development drift gate passed',
            domains,
            details: [...errors, ...warnings, `changedFiles=${changedFiles.length}`],
            gateBlocked: gateErrors.length > 0,
        });

        const digestPath = this.generateDomainDigest(task, iterDir, rules);
        return {
            passed: gateErrors.length === 0,
            errors: gateErrors,
            warnings,
            digestPath,
        };
    }

    getLastReviewStatus(task: Feature, iterDir: string): { severity: 'low' | 'medium' | 'high'; gateBlocked: boolean; at: string; summary: string; digestPath: string } | null {
        const entries = this.readLedger(iterDir).filter(e => e.taskId === task.id);
        if (entries.length === 0) {
            return null;
        }
        const last = entries[entries.length - 1];
        const cfg = this.getConfig();
        const latestDigest = path.join(getSpecDocsDir(iterDir, cfg), 'delta', 'domain-digest.latest.md');
        return {
            severity: last.severity,
            gateBlocked: last.gateBlocked,
            at: last.at,
            summary: last.summary,
            digestPath: fs.existsSync(latestDigest) ? latestDigest : '',
        };
    }

    getSpecDeltaOverview(tasks: Array<{ task: Feature; iterDir: string }>): Array<{ domain: string; total: number; high: number; blocked: number; lastAt: string }> {
        const map = new Map<string, { total: number; high: number; blocked: number; lastAt: string }>();
        for (const { task, iterDir } of tasks) {
            const entries = this.readLedger(iterDir).filter(e => e.taskId === task.id);
            for (const entry of entries) {
                const domains = entry.domains.length > 0 ? entry.domains : ['uncategorized'];
                for (const domain of domains) {
                    const current = map.get(domain) ?? { total: 0, high: 0, blocked: 0, lastAt: '' };
                    current.total += 1;
                    if (entry.severity === 'high') { current.high += 1; }
                    if (entry.gateBlocked) { current.blocked += 1; }
                    if (!current.lastAt || entry.at > current.lastAt) { current.lastAt = entry.at; }
                    map.set(domain, current);
                }
            }
        }
        return Array.from(map.entries())
            .map(([domain, data]) => ({ domain, ...data }))
            .sort((a, b) => b.high - a.high || b.blocked - a.blocked);
    }

    runFullSpecReview(task: Feature, iterDir: string): DriftEvaluation {
        const cfg = this.getConfig();
        const files: Array<{ stage: StageKey; path: string }> = [
            { stage: 'req', path: getSpecFile(iterDir, cfg, 'requirements.md') },
            { stage: 'des', path: getSpecFile(iterDir, cfg, 'design.md') },
            { stage: 'tcs', path: getSpecFile(iterDir, cfg, 'testcase.md') },
            { stage: 'tsk', path: resolveFeaturePlanFileForIteration(iterDir, cfg) },
        ];

        for (const item of files) {
            if (!fs.existsSync(item.path)) {
                continue;
            }
            const content = fs.readFileSync(item.path, 'utf8');
            if (!content.trim()) {
                continue;
            }
            this.recordStageSnapshot(task, iterDir, item.stage, item.path, content);
        }

        return this.evaluateDriftGate(task, iterDir);
    }

    /**
     * Validate structure artifact with requiredSections/requiredFields and derive gate status.
     * This implements API-2 style gate decision semantics for Req-4/INV-4.
     */
    validateStructureGate(
        structureDraft: Record<string, unknown>,
        requiredSections: string[],
        requiredFields: string[],
    ): StructureGateDecision {
        const violations: StructureGateViolation[] = [];
        const gateId = `gate-${Date.now()}`;

        const sections = Array.isArray(structureDraft.sections) ? structureDraft.sections : [];

        for (const sectionName of requiredSections) {
            if (!this.containsSection(sections, sectionName)) {
                violations.push({
                    ruleId: 'SG-REQ-SECTION',
                    location: 'sections',
                    message: `缺失必填段落：${sectionName}`,
                    suggestion: `在 structureDraft.sections 中补充 ${sectionName} 对应结构`,
                });
            }
        }

        for (const fieldName of requiredFields) {
            if (!this.hasRequiredFieldValue(structureDraft, fieldName)) {
                violations.push({
                    ruleId: 'SG-REQ-FIELD',
                    location: fieldName,
                    message: `缺失必填结构字段：${fieldName}`,
                    suggestion: `为 structureDraft.${fieldName} 提供非空值`,
                });
            }
        }

        return {
            passed: violations.length === 0,
            gateStatus: violations.length === 0 ? 'passed' : 'failed',
            gateId,
            violations,
        };
    }

    /** Match required section names from section arrays with tolerant name extraction. */
    private containsSection(sections: unknown[], expectedName: string): boolean {
        const expected = (expectedName || '').trim();
        if (!expected) {
            return true;
        }
        return sections.some(item => {
            if (!item || typeof item !== 'object') {
                return false;
            }
            const obj = item as Record<string, unknown>;
            const name = String(obj.name || obj.title || obj.id || '').trim();
            return name === expected;
        });
    }

    /** Validate required field presence/non-empty in a normalized structure draft object. */
    private hasRequiredFieldValue(structureDraft: Record<string, unknown>, fieldName: string): boolean {
        const value = structureDraft[fieldName];
        if (value === undefined || value === null) {
            return false;
        }
        if (typeof value === 'string') {
            return value.trim().length > 0;
        }
        if (Array.isArray(value)) {
            return value.length > 0;
        }
        if (typeof value === 'object') {
            return Object.keys(value as Record<string, unknown>).length > 0;
        }
        return true;
    }

    private buildSnapshot(stage: StageKey, sourcePath: string, content: string, cfg: Config): StageSnapshot {
        const reqIds = stage === 'req' ? collectDefinedReqIds(content) : [];
        const referencedReqIds = stage === 'req' ? [] : collectReferencedReqIds(content);
        const requirementDomainMap = stage === 'req' ? this.extractRequirementDomainMap(content) : {};
        const hash = this.sha(this.normalizeContent(content));
        const gwtCount = this.countGwtTriples(content);
        return {
            stage,
            hash,
            reqIds,
            referencedReqIds,
            gwtCount,
            requirementDomainMap,
            sourcePath: getSpecFileRel(path.dirname(sourcePath), cfg, path.basename(sourcePath)),
            at: new Date().toISOString(),
        };
    }

    private computeStageDeltaDetails(stage: StageKey, previous: StageSnapshot | undefined, current: StageSnapshot): string[] {
        if (!previous) {
            return [`${stage}:initial-snapshot`];
        }
        const details: string[] = [];
        const addedReq = current.reqIds.filter(id => !previous.reqIds.includes(id));
        const removedReq = previous.reqIds.filter(id => !current.reqIds.includes(id));
        const addedRefs = current.referencedReqIds.filter(id => !previous.referencedReqIds.includes(id));
        const removedRefs = previous.referencedReqIds.filter(id => !current.referencedReqIds.includes(id));
        if (addedReq.length > 0) {
            details.push(`requirements-added:${addedReq.join(',')}`);
        }
        if (removedReq.length > 0) {
            details.push(`requirements-removed:${removedReq.join(',')}`);
        }
        if (addedRefs.length > 0) {
            details.push(`references-added:${addedRefs.join(',')}`);
        }
        if (removedRefs.length > 0) {
            details.push(`references-removed:${removedRefs.join(',')}`);
        }
        if (current.gwtCount !== previous.gwtCount) {
            details.push(`gwt-count:${previous.gwtCount}->${current.gwtCount}`);
        }
        if (details.length === 0) {
            details.push(`${stage}:no-semantic-diff`);
        }
        return details;
    }

    private extractRequirementDomainMap(content: string): Record<string, string> {
        const map: Record<string, string> = {};
        const block = extractMachineBlock(content) || content;
        const reqRe = /-\s*id\s*:\s*(Req-[\w-]+)([\s\S]*?)(?=\n\s*-\s*id\s*:|$)/g;
        let match: RegExpExecArray | null;
        while ((match = reqRe.exec(block)) !== null) {
            const reqId = match[1];
            const section = match[2] || '';
            const domainMatch = section.match(/\n\s*domain\s*:\s*([^\n]+)/i);
            if (domainMatch) {
                map[reqId] = domainMatch[1].replace(/["']/g, '').trim();
            }
        }
        return map;
    }

    private countGwtTriples(content: string): number {
        const lines = content.split(/\r?\n/);
        let count = 0;
        for (let i = 0; i < lines.length; i += 1) {
            if (/\bGIVEN\b/i.test(lines[i])) {
                let hasWhen = false;
                let hasThen = false;
                for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
                    if (/\bWHEN\b/i.test(lines[j])) {
                        hasWhen = true;
                    }
                    if (/\bTHEN\b/i.test(lines[j])) {
                        hasThen = true;
                    }
                }
                if (hasWhen && hasThen) {
                    count += 1;
                }
            }
        }
        return count;
    }

    private resolveDomains(
        input: { reqIds: string[]; referencedReqIds: string[]; paths: string[]; text: string; requirementDomainMap: Record<string, string> },
        rules: DomainRules,
    ): string[] {
        const scores = new Map<string, number>();
        const addScore = (domainId: string, score: number): void => {
            scores.set(domainId, (scores.get(domainId) || 0) + score);
        };

        for (const reqId of [...input.reqIds, ...input.referencedReqIds]) {
            const explicit = input.requirementDomainMap[reqId];
            if (explicit) {
                addScore(explicit.toLowerCase(), 100);
                continue;
            }
            for (const domain of rules.domainDefinitions) {
                if (domain.reqIdPrefixes.some(prefix => reqId.toLowerCase().startsWith(prefix.toLowerCase()))) {
                    addScore(domain.id, 80);
                }
            }
        }

        const allPaths = input.paths.map(v => v.replace(/\\/g, '/').toLowerCase());
        for (const domain of rules.domainDefinitions) {
            for (const pattern of domain.artifactPathPatterns) {
                const p = pattern.toLowerCase();
                if (allPaths.some(item => item.includes(p))) {
                    addScore(domain.id, 70);
                }
            }
        }

        const lowerText = input.text.toLowerCase();
        for (const domain of rules.domainDefinitions) {
            let keywordHits = 0;
            for (const kw of domain.keywords) {
                if (lowerText.includes(kw.toLowerCase())) {
                    keywordHits += 1;
                }
            }
            if (keywordHits > 0) {
                addScore(domain.id, 40 + keywordHits);
            }
        }

        const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) {
            return [rules.unknownDomain];
        }
        return sorted.slice(0, Math.max(1, rules.maxCandidateDomains)).map(item => item[0]);
    }

    private collectChangedFiles(iterDir: string): string[] {
        const repos: Array<{ dir: string; prefix: string }> = [];
        if (fs.existsSync(path.join(iterDir, '.git'))) {
            repos.push({ dir: iterDir, prefix: '' });
        }
        const frontendDir = path.join(iterDir, 'frontend');
        if (fs.existsSync(path.join(frontendDir, '.git'))) {
            repos.push({ dir: frontendDir, prefix: 'frontend/' });
        }
        const backendDir = path.join(iterDir, 'backend');
        if (fs.existsSync(path.join(backendDir, '.git'))) {
            repos.push({ dir: backendDir, prefix: 'backend/' });
        }

        const files = new Set<string>();
        for (const repo of repos) {
            // Use untracked=all so untracked directories are expanded into concrete files.
            const output = this.runGit(repo.dir, ['status', '--porcelain=v1', '--untracked-files=all']);
            if (!output.trim()) {
                continue;
            }
            const lines = output.split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
                const raw = line.slice(3).trim();
                if (!raw) {
                    continue;
                }
                const target = raw.includes(' -> ') ? raw.split(' -> ')[1].trim() : raw;
                const normalizedTarget = (repo.prefix + target).replace(/\\/g, '/');
                const absoluteTarget = path.join(repo.dir, target.replace(/\//g, path.sep));
                if (this.isDirectoryPath(normalizedTarget, absoluteTarget)) {
                    const expanded = this.expandChangedDirectory(repo.dir, repo.prefix, target);
                    if (expanded.length > 0) {
                        for (const file of expanded) {
                            files.add(file);
                        }
                        continue;
                    }
                }
                files.add(normalizedTarget);
            }
        }
        return Array.from(files.values());
    }

    /** Detect whether a git status target refers to a directory placeholder rather than a file. */
    private isDirectoryPath(relativePath: string, absolutePath: string): boolean {
        if (relativePath.endsWith('/')) {
            return true;
        }
        try {
            return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();
        } catch {
            return false;
        }
    }

    /** Expand an untracked/changed directory into concrete file paths for drift analysis. */
    private expandChangedDirectory(repoDir: string, prefix: string, target: string): string[] {
        const absoluteDir = path.join(repoDir, target.replace(/\//g, path.sep));
        const result: string[] = [];
        const stack = [absoluteDir];

        while (stack.length > 0) {
            const current = stack.pop();
            if (!current || !fs.existsSync(current)) {
                continue;
            }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const nextPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(nextPath);
                    continue;
                }
                const relative = path.relative(repoDir, nextPath).replace(/\\/g, '/');
                result.push((prefix + relative).replace(/\\/g, '/'));
            }
        }

        return result;
    }

    private runGit(cwd: string, args: string[]): string {
        try {
            const result = spawnSync('git', args, {
                cwd,
                encoding: 'utf8',
                windowsHide: true,
            });
            if (result.status !== 0) {
                return '';
            }
            return result.stdout || '';
        } catch {
            return '';
        }
    }

    private isCodeLikeFile(file: string): boolean {
        if (this.isSpecArtifactFile(file)) {
            return false;
        }
        return /\.(ts|tsx|js|jsx|py|java|go|cs|rb|php|rs|kt|swift|cpp|cc|c|h|hpp)$/.test(file);
    }

    private isSpecArtifactFile(file: string): boolean {
        return /(^|\/)(requirements|design|testcase|tasks)\.md$/.test(file)
            || /(^|\/)specs\//.test(file)
            || /(^|\/)(docs|specs)\/[\w-]+\/(requirements|design|testcase|tasks)\.md$/.test(file);
    }

    private generateDomainDigest(task: Feature, iterDir: string, rules: DomainRules): string {
        const entries = this.readLedger(iterDir).filter(item => item.taskId === task.id);
        const grouped = new Map<string, LedgerEntry[]>();
        for (const entry of entries) {
            const domains = entry.domains.length > 0 ? entry.domains : [rules.unknownDomain];
            for (const domain of domains) {
                if (!grouped.has(domain)) {
                    grouped.set(domain, []);
                }
                grouped.get(domain)!.push(entry);
            }
        }

        const summary = {
            totalChanges: entries.length,
            highRiskChanges: entries.filter(v => v.severity === 'high').length,
            mediumRiskChanges: entries.filter(v => v.severity === 'medium').length,
            lowRiskChanges: entries.filter(v => v.severity === 'low').length,
            blockedByGate: entries.filter(v => v.gateBlocked).length,
        };

        const lines: string[] = [];
        lines.push('# Spec Delta Domain Digest');
        lines.push('');
        lines.push(`- generatedAt: ${new Date().toISOString()}`);
        lines.push(`- taskId: ${task.id}`);
        lines.push(`- taskName: ${task.name}`);
        lines.push(`- gateLevel: ${resolveGateLevel(this.getConfig())}`);
        lines.push(`- totalChanges: ${summary.totalChanges}`);
        lines.push(`- blockedByGate: ${summary.blockedByGate}`);
        lines.push('');
        lines.push('## Executive Summary');
        lines.push('');
        lines.push(`- highRiskChanges: ${summary.highRiskChanges}`);
        lines.push(`- mediumRiskChanges: ${summary.mediumRiskChanges}`);
        lines.push(`- lowRiskChanges: ${summary.lowRiskChanges}`);
        lines.push('');
        lines.push('## Domain Index');
        lines.push('');
        lines.push('| domain | total | high | medium | low | blocked |');
        lines.push('| --- | --- | --- | --- | --- | --- |');
        const domains = Array.from(grouped.keys()).sort();
        for (const domain of domains) {
            const items = grouped.get(domain) || [];
            lines.push(`| ${domain} | ${items.length} | ${items.filter(v => v.severity === 'high').length} | ${items.filter(v => v.severity === 'medium').length} | ${items.filter(v => v.severity === 'low').length} | ${items.filter(v => v.gateBlocked).length} |`);
        }
        lines.push('');
        lines.push('## Domain Sections');
        lines.push('');
        for (const domain of domains) {
            const items = grouped.get(domain) || [];
            lines.push(`### Domain: ${domain}`);
            lines.push('');
            for (const item of items.slice(-20)) {
                lines.push(`- [${item.at}] [${item.stage}] [${item.severity}] ${item.summary}`);
                for (const detail of item.details.slice(0, 8)) {
                    lines.push(`  - ${detail}`);
                }
            }
            lines.push('');
        }

        const cfg = this.getConfig();
        const outputDir = path.join(getSpecDocsDir(iterDir, cfg), 'delta');
        fs.mkdirSync(outputDir, { recursive: true });

        const latestPath = path.join(outputDir, 'domain-digest.latest.md');
        const content = lines.join('\n') + '\n';
        fs.writeFileSync(latestPath, content, 'utf8');

        return latestPath;
    }

    private loadDomainRules(iterDir: string): DomainRules {
        const candidates = [
            path.join(this.masterRoot, 'docs', 'spec-delta', 'domain-classification-rules.yaml'),
            path.join(iterDir, 'docs', 'spec-delta', 'domain-classification-rules.yaml'),
        ];
        for (const file of candidates) {
            if (!fs.existsSync(file)) {
                continue;
            }
            try {
                const text = fs.readFileSync(file, 'utf8');
                return this.parseDomainRules(text);
            } catch {
                // ignore and fallback
            }
        }
        return DEFAULT_RULES;
    }

    private parseDomainRules(text: string): DomainRules {
        const rules: DomainRules = JSON.parse(JSON.stringify(DEFAULT_RULES)) as DomainRules;
        const unknown = text.match(/unknownDomain\s*:\s*([^\n]+)/i);
        if (unknown) {
            rules.unknownDomain = unknown[1].replace(/["']/g, '').trim();
        }
        const maxCandidates = text.match(/maxCandidateDomains\s*:\s*(\d+)/i);
        if (maxCandidates) {
            const parsed = Number(maxCandidates[1]);
            if (Number.isFinite(parsed) && parsed > 0) {
                rules.maxCandidateDomains = parsed;
            }
        }

        const strictDenyUncategorized = text.match(/denyIfUncategorized\s*:\s*(true|false)/i);
        if (strictDenyUncategorized) {
            rules.denyIfUncategorized = strictDenyUncategorized[1].toLowerCase() === 'true';
        }

        const sectionMatch = text.match(/domainDefinitions\s*:\s*([\s\S]*?)\nmappingRules\s*:/i);
        if (!sectionMatch) {
            return rules;
        }
        const section = sectionMatch[1];
        const lines = section.split(/\r?\n/);
        const parsedDomains: DomainDefinition[] = [];
        let current: DomainDefinition | undefined;
        let currentArrayKey: keyof DomainDefinition | '' = '';

        const flush = (): void => {
            if (!current) {
                return;
            }
            if (!current.id) {
                return;
            }
            parsedDomains.push(current);
        };

        for (const raw of lines) {
            const line = raw.replace(/\t/g, '    ');
            const idMatch = line.match(/^\s*-\s*id\s*:\s*([^\s#]+)/);
            if (idMatch) {
                flush();
                current = {
                    id: idMatch[1].trim(),
                    name: idMatch[1].trim(),
                    reqIdPrefixes: [],
                    artifactPathPatterns: [],
                    contractPatterns: [],
                    keywords: [],
                };
                currentArrayKey = '';
                continue;
            }
            if (!current) {
                continue;
            }

            const nameMatch = line.match(/^\s*name\s*:\s*(.+)$/);
            if (nameMatch) {
                current.name = nameMatch[1].replace(/["']/g, '').trim();
                continue;
            }

            const keyMatch = line.match(/^\s*(reqIdPrefixes|artifactPathPatterns|contractPatterns|keywords)\s*:\s*$/);
            if (keyMatch) {
                currentArrayKey = keyMatch[1] as keyof DomainDefinition;
                continue;
            }

            const itemMatch = line.match(/^\s*-\s*(.+)$/);
            if (itemMatch && currentArrayKey) {
                const value = itemMatch[1].replace(/["']/g, '').trim();
                (current[currentArrayKey] as unknown as string[]).push(value);
            }
        }
        flush();
        if (parsedDomains.length > 0) {
            rules.domainDefinitions = parsedDomains;
        }
        return rules;
    }

    private persistSnapshot(iterDir: string, stage: StageKey, snapshot: StageSnapshot): void {
        const dir = path.join(iterDir, BASE, 'spec-delta', 'snapshots');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${stage}.latest.json`), JSON.stringify(snapshot, null, 2), 'utf8');
    }

    private appendLedger(iterDir: string, entry: LedgerEntry): void {
        const file = path.join(iterDir, BASE, 'spec-delta', 'ledger.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    }

    private readLedger(iterDir: string): LedgerEntry[] {
        const file = path.join(iterDir, BASE, 'spec-delta', 'ledger.jsonl');
        if (!fs.existsSync(file)) {
            return [];
        }
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        const output: LedgerEntry[] = [];
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line) as LedgerEntry;
                if (parsed && parsed.taskId && parsed.type) {
                    output.push(parsed);
                }
            } catch {
                // ignore malformed lines
            }
        }
        return output;
    }

    private loadState(iterDir: string): SpecDeltaState {
        const file = path.join(iterDir, BASE, 'spec-delta', 'state.json');
        if (!fs.existsSync(file)) {
            return { version: 1, stageHashes: {}, stageSnapshots: {} };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SpecDeltaState;
            return {
                version: 1,
                stageHashes: parsed.stageHashes || {},
                stageSnapshots: parsed.stageSnapshots || {},
            };
        } catch {
            return { version: 1, stageHashes: {}, stageSnapshots: {} };
        }
    }

    private saveState(iterDir: string, state: SpecDeltaState): void {
        const file = path.join(iterDir, BASE, 'spec-delta', 'state.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    }

    private normalizeContent(content: string): string {
        return content
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private sha(value: string): string {
        return crypto.createHash('sha1').update(value).digest('hex');
    }
}
