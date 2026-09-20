const Brain = require('../../src/brain');

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const EE = require('events');
    const child = new EE();
    child.stdout = new EE();
    child.stderr = new EE();
    child.stdin = { write: jest.fn(), end: jest.fn() };
    child.kill = jest.fn();
    child.pid = 12345;
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('{"action":"chat","args":{"message":"Mock"}}'));
      child.emit('close', 0);
    });
    return child;
  }),
}));

const { spawn } = require('child_process');

function makeMockChild(data) {
  const EE = require('events');
  const mc = new EE();
  mc.stdout = new EE(); mc.stderr = new EE();
  mc.stdin = { write: jest.fn(), end: jest.fn() };
  mc.kill = jest.fn(); mc.pid = 12345;
  process.nextTick(() => {
    if (data && mc.stdout && typeof mc.stdout.emit === 'function') {
      mc.stdout.emit('data', Buffer.from(data));
    }
    mc.emit('close', 0);
  });
  return mc;
}

function makeMockNav() {
  return {
    init: jest.fn(),
    goto: jest.fn().mockResolvedValue(true),
    stop: jest.fn(),
    followEntity: jest.fn().mockReturnValue(true),
  };
}

describe('Brain', () => {
  let brain, mockBot, mockConfig, mockNav;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNav = makeMockNav();
    mockBot = {
      username: 'TestBot', chat: jest.fn(),
      health: 20, food: 20,
      entity: { position: { x: 100, y: 64, z: 200 }, offset: jest.fn((dx,dy,dz) => ({x:100+dx,y:64+dy,z:200+dz})) },
      inventory: {
        items: () => [{name:'oak_log',count:10},{name:'dirt',count:32}],
        emptySlotCount: jest.fn(() => 20),
      },
      inventoryManager: {
        findItem: jest.fn(() => ({name:'dirt',type:3,count:32})),
        equipItem: jest.fn().mockResolvedValue(true),
        tossItem: jest.fn().mockResolvedValue(true),
        tossStack: jest.fn().mockResolvedValue(true),
        dropAll: jest.fn().mockResolvedValue(),
      },
      crafting: { craft: jest.fn().mockResolvedValue() },
      players: { Steve: {username:'Steve',entity:{position:{x:120,y:64,z:180}}}, Alex: {username:'Alex',entity:{position:{x:150,y:64,z:220}}} },
      entities: { zombie1: {type:'mob',name:'zombie',displayName:'Zombie',isValid:true,dead:false,position:{x:110,y:64,z:190}} },
      blockAt: () => ({name:'stone'}), findBlock: jest.fn(), dig: jest.fn().mockResolvedValue(),
      lookAt: jest.fn().mockResolvedValue(), equip: jest.fn().mockResolvedValue(),
      toss: jest.fn().mockResolvedValue(), tossStack: jest.fn().mockResolvedValue(),
      craft: jest.fn().mockResolvedValue(), attack: jest.fn(),
      pathfinder: { goto: jest.fn().mockResolvedValue(), setGoal: jest.fn(), setMovements: jest.fn() },
      version: '1.20.1', _client: { on: jest.fn(), once: jest.fn() }, heldItem: null,
    };
    mockConfig = { triggerWords: ['bot','hey bot','!bot'], claudePath: 'claude', debug: false };
    brain = new Brain(mockBot, mockConfig, mockNav);
  });

  afterEach(() => brain.cancelCurrentLoop());

  describe('_fallbackIntent (offline failsafe)', () => {
    it('parses mine requests', () => {
      expect(brain._fallbackIntent('mine oak_log 5', 'Steve')).toEqual({ action: 'mine', args: { block: 'oak_log', count: 5 } });
      expect(brain._fallbackIntent('gather dirt', 'Steve')).toEqual({ action: 'mine', args: { block: 'dirt', count: 1 } });
    });

    it('parses follow/findore/craft/drop', () => {
      expect(brain._fallbackIntent('follow Steve', 'Steve')).toEqual({ action: 'follow', args: { player: 'steve' } });
      expect(brain._fallbackIntent('find iron ore', 'Steve')).toEqual({ action: 'findore', args: { ore: 'iron' } });
      expect(brain._fallbackIntent('craft torch', 'Steve')).toEqual({ action: 'craft', args: { item: 'torch', count: 1 } });
      expect(brain._fallbackIntent('drop dirt 10', 'Steve')).toEqual({ action: 'drop', args: { item: 'dirt', count: 10 } });
    });

    it('parses come with requester name', () => {
      expect(brain._fallbackIntent('come', 'Alex')).toEqual({ action: 'come', args: { player: 'Alex' } });
    });

    it('returns null for unknown input', () => {
      expect(brain._fallbackIntent('do the hokey pokey', 'Steve')).toBeNull();
    });
  });

  describe('plan execution', () => {
    it('executes a multi-step envelope plan sequentially', async () => {
      spawn.mockReturnValue(makeMockChild(JSON.stringify({
        reply: 'On it!',
        plan: [
          { action: 'chat', args: { message: 'step one' } },
          { action: 'chat', args: { message: 'step two' } },
        ],
      })));
      await brain.handleChat('Steve', '!bot do the thing');
      expect(mockBot.chat).toHaveBeenCalledWith('On it!');
      expect(mockBot.chat).toHaveBeenCalledWith('step one');
      expect(mockBot.chat).toHaveBeenCalledWith('step two');
    });

    it('keeps legacy single-action replies', async () => {
      spawn.mockReturnValue(makeMockChild('{"action":"chat","args":{"message":"Just talking."}}'));
      await brain.handleChat('Steve', '!bot hey');
      expect(mockBot.chat).toHaveBeenCalledWith('Just talking.');
    });
  });

  describe('_extractIntent', () => {
    it('extracts intent after trigger word', () => expect(brain._extractIntent('!bot mine oak_log')).toBe('mine oak_log'));
    it('extracts intent with "bot" trigger', () => expect(brain._extractIntent('bot follow Steve')).toBe('follow Steve'));
    it('extracts intent with "hey bot" trigger', () => expect(brain._extractIntent('hey bot status')).toBe('status'));
    it('returns "status" if only trigger word', () => expect(brain._extractIntent('bot')).toBe('status'));
    it('is case insensitive', () => expect(brain._extractIntent('!BOT MINE OAK_LOG')).toBe('MINE OAK_LOG'));
    it('returns null for no trigger', () => expect(brain._extractIntent('hello')).toBeNull());
    it('returns null for empty', () => expect(brain._extractIntent('')).toBeNull());
    it('returns null for non-string', () => { expect(brain._extractIntent(null)).toBeNull(); });
    it('picks first trigger', () => expect(brain._extractIntent('bot !bot test')).toBe('!bot test'));
  });

  describe('_buildBotState', () => {
    it('includes health, food, position', () => {
      const s = brain._buildBotState();
      expect(s.health).toBe(20); expect(s.food).toBe(20);
      expect(s.position).toEqual({x:100,y:64,z:200});
    });
    it('missing entity gracefully', () => {
      brain = new Brain({...mockBot,entity:null,players:{},entities:{},inventory:{items:()=>[]}}, mockConfig, makeMockNav());
      const s = brain._buildBotState();
      expect(s.position).toEqual({x:0,y:0,z:0}); expect(s.inventory).toEqual(['empty']);
    });
    it('includes player names', () => {
      const names = brain._buildBotState().nearbyPlayers.map(p => p.name);
      expect(names).toContain('Steve'); expect(names).toContain('Alex');
    });
  });

  describe('spawnClaudeQuery', () => {
    it('returns parsed command on success', async () => {
      spawn.mockReturnValue(makeMockChild('{"action":"chat","args":{"message":"Hello!"}}'));
      expect(await brain.spawnClaudeQuery('Steve','say hello',brain._buildBotState(),[]))
        .toEqual({action:'chat',args:{message:'Hello!'}});
    });
    it('strips markdown fences', async () => {
      spawn.mockReturnValue(makeMockChild('```json\n{"action":"chat","args":{"message":"Hi"}}\n```'));
      expect(await brain.spawnClaudeQuery('Steve','hi',brain._buildBotState(),[]))
        .toEqual({action:'chat',args:{message:'Hi'}});
    });
    it('falls back on ENOENT', async () => {
      spawn.mockImplementation(() => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; });
      const r = await brain.spawnClaudeQuery('Steve','hi',{},[]);
      expect(r).toEqual({action:'chat',args:{message:'Brain error.'}});
    });
    it('falls back on non-JSON', async () => {
      // A fresh child per attempt: the LLM client retries on invalid JSON,
      // so each retry must get its own (consumable) subprocess mock.
      spawn.mockImplementation(() => makeMockChild('not json'));
      expect(await brain.spawnClaudeQuery('Steve','hi',{},[]))
        .toEqual({action:'chat',args:{message:'Brain error.'}});
    });
  });

  describe('executeCommand', () => {
    it('chat', async () => { await brain.executeCommand({action:'chat',args:{message:'Hi'}}); expect(mockBot.chat).toHaveBeenCalledWith('Hi'); });
    it('move', async () => { await brain.executeCommand({action:'move',args:{x:100,y:64,z:200}}); expect(mockNav.goto).toHaveBeenCalledWith(100, 64, 200, 1); });
    it('stop', async () => { brain.loopRunning = true; await brain.executeCommand({action:'stop',args:{}}); expect(brain.loopRunning).toBe(false); });
    it('status', async () => { await brain.executeCommand({action:'status',args:{}}); expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('HP:')); });
    it('drop with items via inventoryManager', async () => {
      mockBot.inventoryManager.findItem.mockReturnValue({name:'dirt',type:3,count:32});
      await brain.executeCommand({action:'drop',args:{item:'dirt',count:10}});
      expect(mockBot.inventoryManager.tossItem).toHaveBeenCalledWith('dirt', 10);
    });
    it('unknown action', async () => { await brain.executeCommand({action:'fly',args:{}}); expect(mockBot.chat).toHaveBeenCalledWith('Unknown action.'); });
    it('noop for null', async () => { await brain.executeCommand(null); expect(mockBot.chat).not.toHaveBeenCalled(); });
  });

  describe('handleChat', () => {
    it('ignores own', async () => { await brain.handleChat('TestBot','bot status'); expect(mockBot.chat).not.toHaveBeenCalled(); });
    it('ignores no trigger', async () => { await brain.handleChat('Steve','hello'); expect(mockBot.chat).not.toHaveBeenCalled(); });
    it('processes trigger', async () => {
      spawn.mockReturnValue(makeMockChild('{"action":"chat","args":{"message":"Hi"}}'));
      await brain.handleChat('Steve','!bot hello');
      expect(mockBot.chat).toHaveBeenCalledWith('Hi');
    });
  });

  describe('_stripMarkdown', () => {
    it('removes json fences', () => expect(brain._stripMarkdown('```json\n{"x":1}\n```')).toBe('{"x":1}'));
    it('removes plain fences', () => expect(brain._stripMarkdown('```\n{"x":1}\n```')).toBe('{"x":1}'));
    it('returns trimmed', () => expect(brain._stripMarkdown('  {"x":1}  ')).toBe('{"x":1}'));
  });
});
