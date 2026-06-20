/**
 * LIVE test — actually launch Zoe's dedicated browser, open a page, read it,
 * confirm handles come back, then close. Needs Playwright + network. Pops a
 * visible window briefly.
 */
const web = require('../lib/web');
async function run() {
  console.log('launching dedicated browser…');
  const o = await web.open('example.com');
  console.log('open:', JSON.stringify(o).slice(0, 160));
  if (!o.ok) { await web.close(); process.exit(1); }
  const r = await web.read();
  console.log('read ok:', r.ok, '| title:', r.title);
  console.log('text+handles (first 400 chars):\n' + (r.text || '').slice(0, 400));
  const search = await web.open('Maastricht treaty convergence criteria');
  console.log('\nsearch open:', search.ok, '| url:', (search.url || '').slice(0, 60));
  const r2 = await web.read();
  const handleCount = (r2.text || '').match(/\[[LBI]\d+\]/g)?.length || 0;
  console.log('search page read ok:', r2.ok, '| handles found:', handleCount);
  await web.close();
  console.log('\nclosed.', (o.ok && r.ok && search.ok && r2.ok && handleCount > 0) ? 'LIVE OK' : 'LIVE INCOMPLETE');
  process.exit((o.ok && r.ok && search.ok && r2.ok) ? 0 : 1);
}
run();
