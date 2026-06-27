/**
 * gameState.js
 *
 * Builds a compact, token-efficient snapshot of the current game state.
 * This snapshot is serialised to JSON and sent to the LLM as the "user" message
 * on every decision tick.
 *
 * Design note: We deliberately keep this small. More context = more tokens = slower
 * and more expensive LLM calls. Only include what the model genuinely needs to decide.
 */

const { HOSTILE_MOB_NAMES } = require('./constants');

const MAX_NEARBY_ENTITIES  = 8;   // Show at most this many nearby entities
const MAX_NEARBY_BLOCKS    = 10;  // Show at most this many distinct nearby block types
const ENTITY_SCAN_RADIUS   = 24;  // Blocks radius to scan for entities
const BLOCK_SCAN_RADIUS    = 5;   // Blocks radius to scan for distinct block types

/**
 * Classifies an entity as 'hostile', 'passive', or 'player'.
 * @param {object} entity
 * @returns {string}
 */
function classifyEntity(entity) {
  if (entity.type === 'player') return 'player';
  const name = (entity.name ?? entity.displayName ?? '').toLowerCase();
  if (HOSTILE_MOB_NAMES.has(name)) return 'hostile';
  return 'passive';
}

/**
 * Builds and returns a game state snapshot object.
 * @param {object} bot - The Mineflayer bot instance
 * @param {Array}  recentChat - Rolling buffer of recent chat messages [{player, message}]
 * @param {object|null} lastActionResult - Result of the last executed action
 * @returns {object} Plain JS object suitable for JSON.stringify
 */
function buildGameState(bot, recentChat = [], actionHistory = [], isStuck = false, stuckReason = '') {
  const pos = bot.entity.position;

  // ── Position ──────────────────────────────────────────────────────────────
  const position = {
    x: Math.round(pos.x * 10) / 10,
    y: Math.round(pos.y * 10) / 10,
    z: Math.round(pos.z * 10) / 10,
  };

  // ── Vitals ────────────────────────────────────────────────────────────────
  const health = Math.round(bot.health * 10) / 10;
  const food   = bot.food;
  const health_status = health <= 6 ? 'CRITICAL' : health <= 12 ? 'LOW' : 'OK';
  const hunger_status = food <= 6 ? 'CRITICAL' : food <= 12 ? 'LOW' : 'OK';
  const needs_food = bot.brain_needs_food || false;

  // ── Inventory (non-empty slots, compact format) ───────────────────────────
  const invCounts = {};
  for (const item of bot.inventory.items()) {
    invCounts[item.name] = (invCounts[item.name] || 0) + item.count;
  }
  const inventory = Object.entries(invCounts).map(([name, count]) => `${name} x${count}`);
  const inventory_free_slots = bot.inventory.emptySlotCount();
  const inventory_full = inventory_free_slots <= 2;

  // ── Nearby Entities ───────────────────────────────────────────────────────
  const nearby_entities = Object.values(bot.entities)
    .filter(e => {
      if (e === bot.entity) return false;
      if (!e.position)      return false;
      return e.position.distanceTo(pos) <= ENTITY_SCAN_RADIUS;
    })
    .map(e => {
      const typeStr = classifyEntity(e);
      return {
        name:     e.username ?? e.name ?? e.displayName ?? 'unknown',
        distance: Math.round(e.position.distanceTo(pos) * 10) / 10,
        type:     typeStr,
        is_threat: typeStr === 'hostile',
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_NEARBY_ENTITIES);

  // ── Nearby Block Types ────────────────────────────────────────────────────
  // Sample a grid around the bot and collect distinct block names
  const blockNameSet = new Set();
  const r = BLOCK_SCAN_RADIUS;
  for (let dx = -r; dx <= r && blockNameSet.size < MAX_NEARBY_BLOCKS; dx++) {
    for (let dz = -r; dz <= r && blockNameSet.size < MAX_NEARBY_BLOCKS; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (block && block.name !== 'air') {
          blockNameSet.add(block.name);
        }
      }
    }
  }
  const nearby_blocks = [...blockNameSet].slice(0, MAX_NEARBY_BLOCKS);

  // ── Time of Day ───────────────────────────────────────────────────────────
  const timeOfDayTick = bot.time?.timeOfDay ?? 0;
  let time_of_day = 'day';
  if (timeOfDayTick >= 13000 && timeOfDayTick < 23000) time_of_day = 'night';
  else if (timeOfDayTick >= 12000 && timeOfDayTick < 13000) time_of_day = 'sunset';
  else if (timeOfDayTick >= 23000) time_of_day = 'sunrise';

  // ── Recent Chat (last 5 messages to keep context tight) ──────────────────
  const recent_chat = recentChat.slice(-5);

  const equipped_item = bot.heldItem ? bot.heldItem.name : 'none';

  const equipped_armor = {
    head:  bot.inventory.slots[5]?.name  || 'none',
    torso: bot.inventory.slots[6]?.name  || 'none',
    legs:  bot.inventory.slots[7]?.name  || 'none',
    feet:  bot.inventory.slots[8]?.name  || 'none',
  };

  const current_goal = bot.brain_current_goal || 'None. (Idle: Pursue Minecraft advancements!)';
  const target_item = bot.brain_target_item || 'none';
  const target_action = bot.brain_target_action || 'none';
  const target_count_remaining = bot.brain_target_count_remaining || 0;

  // Format recent actions for the LLM
  const recent_actions = actionHistory.length > 0 ? actionHistory.map(a => ({
    action: a.action,
    success: a.success,
    result: a.message,
  })) : [];

  const bot_status = isStuck ? `STUCK: ${stuckReason}` : 'OK';

  let target_block_found_at_distance = null;
  if (target_action === 'mine_block' && target_item !== 'none') {
    const blockType = bot.registry.blocksByName[target_item];
    if (blockType) {
      const block = bot.findBlock({ matching: blockType.id, maxDistance: 32 });
      if (block) {
        target_block_found_at_distance = Math.round(bot.entity.position.distanceTo(block.position) * 10) / 10;
      }
    }
  }

  return {
    current_goal,
    target_item,
    target_action,
    target_count_remaining,
    bot_status,
    recent_actions,
    position,
    health,
    health_status,
    food,
    hunger_status,
    needs_food,
    equipped_item,
    equipped_armor,
    inventory_free_slots,
    inventory_full,
    inventory,
    nearby_entities,
    nearby_blocks,
    target_block_found_at_distance,
    time_of_day,
    recent_chat,
  };
}

module.exports = { buildGameState };
