const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
require('dotenv').config();

const { startDecisionLoop, stopDecisionLoop, unstick, pauseDecisionLoop, resumeDecisionLoop } = require('./src/brain/decisionLoop');

const autoeat = require('mineflayer-auto-eat').loader || require('mineflayer-auto-eat').plugin || require('mineflayer-auto-eat');
const pvp = require('mineflayer-pvp').plugin;
const armorManager = require('mineflayer-armor-manager');

// Retrieve connection options from environment variables
const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT) || 25565;
const username = process.env.MC_USERNAME || 'Bot_Antigravity';
// Parse version parameter: if empty or 'false', let mineflayer auto-negotiate
const version = process.env.MC_VERSION && process.env.MC_VERSION !== 'false' ? process.env.MC_VERSION : false;

let bot;
let reconnectTimeout;

function log(message, type = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${message}`);
}

function createBotInstance() {
  log(`Connecting to Minecraft server at ${host}:${port} as ${username}...`, 'SYSTEM');
  
  const botOptions = {
    host,
    port,
    username,
    // 'offline' auth tells Mineflayer not to attempt Microsoft/Mojang authentication.
    // This is required for cracked/offline-mode servers (online-mode=false in server.properties).
    auth: 'offline',
  };
  
  if (version) {
    botOptions.version = version;
    log(`Using explicitly configured version: ${version}`, 'SYSTEM');
  } else {
    log('Minecraft version not specified. Auto-negotiation enabled.', 'SYSTEM');
  }

  bot = mineflayer.createBot(botOptions);

  // Load Pathfinder plugin
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(autoeat);
  bot.loadPlugin(pvp);
  bot.loadPlugin(armorManager);

  // Register Event Handlers
  setupEventHandlers();
}

function setupEventHandlers() {
  // Spawn event
  bot.once('spawn', () => {
    log(`Bot successfully spawned in the world! Coordinates: ${bot.entity.position.toString()}`, 'SPAWN');
    bot.chat("Hello! Antigravity Phase 2 AI bot is online.");
    
    // Set up movements configuration
    const defaultMove = new Movements(bot);
    bot.pathfinder.setMovements(defaultMove);
    log('Pathfinder movements initialized.', 'SYSTEM');

    // Start Phase 2 LLM Decision Loop
    startDecisionLoop(bot);
    
    // Configure auto-eat (safeguard initialization)
    if (!bot.autoEat) {
      log('bot.autoEat was missing. Initializing manually.', 'SYSTEM');
      try {
        const { EatUtil } = require('mineflayer-auto-eat/dist/new.js');
        bot.autoEat = new EatUtil(bot);
      } catch (e) {
        log(`Failed to manually initialize autoEat: ${e.message}`, 'ERROR');
      }
    }

    if (bot.autoEat) {
      bot.autoEat.options = bot.autoEat.options || {}; // Provide a fallback for older versions if needed, but use bot.autoEat.options or opts.
      bot.autoEat.opts.minHunger = 16;
      bot.autoEat.opts.bannedFood = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'];
      
      // Enable auto-eat loop
      bot.autoEat.enableAuto();

      bot.autoEat.on('eatStart', (opts) => {
        log(`Eating ${opts.food.name}...`, 'SURVIVAL');
        pauseDecisionLoop();
      });

      bot.autoEat.on('eatFinish', () => {
        log(`Finished eating.`, 'SURVIVAL');
        resumeDecisionLoop();
      });
      
      bot.autoEat.on('eatFail', (err) => {
        log(`Failed to eat: ${err.message}`, 'SURVIVAL');
        resumeDecisionLoop();
      });
    }

    // Auto-equip best armor
    bot.armorManager.equipAll();

    // Auto-combat finish handler
    bot.on('stoppedAttacking', () => {
      log('Combat finished! Resuming normal operations.', 'COMBAT');
      resumeDecisionLoop();
    });
  });

  // Chat event
  bot.on('chat', (username, message) => {
    // Ignore own messages
    if (username === bot.username) return;

    log(`<${username}> ${message}`, 'CHAT');

    // Parse commands starting with "!"
    if (message.startsWith('!')) {
      handleChatCommand(username, message);
    }
  });

  // Whisper / Direct Message event
  bot.on('whisper', (username, message) => {
    log(`Whisper from <${username}>: ${message}`, 'WHISPER');
    if (message.startsWith('!')) {
      handleChatCommand(username, message);
    }
  });

  // Health and Hunger updates
  let lastHealth = 20;
  bot.on('health', () => {
    if (bot.health < lastHealth) {
      const drop = (lastHealth - bot.health).toFixed(1);
      
      // Look for nearby things that might have hurt us
      let suspect = "Unknown";
      
      // Check fall damage potential (velocity down)
      if (bot.entity.velocity && bot.entity.velocity.y < -0.5) {
        suspect = "Fall Damage (high downward velocity)";
      } 
      // Check for drowning (head in water)
      else if (bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.name === 'water') {
        suspect = "Drowning (head in water)";
      }
      // Check for suffocation (head inside block)
      else {
        const headBlock = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
        if (headBlock && headBlock.boundingBox === 'block' && headBlock.name !== 'water' && headBlock.name !== 'lava') {
          suspect = `Suffocation (head inside ${headBlock.name})`;
        } else {
          // Check for nearby mobs
          let closestMob = null;
          let closestDist = 3; // within melee range
          for (const entity of Object.values(bot.entities)) {
            if (entity === bot.entity || entity.type !== 'mob') continue;
            const dist = bot.entity.position.distanceTo(entity.position);
            if (dist < closestDist) {
              closestDist = dist;
              closestMob = entity.name || entity.displayName;
            }
          }
          if (closestMob) {
            suspect = `Mob attack (nearest mob: ${closestMob} at ${closestDist.toFixed(1)} blocks)`;
          } else {
            // Check what block bot is standing on/in
            const footBlock = bot.blockAt(bot.entity.position);
            if (footBlock && ['cactus', 'magma_block', 'sweet_berry_bush', 'campfire', 'lava'].includes(footBlock.name)) {
              suspect = `Environmental block (${footBlock.name})`;
            }
          }
        }
      }

      log(`WARNING: Health dropped by ${drop}! Health: ${bot.health.toFixed(1)}/20. Suspected cause: ${suspect}`, 'HEALTH_DROP');
    } else if (bot.health > lastHealth) {
      log(`Health regenerated by ${(bot.health - lastHealth).toFixed(1)}. Health: ${bot.health.toFixed(1)}/20`, 'HEALTH_REGEN');
    }
    
    lastHealth = bot.health;
    log(`Status Update - Health: ${bot.health.toFixed(1)}/20, Food: ${bot.food}/20`, 'STATUS');
  });

  // Damaged or Attacked (mineflayer 'entityHurt' event)
  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) {
      log(`Bot was hurt! Current health: ${bot.health.toFixed(1)}`, 'WARNING');
      
      // Auto-defense: find the nearest hostile mob and attack it
      const HOSTILE_TYPES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'blaze', 'ghast', 'zombie_piglin', 'hoglin', 'piglin_brute', 'warden', 'phantom', 'drowned', 'husk', 'stray', 'pillager', 'ravager', 'vindicator']);
      let closestMob = null;
      let closestDist = 16; // search radius for attacker
      for (const e of Object.values(bot.entities)) {
         if (e === bot.entity || e.type !== 'mob') continue;
         const mobName = e.name ?? e.displayName ?? '';
         if (!HOSTILE_TYPES.has(mobName.toLowerCase())) continue;
         const dist = bot.entity.position.distanceTo(e.position);
         if (dist < closestDist) {
           closestDist = dist;
           closestMob = e;
         }
      }
      
      if (closestMob && !bot.pvp.target) {
         log(`Auto-defense triggered! Engaging nearest hostile mob: ${closestMob.name}`, 'COMBAT');
         pauseDecisionLoop();
         
         // Try to equip best sword/weapon before attacking
         const weapons = bot.inventory.items().filter(i => i.name.includes('sword') || i.name.includes('axe'));
         if (weapons.length > 0) {
            // Very simple best-weapon logic: diamond > iron > stone > wooden
            const tierNames = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
            weapons.sort((a, b) => {
               const tierA = tierNames.findIndex(t => a.name.includes(t));
               const tierB = tierNames.findIndex(t => b.name.includes(t));
               return tierB - tierA; // higher tier first
            });
            bot.equip(weapons[0], 'hand').catch(() => {});
         }
         
         bot.pvp.attack(closestMob);
      }
    }
  });

  // Bot dies
  bot.on('death', () => {
    log('Bot died! Respawning automatically...', 'ALERT');
    bot.chat('Agh! I have fallen.');
    bot.respawn();
  });

  // Connection lost
  bot.on('end', (reason) => {
    log(`Connection closed: ${reason}`, 'SYSTEM');
    stopDecisionLoop();
    scheduleReconnect();
  });

  // Kicked from server
  bot.on('kicked', (reason) => {
    const reasonClean = typeof reason === 'object' ? JSON.stringify(reason) : reason;
    log(`Bot was kicked from the server. Reason: ${reasonClean}`, 'ERROR');
  });

  // Error handling
  bot.on('error', (err) => {
    log(`Error encountered: ${err.message}`, 'ERROR');
  });
}

function handleChatCommand(sender, message) {
  const parts = message.slice(1).trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  log(`Processing command: !${command} with args: [${args.join(', ')}] from player: ${sender}`, 'COMMAND');

  switch (command) {
    case 'come': {
      const playerEntity = bot.players[sender]?.entity;
      if (!playerEntity) {
        const msg = `I cannot see you, ${sender}! Stand closer or check render distance.`;
        log(msg, 'COMMAND_FAIL');
        bot.chat(msg);
        return;
      }
      
      const pos = playerEntity.position;
      log(`Pathfinding to player ${sender} at: ${pos.toString()}`, 'NAVIGATION');
      bot.chat(`On my way to you, ${sender}!`);
      
      try {
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
      } catch (err) {
        log(`Failed to pathfind: ${err.message}`, 'ERROR');
        bot.chat('I encountered an error trying to pathfind.');
      }
      break;
    }

    case 'goto': {
      if (args.length < 3) {
        bot.chat('Usage: !goto <x> <y> <z>');
        return;
      }
      const x = parseFloat(args[0]);
      const y = parseFloat(args[1]);
      const z = parseFloat(args[2]);

      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        bot.chat('Coordinates must be numbers. Usage: !goto <x> <y> <z>');
        return;
      }

      log(`Pathfinding to coordinates: (${x}, ${y}, ${z})`, 'NAVIGATION');
      bot.chat(`Navigating to ${x}, ${y}, ${z}...`);
      
      try {
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
      } catch (err) {
        log(`Failed to pathfind: ${err.message}`, 'ERROR');
        bot.chat('I encountered an error trying to pathfind.');
      }
      break;
    }

    case 'look': {
      const playerEntity = bot.players[sender]?.entity;
      if (!playerEntity) {
        bot.chat(`I cannot see you, ${sender}!`);
        return;
      }
      
      log(`Looking at player ${sender}`, 'ACTION');
      // Look at player's head (approximately offset by player height)
      bot.lookAt(playerEntity.position.offset(0, 1.6, 0));
      bot.chat(`Looking at you, ${sender}.`);
      break;
    }

    case 'stop': {
      log('Stopping all movement and pathfinding.', 'NAVIGATION');
      bot.pathfinder.setGoal(null);
      bot.chat('Stopped movement.');
      break;
    }

    case 'resume': {
      log('Resuming bot decision loop from STUCK state...', 'SYSTEM');
      unstick();
      bot.chat('I am unstuck and resuming operations!');
      break;
    }

    case 'status': {
      const pos = bot.entity.position;
      const x = pos.x.toFixed(1);
      const y = pos.y.toFixed(1);
      const z = pos.z.toFixed(1);
      const hp = bot.health.toFixed(1);
      const food = bot.food;
      
      const items = bot.inventory.items();
      const inventoryList = items.map(item => `${item.name} x${item.count}`).join(', ');
      const invString = inventoryList ? `Inventory: ${inventoryList}` : 'Inventory: empty';

      const statusMsg = `Status: Pos(${x}, ${y}, ${z}) | Health: ${hp}/20 | Hunger: ${food}/20 | ${invString}`;
      bot.chat(statusMsg);
      log(statusMsg, 'STATUS');
      break;
    }

    default:
      bot.chat(`Unknown command: !${command}. Available commands: !come, !goto, !look, !stop, !resume, !status`);
      break;
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  log('Reconnecting in 10 seconds...', 'SYSTEM');
  reconnectTimeout = setTimeout(() => {
    createBotInstance();
  }, 10000);
}

// Start the bot
createBotInstance();
