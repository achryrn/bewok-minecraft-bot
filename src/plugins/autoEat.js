class AutoEatPlugin {
  constructor(bot, config) {
    this.bot = bot;
    this.config = config;
    this.enabled = config.autoEat || false;
    this.threshold = config.autoEatThreshold || 14;
    this.eating = false;
  }

  onHealth() {
    if (!this.enabled || this.eating) return;
    if (this.bot.food > this.threshold) return;

    const foodItem = this._findBestFood();
    if (!foodItem) return;

    this.eating = true;
    this._consume(foodItem).finally(() => {
      this.eating = false;
    });
  }

  _findBestFood() {
    const foods = this.bot.inventory
      .items()
      .filter(item => item.foodPoints > 0)
      .sort((a, b) => b.foodPoints - a.foodPoints);

    return foods.length > 0 ? foods[0] : null;
  }

  async _consume(item) {
    try {
      await this.bot.equip(item, 'hand');
      if (this.bot.food <= this.threshold) {
        await this.bot.consume();
        return true;
      }
      return false;
    } catch (err) {
      if (this.config && this.config.debug) {
        console.log('Failed to eat:', err.message);
      }
      return false;
    }
  }

  stop() {
    this.eating = false;
  }
}

module.exports = AutoEatPlugin;
