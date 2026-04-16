const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

// =============================================================================
// Integration Test Harness - Simulates complete workflow with all services
// =============================================================================

const HarnessStep = {
  DESIGN: 'DESIGN',
  DEVELOPING: 'DEVELOPING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DONE: 'DONE'
};

const STAGE = {
  DESIGN: 'DESIGN',
  DEVELOPING: 'DEVELOPING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DONE: 'DONE'
};

// Mock Task class
let taskSeq = 0;
class Task {
  constructor(name, description) {
    taskSeq += 1;
    this.id = `task-${Date.now()}-${taskSeq}`;
    this.name = name;
    this.description = description;
    this.stage = STAGE.DESIGN;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }
}

// Mock TaskScheduler
class TaskScheduler {
  constructor(taskId) {
    this.taskId = taskId;
    this.interval = null;
  }

  start(callback) {
    this.interval = setInterval(callback, 1000);
    if (this.interval.unref) {
      this.interval.unref(); // Don't keep process alive
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  isRunning() {
    return this.interval !== null;
  }
}

// Simple in-memory store service
class InMemoryTaskStore {
  constructor() {
    this.tasks = [];
    this.config = { frontendGithub: '', backendGithub: '', frontendBranch: '', backendBranch: '' };
  }

  async saveTasks(tasks) {
    this.tasks = JSON.parse(JSON.stringify(tasks));
    return true;
  }

  async loadTasks() {
    return this.tasks;
  }

  async saveConfig(config) {
    this.config = { ...config };
    return true;
  }

  async loadConfig() {
    return this.config;
  }
}

// Mock Git Service
class MockGitService {
  async createIterationBranches(iterationDir) {
    return { success: true };
  }

  async pushAll(iterationDir, taskName) {
    return { success: true };
  }
}

// Mock Prompt Service
class MockPromptService {
  getAgentDefinitions() {
    return [
      { key: 'design', name: 'design_agent', description: 'Design' },
      { key: 'dev', name: 'dev_agent', description: 'Development' }
    ];
  }

  getRenderedPrompt(agentName, variables) {
    return `Execute ${agentName} for ${variables.PROJECT_NAME}`;
  }
}

// Integration Test Actions Service
class IntegrationHarnessActionsService {
  constructor(taskStore, gitService, promptService) {
    this.taskStore = taskStore;
    this.gitService = gitService;
    this.promptService = promptService;
    this.tasks = [];
    this.schedulers = new Map();
    this.executionLog = [];
  }

  async createTask(name, description) {
    const task = new Task(name, description);
    this.tasks.push(task);
    this.executionLog.push({ action: 'createTask', taskId: task.id, stage: task.stage });

    await this.taskStore.saveTasks(this.tasks);

    // Initialize git
    const iterationDir = path.join(os.tmpdir(), task.id);
    if (!fs.existsSync(iterationDir)) {
      fs.mkdirSync(iterationDir, { recursive: true });
    }
    await this.gitService.createIterationBranches(iterationDir);

    return task;
  }

  async runAgentByTaskId(taskId, step) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    this.executionLog.push({ action: 'runAgent', taskId, step });

    // Simulate agent execution
    const prompt = this.promptService.getRenderedPrompt(step.toLowerCase() + '_agent', {
      PROJECT_NAME: 'TestProject'
    });
    return { success: true, prompt };
  }

  async nextStageByTaskId(taskId, step) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Transition stage
    if (task.stage === STAGE.DESIGN) {
      task.stage = STAGE.DEVELOPING;
    } else if (task.stage === STAGE.DEVELOPING) {
      task.stage = STAGE.READY_FOR_REVIEW;
      // Stop scheduler when transitioning to review
      if (this.schedulers.has(taskId)) {
        this.schedulers.get(taskId).stop();
        this.schedulers.delete(taskId);
      }
    }

    task.updatedAt = new Date();
    this.executionLog.push({ action: 'nextStage', taskId, newStage: task.stage });

    await this.taskStore.saveTasks(this.tasks);
    return { success: true, stage: task.stage };
  }

