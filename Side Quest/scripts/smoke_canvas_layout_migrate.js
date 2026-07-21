/* smoke_canvas_layout_migrate.js — a document can be resized or hidden before it is ever placed.
 *
 * Live 2026-07-21, firing repeatedly:
 *
 *   [canvas] update-doc failed: NOT NULL constraint failed: doc_positions.x
 *
 * The first version of doc_positions was x,y-only and declared BOTH NOT NULL. migrate() only ever
 * ADDED columns (w, h, hidden, minimized), so every live database kept that constraint while the
 * SCHEMA constant in this module has long declared x and y nullable — the file and the disk
 * disagreed, and the disk won.
 *
 * update() legitimately writes x=NULL: a document that has never been dragged has no position, so
 * hiding, minimising or resizing it patches only those fields. Every one of those died.
 *
 * SQLite cannot drop a NOT NULL in place, so the fix rebuilds the table and copies the rows. The
 * load-bearing tests are the ones proving the REBUILD DOES NOT LOSE SAVED POSITIONS — a migration
 * that silently drops where Lucas arranged his board would be worse than the bug.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const tmp = path.join(os.tmpdir(), `zoe-layout-${Date.now()}.db`);

// Build the OLD table exactly as it exists on disk today, with rows in it.
{
  const d = new Database(tmp);
  d.exec(`CREATE TABLE doc_positions (
    doc_key    TEXT PRIMARY KEY,
    x          INTEGER NOT NULL,
    y          INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , w INTEGER, h INTEGER, hidden INTEGER NOT NULL DEFAULT 0, minimized INTEGER NOT NULL DEFAULT 0)`);
  const ins = d.prepare('INSERT INTO doc_positions (doc_key,x,y,updated_at,w,h,hidden,minimized) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('directed-3387', 35, 71, 1, 240, 120, 1, 0);
  ins.run('drop-somefile', 900, 400, 2, 640, 480, 0, 1);
  d.close();
}

const cl = require('../lib/canvas_layout');
cl.init({ path: tmp });

// ── the constraint is gone ──────────────────────────────────────────────────────────────────────
{
  const d = new Database(tmp, { readonly: true });
  const x = d.prepare('PRAGMA table_info(doc_positions)').all().find((c) => c.name === 'x');
  ok(x && !x.notnull, 'x is nullable after migration');
  const y = d.prepare('PRAGMA table_info(doc_positions)').all().find((c) => c.name === 'y');
  ok(y && !y.notnull, 'and so is y');
  d.close();
}

// ── SAFETY: no saved arrangement is lost ────────────────────────────────────────────────────────
{
  const a = cl.get('directed-3387');
  ok(a && a.x === 35 && a.y === 71, 'an existing position survives the table rebuild EXACTLY');
  ok(a.w === 240 && a.h === 120 && a.hidden === true, 'with its size and hidden flag');
  const b = cl.get('drop-somefile');
  ok(b && b.x === 900 && b.y === 400 && b.minimized === true, 'and so does every other row');
  const d = new Database(tmp, { readonly: true });
  ok(d.prepare('SELECT COUNT(*) n FROM doc_positions').get().n === 2, 'the row COUNT is unchanged — nothing dropped');
  ok(!d.prepare("SELECT name FROM sqlite_master WHERE name='doc_positions_new'").get(),
    'the scratch table is cleaned up, not left behind');
  d.close();
}

// ── the call that was dying now works ───────────────────────────────────────────────────────────
{
  const st = cl.update('never-placed-doc', { hidden: true });
  ok(st && st.hidden === true, 'a doc with NO position can be hidden — this is the exact patch that failed');
  ok(st.x === null && st.y === null, 'and it stores a null position rather than inventing coordinates');
  ok(cl.update('never-placed-doc', { w: 800, h: 600 }).w === 800, 'it can be resized before being placed too');
  // …and placing it later still works
  ok(cl.setPosition('never-placed-doc', 12, 34).x === 12, 'placing it afterwards behaves normally');
}

// ── idempotent: running init twice must not re-migrate or damage anything ───────────────────────
{
  cl.close();
  cl.init({ path: tmp });
  ok(cl.get('directed-3387').x === 35, 'a second init leaves the migrated table alone');
  const d = new Database(tmp, { readonly: true });
  ok(d.prepare('SELECT COUNT(*) n FROM doc_positions').get().n === 3, 'and loses nothing');
  d.close();
}

cl.close();
try { fs.unlinkSync(tmp); } catch {}
for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
