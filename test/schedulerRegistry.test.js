const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

// Mock TaskScheduler
class TaskScheduler {
  constructor(taskId) {
    this.taskId = taskId;
    this.isActive = true;
    this.stoppedAt = null;
  }

  start(callback) {
    this.isActive = true;
    this.callback = callback;
  }

  stop() {
    this.isActive = false;
    this.stoppedAt = new Date();
  }
}

// SchedulerRegistry - manages TaskScheduler lifecycles
class SchedulerRegistry {
  constructor() {
    this.schedulers = new Map();
  }

  /**
   * Get or create a scheduler for a task
   */
  get(taskId) {
    if (!this.schedulers.has(taskId)) {
      this.schedulers.set(taskId, new TaskScheduler(taskId));
    }
    return this.schedulers.get(taskId);
  }

  /**
   * Stop a specific scheduler and remove it
   */
  stop(taskId) {
    if (this.schedulers.has(taskId)) {
      const scheduler = this.schedulers.get(taskId);
      scheduler.stop();
      this.schedulers.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * Stop all schedulers
   */
  stopAll() {
    const stopped = [];
    for (const [taskId, scheduler] of this.schedulers) {
      scheduler.stop();
      stopped.push(taskId);
    }
    this.schedulers.clear();
    return stopped;
  }

  /**
   * Check if a scheduler exists
   */
  has(taskId) {
    return this.schedulers.has(taskId);
  }

  /**
   * Get count of active schedulers
   */
  size() {
    return this.schedulers.size;
  }

  /**
   * Get all task IDs with active schedulers
   */
  getAllTaskIds() {
    return Array.from(this.schedulers.keys());
  }

  /**
   * Get all schedulers
   */
  getAll() {
    return Array.from(this.schedulers.values());
  }
}

describe('SchedulerRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new SchedulerRegistry();
  });

  describe('scheduler lifecycle', () => {
    it('should create scheduler on first get', () => {
      const scheduler = registry.get('task-1');

      assert.ok(scheduler);
      assert.equal(scheduler.taskId, 'task-1');
      assert.equal(scheduler.isActive, true);
    });

    it('should return the same scheduler on subsequent gets', () => {
      const scheduler1 = registry.get('task-1');
      const scheduler2 = registry.get('task-1');

      assert.strictEqual(scheduler1, scheduler2);
    });

    it('should create different schedulers for different task IDs', () => {
      const scheduler1 = registry.get('task-1');
      const scheduler2 = registry.get('task-2');

      assert.notStrictEqual(scheduler1, scheduler2);
      assert.equal(scheduler1.taskId, 'task-1');
      assert.equal(scheduler2.taskId, 'task-2');
    });

    it('should stop and remove a specific scheduler', () => {
      const scheduler = registry.get('task-1');
      assert.equal(scheduler.isActive, true);

      const result = registry.stop('task-1');

      assert.equal(result, true);
      assert.equal(scheduler.isActive, false);
      assert.ok(scheduler.stoppedAt);
      assert.equal(registry.has('task-1'), false);
    });

    it('should return false when stopping non-existent scheduler', () => {
      const result = registry.stop('non-existent');

      assert.equal(result, false);
    });
  });

  describe('multiple scheduler management', () => {
    it('should track multiple schedulers independently', () => {
      const s1 = registry.get('task-1');
      const s2 = registry.get('task-2');
      const s3 = registry.get('task-3');

      assert.equal(registry.size(), 3);
      assert.deepEqual(registry.getAllTaskIds().sort(), ['task-1', 'task-2', 'task-3']);
    });

    it('should stop all schedulers and clear registry', () => {
      registry.get('task-1');
      registry.get('task-2');
      registry.get('task-3');

      const stopped = registry.stopAll();

      assert.equal(stopped.length, 3);
      assert.deepEqual(stopped.sort(), ['task-1', 'task-2', 'task-3']);
      assert.equal(registry.size(), 0);
    });

    it('should handle stopAll when registry is empty', () => {
      const stopped = registry.stopAll();

      assert.deepEqual(stopped, []);
      assert.equal(registry.size(), 0);
    });

    it('should selectively stop schedulers without affecting others', () => {
      const s1 = registry.get('task-1');
      const s2 = registry.get('task-2');
      const s3 = registry.get('task-3');

      registry.stop('task-2');

      assert.equal(registry.size(), 2);
      assert.equal(s1.isActive, true);
      assert.equal(s2.isActive, false);
      assert.equal(s3.isActive, true);
      assert.equal(registry.has('task-1'), true);
      assert.equal(registry.has('task-2'), false);
      assert.equal(registry.has('task-3'), true);
    });
  });

