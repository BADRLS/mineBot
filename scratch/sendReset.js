const mineflayer = require('mineflayer');
require('dotenv').config();

const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT) || 25565;
const version = process.env.MC_VERSION && process.env.MC_VERSION !== 'false' ? process.env.MC_VERSION : false;

console.log(`Connecting to Minecraft server at ${host}:${port} as Reset_Trigger...`);

const botOptions = {
  host,
  port,
  username: 'Reset_Trigger',
  auth: 'offline',
};

if (version) {
  botOptions.version = version;
}

const bot = mineflayer.createBot(botOptions);

bot.on('spawn', () => {
  console.log("Connected to server! Sending !reset command...");
  bot.chat('!reset');
  
  // Wait 3 seconds and exit
  setTimeout(() => {
    console.log("Command sent. Disconnecting...");
    bot.quit();
    process.exit(0);
  }, 3000);
});

bot.on('error', (err) => {
  console.error("Connection error:", err.message);
  process.exit(1);
});

bot.on('kicked', (reason) => {
  console.log("Kicked from server:", reason);
  process.exit(1);
});
