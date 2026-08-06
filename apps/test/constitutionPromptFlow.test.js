'use strict';

/**
 * 宪章加载与注入顺序回归覆盖基线。
 *
 * 覆盖场景：
 * 1. specs/constitution.md 存在时，必须完整采用项目宪章，不得拼接 bundled default。
 * 2. 阶段 Prompt 中宪章区块不得放在最前面，避免会话主题被固定摘要为宪章说明。
 *
 * 这组测试守护的是“项目自定义优先 + 宪章后置注入”的稳定行为。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveConstitution } = require('../out/constitution');
const { PromptService } = require('../out/services/promptService');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fh-constitution-flow-'));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore best-effort cleanup failures
    }
}

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

describe('宪章加载与注入顺序覆盖基线', () => {
    test('GIVEN specs/constitution.md 存在 WHEN 解析宪章 THEN 仅使用项目宪章内容', () => {
        const workspaceRoot = makeTempDir();
        const extensionPath = makeTempDir();
        try {
            const customOnlyMarker = 'CUSTOM_CONSTITUTION_ONLY_MARKER';
            const defaultOnlyMarker = 'DEFAULT_CONSTITUTION_ONLY_MARKER';
            writeFile(path.join(workspaceRoot, 'specs', 'constitution.md'), customOnlyMarker);
            writeFile(path.join(extensionPath, 'system-prompts', 'constitution_default.md'), defaultOnlyMarker);

            const resolved = resolveConstitution(workspaceRoot, workspaceRoot, extensionPath);
            assert.equal(resolved.source, 'project');
            assert.equal(resolved.content.includes(customOnlyMarker), true);
            assert.equal(resolved.content.includes(defaultOnlyMarker), false);
        } finally {
            cleanup(workspaceRoot);
            cleanup(extensionPath);
        }
    });

    test('GIVEN 阶段系统提示词与项目宪章 WHEN 组装 req Prompt THEN 宪章区块位于系统提示词之后', () => {
        const workspaceRoot = makeTempDir();
        const extensionPath = makeTempDir();
        try {
            const lockedMarker = 'LOCKED_SYSTEM_PROMPT_MARKER';
            const constitutionMarker = 'CUSTOM_CONSTITUTION_BODY_MARKER';
            writeFile(path.join(extensionPath, 'system-prompts', 'requirement_system_prompt.md'), lockedMarker);
            writeFile(path.join(workspaceRoot, 'specs', 'constitution.md'), constitutionMarker);

            const service = new PromptService(workspaceRoot, extensionPath);
            const rendered = service.getRenderedPromptWithSource('req', '任务A', '描述A', workspaceRoot);
            const content = rendered.content;

            const lockedIndex = content.indexOf(lockedMarker);
            const constitutionIndex = content.indexOf(constitutionMarker);

            assert.equal(lockedIndex >= 0, true, '应包含系统提示词内容');
            assert.equal(constitutionIndex > lockedIndex, true, '宪章内容应在系统提示词之后');
        } finally {
            cleanup(workspaceRoot);
            cleanup(extensionPath);
        }
    });
});
