'use strict';
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const CommandHandler = require('./commands');
const ChatManager = require('./chat');
const { ConfigManager } = require('./configManager');
const ForgeHandler = require('./forge');
const FabricHandler = require('./fabric');
const Brain = require('./brain');
const NavigationController = require('./navigation');
const AutoEatPlugin = require('./plugins/autoEat');
const FollowPlugin = require('./plugins/follow');
const CombatManager = require('./combat');
const InventoryManager = require('./inventory');
const BlockManager = require('./blocks');
const SurvivalController = require('./survival');
const CraftingManager = require('./crafting');
const BotBridgeChannel = require('./botbridge');
const { detectServerVersion, resolveBotVersion } = require('./versioning');

class BotManager {
  constructor(config) {
    this.config = config;
    this.bot = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.forgeHandler = null;
    this.fabricHandler = null;
    this.brain = null;
    this.commandHandler = null;
    this.ui = null;
    this.configManager = new ConfigManager();
    this.nav = null;
    this.combat = null;
    this.inventory = null;
    this.blocks = null;
    this.survival = null;
    this.crafting = null;
    this.botbridge = null;
    this._serverModeLogged = false;
    this._detectedMode = null;
    this._detectedVersion = null;
    this._versionInfo = null;
    this._welcomed = false;
  }

  async start() {
    this.stopping = false;
    this._welcomed = false;
    this._logBot('Starting - host: ' + this.config.host + ':' + this.config.port + '  username: ' + this.config.username);

    // Flexible version hopping: ping the server and connect with ITS version.
    if (this.config.versionAutoDetect === true) {
      this._logBot('Detecting server version (ping)...');
      const detection = await detectServerVersion(this.config.host, this.config.port, 6000);
      const resolved = resolveBotVersion(this.config, detection);
      this._versionInfo = detection;
      this._detectedVersion = resolved.version;
      this._logBot(
        'Version resolution: ' + resolved.source + ' -> ' + String(resolved.version) +
        (detection.rawVersion ? '  (server reports: "' + detection.rawVersion + '")' : '') +
        (detection.error ? '  [ping ' + detection.error + ']' : '')
      );
    } else {
      this._detectedVersion = this.config.version || false;
    }

    await this._createBot();
  }

  async _createBot() {
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password || undefined,
      auth: this.config.auth || 'offline',
      version: this._detectedVersion !== null && this._detectedVersion !== undefined ? this._detectedVersion : false,
      viewDistance: this.config.viewDistance,
      logErrors: this.config.debug,
      hideErrors: true,
    };

    this.bot = mineflayer.createBot(botOptions);

    if (this.config.debug) {
      this.bot._client.on('window_items', (packet) => {
        console.log('[debug] window_items packet:', JSON.stringify(packet));
      });
      this.bot._client.on('set_slot', (packet) => {
        console.log('[debug] set_slot packet:', JSON.stringify(packet));
      });
    }

    const _seenPacketTypes = new Set();
    this.bot._client.on('packet', (data, meta) => {
      if (!_seenPacketTypes.has(meta.name)) {
        _seenPacketTypes.add(meta.name);
        if (this.config.debug) console.log('[debug] first-seen packet type:', meta.name);
      }
    });

    this.bot.loadPlugin(pathfinder);

    // Wire navigation controller
    this.nav = new NavigationController(this.bot, this.config.navigation || {});

    // Initialize managers
    this.combat = new CombatManager(this.bot);
    this.inventory = new InventoryManager(this.bot);
    this.blocks = new BlockManager(this.bot);
    this.survival = new SurvivalController(this.bot, this.config, this.combat, this.nav);
    this.crafting = new CraftingManager(this.bot);

    // Expose managers and aliases on bot for brain/commands access
    this.bot.nav = this.nav;
    this.bot.navigationController = this.nav;
    this.bot.combat = this.combat;
    this.bot.blocks = this.blocks;
    this.bot.inventoryManager = this.inventory;
    this.bot.crafting = this.crafting;
    this.bot.survival = this.survival;

    this.commandHandler = new CommandHandler(this.bot, this.config, this.configManager);
    this.bot.autoEat = new AutoEatPlugin(this.bot, this.config);
    this.bot.follower = new FollowPlugin(this.bot);
    this.forgeHandler = new ForgeHandler(this.bot, this.config);
    this.fabricHandler = new FabricHandler(this.bot, this.config);
    this.brain = new Brain(this.bot, this.config, this.nav);
    this.bot._brain = this.brain;
    this.bot._forgeHandler = this.forgeHandler;
    this.bot._fabricHandler = this.fabricHandler;

    // Wire BotBridge channel (handles custom packets from server-side mod)
    this.botbridge = new BotBridgeChannel(this.bot);
    this.bot.botbridge = this.botbridge;

    // -- UI layer: single interface for chat in/out ------------------------
    this.ui = new ChatManager(this.bot, this.config);
    this.ui.useExternalCommands(this.commandHandler);
    this.ui.setNaturalHandler((username, message, opts) => {
      // Route plain-language chat to the brain. Only direct whispers pass the
      // "direct" flag so normal chat still needs the configured trigger words.
      if (!this.brain) return;
      if (opts && opts.direct) {
        this.brain.handleChat(username, message, { direct: true });
      } else {
        this.brain.handleChat(username, message);
      }
    });
    this.bot.ui = this.ui;

