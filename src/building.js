const Vec3 = require('vec3');

class BuildController {
  /**
   * @param {object} bot - mineflayer bot instance
   * @param {object} movementManager - MovementManager from src/movement.js
   * @param {object} inventoryManager - InventoryManager from src/inventory.js
   * @param {object} config - bot config object
   */
  constructor(bot, movementManager, inventoryManager, config) {
    this.bot = bot;
    this.movement = movementManager;
    this.inventory = inventoryManager;
    this.config = config;
  }

  /**
   * Pure: compute block positions for a shape.
   * No bot dependency — testable in isolation.
   *
   * @param {object} args - shape arguments { shape, width, length, height, hollow }
   * @param {{ x: number, y: number, z: number }} origin - resolved origin coordinates
   * @returns {{ x: number, y: number, z: number }[]}
   */
  static computePositions(args, origin) {
    const shape = args.shape || 'platform';
    const width = Math.max(1, args.width || 1);
    const length = Math.max(1, args.length || 1);
    const height = Math.max(1, args.height || 1);
    const hollow = args.hollow !== false;

    const positions = [];
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;

    switch (shape) {
      case 'platform': {
        // Flat rectangle at origin.y, centered horizontally on origin
        const startX = ox - Math.floor((width - 1) / 2);
        const startZ = oz - Math.floor((length - 1) / 2);
        for (let dx = 0; dx < width; dx++) {
          for (let dz = 0; dz < length; dz++) {
            positions.push({ x: startX + dx, y: oy, z: startZ + dz });
          }
        }
        break;
      }

      case 'wall': {
        // Vertical rectangle at origin.z, centered horizontally on ox,
        // starting at origin.y, going up
        const startX = ox - Math.floor((width - 1) / 2);
        for (let dx = 0; dx < width; dx++) {
          for (let dy = 0; dy < height; dy++) {
            positions.push({ x: startX + dx, y: oy + dy, z: oz });
          }
        }
        break;
      }

      case 'cube': {
        // Box centered on origin. Hollow by default — only surface blocks.
        const startX = ox - Math.floor((width - 1) / 2);
        const startY = oy - Math.floor((height - 1) / 2);
        const startZ = oz - Math.floor((length - 1) / 2);
        for (let dx = 0; dx < width; dx++) {
          for (let dz = 0; dz < length; dz++) {
            for (let dy = 0; dy < height; dy++) {
              if (hollow && dx > 0 && dx < width - 1 &&
                  dz > 0 && dz < length - 1 &&
                  dy > 0 && dy < height - 1) {
                continue; // skip interior air
              }
              positions.push({ x: startX + dx, y: startY + dy, z: startZ + dz });
            }
          }
        }
        break;
      }

      case 'pillar': {
        // Single column at origin, going up
        for (let dy = 0; dy < height; dy++) {
          positions.push({ x: ox, y: oy + dy, z: oz });
        }
        break;
      }

      default:
        throw new Error(`Unknown build shape: ${shape}`);
    }

    return positions;
  }

