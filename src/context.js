'use strict';
/**
 * context.js — builds the FULL Minecraft context handed to the LLM on every
 * query. The goal: the model should feel it is actually inside the game — every
 * observable value (health, hunger, position, biome, time, weather, inventory,
 * equipment, entities, memory, task state) is passed, plus a first-person
 * narrative paragraph describing "where you are right now".
 *
 * Every getter is defensive — a missing bot subsystem degrades gracefully
 * instead of crashing the brain.
 */

const BIOME_OVERRIDES = {
  'minecraft:plains': 'plains',
};

function fmt(pos) {
  return pos ? `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : '?';
}

function dist(a, b) {
  if (!a || !b) return null;
  try { return Math.floor(Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2)); } catch (_) { return null; }
}

/**
 * Compress an inventory into a compact string list, e.g. ["oak_log x10", ...].
 */
function inventorySummary(bot) {
  try {
    const items = bot.inventory ? bot.inventory.items() : [];
    if (!items || items.length === 0) return ['empty'];
    const counts = {};
    for (const i of items) {
      const name = i.name || '';
      const cnt = i.count || 1;
      if (name && name !== 'air' && name !== 'minecraft:air') {
        counts[name] = (counts[name] || 0) + cnt;
      }
    }
    const entries = Object.entries(counts);
    return entries.length === 0 ? ['empty'] : entries.map(([name, count]) => `${name} x${count}`);
  } catch (_) {
    return ['empty'];
  }
}

function nearbyEntities(bot, maxDist) {
  try {
    const out = { mobs: [], players: [], hostiles: [] };
    const entities = bot.entities || {};
    const me = bot.entity;
    for (const key of Object.keys(entities)) {
      const e = entities[key];
      if (!e || e === me || !e.position) continue;
      const d = dist(me && me.position, e.position);
      if (d === null || d > maxDist) continue;
      const name = e.name || e.displayName || e.username || e.type || 'unknown';
      const entry = { name, distance: d };
      if (e.type === 'player') out.players.push(entry);
      else if (e.type === 'mob' || e.type === 'hostile') {
        out.mobs.push(entry);
        const mobName = (e.name || e.displayName || '').toLowerCase();
        const hostileGuess = e.type === 'hostile' || /zombie|skeleton|creeper|spider|enderman|witch|phantom|drowned|husk|stray|slime|blaze|ghast|magma|piglin|hoglin|shulker|guardian|warden|vex|vindicator|pillager|ravager|evoker|silverfish/.test(mobName);
        if (hostileGuess) out.hostiles.push(entry);
      }
    }
    return out;
  } catch (_) {
    return { mobs: [], players: [], hostiles: [] };
  }
}

function nearbyBlocks(bot, radius) {
  try {
    const pos = bot.entity.position;
    const counts = {};
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        for (let dy = -radius; dy <= radius; dy += 2) {
          try {
            const b = bot.blockAt(pos.offset(dx, dy, dz));
            if (b && b.name && b.name !== 'air') {
              counts[b.name] = (counts[b.name] || 0) + 1;
            }
          } catch (_) { /* unloaded chunk */ }
        }
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
  } catch (_) {
    return [];
  }
}

function biomeName(bot) {
  try {
    const id = bot.biome !== undefined ? bot.biome : null;
    if (id === null) return 'unknown';
    const mcData = require('minecraft-data')(bot.version);
    const b = mcData.biomes[id];
    const name = (b && b.name) || String(id);
    return BIOME_OVERRIDES[name] || name.replace('minecraft:', '');
  } catch (_) {
    return 'unknown';
  }
}

function positionContext(bot) {
  try {
    const pos = bot.entity ? bot.entity.position : null;
    return {
      position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
      yaw: bot.entity ? Math.round(bot.entity.yaw * 57.2958) : null,
      pitch: bot.entity ? Math.round(bot.entity.pitch * 57.2958) : null,
      onGround: bot.entity ? !!bot.entity.onGround : null,
      dimension: (bot.game && bot.game.dimension) || 'unknown',
      gamemode: (bot.game && bot.game.gamemode) || 'unknown',
      difficulty: (bot.game && bot.game.difficulty) || 'unknown',
      hardcore: bot.game ? !!bot.game.hardcore : false,
      biome: biomeName(bot),
      spawnPoint: bot.spawnPoint ? { x: Math.floor(bot.spawnPoint.x), y: Math.floor(bot.spawnPoint.y), z: Math.floor(bot.spawnPoint.z) } : null,
      day: bot.time ? bot.time.day : null,
      timeOfDay: bot.time ? bot.time.timeOfDay : null,
      weather: (bot.weather && bot.weather.toString()) || (bot.rainState ? bot.rainState.toString() : 'clear'),
    };
  } catch (_) {
    return { position: null, dimension: 'unknown', biome: 'unknown' };
  }
}

function vitalsContext(bot) {
  try {
    return {
      health: Math.floor(bot.health || 20),
      food: Math.floor(bot.food || 20),
      saturation: bot.foodSaturation !== undefined ? Math.round(bot.foodSaturation * 10) / 10 : null,
      maxHealth: bot.maxHealth || 20,
      xpLevel: bot.experience ? bot.experience.level : null,
      xpProgress: bot.experience ? Math.round((bot.experience.progress || 0) * 100) : null,
      effects: bot.effects ? Object.entries(bot.effects).map(([id, v]) => ({
        id,
        amplifier: v.amplifier,
        duration: v.duration,
      })) : [],
      isInWater: bot.entity ? !!bot.entity.isInWater : null,
      isInLava: bot.entity ? !!bot.entity.isInLava : null,
    };
  } catch (_) {
    return { health: Math.floor(bot.health || 20), food: Math.floor(bot.food || 20) };
  }
}

function equipmentContext(bot) {
  try {
    const slots = bot.inventory ? bot.inventory.slots : [];
    const eq = {
      head: slots[5] ? slots[5].name : null,
      torso: slots[6] ? slots[6].name : null,
      legs: slots[7] ? slots[7].name : null,
      feet: slots[8] ? slots[8].name : null,
      offhand: slots[45] ? slots[45].name : null,
    };
    return {
      heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count, slot: bot.heldItem.slot } : null,
      quickBarSlot: bot.quickBarSlot !== undefined ? bot.quickBarSlot + 1 : null,
      armor: eq,
      emptySlots: bot.inventory && typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,
    };
  } catch (_) {
    return { heldItem: null, armor: {} };
  }
}

function taskContext(brain) {
  try {
    const tm = brain && brain.taskManager;
    if (!tm || !tm.currentTask) return null;
    const t = tm.currentTask;
    return {
      type: t.type,
      status: t.status,
      progress: t.progress || {},
      label: t.label,
      attempts: t.attempts || 0,
      startedAgoMs: t.startedAt ? Date.now() - t.startedAt : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Time-of-day words for the narrative (Minecraft tick 0..24000, 0 = dawn).
 */
function timeWords(timeOfDay) {
  if (timeOfDay === null || timeOfDay === undefined) return 'unknown time';
  const t = timeOfDay % 24000;
  if (t < 2000) return 'early morning (sunrise fading into day)';
  if (t < 12000) return 'daytime';
  if (t < 13000) return 'late afternoon';
  if (t < 14000) return 'sunset';
  if (t < 23000) return 'night';
  return 'late night, almost dawn';
}

/**
 * First-person narrative paragraph. This is what sells the immersion: the model
 * reads "You are standing on ..." plus everything it can see/feel.
 */
function narrative(ctx) {
  const p = ctx.position;
  const parts = [];
  parts.push(`You are standing at ${p ? `(${p.x}, ${p.y}, ${p.z})` : 'an unknown spot'}`);
  parts.push(`in the ${ctx.dimension && ctx.dimension.includes(':') ? ctx.dimension.split(':')[1] : ctx.dimension} dimension`);
  parts.push(`in a ${ctx.biome} biome`);
  parts.push(`during ${timeWords(ctx.timeOfDay)}`);
  parts.push(`(day ${ctx.day === null ? '?' : ctx.day})`);
  if (ctx.weather && ctx.weather !== 'clear') parts.push(`${ctx.weather === true ? 'it is raining' : `weather: ${ctx.weather}`}`);
  parts.push(`with ${ctx.health} hearts of health and ${ctx.food} hunger`);
  if (ctx.heldItem) parts.push(`holding ${ctx.heldItem.name}${ctx.heldItem.count > 1 ? ` x${ctx.heldItem.count}` : ''} in hand`);
  else parts.push('with empty hands');

  const ents = ctx.entities;
  if (ents.players.length > 0) {
    parts.push(`${ents.players.length} player(s) near you: ${ents.players.map((e) => `${e.name} (${e.distance}m)`).join(', ')}`);
  }
  if (ents.hostiles.length > 0) {
    parts.push(`WARNING: ${ents.hostiles.length} hostile(s) close: ${ents.hostiles.map((e) => `${e.name} (${e.distance}m)`).join(', ')}`);
  } else if (ents.mobs.length > 0) {
    parts.push(`${ents.mobs.length} mob(s) visible: ${ents.mobs.map((e) => `${e.name} (${e.distance}m)`).join(', ')}`);
  }
  if (ctx.currentTask) parts.push(`Currently working on: ${ctx.currentTask.type} (${ctx.currentTask.status}) — progress ${JSON.stringify(ctx.currentTask.progress)}`);
  return parts.join('. ') + '.';
}

/**
 * Build the complete context object for the current game state.
 * @param {import('../bot')} bot - mineflayer bot
 * @param {object} brain - Brain instance (task manager access)
 * @returns {object} rich context
 */
function buildFullContext(bot, brain) {
  const posCtx = positionContext(bot);
  const near = nearbyEntities(bot, 64);
  const ctx = {
    self: {
      username: bot.username || 'unknown',
      ...posCtx,
      ...vitalsContext(bot),
      ...equipmentContext(bot),
    },
    inventory: inventorySummary(bot),
    entities: near,
    nearbyBlocks: nearbyBlocks(bot, 6),
    currentTask: taskContext(brain),
    memory: brain && brain.memory ? brain.memory.toJSON(4) : null,
    server: {
      version: bot.version || 'unknown',
      brand: bot._client ? (bot._client.brand || null) : null,
    },
  };
  ctx.narrative = narrative({
    ...ctx.self,
    biome: ctx.self.biome,
    entities: near,
    currentTask: ctx.currentTask,
    weather: ctx.self.weather,
  });
  return ctx;
}

module.exports = { buildFullContext, narrative, inventorySummary, fmt };
