const ForgeHandler = require('../../src/forge');

jest.mock('minecraft-protocol-forge/src/client/forgeHandshake3', () => jest.fn());

const forgeHandshake3 = require('minecraft-protocol-forge/src/client/forgeHandshake3');

describe('ForgeHandler', () => {
  let handler;
  let mockBot;
  let mockClient;
  let config;

  beforeEach(() => {
    jest.resetAllMocks();
    mockClient = {
      on: jest.fn(),
      once: jest.fn(),
      write: jest.fn(),
    };
    mockBot = {
      _client: mockClient,
      version: '1.20.1',
    };
    config = { debug: false };
    handler = new ForgeHandler(mockBot, config);
  });

  describe('static isForgeServer', () => {
    it('returns true when modinfo contains forge mod', () => {
      const ping = {
        modinfo: {
          modList: [
            { modid: 'forge', version: '36.0' },
            { modid: 'some_mod', version: '1.0' },
          ],
        },
      };
      expect(ForgeHandler.isForgeServer(ping)).toBe(true);
    });

    it('returns true when forgeData is present', () => {
      const ping = { forgeData: { channels: [] } };
      expect(ForgeHandler.isForgeServer(ping)).toBe(true);
    });

    it('returns true when description mentions FML', () => {
      const ping = { description: 'A Minecraft Server with FML' };
      expect(ForgeHandler.isForgeServer(ping)).toBe(true);
    });

    it('returns false for vanilla server', () => {
      const ping = { description: 'A vanilla Minecraft server' };
      expect(ForgeHandler.isForgeServer(ping)).toBe(false);
    });

    it('returns false for null ping result', () => {
      expect(ForgeHandler.isForgeServer(null)).toBe(false);
    });

    it('returns false when modList is empty', () => {
      const ping = { modinfo: { modList: [] } };
      expect(ForgeHandler.isForgeServer(ping)).toBe(false);
    });
  });

  describe('static detectForgeFromServerListPing', () => {
    it('delegates to isForgeServer', () => {
      const spy = jest.spyOn(ForgeHandler, 'isForgeServer');
      ForgeHandler.detectForgeFromServerListPing({ description: 'forge' });
      expect(spy).toHaveBeenCalledWith({ description: 'forge' });
      spy.mockRestore();
    });
  });

  describe('setup', () => {
    it('calls forgeHandshake3 with client', () => {
      handler.setup();
      expect(forgeHandshake3).toHaveBeenCalledWith(mockClient, expect.any(Object));
    });

    it('registers login_success listener', () => {
      handler.setup();
      expect(mockClient.once).toHaveBeenCalledWith('login_success', expect.any(Function));
    });

    it('registers error listener', () => {
      handler.setup();
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('does not setup twice', () => {
      handler.setup();
      handler.setup();
      // forgeHandshake3 should only be called once
      expect(forgeHandshake3).toHaveBeenCalledTimes(1);
      // But client.on('error') should be registered once (the forge handshake listener)
      // plus any from other calls — verify forgeHandshake3 is the idempotency guard
    });

    it('sets handshakeFailed if no client available', () => {
      const handlerNoClient = new ForgeHandler({ _client: null, version: '1.20.1' }, config);
      const errListener = jest.fn();
      handlerNoClient.on('error', errListener);
      handlerNoClient.setup();
      expect(handlerNoClient.handshakeFailed).toBe(true);
      expect(errListener).toHaveBeenCalled();
    });

    it('sets tagHost on client', () => {
      handler.setup();
      expect(mockClient.tagHost).toBe('\0FML3\0');
    });

    it('emits complete event when login_success fires', () => {
      handler.setup();
      const onCallback = mockClient.once.mock.calls.find(
        call => call[0] === 'login_success'
      )[1];

      const completeListener = jest.fn();
      handler.on('complete', completeListener);

      onCallback();

      expect(completeListener).toHaveBeenCalled();
      expect(handler.handshakeComplete).toBe(true);
      expect(handler.failCount).toBe(0);
    });
  });

  describe('waitForHandshake', () => {
    beforeEach(() => {
      handler.setup();
    });

    it('resolves true when handshake is already complete', async () => {
      handler.handshakeComplete = true;
      const result = await handler.waitForHandshake();
      expect(result).toBe(true);
    });

    it('resolves false when handshake already failed', async () => {
      handler.handshakeFailed = true;
      const result = await handler.waitForHandshake();
      expect(result).toBe(false);
    });

    it('resolves true when complete event fires', async () => {
      const result = handler.waitForHandshake();
      handler.emit('complete');
      await expect(result).resolves.toBe(true);
    });

    it('resolves false on timeout', async () => {
      const result = await handler.waitForHandshake(100);
      expect(result).toBe(false);
    });

    it('resolves false on error event', async () => {
      const result = handler.waitForHandshake();
      handler.emit('error', new Error('test error'));
      await expect(result).resolves.toBe(false);
    });
  });

  describe('failCount and permanent failure', () => {
    it('emits permanentFailure after 3 FML errors', () => {
      const errListener = jest.fn();
      const permListener = jest.fn();
      handler.on('error', errListener);
      handler.on('permanentFailure', permListener);

      handler._handleHandshakeFailure(new Error('FML error 1'));
      expect(handler.failCount).toBe(1);
      expect(permListener).not.toHaveBeenCalled();

      handler._handleHandshakeFailure(new Error('FML error 2'));
      expect(handler.failCount).toBe(2);

      handler._handleHandshakeFailure(new Error('FML error 3'));
      expect(handler.failCount).toBe(3);
      expect(permListener).toHaveBeenCalled();
    });

    it('emits error on each failure', () => {
      const errListener = jest.fn();
      handler.on('error', errListener);

      handler._handleHandshakeFailure(new Error('test error'));
      expect(errListener).toHaveBeenCalledWith(new Error('test error'));
    });
  });
});
