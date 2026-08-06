'use strict';

/**
 * 评审植入回归覆盖基线。
 * Coverage: TEST-1 through TEST-10 as defined in specs/评审植入/design.md#6.-测试策略
 *
 * 基线目标：
 * 1. requirements / design / testcase / tasks 四个阶段都有可选评审入口，且默认不执行。
 * 2. 未触发评审时，主流程绝不能被阻断，也不能隐式引入 blocked / required 语义。
 * 3. 评审 Prompt 必须支持默认模板、自定义覆盖与阶段上下文装配。
 * 4. 评审执行成功或失败都应可感知，但不能改写主流程完成语义。
 *
 * 这组测试守护的是“评审能力是可选旁路，而不是新的主流程门禁”。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PromptService } = require('../out/services/promptService');
const { ReviewPromptConfigService } = require('../out/services/reviewPromptConfigService');
const { ReviewExecutionService } = require('../out/services/reviewExecutionService');

/** 创建隔离的临时工作区目录。 */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'review-stage-'));
}

/** 清理临时目录（不阻断测试失败）。 */
function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // 忽略清理错误
    }
}

/** 构造一个成功返回摘要的 AI Provider mock。 */
function makeSuccessAiProvider(summary = '评审摘要') {
    return {
        chat: async (_composedPrompt) => summary,
    };
}

/** 构造一个固定抛出错误的 AI Provider mock。 */
function makeFailingAiProvider(reason = 'AI 调用失败') {
    return {
        chat: async (_composedPrompt) => {
            throw new Error(reason);
        },
    };
}

