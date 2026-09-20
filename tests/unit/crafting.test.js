jest.mock('minecraft-data', () => {
  return jest.fn(() => ({
    itemsByName: {
      oak_planks: { id: 5, name: 'oak_planks' },
      crafting_table: { id: 58, name: 'crafting_table' },
    },
    items: {
      5: { id: 5, name: 'oak_planks' },
      17: { id: 17, name: 'oak_log' },
      58: { id: 58, name: 'crafting_table' },
    },
    recipesAll: [
      {
        result: 5,
        ingredients: [{ id: 17, count: 1 }],
        requiresTable: false,
      },
    ],
  }));
});

const CraftingManager = require('../../src/crafting');

describe('CraftingManager', () => {
  let manager;
  let mockBot;

  beforeEach(() => {
    mockBot = {
      version: '1.16.5',
      canCraft: jest.fn(() => true),
      craft: jest.fn().mockResolvedValue(),
      findBlock: jest.fn(() => null),
      lookAt: jest.fn().mockResolvedValue(),
      equip: jest.fn().mockResolvedValue(),
      placeBlock: jest.fn().mockResolvedValue(),
      blockAt: jest.fn(),
      Vec3: class Vec3 {
        constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
      },
      entity: {
        position: { x: 100, y: 64, z: 100 },
      },
      inventory: {
        items: jest.fn(() => [
          { name: 'oak_log', type: 17, count: 10, slot: 1 },
        ]),
        count: jest.fn(() => 10),
      },
    };
    manager = new CraftingManager(mockBot);
  });

  describe('getRecipesFor', () => {
    it('returns recipes for a valid item', () => {
      const recipes = manager.getRecipesFor('oak_planks');
      expect(Array.isArray(recipes)).toBe(true);
      expect(recipes.length).toBeGreaterThanOrEqual(1);
      expect(recipes[0].result).toBe(5);
    });

    it('returns empty array for unknown item', () => {
      expect(manager.getRecipesFor('diamond_block')).toEqual([]);
    });
  });

  describe('getRecipe', () => {
    it('returns first recipe for an item', () => {
      const recipe = manager.getRecipe('oak_planks');
      expect(recipe).toBeDefined();
      expect(recipe.result).toBe(5);
    });

    it('returns null for unknown item', () => {
      expect(manager.getRecipe('diamond')).toBeNull();
    });
  });

  describe('canCraft', () => {
    it('returns true when recipe exists and can craft', () => {
      expect(manager.canCraft('oak_planks')).toBe(true);
    });

    it('returns false for unknown item', () => {
      expect(manager.canCraft('diamond')).toBe(false);
    });
  });

  describe('craft', () => {
    it('throws when no recipe found', async () => {
      await expect(manager.craft('diamond')).rejects.toThrow('No recipe found for diamond');
    });

    it('crafts the item when recipe exists', async () => {
      const result = await manager.craft('oak_planks', 1);
      expect(result).toBe(true);
      expect(mockBot.craft).toHaveBeenCalled();
    });
  });

  describe('getCraftableItems', () => {
    it('returns items craftable with current inventory', () => {
      const items = manager.getCraftableItems();
      expect(Array.isArray(items)).toBe(true);
    });
  });

  describe('getRequiredItems', () => {
    it('returns requirements for a recipe', () => {
      const reqs = manager.getRequiredItems('oak_planks', 1);
      expect(Array.isArray(reqs)).toBe(true);
    });

    it('returns empty array for unknown item', () => {
      expect(manager.getRequiredItems('diamond')).toEqual([]);
    });
  });
});

