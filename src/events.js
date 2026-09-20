const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this._listenerCounts = {};
  }

  on(event, listener) {
    super.on(event, listener);
    this._listenerCounts[event] = (this._listenerCounts[event] || 0) + 1;
    return this;
  }

  off(event, listener) {
    super.off(event, listener);
    this._listenerCounts[event] = Math.max(0, (this._listenerCounts[event] || 0) - 1);
    return this;
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this._listenerCounts[event] = Math.max(0, (this._listenerCounts[event] || 0) - 1);
      listener(...args);
    };
    super.once(event, wrapped);
    this._listenerCounts[event] = (this._listenerCounts[event] || 0) + 1;
    return this;
  }

  emit(event, ...args) {
    return super.emit(event, ...args);
  }

  listenerCount(event) {
    return this._listenerCounts[event] || 0;
  }

  removeAllListeners(event) {
    if (event) {
      super.removeAllListeners(event);
      this._listenerCounts[event] = 0;
    } else {
      super.removeAllListeners();
      this._listenerCounts = {};
    }
    return this;
  }

  getActiveEvents() {
    return Object.keys(this._listenerCounts).filter(e => this._listenerCounts[e] > 0);
  }
}

module.exports = EventBus;
