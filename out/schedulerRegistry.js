"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulerRegistry = void 0;
const taskScheduler_1 = require("./taskScheduler");
class SchedulerRegistry {
    constructor(createIterDir, workspaceRoot, getConfig, dispatchAi, onStatusChange) {
        this.createIterDir = createIterDir;
        this.workspaceRoot = workspaceRoot;
        this.getConfig = getConfig;
        this.dispatchAi = dispatchAi;
        this.onStatusChange = onStatusChange;
        this.schedulers = new Map();
    }
    get(task) {
        if (!this.schedulers.has(task.id)) {
            const scheduler = new taskScheduler_1.TaskScheduler(this.createIterDir(task), this.workspaceRoot, this.getConfig(), this.dispatchAi, this.onStatusChange);
            this.schedulers.set(task.id, scheduler);
        }
        return this.schedulers.get(task.id);
    }
    stop(taskId) {
        const scheduler = this.schedulers.get(taskId);
        if (!scheduler) {
            return;
        }
        scheduler.stopWatching();
        this.schedulers.delete(taskId);
    }
    stopAll() {
        this.schedulers.forEach((scheduler) => scheduler.stopWatching());
    }
}
exports.SchedulerRegistry = SchedulerRegistry;
//# sourceMappingURL=schedulerRegistry.js.map