  /**
   * Build the shape by placing blocks.
   * Checks inventory before starting, navigates to each position,
   * places against a reference block, retries once on failure.
   *
   * @param {object} args - shape arguments { shape, material, width, length, height, hollow, origin }
   * @param {Function} [shouldContinue] - callback returning boolean, checked before each placement
   * @returns {Promise<{ placed: number, skipped: number, failureReason: string|null }>}
   */
  async buildShape(args, shouldContinue) {
    const material = args.material;
    if (!material || typeof material !== 'string') {
      console.log('[build] No material specified');
      return { placed: 0, skipped: 0, failureReason: 'No material specified' };
    }

    const origin = this._resolveOrigin(args.origin);
    if (!origin) {
      const msg = 'Could not resolve origin — bot not spawned?';
      console.log(`[build] ${msg}`);
      return { placed: 0, skipped: 0, failureReason: msg };
    }

    let positions;
    try {
      positions = BuildController.computePositions(args, origin);
    } catch (err) {
      const msg = `Shape computation error: ${err.message}`;
      console.log(`[build] ${msg}`);
      return { placed: 0, skipped: 0, failureReason: msg };
    }

    if (positions.length === 0) {
      console.log('[build] No positions to build');
      return { placed: 0, skipped: 0, failureReason: null };
    }

    console.log(`[build] Starting build — shape: ${args.shape}, material: ${material}, positions: ${positions.length}`);

    const availableCount = this.inventory ? this.inventory.count(material) : 0;
    if (availableCount < positions.length) {
      const needMore = positions.length - availableCount;
      const msg = `Need ${material} — have ${availableCount}, need ${needMore} more`;
      console.log(`[build] ${msg}`);
      return { placed: 0, skipped: 0, failureReason: msg };
    }

    const botPos = this.bot.entity ? this.bot.entity.position : { x: 0, y: 0, z: 0 };
    const ordered = this._getPlacementOrder(positions, botPos);

    let placed = 0;
    let skipped = 0;
    let failureReason = null;

    for (const posP of ordered) {
      if (shouldContinue && typeof shouldContinue === 'function' && !shouldContinue()) {
        failureReason = 'cancelled';
        console.log(`[build] Build cancelled — placed ${placed}/${positions.length}`);
        break;
      }

      // Skip already-occupied positions
      try {
        const existing = this.bot.blockAt(new Vec3(posP.x, posP.y, posP.z));
        if (existing && existing.type !== 0 && existing.type !== -1) {
          console.log(`[build] Position (${posP.x},${posP.y},${posP.z}) already occupied — skipping`);
          continue;
        }
      } catch (e) {
        // blockAt failed (unloaded chunk, etc.) — try to place anyway
      }

      // Navigate within reach of the target
      const moved = await this._moveNearTarget(posP);
      if (!moved) {
        console.log(`[build] Cannot reach (${posP.x},${posP.y},${posP.z}) — skipping`);
        skipped++;
        continue;
      }

      // Equip the building material
      if (this.inventory) {
        const equipped = await this.inventory.equipItem(material, 'hand');
        if (!equipped) {
          console.log(`[build] Cannot equip ${material}`);
          skipped++;
          continue;
        }
      }

      // Find an existing block adjacent to the target to place against
      const refInfo = this._findReferenceBlock(posP);
      if (!refInfo) {
        console.log(`[build] No reference block adjacent to (${posP.x},${posP.y},${posP.z}) — skipping`);
        skipped++;
        continue;
      }

      // Place the block, retrying once on failure
      const ok = await this._placeWithRetry(posP, refInfo);
      if (ok) {
        placed++;
        console.log(`[build] Placed ${material} at (${posP.x},${posP.y},${posP.z})`);
      } else {
        console.log(`[build] Failed to place ${material} at (${posP.x},${posP.y},${posP.z}) — skipping`);
        skipped++;
      }
    }

    const result = { placed, skipped, failureReason };
    console.log(`[build] Build complete — placed: ${placed}/${positions.length}, skipped: ${skipped}, failure: ${failureReason || 'none'}`);
    return result;
  }

  /**
   * Attempt to place a block at posP using refInfo.
   * Retries once with a different reference block if the first attempt fails.
   *
   * @param {{ x, y, z }} posP
   * @param {{ referenceBlock: object, faceVector: Vec3 }} refInfo
   * @returns {Promise<boolean>}
   */
  async _placeWithRetry(posP, refInfo) {
    try {
      await this.bot.lookAt(new Vec3(posP.x + 0.5, posP.y + 0.5, posP.z + 0.5));
      await this.bot.placeBlock(refInfo.referenceBlock, refInfo.faceVector);
      return true;
    } catch (err) {
      console.log(`[build] First placement failed at (${posP.x},${posP.y},${posP.z}): ${err.message} — retrying`);
      // Try a different reference block if available
      const altRef = this._findReferenceBlock(posP, refInfo.referenceBlock.position);
      if (altRef) {
        try {
          await this.bot.lookAt(new Vec3(posP.x + 0.5, posP.y + 0.5, posP.z + 0.5));
          await this.bot.placeBlock(altRef.referenceBlock, altRef.faceVector);
          return true;
        } catch (err2) {
          console.log(`[build] Retry failed at (${posP.x},${posP.y},${posP.z}): ${err2.message}`);
        }
      } else {
        console.log(`[build] No alternative reference block for retry at (${posP.x},${posP.y},${posP.z})`);
      }
      return false;
    }
  }