    this._registerEvents();

    if (this.bot._client) {
      this.forgeHandler.setup();
      this.fabricHandler.setup();
    }
  }

  _registerEvents() {
    this.bot.once('login', () => {
      this._logBot('Connecting...');
      this._welcomed = false;
    });

    this.bot.on('spawn', () => {
      this.reconnectAttempts = 0;

      // Init navigation on every spawn
      this.nav.init();

      if (this.bot.entity && this.bot.entity.position) {
        const pos = this.bot.entity.position;
        this._logBot('Spawned at x=' + Math.floor(pos.x) + ' y=' + Math.floor(pos.y) + ' z=' + Math.floor(pos.z));
      } else {
        this._logBot('Spawned (position unknown)');
      }

      if (this._serverModeLogged) {
        // still welcome if not yet welcomed this connection
        if (!this._welcomed && this.ui && this.config.ui && this.config.ui.welcome !== false) {
          this._welcomed = true;
          this.ui.sendWelcome(this.config.triggerWords);
        }
        if (this.brain) this.brain.onSpawn();
        if (this.survival) this.survival.start();
        return;
      }
      this._serverModeLogged = true;

      if (this.forgeHandler && this.forgeHandler.handshakeComplete) {
        // forge mode
      } else if (this.fabricHandler && this.fabricHandler._setup) {
        // fabric - detected via brand packet later
      } else {
        this._vanillaTimeout = setTimeout(() => {
          if (!this._serverModeLogged) return;
          this._logBot('No Forge or Fabric channel detected - vanilla mode');
          this._detectedMode = 'vanilla';
          this.bot.emit('serverMode', 'vanilla');
        }, 5000);
      }

      const words = this.config.triggerWords || ['bot', 'hey bot', '!bot'];
      this._logBrain('Ready - trigger words: ' + words.join(', '));

      if (!this._welcomed && this.ui && this.config.ui && this.config.ui.welcome !== false) {
        this._welcomed = true;
        this.ui.sendWelcome(words);
      }

      if (this.brain) this.brain.onSpawn();

      // Start survival monitoring on each spawn
      if (this.survival) this.survival.start();
    });

    this.bot.on('death', () => {
      if (this.brain) this.brain.onDeath();
      if (this.survival) this.survival.stop();
    });

    this.bot.on('kicked', (reason) => {
      console.warn('[warn] Kicked: ' + reason);
      this._handleDisconnect();
    });

    this.bot.on('error', (err) => {
      if (err.message && err.message.includes('Parse error for play.')) {
        if (this.config.debug) console.log('[bot] Suppressed packet parse error');
        return;
      }
      if (err.message !== 'Connection closed' || this.config.debug) {
        console.warn('[warn] Connection error: ' + err.message);
      }
      this._handleDisconnect();
    });

    this.bot.on('end', () => {
      if (!this.stopping) this._handleDisconnect();
    });

    // Chat arrives via the UI layer (src/chat.js)
    this.bot.on('health', () => {
      if (this.bot.autoEat && this.bot.autoEat.onHealth) this.bot.autoEat.onHealth();
      if (this.brain && this.brain.onHealth) this.brain.onHealth();
    });

    if (this.forgeHandler) {
      this.forgeHandler.on('complete', () => {
        this._detectedMode = 'forge';
        if (this._vanillaTimeout) clearTimeout(this._vanillaTimeout);
      });
    }

    if (this.fabricHandler) {
      this.fabricHandler.on('detected', () => {
        this._detectedMode = 'fabric';
        if (this._vanillaTimeout) clearTimeout(this._vanillaTimeout);
      });
    }

    if (this.forgeHandler) {
      this.forgeHandler.on('permanentFailure', () => {
        this.stopping = true;
        if (this.bot) this.bot.end();
      });
    }
  }

  _handleDisconnect() {
    if (this.stopping) return;
    if (!this.config.reconnect) { console.error('[error] Reconnect disabled - exiting'); return; }
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[error] Max reconnect attempts reached (' + this.reconnectAttempts + '/' + this.config.maxReconnectAttempts + ') - giving up');
      console.error('[error] Run node index.js to restart');
      return;
    }

    // Fully kill the old bot before reconnecting to prevent duplicate login
    const oldBot = this.bot;
    if (oldBot) {
      try { oldBot.removeAllListeners(); } catch (_) {}
      try { oldBot.end(); } catch (_) {}
      this.bot = null;
    }
    this.nav = null;
    this.brain = null;
    this.ui = null;
    this.forgeHandler = null;
    this.fabricHandler = null;
    this.combat = this.inventory = this.blocks = this.survival = this.crafting = this.botbridge = null;

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.warn('[warn] Reconnecting in ' + delay + 'ms (attempt ' + this.reconnectAttempts + '/' + this.config.maxReconnectAttempts + ')');
    this._logBot('Connecting...');
    this._serverModeLogged = false;
    setTimeout(() => this._createBot(), delay);
  }

  async stop() {
    this.stopping = true;
    if (this.bot) { this.bot.end(); this.bot = null; }
  }

  _logBot(msg) { console.log('[bot] ' + msg); }
  _logBrain(msg) { console.log('[brain] ' + msg); }
}

module.exports = BotManager;
