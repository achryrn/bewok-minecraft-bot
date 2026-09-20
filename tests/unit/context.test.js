const { buildFullContext, narrative, inventorySummary } = require('../../src/context');

function makeBot(overrides) {
  const base = {
    username: 'TestBot',
    version: '1.20.1',
    health: 17,
    maxHealth: 20,
    food: 12,
    entity: {
      position: { x: 100, y: 64, z: 200, offset: (dx, dy, dz) => ({ x: 100 + dx, y: 64 + dy, z: 200 + dz }) },
      yaw: 0,
      pitch: 0,
      onGround: true,
    },
    heldItem: { name: 'iron_pickaxe', count: 1 },
    inventory: { items: () => [{ name: 'dirt', count: 10 }, { name: 'oak_log', count: 3 }], emptySlotCount: () => 12 },
    players: {},
    entities: {},
    blockAt: () => ({ name: 'grass_block' }),
    game: { dimension: 'minecraft:overworld', gamemode: 'survival', difficulty: 'normal', hardcore: false },
    time: { day: 3, timeOfDay: 6000 },
    experience: { level: 4, progress: 0.5 },
    biome: 1,
  };
  return Object.assign(base, overrides || {});
}

describe('context.js', () => {
  it('builds a full context with vitals and narrative', () => {
    const ctx = buildFullContext(makeBot(), { memory: { toJSON: () => ({ facts: {} }) }, taskManager: { currentTask: null } });
    expect(ctx.self.health).toBe(17);
    expect(ctx.self.food).toBe(12);
    expect(ctx.self.position).toEqual({ x: 100, y: 64, z: 200 });
    expect(ctx.inventory).toContain('dirt x10');
    expect(ctx.narrative).toContain('You are standing at (100, 64, 200)');
  });

  it('includes nearby entities and blocks', () => {
    const bot = makeBot({
      entities: {
        zombie1: { type: 'mob', name: 'zombie', position: { x: 105, y: 64, z: 200 } },
        steve: { type: 'player', name: 'steve', username: 'steve', position: { x: 110, y: 64, z: 200 } },
      },
    });
    const ctx = buildFullContext(bot, { memory: { toJSON: () => ({}) }, taskManager: { currentTask: null } });
    expect(ctx.entities.hostiles.length).toBeGreaterThan(0);
    expect(ctx.entities.players[0].name).toBe('steve');
    expect(ctx.narrative).toContain('hostile');
  });

  it('survives missing game state', () => {
    const ctx = buildFullContext(makeBot({ game: undefined, time: undefined, entity: null }), {});
    expect(ctx.self.health).toBe(17);
    expect(ctx.position || ctx.self.position).toBeDefined();
    expect(ctx.narrative.length).toBeGreaterThan(10);
  });

  it('inventorySummary returns empty', () => {
    expect(inventorySummary(makeBot({ inventory: { items: () => [] } }))).toEqual(['empty']);
  });

  it('narrative reflects current task', () => {
    const brain = {
      memory: { toJSON: () => ({}) },
      taskManager: { currentTask: { type: 'mine', status: 'running', progress: { mined: 2, target: 5 } } },
    };
    const ctx = buildFullContext(makeBot(), brain);
    expect(ctx.narrative).toContain('mine');
  });
});
