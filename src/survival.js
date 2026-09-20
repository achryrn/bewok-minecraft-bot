const EventEmitter = require('events');

// Directly hostile mobs - always attack on sight
const ALWAYS_HOSTILE = new Set([
  'blaze', 'creeper', 'drowned', 'elder_guardian', 'evoker',
  'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube',
  'phantom', 'pillager', 'ravager', 'shulker', 'silverfish',
  'skeleton', 'slime', 'stray', 'vex', 'vindicator',
  'warden', 'witch', 'zoglin', 'zombie', 'zombie_villager',
  'zombified_piglin',
]);

// Conditionally hostile - hostile when provoked or under specific game conditions
const CONDITIONALLY_HOSTILE = new Set([
  'bee', 'cave_spider', 'enderman', 'iron_golem', 'llama',
  'panda', 'piglin', 'polar_bear', 'spider', 'trader_llama',
  'wolf',
]);

// Combined set for lookup
const HOSTILE_MOB_NAMES = new Set([...ALWAYS_HOSTILE, ...CONDITIONALLY_HOSTILE]);

// Maximum tries to find a safe flee direction before giving up
const MAX_FLEE_DIRECTION_TRIES = 12;

// How far to flee in blocks each step
const FLEE_DISTANCE = 20;

class SurvivalController extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} config - full bot config (survival nested under config.survival)
   * @param {object} combatController - instance with stop(), attackMob(name), isAttacking() methods
   * @param {object} navigationController - instance with goto(x,y,z,opts), stop() methods
   */
  constructor(bot, config, combatController, navigationController) {
    super();
    this.bot = bot;
    this.config = config;
    this.combatController = combatController;
    this.navigationController = navigationController;

    // Derive survival config with safe defaults for any missing keys
    const userSurvival = (config && config.survival) || {};
    this._cfg = {
      autoEngageHostiles: true,
      engageRadius: 8,
      fleeHealthThreshold: 6,
      fleeStrategy: 'run',
      autoEat: true,
      eatThreshold: 18,
      ...userSurvival,
    };

    this._running = false;
    this._isFleeing = false;
    this._fleeTarget = null;
    this._storedFleeTarget = null;

    // Interval handles
    this._autoEngageInterval = null;
    this._healthPollInterval = null;
    this._fleePollInterval = null;
    this._hazardInterval = null;

    // Bound listeners so we can remove them cleanly
    this._boundOnHealth = this._onHealth.bind(this);
  }

  /* ----- Lifecycle ----- */

  /**
   * Start all survival monitoring.
   * Safe to call multiple times - second call is a no-op.
   */
  start() {
    if (this._running) return;
    this._running = true;

    console.log('[survival] Starting SurvivalController');

    if (this._cfg.autoEngageHostiles) {
      console.log(`[survival] Auto-engage hostiles enabled - radius: ${this._cfg.engageRadius} blocks`);
      this._startAutoEngage();
    } else {
      console.log('[survival] Auto-engage hostiles disabled by config');
    }

    if (this._cfg.autoEat) {
      console.log(`[survival] Auto-eat enabled - threshold: ${this._cfg.eatThreshold}/20`);
    } else {
      console.log('[survival] Auto-eat disabled by config');
    }

    this.bot.on('health', this._boundOnHealth);
    this._healthPollInterval = setInterval(() => this._onHealth(), 2000);
    this._startHazardChecking();

    console.log('[survival] SurvivalController started');
    this.emit('started');
  }

  /**
   * Stop all survival monitoring and clear any flee state.
   * Safe to call multiple times - subsequent calls are no-op.
   */
  stop() {
    if (!this._running) return;
    this._running = false;

    this._clearAllIntervals();
    this.bot.removeListener('health', this._boundOnHealth);

    this._isFleeing = false;
    this._fleeTarget = null;
    this._storedFleeTarget = null;

    console.log('[survival] SurvivalController stopped');
    this.emit('stopped');
  }

  /** Clear every owned interval handle. */
  _clearAllIntervals() {
    for (const key of ['_autoEngageInterval', '_healthPollInterval', '_fleePollInterval', '_hazardInterval']) {
      if (this[key]) {
        clearInterval(this[key]);
        this[key] = null;
      }
    }
  }

  /* ----- Auto-engage hostiles ----- */

  _startAutoEngage() {
    if (this._autoEngageInterval) clearInterval(this._autoEngageInterval);
    this._autoEngageInterval = setInterval(() => this._tickAutoEngage(), 1000);
  }

  _tickAutoEngage() {
    if (!this._running) return;
    if (!this._cfg.autoEngageHostiles) return;

    // Fleeing takes priority - do not engage while running
    if (this._isFleeing) return;

    // Health too low to fight
    if ((this.bot.health || 20) <= this._cfg.fleeHealthThreshold) return;

    const hostile = this._findNearestHostile(this._cfg.engageRadius);
    if (!hostile) return;

    // Already fighting this or another target
    if (this.combatController && typeof this.combatController.isAttacking === 'function') {
      if (this.combatController.isAttacking()) return;
    }

    const dist = this.bot.entity.position.distanceTo(hostile.position);
    const name = hostile.name || hostile.displayName || 'hostile';
    console.log(`[survival] Auto-engage: ${name} at distance ${dist.toFixed(1)}`);

    // Emit so brain can log or decide to interrupt its current task
    this.emit('autoEngage', {
      entity: hostile,
      name,
      distance: dist,
      position: { x: hostile.position.x, y: hostile.position.y, z: hostile.position.z },
    });

    if (this.combatController && typeof this.combatController.attackMob === 'function') {
      this.combatController.attackMob(name);
    }
  }

  /* ----- Flee / Fight decision ----- */

  /** Called on bot 'health' event and on a 2s poll interval. */
  _onHealth() {
    if (!this._running) return;
    this._evaluateFleeFight();
  }

  _evaluateFleeFight() {
    const health = this.bot.health || 20;
    const threshold = this._cfg.fleeHealthThreshold;

    // Health above threshold - stop fleeing if we were
    if (health > threshold) {
      if (this._isFleeing) {
        console.log(`[survival] Health recovered (${Math.floor(health)}/20) - stopping flee`);
        this._stopFleeing();
        this.emit('healthRecovered', { health: Math.floor(health) });
      }
      return;
    }

    // Health at or below threshold
    if (this._cfg.fleeStrategy === 'fight') {
      this._handleFightResponse(health);
    } else {
      // 'run' - default
      this._handleFleeResponse(health);
    }
  }

  _handleFightResponse(health) {
    const nearest = this._findNearestHostile(32);
    const info = nearest
      ? `${nearest.name || 'mob'} at ${this.bot.entity.position.distanceTo(nearest.position).toFixed(1)}`
      : 'unknown';

    if (!this._isFleeing) {
      console.log(`[survival] Health low (${Math.floor(health)}/20) - fighting ${info}`);
      this.emit('fight', { health: Math.floor(health), threat: info });

      if (nearest && this.combatController && typeof this.combatController.attackMob === 'function') {
        this.combatController.attackMob(nearest.name || null);
      }
    }
  }

  _handleFleeResponse(health) {
    const nearest = this._findNearestHostile(32);
    const info = nearest
      ? `${nearest.name || 'mob'} at ${this.bot.entity.position.distanceTo(nearest.position).toFixed(1)}`
      : 'unknown';

    if (!this._isFleeing) {
      console.log(`[survival] Health low (${Math.floor(health)}/20) - fleeing from ${info}`);
      this.emit('flee', { health: Math.floor(health), from: nearest });

      // Stop any active combat before running
      if (this.combatController && typeof this.combatController.stop === 'function') {
        this.combatController.stop();
      }

      this._beginFlee(nearest);
    }
  }

  _beginFlee(fromEntity) {
    this._isFleeing = true;
    this._fleeTarget = this._pickFleeDestination(fromEntity);

    console.log(`[survival] Fleeing toward (${this._fleeTarget.x}, ${this._fleeTarget.y}, ${this._fleeTarget.z})`);

    // Start a tighter poll so the bot adjusts flee direction as it moves
    if (this._fleePollInterval) clearInterval(this._fleePollInterval);
    this._fleePollInterval = setInterval(() => this._tickFlee(), 2000);

    // First move immediately
    this._tickFlee();
  }

  _tickFlee() {
    if (!this._isFleeing || !this._running) return;

    // Double-check health - may have recovered while interval was queued
    if ((this.bot.health || 20) > this._cfg.fleeHealthThreshold) {
      console.log(`[survival] Health recovered (${Math.floor(this.bot.health)}/20) - stopping flee`);
      this._stopFleeing();
      this.emit('healthRecovered', { health: Math.floor(this.bot.health) });
      return;
    }

    // Re-evaluate threat position
    const nearest = this._findNearestHostile(32);
    if (nearest) {
      this._fleeTarget = this._pickFleeDestination(nearest);
    }

    if (this.navigationController && typeof this.navigationController.goto === 'function') {
      this.navigationController.goto(this._fleeTarget.x, this._fleeTarget.y, this._fleeTarget.z, { timeout: 5000 });
    }
  }

  _stopFleeing() {
    this._isFleeing = false;
    this._fleeTarget = null;

    if (this._fleePollInterval) {
      clearInterval(this._fleePollInterval);
      this._fleePollInterval = null;
    }

    if (this.navigationController && typeof this.navigationController.stop === 'function') {
      this.navigationController.stop();
    }
  }

  /**
   * Pick a safe destination away from a threat entity.
   * Tries several directions biased away from the threat; falls back
   * to moving upward if no ground-level direction is safe.
   */
  _pickFleeDestination(fromEntity) {
    const botPos = this.bot.entity.position;

    // Default direction if no threat
    let awayX = 1, awayZ = 0;

    if (fromEntity && fromEntity.position) {
      const dx = botPos.x - fromEntity.position.x;
      const dz = botPos.z - fromEntity.position.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.01) {
        awayX = dx / len;
        awayZ = dz / len;
      }
    }

    for (let i = 0; i < MAX_FLEE_DIRECTION_TRIES; i++) {
      // Spread tries around the away vector, narrowing spread each time
      const spread = 1.5 * (1 - i / MAX_FLEE_DIRECTION_TRIES) + 0.3;
      const angle = (Math.random() - 0.5) * spread;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dirX = awayX * cos - awayZ * sin;
      const dirZ = awayX * sin + awayZ * cos;

      const candidate = {
        x: Math.floor(botPos.x + dirX * FLEE_DISTANCE),
        y: Math.floor(botPos.y),
        z: Math.floor(botPos.z + dirZ * FLEE_DISTANCE),
      };

      if (this._isPositionSafe(candidate)) {
        return candidate;
      }
    }

    // Last resort - go upward (may pillar or climb)
    return { x: Math.floor(botPos.x), y: Math.floor(botPos.y + 6), z: Math.floor(botPos.z) };
  }

  /* ----- Hazard detection & avoidance ----- */

  _startHazardChecking() {
    if (this._hazardInterval) clearInterval(this._hazardInterval);
    this._hazardInterval = setInterval(() => this._tickHazardCheck(), 3000);
  }

  _tickHazardCheck() {
    if (!this._running) return;
    const pos = this.bot.entity.position;
    const blockHere = this.bot.blockAt(pos);
    const blockBelow = this.bot.blockAt(pos.offset(0, -1, 0));

    // Void
    if (pos.y < -64) {
      console.log(`[survival] Hazard: void below at y=${Math.floor(pos.y)}`);
      this.emit('hazardDetected', { type: 'void', x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
      this._escapeVoid();
      return;
    }

    // Standing in lava
    if (blockHere && (blockHere.name === 'lava' || blockHere.name === 'flowing_lava')) {
      console.log(`[survival] Hazard: standing in lava at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`);
      this.emit('hazardDetected', { type: 'lava', x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
      this._escapeLava();
      return;
    }

    // Standing directly above lava
    if (blockBelow && (blockBelow.name === 'lava' || blockBelow.name === 'flowing_lava')) {
      if (!this._isFleeing) {
        console.log(`[survival] Hazard: above lava at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`);
        this.emit('hazardDetected', { type: 'lava_near', x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
        // Move away from the lava block
        this._fleeFromPosition({ x: pos.x, y: pos.y - 1, z: pos.z });
      }
    }
  }

  _escapeVoid() {
    this.bot.setControlState('jump', true);
    setTimeout(() => this.bot.setControlState('jump', false), 600);
  }

  _escapeLava() {
    // Jump to reduce damage ticks
    this.bot.setControlState('jump', true);
    setTimeout(() => this.bot.setControlState('jump', false), 1000);

    // Find nearest non-lava block and move there
    const pos = this.bot.entity.position;
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dy = -1; dy <= 2; dy++) {
          const check = this.bot.blockAt(pos.offset(dx, dy, dz));
          if (check && check.name !== 'air' && !check.name.includes('lava') && !check.name.includes('water')) {
            if (this.navigationController && typeof this.navigationController.goto === 'function') {
              this.navigationController.goto(check.position.x, check.position.y, check.position.z, { timeout: 5000 });
              return;
            }
          }
        }
      }
    }
  }

  /** Move away from a specific dangerous position. */
  _fleeFromPosition(dangerPos) {
    const botPos = this.bot.entity.position;
    const dx = botPos.x - dangerPos.x;
    const dz = botPos.z - dangerPos.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const target = {
      x: Math.floor(botPos.x + (dx / len) * 5),
      y: Math.floor(botPos.y),
      z: Math.floor(botPos.z + (dz / len) * 5),
    };
    if (this._isPositionSafe(target) && this.navigationController && typeof this.navigationController.goto === 'function') {
      this.navigationController.goto(target.x, target.y, target.z, { timeout: 5000 });
    }
  }

  /* ----- Public safety utility ----- */

  /**
   * Check whether a destination position is safe to path to.
   * Used by NavigationController before committing to a path.
   *
   * @param {{x: number, y: number, z: number}} position
   * @returns {{safe: boolean, reason: string|null}}
   */
  checkPathSafety(position) {
    if (!position) return { safe: false, reason: 'No position given' };

    if (position.y < -64) {
      return { safe: false, reason: `Destination y=${position.y} is in the void` };
    }

    try {
      const block = this.bot.blockAt(position);
      if (block && (block.name === 'lava' || block.name === 'flowing_lava')) {
        return { safe: false, reason: 'Destination is lava' };
      }
      const below = this.bot.blockAt({ x: position.x, y: position.y - 1, z: position.z });
      if (below && (below.name === 'lava' || below.name === 'flowing_lava')) {
        return { safe: false, reason: 'Block below destination is lava' };
      }
    } catch {
      // Cannot read world state - assume safe rather than blocking movement
    }

    return { safe: true, reason: null };
  }

  /* ----- Hostile detection helpers ----- */

  /**
   * Check if an entity is a hostile mob.
   * Uses both the static name list and entity.kind from minecraft-data.
   *
   * @param {object} entity - mineflayer entity object
   * @returns {boolean}
   */
  _isHostile(entity) {
    if (!entity || entity.type !== 'mob') return false;

    const name = (entity.name || entity.displayName || '').toLowerCase();

    if (HOSTILE_MOB_NAMES.has(name)) return true;

    // entity.kind is set by mineflayer from minecraft-data entity categories
    if (entity.kind) {
      const kind = String(entity.kind).toLowerCase();
      if (kind === 'hostile' || kind === 'monster' || kind === 'boss') return true;
    }

    return false;
  }

  /**
   * Find the nearest hostile mob within maxDistance blocks.
   *
   * @param {number} maxDistance
   * @returns {object|null} mineflayer entity or null
   */
  _findNearestHostile(maxDistance) {
    try {
      const entities = Object.values(this.bot.entities || {});
      let best = null;
      let bestDist = maxDistance;

      for (const entity of entities) {
        if (entity === this.bot.entity) continue;
        if (!entity.position) continue;
        if (entity.dead) continue;
        if (!this._isHostile(entity)) continue;

        const dist = this.bot.entity.position.distanceTo(entity.position);
        if (dist < bestDist) {
          bestDist = dist;
          best = entity;
        }
      }

      return best;
    } catch {
      return null;
    }
  }

  /* ----- Position safety check ----- */

  /**
   * Check whether a block position is safe to stand on.
   *
   * @param {{x: number, y: number, z: number}} position
   * @returns {boolean}
   */
  _isPositionSafe(position) {
    if (position.y < -64) return false;

    try {
      const block = this.bot.blockAt(position);
      if (block && (block.name === 'lava' || block.name === 'flowing_lava')) return false;

      const belowBlock = this.bot.blockAt({ x: position.x, y: position.y - 1, z: position.z });
      if (belowBlock && (belowBlock.name === 'lava' || belowBlock.name === 'flowing_lava')) return false;
    } catch {
      // Assume safe if we can't read world state
    }

    return true;
  }

  /* ----- Public query API ----- */

  /**
   * Returns a list of nearby hostile mobs for inclusion in brain state.
   *
   * @param {number} [radius=32]
   * @returns {Array<{name: string, distance: number}>}
   */
  getNearbyHostiles(radius = 32) {
    try {
      const result = [];
      const entities = Object.values(this.bot.entities || {});

      for (const entity of entities) {
        if (entity === this.bot.entity) continue;
        if (!entity.position) continue;
        if (!this._isHostile(entity)) continue;

        const dist = this.bot.entity.position.distanceTo(entity.position);
        if (dist <= radius) {
          result.push({
            name: entity.name || entity.displayName || 'unknown',
            distance: Math.round(dist * 10) / 10,
          });
        }
      }

      result.sort((a, b) => a.distance - b.distance);
      return result;
    } catch {
      return [];
    }
  }

  /**
   * Whether the bot is currently fleeing.
   * @returns {boolean}
   */
  isFleeing() {
    return this._isFleeing;
  }
}

module.exports = SurvivalController;
