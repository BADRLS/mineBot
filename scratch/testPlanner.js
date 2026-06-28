const { syncGoal } = require('../src/brain/advancementPlanner');

// Mock bot implementation
class MockBot {
  constructor(items) {
    this.inventory = {
      items: () => items.map(item => ({ name: item.name, count: item.count }))
    };
    this.achieved_goals = null;
  }
}

// 1. Initial State: No items, should want wood
const bot = new MockBot([]);
console.log("Initial state goal:", syncGoal(bot));
console.log("Memory:", bot.achieved_goals);

// 2. Give wood (3 oak_log), should satisfy get_wood and transition to craft_wooden_pickaxe
bot.inventory = {
  items: () => [{ name: 'oak_log', count: 3 }]
};
console.log("\nAfter getting wood:", syncGoal(bot));
console.log("Memory:", bot.achieved_goals);

// 3. Craft wooden pickaxe (removes logs, adds pickaxe), should keep get_wood in memory!
bot.inventory = {
  items: () => [{ name: 'wooden_pickaxe', count: 1 }]
};
console.log("\nAfter crafting wooden pickaxe (logs consumed):", syncGoal(bot));
console.log("Memory:", bot.achieved_goals);

// 4. Mine stone (retains wooden pickaxe, gets 8 cobblestone)
bot.inventory = {
  items: () => [{ name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 8 }]
};
console.log("\nAfter mining 8 stone:", syncGoal(bot));
console.log("Memory:", bot.achieved_goals);

// 5. Craft furnace and stone pickaxe (uses cobblestone)
// Cobblestone drops to 0, but we have furnace and stone_pickaxe.
bot.inventory = {
  items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'furnace', count: 1 }, { name: 'cobblestone', count: 0 }]
};
console.log("\nAfter crafting furnace and stone pickaxe (cobblestone consumed):", syncGoal(bot));
console.log("Memory:", bot.achieved_goals);
