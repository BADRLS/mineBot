/**
 * decisionLoop.js
 *
 * The main LLM decision loop for the Minecraft bot.
 * Triggers decisions periodically (idle check) or in response to events (chat).
 * Debounces chat events and avoids parallel LLM requests.
 */

const { askLLM } = require('./llm');
const { buildGameState } = require('./gameState');
const { TOOL_SCHEMAS, executeAction, getRelevantTools } = require('./actions');
const { getSystemPrompt } = require('../prompts/systemPrompt');
const { syncGoal } = require('./advancementPlanner');
const { SMELT_INPUTS } = require('./constants');

let intervalId = null;
let chatTimeoutId = null;
let botInstance = null;
let recentChat = [];
const MAX_CHAT_BUFFER = 10;
let isDeciding = false;
let actionHistory = []; // Tracks recent actions for loop detection
let rejectedActionHistory = []; // Separates short-circuited actions so they don't dilute loop detection
const MAX_ACTION_HISTORY = 5;
let isStuck = false;
let stuckReason = '';
let consecutiveLlmErrors = 0;

// Goal stagnation tracking
let lastGoalAction = '';
let lastGoalItem = '';
let consecutiveGoalTicks = 0;

function unstick() {
  if (isStuck) {
    isStuck = false;
    stuckReason = '';
    actionHistory = [];
    rejectedActionHistory = [];
    consecutiveGoalTicks = 0;
    log('Bot has been unstuck by command.', 'SYSTEM');
  }
}

function detectLoop(newAction, newArgs) {
  if (newAction === 'idle' || newAction === 'chat') return 0;
  
  let identicalFailures = 0;
  for (let i = actionHistory.length - 1; i >= 0; i--) {
    const hist = actionHistory[i];
    if (hist.action === newAction) {
      if ((newAction === 'move_to' || newAction === 'place_block') && hist.args.x !== undefined && newArgs.x !== undefined) {
        const dx = Math.abs(hist.args.x - newArgs.x);
        const dz = Math.abs(hist.args.z - newArgs.z);
        if (dx <= 2 && dz <= 2) {
           if (!hist.success) identicalFailures++;
        }
      } else if (JSON.stringify(hist.args) === JSON.stringify(newArgs)) {
        if (!hist.success) identicalFailures++;
      }
    }
  }
  return identicalFailures;
}

// Config values from .env
const DECISION_INTERVAL_MS = parseInt(process.env.DECISION_INTERVAL_MS) || 15000;
const CHAT_DEBOUNCE_MS = parseInt(process.env.CHAT_DEBOUNCE_MS) || 1500;

