import { Config, Task } from './models';
import { TaskScheduler } from './taskScheduler';

export class SchedulerRegistry {
    private readonly schedulers: Map<string, TaskScheduler> = new Map();

    constructor(
        private readonly createIterDir: (task: Task) => string,
        private readonly workspaceRoot: string,
        private readonly getConfig: () => Config,
        private readonly dispatchAi: (query: string, iterDir: string, source: 'stage-agent' | 'dev-subtask') => Promise<void>,
        private readonly onStatusChange: () => void,
    ) {}

    get(task: Task): TaskScheduler {
        if (!this.schedulers.has(task.id)) {
            const scheduler = new TaskScheduler(
                this.createIterDir(task),
                this.workspaceRoot,
                this.getConfig(),
                this.dispatchAi,
                this.onStatusChange,
            );
            this.schedulers.set(task.id, scheduler);
        }
        return this.schedulers.get(task.id)!;
    }

    stop(taskId: string): void {
        const scheduler = this.schedulers.get(taskId);
        if (!scheduler) {
            return;
        }
        scheduler.stopWatching();
        this.schedulers.delete(taskId);
    }

    stopAll(): void {
        this.schedulers.forEach((scheduler) => scheduler.stopWatching());
    }
}
