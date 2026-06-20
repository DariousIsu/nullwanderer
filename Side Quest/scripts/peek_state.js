/**
 * Read-only peek at Zoe's live state — what she's actually doing right now.
 * Opens the REAL db (not a temp) read-only so it never locks/writes the running app.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\peek_state.js
 */
const Database = require('better-sqlite3');
const DB_PATH = require('../lib/db').DB_PATH;
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const t = (ms) => { try { return new Date(Number(ms)).toLocaleString(); } catch { return String(ms); } };
const ago = (ms) => { const s = Math.floor((Date.now() - Number(ms)) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s/60) + 'm ago'; return Math.floor(s/3600) + 'h ago'; };
const snip = (s, n = 220) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

console.log('=== META (mode / play session) ===');
const keys = ['personal_mode','personal_mode_until','play_step','play_character','play_inventory','last_search_at','last_ai_utterance_at','rumination_cooldown_until','chosen_name'];
for (const k of keys) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(k);
  let v = row ? row.value : '(unset)';
  if (k === 'play_inventory' && v && v !== '(unset)') { try { v = JSON.parse(v).map(o => o.label).join(' | ') || '[]'; } catch {} }
  if (/_at$|_until$/.test(k) && row && /^\d+$/.test(v)) v = `${t(v)} (${ago(v)})`;
  console.log(`  ${k}: ${v}`);
}

console.log('\n=== RECENT MONOLOGUE (newest first) ===');
const mono = db.prepare('SELECT ts, type, model, content, query FROM monologue ORDER BY id DESC LIMIT 16').all();
for (const m of mono) {
  const tag = m.type === 'reading' ? `READ/${m.model}` : 'thought';
  console.log(`  [${t(m.ts)}] (${tag}${m.query ? ' q=' + snip(m.query, 40) : ''})`);
  console.log(`     ${snip(m.content, 240)}`);
}

console.log('\n=== RECENT TURNS (newest first) ===');
const turns = db.prepare("SELECT ts, speaker, content, model FROM turns ORDER BY id DESC LIMIT 8").all();
for (const tr of turns) {
  console.log(`  [${t(tr.ts)}] ${tr.speaker}${tr.model ? ' (' + tr.model + ')' : ''}: ${snip(tr.content, 200)}`);
}

try {
  const focus = db.prepare("SELECT * FROM open_threads WHERE status='active' ORDER BY id DESC LIMIT 3").all();
  if (focus.length) { console.log('\n=== ACTIVE THREADS/FOCUS ==='); for (const f of focus) console.log(`  #${f.id} ${snip(f.content, 120)}`); }
} catch {}

db.close();
