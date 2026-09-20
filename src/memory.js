'use strict';
/**
 * memory.js - persistent, self-improving memory for the bot.
 *
 * The bot writes facts, lessons, locations and conversation history to a JSON
 * file so it can:
 *   - remember players / their preferences,
 *   - remember where it found ores, food, beds, crafting tables,
 *   - learn from failures (self-improvement): "digging straight down killed me",
 *     "this area is full of zombies at night",
 *   - keep short-term task context across reconnects.
 *
 * All reads/writes are synchronous behind a tiny in-memory cache and written to
 * disk atomically (temp file + rename) so a crash never corrupts memory.
 */

const fs = require('fs');
const path = require('path');

class BotMemory {
  /**
   * @param {string} filePath - e.g. './memory.json'
   * @param {number} maxLessons - cap on stored lessons
   */
  constructor(filePath, maxLessons = 300) {
    this.filePath = filePath || './memory.json';
    this.maxLessons = maxLessons || 300;
    this._seq = 0; // monotonic insertion counter - deterministic recency tie-break
    this.data = {
      facts: {},          // key -> value  (durable knowledge)
      notes: [],          // [{id, text, ts, tags:[], count}]  (free-form learnings)
      locations: [],      // [{type, x, y, z, dim, ts, quality}]  (known places)
      history: [],        // [{role:'player'|'bot', text, ts}]  (short-term conversation)
      stats: {            // self-improvement counters
        tasksCompleted: 0,
        tasksFailed: 0,
        deaths: 0,
        retries: 0,
        lessonsLearned: 0,
      },
    };
    this.load();
  }

  /* ----- Persistence ----- */

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = Object.assign(this.data, raw || {});
        if (!this.data.facts) this.data.facts = {};
        if (!this.data.notes) this.data.notes = [];
        if (!this.data.locations) this.data.locations = [];
        if (!this.data.history) this.data.history = [];
        if (!this.data.stats) this.data.stats = { tasksCompleted: 0, tasksFailed: 0, deaths: 0, retries: 0, lessonsLearned: 0 };
        this._seq = this.data.notes.reduce((mx, n) => Math.max(mx, n.seq || 0), 0);
      }
    } catch (err) {
      console.warn('[memory] Could not load memory:', err.message);
    }
  }

  save() {
    if (this.enabled === false) return; // in-memory only (unit tests / opt-out)
    try {
      const dir = path.dirname(this.filePath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[memory] Could not save memory:', err.message);
    }
  }

  /* ----- Facts ----- */

  setFact(key, value) {
    this.data.facts[key] = value;
    this.save();
  }

  getFact(key, fallback) {
    return this.data.facts[key] !== undefined ? this.data.facts[key] : fallback;
  }

  hasFact(key) {
    return this.data.facts[key] !== undefined;
  }

  removeFact(key) {
    delete this.data.facts[key];
    this.save();
  }

  allFacts() {
    return { ...this.data.facts };
  }

  /* ----- Lessons (self-improvement) ----- */

  /**
   * Record a lesson. Same lesson text/category is deduplicated (count++).
   * @param {string} text
   * @param {string[]} tags
   */
  learn(text, tags = []) {
    if (!text || typeof text !== 'string') return null;
    const existing = this.data.notes.find((n) => n.text === text);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = Date.now();
      this.data.stats.lessonsLearned++;
      this.save();
      return existing;
    }
    const note = {
      seq: ++this._seq,
      id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text,
      tags: Array.isArray(tags) ? tags : [],
      count: 1,
      ts: Date.now(),
      lastSeen: Date.now(),
    };
    this.data.notes.push(note);
    this.data.stats.lessonsLearned++;
    this._trimNotes();
    this.save();
    return note;
  }

  /**
   * Recall the most relevant lessons - recency + count weighted.
   * @param {number} limit
   * @param {string[]} [filterTags]
   */
  recallLessons(limit = 5, filterTags) {
    let notes = this.data.notes.slice();
    if (filterTags && filterTags.length > 0) {
      notes = notes.filter((n) => n.tags.some((t) => filterTags.includes(t)));
    }
    notes.sort((a, b) => {
      const scoreA = (a.count || 1) / (1 + (Date.now() - (a.lastSeen || a.ts)) / 86400000);
      const scoreB = (b.count || 1) / (1 + (Date.now() - (b.lastSeen || b.ts)) / 86400000);
      if (scoreB !== scoreA) return scoreB - scoreA;
      // deterministic tie-break: the most recently learned lesson wins
      return (b.seq || 0) - (a.seq || 0);
    });
    return notes.slice(0, limit);
  }

  _trimNotes() {
    if (this.data.notes.length <= this.maxLessons) return;
    this.data.notes.sort((a, b) => (b.count || 1) - (a.count || 1));
    this.data.notes = this.data.notes.slice(0, this.maxLessons);
  }

  /* ----- Locations ----- */

  rememberLocation(type, x, y, z, dim, quality) {
    if (!type || x === undefined || y === undefined || z === undefined) return null;
    const loc = { type, x, y, z, dim: dim || null, quality: quality || 1, ts: Date.now() };
    this.data.locations.push(loc);
    if (this.data.locations.length > 500) this.data.locations = this.data.locations.slice(-500);
    this.save();
    return loc;
  }

  findLocations(type, limit = 5) {
    return this.data.locations
      .filter((l) => l.type === type)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  nearestLocation(type, pos) {
    let best = null;
    let bestDist = Infinity;
    for (const l of this.data.locations) {
      if (l.type !== type) continue;
      const d = Math.hypot(l.x - pos.x, l.z - pos.z);
      if (d < bestDist) { bestDist = d; best = l; }
    }
    return best;
  }

  /* ----- Conversation history ----- */

  pushHistory(role, text) {
    if (!text) return;
    this.data.history.push({ role, text, ts: Date.now() });
    if (this.data.history.length > 60) this.data.history = this.data.history.slice(-60);
  }

  popHistory(limit = 12) {
    return this.data.history.slice(-limit);
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }

  /* ----- Stats ----- */

  bumpStat(key, by = 1) {
    if (!this.data.stats[key]) this.data.stats[key] = 0;
    this.data.stats[key] += by;
    this.save();
  }

  stats() {
    return { ...this.data.stats };
  }

  /** Full serialized state (for context building / debugging). */
  toJSON(limit) {
    return {
      facts: this.allFacts(),
      lessons: this.recallLessons(limit || 5),
      locations: this.data.locations.slice(-10),
      recentChat: this.popHistory(8),
      stats: this.stats(),
    };
  }
}

module.exports = BotMemory;
