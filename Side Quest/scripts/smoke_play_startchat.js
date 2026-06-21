/** Play-stepper fixes: filter/tab chips ("Discover") are not treated as characters, and
 *  findStartChatHandle locates the "Start Chat" control on the profile page. */
const ps = require('../lib/play_session');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

// Simulated web.read() of a CrushOn listing: filter tabs + real character cards.
const listing = `
Interactive elements:
  [C0] card: Discover
  [C1] card: Popular
  [C2] card: NSFW
  [L0] link: Mizuki, the fired mini-boss
  [C3] card: Captain Vale, rogue archivist
  [C4] card: Female
  [L1] link: Login
`;
const inv = ps.extractInventory(listing);
const labels = inv.map(o => o.label);
console.log('inventory →', JSON.stringify(labels));
ok('keeps the real characters', labels.includes('Mizuki, the fired mini-boss') && labels.includes('Captain Vale, rogue archivist'));
ok('drops the "Discover" tab', !labels.includes('Discover'));
ok('drops Popular/NSFW/Female filter chips', !labels.some(l => ['Popular', 'NSFW', 'Female'].includes(l)));
ok('drops Login nav chrome', !labels.includes('Login'));

// Simulated profile/intro page after picking a character.
const profile = `
You picked Captain Vale. Bio: rogue archivist...
Interactive elements:
  [B0] button: Add to favorites
  [B1] button: Start Chat
  [L0] link: Report
`;
ok('finds the Start Chat button', ps.findStartChatHandle(profile) === 'B1');
ok('returns null when no start-chat control', ps.findStartChatHandle('[B0] button: Add to favorites\n[L0] link: Report') === null);

console.log(`\n${fail === 0 ? 'PLAY STARTCHAT OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
