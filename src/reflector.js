'use strict';
/**
 * reflector.js - the "learn from everything" agent.
 *
 * Self-improvement without an LLM round-trip: the reflector watches events
 * (task failures, deaths, stuck navigation, ore discoveries, inventory fills)
 * and converts them into durable lessons + locations in BotMemory. Lessons are
 * deduplicated and weighted by frequency, so the bot genuinely gets smarter
 * over time instead of repeating the same mistakes.
 *
 * The LLM planner reads MEMORY on every query, so a lesson learned here
 * steers the very next decision (e.g. "never dig straight down" or
 * "iron ore spawns near y=16 in this world").
 */

const STATIC_LESSONS = {
  death: 'I died. Staying alive is priority one; keep food, avoid lava, and do not fight when low on health.',
  stuck: 'Pathfinding got stuck there; avoid traversing that area and prefer open terrain.',
  noBlock: 'The block I need is not nearby; scan further out before giving up and ask for a better location.',
  inventoryFull: 'My inventory filled up; drop or deposit junk before continuing to gather.',
  noPath: 'There is no walkable path to that target; pick a closer or more reachable target.',
  lava: 'Lava is dangerous; never dig into or walk near uncovered lava.',
  lowHealth: 'I fight poorly at low health; retreat, eat, and heal before engaging.',
};

class ReflectorAgent {
  /**
   * @param {object} bot - mineflayer bot
   * @param {BotMemory} memory
   * @param {object} config
   */
  constructor(bot, memory, config) {
    this.bot = bot;
    this.memory = memory;
    this.config = config;
  }

  /** Central observation entry. */
  observe(event) {
    if (!event || !event.type) return;
    const stats = this.memory.stats();
    try {
      switch (event.type) {
        case 'task-complete': this._onTaskComplete(event.task, event.detail); break;
        case 'task-fail': this._onTaskFail(event.reason, event.action, event.detail); break;
        case 'death': this._onDeath(event.cause); break;
        case 'stuck': this._onStuck(event.location); break;
        case 'no-block': this._onNoBlock(event.block); break;
        case 'inventory-full': this.memory.learn(STATIC_LESSONS.inventoryFull, ['inventory', 'gathering']); break;
        case 'ore-found': this._onOreFound(event); break;
        case 'retry': this.memory.bumpStat('retries'); break;
        case 'player-request': this._onPlayerRequest(event.player); break;
        default: break;
      }
    } catch (err) {
      if (this.config && this.config.debug) console.log('[reflector] observe error:', err.message);
    }
  }

  _onTaskComplete(task, detail) {
    this.memory.bumpStat('tasksCompleted');
    if (!task) return;
    // Remember useful discovery locations reported through progress
    const progress = task.progress || {};
    if (task.type === 'mine' && progress.mined && progress.mined >= 1 && progress.block) {
      const pos = this.bot && this.bot.entity ? this.bot.entity.position : null;
      if (pos) {
        this.memory.rememberLocation('resource:' + progress.block, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), (this.bot.game && this.bot.game.dimension) || 'overworld', 3);
      }
    }
  }

  _onTaskFail(reason, action, detail) {
    this.memory.bumpStat('tasksFailed');
    const reasonStr = String(reason || 'unknown');
    if (/stuck/i.test(reasonStr) || /cannot reach/i.test(reasonStr)) {
      this.memory.learn(STATIC_LESSONS.stuck, ['movement', 'stuck']);
    }
    if (/no .* found|not found|no more/i.test(reasonStr)) {
      this.memory.learn(STATIC_LESSONS.noBlock, ['gathering', 'search']);
    }
    if (/inventory full/i.test(reasonStr)) {
      this.memory.learn(STATIC_LESSONS.inventoryFull, ['inventory']);
    }
    if (/no path|unreachable/i.test(reasonStr)) {
      this.memory.learn(STATIC_LESSONS.noPath, ['movement', 'pathing']);
    }
    if (/lava/i.test(reasonStr)) {
      this.memory.learn(STATIC_LESSONS.lava, ['safety', 'mining']);
    }
    // Domain lessons for the most common actions
    if (action === 'mine' || action === 'gather') {
      this.memory.learn('Mining failed (' + reasonStr + ') - pick a different spot or tool before retrying.', ['mining']);
    }
    if (action === 'attack') {
      this.memory.learn('Combat failed (' + reasonStr + ') - heal, equip a sword, and engage one target at a time.', ['combat']);
    }
  }

  _onDeath(cause) {
    this.memory.bumpStat('deaths');
    const causeStr = String(cause || 'unknown');
    this.memory.learn('I died at ' + causeStr + '. ' + STATIC_LESSONS.death, ['death', 'safety']);
    if (/lava|fire/i.test(causeStr)) {
      this.memory.learn(STATIC_LESSONS.lava, ['safety', 'lava']);
    }
    if (/creeper|zombie|skeleton|spider|mob/i.test(causeStr)) {
      this.memory.learn('I was killed by ' + causeStr + '; keep distance, use armor, and do not wander at night unprepared.', ['combat', 'night']);
    }
  }

  _onStuck(location) {
    this.memory.learn(STATIC_LESSONS.stuck, ['movement', 'stuck']);
    if (location && this.bot) {
      this.memory.rememberLocation('stuck-spot', Math.floor(location.x), Math.floor(location.y), Math.floor(location.z), (this.bot.game && this.bot.game.dimension) || null, 1);
    }
  }

  _onNoBlock(block) {
    this.memory.learn('Could not find ' + block + ' nearby - search wider or choose a different block.', ['gathering', 'search']);
  }

  _onOreFound(event) {
    if (!event || !event.ore) return;
    const pos = event.position || (this.bot && this.bot.entity ? this.bot.entity.position : null);
    if (pos) {
      this.memory.rememberLocation('ore:' + event.ore, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), (this.bot.game && this.bot.game.dimension) || null, event.count || 3);
    }
  }

  _onPlayerRequest(player) {
    if (player) {
      this.memory.setFact('lastRequestedBy', player);
    }
  }

  /** Human-readable memory digest used by the 'recall' action. */
  digest() {
    const lessons = this.memory.recallLessons(5);
    const locs = this.memory.data.locations.slice(-5);
    const lines = [];
    if (lessons.length > 0) lines.push('Lessons: ' + lessons.map((l) => l.text).join(' | '));
    if (locs.length > 0) lines.push('Places: ' + locs.map((l) => l.type + ' @' + l.x + ',' + l.y + ',' + l.z).join(' | '));
    if (lines.length === 0) lines.push('Nothing learned yet.');
    return lines.join('\n');
  }
}

module.exports = ReflectorAgent;
