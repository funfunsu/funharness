import * as fs from 'fs';
import * as path from 'path';

export interface CodeGraphAgentsGuideResult {
    updated: boolean;
    summary: string;
}

/**
 * Ensures worktree-level AGENTS.md contains a reusable CodeGraph usage guide.
 */
export class CodeGraphAgentsGuideUpdater {
    private static readonly startMarker = '<!-- FUN_HARNESS_CODEGRAPH_USAGE_START -->';
    private static readonly endMarker = '<!-- FUN_HARNESS_CODEGRAPH_USAGE_END -->';

    ensureUsageGuide(worktreePath: string): CodeGraphAgentsGuideResult {
        try {
            const agentsPath = path.join(worktreePath, 'AGENTS.md');
            const block = this.buildGuideBlock();

            if (fs.existsSync(agentsPath)) {
                return { updated: false, summary: 'AGENTS.md already exists; skip auto write to avoid growth' };
            }

            fs.writeFileSync(agentsPath, `${block}\n`, 'utf8');
            return { updated: true, summary: 'AGENTS.md created with CodeGraph usage guide' };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { updated: false, summary: `AGENTS.md usage guide update skipped: ${detail}` };
        }
    }

    private buildGuideBlock(): string {
        return [
            CodeGraphAgentsGuideUpdater.startMarker,
            '## CodeGraph 复用方法（自动写入）',
            '',
            '- 在仓库根目录执行 `codegraph sync -q` 刷新索引。',
            '- 对话分析前优先读取 `.codegraph/evidence.json` 或 `.codegraph/evidence/bundle.json`。',
            '- 若存在 `.harness/process/codegraph-evidence.json`，优先引用其中 anchors/seams/impactSet 约束改动范围。',
            '- 若证据缺失或过期（stale/missing），先告警再分析，且不要把“未查询到节点”当成“没有关系”。',
            '',
            '说明：该段由 Fun Harness 在 CodeGraph 初始化成功后自动维护，用于后续对话复用图谱证据。',
            CodeGraphAgentsGuideUpdater.endMarker,
        ].join('\n');
    }
}