  async passByTaskId(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    task.stage = STAGE.DONE;
    task.updatedAt = new Date();
    this.executionLog.push({ action: 'pass', taskId, stage: STAGE.DONE });

    await this.taskStore.saveTasks(this.tasks);
    return { success: true };
  }

  async deleteTaskById(taskId) {
    const index = this.tasks.findIndex(t => t.id === taskId);
    if (index === -1) throw new Error(`Task ${taskId} not found`);

    this.tasks.splice(index, 1);
    this.executionLog.push({ action: 'delete', taskId });

    await this.taskStore.saveTasks(this.tasks);
    return { success: true };
  }

  startScheduler(taskId) {
    if (!this.schedulers.has(taskId)) {
      const scheduler = new TaskScheduler(taskId);
      scheduler.start(() => {
        // Simulated scheduler tick
      });
      this.schedulers.set(taskId, scheduler);
    }
  }

  async getTasks() {
    return this.tasks;
  }

  getExecutionLog() {
    return this.executionLog;
  }
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration Tests - Full Workflow', () => {
  let actions;
  let taskStore;

  beforeEach(() => {
    taskSeq = 0;
    taskStore = new InMemoryTaskStore();
    const gitService = new MockGitService();
    const promptService = new MockPromptService();
    actions = new IntegrationHarnessActionsService(taskStore, gitService, promptService);
  });

  afterEach(() => {
    // Cleanup all schedulers
    if (actions && actions.schedulers) {
      for (const scheduler of actions.schedulers.values()) {
        scheduler.stop();
      }
      actions.schedulers.clear();
    }
  });;

  it('should complete full workflow: create → design → develop → review → done', async () => {
    // Step 1: Create task
    const task = await actions.createTask('User Authentication', 'Implement login system');
    assert.equal(task.stage, STAGE.DESIGN);
    assert.equal(task.name, 'User Authentication');

    // Step 2: Run design agent
    const designResult = await actions.runAgentByTaskId(task.id, HarnessStep.DESIGN);
    assert.equal(designResult.success, true);
    assert.match(designResult.prompt, /TestProject/);

    // Step 3: Transition to development
    const devResult = await actions.nextStageByTaskId(task.id, HarnessStep.DESIGN);
    assert.equal(devResult.stage, STAGE.DEVELOPING);
    const updatedTask = actions.tasks.find(t => t.id === task.id);
    assert.equal(updatedTask.stage, STAGE.DEVELOPING);

    // Step 4: Run development agent
    const developResult = await actions.runAgentByTaskId(task.id, HarnessStep.DEVELOPING);
    assert.equal(developResult.success, true);

    // Step 5: Transition to review (scheduler should stop)
    actions.startScheduler(task.id);
    assert.equal(actions.schedulers.has(task.id), true);
    const reviewResult = await actions.nextStageByTaskId(task.id, HarnessStep.DEVELOPING);
    assert.equal(reviewResult.stage, STAGE.READY_FOR_REVIEW);
    assert.equal(actions.schedulers.has(task.id), false); // Scheduler stopped

    // Step 6: Pass task (mark DONE)
    const passResult = await actions.passByTaskId(task.id);
    assert.equal(passResult.success, true);
    const finalTask = actions.tasks.find(t => t.id === task.id);
    assert.equal(finalTask.stage, STAGE.DONE);
  });

  it('should handle multiple concurrent tasks', async () => {
    // Create 3 tasks
    const task1 = await actions.createTask('Feature A', 'Desc A');
    const task2 = await actions.createTask('Feature B', 'Desc B');
    const task3 = await actions.createTask('Feature C', 'Desc C');

    assert.equal(actions.tasks.length, 3);

    // Transition tasks to different stages
    await actions.nextStageByTaskId(task1.id, HarnessStep.DESIGN);
    await actions.nextStageByTaskId(task2.id, HarnessStep.DESIGN);

    const task1Updated = actions.tasks.find(t => t.id === task1.id);
    const task2Updated = actions.tasks.find(t => t.id === task2.id);
    const task3Unchanged = actions.tasks.find(t => t.id === task3.id);

    assert.equal(task1Updated.stage, STAGE.DEVELOPING);
    assert.equal(task2Updated.stage, STAGE.DEVELOPING);
    assert.equal(task3Unchanged.stage, STAGE.DESIGN);
  });

