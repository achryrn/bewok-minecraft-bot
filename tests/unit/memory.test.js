const fs = require('fs');
const os = require('os');
const path = require('path');
const BotMemory = require('../../src/memory');

describe('BotMemory', () => {
  let dir;
  let mem;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmem-'));
    mem = new BotMemory(path.join(dir, 'memory.json'), 50);
    mem.enabled = true;
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  describe('facts', () => {
    it('sets and gets facts, persists to disk', () => {
      mem.setFact('home', { x: 1, y: 2, z: 3 });
      const reloaded = new BotMemory(path.join(dir, 'memory.json'), 50);
      expect(reloaded.getFact('home')).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('returns fallback for missing fact', () => {
      expect(mem.getFact('nope', 'fallback')).toBe('fallback');
      expect(mem.hasFact('nope')).toBe(false);
    });

    it('removes facts', () => {
      mem.setFact('k', 'v');
      mem.removeFact('k');
      expect(mem.getFact('k', null)).toBeNull();
    });
  });

  describe('lessons', () => {
    it('learns and deduplicates', () => {
      mem.learn('never dig straight down', ['safety']);
      mem.learn('never dig straight down', ['safety']);
      expect(mem.recallLessons(10)[0].count).toBe(2);
      expect(mem.stats().lessonsLearned).toBe(2);
    });

    it('recalls most relevant first', () => {
      mem.learn('old lesson', ['old']);
      mem.learn('fresh lesson', ['fresh']);
      const top = mem.recallLessons(1);
      expect(top[0].text).toBe('fresh lesson');
    });
  });

  describe('locations', () => {
    it('remembers and finds locations', () => {
      mem.rememberLocation('ore:iron_ore', 10, 20, 30, 'overworld', 4);
      const locs = mem.findLocations('ore:iron_ore');
      expect(locs).toHaveLength(1);
      expect(locs[0].x).toBe(10);
      expect(locs[0].quality).toBe(4);
    });

    it('finds nearest location', () => {
      mem.rememberLocation('tree', 0, 64, 0);
      mem.rememberLocation('tree', 500, 64, 500);
      const near = mem.nearestLocation('tree', { x: 2, y: 64, z: 2 });
      expect(near.x).toBe(0);
    });
  });

  describe('history', () => {
    it('pushes and pops bounded history', () => {
      for (let i = 0; i < 80; i++) mem.pushHistory('player', 'msg' + i);
      expect(mem.popHistory().length).toBeLessThanOrEqual(60);
      expect(mem.data.history.length).toBeLessThanOrEqual(60);
    });
  });

  describe('disabled mode', () => {
    it('does not write when disabled', () => {
      const mem2 = new BotMemory(path.join(dir, 'disabled.json'));
      mem2.enabled = false;
      mem2.setFact('k', 'v');
      expect(fs.existsSync(path.join(dir, 'disabled.json'))).toBe(false);
    });
  });

  describe('stats', () => {
    it('bumps stats', () => {
      mem.bumpStat('retries', 3);
      expect(mem.stats().retries).toBe(3);
    });
  });

  describe('toJSON', () => {
    it('returns digestible summary', () => {
      mem.setFact('a', 1);
      mem.learn('lesson one', ['x']);
      const json = mem.toJSON(1);
      expect(json.facts.a).toBe(1);
      expect(json.lessons[0].text).toBe('lesson one');
      expect(json.stats).toBeDefined();
    });
  });
});
