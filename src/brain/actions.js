/**
 * actions.js
 *
 * Defines the actions the LLM can choose from, in two forms:
 *   1. TOOL_SCHEMAS  — the JSON schema sent to the LLM so it knows what's available
 *   2. executeAction — the function that actually carries out the chosen action in Mineflayer
 *
 * Adding a new action: add an entry to TOOL_SCHEMAS and a case in executeAction().
 */

const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { equipBestWeapon } = require('./utils');
const { HOSTILE_MOB_NAMES, FOOD_ANIMAL_NAMES } = require('./constants');

function log(message, type = 'ACTION') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${message}`);
}

// Low-value blocks that should be capped in inventory
const LOW_VALUE_BLOCKS = new Set([
  'cobblestone', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite',
  'cobbled_deepslate', 'gravel', 'sand', 'tuff', 'calcite',
]);

// ─── Tool Schemas (sent to the LLM) ──────────────────────────────────────────

const TOOL_SCHEMAS = [
  {
    name: 'chat',
    description: 'Send a message in the Minecraft game chat. Use this to talk to players, react to events, or express thoughts.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        message: {
          type: 'string',
          description: 'The chat message to send. Keep it short and natural — 1-2 sentences max.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'move_to',
    description: 'Pathfind and walk to a target. Provide either a player name OR specific coordinates (x, y, z). Do not provide both.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        player_name: {
          type: 'string',
          description: 'Name of a player to walk towards. Used when you want to approach a specific player.',
        },
        x: { type: 'number', description: 'Target X coordinate.' },
        y: { type: 'number', description: 'Target Y coordinate.' },
        z: { type: 'number', description: 'Target Z coordinate.' },
      },
    },
  },
  {
    name: 'mine_block',
    description: 'Find and mine the nearest block of a given type. The bot will pathfind to it and break it. If the block is not found nearby, consider using explore_randomly first.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        block_type: {
          type: 'string',
          description: 'The Minecraft block type to mine, e.g. "oak_log", "birch_log", "stone", "coal_ore", "iron_ore". Use the BLOCK name (what exists in the world), not the drop name.',
        },
      },
      required: ['block_type'],
    },
  },
  {
    name: 'follow_player',
    description: 'Continuously follow a player, staying within a short distance. The bot will keep moving as the player moves.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        player_name: {
          type: 'string',
          description: 'The name of the player to follow.',
        },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'attack_nearest_mob',
    description: 'Find and attack the nearest hostile mob. Use this when a mob is threatening the bot or a nearby player.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        max_distance: {
          type: 'number',
          description: 'Maximum search radius in blocks. Defaults to 16 if not provided.',
        },
      },
    },
  },
  {
    name: 'flee',
    description: 'Run away from the nearest hostile mob by pathfinding to a safe distance.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
      },
    },
  },
  {
    name: 'hunt_animal',
    description: 'Find and attack the nearest food-providing animal (cow, pig, chicken, sheep, rabbit) to gather raw meat. The bot will automatically cook it later if needed.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
      },
    },
  },
  {
    name: 'make_obsidian',
    description: 'Uses a water bucket on a lava pool to create obsidian blocks. The bot will pathfind to a lava pool, pour water safely without burning, and pick the water back up.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
      },
    },
  },
  {
    name: 'gather_water',
    description: 'Finds a nearby water source and fills an empty bucket. You must have an empty bucket in your inventory.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
      },
    },
  },
  {
    name: 'build_nether_portal',
    description: 'Builds a 4x5 nether portal using 14 obsidian, lights it with flint_and_steel, and enters it.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
      },
    },
  },
  {
    name: 'equip_item',
    description: 'Equip an item from your inventory to your hand, head, torso, legs, or feet.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        item_name: { type: 'string', description: 'The item to equip (e.g. "iron_sword").' },
        destination: { type: 'string', description: 'Where to equip. MUST be one of: "hand", "head", "torso", "legs", "feet". Use "head", "torso", "legs", "feet" for armor pieces specifically. Default is "hand".' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'toss_item',
    description: 'Drop an item from your inventory onto the ground.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        item_name: { type: 'string', description: 'The item to toss.' },
        count: { type: 'number', description: 'How many to toss. Default is all of them.' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'craft_item',
    description: 'Craft an item. The bot will automatically use a nearby crafting table if required by the recipe, and will auto-craft intermediate items (planks, sticks, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        item_name: { type: 'string', description: 'The item to craft (e.g. "oak_planks", "crafting_table", "wooden_pickaxe").' },
        count: { type: 'number', description: 'How many times to execute the recipe. Default is 1.' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'smelt_item',
    description: 'Smelt an item in a furnace. The bot will automatically find or place a furnace, and use the provided fuel and input items.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        item_name: { type: 'string', description: 'The item you want to produce (e.g. "iron_ingot", "stone"). MUST match target_item.' },
        input_name: { type: 'string', description: 'The raw item to smelt (e.g. "raw_iron", "cobblestone").' },
        fuel_name: { type: 'string', description: 'The fuel to use (e.g. "coal", "oak_planks", "charcoal").' },
        count: { type: 'number', description: 'How many items to smelt. Default is 1.' },
      },
      required: ['item_name', 'input_name', 'fuel_name'],
    },
  },
  {
    name: 'place_block',
    description: 'Place a block at specific coordinates. The bot will pathfind there and place the block.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        block_type: { type: 'string', description: 'The block type to place (e.g. "dirt").' },
        x: { type: 'number', description: 'Target X coordinate.' },
        y: { type: 'number', description: 'Target Y coordinate.' },
        z: { type: 'number', description: 'Target Z coordinate.' },
      },
      required: ['block_type', 'x', 'y', 'z'],
    },
  },
  {
    name: 'idle',
    description: 'Do nothing this tick. Use when the situation is calm and no action is needed, or when waiting for something.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
      },
    },
  },
  {
    name: 'store_in_container',
    description: 'Pathfind to the nearest chest and deposit an item. If item_name is "overflow", the bot will automatically deposit bulk/low-value materials (stone, dirt, sand, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        item_name: { type: 'string', description: 'The item to deposit, or "overflow" to deposit bulk trash.' },
        count: { type: 'number', description: 'How many to deposit. Default is all of them.' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'give_item_to_player',
    description: 'Pathfind to a player and drop an item at their feet.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        player_name: { type: 'string', description: 'Name of the player to give the item to.' },
        item_name: { type: 'string', description: 'The item to give.' },
        count: { type: 'number', description: 'How many to give. Default is all of them.' },
      },
      required: ['player_name', 'item_name'],
    },
  },
  {
    name: 'explore_randomly',
    description: 'Walk in a random direction to discover new terrain and resources. Use when you cannot find a needed block nearby (e.g. ore, trees). Especially useful before mining if target_block_found_at_distance is null.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Briefly explain why you chose this action (max 1 sentence).' },
        distance: { type: 'number', description: 'How far to walk in blocks. Default is 50. Use larger values (80-100) when searching for underground ores.' },
      },
    },
  },
];

// ─── Auto-Crafting Helper ───────────────────────────────────────────────────

/**
 * Recursively crafts an item and its missing dependencies.
 * Returns { success: boolean, reason: string }
 */
async function autoCraft(bot, itemId, count = 1, seen = new Set()) {
  const currentCount = bot.inventory.count(itemId);
  if (currentCount >= count) return { success: true, reason: '' };

  if (seen.has(itemId)) return { success: false, reason: `Recursive dependency loop for item ${itemId}` };
  seen.add(itemId);

  const needed = count - currentCount;
  
  if (bot.inventory.emptySlotCount() === 0) {
    const itemType = bot.registry.items[itemId];
    if (itemType) {
      const existingItem = bot.inventory.items().find(i => i.type === itemId && i.count < itemType.stackSize);
      if (!existingItem) {
        return { success: false, reason: `Cannot craft intermediate item ${itemType.name}: inventory is full.` };
      }
    }
  }

  const recipes = bot.registry.recipes[itemId];
  if (!recipes || recipes.length === 0) return { success: false, reason: `No recipes found for item ${itemId}` };

  let lastReason = "Missing raw materials.";
  let bestReason = null;

  for (const recipe of recipes) {
    let canCraftRecipe = true;
    
    // Tally ingredients required
    const requiredItems = {};
    if (recipe.inShape) {
      for (const row of recipe.inShape) {
        for (const id of row) {
          if (id !== null) {
            requiredItems[id] = (requiredItems[id] || 0) + 1;
          }
        }
      }
    }
    if (recipe.ingredients) { // shapeless
      for (const id of recipe.ingredients) {
        if (id !== null) {
          requiredItems[id] = (requiredItems[id] || 0) + 1;
        }
      }
    }

    const craftOperations = Math.ceil(needed / (recipe.result.count || 1));
    
    // Try to satisfy all ingredients
    for (const [reqIdStr, reqCount] of Object.entries(requiredItems)) {
      const reqId = parseInt(reqIdStr);
      const totalReq = reqCount * craftOperations;
      const has = bot.inventory.count(reqId);
      if (has < totalReq) {
        // Attempt to craft the missing amount
        const result = await autoCraft(bot, reqId, totalReq, new Set(seen));
        if (!result.success) {
          canCraftRecipe = false;
          lastReason = result.reason.includes('Recursive') || result.reason.includes('Mineflayer craft error') 
            ? result.reason 
            : `Missing raw materials (needs item ID ${reqId}).`;
          break;
        }
      }
    }

    let requiresTable = false;
    if (recipe.inShape) {
      if (recipe.inShape.length > 2) requiresTable = true;
      for (const row of recipe.inShape) {
        if (row.length > 2) requiresTable = true;
      }
    } else if (recipe.ingredients && recipe.ingredients.length > 4) {
      requiresTable = true;
    }

    if (canCraftRecipe) {
       let craftingTable = null;
       if (requiresTable) {
         const tableId = bot.registry.blocksByName['crafting_table']?.id;
         craftingTable = bot.findBlock({ matching: tableId, maxDistance: 32 });
         if (!craftingTable) {
           let tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
           if (!tableItem) {
             await autoCraft(bot, tableId, 1, new Set(seen));
             tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
           }
           if (tableItem) {
             const defaultMove = new Movements(bot);
             bot.pathfinder.setMovements(defaultMove);
             
             // Find a spot near the bot that is air and has a solid block underneath
             let placed = false;
             for (let dx = -2; dx <= 2; dx++) {
               for (let dz = -2; dz <= 2; dz++) {
                 if (dx === 0 && dz === 0) continue; // Don't place inside the bot
                 const pos = bot.entity.position.offset(dx, 0, dz).floored();
                 const airBlock = bot.blockAt(pos);
                 const groundBlock = bot.blockAt(pos.offset(0, -1, 0));
                 if (airBlock && airBlock.name === 'air' && groundBlock && groundBlock.name !== 'air' && groundBlock.boundingBox === 'block') {
                    await bot.equip(tableItem, 'hand');
                    try {
                       await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
                       placed = true;
                       break;
                    } catch(e) {}
                 }
               }
               if (placed) break;
             }
             await new Promise(r => setTimeout(r, 500));
             craftingTable = bot.findBlock({ matching: tableId, maxDistance: 5 });
           }
         }
         if (!craftingTable) {
           canCraftRecipe = false;
           bestReason = "No crafting table nearby or in inventory, and couldn't place one.";
           continue; 
         }
       }

       // Perform the craft
       const mfRecipes = bot.recipesFor(itemId, null, craftOperations, craftingTable);
       if (mfRecipes.length > 0) {
         if (craftingTable && mfRecipes[0].requiresTable) {
           const defaultMove = new Movements(bot);
           bot.pathfinder.setMovements(defaultMove);
           await bot.pathfinder.goto(new goals.GoalGetToBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z));
         }
         try {
           await bot.craft(mfRecipes[0], craftOperations, craftingTable);
           return { success: true, reason: '' };
         } catch (e) {
           return { success: false, reason: `Mineflayer craft error: ${e.message}` };
         }
       } else {
         const itemType = bot.registry.items[itemId];
         bestReason = `Missing ingredients for ${itemType?.name || itemId}. If you had enough raw materials, they might have been consumed crafting a required intermediate item (like a crafting_table or sticks). Try gathering more raw materials.`;
       }
    }
  }

  return { success: false, reason: bestReason || lastReason };
}

// ─── Action Executor ──────────────────────────────────────────────────────────

/**
 * Executes the action chosen by the LLM.
 * @param {object} bot - The Mineflayer bot instance
 * @param {string} actionName - The name of the action to execute
 * @param {object} args - Arguments for the action (as returned by the LLM)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function executeAction(bot, actionName, args = {}) {
  try {
    switch (actionName) {

      case 'chat': {
        if (!args.message) return { success: false, message: 'No message provided' };
        bot.chat(args.message);
        return { success: true, message: `Said: "${args.message}"` };
      }

      case 'move_to': {
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);

        if (args.player_name) {
          const target = bot.players[args.player_name]?.entity;
          if (!target) return { success: false, message: `Cannot see player: ${args.player_name}` };
          const p = target.position;
          bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2));
          return { success: true, message: `Pathfinding to player: ${args.player_name}` };
        }

        if (args.x !== undefined && args.z !== undefined) {
          const y = args.y ?? bot.entity.position.y;
          bot.pathfinder.setGoal(new goals.GoalNear(args.x, y, args.z, 1));
          return { success: true, message: `Pathfinding to (${args.x}, ${y}, ${args.z})` };
        }

        return { success: false, message: 'move_to requires player_name or x/z coordinates' };
      }

      case 'mine_block': {
        if (!args.block_type) return { success: false, message: 'No block_type provided' };

        const blockType = bot.registry.blocksByName[args.block_type];
        if (!blockType) return { success: false, message: `Unknown block type: ${args.block_type}` };

        // Only cap low-value blocks to prevent hoarding useless materials
        if (LOW_VALUE_BLOCKS.has(args.block_type) && bot.inventory.count(blockType.id) >= 64) {
          return { success: false, message: `You already have plenty of ${args.block_type} (64+). You do not need to mine more.` };
        }

        const PICKAXE_TIERS = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
        
        let requiredTier = 0;
        if (['stone', 'cobblestone', 'coal_ore', 'deepslate_coal_ore', 'netherrack'].includes(args.block_type)) requiredTier = 1;
        if (['iron_ore', 'deepslate_iron_ore', 'lapis_ore', 'deepslate_lapis_ore', 'deepslate', 'copper_ore', 'deepslate_copper_ore'].includes(args.block_type)) requiredTier = 2;
        if (['gold_ore', 'deepslate_gold_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'redstone_ore', 'deepslate_redstone_ore'].includes(args.block_type)) requiredTier = 3;
        if (['obsidian', 'crying_obsidian'].includes(args.block_type)) requiredTier = 4;

        if (requiredTier > 0) {
          const pickaxes = bot.inventory.items().filter(i => i.name.includes('pickaxe'));
          let bestPickaxe = null;
          let bestTier = 0;
          
          for (const p of pickaxes) {
            const tier = PICKAXE_TIERS[p.name] || 0;
            if (tier >= requiredTier && tier > bestTier) {
              bestPickaxe = p;
              bestTier = tier;
            }
          }

          if (!bestPickaxe) {
            const tierNames = ['', 'wooden', 'stone', 'iron', 'diamond'];
            return { success: false, message: `Cannot mine ${args.block_type}. You need a ${tierNames[requiredTier]}_pickaxe or better. Craft one first.` };
          }

          // Equip the best valid pickaxe if not already holding it
          if (!bot.heldItem || bot.heldItem.name !== bestPickaxe.name) {
             await bot.equip(bestPickaxe, 'hand');
             log(`Auto-equipped ${bestPickaxe.name} (tier ${bestTier}) for mining ${args.block_type}`, 'BRAIN');
          }
        }

        // Search at progressively larger distances
        let block = null;
        for (const searchDist of [32, 64]) {
          block = bot.findBlock({
            matching: blockType.id,
            maxDistance: searchDist,
          });
          if (block) break;
        }

        if (!block) return { success: false, message: `No ${args.block_type} found within 64 blocks. Try using explore_randomly to move to a new area, or if looking for ores, try going underground.` };

        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);

        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
        
        if (bot.entity.position.distanceTo(block.position) > 6) {
          return { success: false, message: 'Pathfinder finished but block is still out of reach.' };
        }

        try {
          const expectedDigTime = bot.digTime(block);
          const timeoutDuration = Math.max(10000, expectedDigTime + 5000);
          log(`Mining ${args.block_type} at ${block.position.toString()}. Expected dig time: ${expectedDigTime}ms, timeout: ${timeoutDuration}ms`, 'ACTION');
          
          await Promise.race([
            bot.dig(block),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Dig timeout (waited ${timeoutDuration}ms, expected ${expectedDigTime}ms)`)), timeoutDuration))
          ]);
        } catch (err) {
          bot.stopDigging();
          throw err;
        }

        return { success: true, message: `Mined ${args.block_type} at ${block.position.toString()}` };
      }

      case 'follow_player': {
        if (!args.player_name) return { success: false, message: 'No player_name provided' };
        const target = bot.players[args.player_name]?.entity;
        if (!target) return { success: false, message: `Cannot see player: ${args.player_name}` };

        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        // GoalFollow keeps re-computing as the player moves
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
        return { success: true, message: `Following player: ${args.player_name}` };
      }

      case 'attack_nearest_mob': {
        const maxDist = args.max_distance ?? 16;
        const HOSTILE_TYPES = new Set([
          'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
          'enderman', 'witch', 'blaze', 'ghast', 'zombie_piglin',
          'hoglin', 'piglin_brute', 'warden', 'phantom',
        ]);

        // Find all nearby entities, filter by hostile type and distance
        let closestMob = null;
        let closestDist = Infinity;

        for (const entity of Object.values(bot.entities)) {
          if (entity === bot.entity) continue;
          if (entity.type !== 'mob') continue;
          const mobName = entity.name ?? entity.displayName ?? '';
          if (!HOSTILE_TYPES.has(mobName.toLowerCase())) continue;
          const dist = bot.entity.position.distanceTo(entity.position);
          if (dist < closestDist && dist <= maxDist) {
            closestDist = dist;
            closestMob = entity;
          }
        }

        if (!closestMob) return { success: false, message: `No hostile mob within ${maxDist} blocks` };

        // Try to equip best sword/weapon before attacking
        await equipBestWeapon(bot);

        // Pathfind to within melee range, then attack
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalMeleeAttack(closestMob, 1));
        bot.attack(closestMob);
        return { success: true, message: `Attacking ${closestMob.name ?? 'mob'} at distance ${closestDist.toFixed(1)}` };
      }

      case 'flee': {
        let closestMob = null;
        let closestDist = Infinity;
        for (const entity of Object.values(bot.entities)) {
          if (entity === bot.entity || entity.type !== 'mob') continue;
          const mobName = entity.name ?? entity.displayName ?? '';
          if (!HOSTILE_MOB_NAMES.has(mobName.toLowerCase())) continue;
          const dist = bot.entity.position.distanceTo(entity.position);
          if (dist < closestDist) {
            closestDist = dist;
            closestMob = entity;
          }
        }
        
        if (!closestMob) return { success: true, message: 'No hostile mobs nearby, fleeing unnecessary.' };
        
        // Find a point in the opposite direction
        const dx = bot.entity.position.x - closestMob.position.x;
        const dz = bot.entity.position.z - closestMob.position.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        if (dist === 0) return { success: false, message: 'Mob is exactly on top of bot, cannot determine flee direction.' };
        
        const fleeDistance = 16;
        const targetX = bot.entity.position.x + (dx / dist) * fleeDistance;
        const targetZ = bot.entity.position.z + (dz / dist) * fleeDistance;
        const targetY = bot.entity.position.y;
        
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalNear(targetX, targetY, targetZ, 2));
        
        return { success: true, message: `Fled from ${closestMob.name ?? 'mob'}` };
      }

      case 'equip_item': {
        const itemType = bot.registry.itemsByName[args.item_name];
        if (!itemType) return { success: false, message: `Unknown item: ${args.item_name}` };
        
        let item = bot.inventory.items().find(i => i.name === args.item_name);
        
        // If not in inventory, try to auto-craft it
        if (!item) {
          try {
            const result = await autoCraft(bot, itemType.id, 1);
            if (result.success) {
              item = bot.inventory.items().find(i => i.name === args.item_name);
            }
          } catch (err) {
            return { success: false, message: `Failed to auto-craft ${args.item_name}: ${err.message}` };
          }
        }

        if (!item) return { success: false, message: `Do not have ${args.item_name} in inventory and could not auto-craft it (missing raw materials).` };
        
        const armorTypes = {
          head: ['helmet', 'cap', 'skull'],
          torso: ['chestplate', 'tunic', 'elytra'],
          legs: ['leggings', 'pants'],
          feet: ['boots']
        };

        let autoDest = null;
        for (const [slot, keywords] of Object.entries(armorTypes)) {
          if (keywords.some(kw => args.item_name.includes(kw))) {
             autoDest = slot;
             break;
          }
        }

        let dest = autoDest || args.destination || 'hand';
        if (dest === 'main_hand') dest = 'hand';

        if (['head', 'torso', 'legs', 'feet'].includes(dest) && !autoDest) {
           return { success: false, message: `${args.item_name} is not valid armor and cannot be equipped to the ${dest} slot.` };
        }

        const armorSlots = { head: 5, torso: 6, legs: 7, feet: 8 };
        if (dest === 'hand') {
          const held = bot.heldItem;
          if (held && held.name === args.item_name) {
             return { success: true, message: `${args.item_name} is already equipped in your hand.` };
          }
        } else if (armorSlots[dest]) {
          const equipped = bot.inventory.slots[armorSlots[dest]];
          if (equipped && equipped.name === args.item_name) {
             return { success: true, message: `${args.item_name} is already equipped in the ${dest} slot.` };
          }
        }
        
        try {
          await bot.equip(item, dest);
          return { success: true, message: `Equipped ${args.item_name} to ${dest}` };
        } catch (err) {
          return { success: false, message: `Failed to equip: ${err.message}` };
        }
      }

      case 'toss_item': {
        const itemType = bot.registry.itemsByName[args.item_name];
        if (!itemType) return { success: false, message: `Unknown item: ${args.item_name}` };
        try {
          if (args.count) {
            await bot.toss(itemType.id, null, args.count);
            return { success: true, message: `Tossed ${args.count} of ${args.item_name}` };
          } else {
            // attempts to toss up to a full stack if count is not provided
            await bot.toss(itemType.id, null, 64);
            return { success: true, message: `Tossed ${args.item_name}` };
          }
        } catch (err) {
          return { success: false, message: `Failed to toss: ${err.message}` };
        }
      }

      case 'craft_item': {
        const itemType = bot.registry.itemsByName[args.item_name];
        if (!itemType) return { success: false, message: `Unknown item: ${args.item_name}` };

        const recipes = bot.registry.recipes[itemType.id];
        if (!recipes || recipes.length === 0) {
          return { success: false, message: `${args.item_name} is not a craftable item. It must be mined, smelted, or gathered.` };
        }
        
        const count = args.count || 1;

        // If the bot already has enough of this item, tell it to move on
        if (bot.inventory.count(itemType.id) >= count) {
          return { 
            success: true, 
            message: `You already have ${bot.inventory.count(itemType.id)}x ${args.item_name} in your inventory — this goal is complete. The advancement planner will move you to the next goal automatically.`
          };
        }

        try {
          const result = await autoCraft(bot, itemType.id, count);
          if (result.success) {
            return { success: true, message: `Successfully crafted ${count} ${args.item_name}.` };
          } else {
            let msg = `Cannot craft ${args.item_name}. ${result.reason}`;
            if (result.reason.includes('inventory is full')) {
              msg += ' Free up space first using toss_item or store_in_container.';
            }
            return { success: false, message: msg };
          }
        } catch (err) {
          return { success: false, message: `Failed to craft ${args.item_name}: ${err.message}` };
        }
      }

      case 'smelt_item': {
        const itemType = bot.registry.itemsByName[args.input_name];
        if (!itemType) return { success: false, message: `Unknown input item: ${args.input_name}` };
        const fuelType = bot.registry.itemsByName[args.fuel_name];
        if (!fuelType) return { success: false, message: `Unknown fuel item: ${args.fuel_name}` };
        
        const count = args.count || 1;
        
        const outItemType = bot.registry.itemsByName[args.item_name];
        if (bot.inventory.emptySlotCount() === 0 && outItemType) {
           const existingItem = bot.inventory.items().find(i => i.name === outItemType.name && i.count < outItemType.stackSize);
           if (!existingItem) {
              return { success: false, message: `Inventory full — cannot safely produce ${args.item_name}. Use store_in_container or toss_item to free space first.` };
           }
        }
        if (bot.inventory.count(itemType.id) < count) {
          return { success: false, message: `You do not have enough ${args.input_name} to smelt. Have: ${bot.inventory.count(itemType.id)}, need: ${count}` };
        }
        if (bot.inventory.count(fuelType.id) < 1) {
          return { success: false, message: `You do not have any ${args.fuel_name} for fuel.` };
        }

        const furnaceId = bot.registry.blocksByName['furnace']?.id;
        let furnaceBlock = bot.findBlock({ matching: furnaceId, maxDistance: 32 });

        if (!furnaceBlock) {
          let furnaceItem = bot.inventory.items().find(i => i.name === 'furnace');
          if (!furnaceItem) {
             return { success: false, message: `No furnace found nearby and none in inventory. Craft a furnace first.` };
          }
          
          const defaultMove = new Movements(bot);
          bot.pathfinder.setMovements(defaultMove);
          let placed = false;
          for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              if (dx === 0 && dz === 0) continue;
              const pos = bot.entity.position.offset(dx, 0, dz).floored();
              const airBlock = bot.blockAt(pos);
              const groundBlock = bot.blockAt(pos.offset(0, -1, 0));
              if (airBlock && airBlock.name === 'air' && groundBlock && groundBlock.name !== 'air' && groundBlock.boundingBox === 'block') {
                 await bot.equip(furnaceItem, 'hand');
                 try {
                    await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
                    placed = true;
                    break;
                 } catch(e) {}
              }
            }
            if (placed) break;
          }
          
          if (!placed) return { success: false, message: `Failed to find a place to put down the furnace.` };
          await new Promise(r => setTimeout(r, 500));
          furnaceBlock = bot.findBlock({ matching: furnaceId, maxDistance: 5 });
        }

        if (!furnaceBlock) return { success: false, message: `Could not find furnace block after placing.` };

        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z));
        
        let furnace = null;
        try {
          furnace = await bot.openFurnace(furnaceBlock);
          
          try {
            // First, clear any existing output
            if (furnace.outputItem() && furnace.outputItem().count > 0) {
               await furnace.takeOutput();
            }

            // Put fuel if needed
            const currentFuel = furnace.fuelItem();
            log(`Current fuel: ${currentFuel ? currentFuel.name + 'x' + currentFuel.count : 'empty'}. Requested fuel: ${fuelType.name}`, 'ACTION');
            if (!currentFuel || currentFuel.count === 0) {
               log(`Attempting to put fuel: ${fuelType.name}`, 'ACTION');
               await furnace.putFuel(fuelType.id, null, 1);
               log(`Successfully put fuel`, 'ACTION');
            } else {
               log(`Fuel already present (${currentFuel.name} x${currentFuel.count}), skipping putFuel to avoid destination full mismatch.`, 'ACTION');
            }

            // Put input if needed
            const currentInput = furnace.inputItem();
            let neededToInsert = count;
            if (currentInput) {
               if (currentInput.type === itemType.id) {
                 neededToInsert = Math.max(0, count - currentInput.count);
               } else {
                 throw new Error("Furnace input slot is occupied by a different item.");
               }
            }
            
            if (neededToInsert > 0) {
               log(`Attempting to put input: ${neededToInsert}x ${itemType.name}`, 'ACTION');
               await furnace.putInput(itemType.id, null, neededToInsert);
               log(`Successfully put input`, 'ACTION');
            }
            
            log(`Furnace started. Waiting for ${count} ${args.item_name} to smelt...`, 'ACTION');
            
            // Wait for item to finish (shortened to 2s to not block decision loop)
            let stuckTimeout = 0;
            while (furnace.inputItem() && furnace.inputItem().count > 0 && stuckTimeout < 2) {
               await new Promise(r => setTimeout(r, 1000));
               stuckTimeout++;
            }
            
            if (furnace.outputItem() && furnace.outputItem().count > 0) {
               await furnace.takeOutput();
            }
            
            furnace.close();
            return { success: true, message: `Successfully smelted ${count} ${args.item_name}.` };
          } catch (e) {
            if (furnace) furnace.close();
            throw e;
          }
        } catch (err) {
          let debugMsg = '';
          if (furnace) {
             const emptySlots = bot.inventory.emptySlotCount();
             const inItem = furnace.inputItem();
             const fuelItem = furnace.fuelItem();
             const outItem = furnace.outputItem();
             debugMsg = ` | Inv free slots: ${emptySlots} | Furnace: [In: ${inItem ? inItem.name+'x'+inItem.count : 'empty'}] [Fuel: ${fuelItem ? fuelItem.name+'x'+fuelItem.count : 'empty'}] [Out: ${outItem ? outItem.name+'x'+outItem.count : 'empty'}]`;
             if (emptySlots === 0 && outItem && err.message.includes('destination full')) {
                 return { success: false, message: `Inventory full! Cannot collect output from furnace. Use toss_item to drop some items and free up space.` };
             }
          }
          return { success: false, message: `Failed to operate furnace: ${err.message}${debugMsg}` };
        }
      }

      case 'place_block': {
        const itemType = bot.registry.itemsByName[args.block_type];
        if (!itemType) return { success: false, message: `Unknown block/item: ${args.block_type}` };
        
        const item = bot.inventory.items().find(i => i.name === args.block_type);
        if (!item) return { success: false, message: `Do not have ${args.block_type} in inventory.` };

        try {
          const defaultMove = new Movements(bot);
          bot.pathfinder.setMovements(defaultMove);
          
          await bot.pathfinder.goto(new goals.GoalNear(args.x, args.y, args.z, 2));
          await bot.equip(item, 'hand');

          const pos = new Vec3(args.x, args.y, args.z);
          const offsets = [
            new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
          ];
          
          let refBlock = null;
          let faceVector = null;
          for (let offset of offsets) {
            const potentialRef = bot.blockAt(pos.plus(offset));
            if (potentialRef && potentialRef.name !== 'air') {
              refBlock = potentialRef;
              faceVector = new Vec3(0, 0, 0).minus(offset);
              break;
            }
          }

          if (!refBlock) {
             return { success: false, message: `Could not find an adjacent solid block to place ${args.block_type} against at (${args.x}, ${args.y}, ${args.z}).` };
          }
          
          await bot.placeBlock(refBlock, faceVector);
          return { success: true, message: `Placed ${args.block_type} at roughly (${args.x}, ${args.y}, ${args.z})` };
        } catch (err) {
          return { success: false, message: `Failed to place block: ${err.message}` };
        }
      }

      case 'hunt_animal': {
        let closestMob = null;
        let closestDist = Infinity;
        for (const entity of Object.values(bot.entities)) {
          if (entity === bot.entity || entity.type !== 'mob') continue;
          const mobName = entity.name ?? entity.displayName ?? '';
          if (!FOOD_ANIMAL_NAMES.has(mobName.toLowerCase())) continue;
          const dist = bot.entity.position.distanceTo(entity.position);
          if (dist < closestDist) {
            closestDist = dist;
            closestMob = entity;
          }
        }
        
        if (!closestMob) return { success: false, message: `No food animals found nearby. Try explore_randomly first.` };
        
        await equipBestWeapon(bot);
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalMeleeAttack(closestMob, 1));
        bot.attack(closestMob);
        return { success: true, message: `Attacked ${closestMob.name} for food. It may take multiple hits.` };
      }

      case 'gather_water': {
        const bucket = bot.inventory.items().find(i => i.name === 'bucket');
        if (!bucket) return { success: false, message: `You do not have an empty bucket.` };

        const waterId = bot.registry.blocksByName['water']?.id;
        if (!waterId) return { success: false, message: `Water not found in registry.` };
        
        const waterBlocks = bot.findBlocks({ matching: waterId, maxDistance: 64, count: 5 });
        if (waterBlocks.length === 0) return { success: false, message: `No water found nearby. Explore to find a lake or river.` };

        const targetWater = waterBlocks[0];
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        
        // Go near the water
        await bot.pathfinder.goto(new goals.GoalNear(targetWater.x, targetWater.y, targetWater.z, 2));
        
        await bot.equip(bucket, 'hand');
        
        try {
          const waterBlock = bot.blockAt(targetWater);
          await bot.lookAt(waterBlock.position.offset(0.5, 0.5, 0.5));
          bot.activateItem(); // Use the bucket on the water
          await new Promise(r => setTimeout(r, 1000));
          
          if (bot.inventory.items().find(i => i.name === 'water_bucket')) {
             return { success: true, message: `Successfully filled bucket with water.` };
          } else {
             return { success: false, message: `Used bucket but didn't get a water_bucket. You might have missed.` };
          }
        } catch (e) {
          return { success: false, message: `Failed to gather water: ${e.message}` };
        }
      }

      case 'build_nether_portal': {
        const obsidianCount = bot.inventory.items().filter(i => i.name === 'obsidian').reduce((acc, i) => acc + i.count, 0);
        if (obsidianCount < 14) return { success: false, message: `Need 14 obsidian to build portal. You have ${obsidianCount}.` };
        
        const flintAndSteel = bot.inventory.items().find(i => i.name === 'flint_and_steel');
        if (!flintAndSteel) return { success: false, message: `You need flint_and_steel to light the portal.` };

        // For simplicity, we just look for a flat area nearby and build it.
        // Or even simpler, just build it right in front of the bot.
        const botPos = bot.entity.position.floored();
        const basePos = botPos.offset(2, 0, 0);
        
        // This is a naive portal builder. It assumes space is clear or can be placed.
        const portalPositions = [
           basePos.offset(0,0,0), basePos.offset(0,0,1), basePos.offset(0,0,2), basePos.offset(0,0,3), // Bottom
           basePos.offset(0,1,0), basePos.offset(0,2,0), basePos.offset(0,3,0), // Left side
           basePos.offset(0,1,3), basePos.offset(0,2,3), basePos.offset(0,3,3), // Right side
           basePos.offset(0,4,0), basePos.offset(0,4,1), basePos.offset(0,4,2), basePos.offset(0,4,3)  // Top
        ];
        
        try {
           const obsidianItem = bot.inventory.items().find(i => i.name === 'obsidian');
           await bot.equip(obsidianItem, 'hand');
           for (const p of portalPositions) {
              const b = bot.blockAt(p);
              if (b && b.name === 'air') {
                 // Try placing against the block below
                 const ref = bot.blockAt(p.offset(0, -1, 0));
                 if (ref && ref.name !== 'air' && ref.boundingBox === 'block') {
                    await bot.placeBlock(ref, new Vec3(0,1,0));
                 }
              }
           }
           
           // Ignite
           await bot.equip(flintAndSteel, 'hand');
           const bottomInside = bot.blockAt(basePos.offset(0,1,1));
           if (bottomInside) {
             const bottomBlock = bot.blockAt(basePos.offset(0,0,1));
             await bot.placeBlock(bottomBlock, new Vec3(0,1,0));
           }

           return { success: true, message: `Attempted to build and light portal. If it worked, walk into it by moving near it.` };
        } catch (e) {
           return { success: false, message: `Failed to build portal: ${e.message}` };
        }
      }

      case 'make_obsidian': {
        const bucket = bot.inventory.items().find(i => i.name === 'water_bucket');
        if (!bucket) return { success: false, message: `You need a water_bucket in your inventory to make obsidian.` };

        const lavaId = bot.registry.blocksByName['lava']?.id;
        if (!lavaId) return { success: false, message: `Lava not found in registry.` };
        
        const lavaBlocks = bot.findBlocks({ matching: lavaId, maxDistance: 32, count: 5 });
        if (lavaBlocks.length === 0) return { success: false, message: `No lava found nearby. Go underground or explore.` };

        // Find a lava block that has a solid block next to it, so we can place water on the solid block
        let targetLava = null;
        let placeAgainst = null;
        let placeFace = null;
        for (const pos of lavaBlocks) {
          const offsets = [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)];
          for (const offset of offsets) {
             const neighbor = bot.blockAt(pos.plus(offset));
             if (neighbor && neighbor.name !== 'lava' && neighbor.name !== 'water' && neighbor.name !== 'air' && neighbor.boundingBox === 'block') {
                targetLava = pos;
                placeAgainst = neighbor;
                placeFace = new Vec3(0,0,0).minus(offset); // face towards the lava
                break;
             }
          }
          if (targetLava) break;
        }

        if (!targetLava) return { success: false, message: `Found lava, but no safe adjacent block to pour water onto.` };

        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        // Pathfind near the placeAgainst block
        await bot.pathfinder.goto(new goals.GoalNear(placeAgainst.position.x, placeAgainst.position.y, placeAgainst.position.z, 3));
        
        await bot.equip(bucket, 'hand');
        
        try {
          await bot.placeBlock(placeAgainst, placeFace);
          // Wait for water to flow and turn lava to obsidian
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // Now pick the water back up (using the empty bucket)
          const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
          if (emptyBucket) {
             await bot.equip(emptyBucket, 'hand');
             // Water should be in the same spot where we placed it (above targetLava or offset)
             // Try to interact with the block we placed water on. In mineflayer, picking up water usually involves activating the block we just hit or activating the water block directly.
             // Usually, right clicking with empty bucket on the water source block picks it up.
             const waterPos = placeAgainst.position.minus(placeFace);
             const waterBlock = bot.blockAt(waterPos);
             if (waterBlock && (waterBlock.name === 'water' || waterBlock.name === 'flowing_water')) {
               // A hacky way is to look at it and activateItem
               await bot.lookAt(waterPos.offset(0.5, 0.5, 0.5));
               bot.activateItem();
               await new Promise(resolve => setTimeout(resolve, 500));
             }
          }
          return { success: true, message: `Successfully poured water to make obsidian. Mine it with a diamond_pickaxe.` };
        } catch (e) {
           return { success: false, message: `Failed to pour water: ${e.message}` };
        }
      }

      case 'store_in_container': {
        const chestId = bot.registry.blocksByName['chest']?.id;
        const barrelId = bot.registry.blocksByName['barrel']?.id;
        
        let containerBlock = null;
        if (chestId) containerBlock = bot.findBlock({ matching: chestId, maxDistance: 16 });
        if (!containerBlock && barrelId) containerBlock = bot.findBlock({ matching: barrelId, maxDistance: 16 });
        
        if (!containerBlock) return { success: false, message: `No chest or barrel found within 16 blocks.` };
        
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(containerBlock.position.x, containerBlock.position.y, containerBlock.position.z));
        
        let container = null;
        try {
          container = await bot.openContainer(containerBlock);
          
          let deposited = [];
          if (args.item_name === 'overflow') {
            const trash = ['cobblestone', 'dirt', 'sand', 'gravel', 'andesite', 'diorite', 'granite'];
            for (const item of bot.inventory.items()) {
              if (trash.includes(item.name)) {
                try {
                  await container.deposit(item.type, item.metadata, item.count);
                  deposited.push(`${item.name} x${item.count}`);
                } catch(e) { }
              }
            }
          } else {
            const itemType = bot.registry.itemsByName[args.item_name];
            if (!itemType) { container.close(); return { success: false, message: `Unknown item: ${args.item_name}` }; }
            
            let amount = args.count;
            if (!amount) {
              amount = bot.inventory.items().filter(i => i.name === args.item_name).reduce((sum, i) => sum + i.count, 0);
            }
            if (amount > 0) {
              await container.deposit(itemType.id, null, amount);
              deposited.push(`${args.item_name} x${amount}`);
            }
          }
          
          container.close();
          if (deposited.length > 0) {
            return { success: true, message: `Deposited into container: ${deposited.join(', ')}` };
          } else {
            return { success: false, message: `Nothing was deposited. Container might be full or you don't have the item.` };
          }
        } catch (err) {
          if (container) container.close();
          return { success: false, message: `Failed to use container: ${err.message}` };
        }
      }

      case 'give_item_to_player': {
        if (!args.player_name) return { success: false, message: 'No player_name provided' };
        if (!args.item_name) return { success: false, message: 'No item_name provided' };
        
        const target = bot.players[args.player_name]?.entity;
        if (!target) return { success: false, message: `Cannot see player: ${args.player_name}` };
        
        const itemType = bot.registry.itemsByName[args.item_name];
        if (!itemType) return { success: false, message: `Unknown item: ${args.item_name}` };
        
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
        
        await bot.lookAt(target.position.offset(0, target.height, 0));
        
        try {
          const amount = args.count || bot.inventory.items().filter(i => i.name === args.item_name).reduce((sum, i) => sum + i.count, 0);
          if (amount > 0) {
            await bot.toss(itemType.id, null, amount);
            return { success: true, message: `Gave ${amount} ${args.item_name} to ${args.player_name}` };
          } else {
            return { success: false, message: `You do not have any ${args.item_name} to give.` };
          }
        } catch (err) {
          return { success: false, message: `Failed to give item: ${err.message}` };
        }
      }

      case 'explore_randomly': {
        const distance = args.distance || 50;
        
        // Pick a random horizontal direction
        const angle = Math.random() * 2 * Math.PI;
        const targetX = bot.entity.position.x + Math.cos(angle) * distance;
        const targetZ = bot.entity.position.z + Math.sin(angle) * distance;
        const targetY = bot.entity.position.y;
        
        log(`Exploring randomly: heading ${distance} blocks in direction ${(angle * 180 / Math.PI).toFixed(0)}°`, 'ACTION');
        
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        
        try {
          // Use GoalNear with a generous radius so we don't get stuck on exact coordinates
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(targetX, targetY, targetZ, 5)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Exploration timeout')), 15000))
          ]);
        } catch (err) {
          // Even if pathfinding doesn't fully complete, we've likely moved somewhere new
          bot.pathfinder.setGoal(null);
        }
        
        const newPos = bot.entity.position;
        return { success: true, message: `Explored to (${newPos.x.toFixed(0)}, ${newPos.y.toFixed(0)}, ${newPos.z.toFixed(0)}). Look around for resources!` };
      }

      case 'idle': {
        return { success: true, message: 'Idling — no action taken' };
      }

      default:
        return { success: false, message: `Unknown action: ${actionName}` };
    }
  } catch (err) {
    return { success: false, message: `Action "${actionName}" threw an error: ${err.message}` };
  }
}

