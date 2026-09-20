const CommandHandler = require('../../src/commands');

describe('CommandHandler', () => {
  let handler;
  let mockBot;
  let chatMessages;

  beforeEach(() => {
    chatMessages = [];
    mockBot = {
      username: 'Bot',
      chat: jest.fn(msg => chatMessages.push(msg)),
      players: {
        Player1: {
          entity: { position: { offset: () => ({ x: 0, y: 0, z: 0 }) } },
          equipment: { head: { name: 'diamond_helmet' } },
        },
        UnknownPlayer: {},
      },
      inventory: {
        items: jest.fn(() => [
          { name: 'dirt', count: 32 },
          { name: 'apple', count: 5 },
        ]),
      },
      pathfinder: { setGoal: jest.fn() },
      follower: { setTarget: jest.fn(), stop: jest.fn() },
    };
    const mockConfigManager = { set: jest.fn(), get: jest.fn(), list: jest.fn(() => []) };
    handler = new CommandHandler(mockBot, { chatCommands: true }, mockConfigManager);
  });

  describe('handleChat', () => {
    it('ignores messages without leading slash', () => {
      handler.handleChat('Player1', 'hello');
      expect(chatMessages).toHaveLength(0);
    });

    it('ignores own messages', () => {
      handler.handleChat('Bot', '/help');
      expect(chatMessages).toHaveLength(0);
    });

    it('responds to /help', () => {
      handler.handleChat('Player1', '/help');
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0]).toMatch(/^Commands:/);
    });

    it('responds to /inventory', () => {
      handler.handleChat('Player1', '/inventory');
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0]).toContain('dirt');
      expect(chatMessages[0]).toContain('apple');
    });

    it('responds to /inventory when empty', () => {
      mockBot.inventory.items.mockReturnValue([]);
      handler.handleChat('Player1', '/inventory');
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0]).toMatch(/empty/i);
    });

    it('responds to /stop', () => {
      handler.handleChat('Player1', '/stop');
      expect(chatMessages).toContain('Stopped');
    });

    it('responds to /look', () => {
      mockBot.lookAt = jest.fn();
      handler.handleChat('Player1', '/look');
      expect(mockBot.lookAt).toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('registers a custom command', () => {
      const fn = jest.fn();
      handler.register('testcmd', fn);
      handler.handleChat('Player1', '/testcmd arg1 arg2');
      expect(fn).toHaveBeenCalledWith('Player1', ['arg1', 'arg2']);
    });

    it('is case insensitive', () => {
      const fn = jest.fn();
      handler.register('TestCmd', fn);
      handler.handleChat('Player1', '/testcmd');
      expect(fn).toHaveBeenCalled();
    });
  });
});

