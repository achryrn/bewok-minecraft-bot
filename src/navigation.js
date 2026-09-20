const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock, GoalFollow, GoalXZ } = require('mineflayer-pathfinder').goals;

/**
 * NavigationController — wraps mineflayer-pathfinder with collision recovery,
 * stuck detection, and smart obstacle handling.
 *
 * Per CLAUDE.md v3 "Navigation and Collision Recovery" section.
 */
class NavigationController {
  constructor(bot, config = {}) {
    this.bot = bot;
    this.config = config;
    this._currentGoal = null;
    this._stuckTimer = null;
    this._lastPos = null;
    this._stuckCount = 0;
    this._recovering = false;
    this._stopped = false;
    this._pendingResolve = null;
    this._mcData = null;
  }

  /** Initialize pathfinder and load Movements. Call once on spawn. */
  init() {
    this._mcData = require('minecraft-data')(this.bot.version);
    this.bot.loadPlugin(pathfinder);
    this._updateMovements();
    this._listenPathUpdate();
  }

  /** Update Movements config — call on every spawn. */
  _updateMovements() {
    if (!this._mcData) this._mcData = require('minecraft-data')(this.bot.version);
    const mv = new Movements(this.bot, this._mcData);
    mv.allowParkour = true;
    mv.allow1BlockJump = true;
    mv.canDig = true;
    mv.allowSprinting = true;
    mv.canPlace = true;
    mv.digCost = 0;
    mv.placeCost = 0;
    mv.allowParkourPlacing = false;
    // Increase how far the bot considers "reachable" — avoids premature "noPath"
    mv.maxFallHeight = 8;
    this.bot.pathfinder.setMovements(mv);
  }

  /** Listen for pathfinder events (path_update, goal_reached). */
  _listenPathUpdate() {
    this.bot.on('path_update', (data) => {
      if (data.status === 'noPath' && this._pendingResolve && !this._recovering) {
        console.log('[nav] path_update: noPath — attempting recovery');
        this._recover();
      }
    });

    this.bot.on('goal_reached', () => {
      this._clearStuckTimer();
      this._stuckCount = 0;
      if (this._pendingResolve) {
        const r = this._pendingResolve;
        this._pendingResolve = null;
        r(true);
      }
    });
  }

  /**
   * Navigate to (x, y, z) with a given radius.
   * Returns Promise<boolean> — true if reached, false if gave up.
   */
  async goto(x, y, z, radius = 2) {
    if (this._stopped) return false;
    this._cancelCurrent();

    const goal = new GoalNear(x, y, z, radius);
    this._currentGoal = goal;
    this.bot.pathfinder.setGoal(goal);

    return this._awaitCompletion(30000);
  }

  /** Follow an entity. Returns false if entity invalid. */
  followEntity(entity, distance = 2) {
    if (!entity || !entity.position) return false;
    this._cancelCurrent();
    this._currentGoal = new GoalFollow(entity, distance);
    this.bot.pathfinder.setGoal(this._currentGoal, true);
    return true;
  }

  /** Stop all navigation. */
  stop() {
    this._stopped = true;
    this._clearStuckTimer();
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      r(false);
    }
    this.bot.pathfinder.setGoal(null);
    this._currentGoal = null;
  }

  /** Cancel current goal and resolve pending promise. */
  _cancelCurrent() {
    this._stopped = false;
    this._clearStuckTimer();
    this._stuckCount = 0;
    this._lastPos = null;
    this.bot.pathfinder.setGoal(null);
  }

  /** Wait for goal completion with stuck detection. */
  _awaitCompletion(timeoutMs) {
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      this._lastPos = { ...this.bot.entity.position };
      this._startStuckTimer();
    });
  }

  /** Start checking position every 2s for stuck detection. */
  _startStuckTimer() {
    this._clearStuckTimer();
    this._stuckTimer = setInterval(() => {
      if (!this.bot.entity || !this._pendingResolve) return;

      const pos = this.bot.entity.position;
      const dx = Math.abs(pos.x - this._lastPos.x);
      const dz = Math.abs(pos.z - this._lastPos.z);

      if (dx < 0.5 && dz < 0.5) {
        this._stuckCount++;
        console.log(`[nav] Stuck check ${this._stuckCount}/6 — moved <0.5 blocks`);

        if (this._stuckCount >= 6 && !this._recovering) {
          // 12s with no real movement → stuck
          console.log('[nav] Stuck detected — attempting recovery');
          this._recover();
        }
      } else {
        // Movement detected, reset counter
        this._stuckCount = 0;
      }
      this._lastPos = { x: pos.x, y: pos.y, z: pos.z };
    }, 2000);
  }

  _clearStuckTimer() {
    if (this._stuckTimer) {
      clearInterval(this._stuckTimer);
      this._stuckTimer = null;
    }
  }

  /** Recovery sequence: jump → recompute → dig → random point → give up. */
  async _recover() {
    if (this._recovering) return;
    this._recovering = true;
    this._clearStuckTimer();

    try {
      // Step 1: Jump to clear 1-block obstacles
      console.log('[nav] Recovery: jump');
      this.bot.setControlState('jump', true);
      await this._sleep(400);
      this.bot.setControlState('jump', false);

      // Step 2: Recompute goal
      if (this._currentGoal) {
        console.log('[nav] Recovery: recompute path');
        this.bot.pathfinder.setGoal(this._currentGoal);
        // Wait and check if moving
        await this._sleep(2000);

        const pos = this.bot.entity.position;
        const dx = Math.abs(pos.x - this._lastPos.x);
        const dz = Math.abs(pos.z - this._lastPos.z);

        if (dx > 0.5 || dz > 0.5) {
          // Moving again — done
          this._recovering = false;
          this._startStuckTimer();
          return;
        }
      }

      // Step 3: Dig block directly in front if obstructed
      console.log('[nav] Recovery: check for obstructing block');
      try {
        const front = this.bot.blockAt(this.bot.entity.position.offset(
          Math.round(Math.sin(this.bot.entity.yaw)), 0,
          Math.round(-Math.cos(this.bot.entity.yaw))
        ));
        if (front && front.type !== 0) {
          await this.bot.dig(front);
          console.log('[nav] Recovery: dug obstructing block');
        }
      } catch (_) {}

      // Step 4: Pick random reachable point 5-10 blocks away, path there
      if (this._currentGoal) {
        console.log('[nav] Recovery: try random midpoint');
        const pos = this.bot.entity.position;
        for (let attempt = 0; attempt < 5; attempt++) {
          const rx = pos.x + (Math.random() - 0.5) * 16;
          const rz = pos.z + (Math.random() - 0.5) * 16;
          const target = this.bot.blockAt({ x: Math.floor(rx), y: Math.floor(pos.y), z: Math.floor(rz) });
          if (target && target.type !== 0) {
            const tempGoal = new GoalNear(rx, pos.y, rz, 3);
            this.bot.pathfinder.setGoal(tempGoal);
            await this._sleep(3000);
            break;
          }
        }
      }

      // Step 5: Re-set original goal
      if (this._currentGoal) {
        console.log('[nav] Recovery: retry original goal');
        this.bot.pathfinder.setGoal(this._currentGoal);
        this._startStuckTimer();
      }

      // Reset recovery flag — if stuck again, will retry
      this._stuckCount = 0;
    } catch (err) {
      console.log('[nav] Recovery error:', err.message);
    }

    this._recovering = false;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = NavigationController;
