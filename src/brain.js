'use strict';
/**
 * brain.js - the multi-agent orchestrator.
 *
 * One bot, several cooperating agents (all in the same process):
 *
 *   1. PLANNER  (src/planner.js) - reads the FULL live game context + memory
 *      and decides what to SAY and DO (ordered plan of actions).
 *   2. EXECUTOR (src/executor.js) - runs each plan step with retries, timeouts
 *      and failure classification, keeping the player updated (interactive).
 *   3. REFLECTOR(src/reflector.js) - watches outcomes (failures, deaths,
 *      discoveries) and writes durable lessons into memory so the bot
 *      self-improves over time.
 *
 * The brain also keeps the legacy single-query path (spawnClaudeQuery /
 * executeCommand) so existing command shortcuts and tests keep working, and so
 * third-party code can still drive the bot with one {action,args} object.
 *
 * Requirements covered here:
 *   - decisive/response: planner falls back to sensible defaults, never stalls,
 *   - failsafe/retry: every action dispatched through ActionExecutor,
 *   - interactive: progress updates + clear failure messages in chat,
 *   - full context: context.buildFullContext feeds the planner every query,
 *   - long tasks: task manager persists + resumes across reconnects,
 *   - self improving: reflector -> memory -> planner on every loop.
 */

const { TaskManager } = require('./task');
const { BuildController } = require('./building');
const LLMClient = require('./llm');
const BotMemory = require('./memory');
const { PlannerAgent } = require('./planner');
const ReflectorAgent = require('./reflector');
const { ActionExecutor } = require('./executor');
const { buildFullContext } = require('./context');

const SYSTEM_PROMPT = [
  'You are a Minecraft bot. Bot state below has an "inventory" field - this is the bot\'s actual inventory from the server. When asked about inventory, look at the bot state and report what you see there. Do not guess or assume items not listed.',
  'Reply with JSON only. No extra text.',
  'Available actions: chat, move, mine, gather, follow, stop, attack, craft, drop, come, status, findore, explore, build, chain, equip, cycle.',
  'If unsure: {"action":"chat","args":{"message":"I did not understand that."}}',
].join('\n');

const MAX_HISTORY = 6;
const STOP_WORDS = ['stop', 'cancel', 'halt', 'abort', 'shut up', 'stop every task', 'stop all', 'remove all task', 'remove all tasks', 'clear task', 'clear tasks'];

class Brain {
  constructor(bot, config, nav) {
    this.bot = bot;
    this.config = config;
    this.nav = nav;
    this.history = [];
    this.currentLoop = null;
    this.loopRunning = false;
    this._stopRequested = false;
    this.triggerWords = config.triggerWords || ['bot', 'hey bot', '!bot'];
    this.claudePath = config.claudePath || 'claude';

    // --- Agents -----------------------------------------------------------
    this.llm = new LLMClient(config);
    this.planner = new PlannerAgent(config, this.llm);

    const memoryCfg = (config && config.memory) || {};
    this.memory = new BotMemory(memoryCfg.path || './data/memory.json', memoryCfg.maxLessons || 300);
    this.memory.enabled = (memoryCfg.enabled === true); // off by default -> no disk writes in unit tests
    if (config && config.debug && this.memory.enabled) console.log('[brain] Persistent memory enabled at ' + (memoryCfg.path || './data/memory.json'));

    this.reflector = new ReflectorAgent(bot, this.memory, config);
    this.executor = new ActionExecutor(config, (msg) => this.bot.chat(msg));

    this.taskManager = new TaskManager(bot, config.taskStatePath || './data/task-state.json');
    this.taskManager.loadFromDisk();
  }

  /* ----- Conversation ----- */

  /**
   * Handle an inbound player message.
   * @param {string} username
   * @param {string} message
   * @param {object} [opts] - { direct: true } for whispers (no trigger needed)
   */
  async handleChat(username, message, opts) {
    if (username === this.bot.username) return;
    const direct = !!(opts && opts.direct);
    let intent;
    if (direct) {
      intent = (message && message.trim()) || null;
      const extracted = this._extractIntent(message);
      if (extracted && extracted !== 'status') intent = extracted;
    } else {
      intent = this._extractIntent(message);
    }
    if (!intent) return;

    // Instant stop/clear handling - no model round trip (failsafe)
    const lowered = intent.toLowerCase();
    if (STOP_WORDS.some((w) => lowered.includes(w))) {
      this._actionStop();
      this._recordExchange(username, intent, { action: 'stop', args: {} });
      if (this.memory) this.memory.pushHistory('player', username + ': ' + intent);
      return;
    }

    // Status shortcut - fast health/position report without the model
    if (/^(status|stats?|hp|health|where are you|pos)$/i.test(intent.trim())) {
      await this._actionStatus();
      this._recordExchange(username, intent, { action: 'status', args: {} });
      return;
    }

    console.log('[brain] ' + username + ' says: ' + intent);
    if (this.memory) this.memory.pushHistory('player', username + ': ' + intent);

    const ctx = this._buildFullContext();
    const historyStr = this._formatHistory();

    let plan;
    try {
      plan = await this.planner.plan(username, intent, ctx, historyStr);
    } catch (err) {
      // Failsafe: never leave the player hanging when the model is unreachable.
      console.log('[brain] Planner error: ' + err.message);
      const fallback = this._fallbackIntent(intent, username);
      if (fallback) {
        this._recordExchange(username, intent, fallback);
        await this.executeCommand(fallback, username);
        if (this.memory) this.memory.pushHistory('bot', 'brain offline; used local fallback');
        return;
      }
      this.bot.chat('I cannot reach my brain interface right now. Please try again in a moment.');
      this._recordExchange(username, intent, { action: 'chat', args: { message: 'brain hiccup' } });
      return;
    }

    await this._executePlan(plan, username, intent);
  }

