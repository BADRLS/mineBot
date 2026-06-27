/**
 * Attempts to find and equip the best available weapon (sword or axe) from the bot's inventory.
 * Sorts by material tier.
 * @param {object} bot - The Mineflayer bot instance
 * @returns {Promise<boolean>} True if a weapon was equipped, false otherwise.
 */
async function equipBestWeapon(bot) {
  const weapons = bot.inventory.items().filter(i => i.name.includes('sword') || i.name.includes('axe'));
  if (weapons.length > 0) {
    // Simple best-weapon logic: netherite > diamond > iron > stone > wooden
    const tierNames = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
    weapons.sort((a, b) => {
       const tierA = tierNames.findIndex(t => a.name.includes(t));
       const tierB = tierNames.findIndex(t => b.name.includes(t));
       return tierB - tierA; // higher tier first
    });
    
    // Equip the best valid weapon if not already holding it
    if (!bot.heldItem || bot.heldItem.name !== weapons[0].name) {
       try {
         await bot.equip(weapons[0], 'hand');
         return true;
       } catch (err) {
         return false;
       }
    }
    return true; // Already holding the best weapon
  }
  return false;
}

module.exports = {
  equipBestWeapon,
};
