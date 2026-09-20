class BlockManager {
  constructor(bot) {
    this.bot = bot;
  }

  findBlock(options) {
    return this.bot.findBlock(options);
  }

  findBlocks(options) {
    return this.bot.findBlocks(options);
  }

  blockAt(position) {
    return this.bot.blockAt(position);
  }

  async digBlock(block) {
    if (!block) return false;
    try {
      await this.bot.dig(block);
      return true;
    } catch (err) {
      return false;
    }
  }

  async digBlockAt(position) {
    const block = this.bot.blockAt(position);
    if (!block || block.type === 0) return false;
    return this.digBlock(block);
  }

  async placeBlock(block, direction) {
    if (!block) return false;
    const dir = direction || new this.bot.Vec3(0, 1, 0);
    try {
      await this.bot.placeBlock(block, dir);
      return true;
    } catch (err) {
      return false;
    }
  }

  async placeBlockAt(position, referenceBlock) {
    if (!referenceBlock) return false;
    const dir = referenceBlock.position.minus(position).normalize();
    try {
      await this.bot.placeBlock(referenceBlock, dir);
      return true;
    } catch (err) {
      return false;
    }
  }

  async equipAndDig(block) {
    if (!block) return false;
    const mcData = require('minecraft-data')(this.bot.version);
    const blockInfo = mcData.blocks[block.type];
    let equipped = false;

    if (blockInfo && blockInfo.harvestTools) {
      const toolIds = Object.keys(blockInfo.harvestTools).map(Number);
      const bestTool = this.bot.inventory.items().find(item =>
        toolIds.includes(item.type)
      );
      if (bestTool) {
        try {
          await this.bot.equip(bestTool, 'hand');
          equipped = true;
        } catch (_) {
          // best-effort tool equip
        }
      }
    }

    try {
      const target = equipped
        ? block
        : this.bot.blockAt(block.position);
      if (target) {
        await this.bot.dig(target);
        return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  async moveAndDig(position, movementManager) {
    if (!movementManager) return false;
    const block = this.bot.blockAt(position);
    if (!block || block.type === 0) return false;

    const distance = this.bot.entity.position.distanceTo(position);
    if (distance > 5) {
      const moved = await movementManager.goTo(position.x, position.y, position.z, 4);
      if (!moved) return false;
    }

    return this.equipAndDig(block);
  }

  isBlockAt(position, blockName) {
    const block = this.bot.blockAt(position);
    if (!block) return false;
    return block.name === blockName;
  }

  getSurroundingBlocks(radius) {
    const pos = this.bot.entity.position;
    const blocks = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const block = this.bot.blockAt(pos.offset(dx, dy, dz));
          if (block && block.type !== 0) {
            blocks.push(block);
          }
        }
      }
    }
    return blocks;
  }
}

/**
 * MiningRuleSet - validates mining candidates against safety and tool rules
 * Per CLAUDE.md v3 "Mining Rule Set" section
 */
class MiningRuleSet {
  constructor(bot, config = {}) {
    this.bot = bot;
    this.config = config;
    this.mcData = require('minecraft-data')(bot.version);

    // Tool tier ordering (lowest to highest)
    this.tierOrder = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];

    // Tool categories for each harvest tool type
    this.toolCategories = {
      pickaxe: ['wooden_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
      axe: ['wooden_axe', 'stone_axe', 'golden_axe', 'iron_axe', 'diamond_axe', 'netherite_axe'],
      shovel: ['wooden_shovel', 'stone_shovel', 'golden_shovel', 'iron_shovel', 'diamond_shovel', 'netherite_shovel'],
    };

    // Falling block types that can fall on the bot
    this.fallingBlocks = new Set([
      'sand', 'red_sand', 'gravel', 'concrete_powder',
      'anvil', 'dragon_egg', 'pointed_dripstone'
    ]);

    // Lava block names
    this.lavaBlocks = new Set(['lava', 'flowing_lava']);
  }

