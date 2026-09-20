const AutoEatPlugin = require('../../../src/plugins/autoEat');

describe('AutoEatPlugin', () => {
  let plugin;
  let mockBot;
  let mockConfig;

  beforeEach(() => {
    mockConfig = { autoEat: true, autoEatThreshold: 14, debug: false };
    mockBot = {
      food: 20,
      inventory: {
        items: jest.fn(() => [
          { name: 'apple', foodPoints: 4, count: 5 },
          { name: 'cooked_beef', foodPoints: 6, count: 3 },
          { name: 'stone', foodPoints: 0, count: 10 },
        ]),
      },
      equip: jest.fn().mockResolvedValue(),
      consume: jest.fn().mockResolvedValue(),
    };
    plugin = new AutoEatPlugin(mockBot, mockConfig);
  });

  describe('onHealth', () => {
    it('does nothing when disabled', () => {
      plugin.enabled = false;
      plugin.onHealth();
      expect(mockBot.equip).not.toHaveBeenCalled();
    });

    it('does nothing when already eating', () => {
      plugin.eating = true;
      plugin.onHealth();
      expect(mockBot.equip).not.toHaveBeenCalled();
    });

    it('does nothing when food above threshold', () => {
      plugin.onHealth();
      expect(mockBot.equip).not.toHaveBeenCalled();
    });

    it('eats best food when food below threshold', async () => {
      mockBot.food = 10;
      plugin.onHealth();
      // Allow the promise to resolve
      await new Promise(process.nextTick);
      expect(mockBot.equip).toHaveBeenCalled();
      // cooked_beef has highest foodPoints
      expect(mockBot.consume).toHaveBeenCalled();
    });

    it('does nothing when no food items available', () => {
      mockBot.inventory.items.mockReturnValue([{ name: 'stone', foodPoints: 0, count: 10 }]);
      mockBot.food = 10;
      plugin.onHealth();
      expect(mockBot.equip).not.toHaveBeenCalled();
    });

    it('resets eating flag after consume', async () => {
      mockBot.food = 10;
      expect(plugin.eating).toBe(false);
      plugin.onHealth();
      expect(plugin.eating).toBe(true);
      await new Promise(process.nextTick);
      expect(plugin.eating).toBe(false);
    });
  });

  describe('_findBestFood', () => {
    it('returns the item with highest foodPoints', () => {
      const item = plugin._findBestFood();
      expect(item.name).toBe('cooked_beef');
    });

    it('returns null when no food items', () => {
      mockBot.inventory.items.mockReturnValue([]);
      expect(plugin._findBestFood()).toBeNull();
    });
  });
});

