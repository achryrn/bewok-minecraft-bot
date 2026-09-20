const CombatManager = require('../../src/combat');

jest.mock('mineflayer-pathfinder', () => {
  const mockGoal = function (entity, d) {
    this.entity = entity;
    this.distance = d;
  };
  return {
    goals: {
      GoalFollow: jest.fn(mockGoal),
    },
    pathfinder: jest.fn(),
  };
});

describe('CombatManager', () => {
  let combat;
  let mockBot;
  let mockEntity;
  let mockHostile;

  const createEntity = (overrides = {}) => ({
    type: 'mob',
    kind: 'hostile',
    position: {
      x: 100, y: 64, z: 100,
      distanceTo: jest.fn(() => 3),
      offset: jest.fn(function (ox, oy, oz) {
        return { x: this.x + ox, y: this.y + oy, z: this.z + oz };
      }),
    },
    isValid: true,
    dead: false,
    ...overrides,
  });

  beforeEach(() => {
    mockEntity = createEntity();
    mockHostile = createEntity({ type: 'mob', kind: 'hostile' });

    mockBot = {
      entity: {
        position: {
          x: 100, y: 64, z: 100,
          distanceTo: jest.fn(() => 0),
        },
      },
      lookAt: jest.fn().mockResolvedValue(),
      attack: jest.fn(),
      equip: jest.fn().mockResolvedValue(),
      inventory: {
        items: jest.fn(() => []),
      },
      entities: {
        zombie: mockHostile,
        sheep: { type: 'mob', kind: 'passive', position: { x: 200, y: 64, z: 200 } },
      },
      pathfinder: { setGoal: jest.fn() },
      version: '1.16.5',
    };

    combat = new CombatManager(mockBot);
  });

  describe('attackEntity', () => {
    it('attacks a valid entity', async () => {
      const result = await combat.attackEntity(mockEntity);
      expect(result).toBe(true);
      expect(mockBot.lookAt).toHaveBeenCalled();
      expect(mockBot.attack).toHaveBeenCalledWith(mockEntity);
      expect(combat.target).toBe(mockEntity);
    });

    it('returns false for null entity', async () => {
      expect(await combat.attackEntity(null)).toBe(false);
    });

    it('refuses to attack object-type entities', async () => {
      expect(await combat.attackEntity({ kind: 'object' })).toBe(false);
    });
  });

  describe('stop', () => {
    it('stops fighting and clears target', () => {
      combat.fighting = true;
      combat.target = mockEntity;
      combat.stop();
      expect(combat.fighting).toBe(false);
      expect(combat.target).toBeNull();
    });
  });

  describe('setAutoAttack', () => {
    it('enables auto attack', () => {
      expect(combat.autoAttackEnabled).toBe(false);
      combat.setAutoAttack(true);
      expect(combat.autoAttackEnabled).toBe(true);
    });

    it('disables auto attack', () => {
      combat.setAutoAttack(true);
      combat.setAutoAttack(false);
      expect(combat.autoAttackEnabled).toBe(false);
    });
  });

  describe('onEntityDamaged', () => {
    it('attacks mob when autoAttack is enabled and in range', () => {
      combat.setAutoAttack(true);
      combat.onEntityDamaged(mockEntity);
      expect(mockBot.attack).toHaveBeenCalledWith(mockEntity);
    });

    it('does nothing when autoAttack is disabled', () => {
      combat.onEntityDamaged(mockEntity);
      expect(mockBot.attack).not.toHaveBeenCalled();
    });
  });

  describe('equipBestWeapon', () => {
    it('returns null when no weapons', () => {
      expect(combat.equipBestWeapon()).toBeNull();
    });

    it('equips the weapon with highest damage', () => {
      mockBot.inventory.items.mockReturnValue([
        { name: 'wooden_sword', attackDamage: 4 },
        { name: 'stone_sword', attackDamage: 5 },
      ]);
      const result = combat.equipBestWeapon();
      expect(result).toBeDefined();
      expect(mockBot.equip).toHaveBeenCalled();
    });
  });

  describe('nearestHostileMob', () => {
    it('finds nearest hostile mob within range', () => {
      const mob = combat.nearestHostileMob(16);
      expect(mob).toBeDefined();
    });

    it('returns undefined if no hostile mob in range', () => {
      mockBot.entities = {};
      expect(combat.nearestHostileMob(16)).toBeUndefined();
    });
  });

  describe('nearbyHostileMobs', () => {
    it('returns array of hostile mobs within range', () => {
      const mobs = combat.nearbyHostileMobs(16);
      expect(Array.isArray(mobs)).toBe(true);
      expect(mobs.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array when no hostile mobs', () => {
      mockBot.entities = {};
      expect(combat.nearbyHostileMobs(16)).toEqual([]);
    });
  });
});