  /**
   * Resolve the origin argument to { x, y, z }.
   * "bot" (or null/undefined) → use bot's current position, floored.
   * { x, y, z } object → use directly, floored.
   *
   * @param {string|object|null} originArg
   * @returns {{ x: number, y: number, z: number }|null}
   */
  _resolveOrigin(originArg) {
    if (!originArg || originArg === 'bot') {
      if (!this.bot.entity || !this.bot.entity.position) return null;
      const p = this.bot.entity.position;
      return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    }
    if (typeof originArg === 'object' && originArg.x !== undefined) {
      return {
        x: Math.floor(originArg.x),
        y: Math.floor(originArg.y),
        z: Math.floor(originArg.z),
      };
    }
    return null;
  }

  /**
   * Find an existing non-air block adjacent to the target position to place against.
   * Checks all 6 faces: below, above, west, east, north, south.
   *
   * @param {{ x, y, z }} pos - target position
   * @param {{ x, y, z }} [excludePos] - optional position to exclude (for retry with a different face)
   * @returns {{ referenceBlock: object, faceVector: Vec3 }|null}
   */
  _findReferenceBlock(pos, excludePos) {
    const offsets = [
      { d: { x: 0, y: -1, z: 0 }, dir: { x: 0, y: 1, z: 0 } },   // below → place up
      { d: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: -1, z: 0 } },   // above → place down
      { d: { x: -1, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 } },   // west  → place east
      { d: { x: 1, y: 0, z: 0 }, dir: { x: -1, y: 0, z: 0 } },   // east  → place west
      { d: { x: 0, y: 0, z: -1 }, dir: { x: 0, y: 0, z: 1 } },   // north → place south
      { d: { x: 0, y: 0, z: 1 }, dir: { x: 0, y: 0, z: -1 } },   // south → place north
    ];

    for (const offset of offsets) {
      const adjPos = new Vec3(pos.x + offset.d.x, pos.y + offset.d.y, pos.z + offset.d.z);
      if (excludePos && adjPos.x === excludePos.x && adjPos.y === excludePos.y && adjPos.z === excludePos.z) {
        continue;
      }
      try {
        const block = this.bot.blockAt(adjPos);
        if (block && block.type !== 0 && block.type !== -1) {
          return {
            referenceBlock: block,
            faceVector: new Vec3(offset.dir.x, offset.dir.y, offset.dir.z),
          };
        }
      } catch (_) {
        // block not loaded or error — try next face
      }
    }

    return null;
  }

  /**
   * Navigate within placing reach of a target position.
   * Uses the movement manager's goTo with a 4-block radius.
   */
  async _moveNearTarget(pos) {
    if (!this.movement) {
      console.log('[build] No movement manager available');
      return false;
    }
    const targetVec = new Vec3(pos.x, pos.y, pos.z);
    try {
      const botPos = this.bot.entity ? this.bot.entity.position : null;
      if (botPos) {
        const dist = botPos.distanceTo(targetVec);
        if (dist <= 4.5) return true;
      }
      return await this.movement.goTo(pos.x, pos.y, pos.z, 4);
    } catch (err) {
      console.log(`[build] Movement error to (${pos.x},${pos.y},${pos.z}): ${err.message}`);
      return false;
    }
  }

  /**
   * Order positions for safe, non-trapping building.
   * Strategy: build from bottom to top, and for same y-level,
   * place farthest blocks first so the bot walks outward then back.
   *
   * @param {{x,y,z}[]} positions
   * @param {{x,y,z}} botPos
   * @returns {{x,y,z}[]}
   */
  _getPlacementOrder(positions, botPos) {
    const sorted = [...positions].sort((a, b) => {
      // Bottom-up
      if (a.y !== b.y) return a.y - b.y;
      // Same y-level: farthest from bot first
      const distA = Math.hypot(a.x - botPos.x, a.z - botPos.z);
      const distB = Math.hypot(b.x - botPos.x, b.z - botPos.z);
      return distB - distA;
    });
    return sorted;
  }
}

module.exports = BuildController;
