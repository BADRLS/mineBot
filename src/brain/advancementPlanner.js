const fs = require('fs');
const path = require('path');

/**
 * advancementPlanner.js
 *
 * Deterministic advancement planner using a structured goal graph.
 * This keeps the planning burden OUT of the LLM so the small model only has
 * to execute well-defined goals based on Minecraft's natural progression.
 *
 * Session persistence: achieved goals are saved to disk so the bot
 * can resume from where it left off after a restart.
 */

// ─── Persistence ────────────────────────────────────────────────────────────
const SAVE_FILE = path.join(__dirname, '../../data/progress.json');

/**
 * Loads previously achieved goals from disk.
 * @returns {Set<string>} Set of achieved goal IDs
 */
function loadProgress() {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(SAVE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (fs.existsSync(SAVE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
      if (data.achieved_goals && Array.isArray(data.achieved_goals)) {
        console.log(`[SYSTEM] Loaded ${data.achieved_goals.length} achieved goals from save file: ${data.achieved_goals.join(', ')}`);
        return new Set(data.achieved_goals);
      }
    }
  } catch (e) {
    console.error(`[SYSTEM] Failed to load progress file: ${e.message}`);
  }
  return new Set();
}

/**
 * Saves achieved goals to disk.
 * @param {Set<string>} achievedGoals
 */
function saveProgress(achievedGoals) {
  try {
    const dataDir = path.dirname(SAVE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const data = {
      achieved_goals: [...achievedGoals],
      last_saved: new Date().toISOString(),
    };
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`[SYSTEM] Failed to save progress file: ${e.message}`);
  }
}

// ─── All known log types ────────────────────────────────────────────────────
const ALL_LOG_TYPES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
  'dark_oak_log', 'acacia_log', 'mangrove_log', 'cherry_log',
];

/**
 * Scans nearby blocks to find the closest available log type.
 * Falls back to 'oak_log' if nothing is found (the bot will explore).
 * @param {object} bot - Mineflayer bot instance
 * @returns {string} The log block name to mine
 */
function findNearbyLogType(bot) {
  let bestLogType = null;
  let bestDist = Infinity;

  for (const logName of ALL_LOG_TYPES) {
    const blockType = bot.registry.blocksByName[logName];
    if (!blockType) continue;
    const block = bot.findBlock({ matching: blockType.id, maxDistance: 64 });
    if (block) {
      const dist = bot.entity.position.distanceTo(block.position);
      if (dist < bestDist) {
        bestDist = dist;
        bestLogType = logName;
      }
    }
  }

  return bestLogType || 'oak_log';
}

// ─── Goal Graph ─────────────────────────────────────────────────────────────

