/**
 * READ-ONLY autonomy snapshot — what her idle loop is actually doing right now.
 * Safe to run while the app is live (WAL concurrent read). Shows the active focus,
 * recent blackboard activity by kind, her web/search readings, open capability
 * gaps, the reflection significance accumulator, and pending self-scheduled tasks.
 *
 * Run:  $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\observe_autonomy.js
 */
const D = require('../lib/db');
D.init();

function line(s) { console.log(s); }
const short = (s, n = 70) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// --- active focus ---
const fid = parseInt(D.getMeta('current_focus_id') || '0', 10);
const focus = fid ? D.getOpenThread(fid) : null;
line('=== FOCUS ===');
line(focus ? `  #${focus.id} [${focus.status}] ${focus.content}` : '  (none active)');
let fstate = null; try { fstate = JSON.parse(D.getMeta('focus_state') || 'null'); } catch {}
if (fstate) line(`  state: tick ${fstate.ticks}, strikes ${fstate.strikes}`);

// --- blackboard activity by source/kind (last 60) ---
line('\n=== BLACKBOARD (last 60 events, by source/kind) ===');
const ev = D.getRecentAgentEvents(60);
const counts = {};
for (const e of ev) { const k = `${e.source}/${e.kind}`; counts[k] = (counts[k] || 0) + 1; }
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) line(`  ${String(n).padStart(3)}  ${k}`);

// --- recent web/search readings (her autonomy on the net) ---
line('\n=== RECENT READINGS (web/search/file, last 10) ===');
const readings = D.getRecentMonologueByType('reading', 10);
for (const r of readings) line(`  [${r.model || '?'}] ${short(r.query || r.content, 64)}`);

// --- recent thoughts (subconscious stream, last 6) ---
line('\n=== RECENT THOUGHTS (last 6, importance) ===');
for (const t of D.getRecentMonologueByType('thought', 6)) line(`  imp=${t.importance == null ? '-' : t.importance}  ${short(t.content, 64)}`);

// --- capability gaps ---
line('\n=== OPEN CAPABILITY GAPS ===');
const gaps = D.getOpenCapabilityGaps(10);
if (!gaps.length) line('  (none)');
for (const g of gaps) line(`  • ${short(g.description, 60)}${g.proposed_solution ? '  → ' + short(g.proposed_solution, 40) : ''}`);

// --- reflection accumulator + pending schedules ---
line('\n=== SIGNALS ===');
line(`  reflection_importance_accum: ${D.getMeta('reflection_importance_accum') || '0'} / 150`);
line(`  rumination_cooldown: ${(() => { const u = parseInt(D.getMeta('rumination_cooldown_until') || '0', 10); const m = Math.round((u - Date.now()) / 60000); return u > Date.now() ? `${m}m left` : 'off'; })()}`);
const sched = D.getPendingScheduledTasks(5);
line(`  pending self-scheduled tasks: ${sched.length}`);
for (const s of sched) line(`    - "${short(s.note, 50)}" (fires ${new Date(s.fire_at).toLocaleString()})`);
line(`  active threads: ${D.getActiveOpenThreads(50).length} | knowledge items: ${D.countKnowledge()}`);

D.getDb().close();
