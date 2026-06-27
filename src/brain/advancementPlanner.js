/**
 * advancementPlanner.js
 *
 * Deterministic advancement planner using a structured goal graph.
 * This keeps the planning burden OUT of the LLM so the small model only has
 * to execute well-defined goals based on Minecraft's natural progression.
 */

const GOALS = [
  {
    id: 'get_wood',
    description: 'Mine at least 3 oak_log (or any wood log) to gather raw materials.',
    target_item: 'oak_log',
    target_action: 'mine_block',
    prerequisites: [],
    check: (inv) =>
      (inv['oak_log'] || inv['birch_log'] || inv['spruce_log'] ||
       inv['jungle_log'] || inv['dark_oak_log'] || inv['acacia_log'] ||
       inv['mangrove_log'] || inv['cherry_log'] || 0) >= 3,
  },
  {
    id: 'craft_wooden_pickaxe',
    description: 'Craft a wooden_pickaxe (needs logs). Then equip it.',
    target_item: 'wooden_pickaxe',
    target_action: 'craft_item',
    prerequisites: ['get_wood'],
    check: (inv) =>
      (inv['wooden_pickaxe'] || inv['stone_pickaxe'] ||
       inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0) >= 1,
  },
  {
    id: 'mine_stone',
    description: 'Mine at least 8 stone using your pickaxe. (Mining stone drops cobblestone).',
    target_item: 'cobblestone',
    target_action: 'mine_block',
    prerequisites: ['craft_wooden_pickaxe'],
    check: (inv) => (inv['cobblestone'] || 0) >= 8,
  },
  {
    id: 'craft_stone_pickaxe',
    description: 'Craft a stone_pickaxe. Then equip it.',
    target_item: 'stone_pickaxe',
    target_action: 'craft_item',
    prerequisites: ['mine_stone'],
    check: (inv) =>
      (inv['stone_pickaxe'] || inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0) >= 1,
  },
  {
    id: 'craft_furnace',
    description: 'Craft a furnace using cobblestone.',
    target_item: 'furnace',
    target_action: 'craft_item',
    prerequisites: ['mine_stone'],
    check: (inv) => (inv['furnace'] || 0) >= 1,
  },
  {
    id: 'mine_iron',
    description: 'Mine at least 8 iron_ore underground using your stone_pickaxe.',
    target_item: 'iron_ore',
    target_action: 'mine_block',
    prerequisites: ['craft_stone_pickaxe'],
    check: (inv) => (inv['raw_iron'] || inv['iron_ore'] || inv['iron_ingot'] || 0) >= 8,
  },
  {
    id: 'smelt_iron',
    description: 'Smelt iron_ore into iron_ingot using the furnace. Provide coal or wood as fuel.',
    target_item: 'iron_ingot',
    target_action: 'smelt_item',
    prerequisites: ['mine_iron', 'craft_furnace'],
    check: (inv) => (inv['iron_ingot'] || 0) >= 8,
  },
  {
    id: 'craft_iron_pickaxe',
    description: 'Craft an iron_pickaxe.',
    target_item: 'iron_pickaxe',
    target_action: 'craft_item',
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0) >= 1,
  },
  {
    id: 'craft_iron_armor',
    description: 'Craft at least one piece of iron armor (e.g. iron_chestplate).',
    target_item: 'iron_chestplate',
    target_action: 'craft_item',
    prerequisites: ['smelt_iron'],
    check: (inv) =>
      (inv['iron_helmet'] || inv['iron_chestplate'] || inv['iron_leggings'] || inv['iron_boots'] || 0) >= 1,
  },
  {
    id: 'mine_diamonds',
    description: 'Mine diamond_ore underground using your iron_pickaxe.',
    target_item: 'diamond',
    target_action: 'mine_block',
    prerequisites: ['craft_iron_pickaxe'],
    check: (inv) => (inv['diamond'] || inv['diamond_ore'] || 0) >= 1,
  }
];

/**
 * Computes the correct advancement goal from inventory and forcefully sets it
 * on the bot. Called every tick so stale LLM-set goals are always corrected.
 *
 * Walks the goal graph to find the first eligible incomplete goal.
 *
 * @param {object} bot - Mineflayer bot instance
 * @returns {object} Object containing { goal, target_item, target_action }
 */
function syncGoal(bot) {
  const inv = {};
  for (const item of bot.inventory.items()) {
    inv[item.name] = (inv[item.name] || 0) + item.count;
  }

  let selectedGoal = null;

  for (const goal of GOALS) {
    if (!goal.check(inv)) {
      // Check if all prerequisites are met
      const prereqsMet = goal.prerequisites.every(reqId => {
        const reqGoal = GOALS.find(g => g.id === reqId);
        return reqGoal && reqGoal.check(inv);
      });

      if (prereqsMet) {
        selectedGoal = goal;
        break; // Found the first eligible goal
      }
    }
  }

  let goalDescription = 'All major advancements complete! Explore freely and build something great.';
  let targetItem = 'none';
  let targetAction = 'none';

  if (selectedGoal) {
    goalDescription = selectedGoal.description;
    targetItem = selectedGoal.target_item;
    targetAction = selectedGoal.target_action || 'none';
  }

  // Always enforce the correct goal — prevents LLM from setting stale goals
  bot.brain_current_goal = goalDescription;
  bot.brain_target_item = targetItem;
  bot.brain_target_action = targetAction;
  
  return {
    goal: goalDescription,
    target_item: targetItem,
    target_action: targetAction
  };
}

// Keep legacy export for backwards compat
function getNextAdvancementGoal(bot) {
  const synced = syncGoal(bot);
  return synced.goal;
}

module.exports = { syncGoal, getNextAdvancementGoal };
