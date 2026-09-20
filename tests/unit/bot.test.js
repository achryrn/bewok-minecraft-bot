const BotManager = require('../../src/bot');

jest.mock('mineflayer');
jest.mock('mineflayer-pathfinder');

// Mock the modules that BotManager wires
jest.mock('../../src/forge', () => {
  return jest.fn().mockImplementation(() => ({
    setup: jest.fn(),
    on: jest.fn(),
    waitForHandshake: jest.fn().mockResolvedValue(true),
  }));
});

jest.mock('../../src/navigation', () => {
  return jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    goto: jest.fn().mockResolvedValue(true),
    stop: jest.fn(),
    followEntity: jest.fn(),
  }));
});

jest.mock('../../src/brain', () => {
  return jest.fn().mockImplementation(() => ({
    handleChat: jest.fn(),
    cancelCurrentLoop: jest.fn(),
    onSpawn: jest.fn(),
    onDeath: jest.fn(),
  }));
});

jest.mock('../../src/combat', () => {
  return jest.fn().mockImplementation(() => ({
    attackEntity: jest.fn(),
    kill: jest.fn(),
    stop: jest.fn(),
    equipBestWeapon: jest.fn(),
    nearestHostileMob: jest.fn(),
    nearbyHostileMobs: jest.fn(),
    setAutoAttack: jest.fn(),
    onEntityDamaged: jest.fn(),
  }));
});

jest.mock('../../src/inventory', () => {
  return jest.fn().mockImplementation(() => ({
    items: jest.fn(),
    count: jest.fn(),
    hasItems: jest.fn(),
    findItem: jest.fn(),
    equipItem: jest.fn(),
    tossItem: jest.fn(),
    tossStack: jest.fn(),
    dropAll: jest.fn(),
    equipSword: jest.fn(),
    equipPickaxe: jest.fn(),
    equipToolForBlock: jest.fn(),
    getEmptySlotsCount: jest.fn(),
    isInventoryFull: jest.fn(),
  }));
});

jest.mock('../../src/blocks', () => {
  return jest.fn().mockImplementation(() => ({
    findBlock: jest.fn(),
    findBlocks: jest.fn(),
    blockAt: jest.fn(),
    digBlock: jest.fn(),
    digBlockAt: jest.fn(),
    placeBlock: jest.fn(),
    placeBlockAt: jest.fn(),
    equipAndDig: jest.fn(),
    isBlockAt: jest.fn(),
    getSurroundingBlocks: jest.fn(),
  }));
});

jest.mock('../../src/survival', () => {
  return jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    on: jest.fn(),
    getNearbyHostiles: jest.fn(),
    isFleeing: jest.fn(),
    checkPathSafety: jest.fn(),
  }));
});

jest.mock('../../src/crafting', () => {
  return jest.fn().mockImplementation(() => ({
    getRecipesFor: jest.fn(),
    getRecipe: jest.fn(),
    canCraft: jest.fn(),
    craft: jest.fn(),
    craftWithTable: jest.fn(),
    getCraftableItems: jest.fn(),
    getRequiredItems: jest.fn(),
  }));
});

jest.mock('../../src/plugins/autoEat', () => {
  return jest.fn().mockImplementation(() => ({
    onHealth: jest.fn(),
  }));
});

jest.mock('../../src/plugins/follow', () => {
  return jest.fn().mockImplementation(() => ({
    setTarget: jest.fn(),
    stop: jest.fn(),
  }));
});

jest.mock('../../src/configManager', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    list: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    save: jest.fn(),
    reset: jest.fn(),
  })),
}));

const mineflayer = require('mineflayer');
const ForgeHandler = require('../../src/forge');
const Brain = require('../../src/brain');

