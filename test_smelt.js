const mineflayer = require('mineflayer');
const { executeAction } = require('./src/brain/actions');

const bot = mineflayer.createBot({
  host: 'BADRX2005-3gTq.aternos.me',
  port: 50671,
  username: 'TestBot_Antigrav',
  version: '1.21.11'
});

const pathfinder = require('mineflayer-pathfinder').pathfinder;
bot.loadPlugin(pathfinder);

bot.on('spawn', async () => {
  console.log('Spawned! Waiting for world to load...');
  await new Promise(r => setTimeout(r, 2000));
  
  // Need to be creative to give items if not OP
  bot.chat('/gamemode creative');
  await new Promise(r => setTimeout(r, 500));
  
  bot.chat('/give @s furnace 1');
  bot.chat('/give @s coal 64');
  bot.chat('/give @s raw_iron 64');
  bot.chat('/give @s iron_helmet 1');
  bot.chat('/give @s wooden_pickaxe 1');

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n--- Test 1: Equip invalid armor ---');
  let res = await executeAction(bot, 'equip_item', { destination: 'head', item_name: 'wooden_pickaxe' });
  console.log('Result:', res);

  console.log('\n--- Test 2: Equip valid armor ---');
  res = await executeAction(bot, 'equip_item', { destination: 'head', item_name: 'iron_helmet' });
  console.log('Result:', res);

  console.log('\n--- Test 3: Smelt item ---');
  res = await executeAction(bot, 'smelt_item', { item_name: 'iron_ingot', input_name: 'raw_iron', fuel_name: 'coal', count: 1 });
  console.log('Result:', res);

  console.log('\nAll tests complete.');
  process.exit(0);
});

bot.on('error', err => console.log('Bot error:', err));
bot.on('end', () => console.log('Bot disconnected'));
