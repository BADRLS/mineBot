/**
 * actions.js
 *
 * Defines the 6 actions the LLM can choose from, in two forms:
 *   1. TOOL_SCHEMAS  — the JSON schema sent to the LLM so it knows what's available
 *   2. executeAction — the function that actually carries out the chosen action in Mineflayer
 *
 * Adding a new action: add an entry to TOOL_SCHEMAS and a case in executeAction().
 */

const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

function log(message, type = 'ACTION') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${message}`);
}

// ─── Tool Schemas (sent to the LLM) ──────────────────────────────────────────

const TOOL_SCHEMAS = [
  {
    name: 'chat',
    description: 'Send a message in the Minecraft game chat. Use this to talk to players, react to events, or express thoughts.',
    input_schema: {
      type: 'object',
      properties: {
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
    description: 'Find and mine the nearest block of a given type. The bot will pathfind to it and break it.',
    input_schema: {
      type: 'object',
      properties: {
        block_type: {
          type: 'string',
          description: 'The Minecraft block type to mine, e.g. "oak_log", "stone", "coal_ore", "iron_ore".',
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
        max_distance: {
          type: 'number',
          description: 'Maximum search radius in blocks. Defaults to 16 if not provided.',
        },
      },
    },
  },
  {
    name: 'equip_item',
    description: 'Equip an item from your inventory to your hand, head, torso, legs, or feet.',
    input_schema: {
      type: 'object',
      properties: {
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
        item_name: { type: 'string', description: 'The item to toss.' },
        count: { type: 'number', description: 'How many to toss. Default is all of them.' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'craft_item',
    description: 'Craft an item. The bot will automatically use a nearby crafting table if required by the recipe.',
    input_schema: {
      type: 'object',
      properties: {
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
      properties: {},
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
  const recipes = bot.registry.recipes[itemId];
  if (!recipes || recipes.length === 0) return { success: false, reason: `No recipes found for item ${itemId}` };

  let lastReason = "Missing raw materials.";

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
          lastReason = `Missing raw materials (needs item ID ${reqId}).`;
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
           lastReason = "No crafting table nearby or in inventory, and couldn't place one.";
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
         lastReason = "Have items but recipesFor returned empty (Mineflayer bug or missing intermediate).";
       }
    }
  }

  return { success: false, reason: lastReason };
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

        if (bot.inventory.count(blockType.id) >= 32) {
          return { success: false, message: `You already have plenty of ${args.block_type}. You do not need to mine more for your current goal.` };
        }

        const PICKAXE_TIERS = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
        
        let requiredTier = 0;
        if (['stone', 'cobblestone', 'coal_ore', 'netherrack'].includes(args.block_type)) requiredTier = 1;
        if (['iron_ore', 'lapis_ore', 'deepslate'].includes(args.block_type)) requiredTier = 2;
        if (['gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore'].includes(args.block_type)) requiredTier = 3;
        if (['obsidian'].includes(args.block_type)) requiredTier = 4;

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

        const block = bot.findBlock({
          matching: blockType.id,
          maxDistance: 32,
        });

        if (!block) return { success: false, message: `No ${args.block_type} found within 32 blocks` };

        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);

        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
        
        if (bot.entity.position.distanceTo(block.position) > 6) {
          return { success: false, message: 'Pathfinder finished but block is still out of reach.' };
        }

        try {
          const expectedDigTime = bot.digTime(block);
          const timeoutDuration = Math.max(10000, expectedDigTime + 5000); // Give 5s buffer, min 10s
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

        // Pathfind to within melee range, then attack
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        await bot.pathfinder.goto(new goals.GoalMeleeAttack(closestMob, 1));
        bot.attack(closestMob);
        return { success: true, message: `Attacking ${closestMob.name ?? 'mob'} at distance ${closestDist.toFixed(1)}` };
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

        // CRITICAL: Stop the LLM from looping if it already has the item
        if (bot.inventory.count(itemType.id) >= count) {
          return { 
            success: false, 
            message: `You ALREADY HAVE ${args.item_name} in your inventory! Check your inventory. Do NOT craft it again. Move to the next step (like equipping it or crafting the final tool).`
          };
        }

        try {
          const result = await autoCraft(bot, itemType.id, count);
          if (result.success) {
            return { success: true, message: `Successfully crafted ${count} ${args.item_name}.` };
          } else {
            return { success: false, message: `Cannot craft ${args.item_name}. ${result.reason}` };
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

            // Put fuel if needed. Only add if there's no fuel.
            // We just ensure there's at least some fuel. We don't force it to match fuelType if it's already occupied.
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
                 // Already has some of the right type. Insert the remainder if any.
                 neededToInsert = Math.max(0, count - currentInput.count);
               } else {
                 // Wrong type in input slot. We can't easily extract it.
                 throw new Error("Furnace input slot is occupied by a different item.");
               }
            }
            
            if (neededToInsert > 0) {
               log(`Attempting to put input: ${neededToInsert}x ${itemType.name}`, 'ACTION');
               await furnace.putInput(itemType.id, null, neededToInsert);
               log(`Successfully put input`, 'ACTION');
            }
            
            log(`Furnace started. Waiting for ${count} ${args.item_name} to smelt...`, 'ACTION');
            
            // Wait for item to finish
            let stuckTimeout = 0;
            while (furnace.inputItem() && furnace.inputItem().count > 0 && stuckTimeout < 60) {
               await new Promise(r => setTimeout(r, 1000));
               stuckTimeout++;
            }
            
            if (stuckTimeout >= 60) {
               throw new Error("Smelting timed out after 60 seconds.");
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

module.exports = { TOOL_SCHEMAS, executeAction };