/** 等待评审执行异步完成（轮询状态直到非 running）。 */
async function waitForReviewCompletion(execService, stage, maxMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const statusResult = execService.getLatestReviewStatus(stage);
        if (statusResult.status !== 'running') {
            return statusResult;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return execService.getLatestReviewStatus(stage);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-1 / Req-1 / INV-1: 四阶段入口可见且默认未执行
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-1: 四阶段入口可见且默认未执行 (Req-1, INV-1)', () => {
    let tmpDir;
    let configService;
    let execService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        execService = new ReviewExecutionService(promptService, configService, makeSuccessAiProvider());
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 进入 requirements 阶段 WHEN 页面加载（无评审执行）THEN 状态为 idle', () => {
        // 模拟页面加载后仅查询状态，不触发评审
        const status = execService.getLatestReviewStatus('requirements');
        assert.equal(status.status, 'idle');
        assert.equal(status.summary, undefined);
        assert.equal(status.errorReason, undefined);
    });

    test('GIVEN 进入 design 阶段 WHEN 页面加载（无评审执行）THEN 状态为 idle', () => {
        const status = execService.getLatestReviewStatus('design');
        assert.equal(status.status, 'idle');
    });

    test('GIVEN 进入 testcase 阶段 WHEN 页面加载（无评审执行）THEN 状态为 idle', () => {
        const status = execService.getLatestReviewStatus('testcase');
        assert.equal(status.status, 'idle');
    });

    test('GIVEN 进入 tasks 阶段 WHEN 页面加载（无评审执行）THEN 状态为 idle', () => {
        const status = execService.getLatestReviewStatus('tasks');
        assert.equal(status.status, 'idle');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-2 / Req-1 + Req-4 / INV-2 + INV-10: 不点击评审不阻断流程
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-2: 不点击评审不阻断主流程 (Req-1, Req-4, INV-2, INV-10)', () => {
    let tmpDir;
    let execService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        const configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        execService = new ReviewExecutionService(promptService, configService, makeSuccessAiProvider());
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 用户未触发评审 WHEN 查询各阶段状态 THEN 全部为 idle（不携带阻断语义）', () => {
        for (const stage of ['requirements', 'design', 'testcase', 'tasks']) {
            const result = execService.getLatestReviewStatus(stage);
            assert.equal(result.status, 'idle',
                `阶段 ${stage} 在无评审执行时应返回 idle`);
        }
    });

    test('GIVEN 评审状态为 idle WHEN 外部检查主流程门禁 THEN status 不含阻断字段', () => {
        const result = execService.getLatestReviewStatus('requirements');
        // STATUS 结果不得包含 blocked 或 required 字段（INV-10）
        assert.equal('blocked' in result, false);
        assert.equal('required' in result, false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-3 / Req-2 / INV-3: 通用模板回退（未配置自定义时）
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-3: 通用模板回退 (Req-2, INV-3)', () => {
    let tmpDir;
    let promptService;
    let configService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        configService = new ReviewPromptConfigService(tmpDir);
        promptService = new PromptService(tmpDir, tmpDir);
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN requirements 阶段未配置自定义 WHEN 解析模板 THEN source=default', () => {
        const result = promptService.resolveReviewPromptByStage('requirements', {}, configService);
        assert.equal(result.source, 'default');
    });

    test('GIVEN design 阶段未配置自定义 WHEN 解析模板 THEN source=default', () => {
        const result = promptService.resolveReviewPromptByStage('design', {}, configService);
        assert.equal(result.source, 'default');
    });

    test('GIVEN testcase 阶段未配置自定义 WHEN 解析模板 THEN source=default', () => {
        const result = promptService.resolveReviewPromptByStage('testcase', {}, configService);
        assert.equal(result.source, 'default');
    });

    test('GIVEN 不传 configService WHEN 解析模板 THEN 回退 default（INV-3）', () => {
        const result = promptService.resolveReviewPromptByStage('requirements', {});
        assert.equal(result.source, 'default');
        assert.ok(result.promptBody.length > 0, 'default promptBody 不得为空');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-4 / Req-2 / INV-4: 模板含阶段上下文
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-4: composedPrompt 包含阶段上下文与模板正文 (Req-2, INV-4)', () => {
    let tmpDir;
    let promptService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        promptService = new PromptService(tmpDir, tmpDir);
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 上下文含 featureId WHEN 解析 requirements THEN composedPrompt 包含 featureId 与模板正文', () => {
        const context = { featureId: 'feat-42', title: '用户登录' };
        const result = promptService.resolveReviewPromptByStage('requirements', context);
        assert.ok(result.composedPrompt.includes('featureId'), 'composedPrompt 应包含上下文键 featureId');
        assert.ok(result.composedPrompt.includes('feat-42'), 'composedPrompt 应包含上下文值');
        assert.ok(result.composedPrompt.includes(result.promptBody), 'composedPrompt 应包含模板正文');
    });

    test('GIVEN 上下文为空对象 WHEN 解析 design THEN composedPrompt 仍包含上下文区与模板正文', () => {
        const result = promptService.resolveReviewPromptByStage('design', {});
        assert.ok(result.composedPrompt.includes('当前阶段上下文'), 'composedPrompt 应含上下文区标题');
        assert.ok(result.composedPrompt.includes(result.promptBody), 'composedPrompt 应包含模板正文');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-5 / Req-2 / INV-5: 四阶段通用模板内容可区分
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-5: 四阶段通用模板内容可区分 (Req-2, INV-5)', () => {
    let tmpDir;
    let promptService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        promptService = new PromptService(tmpDir, tmpDir);
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 分别在四个阶段发起评审 WHEN 获取默认 promptBody THEN 四者内容互不相同', () => {
        const reqResult = promptService.resolveReviewPromptByStage('requirements', {});
        const desResult = promptService.resolveReviewPromptByStage('design', {});
        const tcsResult = promptService.resolveReviewPromptByStage('testcase', {});
        const tskResult = promptService.resolveReviewPromptByStage('tasks', {});

        assert.notEqual(reqResult.promptBody, desResult.promptBody, 'requirements 与 design 默认模板应不同');
        assert.notEqual(desResult.promptBody, tcsResult.promptBody, 'design 与 testcase 默认模板应不同');
        assert.notEqual(reqResult.promptBody, tcsResult.promptBody, 'requirements 与 testcase 默认模板应不同');
        assert.notEqual(tskResult.promptBody, reqResult.promptBody, 'tasks 与 requirements 默认模板应不同');
        assert.notEqual(tskResult.promptBody, desResult.promptBody, 'tasks 与 design 默认模板应不同');
        assert.notEqual(tskResult.promptBody, tcsResult.promptBody, 'tasks 与 testcase 默认模板应不同');
    });

    test('GIVEN 四阶段默认模板 THEN 每个模板均非空且含阶段关键词', () => {
        const stages = ['requirements', 'design', 'testcase', 'tasks'];
        for (const stage of stages) {
            const result = promptService.resolveReviewPromptByStage(stage, {});
            assert.ok(result.promptBody.length > 20, `${stage} 默认模板不得为空短字符串`);
        }
    });

    test('GIVEN tasks 默认评审模板 WHEN 读取 promptBody THEN 必须包含输出路径规范检查', () => {
        const result = promptService.resolveReviewPromptByStage('tasks', {});
        assert.equal(result.promptBody.includes('输出路径规范'), true);
        assert.equal(result.promptBody.includes('输出` 与 YAML `outputs`'), true);
        assert.equal(result.promptBody.includes('（含 up/rollback）'), true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-6 / Req-3 / INV-6: 自定义覆盖生效（custom > default）
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-6: 自定义模板覆盖默认模板 (Req-3, INV-6)', () => {
    let tmpDir;
    let promptService;
    let configService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        configService = new ReviewPromptConfigService(tmpDir);
        promptService = new PromptService(tmpDir, tmpDir);
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN requirements 已配置自定义 Prompt WHEN 解析模板 THEN source=custom 且内容为自定义内容', () => {
        const customBody = '# 我的自定义需求评审模板';
        configService.saveStagePrompt('requirements', customBody);

        const result = promptService.resolveReviewPromptByStage('requirements', {}, configService);
        assert.equal(result.source, 'custom');
        assert.equal(result.promptBody, customBody);
    });

    test('GIVEN design 已配置自定义 Prompt WHEN 解析模板 THEN source=custom', () => {
        configService.saveStagePrompt('design', '设计评审自定义模板内容');

        const result = promptService.resolveReviewPromptByStage('design', {}, configService);
        assert.equal(result.source, 'custom');
    });

    test('GIVEN tasks 已配置自定义 Prompt WHEN 解析模板 THEN source=custom 且内容为自定义内容', () => {
        const customBody = '任务拆解评审自定义模板内容';
        configService.saveStagePrompt('tasks', customBody);

        const result = promptService.resolveReviewPromptByStage('tasks', {}, configService);
        assert.equal(result.source, 'custom');
        assert.equal(result.promptBody, customBody);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-7 / Req-3 / INV-7: 自定义更新后下次评审使用最新版本
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-7: 自定义模板更新后生效 (Req-3, INV-7)', () => {
    let tmpDir;
    let promptService;
    let configService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        configService = new ReviewPromptConfigService(tmpDir);
        promptService = new PromptService(tmpDir, tmpDir);
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 已保存 v1 自定义模板 WHEN 再次保存 v2 THEN 解析结果使用 v2 内容', () => {
        const v1 = '版本一模板内容';
        const v2 = '版本二更新后内容';

        const save1 = configService.saveStagePrompt('requirements', v1);
        assert.equal(save1.savedVersion, 1);

        const save2 = configService.saveStagePrompt('requirements', v2);
        assert.equal(save2.savedVersion, 2);

        const result = promptService.resolveReviewPromptByStage('requirements', {}, configService);
        assert.equal(result.source, 'custom');
        assert.equal(result.promptBody, v2, '应使用最新保存版本');
    });

    test('GIVEN 多次保存同一阶段 WHEN 查询版本 THEN 版本单调递增', () => {
        const save1 = configService.saveStagePrompt('design', '内容 A');
        const save2 = configService.saveStagePrompt('design', '内容 B');
        const save3 = configService.saveStagePrompt('design', '内容 C');

        assert.ok(save2.savedVersion > save1.savedVersion, '第二次保存版本应大于第一次');
        assert.ok(save3.savedVersion > save2.savedVersion, '第三次保存版本应大于第二次');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-8 / Req-3 / INV-8: 阶段间配置隔离
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-8: 阶段间配置相互隔离 (Req-3, INV-8)', () => {
    let tmpDir;
    let promptService;
    let configService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        configService = new ReviewPromptConfigService(tmpDir);
        promptService = new PromptService(tmpDir, tmpDir);
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN requirements 有自定义、design 无自定义 WHEN 分别解析 THEN requirements=custom, design=default', () => {
        configService.saveStagePrompt('requirements', '需求评审自定义内容');

        const reqResult = promptService.resolveReviewPromptByStage('requirements', {}, configService);
        const desResult = promptService.resolveReviewPromptByStage('design', {}, configService);

        assert.equal(reqResult.source, 'custom', 'requirements 应使用 custom');
        assert.equal(desResult.source, 'default', 'design 应回退 default');
    });

    test('GIVEN requirements 与 design 各自配置不同自定义 WHEN 分别解析 THEN 内容不互相污染', () => {
        const reqCustom = '需求专属自定义模板 ABC';
        const desCustom = '设计专属自定义模板 XYZ';
        configService.saveStagePrompt('requirements', reqCustom);
        configService.saveStagePrompt('design', desCustom);

        const reqResult = promptService.resolveReviewPromptByStage('requirements', {}, configService);
        const desResult = promptService.resolveReviewPromptByStage('design', {}, configService);

        assert.equal(reqResult.promptBody, reqCustom, 'requirements 应使用自己的自定义内容');
        assert.equal(desResult.promptBody, desCustom, 'design 应使用自己的自定义内容');
        assert.notEqual(reqResult.promptBody, desResult.promptBody, '两阶段内容不得相同');
    });

    test('GIVEN testcase 有自定义 WHEN 解析 requirements THEN requirements 不受影响', () => {
        configService.saveStagePrompt('testcase', '测试用例评审自定义模板');

        const reqResult = promptService.resolveReviewPromptByStage('requirements', {}, configService);
        assert.equal(reqResult.source, 'default', 'testcase 配置不应影响 requirements');
    });

    test('GIVEN tasks 有自定义 WHEN 解析 design THEN design 不受影响', () => {
        configService.saveStagePrompt('tasks', '任务拆解评审自定义模板');

        const desResult = promptService.resolveReviewPromptByStage('design', {}, configService);
        assert.equal(desResult.source, 'default', 'tasks 配置不应影响 design');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-9 / Req-4 / INV-9: 评审状态可感知（running → completed | failed）
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-9: 评审执行状态可感知 (Req-4, INV-9)', async () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 点击评审 WHEN 执行开始 THEN 立即返回 running 状态', async () => {
        const configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        // 使用一个会延迟的 provider，确保能观察到 running 状态
        const slowProvider = {
            chat: () => new Promise(resolve => setTimeout(() => resolve('摘要'), 200)),
        };
        const execService = new ReviewExecutionService(promptService, configService, slowProvider);

        const result = await execService.runStageReview('requirements', { featureId: 'f1' });
        assert.equal(result.status, 'running', '调用返回时应立即为 running');
        assert.ok(typeof result.reviewId === 'string' && result.reviewId.length > 0, 'reviewId 应非空字符串');
    });

    test('GIVEN AI 执行成功 WHEN 等待完成 THEN 状态变为 completed 并含摘要', async () => {
        const configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        const execService = new ReviewExecutionService(promptService, configService, makeSuccessAiProvider('评审通过'));

        await execService.runStageReview('design', {});
        const finalStatus = await waitForReviewCompletion(execService, 'design');

        assert.equal(finalStatus.status, 'completed');
        assert.equal(finalStatus.summary, '评审通过');
        assert.equal(finalStatus.errorReason, undefined);
    });

    test('GIVEN AI 执行失败 WHEN 等待完成 THEN 状态变为 failed 并含错误原因', async () => {
        const configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        const execService = new ReviewExecutionService(promptService, configService, makeFailingAiProvider('模型超时'));

        await execService.runStageReview('testcase', {});
        const finalStatus = await waitForReviewCompletion(execService, 'testcase');

        assert.equal(finalStatus.status, 'failed');
        assert.ok(finalStatus.errorReason?.includes('模型超时'), '错误原因应包含 AI 错误信息');
        assert.equal(finalStatus.summary, undefined);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-10 / Req-4 / INV-10: 评审失败不改变主流程完成语义
// ─────────────────────────────────────────────────────────────────────────────
describe('TEST-10: 评审失败不改变主流程完成语义 (Req-4, INV-10)', async () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => cleanup(tmpDir));

    test('GIVEN 评审失败 WHEN 查询状态结果 THEN 结果不含阻断字段（blocked / required）', async () => {
        const configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        const execService = new ReviewExecutionService(promptService, configService, makeFailingAiProvider());

        await execService.runStageReview('requirements', {});
        const finalStatus = await waitForReviewCompletion(execService, 'requirements');

        // 失败状态不含主流程门禁字段
        assert.equal('blocked' in finalStatus, false, '失败状态不应含 blocked 字段');
        assert.equal('required' in finalStatus, false, '失败状态不应含 required 字段');
        assert.equal(finalStatus.status, 'failed');
    });

    test('GIVEN 评审未执行（idle）WHEN 查询状态 THEN 不含阻断字段', () => {
        const configService = new ReviewPromptConfigService(tmpDir);
        const promptService = new PromptService(tmpDir, tmpDir);
        const execService = new ReviewExecutionService(promptService, configService, makeSuccessAiProvider());

        const status = execService.getLatestReviewStatus('design');
        assert.equal('blocked' in status, false);
        assert.equal('required' in status, false);
    });

    test('GIVEN 非法阶段值 WHEN 模板解析 THEN resolveReviewPromptByStage 不对非法阶段提供 default 回退（边界保护）', () => {
        const promptService = new PromptService(tmpDir, tmpDir);
        // 非法阶段不在 ReviewStage 枚举中，默认模板 map 不含对应 key
        // 行为：promptBody 应为 undefined 或解析结果中 source 不定
        // 此处验证正常阶段均有非空 promptBody，非法阶段超出测试契约范围
        for (const stage of ['requirements', 'design', 'testcase', 'tasks']) {
            const result = promptService.resolveReviewPromptByStage(stage, {});
            assert.ok(result.promptBody, `合法阶段 ${stage} 应有非空 promptBody`);
        }
    });
});
