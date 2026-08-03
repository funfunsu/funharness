import { Config, Feature } from './models';
import { FeatureScheduler } from './featureScheduler';

export class SchedulerRegistry {
    private readonly schedulers: Map<string, FeatureScheduler> = new Map();

    constructor(
        private readonly createIterDir: (task: Feature) => string,
        private readonly workspaceRoot: string,
        private readonly getConfig: () => Config,
        private readonly dispatchAi: (query: string, iterDir: string, source: 'stage-agent' | 'dev-subtask', providerOverride?: string) => Promise<void>,
        private readonly onStatusChange: () => void,
        private readonly getDevSystemPrompt: (task: Feature, subFeatureName?: string) => string,
    ) {}

    get(task: Feature): FeatureScheduler {
        if (!this.schedulers.has(task.id)) {
            const scheduler = new FeatureScheduler(
                this.createIterDir(task),
                this.workspaceRoot,
                this.getConfig(),
                this.dispatchAi,
                this.onStatusChange,
                (subTask, iterTask) => this.getDevSystemPrompt(iterTask, subTask.name),
            );
            this.schedulers.set(task.id, scheduler);
        }
        return this.schedulers.get(task.id)!;
    }

    stop(featureId: string): void {
        const scheduler = this.schedulers.get(featureId);
        if (!scheduler) {
            return;
        }
        scheduler.stopWatching();
        this.schedulers.delete(featureId);
    }

    stopAll(): void {
        this.schedulers.forEach((scheduler) => scheduler.stopWatching());
    }
}
