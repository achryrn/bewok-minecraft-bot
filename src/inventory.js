class InventoryManager {
  constructor(bot) {
    this.bot = bot;
  }

  items() {
    return this.bot.inventory.items();
  }

  count(itemName) {
    return this.items()
      .filter(item => item.name === itemName)
      .reduce((sum, item) => sum + item.count, 0);
  }

  hasItems(itemName, count) {
    return this.count(itemName) >= (count || 1);
  }

  findItem(itemName) {
    return this.items().find(item => item.name === itemName) || null;
  }

  async equipItem(itemName, destination) {
    const dest = destination || 'hand';
    const item = this.findItem(itemName);
    if (!item) return false;
    try {
      await this.bot.equip(item, dest);
      return true;
    } catch (err) {
      return false;
    }
  }

  async tossItem(itemName, count) {
    const c = count || this.count(itemName);
    const item = this.findItem(itemName);
    if (!item) return false;
    try {
      await this.bot.toss(item.type, item.metadata, c);
      return true;
    } catch (err) {
      return false;
    }
  }

  async tossStack(item) {
    if (!item) return false;
    try {
      await this.bot.tossStack(item);
      return true;
    } catch (err) {
      return false;
    }
  }

  async dropAll() {
    const items = this.items();
    for (const item of items) {
      try {
        await this.bot.tossStack(item);
      } catch (err) {
        // skip items that can't be dropped
      }
    }
  }

  async moveItem(item, destinationContainer, count) {
    if (!item) return false;
    try {
      const c = count || item.count;
      await this.bot.clickWindow(item.slot, 0, 0);
      if (destinationContainer) {
        const destSlot = destinationContainer.slots.findIndex(s => !s);
        if (destSlot >= 0) {
          await this.bot.clickWindow(destSlot, 0, 0);
        }
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  async equipSword() {
    const sword = this.items().find(item => item.name.includes('sword'));
    if (!sword) return false;
    try {
      await this.bot.equip(sword, 'hand');
      return true;
    } catch (err) {
      return false;
    }
  }

  async equipPickaxe() {
    const pickaxe = this.items().find(item => item.name.includes('pickaxe'));
    if (!pickaxe) return false;
    try {
      await this.bot.equip(pickaxe, 'hand');
      return true;
    } catch (err) {
      return false;
    }
  }

  async equipToolForBlock(block) {
    if (!block) return false;
    const mcData = require('minecraft-data')(this.bot.version);
    const blockId = block.type;
    const blockInfo = mcData.blocks[blockId];
    if (!blockInfo || !blockInfo.harvestTools) return false;

    const requiredToolIds = Object.keys(blockInfo.harvestTools).map(Number);
    const bestTool = this.items().find(item => requiredToolIds.includes(item.type));
    if (!bestTool) return false;

    try {
      await this.bot.equip(bestTool, 'hand');
      return bestTool;
    } catch (err) {
      return null;
    }
  }

  getEmptySlotsCount() {
    return this.bot.inventory.slots.filter(slot => !slot).length;
  }

  isInventoryFull() {
    return this.getEmptySlotsCount() === 0;
  }
}

module.exports = InventoryManager;
