/**
 * Clear a stuck play/personal session to a clean, responsive state. Run with the
 * app DOWN (exclusive write). Leaves identity/memory untouched — only the play-mode
 * meta flags.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\reset_play_state.js
 */
const Database = require('better-sqlite3');
const DB_PATH = require('../lib/db').DB_PATH;
const db = new Database(DB_PATH);
const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
const clean = {
  personal_mode: 'off',
  personal_mode_until: '0',
  play_step: 'none',
  play_character: '',
  play_inventory: '[]',
  play_step_strikes: '0',
  play_last_reply: ''
};
for (const [k, v] of Object.entries(clean)) set.run(k, v);
console.log('reset play/personal meta → clean responsive state:');
for (const k of Object.keys(clean)) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(k);
  console.log(`  ${k} = ${row ? JSON.stringify(row.value) : '(unset)'}`);
}
db.close();
