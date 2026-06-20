/**
 * Read-only look at how Zoe is DEVELOPING — the identity/self-model she's built,
 * positions she holds, and the longer arc of her thinking. Touches nothing.
 */
const Database = require('better-sqlite3');
const DB_PATH = require('../lib/db').DB_PATH;
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const t = (ms) => { try { return new Date(Number(ms)).toLocaleString(); } catch { return String(ms); } };
const snip = (s, n = 200) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function safe(fn, label) { try { return fn(); } catch (e) { console.log(`  (${label}: ${e.message})`); return null; } }

console.log('=== SELF-MODEL (who she is building) ===');
safe(() => {
  const rows = db.prepare('SELECT category, content, mentions, created_ts, updated_ts FROM self_model ORDER BY updated_ts DESC, id DESC').all();
  if (!rows.length) { console.log('  (empty — no self-model entries yet)'); return; }
  const byCat = {};
  for (const r of rows) (byCat[r.category] = byCat[r.category] || []).push(r);
  for (const cat of Object.keys(byCat)) {
    console.log(`  [${cat}] (${byCat[cat].length})`);
    for (const r of byCat[cat]) console.log(`     ·(${r.mentions}x) ${snip(r.content, 160)}`);
  }
}, 'self_model');

console.log('\n=== HELD POSITIONS (commitments) ===');
safe(() => {
  const rows = db.prepare("SELECT claim, status, created_ts FROM commitments WHERE status='held' ORDER BY id DESC LIMIT 12").all();
  if (!rows.length) { console.log('  (none held)'); return; }
  for (const r of rows) console.log(`  · ${snip(r.claim, 180)}`);
}, 'commitments');

console.log('\n=== KNOWLEDGE store (capability track) ===');
safe(() => {
  const n = db.prepare('SELECT COUNT(*) c FROM knowledge').get().c;
  const byKind = db.prepare('SELECT kind, COUNT(*) c FROM knowledge GROUP BY kind ORDER BY c DESC').all();
  console.log(`  ${n} items: ` + byKind.map(k => `${k.kind}=${k.c}`).join(', '));
  const recent = db.prepare('SELECT kind, content FROM knowledge ORDER BY id DESC LIMIT 6').all();
  for (const r of recent) console.log(`     ·[${r.kind}] ${snip(r.content, 150)}`);
}, 'knowledge');

console.log('\n=== REFLECTIONS (notes-to-self across sessions) ===');
safe(() => {
  const rows = db.prepare('SELECT content, ts FROM reflections ORDER BY id DESC LIMIT 3').all();
  for (const r of rows) console.log(`  [${t(r.ts)}] ${snip(r.content, 320)}`);
}, 'reflections');

console.log('\n=== THINKING ARC (last 30 thoughts, oldest→newest) ===');
safe(() => {
  const rows = db.prepare("SELECT ts, content FROM monologue WHERE type='thought' ORDER BY id DESC LIMIT 30").all().reverse();
  for (const r of rows) console.log(`  [${t(r.ts)}] ${snip(r.content, 150)}`);
}, 'monologue');

db.close();