function log(message, type = 'BRAIN') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${message}`);
}

function scheduleNextDecision(overrideDelay) {
  if (intervalId) clearTimeout(intervalId);
  const delay = overrideDelay !== undefined ? overrideDelay : DECISION_INTERVAL_MS;
  intervalId = setTimeout(() => {
    triggerDecision('idle interval check');
  }, delay);
}

async function autoDeclutterInventory(bot) {
  if (!bot || !bot.inventory || bot.inventory.emptySlotCount() > 1) return;

  const caps = {
    'cobblestone': 64,
    'dirt': 64,
    'netherrack': 64,
    'andesite': 16,
    'diorite': 16,
    'granite': 16,
    'cobbled_deepslate': 16,
    'clay_ball': 16,
    'bamboo': 16,
    'sand': 8,
    'gravel': 8
  };

  let chestBlock = null;
  const chestId = bot.registry.blocksByName['chest']?.id;
  if (chestId) {
    chestBlock = bot.findBlock({ matching: chestId, maxDistance: 5 });
  }

  let container = null;
  if (chestBlock) {
    try {
      container = await bot.openContainer(chestBlock);
    } catch (e) {
      container = null;
    }
  }

  for (const [name, limit] of Object.entries(caps)) {
    if (bot.inventory.emptySlotCount() >= 2) break;
    
    const items = bot.inventory.items().filter(i => i.name === name);
    const totalCount = items.reduce((sum, i) => sum + i.count, 0);
    const excess = totalCount - limit;
    
    if (excess > 0) {
      const typeId = items[0].type;
      let tossedOrStored = false;
      if (container) {
        try {
          await container.deposit(typeId, null, excess);
          tossedOrStored = true;
          log(`[INVENTORY] Auto-deposited ${excess} ${name} to free space.`, 'SYSTEM');
        } catch (e) {}
      }
      
      if (!tossedOrStored) {
        try {
          await bot.toss(typeId, null, excess);
          log(`[INVENTORY] Auto-tossed ${excess} ${name} to free space.`, 'SYSTEM');
        } catch (e) {}
      }
    }
  }

  if (container) {
    try { container.close(); } catch (e) {}
  }
}

/**
 * Gathers current game state and requests an action decision from the LLM.
 * @param {string} triggerReason - Explanation of why this decision was triggered
 */
async function triggerDecision(triggerReason) {
  if (!botInstance) return;
  if (isStuck) {
    log(`Decision tick skipped (${triggerReason}): Bot is STUCK (${stuckReason}). Waiting for !resume command.`, 'BRAIN');
    return;
  }
  if (isPaused) {
    log(`Decision tick skipped (${triggerReason}): Decision loop is PAUSED (likely in combat).`, 'BRAIN');
    return;
  }
  if (isDeciding) {
    log(`Decision tick skipped (${triggerReason}): LLM call already in progress.`, 'BRAIN');
    return;
  }

  isDeciding = true;
  log(`Triggering decision. Reason: ${triggerReason}`, 'BRAIN');
  let nextDelay = DECISION_INTERVAL_MS;

  // Always sync the goal from the advancement planner.
  // This overrides any stale goal the LLM may have set itself.
  const synced = syncGoal(botInstance);
  log(`[PLANNER] Active goal: "${synced.goal}" (target: ${synced.target_item})`, 'BRAIN');

  if (synced.target_action === lastGoalAction && synced.target_item === lastGoalItem && synced.target_action !== 'none' && synced.target_action !== 'free_explore') {
    consecutiveGoalTicks++;
  } else {
    lastGoalAction = synced.target_action;
    lastGoalItem = synced.target_item;
    consecutiveGoalTicks = 1;
  }

  if (consecutiveGoalTicks >= 8) {
    isStuck = true;
    stuckReason = `Goal stagnation: repeated failures trying to ${synced.target_action} ${synced.target_item}.`;
    botInstance.chat(`! I am stuck trying to complete my goal (${synced.target_action} ${synced.target_item}). I might need help or a !resume.`);
    log(`Goal stagnation detected! Bot is now STUCK.`, 'WARNING');
    return;
  }

  // Global stuck check based on position
  if (actionHistory.length >= MAX_ACTION_HISTORY) {
    let allNonIdle = true;
    let posChanged = false;
    const currentPos = botInstance.entity.position;
    for (const hist of actionHistory) {
      if (hist.action === 'idle' || hist.action === 'chat') allNonIdle = false;
      if (hist.pos && hist.pos.distanceTo(currentPos) > 1.5) {
         posChanged = true;
      }
    }
    if (allNonIdle && !posChanged) {
      isStuck = true;
      stuckReason = 'Position has not changed over multiple actions. The bot may be trapped or failing to pathfind.';
      botInstance.chat(`! I seem to be physically stuck in one place. Need help!`);
      log(`Global stuck check triggered.`, 'WARNING');
      return;
    }
  }

  await autoDeclutterInventory(botInstance);

  try {
    const systemPrompt = getSystemPrompt();
    const stateObj = buildGameState(botInstance, recentChat, actionHistory, isStuck, stuckReason);
    const userMessage = JSON.stringify(stateObj, null, 2);

    log('--- FULL LLM PROMPT ---', 'BRAIN');
    console.log(userMessage);
    log('-----------------------', 'BRAIN');

    log(`Sending game state to LLM (provider: ${process.env.LLM_PROVIDER || 'ollama'})...`, 'BRAIN');
    
    let decision;
    try {
      const relevantTools = getRelevantTools(stateObj.target_action, Object.values(botInstance.entities));
      decision = await askLLM(systemPrompt, userMessage, relevantTools, stateObj.target_action);
      consecutiveLlmErrors = 0;
    } catch (err) {
      consecutiveLlmErrors++;
      if (consecutiveLlmErrors >= 3) {
        isStuck = true;
        stuckReason = 'LLM API appears to be down';
        log('Circuit breaker triggered: LLM API appears to be down.', 'ERROR');
      }
      throw err;
    }
    
    log(`LLM response received. Action: "${decision.action}", Args: ${JSON.stringify(decision.args)}`, 'BRAIN');

    // Whitelist maintenance actions and conditional emergencies
    const maintenanceActions = ['toss_item', 'store_in_container', 'give_item_to_player', 'equip_item'];
    let emergencyActions = [];
    if (stateObj.health_status === 'LOW' || stateObj.health_status === 'CRITICAL' || stateObj.nearby_entities.some(e => e.is_threat)) {
      emergencyActions = ['flee', 'attack_nearest_mob'];
    }
    const isWhitelisted = maintenanceActions.includes(decision.action) || emergencyActions.includes(decision.action);

    // Strict target_action enforcement
    if (!isWhitelisted && stateObj.target_action !== 'none' && stateObj.target_action !== 'free_explore' && decision.action !== stateObj.target_action) {
      log(`Rejecting invalid action: target_action is "${stateObj.target_action}" but LLM chose "${decision.action}"`, 'WARNING');
      const shortCircuitResult = {
        success: false,
        message: `Invalid action. Your target_action is "${stateObj.target_action}" — you must call that tool, not "${decision.action}". Re-read current_goal and target_item.`
      };
      
      rejectedActionHistory.push({
        action: decision.action,
        args: decision.args,
        success: shortCircuitResult.success,
        message: shortCircuitResult.message,
        pos: botInstance.entity.position.clone(),
      });
      if (rejectedActionHistory.length > MAX_ACTION_HISTORY) rejectedActionHistory.shift();
      
      consecutiveGoalTicks++; // Rejections count toward stagnation
      nextDelay = 3000;
      return;
    }

    if (decision.action === 'craft_item' && stateObj.target_item && stateObj.target_item !== 'none') {
      const targetItemType = botInstance.registry.itemsByName[stateObj.target_item];
      const hasRecipes = targetItemType && botInstance.registry.recipes[targetItemType.id] && botInstance.registry.recipes[targetItemType.id].length > 0;
      
      if (!hasRecipes) {
        log(`Rejecting craft_item: Target item ${stateObj.target_item} is not craftable.`, 'BRAIN');
        const shortCircuitResult = {
          success: false,
          message: `Your goal is to get ${stateObj.target_item}, but it cannot be crafted. Use mine_block or another action instead. Do NOT use craft_item for ${stateObj.target_item}.`
        };
        
        actionHistory.push({
          action: decision.action,
          args: decision.args,
          success: shortCircuitResult.success,
          message: shortCircuitResult.message,
        });
        if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
        
        log(`Action execution failed: ${shortCircuitResult.message}`, 'WARNING');
        nextDelay = 3000;
        return;
      } else if (decision.args.item_name !== stateObj.target_item) {
        log(`Auto-correcting craft_item item_name from "${decision.args.item_name}" to "${stateObj.target_item}"`, 'BRAIN');
        decision.args.item_name = stateObj.target_item;
      }
      
      if (stateObj.target_count_remaining > 0) {
        decision.args.count = stateObj.target_count_remaining;
      } else {
        decision.args.count = decision.args.count || 1;
      }
    } else if (decision.action === 'smelt_item' && stateObj.target_item && stateObj.target_item !== 'none') {
       if (decision.args.item_name !== stateObj.target_item) {
         log(`Auto-correcting smelt_item item_name from "${decision.args.item_name}" to "${stateObj.target_item}"`, 'BRAIN');
         decision.args.item_name = stateObj.target_item;
       }
       // If input or fuel is missing, we can try to guess it based on target_item, but ideally the LLM gets it.
       if (!decision.args.input_name && SMELT_INPUTS[stateObj.target_item]) decision.args.input_name = SMELT_INPUTS[stateObj.target_item];
       if (!decision.args.fuel_name) {
          const fuelPrefs = ['coal', 'charcoal', 'oak_log', 'birch_log', 'spruce_log', 'oak_planks', 'birch_planks', 'jungle_log', 'dark_oak_log', 'acacia_log', 'mangrove_log', 'cherry_log', 'jungle_planks', 'dark_oak_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks'];
          for (const pref of fuelPrefs) {
             if (botInstance.inventory.items().some(i => i.name === pref)) {
                decision.args.fuel_name = pref;
                break;
             }
          }
       }
       
       if (stateObj.target_count_remaining > 0) {
         let inputCount = 0;
         if (decision.args.input_name) {
           inputCount = botInstance.inventory.items().filter(i => i.name === decision.args.input_name).reduce((sum, i) => sum + i.count, 0);
         }
         let fuelCount = 0;
         if (decision.args.fuel_name) {
           fuelCount = botInstance.inventory.items().filter(i => i.name === decision.args.fuel_name).reduce((sum, i) => sum + i.count, 0);
         }
         const maxAchievable = Math.min(inputCount, fuelCount * 8);
         decision.args.count = Math.max(1, Math.min(stateObj.target_count_remaining, maxAchievable));
       } else {
         decision.args.count = decision.args.count || 1;
       }
    }

    const loopCount = detectLoop(decision.action, decision.args);
    if (loopCount >= 3) {
      isStuck = true;
      stuckReason = `Repeated action ${decision.action} too many times with no progress.`;
      botInstance.chat(`! I am stuck in a loop trying to do ${decision.action}. Please help! Use !resume to unstick me.`);
      log(`Loop detected! Bot is now STUCK.`, 'WARNING');
      nextDelay = 3000;
      return;
    }

    let result;
    if (loopCount >= 1) {
      result = {
        success: false,
        message: "You already tried this exact action and it failed. Stop trying this — it is not a valid action for your current goal. Try a completely different action."
      };
      log(`Action short-circuited due to failure loop: ${decision.action}`, 'WARNING');
    } else {
      result = await Promise.race([
        executeAction(botInstance, decision.action, decision.args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Action execution timed out after 20 seconds.')), 20000))
      ]).catch(err => ({ success: false, message: err.message }));
    }
    
    const actionResult = {
      action: decision.action,
      args: decision.args,
      success: result.success,
      message: result.message,
      pos: botInstance.entity.position.clone(),
    };
    
    actionHistory.push(actionResult);
    if (actionHistory.length > MAX_ACTION_HISTORY) {
      actionHistory.shift();
    }

    if (result.success) {
      log(`Action execution success: ${result.message}`, 'BRAIN');
      consecutiveGoalTicks = 0; // Reset stagnation counter on success
    } else {
      log(`Action execution failed: ${result.message}`, 'WARNING');
      nextDelay = 5000;
    }
  } catch (err) {
    log(`Error in decision loop: ${err.message}`, 'ERROR');
    nextDelay = 5000;
  } finally {
    isDeciding = false;
    scheduleNextDecision(nextDelay);
  }
}

/**
 * Handler for the bot's 'chat' event. Stores messages in the rolling buffer
 * and triggers a debounced decision request.
 */
function handleChat(username, message) {
  // Ignore own messages
  if (username === botInstance.username) return;

  // Skip bang-commands entirely, as they are handled deterministically in index.js
  if (message.startsWith('!')) return;

  // Add to rolling chat buffer
  recentChat.push({ player: username, message });
  if (recentChat.length > MAX_CHAT_BUFFER) {
    recentChat.shift();
  }

  // Debounce the decision trigger so rapid chat messages are grouped
  if (chatTimeoutId) clearTimeout(chatTimeoutId);
  chatTimeoutId = setTimeout(() => {
    triggerDecision(`chat message from ${username}`);
  }, CHAT_DEBOUNCE_MS);
}

/**
 * Starts the decision loop, attaching listeners and intervals.
 * @param {object} bot - The Mineflayer bot instance
 */
function startDecisionLoop(bot) {
  if (botInstance) {
    log('Decision loop already running. Stopping previous one first...', 'BRAIN');
    stopDecisionLoop();
  }

  botInstance = bot;
  recentChat = [];
  actionHistory = [];
  isStuck = false;
  isDeciding = false;

  // Listen for chat messages to trigger event-driven decisions
  botInstance.on('chat', handleChat);

  // Start the first interval check
  scheduleNextDecision();

  log(`Decision loop started. Interval: ${DECISION_INTERVAL_MS}ms, Chat Debounce: ${CHAT_DEBOUNCE_MS}ms`, 'BRAIN');
}

/**
 * Stops the decision loop and cleans up timers and listeners.
 */
function stopDecisionLoop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (chatTimeoutId) {
    clearTimeout(chatTimeoutId);
    chatTimeoutId = null;
  }
  if (botInstance) {
    botInstance.removeListener('chat', handleChat);
    botInstance = null;
  }
  log('Decision loop stopped.', 'BRAIN');
}

let isPaused = false;

function pauseDecisionLoop() {
  if (!isPaused) {
    isPaused = true;
    if (intervalId) {
      clearTimeout(intervalId);
      intervalId = null;
    }
    log('Decision loop paused (e.g. for combat).', 'BRAIN');
  }
}

function resumeDecisionLoop() {
  if (isPaused) {
    isPaused = false;
    log('Decision loop resumed.', 'BRAIN');
    scheduleNextDecision();
  }
}

module.exports = {
  startDecisionLoop,
  stopDecisionLoop,
  triggerDecision,
  pauseDecisionLoop,
  resumeDecisionLoop,
  unstick,
};
