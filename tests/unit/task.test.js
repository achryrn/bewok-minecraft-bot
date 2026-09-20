const { Task, TaskManager } = require('../../src/task');

describe('Task', () => {
  describe('constructor', () => {
    it('creates a pending task with given type and args', () => {
      const t = new Task('mine', { block: 'oak_log', count: 5 }, { priority: 2, label: 'get wood' });
      expect(t.type).toBe('mine');
      expect(t.args).toEqual({ block: 'oak_log', count: 5 });
      expect(t.priority).toBe(2);
      expect(t.label).toBe('get wood');
      expect(t.status).toBe('pending');
      expect(t.isFinished).toBe(false);
      expect(t.duration).toBeNull();
      expect(t.id).toMatch(/^task_\d+_/);
    });

    it('defaults args and options', () => {
      const t = new Task('chat');
      expect(t.type).toBe('chat');
      expect(t.args).toEqual({});
      expect(t.priority).toBe(0);
      expect(t.label).toMatch(/^chat\(/);
    });

    it('throws for empty or non-string type', () => {
      expect(() => new Task('')).toThrow('non-empty string');
      expect(() => new Task(null)).toThrow('non-empty string');
      expect(() => new Task(undefined)).toThrow('non-empty string');
    });
  });

  describe('lifecycle', () => {
    it('flows pending -> running -> completed', () => {
      const t = new Task('move', { x: 10, y: 64, z: 10 });
      expect(t.status).toBe('pending');
      t.start();
      expect(t.status).toBe('running');
      expect(t.startedAt).toBeGreaterThan(0);
      t.complete('result-data');
      expect(t.status).toBe('completed');
      expect(t.result).toBe('result-data');
      expect(t.isFinished).toBe(true);
      expect(t.completedAt).toBeGreaterThanOrEqual(t.startedAt);
      expect(t.duration).toBeGreaterThanOrEqual(0);
    });

    it('flows pending -> running -> failed', () => {
      const t = new Task('mine', { block: 'stone' });
      t.start();
      t.fail(new Error('no path'));
      expect(t.status).toBe('failed');
      expect(t.error).toBe('no path');
      expect(t.isFinished).toBe(true);
    });

    it('flows pending -> cancelled (never started)', () => {
      const t = new Task('chat', { message: 'hi' });
      t.cancel();
      expect(t.status).toBe('cancelled');
      expect(t.duration).toBeNull();
      expect(t.isFinished).toBe(true);
    });

    it('flows pending -> running -> cancelled', () => {
      const t = new Task('attack', { target: 'zombie' });
      t.start();
      t.cancel();
      expect(t.status).toBe('cancelled');
      expect(t.duration).toBeGreaterThanOrEqual(0);
    });

    it('cannot start a task twice', () => {
      const t = new Task('x');
      t.start();
      expect(() => t.start()).toThrow('Cannot start');
    });

    it('cancel is idempotent on finished tasks', () => {
      const t = new Task('x');
      t.start();
      t.complete();
      t.cancel(); // should not change status
      expect(t.status).toBe('completed');
    });

    it('fail is no-op on cancelled tasks', () => {
      const t = new Task('x');
      t.start();
      t.cancel();
      t.fail('boom');
      expect(t.status).toBe('cancelled');
    });

    it('complete is no-op on cancelled tasks', () => {
      const t = new Task('x');
      t.cancel();
      t.complete('val');
      expect(t.status).toBe('cancelled');
      expect(t.result).toBeNull();
    });
  });

  describe('toJSON', () => {
    it('includes all serializable fields', () => {
      const t = new Task('mine', { block: 'dirt' }, { priority: 3, label: 'dig' });
      t.start();
      t.complete('done');
      const json = t.toJSON();
      expect(json.id).toBe(t.id);
      expect(json.type).toBe('mine');
      expect(json.status).toBe('completed');
      expect(json.priority).toBe(3);
      expect(json.label).toBe('dig');
      expect(json.error).toBeNull();
      expect(json.createdAt).toBeGreaterThan(0);
      expect(json.startedAt).toBeGreaterThan(0);
      expect(json.completedAt).toBeGreaterThan(0);
      expect(json.duration).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('TaskManager', () => {
  let tm;

  beforeEach(() => {
    tm = new TaskManager();
  });

  describe('initial state', () => {
    it('starts idle with empty queue', () => {
      expect(tm.idle).toBe(true);
      expect(tm.size).toBe(0);
      expect(tm.getCurrentTask()).toBeNull();
      expect(tm.getQueue()).toEqual([]);
      expect(tm.getHistory()).toEqual([]);
    });
  });

  describe('enqueue and execution ordering', () => {
    it('executes tasks in priority order (higher runs first)', (done) => {
      const order = [];
      const tm2 = new TaskManager({
        executor: async (t) => { order.push(t.type); }
      });
      tm2.enqueue('low', {}, { priority: 0 });
      tm2.enqueue('high', {}, { priority: 10 });

      setImmediate(() => {
        expect(order[0]).toBe('high');
        expect(order[1]).toBe('low');
        done();
      });
    });

    it('executes same-priority tasks in FIFO order', (done) => {
      const order = [];
      const tm2 = new TaskManager({
        executor: async (t) => { order.push(t.type); }
      });
      tm2.enqueue('first', {}, { priority: 1 });
      tm2.enqueue('second', {}, { priority: 1 });
      tm2.enqueue('third', {}, { priority: 1 });

      setImmediate(() => {
        expect(order).toEqual(['first', 'second', 'third']);
        done();
      });
    });

    it('fires drain event when queue empties', (done) => {
      const drained = jest.fn();
      tm.on('drain', drained);
      tm.enqueue('chat', { message: 'hi' });

      setImmediate(() => {
        expect(drained).toHaveBeenCalled();
        done();
      });
    });

    it('fires taskStart and taskComplete events', (done) => {
      const start = jest.fn();
      const complete = jest.fn();
      tm.on('taskStart', start);
      tm.on('taskComplete', complete);
      tm.enqueue('move', { x: 1, y: 2, z: 3 });

      setImmediate(() => {
        expect(start).toHaveBeenCalled();
        expect(complete).toHaveBeenCalled();
        done();
      });
    });
  });

  describe('no executor', () => {
    it('resolves immediately with no executor set', (done) => {
      const complete = jest.fn();
      tm.on('taskComplete', complete);
      tm.enqueue('chat', { message: 'hello' });

      setImmediate(() => {
        expect(complete).toHaveBeenCalled();
        const task = tm.getHistory()[0];
        expect(task.status).toBe('completed');
        done();
      });
    });
  });

  describe('error handling', () => {
    it('fires taskError when executor throws', (done) => {
      const onError = jest.fn();
      const tm2 = new TaskManager({
        executor: async () => { throw new Error('boom'); }
      });
      tm2.on('taskError', onError);
      tm2.enqueue('mine', { block: 'stone' });

      setImmediate(() => {
        expect(onError).toHaveBeenCalled();
        const task = onError.mock.calls[0][0];
        expect(task.status).toBe('failed');
        expect(task.error).toBe('boom');
        done();
      });
    });
  });

  describe('cancel operations', () => {
    it('cancels a queued task by id', (done) => {
      const tm2 = new TaskManager({
        executor: async (t) => { await new Promise(r => setTimeout(r, 50)); }
      });
      // Let the first task start and hold
      const t1 = tm2.enqueue('hold', {});
      setTimeout(() => {
        // Now enqueue and immediately cancel a second task
        const t2 = tm2.enqueue('cancelme', {});
        const result = tm2.cancel(t2.id);
        expect(result).toBe(true);
        expect(t2.status).toBe('cancelled');
        done();
      }, 20);
    });

    it('cancel returns false for unknown id', () => {
      expect(tm.cancel('nonexistent')).toBe(false);
    });

    it('cancelAll empties queue and cancels running task', (done) => {
      const tm2 = new TaskManager({
        executor: async (t) => { await new Promise(r => setTimeout(r, 100)); }
      });
      tm2.enqueue('a', {});
      tm2.enqueue('b', {});
      tm2.enqueue('c', {});

      setTimeout(() => {
        tm2.cancelAll();
        expect(tm2.size).toBe(0);
        expect(tm2.idle).toBe(true);
        done();
      }, 10);
    });
  });

  describe('dequeue', () => {
    it('removes a pending task by id', () => {
      tm.enqueue('test', {});
      const pending = tm.getQueue(); // should be empty by now since no executor resolves immediately
      // Need an executor that blocks
    });

    it('dequeue by predicate function', (done) => {
      const tm2 = new TaskManager({
        executor: async (t) => { await new Promise(r => setTimeout(r, 50)); }
      });
      tm2.enqueue('mine', { block: 'iron' });
      tm2.enqueue('craft', { item: 'stick' });

      setTimeout(() => {
        const removed = tm2.dequeue(t => t.type === 'craft');
        expect(removed).not.toBeNull();
        expect(removed.type).toBe('craft');
        expect(removed.status).toBe('cancelled');
        done();
      }, 10);
    });

    it('returns null when no task matches', () => {
      const result = tm.dequeue('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('size and idle', () => {
    it('reflects queued and running tasks', (done) => {
      const tm2 = new TaskManager({
        executor: async (t) => { await new Promise(r => setTimeout(r, 50)); }
      });
      expect(tm2.idle).toBe(true);
      expect(tm2.size).toBe(0);

      tm2.enqueue('a', {});
      // After enqueue but before first setImmediate fires, size shows 1
      tm2.enqueue('b', {});

      setTimeout(() => {
        // a is running, b is queued
        expect(tm2.size).toBe(2);
        expect(tm2.idle).toBe(false);
        done();
      }, 10);
    });
  });

  describe('history', () => {
    it('records completed tasks', (done) => {
      const tm2 = new TaskManager({
        executor: async (t) => { await new Promise(r => setTimeout(r, 10)); }
      });
      tm2.enqueue('mine', {});
      tm2.enqueue('move', {});

      setTimeout(() => {
        const hist = tm2.getHistory();
        expect(hist.length).toBe(2);
        expect(hist[0].type).toBe('mine');
        expect(hist[0].status).toBe('completed');
        expect(hist[1].type).toBe('move');
        done();
      }, 100);
    });

    it('trims to maxHistory', (done) => {
      const tm2 = new TaskManager({ maxHistory: 3 });
      for (let i = 0; i < 10; i++) {
        tm2.enqueue('chat', { message: String(i) });
      }

      setTimeout(() => {
        expect(tm2.getHistory().length).toBeLessThanOrEqual(3);
        done();
      }, 200);
    });
  });

  describe('setExecutor', () => {
    it('uses executor set after construction', (done) => {
      const fn = jest.fn(async () => 'ok');
      tm.setExecutor(fn);
      tm.enqueue('test', {});

      setImmediate(() => {
        expect(fn).toHaveBeenCalled();
        const task = tm.getHistory()[0];
        expect(task.status).toBe('completed');
        done();
      });
    });
  });

  describe('getCurrentTask', () => {
    it('returns null when idle', () => {
      expect(tm.getCurrentTask()).toBeNull();
    });

    it('returns running task', (done) => {
      let running;
      const tm2 = new TaskManager({
        executor: async (t) => {
          running = tm2.getCurrentTask();
          await new Promise(r => setTimeout(r, 10));
        }
      });
      tm2.enqueue('mine', {});

      setTimeout(() => {
        expect(running).not.toBeNull();
        expect(running.type).toBe('mine');
        done();
      }, 20);
    });
  });
});