  /**
   * Run a full planner plan: record it, write planner memory, reply, then
   * execute every step sequentially (interruptible by "stop").
   */
  async _executePlan(plan, username, intent) {
    this._stopRequested = false;
    this._recordExchange(username, intent, { reply: plan.reply, plan: plan.plan, unknown: plan.unknown });
    if (this.memory) this.memory.pushHistory('bot', plan.reply || (plan.plan.length ? JSON.stringify(plan.plan) : '(silent)'));

    // Immersion memory write-back from the planner
    this._applyPlannerMemory(plan.remember);

    if (plan.reply) this._say(plan.reply);

    // Execute the plan step by step (interruptible; "stop" sets _stopRequested)
    for (const step of plan.plan) {
      if (this._stopRequested) break;
      await this._executePlanStep(step, username);
    }

    if (this.reflector) this.reflector.observe({ type: 'player-request', player: username });
  }

  /**
   * Local deterministic intent parser - used when the planner/LLM is offline so
   * the bot can still handle the most common requests (failsafe behavior).
   */
  _fallbackIntent(intent, username) {
    if (!intent) return null;
    const text = intent.trim().toLowerCase();

    const mineMatch = text.match(/^(?:mine|gather|dig|break)\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
    if (mineMatch) {
      return { action: 'mine', args: { block: mineMatch[1], count: parseInt(mineMatch[2], 10) || 1 } };
    }

    const followMatch = text.match(/^(?:follow)\s+([a-z0-9_]+)$/);
    if (followMatch) return { action: 'follow', args: { player: followMatch[1] } };

    const oreMatch = text.match(/^(?:find|locate)\s+([a-z0-9_]+)\s*ore$/);
    if (oreMatch) return { action: 'findore', args: { ore: oreMatch[1] } };

    const craftMatch = text.match(/^(?:craft|make)\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
    if (craftMatch) {
      return { action: 'craft', args: { item: craftMatch[1], count: parseInt(craftMatch[2], 10) || 1 } };
    }

    const dropMatch = text.match(/^(?:drop|discard|toss)\s+([a-z0-9_]+)(?:\s+(\d+))?$/);
    if (dropMatch) {
      return { action: 'drop', args: { item: dropMatch[1], count: parseInt(dropMatch[2], 10) || 64 } };
    }

    if (/^(?:come|over here)$/.test(text)) return { action: 'come', args: { player: username || '' } };
    if (/^(?:status|stats?|where (?:are|am) i)$/.test(text)) return { action: 'status', args: {} };
    if (/^(?:equip)\s+([a-z0-9_]+)$/.test(text)) return { action: 'equip', args: { item: text.split(' ')[1] } };
    if (/^(?:explore)\s*(.*)$/.test(text)) {
      const dir = text.replace('explore', '').trim() || 'north';
      return { action: 'explore', args: { direction: dir } };
    }
    return null;
  }

  /**
   * Loop-backed actions run asynchronously (setImmediate) - the plan must wait
   * for them to finish before moving to the next step so steps never overlap.
   */
  _waitForLoopEnd(timeoutMs) {
    return new Promise((resolve) => {
      if (!this.loopRunning) { resolve(false); return; }
      const started = Date.now();
      const timer = setInterval(() => {
        if (!this.loopRunning) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          this.cancelCurrentLoop();
          resolve(false);
        }
      }, 300);
    });
  }

  /** Execute a single plan step via the retry/failsafe executor. */
  async _executePlanStep(step, username) {
    const handler = this._actionFor(step.action);
    if (!handler) {
      this.bot.chat('I do not know how to "' + step.action + '" yet.');
      return;
    }
    const outcome = await this.executor.dispatch({
      action: step.action,
      args: step.args || {},
      execute: async (args) => {
        await handler.call(this, args);
        return true;
      },
      onProgress: (msg) => this._say(msg),
    });
    if (!outcome.ok) {
      const reason = outcome.error ? outcome.error.reason : 'unknown';
      this._say('That did not work (' + reason + ') - ' + this._suggestionFor(reason, step.action));
      if (this.reflector) this.reflector.observe({ type: 'task-fail', reason: reason, action: step.action });
      return;
    }

    // Wait for bounded loop actions to actually complete before the next step.
    const LOOP_ACTIONS = ['mine', 'gather', 'explore', 'build', 'chain', 'attack'];
    if (LOOP_ACTIONS.includes(step.action)) {
      const completed = await this._waitForLoopEnd(180000);
      if (!completed) {
        this._say('I stopped that mid-way (' + step.action + ') - taking too long.');
        if (this.reflector) this.reflector.observe({ type: 'task-fail', reason: 'timeout', action: step.action });
      }
    }

    if (this.reflector && step.action === 'findore' && Array.isArray(outcome.result) && outcome.result.length > 0) {
      this.reflector.observe({ type: 'ore-found', ore: (step.args || {}).ore, count: outcome.result.length });
    }
  }

  _suggestionFor(reason, action) {
    switch (reason) {
      case 'no-path': return 'that place is not reachable from here.';
      case 'no-block': return 'I could not find any nearby - point me somewhere?';
      case 'inventory-full': return 'my inventory is full - clear some space first.';
      case 'missing-item': return 'I do not have what I need for that.';
      case 'danger-lava': return 'lava is involved - not touching that.';
      case 'dead': return 'I died - give me a moment to respawn.';
      case 'brain-offline': return 'my brain process is unavailable right now.';
      case 'timeout': return 'that took too long, so I stopped.';
      default: return 'I will try a different way next time.';
    }
  }

  _extractIntent(message) {
    if (!message || typeof message !== 'string') return null;
    for (const trigger of this.triggerWords) {
      const regex = new RegExp(trigger.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&'), 'i');
      const match = message.match(regex);
      if (match) {
        const after = message.slice(match.index + match[0].length).trim();
        return after || 'status';
      }
    }
    return null;
  }

  /* ----- State & context ----- */

  /** Full live context for the planner (context.js). */
  _buildFullContext() {
    return buildFullContext(this.bot, this);
  }

  /** Legacy compact bot-state used by status reports and old callers. */
  _buildBotState() {
    const pos = this.bot.entity ? this.bot.entity.position : { x: 0, y: 0, z: 0 };
    const mobs = this._getNearbyMobs();
    const blocks = this._getNearbyBlocks();
    const players = Object.values(this.bot.players || {})
      .filter((p) => p.username !== this.bot.username)
      .map((p) => {
        let dist = '?';
        const botPos = this.bot.entity && this.bot.entity.position;
        const playerPos = p.entity && p.entity.position;
        if (botPos && playerPos && typeof botPos.x === 'number' && typeof playerPos.x === 'number') {
          const dx = botPos.x - playerPos.x;
          const dy = botPos.y - playerPos.y;
          const dz = botPos.z - playerPos.z;
          dist = Math.floor(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        return { name: p.username || 'unknown', distance: dist };
      });
    return {
      health: Math.floor(this.bot.health || 20),
      food: Math.floor(this.bot.food || 20),
      position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      inventory: this._buildInventorySummary(),
      heldItem: this.bot.heldItem ? { name: this.bot.heldItem.name, count: this.bot.heldItem.count } : null,
      armor: {
        head: this.bot.inventory && this.bot.inventory.slots && this.bot.inventory.slots[5] ? { name: this.bot.inventory.slots[5].name } : null,
        torso: this.bot.inventory && this.bot.inventory.slots && this.bot.inventory.slots[6] ? { name: this.bot.inventory.slots[6].name } : null,
        legs: this.bot.inventory && this.bot.inventory.slots && this.bot.inventory.slots[7] ? { name: this.bot.inventory.slots[7].name } : null,
        feet: this.bot.inventory && this.bot.inventory.slots && this.bot.inventory.slots[8] ? { name: this.bot.inventory.slots[8].name } : null,
      },
      offhand: this.bot.inventory && this.bot.inventory.slots && this.bot.inventory.slots[45] ? { name: this.bot.inventory.slots[45].name } : null,
      emptySlots: this.bot.inventory && typeof this.bot.inventory.emptySlotCount === 'function' ? this.bot.inventory.emptySlotCount() : '?',
      currentAction: this.loopRunning ? (this.currentLoop && this.currentLoop.action ? this.currentLoop.action : 'idle') : 'idle',
      nearbyPlayers: players.length > 0 ? players : [{ name: 'none', distance: 0 }],
      nearbyMobs: mobs.length > 0 ? mobs : ['none'],
      nearbyBlocks: blocks.length > 0 ? blocks : ['none'],
      activeTask: this.taskManager.currentTask ? this.taskManager.currentTask.toJSON() : null,
    };
  }

  _buildInventorySummary() {
    const im = this.bot.inventoryManager;
    let items = null;
    if (im && typeof im.items === 'function') items = im.items();
    if (!items && this.bot.inventory && typeof this.bot.inventory.items === 'function') items = this.bot.inventory.items();
    if (!items || items.length === 0) return ['empty'];
    const counts = {};
    for (const i of items) {
      const name = i.name || '';
      const cnt = i.count || 1;
      if (name && name !== 'air' && name !== 'minecraft:air') {
        counts[name] = (counts[name] || 0) + cnt;
      }
    }
    const entries = Object.entries(counts);
    return entries.length === 0 ? ['empty'] : entries.map(([name, count]) => name + ' x' + count);
  }

  _buildTaskContext() {
    const t = this.taskManager.currentTask;
    if (!t) return 'No active task.';
    return 'Active task: ' + t.type + ' ' + JSON.stringify(t.args) + ' - status: ' + t.status + ' - progress: ' + JSON.stringify(t.progress);
  }

  _getNearbyMobs() {
    try {
      const entities = this.bot.entities || {};
      const counts = {};
      Object.values(entities).forEach((e) => {
        if (e.type === 'mob' || e.type === 'hostile') {
          const name = e.name || e.displayName || 'unknown';
          counts[name] = (counts[name] || 0) + 1;
        }
      });
      return Object.entries(counts).map(([name, count]) => (count > 1 ? name + ' x' + count : name));
    } catch (e) {
      return [];
    }
  }

  _getNearbyBlocks() {
    try {
      const pos = this.bot.entity.position;
      const seen = new Set();
      const blocks = [];
      for (let dx = -5; dx <= 5; dx += 2) {
        for (let dz = -5; dz <= 5; dz += 2) {
          for (let dy = -4; dy <= 4; dy += 2) {
            const block = this.bot.blockAt(pos.offset(dx, dy, dz));
            if (block && block.name && block.name !== 'air' && !seen.has(block.name)) {
              seen.add(block.name);
              blocks.push(block.name);
            }
          }
        }
      }
      return blocks.slice(0, 10);
    } catch (e) {
      return [];
    }
  }

  /** Case-insensitive player lookup (player names arrive from chat in any case). */
  _findPlayer(name) {
    if (!name) return null;
    const players = this.bot.players || {};
    if (players[name]) return players[name];
    const lower = String(name).toLowerCase();
    return Object.keys(players).find((k) => k.toLowerCase() === lower) ? players[Object.keys(players).find((k) => k.toLowerCase() === lower)] : null;
  }

  _formatHistory() {
    if (this.history.length === 0) return '';
    return this.history
      .map((h) => (h.startsWith('Bot: ') ? 'Bot: (responded)' : h))
      .join('\n');
  }

  _recordExchange(username, intent, command) {
    const playerEntry = 'Player ' + username + ': ' + intent;
    let botEntry = 'Bot: ';
    try {
      botEntry += JSON.stringify(command);
    } catch (e) {
      botEntry += '{"action":"chat","args":{"message":"Brain error."}}';
    }
    this.history.push(playerEntry);
    this.history.push(botEntry);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(this.history.length - MAX_HISTORY);
    }
  }

  /** Write planner "remember" directives into durable memory. */
  _applyPlannerMemory(remember) {
    if (!Array.isArray(remember) || !this.memory || !this.memory.enabled) return;
    for (const entry of remember) {
      if (!entry || typeof entry !== 'object') continue;
      const type = entry.type || 'lesson';
      if (type === 'lesson' && entry.text) {
        this.memory.learn(String(entry.text), ['planner']);
      } else if (type === 'fact' && Array.isArray(entry.fact) && entry.fact.length >= 2) {
        this.memory.setFact(String(entry.fact[0]), entry.fact[1]);
      } else if (type === 'location' && Array.isArray(entry.location) && entry.location.length >= 4) {
        const locType = entry.location[0];
        const x = Number(entry.location[1]);
        const y = Number(entry.location[2]);
        const z = Number(entry.location[3]);
        const q = Number(entry.location[4]) || 1;
        this.memory.rememberLocation(String(locType), x, y, z, null, q);
      }
    }
  }

  _say(message) {
    if (!message) return;
    const MAX_LINE = 220;
    if (message.length <= MAX_LINE) {
      this.bot.chat(message);
      return;
    }
    const words = message.split(' ');
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).length > MAX_LINE) {
        this.bot.chat(line.trim());
        line = w;
      } else {
        line = line ? line + ' ' + w : w;
      }
    }
    if (line.trim()) this.bot.chat(line.trim());
  }