const GOALS = [
  {
    id: 'get_wood',
    description: 'Mine at least 3 wood logs to gather raw materials.',
    target_item: 'oak_log',
    target_action: 'mine_block',
    targetCount: 3,
    prerequisites: [],
    resolveTargetItem: (bot) => findNearbyLogType(bot),
    check: (inv) => (inv['oak_log'] || inv['birch_log'] || inv['spruce_log'] || inv['jungle_log'] || inv['dark_oak_log'] || inv['acacia_log'] || inv['mangrove_log'] || inv['cherry_log'] || 0) >= 3,
    currentCount: (inv) => (inv['oak_log'] || inv['birch_log'] || inv['spruce_log'] || inv['jungle_log'] || inv['dark_oak_log'] || inv['acacia_log'] || inv['mangrove_log'] || inv['cherry_log'] || 0)
  },
  {
    id: 'craft_wooden_pickaxe',
    description: 'Craft a wooden_pickaxe (needs logs).',
    target_item: 'wooden_pickaxe',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['get_wood'],
    check: (inv) => (inv['wooden_pickaxe'] || inv['stone_pickaxe'] || inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0) >= 1,
    currentCount: (inv) => (inv['wooden_pickaxe'] || inv['stone_pickaxe'] || inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0)
  },
  {
    id: 'mine_stone',
    description: 'Mine at least 8 stone to get cobblestone.',
    target_item: 'stone',
    target_action: 'mine_block',
    targetCount: 8,
    prerequisites: ['craft_wooden_pickaxe'],
    resolveTargetItem: () => 'stone',
    check: (inv) => (inv['cobblestone'] || 0) >= 8,
    currentCount: (inv) => (inv['cobblestone'] || 0)
  },
  {
    id: 'craft_stone_pickaxe',
    description: 'Craft a stone_pickaxe.',
    target_item: 'stone_pickaxe',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['mine_stone'],
    check: (inv) => (inv['stone_pickaxe'] || inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0) >= 1,
    currentCount: (inv) => (inv['stone_pickaxe'] || inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0)
  },
  {
    id: 'craft_furnace',
    description: 'Craft a furnace using cobblestone.',
    target_item: 'furnace',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['mine_stone'],
    check: (inv) => (inv['furnace'] || 0) >= 1,
    currentCount: (inv) => (inv['furnace'] || 0)
  },
  {
    id: 'mine_coal',
    description: 'Mine at least 4 coal_ore to get coal for fuel.',
    target_item: 'coal_ore',
    target_action: 'mine_block',
    targetCount: 4,
    prerequisites: ['craft_wooden_pickaxe'],
    check: (inv) => (inv['coal'] || inv['charcoal'] || 0) >= 4,
    currentCount: (inv) => (inv['coal'] || inv['charcoal'] || 0)
  },
  {
    id: 'mine_iron',
    description: 'Mine at least 15 iron_ore underground (Y=0-63).',
    target_item: 'iron_ore',
    target_action: 'mine_block',
    targetCount: 15,
    prerequisites: ['craft_stone_pickaxe'],
    resolveTargetItem: (bot) => {
      const ironOre = bot.registry.blocksByName['iron_ore'];
      const deepslateIronOre = bot.registry.blocksByName['deepslate_iron_ore'];
      if (ironOre && bot.findBlock({ matching: ironOre.id, maxDistance: 32 })) return 'iron_ore';
      if (deepslateIronOre && bot.findBlock({ matching: deepslateIronOre.id, maxDistance: 32 })) return 'deepslate_iron_ore';
      return 'iron_ore';
    },
    check: (inv) => (inv['raw_iron'] || inv['iron_ingot'] || 0) >= 15,
    currentCount: (inv) => (inv['raw_iron'] || inv['iron_ingot'] || 0)
  },
  {
    id: 'smelt_iron',
    description: 'Smelt raw_iron into iron_ingot using the furnace.',
    target_item: 'iron_ingot',
    target_action: 'smelt_item',
    targetCount: 15,
    prerequisites: ['mine_iron', 'craft_furnace', 'mine_coal'],
    check: (inv) => (inv['iron_ingot'] || 0) >= 15,
    currentCount: (inv) => (inv['iron_ingot'] || 0)
  },
  {
    id: 'craft_shield',
    description: 'Craft a shield for protection.',
    target_item: 'shield',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['shield'] || 0) >= 1,
    currentCount: (inv) => (inv['shield'] || 0)
  },
  {
    id: 'craft_iron_pickaxe',
    description: 'Craft an iron_pickaxe.',
    target_item: 'iron_pickaxe',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0) >= 1,
    currentCount: (inv) => (inv['iron_pickaxe'] || inv['diamond_pickaxe'] || 0)
  },
  {
    id: 'craft_iron_sword',
    description: 'Craft an iron_sword.',
    target_item: 'iron_sword',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_sword'] || inv['diamond_sword'] || 0) >= 1,
    currentCount: (inv) => (inv['iron_sword'] || inv['diamond_sword'] || 0)
  },
  {
    id: 'craft_iron_helmet',
    description: 'Craft an iron_helmet.',
    target_item: 'iron_helmet',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_helmet'] || 0) >= 1,
    currentCount: (inv) => (inv['iron_helmet'] || 0)
  },
  {
    id: 'craft_iron_chestplate',
    description: 'Craft an iron_chestplate.',
    target_item: 'iron_chestplate',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_chestplate'] || 0) >= 1,
    currentCount: (inv) => (inv['iron_chestplate'] || 0)
  },
  {
    id: 'craft_iron_leggings',
    description: 'Craft iron_leggings.',
    target_item: 'iron_leggings',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_leggings'] || 0) >= 1,
    currentCount: (inv) => (inv['iron_leggings'] || 0)
  },
  {
    id: 'craft_iron_boots',
    description: 'Craft iron_boots.',
    target_item: 'iron_boots',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['iron_boots'] || 0) >= 1,
    currentCount: (inv) => (inv['iron_boots'] || 0)
  },
  {
    id: 'mine_diamonds',
    description: 'Mine diamond_ore underground below Y=16.',
    target_item: 'diamond_ore',
    target_action: 'mine_block',
    targetCount: 3,
    prerequisites: ['craft_iron_pickaxe'],
    resolveTargetItem: (bot) => {
      const diamondOre = bot.registry.blocksByName['diamond_ore'];
      const deepslateDiamondOre = bot.registry.blocksByName['deepslate_diamond_ore'];
      if (diamondOre && bot.findBlock({ matching: diamondOre.id, maxDistance: 32 })) return 'diamond_ore';
      if (deepslateDiamondOre && bot.findBlock({ matching: deepslateDiamondOre.id, maxDistance: 32 })) return 'deepslate_diamond_ore';
      return 'diamond_ore';
    },
    check: (inv) => (inv['diamond'] || 0) >= 3,
    currentCount: (inv) => (inv['diamond'] || 0)
  },
  {
    id: 'craft_diamond_pickaxe',
    description: 'Craft a diamond_pickaxe.',
    target_item: 'diamond_pickaxe',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['mine_diamonds'],
    check: (inv) => (inv['diamond_pickaxe'] || 0) >= 1,
    currentCount: (inv) => (inv['diamond_pickaxe'] || 0)
  },
  {
    id: 'craft_bucket',
    description: 'Craft a bucket using 3 iron_ingots.',
    target_item: 'bucket',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['smelt_iron'],
    check: (inv) => (inv['bucket'] || inv['water_bucket'] || inv['lava_bucket'] || 0) >= 1,
    currentCount: (inv) => (inv['bucket'] || inv['water_bucket'] || inv['lava_bucket'] || 0)
  },
  {
    id: 'get_water',
    description: 'Use gather_water to fill the empty bucket.',
    target_item: 'water_bucket',
    target_action: 'gather_water',
    targetCount: 1,
    prerequisites: ['craft_bucket'],
    check: (inv) => (inv['water_bucket'] || 0) >= 1,
    currentCount: (inv) => (inv['water_bucket'] || 0)
  },
  {
    id: 'make_obsidian_blocks',
    description: 'Use make_obsidian to pour water on lava and create obsidian blocks. Do this multiple times if needed.',
    target_item: 'obsidian',
    target_action: 'make_obsidian',
    targetCount: 14,
    prerequisites: ['get_water', 'craft_diamond_pickaxe'],
    check: (inv) => (inv['obsidian'] || 0) >= 14, // It will bypass check if we already have it from mining
    currentCount: (inv) => (inv['obsidian'] || 0)
  },
  {
    id: 'mine_obsidian',
    description: 'Mine the obsidian you just made using your diamond_pickaxe.',
    target_item: 'obsidian',
    target_action: 'mine_block',
    targetCount: 14,
    prerequisites: ['make_obsidian_blocks'],
    check: (inv) => (inv['obsidian'] || 0) >= 14,
    currentCount: (inv) => (inv['obsidian'] || 0)
  },
  {
    id: 'mine_gravel',
    description: 'Mine gravel to get flint.',
    target_item: 'gravel',
    target_action: 'mine_block',
    targetCount: 1,
    prerequisites: ['craft_stone_pickaxe'],
    check: (inv) => (inv['flint'] || 0) >= 1,
    currentCount: (inv) => (inv['flint'] || 0)
  },
  {
    id: 'craft_flint_and_steel',
    description: 'Craft flint_and_steel to light the nether portal.',
    target_item: 'flint_and_steel',
    target_action: 'craft_item',
    targetCount: 1,
    prerequisites: ['mine_gravel', 'smelt_iron'],
    check: (inv) => (inv['flint_and_steel'] || 0) >= 1,
    currentCount: (inv) => (inv['flint_and_steel'] || 0)
  },
  {
    id: 'build_nether_portal',
    description: 'Place 14 obsidian in a portal frame, then use flint_and_steel to light it.',
    target_item: 'nether_portal',
    target_action: 'build_portal', // LLM will have to place blocks or we make a custom action. Wait, I should make a build_portal action to keep it robust. Let\'s assume LLM can place_block. It\'s very hard for LLM to build a portal. I will add a `build_nether_portal` custom action next!
    targetCount: 1,
    prerequisites: ['mine_obsidian', 'craft_flint_and_steel'],
    check: (inv, bot) => (bot && bot.game && bot.game.dimension === 'the_nether') || false, // Hard to check otherwise
    currentCount: () => 0
  }
];

