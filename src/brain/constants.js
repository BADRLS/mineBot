const HOSTILE_MOB_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'blaze', 'ghast', 'zombie_piglin',
  'hoglin', 'piglin_brute', 'warden', 'phantom', 'drowned',
  'husk', 'stray', 'pillager', 'ravager', 'vindicator',
]);

const SMELT_INPUTS = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  glass: 'sand',
  stone: 'cobblestone',
};

module.exports = {
  HOSTILE_MOB_NAMES,
  SMELT_INPUTS,
};
