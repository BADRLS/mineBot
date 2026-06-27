require('dotenv').config();
const { askLLM } = require('./src/brain/llm');
const { getSystemPrompt } = require('./src/prompts/systemPrompt');
const { TOOL_SCHEMAS } = require('./src/brain/actions');

async function test() {
  const prompt = getSystemPrompt();
  
  const mockState = {
    current_goal: "Smelt iron_ore into iron_ingot using the furnace. Provide coal or wood as fuel.",
    target_item: "iron_ingot",
    bot_status: "OK",
    recent_actions: [],
    position: { x: 0, y: 0, z: 0 },
    health: 20,
    food: 20,
    equipped_item: "wooden_pickaxe",
    inventory: [
      "raw_iron x8",
      "coal x5",
      "cobblestone x12",
      "furnace x1"
    ],
    nearby_entities: [],
    nearby_blocks: ["dirt"],
    time_of_day: "day",
    recent_chat: []
  };

  const userMessage = JSON.stringify(mockState, null, 2);
  
  console.log('Sending state to Ollama...');
  const result = await askLLM(prompt, userMessage, TOOL_SCHEMAS);
  console.log('\n--- OLLAMA RESPONSE ---');
  console.log(JSON.stringify(result, null, 2));
}

test().catch(console.error);
