'use strict';
/**
 * commands.js - slash-command UI (fast, deterministic shortcuts).
 *
 * Plain-language chat is the primary interface (routed to the Brain via
 * ChatManager); these "/" commands are the power-user shortcuts on top of it.
 * This refactor adds: grouped help, aliases, per-command usage, friendlier
 * errors, and a few new commands (memory / about / clear).
 */

const COMMAND_GROUPS = {
  'Movement & actions': ['follow', 'come', 'goto', 'look', 'stop', 'mine', 'attack', 'build', 'explore'],
  'Items & self': ['inventory', 'equipment', 'status', 'health', 'pos', 'cycle'],
  'Knowledge & config': ['help', 'config', 'handshake', 'memory', 'about'],
};

const ALIASES = {
  p: 'pos', pos: 'pos',
  hp: 'health', health: 'health',
  inv: 'inventory', inventory: 'inventory',
  eq: 'equipment', equipment: 'equipment',
  st: 'status', status: 'status',
  s: 'status',
  h: 'help', '?': 'help',
  stop: 'stop', halt: 'stop',
  mem: 'memory', memory: 'memory',
  gotom: 'goto', goto: 'goto',
  cm: 'come', come: 'come',
};

class CommandHandler {
  constructor(bot, config, configManager) {
    this.bot = bot;
    this.config = config;
    this.configManager = configManager;
    this.commands = new Map();
    this.usages = new Map();
    this._registerDefaultCommands();
  }

  _yawToDirection(yaw) {
    if (yaw === undefined || yaw === null) return '?';
    const degrees = ((yaw * 180 / Math.PI) % 360 + 360) % 360;
    if (degrees >= 315 || degrees < 45) return 'south';
    if (degrees >= 45 && degrees < 135) return 'west';
    if (degrees >= 135 && degrees < 225) return 'north';
    return 'east';
  }

