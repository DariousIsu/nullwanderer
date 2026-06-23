const echo = require('../lib/echo');
const { createSuit } = require('../lib/echo_suit');
(async () => {
  const client = echo.fromEnv({ url: 'http://127.0.0.1:8765/mcp/', token: 'nx-echo-dev-admin' });
  const suit = createSuit({ client });
  const r = await suit.connect();
  console.log('connect:', JSON.stringify(r));
  const block = suit.suitContextBlock() || '';
  console.log('block length:', block.length);
  console.log('names <echo-recipe>:', /<echo-recipe/.test(block));
  console.log('menu has search-vault:', /search-vault/.test(block));
  console.log('menu has entity-dossier:', /entity-dossier/.test(block));
  console.log('recipe menu lines:', (block.match(/^• /gm) || []).length);
  try { await suit.close(); } catch {}
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
