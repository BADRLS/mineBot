/**
 * decisionLoop.js
 *
 * The main LLM decision loop for the Minecraft bot.
 * Triggers decisions periodically (idle check) or in response to events (chat).
 * Debounces chat events and avoids parallel LLM requests.
 */

const { askLLM } = require('./llm');
const { buildGameState } = require('./gameState');
const { TOOL_SCHEMAS, executeAction } = require('./actions');
const { getSystemPrompt } = require('../prompts/systemPrompt');
const { syncGoal } = require('./advancementPlanner');

let intervalId = null;
let chatTimeoutId = null;
let botInstance = null;
let recentChat = [];
const MAX_CHAT_BUFFER = 10;
let isDeciding = false;
let actionHistory = []; // Tracks recent actions for loop detection
const MAX_ACTION_HISTORY = 5;
let isStuck = false;
let stuckReason = '';
let consecutiveLlmErrors = 0;

function unstick() {
  if (isStuck) {
    isStuck = false;
    stuckReason = '';
    actionHistory = [];
    log('Bot has been unstuck by command.', 'SYSTEM');
  }
}

function detectLoop(newAction, newArgs) {
  if (newAction === 'idle' || newAction === 'chat') return 0;
  
  let identicalFailures = 0;
  for (let i = actionHistory.length - 1; i >= 0; i--) {
    const hist = actionHistory[i];
    if (hist.action === newAction && JSON.stringify(hist.args) === JSON.stringify(newArgs)) {
      if (!hist.success) identicalFailures++;
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

function scheduleNextDecision() {
  if (intervalId) clearTimeout(intervalId);
  intervalId = setTimeout(() => {
    triggerDecision('idle interval check');
  }, DECISION_INTERVAL_MS);
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

  // Always sync the goal from the advancement planner.
  // This overrides any stale goal the LLM may have set itself.
  const synced = syncGoal(botInstance);
  log(`[PLANNER] Active goal: "${synced.goal}" (target: ${synced.target_item})`, 'BRAIN');

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
      decision = await askLLM(systemPrompt, userMessage, TOOL_SCHEMAS);
      consecutiveLlmErrors = 0;
    } catch (err) {
      consecutiveLlmErrors++;
      if (consecutiveLlmErrors >= 3) {
        isStuck = true;
        stuckReason = 'Ollama appears to be down';
        log('Circuit breaker triggered: Ollama appears to be down.', 'ERROR');
      }
      throw err;
    }
    
    log(`LLM response received. Action: "${decision.action}", Args: ${JSON.stringify(decision.args)}`, 'BRAIN');

    // Narrow auto-correction: Only correct craft_item <-> smelt_item mismatches.
    if (stateObj.target_action === 'smelt_item' && decision.action === 'craft_item') {
       log(`Auto-correcting action from "craft_item" to "smelt_item" to match target_action`, 'BRAIN');
       decision.action = 'smelt_item';
    } else if (stateObj.target_action === 'craft_item' && decision.action === 'smelt_item') {
       log(`Auto-correcting action from "smelt_item" to "craft_item" to match target_action`, 'BRAIN');
       decision.action = 'craft_item';
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
        isDeciding = false;
        scheduleNextDecision();
        return;
      } else if (decision.args.item_name !== stateObj.target_item) {
        log(`Auto-correcting craft_item item_name from "${decision.args.item_name}" to "${stateObj.target_item}"`, 'BRAIN');
        decision.args.item_name = stateObj.target_item;
      }
    } else if (decision.action === 'smelt_item' && stateObj.target_item && stateObj.target_item !== 'none') {
       if (decision.args.item_name !== stateObj.target_item) {
         log(`Auto-correcting smelt_item item_name from "${decision.args.item_name}" to "${stateObj.target_item}"`, 'BRAIN');
         decision.args.item_name = stateObj.target_item;
       }
       // If input or fuel is missing, we can try to guess it based on target_item, but ideally the LLM gets it.
       if (!decision.args.input_name && stateObj.target_item === 'iron_ingot') decision.args.input_name = 'raw_iron';
       if (!decision.args.fuel_name) {
          if (botInstance.inventory.items().some(i => i.name === 'coal')) decision.args.fuel_name = 'coal';
          else if (botInstance.inventory.items().some(i => i.name.includes('log') || i.name.includes('planks'))) {
             decision.args.fuel_name = botInstance.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks')).name;
          }
       }
    }

    const loopCount = detectLoop(decision.action, decision.args);
    if (loopCount >= 3) {
      isStuck = true;
      stuckReason = `Repeated action ${decision.action} too many times with no progress.`;
      botInstance.chat(`! I am stuck in a loop trying to do ${decision.action}. Please help! Use !resume to unstick me.`);
      log(`Loop detected! Bot is now STUCK.`, 'WARNING');
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
      result = await executeAction(botInstance, decision.action, decision.args);
    }
    
    const actionResult = {
      action: decision.action,
      args: decision.args,
      success: result.success,
      message: result.message,
    };
    
    actionHistory.push(actionResult);
    if (actionHistory.length > MAX_ACTION_HISTORY) {
      actionHistory.shift();
    }

    if (result.success) {
      log(`Action execution success: ${result.message}`, 'BRAIN');
    } else {
      log(`Action execution failed: ${result.message}`, 'WARNING');
    }
  } catch (err) {
    log(`Error in decision loop: ${err.message}`, 'ERROR');
  } finally {
    isDeciding = false;
    scheduleNextDecision();
  }
}

/**
 * Handler for the bot's 'chat' event. Stores messages in the rolling buffer
 * and triggers a debounced decision request.
 */
function handleChat(username, message) {
  // Ignore own messages
  if (username === botInstance.username) return;

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
