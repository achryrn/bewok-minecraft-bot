const FabricHandler = require('../../src/fabric');

describe('FabricHandler', () => {
  let handler;
  let mockBot;
  let mockClient;
  let config;

  beforeEach(() => {
    jest.resetAllMocks();
    mockClient = {
      on: jest.fn(),
    };
    mockBot = {
      _client: mockClient,
    };
    config = { debug: false };
    handler = new FabricHandler(mockBot, config);
  });

  describe('static isFabricBrand', () => {
    it('returns true for "fabric"', () => {
      expect(FabricHandler.isFabricBrand('fabric')).toBe(true);
    });

    it('returns true for "Fabric 0.14"', () => {
      expect(FabricHandler.isFabricBrand('Fabric 0.14')).toBe(true);
    });

    it('returns true for "Fabric" (capitalized)', () => {
      expect(FabricHandler.isFabricBrand('Fabric')).toBe(true);
    });

    it('returns false for "vanilla"', () => {
      expect(FabricHandler.isFabricBrand('vanilla')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(FabricHandler.isFabricBrand('')).toBe(false);
    });

    it('returns false for null', () => {
      expect(FabricHandler.isFabricBrand(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(FabricHandler.isFabricBrand(undefined)).toBe(false);
    });
  });

  describe('setup', () => {
    it('registers custom_payload listener', () => {
      handler.setup();
      expect(mockClient.on).toHaveBeenCalledWith('custom_payload', expect.any(Function));
    });

    it('does not setup twice', () => {
      handler.setup();
      handler.setup();
      expect(mockClient.on).toHaveBeenCalledTimes(1);
    });

    it('handles missing client gracefully', () => {
      const handlerNoClient = new FabricHandler({ _client: null }, config);
      handlerNoClient.setup();
      // Should not throw
    });
  });

  describe('brand packet handling', () => {
    it('emits detected event for fabric brand', () => {
      handler.setup();
      const payloadCallback = mockClient.on.mock.calls.find(
        call => call[0] === 'custom_payload'
      )[1];

      const detectedListener = jest.fn();
      handler.on('detected', detectedListener);

      // Simulate MC|Brand packet with fabric brand
      // MC|Brand data format: VarInt length prefix + UTF-8 string bytes
      const brandPrefix = Buffer.from([6]); // varint length = 6 for "Fabric"
      const brandStr = Buffer.from('Fabric', 'utf8');
      const brandBuf = Buffer.concat([brandPrefix, brandStr]);
      payloadCallback({ channel: 'MC|Brand', data: brandBuf });

      expect(detectedListener).toHaveBeenCalled();
      expect(detectedListener).toHaveBeenCalledWith('Fabric');
    });

    it('does not emit detected for vanilla brand', () => {
      handler.setup();
      const payloadCallback = mockClient.on.mock.calls.find(
        call => call[0] === 'custom_payload'
      )[1];

      const detectedListener = jest.fn();
      handler.on('detected', detectedListener);

      const brandPrefix = Buffer.from([7]); // varint length = 7 for "vanilla"
      const brandStr = Buffer.from('vanilla', 'utf8');
      const brandBuf = Buffer.concat([brandPrefix, brandStr]);
      payloadCallback({ channel: 'MC|Brand', data: brandBuf });

      expect(detectedListener).not.toHaveBeenCalled();
    });

    it('does not emit detected for non-brand packets', () => {
      handler.setup();
      const payloadCallback = mockClient.on.mock.calls.find(
        call => call[0] === 'custom_payload'
      )[1];

      const detectedListener = jest.fn();
      handler.on('detected', detectedListener);

      payloadCallback({ channel: 'FML|HS', data: Buffer.alloc(1) });

      expect(detectedListener).not.toHaveBeenCalled();
    });

    it('handles brand with no data gracefully', () => {
      handler.setup();
      const payloadCallback = mockClient.on.mock.calls.find(
        call => call[0] === 'custom_payload'
      )[1];

      const detectedListener = jest.fn();
      handler.on('detected', detectedListener);

      payloadCallback({ channel: 'MC|Brand', data: null });

      expect(detectedListener).not.toHaveBeenCalled();
    });
  });
});