  _reply(message) {
    if (!message) return;
    const maxLen = 220;
    if (message.length <= maxLen) { this.bot.chat(message); return; }
    const words = String(message).split(' ');
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).length > maxLen) {
        this.bot.chat(line.trim());
        line = w;
      } else {
        line = line ? line + ' ' + w : w;
      }
    }
    if (line.trim()) this.bot.chat(line.trim());
  }

  _registerDefaultCommands() {
    /* -- Movement & actions -- */

    this.register('follow', (sender, args) => {
      const target = args.join(' ');
      const player = this.bot.players[target];
      if (!player || !player.entity) { this.bot.chat("Can't find player " + target); return; }
      if (this.bot.follower) {
        this.bot.follower.setTarget(player.entity);
        this.bot.chat('Following ' + target);
      } else {
        this.bot.chat('Follower plugin not loaded.');
      }
    }, 'follow <player>');

    this.register('stop', (sender, args) => {
      if (this.bot.follower) this.bot.follower.stop();
      if (this.bot._brain && this.bot._brain._actionStop) this.bot._brain._actionStop();
      this.bot.chat('Stopped');
    }, 'stop');

    this.register('come', (sender, args) => {
      const player = this.bot.players[sender];
      if (player && player.entity && this.bot.follower) {
        this.bot.follower.setTarget(player.entity);
        this.bot.chat('Coming to you');
      } else {
        this.bot.chat("Can't see you");
      }
    }, 'come');

    this.register('goto', (sender, args) => {
      if (args.length < 3) { this._reply('Usage: /goto <x> <y> <z>'); return; }
      const x = parseFloat(args[0]);
      const y = parseFloat(args[1]);
      const z = parseFloat(args[2]);
      if (isNaN(x) || isNaN(y) || isNaN(z)) { this.bot.chat('Coordinates must be numbers'); return; }
      if (this.bot._brain && this.bot._brain._actionMove) {
        this.bot._brain._actionMove({ x, y, z, announce: true });
      } else if (this.bot.nav && typeof this.bot.nav.goto === 'function') {
        this.bot.nav.goto(x, y, z).then((reached) => {
          this.bot.chat(reached ? 'Reached ' + Math.floor(x) + ', ' + Math.floor(y) + ', ' + Math.floor(z) : 'Could not reach destination');
        });
      } else {
        this.bot.chat('Navigation not available');
      }
    }, 'goto <x> <y> <z>');

    this.register('look', (sender, args) => {
      const player = this.bot.players[sender];
      if (player && player.entity) {
        this.bot.lookAt(player.entity.position.offset(0, 1.6, 0));
      }
    }, 'look');

    this.register('mine', (sender, args) => {
      if (args.length === 0) { this._reply('Usage: /mine <block> [count]'); return; }
      const blockName = args[0].toLowerCase();
      const count = args.length > 1 ? parseInt(args[1], 10) : 1;
      if (isNaN(count) || count < 1) { this.bot.chat('Count must be a positive number'); return; }
      if (this.bot._brain && this.bot._brain._actionMine) {
        this.bot._brain._actionMine({ block: blockName, count });
      } else {
        this.bot.chat('Brain not available for mining');
      }
    }, 'mine <block> [count]');

    this.register('attack', (sender, args) => {
      if (args.length === 0) { this._reply('Usage: /attack <target>'); return; }
      if (this.bot._brain && this.bot._brain._actionAttack) {
        this.bot._brain._actionAttack({ target: args.join(' ') });
      } else {
        this.bot.chat('Brain not available for attacking');
      }
    }, 'attack <target>');

    this.register('build', (sender, args) => {
      if (args.length < 3) { this._reply('Usage: /build <shape> <material> <width> [length] [height]'); return; }
      const shape = args[0].toLowerCase();
      const material = args[1].toLowerCase();
      const width = parseInt(args[2], 10);
      const length = args.length > 3 ? parseInt(args[3], 10) : width;
      const height = args.length > 4 ? parseInt(args[4], 10) : 1;

      if (isNaN(width) || width < 1) { this.bot.chat('Width must be a positive number'); return; }
      if (isNaN(length) || length < 1) { this.bot.chat('Length must be a positive number'); return; }
      if (isNaN(height) || height < 1) { this.bot.chat('Height must be a positive number'); return; }

      if (this.bot._brain && this.bot._brain._actionBuild) {
        this.bot._brain._actionBuild({ shape, material, width, length, height });
      } else {
        this.bot.chat('Brain not available for building');
      }
    }, 'build <shape> <material> <width> [length] [height]');

    /* -- Items & self -- */

    this.register('inventory', (sender, args) => {
      const items = this.bot.inventory.items();
      if (items.length === 0) { this.bot.chat('Inventory is empty'); return; }
      const chunks = [];
      let line = 'Inventory: ';
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].name + ' x' + items[i].count;
        if (i > 0 && i % 8 === 0) { chunks.push(line.replace(/, $/, '')); line = ''; }
        line += entry + ', ';
      }
      chunks.push(line.replace(/, $/, ''));

      if (this.bot.heldItem) chunks.push('Held: ' + this.bot.heldItem.name);

      const armorParts = [];
      if (this.bot.inventory.slots) {
        const armorSlots = [5, 6, 7, 8];
        const labels = ['Head', 'Torso', 'Legs', 'Feet'];
        for (let i = 0; i < armorSlots.length; i++) {
          const slot = this.bot.inventory.slots[armorSlots[i]];
          if (slot) armorParts.push(labels[i] + ': ' + slot.name);
        }
        const offhand = this.bot.inventory.slots[45];
        if (offhand) armorParts.push('Offhand: ' + offhand.name);
      }
      if (armorParts.length > 0) chunks.push(armorParts.join(' | '));

      for (const c of chunks) this.bot.chat(c);
    }, 'inventory');

    this.register('equipment', (sender, args) => {
      const player = this.bot.players[sender];
      if (player && player.entity && player.entity.equipment) {
        const eq = player.entity.equipment;
        const desc = Object.entries(eq)
          .filter(([k, v]) => v)
          .map(([k, v]) => k + ': ' + v.name)
          .join(', ');
        this.bot.chat(desc ? 'Equipment: ' + desc : 'No equipment');
      }
    }, 'equipment');

    this.register('status', (sender, args) => {
      const pos = this.bot.entity ? this.bot.entity.position : { x: '?', y: '?', z: '?' };
      const dim = this.bot.game && this.bot.game.dimension ? this.bot.game.dimension : '?';
      const yaw = this.bot.entity ? this.bot.entity.yaw : null;
      const facing = this._yawToDirection(yaw);
      const taskInfo = this.bot._brain && this.bot._brain.taskManager && this.bot._brain.taskManager.currentTask
        ? ' | Task: ' + this.bot._brain.taskManager.currentTask.type + ' (' + this.bot._brain.taskManager.currentTask.status + ')'
        : '';
      this.bot.chat(
        'HP: ' + Math.floor(this.bot.health || 20) + '/' + Math.floor(this.bot.food || 20) + ' food | ' +
        'Pos: ' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ', ' + Math.floor(pos.z) + ' | ' +
        'Dim: ' + dim + ' | Facing: ' + facing + taskInfo
      );
    }, 'status');

    this.register('cycle', (sender, args) => {
      if (this.bot._brain && this.bot._brain._actionCycle) this.bot._brain._actionCycle();
      else this.bot.chat('Brain not available for cycling');
    }, 'cycle');

    /* -- Knowledge & config -- */

    this.register('help', (sender, args) => {
      const target = (args[0] || '').toLowerCase();
      if (target && this.commands.has(target)) {
        const use = this.usages.get(target) || target;
        this._reply('/' + target + (use !== target ? ' - ' + use : ''));
        return;
      }
      if (target && ALIASES[target]) {
        const canonical = ALIASES[target];
        const use = this.usages.get(canonical) || canonical;
        this._reply('/' + target + ' is an alias for /' + canonical + (use !== canonical ? ' - ' + use : ''));
        return;
      }
      // Single-line command list (servers drop long messages; keep it short).
      const cmds = [...this.commands.keys()].sort().join(', ');
      this.bot.chat('Commands: ' + cmds);
    }, 'help [command]');

    this.register('memory', (sender, args) => {
      const brain = this.bot._brain;
      if (!brain || !brain.memory) { this.bot.chat('Memory not available.'); return; }
      const digest = brain.reflector ? brain.reflector.digest() : JSON.stringify(brain.memory.toJSON(2));
      this._reply('Memory: ' + String(digest).slice(0, 400));
    }, 'memory');

    this.register('about', (sender, args) => {
      this.bot.chat('I am a self-improving Minecraft bot - ask me anything in plain language. (/help for shortcuts)');
    }, 'about');

    this.register('config', (sender, args) => {
      if (args.length === 0) {
        this.bot.chat('Usage: /config list | /config get <key> | /config set <key> <value> | /config save | /config reset');
        return;
      }
      const subcmd = args[0].toLowerCase();
      switch (subcmd) {
        case 'list': {
          const items = this.configManager.list(this.config);
          const chunks = [];
          let chunk = 'Config: ';
          for (const item of items) {
            const entry = item.key + '=' + item.value;
            if (chunk.length + entry.length + 2 > 250) { chunks.push(chunk); chunk = 'Config: '; }
            chunk += entry + ', ';
          }
          chunks.push(chunk.replace(/, $/, ''));
          for (const c of chunks) this.bot.chat(c);
          break;
        }
        case 'get': {
          if (args.length < 2) { this.bot.chat('Usage: /config get <key>'); return; }
          const key = args[1].toLowerCase();
          const val = this.configManager.get(key, this.config);
          if (val === undefined) { this.bot.chat('Unknown key: ' + key); }
          else { const v = Array.isArray(val) ? val.join(', ') : String(val); this.bot.chat(key + ' = ' + v); }
          break;
        }
        case 'set': {
          if (args.length < 3) { this.bot.chat('Usage: /config set <key> <value>'); return; }
          const key = args[1].toLowerCase();
          const valueStr = args.slice(2).join(' ');
          const result = this.configManager.set(key, valueStr);
          this.bot.chat(result.message);
          break;
        }
        case 'save': {
          const result = this.configManager.save(this.config);
          this.bot.chat(result.message);
          break;
        }
        case 'reset': {
          this.configManager.reset();
          this.bot.chat('Runtime overrides reset - using file config values');
          break;
        }
        default:
          this.bot.chat('Usage: /config list | /config get <key> | /config set <key> <value> | /config save | /config reset');
      }
    }, 'config <list|get|set|save|reset>');

    this.register('handshake', (sender, args) => {
      if (this.bot._forgeHandler && typeof this.bot._forgeHandler.getStatus === 'function') {
        const status = this.bot._forgeHandler.getStatus();
        const parts = [];
        parts.push('Mode: ' + status.mode);
        parts.push('Mod count: ' + status.modCount);
        parts.push('Handshake: ' + status.lastHandshakeResult);
        if (status.failCount > 0) parts.push('Failures: ' + status.failCount);
        this.bot.chat(parts.join(' | '));
      } else if (this.bot._fabricHandler) {
        this.bot.chat('Fabric detected - no handshake needed');
      } else {
        this.bot.chat('Vanilla mode - no Forge or Fabric detected');
      }
    }, 'handshake');
  }

  /**
   * Register a command with optional usage text.
   * @param {string} name
   * @param {(sender: string, args: string[]) => void} handler
   * @param {string} [usage]
   */
  register(name, handler, usage) {
    this.commands.set(name.toLowerCase(), handler);
    if (usage) this.usages.set(name.toLowerCase(), usage);
  }

  /** Resolve alias -> canonical command name. */
  resolve(name) {
    const lower = name.toLowerCase();
    if (this.commands.has(lower)) return lower;
    return ALIASES[lower] ? lower : null; // aliases point at existing names or self
  }

  handleChat(username, message) {
    if (!this.config.chatCommands) return;
    if (!message.startsWith('/')) return;
    if (username === this.bot.username) return;

    const [rawCmd, ...args] = message.slice(1).split(' ');
    const cmd = rawCmd.toLowerCase();
    // Alias resolution: aliases that match a real command name are passed
    // through; user-facing aliases (like "inv") are mapped here.
    const canonical = ALIASES[cmd] && this.commands.has(ALIASES[cmd]) ? ALIASES[cmd] : cmd;
    console.log('[cmd] ' + username + ': /' + canonical + ' ' + args.join(' '));
    const handler = this.commands.get(canonical);
    if (handler) {
      try {
        handler(username, args);
      } catch (err) {
        this.bot.chat('Error executing /' + canonical + ': ' + err.message);
      }
    } else {
      this.bot.chat('Unknown command. Type /help for available commands.');
    }
  }
}

module.exports = CommandHandler;
