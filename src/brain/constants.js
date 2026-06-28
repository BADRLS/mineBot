const HOSTILE_MOB_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'blaze', 'ghast', 'zombie_piglin',
  'hoglin', 'piglin_brute', 'warden', 'phantom', 'drowned',
  'husk', 'stray', 'pillager', 'ravager', 'vindicator',
  'evoker', 'vex', 'slime', 'magma_cube', 'silverfish',
  'guardian', 'elder_guardian', 'shulker', 'wither_skeleton',
]);

const FOOD_ANIMAL_NAMES = new Set([
  'cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom',
  'cod', 'salmon', 'tropical_fish',
]);

const SMELT_INPUTS = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  glass: 'sand',
  stone: 'cobblestone',
  charcoal: 'oak_log',
  cooked_beef: 'raw_beef',
  cooked_porkchop: 'raw_porkchop',
  cooked_chicken: 'raw_chicken',
  cooked_mutton: 'raw_mutton',
  cooked_rabbit: 'raw_rabbit',
  cooked_cod: 'raw_cod',
  cooked_salmon: 'raw_salmon',
};

// All food items the bot considers edible (cooked / safe)
const COOKED_FOOD_NAMES = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'apple',
  'golden_apple', 'enchanted_golden_apple', 'baked_potato', 'cookie',
  'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup',
  'sweet_berries', 'glow_berries', 'dried_kelp', 'cake',
]);

const RAW_FOOD_NAMES = new Set([
  'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton',
  'raw_rabbit', 'cod', 'salmon',
]);

module.exports = {
  HOSTILE_MOB_NAMES,
  FOOD_ANIMAL_NAMES,
  SMELT_INPUTS,
  COOKED_FOOD_NAMES,
  RAW_FOOD_NAMES,
};