/**
 * Filters the available tools based on the current goal and nearby entities.
 * @param {string} targetAction - The current target action from the planner.
 * @param {Array} nearbyEntities - List of nearby entities.
 * @returns {Array} Filtered list of tool schemas.
 */
function getRelevantTools(targetAction, nearbyEntities, inventoryFull = false) {
  if (targetAction === 'none' || targetAction === 'free_explore') {
    return TOOL_SCHEMAS;
  }
  
  let hasHostile = false;
  for (const e of nearbyEntities) {
     if (e.type === 'mob') {
       const mobName = e.name ?? e.displayName ?? '';
       if (HOSTILE_MOB_NAMES.has(mobName.toLowerCase())) {
         hasHostile = true;
         break;
       }
     }
  }

  // When a target action is active, only provide the target action + whitelisted tools
  const universalTools = ['idle', 'toss_item', 'store_in_container', 'give_item_to_player', 'equip_item', 'explore_randomly', 'hunt_animal', 'build_nether_portal', 'gather_water', 'make_obsidian'];
  if (hasHostile) {
    universalTools.push('flee', 'attack_nearest_mob');
  }
  
  return TOOL_SCHEMAS.filter(t => t.name === targetAction || universalTools.includes(t.name));
}

module.exports = { TOOL_SCHEMAS, executeAction, getRelevantTools };