  /* ----- Legacy LLM query path (kept for compat/tests) ----- */

  async spawnClaudeQuery(playerName, intent, botState, history, taskContext) {
    const ctx = {
      legacyState: botState || {},
      task: taskContext || null,
      plus: this._buildFullContext(),
    };
    let planResult;
    try {
      planResult = await this.planner.plan(playerName, intent, ctx, this._formatHistory());
    } catch (err) {
      const msg = err.message || '';
      this.bot.chat(/enoent|not found|spawn/i.test(msg) ? 'Brain offline.' : 'Brain error.');
      return { action: 'chat', args: { message: 'Brain error.' } };
    }
    const raw = planResult.raw;
    if (raw && raw.action) return { action: raw.action, args: raw.args || {} };
    if (planResult.reply) return { action: 'chat', args: { message: planResult.reply } };
    if (planResult.plan.length === 1) return planResult.plan[0];
    if (planResult.plan.length > 1) return { action: 'chain', args: { steps: planResult.plan } };
    return { action: 'chat', args: { message: 'I did not understand that.' } };
  }

  _stripMarkdown(output) {
    let cleaned = String(output || '').trim();
    const fenceRegex = /\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/;
    const match = cleaned.match(fenceRegex);
    if (match) cleaned = match[1].trim();
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {
      console.log('[brain] Invalid JSON after markdown strip, using fallback');
      return '{"action":"chat","args":{"message":"Brain error."}}';
    }
  }

