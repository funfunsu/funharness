"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const models_1 = require("../models");
class PromptService {
    constructor(workspaceRoot, extensionPath) {
        this.workspaceRoot = workspaceRoot;
        this.extensionPath = extensionPath;
    }
    ensureProjectPrompts() {
        const targetDir = this.getProjectPromptsDir();
        fs.mkdirSync(targetDir, { recursive: true });
        for (const cfg of models_1.PROMPT_CONFIGS) {
            const target = path.join(targetDir, cfg.file);
            if (!fs.existsSync(target)) {
                const source = this.getBundledPromptFile(cfg.key);
                if (fs.existsSync(source)) {
                    fs.copyFileSync(source, target);
                }
            }
        }
    }
    createAgentDefinitions() {
        const agentDir = path.join(this.workspaceRoot, models_1.AGENT_DIR);
        fs.mkdirSync(agentDir, { recursive: true });
        for (const cfg of models_1.PROMPT_CONFIGS) {
            const agentFile = path.join(agentDir, `fun-harness-${cfg.key}.agent.md`);
            const promptContent = this.getBundledPromptContent(cfg.key);
            fs.writeFileSync(agentFile, this.buildAgentDefinition(cfg.key, cfg.name, promptContent), 'utf8');
        }
    }
    restoreAgentPrompt(promptKey) {
        const cfg = models_1.PROMPT_CONFIGS.find(c => c.key === promptKey);
        if (!cfg) {
            return;
        }
        const agentDir = path.join(this.workspaceRoot, models_1.AGENT_DIR);
        const agentFile = path.join(agentDir, `fun-harness-${promptKey}.agent.md`);
        const promptContent = this.getBundledPromptContent(promptKey);
        fs.writeFileSync(agentFile, this.buildAgentDefinition(promptKey, cfg.name, promptContent), 'utf8');
    }
    getRenderedPrompt(step, taskName, taskDesc, currentWorkSpace, config) {
        const rendered = this.getRenderedPromptWithSource(step, taskName, taskDesc, currentWorkSpace, config);
        return rendered.content;
    }
    getRenderedPromptWithSource(step, taskName, taskDesc, currentWorkSpace, config) {
        const resolved = this.resolvePromptFile(step, currentWorkSpace);
        if (!resolved.path || !fs.existsSync(resolved.path)) {
            return { content: '', source: resolved.source, path: resolved.path };
        }
        const content = fs.readFileSync(resolved.path, 'utf8');
        const techStack = (config?.techStack || '').trim();
        const codingStandards = (config?.codingStandards || '').trim();
        const projectConventions = (config?.projectConventions || '').trim();
        let renderedContent = content
            .replace(/{{taskName}}/g, taskName)
            .replace(/{{taskDesc}}/g, taskDesc)
            .replace(/{{currentWorkSpace}}/g, currentWorkSpace)
            .replace(/{{techStack}}/g, techStack)
            .replace(/{{codingStandards}}/g, codingStandards)
            .replace(/{{projectConventions}}/g, projectConventions);
        if (projectConventions && !/{{projectConventions}}/g.test(content)) {
            renderedContent += `\n\n## 项目自定义约定\n${projectConventions}\n`;
        }
        return {
            content: renderedContent,
            source: resolved.source,
            path: resolved.path,
        };
    }
    resolvePromptFile(step, currentWorkSpace) {
        const item = models_1.PROMPT_CONFIGS.find(i => i.key === step);
        if (!item) {
            return { source: 'bundled-default', path: '' };
        }
        const taskOverride = path.join(currentWorkSpace, models_1.BASE, models_1.PROMPTS_DIR, item.file);
        if (fs.existsSync(taskOverride)) {
            return { source: 'task-override', path: taskOverride };
        }
        const masterRoot = this.resolveMasterRoot(currentWorkSpace);
        if (masterRoot) {
            const masterOverride = path.join(masterRoot, models_1.BASE, models_1.PROMPTS_DIR, item.file);
            if (fs.existsSync(masterOverride)) {
                return { source: 'master-override', path: masterOverride };
            }
        }
        const workspaceOverride = this.getPromptFile(step);
        if (workspaceOverride && fs.existsSync(workspaceOverride)) {
            return { source: 'workspace-override', path: workspaceOverride };
        }
        return { source: 'bundled-default', path: this.getBundledPromptFile(step) };
    }
    resolveMasterRoot(currentWorkSpace) {
        const configCandidates = [
            path.join(currentWorkSpace, models_1.BASE, 'config.json'),
            path.join(this.workspaceRoot, models_1.BASE, 'config.json'),
        ];
        for (const file of configCandidates) {
            if (!fs.existsSync(file)) {
                continue;
            }
            try {
                const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
                const masterRoot = typeof raw.__harnessMasterRoot === 'string' ? raw.__harnessMasterRoot : '';
                if (!masterRoot) {
                    continue;
                }
                const resolvedMasterRoot = path.resolve(masterRoot);
                if (!this.isWithinWorkspaceRoot(resolvedMasterRoot)) {
                    continue;
                }
                if (fs.existsSync(resolvedMasterRoot)) {
                    return resolvedMasterRoot;
                }
            }
            catch {
                // Ignore malformed config and continue.
            }
        }
        return '';
    }
    isWithinWorkspaceRoot(targetPath) {
        const root = path.resolve(this.workspaceRoot);
        const target = path.resolve(targetPath);
        return target === root || target.startsWith(`${root}${path.sep}`);
    }
    getProjectPromptsDir() {
        return path.join(this.workspaceRoot, models_1.BASE, models_1.PROMPTS_DIR);
    }
    getPromptFile(key) {
        const item = models_1.PROMPT_CONFIGS.find(i => i.key === key);
        if (!item) {
            return '';
        }
        return path.join(this.getProjectPromptsDir(), item.file);
    }
    getBundledPromptFile(key) {
        const item = models_1.PROMPT_CONFIGS.find(i => i.key === key);
        if (!item) {
            return '';
        }
        return path.join(this.extensionPath, models_1.PROMPTS_DIR, item.file);
    }
    getBundledPromptContent(key) {
        const file = this.getBundledPromptFile(key);
        if (!file || !fs.existsSync(file)) {
            return '';
        }
        return fs.readFileSync(file, 'utf8');
    }
    buildAgentDefinition(key, name, promptContent) {
        return `---
name: fun-harness-${key}
description: ${name}
argument-hint: "The task name, description, and output path"
---

${promptContent}
`;
    }
}
exports.PromptService = PromptService;
//# sourceMappingURL=promptService.js.map