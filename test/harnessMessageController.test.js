const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// Mock HarnessStep enum
const HarnessStep = {
  DESIGN: 'DESIGN',
  DEVELOPING: 'DEVELOPING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DONE: 'DONE'
};

// Create mock HarnessActionsService for testing
class MockHarnessActionsService {
  constructor() {
    this.callLog = [];
  }

  async createTask(name, description) {
    this.callLog.push({ method: 'createTask', args: { name, description } });
    return { taskId: 'task-123', name, description };
  }

  async runAgentByTaskId(taskId, step) {
    this.callLog.push({ method: 'runAgentByTaskId', args: { taskId, step } });
    return { success: true };
  }

  async nextStageByTaskId(taskId, step) {
    this.callLog.push({ method: 'nextStageByTaskId', args: { taskId, step } });
    return { success: true };
  }

  async passByTaskId(taskId) {
    this.callLog.push({ method: 'passByTaskId', args: { taskId } });
    return { success: true };
  }

  async deleteTaskById(taskId) {
    this.callLog.push({ method: 'deleteTaskById', args: { taskId } });
    return { success: true };
  }
}

// Create HarnessMessageController class for testing
class HarnessMessageController {
  constructor(harnessActionsService) {
    this.actionsService = harnessActionsService;
  }

  /**
   * Route all messages to appropriate handlers
   */
  async handle(message) {
    switch (message.type) {
      case 'CREATE_TASK':
        return this.actionsService.createTask(
          message.payload.taskName,
          message.payload.description
        );

      case 'RUN_AGENT':
        return this.actionsService.runAgentByTaskId(
          message.payload.taskId,
          message.payload.step
        );

      case 'NEXT_STAGE':
        return this.actionsService.nextStageByTaskId(
          message.payload.taskId,
          message.payload.step
        );

      case 'PASS_TASK':
        return this.actionsService.passByTaskId(
          message.payload.taskId
        );

      case 'DELETE_TASK':
        return this.actionsService.deleteTaskById(
          message.payload.taskId
        );

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }
}

describe('HarnessMessageController', () => {
  let controller;
  let mockActionsService;

  beforeEach(() => {
    mockActionsService = new MockHarnessActionsService();
    controller = new HarnessMessageController(mockActionsService);
  });

  describe('message routing', () => {
    it('should route CREATE_TASK message', async () => {
      const message = {
        type: 'CREATE_TASK',
        payload: {
          taskName: 'New Feature',
          description: 'Implement new feature'
        }
      };

      const result = await controller.handle(message);

      assert.equal(result.taskId, 'task-123');
      assert.equal(result.name, 'New Feature');
      assert.equal(mockActionsService.callLog.length, 1);
      assert.equal(mockActionsService.callLog[0].method, 'createTask');
    });

    it('should route RUN_AGENT message', async () => {
      const message = {
        type: 'RUN_AGENT',
        payload: {
          taskId: 'task-456',
          step: HarnessStep.DESIGN
        }
      };

      const result = await controller.handle(message);

      assert.equal(result.success, true);
      assert.equal(mockActionsService.callLog.length, 1);
      assert.equal(mockActionsService.callLog[0].method, 'runAgentByTaskId');
      assert.deepEqual(mockActionsService.callLog[0].args, {
        taskId: 'task-456',
        step: HarnessStep.DESIGN
      });
    });

    it('should route NEXT_STAGE message', async () => {
      const message = {
        type: 'NEXT_STAGE',
        payload: {
          taskId: 'task-789',
          step: HarnessStep.DEVELOPING
        }
      };

      const result = await controller.handle(message);

      assert.equal(result.success, true);
      assert.equal(mockActionsService.callLog.length, 1);
      assert.equal(mockActionsService.callLog[0].method, 'nextStageByTaskId');
    });

    it('should route PASS_TASK message', async () => {
      const message = {
        type: 'PASS_TASK',
        payload: {
          taskId: 'task-complete'
        }
      };

      const result = await controller.handle(message);

      assert.equal(result.success, true);
      assert.equal(mockActionsService.callLog.length, 1);
      assert.equal(mockActionsService.callLog[0].method, 'passByTaskId');
      assert.deepEqual(mockActionsService.callLog[0].args, { taskId: 'task-complete' });
    });

    it('should route DELETE_TASK message', async () => {
      const message = {
        type: 'DELETE_TASK',
        payload: {
          taskId: 'task-delete'
        }
      };

      const result = await controller.handle(message);

      assert.equal(result.success, true);
      assert.equal(mockActionsService.callLog.length, 1);
      assert.equal(mockActionsService.callLog[0].method, 'deleteTaskById');
    });

    it('should throw on unknown message type', async () => {
      const message = {
        type: 'UNKNOWN_MESSAGE',
        payload: {}
      };

      await assert.rejects(
        () => controller.handle(message),
        /Unknown message type: UNKNOWN_MESSAGE/
      );
    });
  });

  describe('message payload preservation', () => {
    it('should preserve all payload properties for CREATE_TASK', async () => {
      const message = {
        type: 'CREATE_TASK',
        payload: {
          taskName: 'Complex Task',
          description: 'Multi-line\ndescription'
        }
      };

      await controller.handle(message);

      const logEntry = mockActionsService.callLog[0];
      assert.equal(logEntry.args.name, 'Complex Task');
      assert.equal(logEntry.args.description, 'Multi-line\ndescription');
    });

    it('should preserve step enum value in RUN_AGENT', async () => {
      const message = {
        type: 'RUN_AGENT',
        payload: {
          taskId: 'task-1',
          step: HarnessStep.READY_FOR_REVIEW
        }
      };

      await controller.handle(message);

      const logEntry = mockActionsService.callLog[0];
      assert.equal(logEntry.args.step, HarnessStep.READY_FOR_REVIEW);
    });
  });

  describe('multiple message sequences', () => {
    it('should handle sequence of different message types', async () => {
      const messages = [
        {
          type: 'CREATE_TASK',
          payload: { taskName: 'Task 1', description: 'Desc 1' }
        },
        {
          type: 'RUN_AGENT',
          payload: { taskId: 'task-1', step: HarnessStep.DESIGN }
        },
        {
          type: 'NEXT_STAGE',
          payload: { taskId: 'task-1', step: HarnessStep.DEVELOPING }
        }
      ];

      for (const msg of messages) {
        await controller.handle(msg);
      }

      assert.equal(mockActionsService.callLog.length, 3);
      assert.equal(mockActionsService.callLog[0].method, 'createTask');
      assert.equal(mockActionsService.callLog[1].method, 'runAgentByTaskId');
      assert.equal(mockActionsService.callLog[2].method, 'nextStageByTaskId');
    });

    it('should isolate call logs for different controller instances', async () => {
      const controller2 = new HarnessMessageController(
        new MockHarnessActionsService()
      );

      const message = {
        type: 'CREATE_TASK',
        payload: { taskName: 'Task', description: 'Desc' }
      };

      await controller.handle(message);
      await controller2.handle(message);

      assert.equal(mockActionsService.callLog.length, 1);
      assert.equal(controller2.actionsService.callLog.length, 1);
    });
  });

  describe('error handling', () => {
    it('should not catch errors from service layer', async () => {
      const failingService = {
        createTask: async () => {
          throw new Error('Service error');
        }
      };

      const failingController = new HarnessMessageController(failingService);
      const message = {
        type: 'CREATE_TASK',
        payload: { taskName: 'Task', description: 'Desc' }
      };

      await assert.rejects(
        () => failingController.handle(message),
        /Service error/
      );
    });

    it('should accept null/undefined message types gracefully in error handling', async () => {
      const message = {
        type: undefined,
        payload: {}
      };

      await assert.rejects(
        () => controller.handle(message),
        /Unknown message type/
      );
    });
  });
});