  describe('query methods', () => {
    it('should report correct size', () => {
      assert.equal(registry.size(), 0);

      registry.get('task-1');
      assert.equal(registry.size(), 1);

      registry.get('task-2');
      assert.equal(registry.size(), 2);

      registry.stop('task-1');
      assert.equal(registry.size(), 1);
    });

    it('should check if scheduler exists', () => {
      registry.get('task-1');

      assert.equal(registry.has('task-1'), true);
      assert.equal(registry.has('task-2'), false);
    });

    it('should get all task IDs', () => {
      registry.get('task-a');
      registry.get('task-b');
      registry.get('task-c');

      const taskIds = registry.getAllTaskIds().sort();

      assert.deepEqual(taskIds, ['task-a', 'task-b', 'task-c']);
    });

    it('should get all schedulers', () => {
      const s1 = registry.get('task-1');
      const s2 = registry.get('task-2');

      const all = registry.getAll();

      assert.equal(all.length, 2);
      assert.ok(all.includes(s1));
      assert.ok(all.includes(s2));
    });
  });

  describe('edge cases', () => {
    it('should handle task IDs with special characters', () => {
      const taskIds = ['task-123', 'task_with_underscore', 'task.with.dot', 'task-@-special'];

      for (const taskId of taskIds) {
        const scheduler = registry.get(taskId);
        assert.equal(scheduler.taskId, taskId);
      }

      assert.equal(registry.size(), 4);
    });

    it('should handle rapid get/stop cycles', () => {
      const taskId = 'rapid-task';

      registry.get(taskId);
      assert.equal(registry.has(taskId), true);

      registry.stop(taskId);
      assert.equal(registry.has(taskId), false);

      registry.get(taskId);
      assert.equal(registry.has(taskId), true);

      const scheduler = registry.get(taskId);
      assert.equal(scheduler.isActive, true);
    });

    it('should preserve closure state across operations', () => {
      const taskId = 'state-task';
      const scheduler = registry.get(taskId);

      let callCount = 0;
      const callback = () => {
        callCount++;
      };

      scheduler.start(callback);
      assert.equal(scheduler.callback, callback);

      registry.stop(taskId);
      assert.equal(scheduler.isActive, false);
      assert.ok(scheduler.stoppedAt instanceof Date);
    });
  });

  describe('concurrency patterns', () => {
    it('should handle interleaved get/stop operations', () => {
      // Create multiple schedulers
      const s1 = registry.get('task-1');
      const s2 = registry.get('task-2');
      const s3 = registry.get('task-3');

      // Interleaved stops and creates
      registry.stop('task-2');
      registry.get('task-4');
      registry.stop('task-1');
      registry.get('task-5');

      const remaining = registry.getAllTaskIds().sort();
      assert.deepEqual(remaining, ['task-3', 'task-4', 'task-5']);

      // Verify stopped schedulers are indeed inactive
      assert.equal(s1.isActive, false);
      assert.equal(s2.isActive, false);
      assert.equal(s3.isActive, true);
    });

    it('should maintain registry consistency through stopAll then recreate', () => {
      registry.get('task-1');
      registry.get('task-2');
      assert.equal(registry.size(), 2);

      registry.stopAll();
      assert.equal(registry.size(), 0);

      registry.get('task-1');
      registry.get('task-3');
      assert.equal(registry.size(), 2);
      assert.deepEqual(registry.getAllTaskIds().sort(), ['task-1', 'task-3']);
    });
  });

  describe('type safety', () => {
    it('should handle various string formats as task IDs', () => {
      const testCases = [
        'simple',
        'with-dash',
        'with_underscore',
        'with.dot',
        'with spaces',
        '123numeric',
        ''  // empty string
      ];

      for (const taskId of testCases) {
        const scheduler = registry.get(taskId);
        assert.ok(scheduler);
        assert.equal(scheduler.taskId, taskId);
      }

      assert.equal(registry.size(), testCases.length);
    });

    it('should handle numeric task IDs as strings', () => {
      const taskId = '12345';
      const scheduler = registry.get(taskId);

      assert.equal(scheduler.taskId, '12345');
      assert.equal(typeof scheduler.taskId, 'string');
    });
  });
});
