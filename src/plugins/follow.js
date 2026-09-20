const { pathfinder } = require('mineflayer-pathfinder');
const { GoalFollow } = require('mineflayer-pathfinder').goals;

class FollowPlugin {
  constructor(bot) {
    this.bot = bot;
    this.target = null;
    this.following = false;
    this._tickInterval = null;
  }

  setTarget(entity, distance) {
    const d = distance || 2;
    this.target = entity;
    this.following = true;

    if (!entity || !entity.position) {
      this.stop();
      return;
    }

    const goal = new GoalFollow(entity, d);
    this.bot.pathfinder.setGoal(goal, true);

    this._ensureTickInterval(d);
  }

  _ensureTickInterval(distance) {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => {
      if (this.following && this.target) {
        const goal = new GoalFollow(this.target, distance || 2);
        this.bot.pathfinder.setGoal(goal, true);
      }
    }, 3000);
  }

  stop() {
    this.following = false;
    this.target = null;
    this.bot.pathfinder.setGoal(null);
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }
}

module.exports = FollowPlugin;
