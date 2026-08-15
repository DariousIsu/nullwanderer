/* scripts/read_internal_state.js — the Slice-0 hand-verification readout: renders the dark
 * instrument's journal as a table (drives + VAD per tick) so the 48h honesty check ("quiet
 * evening → social rises; heavy research → curiosity falls") is a read, not an excavation.
 * Read-only. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/read_internal_state.js
 */
'use strict';
const Database = require(require('path').join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const d = new Database(require('path').join(__dirname, '..', 'data', 'sq.db'), { readonly: true });
const get = (k) => { const r = d.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r && r.value; };
const cur = JSON.parse(get('internal_state') || 'null');
const j = JSON.parse(get('internal_state.journal') || '[]');
console.log(`internal_state journal: ${j.length} tick(s)\n`);
console.log('time (ET)         curi  soc   engy  prog  |  val   aro   dom');
for (const e of j.slice(-48)) {
  const t = new Date(e.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const f = (x) => (x == null ? '  — ' : x.toFixed(2));
  console.log(`${t}   ${f(e.d.curiosity)}  ${f(e.d.social)}  ${f(e.d.energy)}  ${f(e.d.progress)}  |  ${f(e.vad.v)}  ${f(e.vad.a)}  ${f(e.vad.d)}`);
}
if (cur) { console.log('\ncurrent provenance:'); for (const [k, v] of Object.entries(cur.prov || {})) console.log(`  ${k}: ${v}`); }
d.close();
