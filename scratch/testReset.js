const mockBot = {
  achieved_goals: new Set(['get_wood', 'mine_stone'])
};

console.log("Before reset:", Array.from(mockBot.achieved_goals));

// Mimic the case 'reset' logic
if (mockBot.achieved_goals) {
  mockBot.achieved_goals.clear();
}

console.log("After reset (should be empty):", Array.from(mockBot.achieved_goals));