  /**
   * Rule 1: Check if bot has the minimum tool tier required to harvest the block
   * Returns { ok: boolean, reason: string, requiredTier: string|null, bestAvailable: string|null }
   */
  checkToolTier(block) {
    const blockInfo = this.mcData.blocks[block.type];
    if (!blockInfo || !blockInfo.harvestTools) {
      return { ok: true, reason: 'no tool requirement', requiredTier: null, bestAvailable: null };
    }

    // Get required tool IDs from harvestTools (these are item type IDs)
    const requiredToolIds = Object.keys(blockInfo.harvestTools).map(Number);

    // Find the best available tool of the correct category in bot's inventory
    const bestTool = this._findBestToolForBlock(block, requiredToolIds);

    if (!bestTool) {
      // No suitable tool at all
      return {
        ok: false,
        reason: 'no suitable tool in inventory',
        requiredTier: this._getMinTierFromIds(requiredToolIds),
        bestAvailable: null
      };
    }

    // Check if the best tool meets the minimum tier requirement
    const toolTier = this._getToolTier(bestTool.name);
    const requiredTier = this._getMinTierFromIds(requiredToolIds);

    if (this._tierMeetsRequirement(toolTier, requiredTier)) {
      return { ok: true, reason: 'tool tier sufficient', requiredTier, bestAvailable: bestTool.name };
    } else {
      return {
        ok: false,
        reason: `requires ${requiredTier} tier, best available is ${toolTier}`,
        requiredTier,
        bestAvailable: bestTool.name
      };
    }
  }