  /* ----- Death/Respawn ----- */

  onDeath() {
    console.log('[bot] Bot died');
    if (this.reflector) this.reflector.observe({ type: 'death', cause: 'unknown' });
    if (this.taskManager.currentTask && this.taskManager.currentTask.status === 'running') {
      this.taskManager.pauseTask('Bot died');
      this.taskManager.currentTask.log('paused', 'Bot died, will resume on respawn');
      console.log('[task] Paused task due to death');
    }
  }

  onSpawn() {
    const task = this.taskManager.currentTask;
    if (task && task.status === 'paused') {
      console.log('[task] Resuming task: ' + task.type + ' ' + JSON.stringify(task.args) + ' (resume #' + (task.resumeCount + 1) + ')');
      this.bot.chat('Resuming previous task: ' + this._describeTask(task));
      const resumed = this.taskManager.resumeTask();
      this._dispatchTaskLoop(resumed);
    }
  }

  _describeTask(task) {
    if (task.type === 'mine' || task.type === 'gather') {
      return task.type + ' ' + (task.args.block || 'blocks') + ' x' + (task.args.count || '?');
    }
    return task.type + ' ' + JSON.stringify(task.args);
  }

  _dispatchTaskLoop(task) {
    switch (task.type) {
      case 'mine':
      case 'gather':
        return this._actionMine({ ...task.args, _resumedTask: task });
      case 'explore':
        return this._actionExplore({ ...task.args, _resumedTask: task });
      case 'build':
        return this._actionBuild({ ...task.args, _resumedTask: task });
      case 'chain':
        return this._actionChain({ ...task.args, _resumedTask: task });
      default:
        console.log('[task] Cannot resume task type: ' + task.type);
        this.taskManager.failTask('Unknown task type for resume: ' + task.type);
    }
  }

  /* ----- Dispatch ----- */

  _actionFor(action) {
    const map = {
      chat: this._actionChat, move: this._actionMove, mine: this._actionMine,
      gather: this._actionMine, follow: this._actionFollow, stop: this._actionStop,
      attack: this._actionAttack, craft: this._actionCraft, drop: this._actionDrop,
      come: this._actionCome, status: this._actionStatus, findore: this._actionFindOre,
      explore: this._actionExplore, build: this._actionBuild, chain: this._actionChain,
      equip: this._actionEquip, cycle: this._actionCycle, remember: this._actionRemember,
      recall: this._actionRecall, wait: this._actionWait, jump: this._actionJump,
      sprint: this._actionSprint, sneak: this._actionSneak, greet: this._actionGreet,
    };
    return map[action] || null;
  }

