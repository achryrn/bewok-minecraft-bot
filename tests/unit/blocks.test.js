const BlockManager = require('../../src/blocks');

describe('BlockManager', () => {
  let manager;
  let mockBot;

  beforeEach(() => {
    mockBot = {
      version: '1.16.5',
      entity: {
        position: {
          x: 100, y: 64, z: 100,
          distanceTo: jest.fn(() => 10),
          offset: jest.fn((dx, dy, dz) => ({
            x: 100 + dx, y: 64 + dy, z: 100 + dz,
          })),
        },
      },
      findBlock: jest.fn(),
      findBlocks: jest.fn(),
      blockAt: jest.fn(),
      dig: jest.fn().mockResolvedValue(),
      equip: jest.fn().mockResolvedValue(),
      placeBlock: jest.fn().mockResolvedValue(),
      Vec3: class Vec3 {
        constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
        minus(v) { return { x: this.x - v.x, y: this.y - v.y, z: this.z - v.z }; }
        normalize() { return { x: 0, y: 1, z: 0 }; }
      },
      inventory: {
        items: jest.fn(() => []),
      },
    };
    manager = new BlockManager(mockBot);
  });

  describe('findBlock', () => {
    it('delegates to bot.findBlock', () => {
      const opts = { matching: { name: 'stone' }, maxDistance: 10 };
      manager.findBlock(opts);
      expect(mockBot.findBlock).toHaveBeenCalledWith(opts);
    });
  });

  describe('findBlocks', () => {
    it('delegates to bot.findBlocks', () => {
      const opts = { matching: { name: 'stone' }, maxDistance: 10 };
      manager.findBlocks(opts);
      expect(mockBot.findBlocks).toHaveBeenCalledWith(opts);
    });
  });

  describe('blockAt', () => {
    it('delegates to bot.blockAt', () => {
      const pos = { x: 100, y: 64, z: 100 };
      manager.blockAt(pos);
      expect(mockBot.blockAt).toHaveBeenCalledWith(pos);
    });
  });

  describe('digBlock', () => {
    it('digs a block', async () => {
      const block = { position: { x: 100, y: 65, z: 100 } };
      const result = await manager.digBlock(block);
      expect(result).toBe(true);
      expect(mockBot.dig).toHaveBeenCalledWith(block);
    });

    it('returns false for null block', async () => {
      expect(await manager.digBlock(null)).toBe(false);
    });

    it('handles dig failure', async () => {
      mockBot.dig.mockRejectedValue(new Error('dig failed'));
      const result = await manager.digBlock({ position: {} });
      expect(result).toBe(false);
    });
  });

  describe('digBlockAt', () => {
    it('returns false when block is air', async () => {
      mockBot.blockAt.mockReturnValue({ type: 0 });
      const result = await manager.digBlockAt({ x: 100, y: 65, z: 100 });
      expect(result).toBe(false);
    });

    it('digs a block at position', async () => {
      const block = { type: 1, position: { x: 100, y: 65, z: 100 } };
      mockBot.blockAt.mockReturnValue(block);
      const result = await manager.digBlockAt({ x: 100, y: 65, z: 100 });
      expect(result).toBe(true);
    });
  });

  describe('placeBlock', () => {
    it('places a block with default direction', async () => {
      const block = { position: { x: 100, y: 64, z: 100 } };
      const result = await manager.placeBlock(block);
      expect(result).toBe(true);
      expect(mockBot.placeBlock).toHaveBeenCalledWith(block, expect.any(Object));
    });

    it('returns false for null block', async () => {
      expect(await manager.placeBlock(null)).toBe(false);
    });
  });

  describe('isBlockAt', () => {
    it('returns true when block matches name', () => {
      mockBot.blockAt.mockReturnValue({ name: 'stone' });
      expect(manager.isBlockAt({ x: 100, y: 65, z: 100 }, 'stone')).toBe(true);
    });

    it('returns false for air block', () => {
      mockBot.blockAt.mockReturnValue(null);
      expect(manager.isBlockAt({ x: 100 }, 'stone')).toBe(false);
    });

    it('returns false when name differs', () => {
      mockBot.blockAt.mockReturnValue({ name: 'dirt' });
      expect(manager.isBlockAt({ x: 100 }, 'stone')).toBe(false);
    });
  });

  describe('getSurroundingBlocks', () => {
    it('returns blocks within radius', () => {
      // Return a non-air block once, then null for the rest
      mockBot.blockAt.mockImplementation(() => null);
      mockBot.blockAt.mockReturnValueOnce({ type: 1 });
      const blocks = manager.getSurroundingBlocks(1);
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it('filters out air blocks', () => {
      mockBot.blockAt.mockReturnValue({ type: 0 });
      const blocks = manager.getSurroundingBlocks(1);
      // All returned blocks are type 0 (air) - should filter to empty
      expect(blocks).toHaveLength(0);
    });
  });

  describe('equipAndDig', () => {
    it('digs a block without tool', async () => {
      const block = { type: 1, position: { x: 100, y: 65, z: 100 } };
      mockBot.blockAt.mockReturnValue(block);
      const result = await manager.equipAndDig(block);
      expect(result).toBe(true);
    });

    it('returns false for null block', async () => {
      expect(await manager.equipAndDig(null)).toBe(false);
    });
  });
});

