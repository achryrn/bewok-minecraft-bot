const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class Task {
  constructor(type, args = {}, options = {}) {
    if (!type || typeof type !== 'string') {
      throw new Error('Task type must be a non-empty string');
    }
    this.id = options.id || `task_${Task._counter++}_${Date.now().toString(36)}`;
    this.type = type;
    this.args = args;
    this.priority = options.priority || 0;
    this.label = options.label || `${type}(${JSON.stringify(args)})`;
    this.status = 'pending';
    this.error = null;
    this.result = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this._cancelled = false;
    this.requestedBy = options.requestedBy || 'unknown';
    this.progress = {};
    this.history = [];
    this.failureReason = null;
    this.resumeCount = 0;
    this.attempts = 0;
    this.lastError = null;
    this.updatedAt = Date.now();
  }

  /** Register a retry - used by the executor when an action is re-attempted. */
  retry(err) {
    this.attempts++;
    if (err) this.lastError = err instanceof Error ? err.message : String(err);
    return this.attempts;
  }

  static _counter = 0;

  start() {
    if (this.status !== 'pending') throw new Error(`Cannot start task ${this.id} - status is ${this.status}`);
    this.status = 'running';
    this.startedAt = Date.now();
    return this;
  }

  complete(result) {
    if (this._cancelled) return this;
    this.status = 'completed';
    this.completedAt = Date.now();
    this.result = result !== undefined ? result : null;
    return this;
  }

  fail(err) {
    if (this._cancelled) return this;
    this.status = 'failed';
    this.completedAt = Date.now();
    this.error = err instanceof Error ? err.message : String(err);
    return this;
  }

  cancel() {
    if (this.status === 'completed' || this.status === 'failed') return this;
    this._cancelled = true;
    this.status = 'cancelled';
    this.completedAt = Date.now();
    return this;
  }

  get isFinished() {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled';
  }

  get duration() {
    if (!this.startedAt) return null;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  log(event, detail) {
    this.history.push({ ts: Date.now(), event, detail });
    this.updatedAt = Date.now();
    if (this.history.length > 50) this.history = this.history.slice(-50);
  }

  toJSON() {
    return {
      id: this.id, type: this.type, status: this.status, priority: this.priority,
      label: this.label, error: this.error, createdAt: this.createdAt,
      startedAt: this.startedAt, completedAt: this.completedAt, duration: this.duration,
      args: this.args, requestedBy: this.requestedBy, progress: this.progress,
      failureReason: this.failureReason, resumeCount: this.resumeCount,
      attempts: this.attempts, lastError: this.lastError,
    };
  }

  static fromJSON(obj) {
    // Remove computed/getter-only fields before Object.assign
    const clean = { ...obj };
    delete clean.duration;
    delete clean.isFinished;
    const t = new Task(clean.type, clean.args || {}, { id: clean.id, priority: clean.priority, label: clean.label, requestedBy: clean.requestedBy });
    Object.assign(t, clean);
    return t;
  }
}

class TaskManager extends EventEmitter {
  constructor(firstArg, secondArg) {
    super();
    // Support both: TaskManager(bot, persistPath) and TaskManager(options)
    if (firstArg && typeof firstArg === 'object' && !firstArg._client && !firstArg.write && !firstArg.on) {
      // Called as TaskManager(options) - backward compat with queue-style tests
      this.bot = null;
      this.persistPath = './data/task-state.json';
      this._executor = firstArg.executor || null;
      this._maxHistory = firstArg.maxHistory || 50;
    } else {
      this.bot = firstArg || null;
      this.persistPath = secondArg || './data/task-state.json';
      this._executor = null;
      this._maxHistory = 50;
    }
    if (!this._maxHistory) this._maxHistory = 50;
    this.currentTask = null;
    this._cancelFlag = false;
    this._queue = [];
    this._history = [];
    this._processing = false;
    this._scheduled = false;
  }

  /* ----- Persistence ----- */

  loadFromDisk() {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
        const task = Task.fromJSON(data);
        // Discard stale tasks older than 1 hour
        if (task.createdAt && Date.now() - task.createdAt > 60 * 60 * 1000) {
          console.log('[task] Discarding stale persisted task');
        } else {
          this.currentTask = task;
          console.log(`[task] Loaded persisted task: ${this.currentTask.type} (${this.currentTask.status})`);
        }
      }
    } catch (err) {
      console.warn('[warn] Could not load task state:', err.message);
      this.currentTask = null;
    }
  }

  saveToDisk() {
    try {
      // make sure the target directory exists (data/ by default)
      const dir = path.dirname(this.persistPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      if (this.currentTask) {
        fs.writeFileSync(this.persistPath, JSON.stringify(this.currentTask.toJSON(), null, 2), 'utf8');
      } else {
        if (fs.existsSync(this.persistPath)) fs.unlinkSync(this.persistPath);
      }
    } catch (err) {
      console.warn('[warn] Could not save task state:', err.message);
    }
  }

  /* ----- Single-task lifecycle (used by brain) ----- */

  startTask(type, args, requestedBy) {
    if (this.currentTask && this.currentTask.status === 'running') {
      this.cancelTask();
    }
    this._cancelFlag = false;
    this.currentTask = new Task(type, args, { requestedBy });
    this.currentTask.status = 'running';
    this.currentTask.startedAt = Date.now();
    this.currentTask.log('started', `${type} ${JSON.stringify(args)}`);
    this.saveToDisk();
    return this.currentTask;
  }

  completeTask(reason) {
    if (!this.currentTask) return;
    this.currentTask.status = 'completed';
    this.currentTask.completedAt = Date.now();
    this.currentTask.log('completed', reason || 'Done');
    this.saveToDisk();
    setTimeout(() => { this.currentTask = null; this.saveToDisk(); }, 5000);
  }

  failTask(reason) {
    if (!this.currentTask) return;
    this.currentTask.status = 'failed';
    this.currentTask.completedAt = Date.now();
    this.currentTask.failureReason = reason;
    this.currentTask.error = reason;
    this.currentTask.log('failed', reason);
    this.saveToDisk();
  }

  cancelTask() {
    if (!this.currentTask) return;
    this._cancelFlag = true;
    this.currentTask.status = 'cancelled';
    this.currentTask.completedAt = Date.now();
    this.currentTask.log('cancelled', 'Cancelled');
    this.saveToDisk();
    this.currentTask = null;
    this.saveToDisk();
  }

  pauseTask(reason) {
    if (!this.currentTask || this.currentTask.status !== 'running') return;
    this.currentTask.status = 'paused';
    this.currentTask.log('paused', reason || 'Paused');
    this.saveToDisk();
  }

  resumeTask() {
    if (!this.currentTask || this.currentTask.status !== 'paused') return this.currentTask;
    this.currentTask.status = 'running';
    this.currentTask.resumeCount++;
    this.currentTask.log('resumed', `Resume #${this.currentTask.resumeCount}`);
    this.saveToDisk();
    return this.currentTask;
  }

  shouldContinue() {
    return !this._cancelFlag && this.currentTask && this.currentTask.status === 'running';
  }

  /* ----- Queue (compatibility with TaskManager tests) ----- */

  get idle() { return !this._processing && this._queue.length === 0; }

  get size() { return this._queue.length + (this._processing ? 1 : 0); }

  enqueue(type, args, options) {
    const task = type instanceof Task ? type : new Task(type, args, options);
    this._queue.push(task);
    this._sortQueue();
    this._scheduleNext();
    return task;
  }

  dequeue(idOrPredicate) {
    const idx = typeof idOrPredicate === 'function'
      ? this._queue.findIndex(idOrPredicate)
      : this._queue.findIndex(t => t.id === idOrPredicate);
    if (idx === -1) return null;
    const removed = this._queue.splice(idx, 1)[0];
    removed.cancel();
    return removed;
  }

  cancel(id) {
    if (this.currentTask && this.currentTask.id === id) {
      this.currentTask.cancel();
      this.currentTask = null;
      this._processing = false;
      this._scheduleNext();
      return true;
    }
    const removed = this.dequeue(t => t.id === id);
    return !!removed;
  }

  cancelAll() {
    if (this.currentTask) { this.currentTask.cancel(); this.currentTask = null; this._processing = false; }
    while (this._queue.length > 0) { const t = this._queue.shift(); t.cancel(); }
  }

  getQueue() { return [...this._queue]; }
  getHistory() { return [...this._history]; }
  getCurrentTask() { return this.currentTask; }

  setExecutor(fn) { this._executor = fn; }

  _trimHistory() {
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(this._history.length - this._maxHistory);
    }
  }

  _sortQueue() {
    this._queue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
  }

  _scheduleNext() {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => { this._scheduled = false; this._processNext(); });
  }

  _processNext() {
    if (this._processing || this.currentTask) return;
    if (this._queue.length === 0) { this.emit('drain'); return; }
    this._processing = true;
    const task = this._queue.shift();
    if (task._cancelled) { this._history.push(task); this._processing = false; this._processNext(); return; }
    this.currentTask = task;
    task.start();
    this.emit('taskStart', task);
    const afterTask = () => {
      this._history.push(task);
      this._trimHistory();
      this.currentTask = null;
      this._processing = false;
      this._processNext();
    };
    this._executeTask(task).then(afterTask).catch((err) => {
      if (!task.isFinished) task.fail(err);
      afterTask();
      this._processing = false;
      this._processNext();
    });
  }

  async _executeTask(task) {
    if (this._executor) {
      try {
        const result = await this._executor(task);
        if (!task.isFinished) {
          task.complete(result);
          this.emit('taskComplete', task);
        }
      } catch (err) {
        if (!task.isFinished) {
          task.fail(err);
          this.emit('taskError', task, err);
        }
      }
    } else {
      task.complete();
      this.emit('taskComplete', task);
    }
  }
}
// Remove legacy EventEmitter mixin at bottom - using extends now

module.exports = { Task, TaskManager };