  async executeCommand(command, username) {
    if (!command || !command.action) return;
    if (command.action !== 'chat' && command.action !== 'status') {
      this.cancelCurrentLoop();
    }
    switch (command.action) {
      case 'chat': this._actionChat(command.args); break;
      case 'move': await this._actionMove(command.args); break;
      case 'mine': await this._actionMine(command.args); break;
      case 'gather': await this._actionMine(command.args); break;
      case 'follow': await this._actionFollow(command.args); break;
      case 'stop': this._actionStop(); break;
      case 'attack': await this._actionAttack(command.args); break;
      case 'craft': await this._actionCraft(command.args); break;
      case 'drop': await this._actionDrop(command.args); break;
      case 'come': await this._actionCome(command.args); break;
      case 'status': await this._actionStatus(); break;
      case 'findore': await this._actionFindOre(command.args); break;
      case 'explore': await this._actionExplore(command.args); break;
      case 'build': await this._actionBuild(command.args); break;
      case 'chain': await this._actionChain(command.args); break;
      case 'equip': await this._actionEquip(command.args); break;
      case 'cycle': await this._actionCycle(command.args); break;
      case 'remember': this._actionRemember(command.args); break;
      case 'recall': this._actionRecall(command.args); break;
      case 'wait': await this._actionWait(command.args); break;
      case 'jump': await this._actionJump(); break;
      case 'sprint': await this._actionSprint(command.args); break;
      case 'sneak': await this._actionSneak(command.args); break;
      case 'greet': this._actionGreet(command.args); break;
      default: this.bot.chat('Unknown action.');
    }
  }

  /* ----- Actions ----- */

  _actionChat(args) {
    if (args && args.message) this.bot.chat(args.message);
  }

  async _actionMove(args) {
    if (!args || args.x === undefined || args.y === undefined || args.z === undefined) {
      this.bot.chat('Move requires x, y, z coordinates.');
      return;
    }
    try {
      const reached = await this.nav.goto(args.x, args.y, args.z, 1);
      if (!reached) this.bot.chat('Cannot reach that position.');
      else if (args.announce) this.bot.chat('Moved to ' + Math.floor(args.x) + ', ' + Math.floor(args.y) + ', ' + Math.floor(args.z) + '.');
    } catch (err) {
      this.bot.chat('Cannot reach that position.');
      throw err;
    }
  }

