const InventoryManager = require('../../src/inventory');

describe('InventoryManager', () => {
  let manager;
  let mockBot;

  beforeEach(() => {
    mockBot = {
      version: '1.16.5',
      inventory: {
        items: jest.fn(() => [
          { name: 'dirt', type: 3, count: 32, slot: 0, metadata: 0 },
          { name: 'stone_sword', type: 272, count: 1, slot: 1, metadata: 0 },
          { name: 'apple', type: 260, count: 5, slot: 2, metadata: 0 },
        ]),
        slots: [
          { name: 'dirt', type: 3, count: 32, slot: 0, metadata: 0 },
          { name: 'stone_sword', type: 272, count: 1, slot: 1, metadata: 0 },
          null,
          null,
        ],
      },
      equip: jest.fn().mockResolvedValue(),
      toss: jest.fn().mockResolvedValue(),
      tossStack: jest.fn().mockResolvedValue(),
      clickWindow: jest.fn().mockResolvedValue(),
    };
    manager = new InventoryManager(mockBot);
  });

  describe('items', () => {
    it('returns all items from bot inventory', () => {
      const items = manager.items();
      expect(items).toHaveLength(3);
      expect(items[0].name).toBe('dirt');
    });
  });

  describe('count', () => {
    it('counts items by name', () => {
      expect(manager.count('dirt')).toBe(32);
    });

    it('returns 0 for items not in inventory', () => {
      expect(manager.count('diamond')).toBe(0);
    });
  });

  describe('hasItems', () => {
    it('returns true when enough items', () => {
      expect(manager.hasItems('dirt', 10)).toBe(true);
    });

    it('returns false when not enough items', () => {
      expect(manager.hasItems('dirt', 100)).toBe(false);
    });

    it('defaults count to 1', () => {
      expect(manager.hasItems('stone_sword')).toBe(true);
    });
  });

  describe('findItem', () => {
    it('finds an item by name', () => {
      const item = manager.findItem('apple');
      expect(item).toBeDefined();
      expect(item.count).toBe(5);
    });

    it('returns null for missing item', () => {
      expect(manager.findItem('diamond')).toBeNull();
    });
  });

  describe('equipItem', () => {
    it('equips an item to hand by default', async () => {
      const result = await manager.equipItem('stone_sword');
      expect(result).toBe(true);
      expect(mockBot.equip).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'stone_sword' }),
        'hand'
      );
    });

    it('returns false when item not found', async () => {
      const result = await manager.equipItem('diamond');
      expect(result).toBe(false);
    });

    it('equips to specified destination', async () => {
      await manager.equipItem('stone_sword', 'head');
      expect(mockBot.equip).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'stone_sword' }),
        'head'
      );
    });
  });

  describe('tossItem', () => {
    it('tosses all of an item by default', async () => {
      const result = await manager.tossItem('dirt');
      expect(result).toBe(true);
      expect(mockBot.toss).toHaveBeenCalledWith(3, 0, 32);
    });

    it('tosses specified count', async () => {
      const result = await manager.tossItem('apple', 3);
      expect(result).toBe(true);
      expect(mockBot.toss).toHaveBeenCalledWith(260, 0, 3);
    });

    it('returns false for missing item', async () => {
      const result = await manager.tossItem('diamond');
      expect(result).toBe(false);
    });
  });

  describe('equipSword', () => {
    it('equips the first sword found', async () => {
      const result = await manager.equipSword();
      expect(result).toBe(true);
      expect(mockBot.equip).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'stone_sword' }),
        'hand'
      );
    });

    it('returns false when no sword', () => {
      mockBot.inventory.items.mockReturnValue([
        { name: 'dirt', type: 3, count: 32, slot: 0, metadata: 0 },
      ]);
      const manager2 = new InventoryManager(mockBot);
      return manager2.equipSword().then(r => expect(r).toBe(false));
    });
  });

  describe('equipPickaxe', () => {
    it('returns false when no pickaxe', async () => {
      const result = await manager.equipPickaxe();
      expect(result).toBe(false);
    });
  });

  describe('getEmptySlotsCount', () => {
    it('counts empty slots', () => {
      expect(manager.getEmptySlotsCount()).toBe(2);
    });
  });

  describe('isInventoryFull', () => {
    it('returns false when not full', () => {
      expect(manager.isInventoryFull()).toBe(false);
    });

    it('returns true when full', () => {
      mockBot.inventory.slots = [
        { name: 'dirt' },
        { name: 'stone' },
        { name: 'apple' },
        { name: 'diamond' },
      ];
      const manager2 = new InventoryManager(mockBot);
      expect(manager2.isInventoryFull()).toBe(true);
    });
  });
});

