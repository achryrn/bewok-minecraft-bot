const EventEmitter = require('events');

class CombatManager extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this.target = null;
    this.fighting = false;
    this.autoAttackEnabled = false;
    this.attackRange = 4.5;
  }

  async attackEntity(entity) {
    if (!entity) return false;
    if (entity.kind === 'object' || entity.type === 'object') return false;

    try {
      await this.bot.lookAt(entity.position.offset(0, 1, 0), true);
      this.bot.attack(entity);
      this.target = entity;
      return true;
    } catch (err) {
      return false;
    }
  }

  async kill(entity) {
    if (!entity || !entity.position) return false;

    this.target = entity;
    this.fighting = true;

    try {
      while (this.fighting && entity && entity.isValid && !entity.dead) {
        const distance = this.bot.entity.position.distanceTo(entity.position);

        if (distance > this.attackRange) {
          await this.bot.lookAt(entity.position.offset(0, 1, 0), true);
          // Move closer if too far
          const { GoalFollow } = require('mineflayer-pathfinder').goals;
          this.bot.pathfinder.setGoal(new GoalFollow(entity, 2), true);
          await new Promise(resolve => setTimeout(resolve, 200));
        } else {
          await this.bot.lookAt(entity.position.offset(0, 1, 0), true);
          this.bot.attack(entity);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      return true;
    } catch (err) {
      this.fighting = false;
      return false;
    } finally {
      this.fighting = false;
      this.bot.pathfinder.setGoal(null);
    }
  }

  stop() {
    this.fighting = false;
    this.target = null;
    this.bot.pathfinder.setGoal(null);
  }

  /** Whether combat is currently active (used by SurvivalController). */
  isAttacking() {
    return this.fighting;
  }

  /** Attack a mob by name - used by SurvivalController auto-engage. */
  async attackMob(name) {
    const entity = this.nearestHostileMob();
    if (!entity) return false;
    return this.kill(entity);
  }

  setAutoAttack(enabled) {
    this.autoAttackEnabled = enabled;
  }

  onEntityDamaged(entity) {
    if (!this.autoAttackEnabled || !entity) return;
    if (entity.type === 'mob' && entity.position) {
      const distance = this.bot.entity.position.distanceTo(entity.position);
      if (distance <= this.attackRange) {
        this.bot.lookAt(entity.position.offset(0, 1, 0), true);
        this.bot.attack(entity);
      }
    }
  }

  equipBestWeapon() {
    const weapons = this.bot.inventory.items().filter(item => {
      return item.name.includes('sword') || item.name.includes('axe');
    });
    if (weapons.length === 0) return null;

    // Simple heuristic: choose weapon with highest damage
    weapons.sort((a, b) => (b.attackDamage || 1) - (a.attackDamage || 1));

    try {
      this.bot.equip(weapons[0], 'hand');
      return weapons[0];
    } catch (err) {
      return null;
    }
  }

  nearestHostileMob(maxDistance) {
    const maxDist = maxDistance || 16;
    return Object.values(this.bot.entities).find(entity => {
      if (entity.type !== 'mob') return false;
      if (entity.kind === 'passive') return false;
      const dist = this.bot.entity.position.distanceTo(entity.position);
      return dist <= maxDist;
    });
  }

  nearbyHostileMobs(maxDistance) {
    const maxDist = maxDistance || 16;
    return Object.values(this.bot.entities).filter(entity => {
      if (entity.type !== 'mob') return false;
      if (entity.kind === 'passive') return false;
      const dist = this.bot.entity.position.distanceTo(entity.position);
      return dist <= maxDist;
    });
  }
}

module.exports = CombatManager;