  it('should persist task state across store save/load cycles', async () => {
    // Create and modify task
    const task = await actions.createTask('Persist Test', 'Test persistence');
    await actions.nextStageByTaskId(task.id, HarnessStep.DESIGN);

    // Save to store
    const savedTasks = await actions.taskStore.loadTasks();
    assert.equal(savedTasks.length, 1);
    assert.equal(savedTasks[0].stage, STAGE.DEVELOPING);
    assert.equal(savedTasks[0].name, 'Persist Test');
  });

  it('should track execution log for audit trail', async () => {
    const task = await actions.createTask('Log Test', 'Test logging');
    await actions.runAgentByTaskId(task.id, HarnessStep.DESIGN);
    await actions.nextStageByTaskId(task.id, HarnessStep.DESIGN);
    await actions.passByTaskId(task.id);

    const log = actions.getExecutionLog();
    assert.equal(log.length, 4); // create, runAgent, nextStage, pass
    assert.equal(log[0].action, 'createTask');
    assert.equal(log[1].action, 'runAgent');
    assert.equal(log[2].action, 'nextStage');
    assert.equal(log[3].action, 'pass');
  });

  it('should error when operating on non-existent task', async () => {
    const fakeTaskId = 'task-doesnotexist';

    await assert.rejects(
      () => actions.runAgentByTaskId(fakeTaskId, HarnessStep.DESIGN),
      /Task.*not found/
    );

    await assert.rejects(
      () => actions.nextStageByTaskId(fakeTaskId, HarnessStep.DESIGN),
      /Task.*not found/
    );

    await assert.rejects(
      () => actions.passByTaskId(fakeTaskId),
      /Task.*not found/
    );
  });

  it('should support task deletion', async () => {
    const task1 = await actions.createTask('Delete This', 'Temporary task');
    const task2 = await actions.createTask('Keep This', 'Permanent task');

    assert.equal(actions.tasks.length, 2);

    await actions.deleteTaskById(task1.id);

    assert.equal(actions.tasks.length, 1);
    const remaining = actions.tasks[0];
    assert.equal(remaining.id, task2.id);
    assert.equal(remaining.name, 'Keep This');
  });

  it('should maintain scheduler state independently per task', async () => {
    const task1 = await actions.createTask('Task 1', 'Desc 1');
    const task2 = await actions.createTask('Task 2', 'Desc 2');

    actions.startScheduler(task1.id);
    actions.startScheduler(task2.id);

    assert.equal(actions.schedulers.size, 2);

    // Stop only task1's scheduler
    if (actions.schedulers.has(task1.id)) {
      actions.schedulers.get(task1.id).stop();
      actions.schedulers.delete(task1.id);
    }

    assert.equal(actions.schedulers.size, 1);
    assert.equal(actions.schedulers.has(task2.id), true);
  });

  it('should handle rapid state transitions', async () => {
    const task = await actions.createTask('Rapid Transition', 'Fast workflow');

    // Rapid transitions
    await actions.nextStageByTaskId(task.id, HarnessStep.DESIGN);
    assert.equal(actions.tasks.find(t => t.id === task.id).stage, STAGE.DEVELOPING);

    await actions.nextStageByTaskId(task.id, HarnessStep.DEVELOPING);
    assert.equal(actions.tasks.find(t => t.id === task.id).stage, STAGE.READY_FOR_REVIEW);

    await actions.passByTaskId(task.id);
    assert.equal(actions.tasks.find(t => t.id === task.id).stage, STAGE.DONE);

    const log = actions.getExecutionLog();
    assert.equal(log.length, 4); // create, 2 transitions, pass
  });
});
