import * as fs from 'fs';
import * as path from 'path';
import { BASE } from '../models';
import { ReviewStage, StageReviewSaveResult } from '../harnessMessages';

/** Per-stage custom review prompt configuration (MODEL-1, Req-3). */
export interface StageReviewPromptConfig {
    stage: ReviewStage;
    customPrompt: string;
    version: number;
    updatedAt: string;
}

const REVIEW_CONFIG_FILE = 'review-prompt-config.json';

/**
 * Service for saving and loading per-stage custom review prompts (API-3, Req-3).
 * Each stage maintains an independent configuration entry; cross-stage contamination
 * is structurally prevented by keying on stage (INV-8).
 */
export class ReviewPromptConfigService {
    private readonly configPath: string;
    private store: Map<ReviewStage, StageReviewPromptConfig> = new Map();
    private loaded = false;

    constructor(private readonly workspaceRoot: string) {
        this.configPath = path.join(workspaceRoot, BASE, REVIEW_CONFIG_FILE);
    }

    /** Lazily load config from disk. */
    private ensureLoaded(): void {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        if (!fs.existsSync(this.configPath)) {
            return;
        }
        try {
            const raw = fs.readFileSync(this.configPath, 'utf8');
            const items: StageReviewPromptConfig[] = JSON.parse(raw);
            for (const item of items) {
                if (item.stage && typeof item.customPrompt === 'string') {
                    this.store.set(item.stage, item);
                }
            }
        } catch {
            // Malformed file; start with empty store, do not rethrow
        }
    }

    /** Write current in-memory store to disk. */
    private persist(): void {
        const dir = path.dirname(this.configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const items = Array.from(this.store.values());
        fs.writeFileSync(this.configPath, JSON.stringify(items, null, 2), 'utf8');
    }

    /**
     * Save a custom prompt for the given stage (API-3).
     * Same-stage saves use last-write-wins with a monotonically incrementing version (INV-7).
     * Only the target stage is affected; other stages remain unchanged (INV-8).
     */
    saveStagePrompt(stage: ReviewStage, promptBody: string): StageReviewSaveResult {
        this.ensureLoaded();
        const existing = this.store.get(stage);
        const version = existing ? existing.version + 1 : 1;
        const updatedAt = new Date().toISOString();
        this.store.set(stage, { stage, customPrompt: promptBody, version, updatedAt });
        this.persist();
        return { savedVersion: version, updatedAt };
    }

    /**
     * Read the saved custom prompt for the given stage.
     * Returns undefined when no custom prompt has been saved for this stage (INV-3).
     */
    getStagePrompt(stage: ReviewStage): string | undefined {
        this.ensureLoaded();
        return this.store.get(stage)?.customPrompt;
    }
}
