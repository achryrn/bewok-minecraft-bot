class CraftingManager {
  constructor(bot) {
    this.bot = bot;
    this.mcData = require('minecraft-data')(bot.version);
  }

  getRecipesFor(itemName) {
    const item = this.mcData.itemsByName[itemName];
    if (!item) return [];
    return this.mcData.recipesAll.filter(r => r.result === item.id);
  }

  getRecipe(itemName) {
    const recipes = this.getRecipesFor(itemName);
    return recipes.length > 0 ? recipes[0] : null;
  }

  canCraft(itemName) {
    const recipe = this.getRecipe(itemName);
    if (!recipe) return false;
    return this.bot.canCraft(recipe);
  }

  async craft(itemName, count) {
    const c = count || 1;
    const recipe = this.getRecipe(itemName);
    if (!recipe) {
      throw new Error(`No recipe found for ${itemName}`);
    }
    try {
      await this.bot.craft(recipe, c);
      return true;
    } catch (err) {
      throw new Error(`Failed to craft ${itemName}: ${err.message}`);
    }
  }

  async craftWithTable(itemName, count) {
    const c = count || 1;
    const recipe = this.getRecipe(itemName);
    if (!recipe) {
      throw new Error(`No recipe found for ${itemName}`);
    }
    if (!recipe.requiresTable) {
      return this.craft(itemName, c);
    }

    // Find or place crafting table
    const table = this.bot.findBlock({
      matching: block => block.name === 'crafting_table',
      maxDistance: 16,
    });

    if (table) {
      await this.bot.lookAt(table.position.offset(0, 1, 0), true);
      try {
        await this.bot.craft(recipe, c, table);
        return true;
      } catch (err) {
        throw new Error(`Failed to craft ${itemName} at table: ${err.message}`);
      }
    }

    // Place crafting table if we have one
    const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
    if (tableItem) {
      await this.bot.equip(tableItem, 'hand');
      const referenceBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      try {
        await this.bot.placeBlock(referenceBlock, new this.bot.Vec3(1, 0, 0));
        await new Promise(r => setTimeout(r, 500));
        const placedTable = this.bot.blockAt(this.bot.entity.position.offset(1, 0, 0));
        if (placedTable && placedTable.name === 'crafting_table') {
          await this.bot.craft(recipe, c, placedTable);
          return true;
        }
      } catch (err) {
        throw new Error(`Failed to place/use crafting table: ${err.message}`);
      }
    }

    throw new Error('No crafting table available and cannot place one');
  }

  getCraftableItems() {
    const items = this.bot.inventory.items();
    const availableItemIds = new Set(items.map(i => i.type));
    const craftable = [];

    for (const recipe of this.mcData.recipesAll) {
      if (recipe.requiresTable) continue;
      const ingredients = recipe.ingredients || [];
      const canMake = ingredients.every(ing => {
        if (!ing) return true;
        if (Array.isArray(ing)) return ing.some(i => availableItemIds.has(i.id));
        return availableItemIds.has(ing.id);
      });
      if (canMake) {
        craftable.push(this.mcData.items[recipe.result]);
      }
    }

    return craftable;
  }

  getRequiredItems(itemName, count) {
    const c = count || 1;
    const recipe = this.getRecipe(itemName);
    if (!recipe) return [];

    const requirements = [];
    const ingredients = recipe.ingredients || [];

    for (const ing of ingredients) {
      if (!ing) continue;
      if (Array.isArray(ing)) {
        // Alternative ingredients - just pick first available
        for (const alt of ing) {
          const have = this.bot.inventory.count(alt.id);
          if (have > 0) {
            requirements.push({
              name: this.mcData.items[alt.id].name,
              required: c * (alt.count || 1),
              available: have,
            });
            break;
          }
        }
      } else {
        requirements.push({
          name: this.mcData.items[ing.id].name,
          required: c * (ing.count || 1),
          available: this.bot.inventory.count(this.mcData.items[ing.id].name),
        });
      }
    }

    return requirements;
  }
}

module.exports = CraftingManager;