import { ReviewStage, StageContext, StageReviewRunResult, StageReviewStatusResult } from '../harnessMessages';
import { PromptService } from './promptService';
import { ReviewPromptConfigService } from './reviewPromptConfigService';

/** In-memory status record for a running or completed review (MODEL-4, Req-4). */
interface StageReviewStatus {
    reviewId: string;
    stage: ReviewStage;
    status: 'idle' | 'running' | 'completed' | 'failed';
    summary?: string;
    errorReason?: string;
    updatedAt: string;
}

/** Minimal AI chat interface required for review dispatch. */
export interface ReviewAiProvider {
    /** Send the composed prompt to AI and return the generated summary. Rejects on failure. */
    chat(composedPrompt: string): Promise<string>;
}

/**
 * Service for executing stage reviews and tracking their status (API-4, API-5, Req-4).
 *
 * Non-blocking contract (INV-10): review failures update internal status only; they never
 * write to main-workflow completion gates and must not block stage save/advance operations.
 */
export class ReviewExecutionService {
    private readonly statusStore = new Map<ReviewStage, StageReviewStatus>();

    constructor(
        private readonly promptService: PromptService,
        private readonly configService: ReviewPromptConfigService,
        private readonly aiProvider: ReviewAiProvider,
    ) {}

    /**
     * Run a stage review (API-4, Req-2, Req-3, Req-4).
     *
     * Returns immediately with `status: 'running'`; execution continues asynchronously
     * and updates the internal status store on completion or failure (INV-9).
     * Invalid stage values are rejected with `status: 'failed'` (error-handling contract).
     */
    async runStageReview(stage: ReviewStage, context: StageContext): Promise<StageReviewRunResult> {
        const reviewId = `review-${stage}-${Date.now()}`;
        this.statusStore.set(stage, {
            reviewId,
            stage,
            status: 'running',
            updatedAt: new Date().toISOString(),
        });

        // Resolve prompt — composedPrompt must contain context + template body (INV-4)
        let composedPrompt: string;
        try {
            const resolved = this.promptService.resolveReviewPromptByStage(stage, context, this.configService);
            composedPrompt = resolved.composedPrompt;
        } catch (resolveError) {
            const errorReason = resolveError instanceof Error ? resolveError.message : String(resolveError);
            this.statusStore.set(stage, {
                reviewId,
                stage,
                status: 'failed',
                errorReason,
                updatedAt: new Date().toISOString(),
            });
            return { reviewId, status: 'failed', errorReason };
        }

        // Fire-and-forget execution; no await so caller returns immediately
        this.executeReview(reviewId, stage, composedPrompt);

        return { reviewId, status: 'running' };
    }

    /**
     * Get the latest review status for the given stage (API-5, Req-4).
     * Returns `{ status: 'idle' }` when no review has been run for this stage.
     * The returned status is purely informational and carries no workflow gate semantics (INV-10).
     */
    getLatestReviewStatus(stage: ReviewStage): StageReviewStatusResult {
        const entry = this.statusStore.get(stage);
        if (!entry) {
            return { status: 'idle' };
        }
        return {
            status: entry.status,
            summary: entry.summary,
            errorReason: entry.errorReason,
        };
    }

    /** Async review execution — status transitions: running → completed | failed (INV-9). */
    private executeReview(reviewId: string, stage: ReviewStage, composedPrompt: string): void {
        this.aiProvider.chat(composedPrompt).then(summary => {
            this.statusStore.set(stage, {
                reviewId,
                stage,
                status: 'completed',
                summary,
                updatedAt: new Date().toISOString(),
            });
        }).catch((error: unknown) => {
            const errorReason = error instanceof Error ? error.message : String(error);
            this.statusStore.set(stage, {
                reviewId,
                stage,
                status: 'failed',
                errorReason,
                updatedAt: new Date().toISOString(),
            });
        });
    }
}