  /**
   * Rule 2: Check unsafe conditions - lava adjacency, fall risk, suffocation, falling blocks above
   * Returns { ok: boolean, reason: string, checks: object }
   */
  checkUnsafe(block) {
    const checks = {
      lavaAdjacent: false,
      waterAdjacent: false,
      fallRisk: false,
      suffocation: false,
      fallingBlockAbove: false
    };

    const pos = block.position;

    // Check 6 adjacent blocks for lava/water
    const adjacentOffsets = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1]
    ];

    for (const [dx, dy, dz] of adjacentOffsets) {
      const adjBlock = this.bot.blockAt(pos.offset(dx, dy, dz));
      if (adjBlock) {
        if (this.lavaBlocks.has(adjBlock.name)) {
          checks.lavaAdjacent = true;
        }
        if (adjBlock.name === 'water' || adjBlock.name === 'flowing_water') {
          checks.waterAdjacent = true;
        }
      }
    }

    // Check diagonal if strict adjacency check enabled
    if (this.config.mining?.strictAdjacencyCheck) {
      const diagonalOffsets = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 3) continue; // corners
            if (Math.abs(dx) === 1 && Math.abs(dy) === 1 && Math.abs(dz) === 1) continue; // corners
            diagonalOffsets.push([dx, dy, dz]);
          }
        }
      }
      for (const [dx, dy, dz] of diagonalOffsets) {
        const adjBlock = this.bot.blockAt(pos.offset(dx, dy, dz));
        if (adjBlock && this.lavaBlocks.has(adjBlock.name)) {
          checks.lavaAdjacent = true;
        }
      }
    }

    // Fall risk: check if mining this block would create a fall > maxSafeFallBlocks
    // The bot would end up standing at the target block's position after mining
    const belowTarget = this.bot.blockAt(pos.offset(0, -1, 0));
    if (!belowTarget || belowTarget.type === 0) {
      // Check how far down the next solid block is
      let fallDistance = 1;
      for (let y = -2; y >= -this.config.mining?.maxSafeFallBlocks || 3; y--) {
        const b = this.bot.blockAt(pos.offset(0, y, 0));
        if (b && b.type !== 0) break;
        fallDistance++;
      }
      if (fallDistance > (this.config.mining?.maxSafeFallBlocks || 3)) {
        checks.fallRisk = true;
      }
    }

    // Suffocation: check if bot is inside the block being mined
    const botPos = this.bot.entity.position;
    if (Math.floor(botPos.x) === pos.x &&
        Math.floor(botPos.y) === pos.y &&
        Math.floor(botPos.z) === pos.z) {
      checks.suffocation = true;
    }

    // Falling block above: check block directly above target
    const above = this.bot.blockAt(pos.offset(0, 1, 0));
    if (above && this.fallingBlocks.has(above.name)) {
      checks.fallingBlockAbove = true;
    }

    // Determine overall result
    const failReasons = [];
    if (checks.lavaAdjacent && !this.config.mining?.allowLavaAdjacentMining) {
      failReasons.push('lava adjacent');
    }
    if (checks.fallRisk) failReasons.push('fall risk');
    if (checks.suffocation) failReasons.push('would suffocate self');
    if (checks.fallingBlockAbove) failReasons.push('falling block above');

    return {
      ok: failReasons.length === 0,
      reason: failReasons.length > 0 ? failReasons.join(', ') : 'all checks passed',
      checks
    };
  }

  /**
   * Rule 2 + 3 combined: Check and equip the best available tool for the block
   * Returns { ok: boolean, tool: item|null, reason: string }
   */
  async checkAndEquipBestTool(block) {
    const blockInfo = this.mcData.blocks[block.type];
    if (!blockInfo || !blockInfo.harvestTools) {
      return { ok: true, tool: null, reason: 'no tool required' };
    }

    const requiredToolIds = Object.keys(blockInfo.harvestTools).map(Number);
    const bestTool = this._findBestToolForBlock(block, requiredToolIds);

    if (!bestTool) {
      return { ok: false, tool: null, reason: 'no suitable tool in inventory' };
    }

    // Check durability if configured
    if (this.config.mining?.avoidLowDurability) {
      const minDurability = this.config.mining?.minDurability || 10;
      // Note: mineflayer doesn't expose durability on item instances directly
      // This is a best-effort check - if item has .durability use it
      if (bestTool.durability !== undefined && bestTool.durability < minDurability) {
        console.log(`[mine] Warning: best tool ${bestTool.name} has low durability (${bestTool.durability})`);
      }
    }

    try {
      await this.bot.equip(bestTool, 'hand');
      return { ok: true, tool: bestTool, reason: `equipped ${bestTool.name}` };
    } catch (err) {
      return { ok: false, tool: null, reason: `failed to equip: ${err.message}` };
    }
  }

  /**
   * Vein mining: BFS to find adjacent same-type ore blocks (Rule 4 preferVeinMining)
   * Returns array of block positions to mine in order (closest first)
   */
  veinMine(startBlock, maxDepth = 2) {
    if (!this.config.mining?.preferVeinMining) return [startBlock.position];

    const targetName = startBlock.name;
    const visited = new Set();
    const queue = [{ pos: startBlock.position, depth: 0 }];
    const results = [startBlock.position];
    const maxResults = 20; // Limit to prevent runaway

    const key = (p) => `${p.x},${p.y},${p.z}`;
    visited.add(key(startBlock.position));

    const offsets = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1]
    ];

    while (queue.length > 0 && results.length < maxResults) {
      const { pos, depth } = queue.shift();
      if (depth >= maxDepth) continue;

      for (const [dx, dy, dz] of offsets) {
        const nextPos = pos.offset(dx, dy, dz);
        const k = key(nextPos);
        if (visited.has(k)) continue;
        visited.add(k);

        const block = this.bot.blockAt(nextPos);
        if (block && block.name === targetName) {
          results.push(nextPos);
          queue.push({ pos: nextPos, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * Find the best tool in inventory for a block given required tool IDs
   * Returns the item with the highest tier that meets requirements
   */
  _findBestToolForBlock(block, requiredToolIds) {
    const items = this.bot.inventory.items();
    let bestTool = null;
    let bestTierIndex = -1;

    for (const item of items) {
      if (requiredToolIds.includes(item.type)) {
        const tier = this._getToolTier(item.name);
        const tierIndex = this.tierOrder.indexOf(tier);
        if (tierIndex > bestTierIndex) {
          bestTierIndex = tierIndex;
          bestTool = item;
        }
      }
    }

    return bestTool;
  }

  /**
   * Get tool tier from item name (e.g., 'iron_pickaxe' -> 'iron')
   */
  _getToolTier(itemName) {
    const parts = itemName.split('_');
    return parts[0]; // wooden, stone, golden, iron, diamond, netherite
  }

  /**
   * Get minimum tier from a list of tool IDs
   */
  _getMinTierFromIds(toolIds) {
    let minTierIndex = Infinity;
    for (const id of toolIds) {
      const item = this.mcData.items[id];
      if (item) {
        const tier = this._getToolTier(item.name);
        const tierIndex = this.tierOrder.indexOf(tier);
        if (tierIndex < minTierIndex) minTierIndex = tierIndex;
      }
    }
    return minTierIndex !== Infinity ? this.tierOrder[minTierIndex] : 'unknown';
  }

  /**
   * Check if a tool tier meets the minimum required tier
   */
  _tierMeetsRequirement(toolTier, requiredTier) {
    const toolIdx = this.tierOrder.indexOf(toolTier);
    const reqIdx = this.tierOrder.indexOf(requiredTier);
    if (toolIdx === -1 || reqIdx === -1) return false;
    return toolIdx >= reqIdx;
  }
}

/**
 * Static reference array of hostile mob names (Minecraft 1.20.1)
 * Derived from minecraft-data entities with category 'Hostile mobs'
 * Per CLAUDE.md v3 "Combat" section
 */
const HOSTILE_MOB_LIST = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'phantom', 'drowned',
  'husk', 'stray', 'zombie_villager', 'piglin', 'piglin_brute',
  'zombified_piglin', 'blaze', 'ghast', 'magma_cube', 'silverfish',
  'vex', 'vindicator', 'pillager', 'ravager', 'evoker',
  'shulker', 'guardian', 'elder_guardian', 'warden',
  'ender_dragon', 'wither', 'wither_skeleton', 'hoglin',
  'zoglin', 'illusioner', 'giant', 'endermite', 'skeleton_horse',
  'zombie_horse'
];

/**
 * Check if an entity name is a hostile mob
 */
function isHostileMob(entityName) {
  return HOSTILE_MOB_LIST.includes(entityName);
}

/**
 * Find cave entrance near the bot
 * Per FORGE_RESEARCH.md "Cave Finding Strategy"
 * Returns array of candidate positions sorted by distance
 */
function findCaveEntrance(bot, maxRadius = 32) {
  const pos = bot.entity.position;
  const candidates = [];

  for (let x = -maxRadius; x <= maxRadius; x += 2) {
    for (let z = -maxRadius; z <= maxRadius; z += 2) {
      for (let y = -20; y <= 10; y++) {
        const absY = Math.floor(pos.y) + y;
        if (absY < 0 || absY > 60) continue;
        const block = bot.blockAt(pos.offset(x, y, z));
        if (block && block.name === 'air') {
          const below = bot.blockAt(pos.offset(x, y - 1, z));
          if (below && below.name !== 'air') {
            candidates.push({ x: pos.x + x, y: absY, z: pos.z + z });
          }
        }
      }
    }
  }

  return candidates.sort((a, b) =>
    bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
  );
}

// BlockManager is the default export for backward compatibility.
// Named exports: MiningRuleSet, HOSTILE_MOB_LIST, isHostileMob, findCaveEntrance
module.exports = Object.assign(BlockManager, {
  MiningRuleSet,
  HOSTILE_MOB_LIST,
  isHostileMob,
  findCaveEntrance
});