  async _actionMine(args) {
    if (!args || !args.block) {
      this.bot.chat('Mine requires a block type.');
      return;
    }
    const resumedTask = args._resumedTask;
    if (resumedTask) resumedTask.log('resumed', 'Continuing mining');

    const count = args.count || 1;
    const blockName = args.block;
    let mined = resumedTask ? (resumedTask.progress.mined || 0) : 0;

    if (!resumedTask) {
      const task = this.taskManager.startTask('mine', args, args._requestedBy || 'unknown');
      task.progress = { mined: 0, target: count, block: blockName };
    }

    this.loopRunning = true;
    this.currentLoop = { action: 'mining' };

    if (!resumedTask) this.bot.chat('Mining ' + count + ' ' + blockName + '...');
    else this.bot.chat('Continuing: ' + (count - mined) + ' more ' + blockName + '...');

    const mineLoop = async () => {
      while (this.loopRunning && mined < count) {
        try {
          if (this.bot.inventory.emptySlotCount && this.bot.inventory.emptySlotCount() === 0) {
            this.bot.chat('Inventory full - mined ' + mined + '/' + count + ' ' + blockName + '. Need space.');
            if (this.reflector) this.reflector.observe({ type: 'inventory-full' });
            this.taskManager.pauseTask('inventory_full');
            if (this.taskManager.currentTask) {
              this.taskManager.currentTask.progress.mined = mined;
              this.taskManager.saveToDisk();
            }
            while (this.loopRunning && this.bot.inventory.emptySlotCount() === 0) {
              await new Promise((r) => setTimeout(r, 2000));
            }
            if (this.loopRunning) {
              this.taskManager.resumeTask();
              this.bot.chat('Space freed - continuing...');
            }
          }

          const block = this.bot.findBlock({ matching: (b) => b.name === blockName, maxDistance: 32 });
          if (!block) {
            this.bot.chat('No ' + blockName + ' nearby.');
            if (this.reflector) this.reflector.observe({ type: 'no-block', block: blockName });
            break;
          }
          const dist = this.bot.entity.position.distanceTo(block.position);
          if (dist > 5) {
            const reached = await this.nav.goto(block.position.x, block.position.y, block.position.z, 4);
            if (!reached) {
              this.bot.chat('Cannot reach that ' + blockName + '.');
              break;
            }
          }
          await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
          await this.bot.dig(block);
          mined++;
          if (this.taskManager.currentTask) {
            this.taskManager.currentTask.progress.mined = mined;
            this.taskManager.saveToDisk();
          }
        } catch (err) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (this.loopRunning) {
        this.loopRunning = false;
        this.currentLoop = null;
        if (mined >= count) {
          this.taskManager.completeTask('Mined ' + count + ' ' + blockName);
          this.bot.chat('Mined ' + count + ' ' + blockName + '.');
          if (this.reflector) this.reflector.observe({ type: 'task-complete', task: this.taskManager.currentTask });
        } else if (mined > 0) {
          const reason = 'Mined ' + mined + '/' + count + ' ' + blockName + ' - no more found';
          this.taskManager.failTask(reason);
          if (this.reflector) this.reflector.observe({ type: 'task-fail', reason: reason, action: 'mine' });
        }
      }
    };
    setImmediate(() => { mineLoop(); });
  }

  async _actionFollow(args) {
    if (!args || !args.player) { this.bot.chat('Follow requires a player name.'); return; }
    const player = this._findPlayer(args.player);
    if (!player || !player.entity) { this.bot.chat('Cannot see player ' + args.player + '.'); return; }
    this.loopRunning = true;
    this.currentLoop = { action: 'following' };
    this.nav.followEntity(player.entity, 2);
    this.bot.chat('Following ' + args.player + '.');
  }

  _actionStop() {
    this.cancelCurrentLoop();
    this.taskManager.cancelTask();
    this.bot.chat('Stopped.');
  }

  async _actionAttack(args) {
    if (!args || !args.target) { this.bot.chat('Attack requires a target.'); return; }
    const targetName = args.target.toLowerCase();
    const entity = Object.values(this.bot.entities || {}).find((e) => {
      if (e.type === 'mob' || e.type === 'hostile' || e.type === 'player') {
        const name = (e.name || e.displayName || e.username || '').toLowerCase();
        return name === targetName || name.includes(targetName);
      }
      return false;
    });
    if (!entity) { this.bot.chat('No ' + args.target + ' nearby.'); return; }
    this.loopRunning = true;
    this.currentLoop = { action: 'attacking' };
    const attackLoop = async () => {
      while (this.loopRunning && entity.isValid && !entity.dead) {
        try {
          await this.bot.lookAt(entity.position.offset(0, 1, 0), true);
          if (this.bot.entity.position.distanceTo(entity.position) > 4) {
            this.nav.followEntity(entity, 2);
            await new Promise((r) => setTimeout(r, 200));
          } else {
            if (!this.bot.heldItem || !/sword|axe/.test(this.bot.heldItem.name)) {
              const im = this.bot.inventoryManager;
              if (im && typeof im.equipSword === 'function') await im.equipSword();
            }
            this.bot.attack(entity);
            await new Promise((r) => setTimeout(r, 300));
          }
        } catch (e) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (this.loopRunning) {
        this.loopRunning = false;
        this.currentLoop = null;
        this.nav.stop();
        this.bot.chat('Finished attacking ' + targetName + '.');
      }
    };
    setImmediate(() => { attackLoop(); });
  }

  async _actionCraft(args) {
    if (!args || !args.item) { this.bot.chat('Craft requires an item name.'); return; }
    try {
      const cm = this.bot.crafting;
      if (cm && typeof cm.craftWithTable === 'function') {
        await cm.craftWithTable(args.item, args.count || 1);
      } else if (cm) {
        await cm.craft(args.item, args.count || 1);
      } else {
        const mcData = require('minecraft-data')(this.bot.version);
        const item = mcData.itemsByName[args.item];
        if (!item) { this.bot.chat('Unknown item: ' + args.item); return; }
        await this.bot.craft(item.id, args.count || 1);
      }
      this.bot.chat('Crafted ' + (args.count || 1) + ' ' + args.item + '.');
    } catch (err) {
      this.bot.chat('Cannot craft ' + args.item + '.');
      throw err;
    }
  }

  async _actionDrop(args) {
    if (!args || !args.item) { this.bot.chat('Drop requires an item name.'); return; }
    const count = args.count || 64;
    try {
      const im = this.bot.inventoryManager;
      if (im && typeof im.tossItem === 'function') {
        const item = im.findItem(args.item);
        if (!item) { this.bot.chat('No ' + args.item + ' in inventory.'); return; }
        await im.tossItem(args.item, count);
      } else {
        const items = this.bot.inventory.items().filter((i) => i && i.name === args.item);
        if (items.length === 0) {
          const slots = this.bot.inventory.slots;
          if (slots) for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (s && s.name === args.item) { try { await this.bot.tossStack(s); } catch (e) {} }
          }
        } else {
          for (const item of items) {
            const toDrop = Math.min(count, item.count);
            if (item.type !== undefined) await this.bot.toss(item.type, item.metadata || 0, toDrop);
            else try { await this.bot.tossStack(item); } catch (e) {}
          }
        }
      }
      this.bot.chat('Dropped ' + args.item + '.');
    } catch (err) {
      this.bot.chat('Cannot drop ' + args.item + '.');
      throw err;
    }
  }

  async _actionEquip(args) {
    if (!args || !args.item) { this.bot.chat('Equip requires an item name.'); return; }
    try {
      const im = this.bot.inventoryManager;
      if (im && typeof im.equipItem === 'function') {
        const ok = await im.equipItem(args.item, 'hand');
        if (ok) { this.bot.chat('Equipped ' + args.item + '.'); return; }
      }
      const item = this.bot.inventory.items().find((i) => i && i.name === args.item);
      if (!item) { this.bot.chat('No ' + args.item + ' in inventory.'); return; }
      await this.bot.equip(item, 'hand');
      this.bot.chat('Equipped ' + args.item + '.');
    } catch (err) {
      this.bot.chat('Cannot equip ' + args.item + '.');
      throw err;
    }
  }

  async _actionCycle() {
    try {
      const slots = this.bot.inventory.slots;
      const heldSlot = this.bot.quickBarSlot || 0;
      let nextSlot = heldSlot;
      for (let i = 1; i <= 9; i++) {
        const testSlot = (heldSlot + i) % 9;
        const slotIdx = 36 + testSlot;
        if (slots[slotIdx] && slots[slotIdx].name && slots[slotIdx].name !== 'air') {
          nextSlot = testSlot;
          break;
        }
      }
      if (nextSlot !== heldSlot) {
        await this.bot.setQuickBarSlot(nextSlot);
        this.bot.chat('Cycled to slot ' + (nextSlot + 1) + '.');
      } else this.bot.chat('No other items in hotbar.');
    } catch (e) {
      this.bot.chat('Cannot cycle items.');
    }
  }

  async _actionCome(args) {
    if (!args || !args.player) { this.bot.chat('Come requires a player name.'); return; }
    const player = this._findPlayer(args.player);
    if (!player || !player.entity) { this.bot.chat('Cannot see player ' + args.player + '.'); return; }
    try {
      const pos = player.entity.position;
      const reached = await this.nav.goto(pos.x, pos.y, pos.z, 2);
      if (reached) this.bot.chat('Coming to ' + args.player + '.');
      else this.bot.chat('Cannot reach ' + args.player + '.');
    } catch (err) {
      this.bot.chat('Cannot reach ' + args.player + '.');
      throw err;
    }
  }

  async _actionStatus() {
    const state = this._buildBotState();
    const taskInfo = this.taskManager.currentTask
      ? ' | Task: ' + this.taskManager.currentTask.type + ' (' + this.taskManager.currentTask.status + ')'
      : '';
    this.bot.chat('HP: ' + state.health + '/' + state.food + ' food | Pos: ' + state.position.x + ', ' + state.position.y + ', ' + state.position.z + taskInfo);
  }

  async _actionFindOre(args) {
    if (!args || !args.ore) { this.bot.chat('Find ore requires an ore name.'); return; }
    const oreName = args.ore;
    const radius = args.radius || 64;
    try {
      const bb = this.bot.botbridge;
      if (bb && typeof bb.requestOreScan === 'function') {
        const pos = this.bot.entity.position;
        const oreId = oreName.includes(':') ? oreName : 'minecraft:' + oreName;
        try {
          const results = await bb.requestOreScan(oreId, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), radius);
          if (results.length === 0) {
            this.bot.chat('No ' + oreName + ' found within ' + radius + ' blocks (server scan).');
            if (this.reflector) this.reflector.observe({ type: 'no-block', block: oreName });
            return results;
          }
          const top3 = results.slice(0, 3);
          this.bot.chat('Found ' + results.length + ' ' + oreName + ' (server scan). Closest: ' + top3.map((p) => '(' + p.x + ',' + p.y + ',' + p.z + ')').join(', '));
          if (this.reflector) {
            const first = results[0];
            this.reflector.observe({ type: 'ore-found', ore: oreName, position: { x: first.x, y: first.y, z: first.z }, count: results.length });
          }
          return results;
        } catch (bbErr) {
          console.log('[brain] BotBridge scan failed: ' + bbErr.message + ' - falling back to local scan');
        }
      }

      const pos = this.bot.entity.position;
      const results = [];
      for (let x = -radius; x <= radius; x++) {
        for (let y = -radius; y <= radius; y++) {
          for (let z = -radius; z <= radius; z++) {
            const block = this.bot.blockAt(pos.offset(x, y, z));
            if (block && block.name === oreName) results.push(block.position);
          }
        }
      }
      results.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos));
      if (results.length === 0) {
        this.bot.chat('No ' + oreName + ' found within ' + radius + ' blocks.');
        if (this.reflector) this.reflector.observe({ type: 'no-block', block: oreName });
        return null;
      }
      const top3 = results.slice(0, 3);
      this.bot.chat('Found ' + results.length + ' ' + oreName + '. Closest: ' + top3.map((p) => '(' + p.x + ',' + p.y + ',' + p.z + ')').join(', '));
      if (this.reflector) {
        const first = results[0];
        this.reflector.observe({ type: 'ore-found', ore: oreName, position: { x: first.x, y: first.y, z: first.z }, count: results.length });
      }
      return results;
    } catch (err) {
      this.bot.chat('Error scanning for ' + oreName + '.');
      return null;
    }
  }

  async _actionExplore(args) {
    const direction = (args && args.direction) || 'north';
    const distance = (args && args.distance) || 100;
    const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
    const [dx, dz] = dirs[direction] || [0, -1];
    const pos = this.bot.entity.position;
    const targetX = pos.x + dx * distance;
    const targetZ = pos.z + dz * distance;
    const targetY = pos.y;

    if (!args._resumedTask) {
      this.taskManager.startTask('explore', { direction, distance, targetX, targetY, targetZ }, (args && args._requestedBy) || 'unknown');
    }
    this.loopRunning = true;
    this.currentLoop = { action: 'exploring' };
    this.bot.chat('Exploring ' + direction + ' for ' + distance + ' blocks...');

    let lastCheckPos = { x: pos.x, y: pos.y, z: pos.z };
    let stuckTime = 0;

    const exploreLoop = async () => {
      while (this.loopRunning) {
        const current = this.bot.entity.position;
        const dist = current.distanceTo({ x: targetX, y: targetY, z: targetZ });
        if (dist < 3) {
          this.bot.chat('Reached target after exploring ' + direction + '.');
          this.taskManager.completeTask('Explored ' + direction);
          break;
        }
        if (Math.abs(current.x - lastCheckPos.x) < 1 && Math.abs(current.z - lastCheckPos.z) < 1) {
          stuckTime += 5000;
          if (stuckTime >= 30000) {
            this.bot.chat('Got stuck exploring.');
            if (this.reflector) this.reflector.observe({ type: 'stuck', location: current });
            this.taskManager.failTask('stuck');
            break;
          }
        } else {
          stuckTime = 0;
          lastCheckPos = { x: current.x, y: current.y, z: current.z };
        }
        try {
          const reached = await this.nav.goto(targetX, targetY, targetZ, 3);
          if (!reached) await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      this.loopRunning = false;
      this.currentLoop = null;
    };
    setImmediate(() => { exploreLoop(); });
  }

  async _actionBuild(args) {
    if (!args || !args.shape) {
      this.bot.chat('Build requires a shape (platform, wall, cube, pillar).');
      return;
    }

    const resumedTask = args._resumedTask;
    if (!resumedTask) {
      this.taskManager.startTask('build', args, args._requestedBy || 'unknown');
    }

    this.loopRunning = true;
    this.currentLoop = { action: 'building' };

    const buildController = new BuildController(this.bot, null, this.config);
    const shapeArgs = {
      shape: args.shape,
      material: args.material || 'cobblestone',
      width: args.width || 5,
      length: args.length || args.width || 5,
      height: args.height || 1,
      hollow: args.hollow !== false,
      origin: args.origin || 'bot',
    };

    this.bot.chat('Building ' + shapeArgs.shape + '...');

    setImmediate(async () => {
      try {
        const result = await buildController.buildShape(shapeArgs, () => this.loopRunning);
        if (result.failureReason) {
          this.bot.chat('Build failed: ' + result.failureReason);
          this.taskManager.failTask(result.failureReason);
          if (this.reflector) this.reflector.observe({ type: 'task-fail', reason: result.failureReason, action: 'build' });
        } else {
          this.bot.chat('Build complete: placed ' + result.placed + ' blocks');
          this.taskManager.completeTask('Built ' + shapeArgs.shape);
          if (this.reflector) this.reflector.observe({ type: 'task-complete', task: this.taskManager.currentTask });
        }
      } catch (err) {
        this.bot.chat('Build error: ' + err.message);
        this.taskManager.failTask(err.message);
        if (this.reflector) this.reflector.observe({ type: 'task-fail', reason: err.message, action: 'build' });
      }
      this.loopRunning = false;
      this.currentLoop = null;
    });
  }

  async _actionChain(args) {
    if (!args || !args.steps || !Array.isArray(args.steps) || args.steps.length === 0) {
      this.bot.chat('Chain requires a steps array.');
      return;
    }

    for (let i = 0; i < args.steps.length; i++) {
      if (args.steps[i].action === 'chain') {
        this.bot.chat('Nested chains are not supported.');
        return;
      }
    }

    const resumedTask = args._resumedTask;
    let currentStepIndex = resumedTask ? (resumedTask.progress.currentStepIndex || 0) : 0;

    if (!resumedTask) {
      const task = this.taskManager.startTask('chain', args, args._requestedBy || 'unknown');
      task.progress = { currentStepIndex: 0, steps: args.steps.map((s) => ({ action: s.action, status: 'pending' })) };
    }

    this.loopRunning = true;
    this.currentLoop = { action: 'chaining' };

    const runStep = async (index) => {
      if (!this.loopRunning) return;
      if (index >= args.steps.length) {
        this.bot.chat('Chain complete - all steps finished.');
        this.taskManager.completeTask('All steps completed');
        this.loopRunning = false;
        this.currentLoop = null;
        return;
      }

      const step = args.steps[index];
      this.bot.chat('Chain step ' + (index + 1) + '/' + args.steps.length + ': ' + step.action + ' ' + JSON.stringify(step.args || {}));

      if (this.taskManager.currentTask) {
        this.taskManager.currentTask.progress.currentStepIndex = index;
        this.taskManager.currentTask.progress.steps[index].status = 'running';
        this.taskManager.saveToDisk();
      }

      try {
        await this.executeCommand(step);
        if (this.taskManager.currentTask) {
          this.taskManager.currentTask.progress.steps[index].status = 'completed';
          this.taskManager.saveToDisk();
        }
        this.bot.chat('Step ' + (index + 1) + ' complete.');
        setImmediate(() => runStep(index + 1));
      } catch (err) {
        const failMsg = 'Step ' + (index + 1) + ' (' + step.action + ') failed: ' + err.message;
        this.bot.chat(failMsg);
        this.taskManager.failTask(failMsg);
        if (this.reflector) this.reflector.observe({ type: 'task-fail', reason: err.message, action: step.action });
        this.loopRunning = false;
        this.currentLoop = null;
      }
    };

    setImmediate(() => runStep(currentStepIndex));
  }

  /* ----- Memory-backed actions ----- */

  _actionRemember(args) {
    if (!args || !args.text) { this.bot.chat('Remember requires text.'); return; }
    if (!this.memory) { this.bot.chat('Memory is not available.'); return; }
    this.memory.learn(String(args.text), ['manual']);
    this.bot.chat('Got it - remembered.');
  }

  async _actionRecall() {
    if (!this.memory) { this.bot.chat('Memory is not available.'); return; }
    const digest = this.reflector ? this.reflector.digest() : JSON.stringify(this.memory.toJSON(3));
    this._say(String(digest).slice(0, 440));
  }

  async _actionWait(args) {
    const seconds = Math.min(Number(args && args.seconds) || 2, 30);
    this.bot.chat('Waiting ' + seconds + 's...');
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }

  async _actionJump() {
    this.bot.setControlState('jump', true);
    await new Promise((r) => setTimeout(r, 300));
    this.bot.setControlState('jump', false);
  }

  async _actionSprint(args) {
    const on = args && args.on !== false;
    this.bot.setControlState('sprint', on);
    this.bot.chat(on ? 'Sprinting.' : 'Walking.');
  }

  async _actionSneak(args) {
    const on = args && args.on !== false;
    this.bot.setControlState('sneak', on);
    this.bot.chat(on ? 'Sneaking.' : 'Standing.');
  }

  _actionGreet() {
    const names = Object.keys(this.bot.players || {}).filter((n) => n !== this.bot.username);
    if (names.length > 0) this.bot.chat('Hey ' + names.slice(0, 2).join(', ') + '! What do we need doing?');
    else this.bot.chat('Anyone out there?');
  }

  /* ----- Loop control ----- */

  cancelCurrentLoop() {
    this._stopRequested = true;
    this.loopRunning = false;
    this.currentLoop = null;
    if (this.nav) this.nav.stop();
    else {
      try { this.bot.pathfinder.setGoal(null); } catch (e) {}
    }
  }
}

module.exports = Brain;
