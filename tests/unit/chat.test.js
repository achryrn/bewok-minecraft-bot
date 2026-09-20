const ChatManager = require('../../src/chat');

describe('ChatManager', () => {
  let chat;
  let mockBot;
  let config;
  let chatCallbacks;

  beforeEach(() => {
    jest.clearAllMocks();
    chatCallbacks = {};
    mockBot = {
      username: 'TestBot',
      chat: jest.fn(),
      whisper: jest.fn(),
      on: jest.fn((event, cb) => {
        chatCallbacks[event] = cb;
      }),
      entity: {
        position: { x: 100, y: 64, z: 100, toFixed: n => n },
      },
      health: 20,
      food: 20,
      inventory: {
        items: jest.fn(() => [
          { name: 'dirt', count: 32 },
        ]),
      },
    };
    config = { chatCommands: true };
  });

  describe('constructor', () => {
    it('registers chat listener', () => {
      chat = new ChatManager(mockBot, config);
      expect(mockBot.on).toHaveBeenCalledWith('chat', expect.any(Function));
    });

    it('registers whisper listener', () => {
      chat = new ChatManager(mockBot, config);
      expect(mockBot.on).toHaveBeenCalledWith('whisper', expect.any(Function));
    });
  });

  describe('chat event handling', () => {
    it('ignores own messages', () => {
      chat = new ChatManager(mockBot, config);
      const chatListener = chatCallbacks.chat;
      const messageSpy = jest.spyOn(chat, 'emit');
      chatListener('TestBot', '/help');
      expect(messageSpy).not.toHaveBeenCalled();
    });

    it('emits message event for others', () => {
      chat = new ChatManager(mockBot, config);
      const chatListener = chatCallbacks.chat;
      const messageSpy = jest.spyOn(chat, 'emit');
      chatListener('Player1', 'hello');
      expect(messageSpy).toHaveBeenCalledWith('message', {
        username: 'Player1',
        message: 'hello',
        translate: undefined,
        jsonMsg: undefined,
      });
    });

    it('emits whisper event', () => {
      chat = new ChatManager(mockBot, config);
      const whisperCb = chatCallbacks.whisper;
      const whisperSpy = jest.spyOn(chat, 'emit');
      whisperCb('Player1', 'secret');
      expect(whisperSpy).toHaveBeenCalledWith('whisper', {
        username: 'Player1',
        message: 'secret',
      });
    });
  });

  describe('commands', () => {
    beforeEach(() => {
      chat = new ChatManager(mockBot, config);
    });

    it('responds to /help', async () => {
      chat.handleCommand('Player1', '/help');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('Available commands'));
    });

    it('responds to /pos', async () => {
      chat.handleCommand('Player1', '/pos');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('My position'));
    });

    it('responds to /health', async () => {
      chat.handleCommand('Player1', '/health');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('Health'));
    });

    it('responds to /inventory', async () => {
      chat.handleCommand('Player1', '/inventory');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('dirt'));
    });

    it('says inventory empty when empty', () => {
      mockBot.inventory.items.mockReturnValue([]);
      chat = new ChatManager(mockBot, config);
      chat.handleCommand('Player1', '/inventory');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringMatching(/empty/i));
    });

    it('handles unknown commands', () => {
      chat.handleCommand('Player1', '/unknown');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    });

    it('catches handler errors', () => {
      chat.register('crash', () => { throw new Error('boom'); });
      chat.handleCommand('Player1', '/crash');
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('Command failed'));
    });
  });

  describe('register / unregister', () => {
    it('registers a new command', () => {
      chat = new ChatManager(mockBot, config);
      const fn = jest.fn();
      chat.register('test', fn);
      chat.handleCommand('Player1', '/test arg1');
      expect(fn).toHaveBeenCalledWith('Player1', ['arg1']);
    });

    it('unregisters a command', () => {
      chat = new ChatManager(mockBot, config);
      const fn = jest.fn();
      chat.register('test', fn);
      chat.unregister('test');
      chat.handleCommand('Player1', '/test');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('say and whisper', () => {
    it('sends a chat message', () => {
      chat = new ChatManager(mockBot, config);
      chat.say('Hello');
      expect(mockBot.chat).toHaveBeenCalledWith('Hello');
    });

    it('whispers to a player', () => {
      chat = new ChatManager(mockBot, config);
      chat.whisper('Player1', 'secret');
      expect(mockBot.whisper).toHaveBeenCalledWith('Player1', 'secret');
    });
  });
});

