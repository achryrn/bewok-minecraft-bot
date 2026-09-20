'use strict';
/**
 * chat.js — the bot's UI layer.
 *
 * This is the single place where inbound player messages arrive and where every
 * outbound reply is formatted. It is "the UI" in the sense that matters for a
 * Minecraft bot: how players talk to it, how slash shortcuts work, and how the
 * bot speaks back — natural, readable, first-person, never wall-of-text.
 *
 * Responsibilities:
 *   1. Route input:
 *        - "/cmd ..."  → slash command registry (fast, deterministic shortcuts)
 *        - anything else → the natural-language handler (the Brain), connected
 *          via setNaturalHandler() — so NL conversation is the primary UI.
 *        - whispers  → NL handler in "direct" mode (no trigger word needed).
 *   2. Format output:
 *        - replies are split at readable line lengths (servers drop long lines),
 *        - a welcome/help message is provided on spawn,
 *        - a small render kit for status/inventory/help panels.
 *   3. Stay compatible: register/unregister/handleCommand/say/whisper API and
 *      the 'message'/'whisper' events are preserved for tests and integrators.
 */

const EventEmitter = require('events');

class ChatManager extends EventEmitter {
  constructor(bot, config) {
    super();
    this.bot = bot;
    this.config = config;
    this.commands = new Map();
    this.naturalHandler = null;
    this.naturalFallback = null;
    this.externalHandler = null;
    this._registerDefaultCommands();
    this._registerChatListener();
  }

  /** Attach a richer slash-command handler (e.g. CommandHandler) as the external registry. */
  useExternalCommands(handler) {
    this.externalHandler = handler || null;
  }

  /* ───── Input hooks ───── */

  /** Connect the brain as the natural-language processor. */
  setNaturalHandler(fn) {
    this.naturalHandler = typeof fn === 'function' ? fn : null;
  }

  /** Optional deterministic fallback when no brain is attached. */
  setNaturalFallback(fn) {
    this.naturalFallback = typeof fn === 'function' ? fn : null;
  }

  /**
   * Single entry point for every chat line the bot sees.
   * @param {string} username
   * @param {string} message
   * @param {object} [meta] - { translate, jsonMsg }
   */
  handleInbound(username, message, meta) {
    if (username === this.bot.username) return;
    const translate = meta && meta.translate;
    const jsonMsg = meta && meta.jsonMsg;

    this.emit('message', { username, message, translate, jsonMsg });

    if (this.config.chatCommands && message.startsWith('/')) {
      this.handleCommand(username, message);
      return;
    }

    if (this.naturalHandler) {
      this.naturalHandler(username, message, { direct: false });
    } else if (this.naturalFallback) {
      this.naturalFallback(username, message);
    }
  }

  /** Handle a whisper (private message) — routed as "direct" NL. */
  handleWhisper(username, message) {
    if (username === this.bot.username) return;
    this.emit('whisper', { username, message });
    if (this.naturalHandler) {
      this.naturalHandler(username, message, { direct: true });
    } else if (this.naturalFallback) {
      this.naturalFallback(username, message);
    }
  }

  _registerChatListener() {
    this.bot.on('chat', (username, message, translate, jsonMsg) => {
      this.handleInbound(username, message, { translate, jsonMsg });
    });

    this.bot.on('whisper', (username, message) => {
      this.handleWhisper(username, message);
    });
  }

  /* ───── Slash commands (shortcut UI) ───── */

  _registerDefaultCommands() {
    this.register('help', async (username, args) => {
      const cmds = [...this.commands.keys()].sort().join(', ');
      this.reply('Available commands: ' + cmds + '. For anything else, just talk to me in plain language.');
    });

    this.register('pos', async (username) => {
      const pos = this.bot.entity ? this.bot.entity.position : null;
      if (!pos) { this.reply('I do not know where I am right now.'); return; }
      this.reply('My position: ' + pos.x.toFixed(1) + ', ' + pos.y.toFixed(1) + ', ' + pos.z.toFixed(1));
    });

    this.register('health', async (username) => {
      this.reply('Health: ' + Math.floor(this.bot.health || 20) + ' | Food: ' + Math.floor(this.bot.food || 20));
    });

    this.register('inventory', async (username) => {
      const items = this.bot.inventory.items();
      if (items.length === 0) {
        this.reply('Inventory is empty');
        return;
      }
      const list = items.map((i) => i.name + ' x' + i.count).join(', ');
      this.reply('Inventory: ' + list);
    });
  }

  register(name, handler) {
    this.commands.set(name.toLowerCase(), handler);
  }

  unregister(name) {
    this.commands.delete(name.toLowerCase());
  }

  handleCommand(username, message) {
    // When a richer external command registry is attached (production wiring),
    // all slash commands go through it so there is exactly one command UI.
    if (this.externalHandler && typeof this.externalHandler.handleChat === 'function') {
      this.externalHandler.handleChat(username, message);
      return;
    }

    const parts = message.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    const handler = this.commands.get(cmd);
    if (handler) {
      try {
        const result = handler(username, args);
        if (result && typeof result.then === 'function') {
          result.catch((err) => this.reply('Command failed: ' + err.message));
        }
      } catch (err) {
        this.reply('Command failed: ' + err.message);
      }
    } else {
      this.reply('Unknown command: ' + cmd + '. Use /help for the list.');
    }
  }

  /* ───── Output formatting ───── */

  /**
   * Reply with safe line splitting (a single line can be silently truncated or
   * dropped by some servers). Messages are broken at word boundaries.
   */
  reply(message) {
    if (!message) return;
    const maxLen = 220;
    if (message.length <= maxLen) {
      this.bot.chat(message);
      return;
    }
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

  /** Format a compact status line from a bot-state object. */
  renderStatus(state) {
    if (!state) return 'No state available.';
    const pos = state.position ? state.position.x + ', ' + state.position.y + ', ' + state.position.z : '?, ?, ?';
    const task = state.activeTask ? ' | Task: ' + state.activeTask.type + ' (' + state.activeTask.status + ')' : '';
    return 'HP: ' + state.health + '/' + state.food + ' food | Pos: ' + pos + task;
  }

  /** Format an inventory digest from a bot-state object. */
  renderInventory(state) {
    if (!state || !state.inventory) return 'Inventory: empty';
    return 'Inventory: ' + (Array.isArray(state.inventory) ? state.inventory.join(', ') : String(state.inventory));
  }

  /** Welcome message shown shortly after spawn. */
  sendWelcome(triggerWords) {
    const triggers = (triggerWords && triggerWords.length ? triggerWords : ['bot']).join('", "');
    this.reply('Heya! I am online. Say "' + triggers + '" + your request and I will get it done — or use /help for quick commands.');
  }

  sendHelp() {
    this.handleCommand('', '/help');
  }

  say(message) {
    this.bot.chat(message);
  }

  whisper(username, message) {
    this.bot.whisper(username, message);
  }
}

module.exports = ChatManager;
