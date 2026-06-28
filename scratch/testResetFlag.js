const fs = require('fs');
const path = require('path');
const { syncGoal } = require('../src/brain/advancementPlanner');

// Create mock bot
const mockBot = {
  inventory: {
    items: () => []
  },
  achieved_goals: new Set(['get_wood', 'mine_stone'])
};

// Create flag file
const flagPath = path.join(__dirname, '../reset_memory.flag');
fs.writeFileSync(flagPath, 'RESET');

console.log("Is flag file present before syncGoal?", fs.existsSync(flagPath));
console.log("Memory before syncGoal:", Array.from(mockBot.achieved_goals));

// Call syncGoal
syncGoal(mockBot);

console.log("Is flag file present after syncGoal?", fs.existsSync(flagPath));
console.log("Memory after syncGoal (should be empty):", Array.from(mockBot.achieved_goals));