describe('BotManager', () => {
  let manager;
  const mockConfig = {
    host: 'localhost',
    port: 25565,
    username: 'TestBot',
    password: '',
    version: false,
    reconnect: false,
    reconnectDelay: 5000,
    maxReconnectAttempts: 3,
    chatCommands: true,
    autoEat: true,
    autoEatThreshold: 14,
    followDistance: 2,
    viewDistance: 'normal',
    forgeHandshake: true,
    debug: false,
  };

  let mockBotInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    mockBotInstance = {
      loadPlugin: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      end: jest.fn(),
      entity: { position: { x: 0, y: 64, z: 0 } },
      username: 'TestBot',
      food: 20,
      inventory: { items: jest.fn(() => []) },
      version: '1.20.1',
      pathfinder: { setMovements: jest.fn(), setGoal: jest.fn(), goto: jest.fn() },
      _client: {
        on: jest.fn(),
      },
      players: {},
      entities: {},
      chat: jest.fn(),
      blockAt: jest.fn(),
      findBlock: jest.fn(),
      dig: jest.fn(),
      lookAt: jest.fn(),
      equip: jest.fn(),
      toss: jest.fn(),
      craft: jest.fn(),
      attack: jest.fn(),
    };

    mineflayer.createBot.mockReturnValue(mockBotInstance);

    manager = new BotManager(mockConfig);
  });

  describe('start', () => {
    it('creates a bot with correct config', async () => {
      await manager.start();
      expect(mineflayer.createBot).toHaveBeenCalledWith({
        host: 'localhost',
        port: 25565,
        username: 'TestBot',
        password: undefined,
        auth: 'offline',
        version: false,
        viewDistance: 'normal',
        logErrors: false,
        hideErrors: true,
      });
    });

    it('loads pathfinder plugin', async () => {
      await manager.start();
      expect(mockBotInstance.loadPlugin).toHaveBeenCalled();
    });

    it('creates ForgeHandler when forgeHandshake is enabled', async () => {
      await manager.start();
      expect(ForgeHandler).toHaveBeenCalledWith(mockBotInstance, mockConfig);
      expect(manager.forgeHandler).toBeDefined();
      // setup() should be called since _client exists synchronously
      expect(manager.forgeHandler.setup).toHaveBeenCalled();
    });

    it('creates Brain instance', async () => {
      await manager.start();
      expect(Brain).toHaveBeenCalledWith(mockBotInstance, mockConfig, expect.anything());
      expect(manager.brain).toBeDefined();
    });

    it('creates CombatManager', async () => {
      await manager.start();
      expect(manager.combat).toBeDefined();
    });

    it('creates InventoryManager', async () => {
      await manager.start();
      expect(manager.inventory).toBeDefined();
    });

    it('creates BlockManager', async () => {
      await manager.start();
      expect(manager.blocks).toBeDefined();
    });

    it('creates SurvivalController', async () => {
      await manager.start();
      expect(manager.survival).toBeDefined();
    });

    it('creates CraftingManager', async () => {
      await manager.start();
      expect(manager.crafting).toBeDefined();
    });

    it('sets nav and managers on bot instance', async () => {
      await manager.start();
      expect(mockBotInstance.nav).toBeDefined();
      expect(mockBotInstance.combat).toBeDefined();
      expect(mockBotInstance.inventoryManager).toBeDefined();
      expect(mockBotInstance.blocks).toBeDefined();
      expect(mockBotInstance.survival).toBeDefined();
      expect(mockBotInstance.crafting).toBeDefined();
    });

    it('registers event handlers', async () => {
      await manager.start();
      expect(mockBotInstance.on).toHaveBeenCalledWith('spawn', expect.any(Function));
      expect(mockBotInstance.on).toHaveBeenCalledWith('kicked', expect.any(Function));
      expect(mockBotInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockBotInstance.on).toHaveBeenCalledWith('end', expect.any(Function));
      expect(mockBotInstance.on).toHaveBeenCalledWith('chat', expect.any(Function));
      expect(mockBotInstance.on).toHaveBeenCalledWith('health', expect.any(Function));
    });
  });

  describe('stop', () => {
    it('ends the bot and sets stopping flag', async () => {
      await manager.start();
      await manager.stop();
      expect(manager.stopping).toBe(true);
      expect(mockBotInstance.end).toHaveBeenCalled();
      expect(manager.bot).toBeNull();
    });
  });

  describe('chat event routing', () => {
    it('routes through both CommandHandler and Brain', async () => {
      await manager.start();

      // Grab the chat callback
      const chatCallback = mockBotInstance.on.mock.calls.find(
        call => call[0] === 'chat'
      )[1];

      // Simulate a chat message
      chatCallback('Steve', 'bot status');

      // Brain.handleChat should have been called
      expect(manager.brain.handleChat).toHaveBeenCalledWith('Steve', 'bot status');
    });

    it('skips brain for own messages (filtered by bot.js guard)', async () => {
      await manager.start();

      const chatCallback = mockBotInstance.on.mock.calls.find(
        call => call[0] === 'chat'
      )[1];

      chatCallback('TestBot', 'bot status');

      // bot.js has a guard: if (username === this.bot.username) return;
      // so brain.handleChat is never reached for own messages
      expect(manager.brain.handleChat).not.toHaveBeenCalled();
    });
  });
});