/**
 * Computes the correct advancement goal from inventory and forcefully sets it
 * on the bot. Called every tick so stale LLM-set goals are always corrected.
 *
 * Walks the goal graph to find the first eligible incomplete goal, using memory
 * so the bot doesn't regress if it consumes or stores items.
 *
 * @param {object} bot - Mineflayer bot instance
 * @returns {object} Object containing { goal, target_item, target_action, target_count_remaining }
 */
function syncGoal(bot) {
  // Check for reset flag file in the project root
  const flagPath = path.join(__dirname, '../../reset_memory.flag');
  if (fs.existsSync(flagPath)) {
    try {
      fs.unlinkSync(flagPath);
      if (bot.achieved_goals) {
        bot.achieved_goals.clear();
      }
      saveProgress(new Set());
      console.log("[SYSTEM] Reset flag file detected. Advancement memory wiped!");
    } catch (e) {
      console.error("[SYSTEM] Failed to handle reset flag:", e.message);
    }
  }

  // 1. Initialize memory for this session — load from disk on first call
  if (!bot.achieved_goals) {
    bot.achieved_goals = loadProgress();
  }

  const inv = {};
  for (const item of bot.inventory.items()) {
    inv[item.name] = (inv[item.name] || 0) + item.count;
  }

  // 2. First pass: Update memory with any goals currently satisfied by the inventory
  let changed = false;
  for (const goal of GOALS) {
    if (goal.check(inv, bot) && !bot.achieved_goals.has(goal.id)) {
      bot.achieved_goals.add(goal.id);
      changed = true;
      console.log(`[PLANNER] Goal "${goal.id}" is now achieved!`);
    }
  }

  // Save to disk whenever new goals are achieved
  if (changed) {
    saveProgress(bot.achieved_goals);
  }

  let selectedGoal = null;

  // 3. Second pass: Find the first goal we HAVEN'T achieved, 
  // whose prerequisites ARE met in our memory
  for (const goal of GOALS) {
    if (!bot.achieved_goals.has(goal.id)) {
      // Check if all prerequisites are stored in memory
      const prereqsMet = goal.prerequisites.every(reqId => bot.achieved_goals.has(reqId));

      if (prereqsMet) {
        selectedGoal = goal;
        break; // Found the next logical step!
      }
    }
  }

  let goalDescription = 'All major advancements complete! Explore freely and build something great.';
  let targetItem = 'none';
  let targetAction = 'free_explore';
  let targetCountRemaining = 0;

  if (selectedGoal) {
    goalDescription = selectedGoal.description;
    
    // Use dynamic resolution if available
    if (selectedGoal.resolveTargetItem) {
      targetItem = selectedGoal.resolveTargetItem(bot);
    } else {
      targetItem = selectedGoal.target_item;
    }
    
    targetAction = selectedGoal.target_action || 'none';
    
    if (selectedGoal.targetCount && selectedGoal.currentCount) {
      const cur = selectedGoal.currentCount(inv);
      targetCountRemaining = Math.max(0, selectedGoal.targetCount - cur);
    }
  }

  // Always enforce the correct goal — prevents LLM from setting stale goals
  bot.brain_current_goal = goalDescription;
  bot.brain_target_item = targetItem;
  bot.brain_target_action = targetAction;
  bot.brain_target_count_remaining = targetCountRemaining;
  
  return {
    goal: goalDescription,
    target_item: targetItem,
    target_action: targetAction,
    target_count_remaining: targetCountRemaining
  };
}

/**
 * Resets all saved progress (used by !reset command).
 * @param {object} bot - Mineflayer bot instance
 */
function resetProgress(bot) {
  if (bot.achieved_goals) {
    bot.achieved_goals.clear();
  }
  saveProgress(new Set());
  console.log("[SYSTEM] All progress has been reset and saved.");
}

// Keep legacy export for backwards compat
function getNextAdvancementGoal(bot) {
  const synced = syncGoal(bot);
  return synced.goal;
}

module.exports = { syncGoal, getNextAdvancementGoal, resetProgress, findNearbyLogType, ALL_LOG_TYPES };
