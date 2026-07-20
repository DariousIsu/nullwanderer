/* scripts/backfill_meeting_encounters.js — replay past meetings into the encounter log (W4).
 *
 * 32 meetings, 4,178 transcript lines. Attendance is recoverable in full: the meeting code, the
 * speaker badge Meet supplied, and the exact timestamp are all still on every line.
 *
 * ONLY ATTENDANCE. What anyone SAID is not replayed as evidence — that reaches the graph through the
 * meeting document, where it is marked `stated`. A meeting proves someone was there; it proves nothing
 * about the truth of what they told the room.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_meeting_encounters.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const me = require('../lib/meeting_encounters');
const enc = require('../lib/encounters');
const og = require('../lib/origin');

db.init();
const APPLY = process.argv.includes('--apply');
const d = db.getDb();

console.log(`\nMEETING ATTENDANCE → ENCOUNTER LOG — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(74)}`);

const lines = d.prepare('SELECT id, meeting, speaker, text, ts FROM meeting_transcript ORDER BY ts ASC').all();
const stats = me.attendanceStats(lines);
const build = me.attendanceEncounters(lines);

console.log(`transcript lines      ${stats.lines}`);
console.log(`  with a speaker      ${stats.named}`);
console.log(`  WITHOUT a speaker   ${stats.unnamed}  (${((stats.unnamed / Math.max(1, stats.lines)) * 100).toFixed(0)}% — media captions; no attendance claim, never guessed)`);
console.log(`meetings              ${stats.meetings}`);
console.log(`distinct people       ${stats.people}`);
console.log(`encounters to write   ${build.length}  (existence + participated_in per person per meeting)`);

// How often does the same person appear across SEPARATE meetings? That is the corroboration this lane
// produces — and the reason a meeting has to be its own origin key.
const byPerson = new Map();
for (const e of build) {
  if (e.claim_class !== 'existence') continue;
  const k = e.object_label;
  if (!byPerson.has(k)) byPerson.set(k, []);
  byPerson.get(k).push(e);
}
const multi = [...byPerson.entries()].map(([k, v]) => [k, og.independence(v).count]).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
console.log(`\npeople seen in more than one meeting: ${multi.length}`);
for (const [k, n] of multi.slice(0, 6)) console.log(`  ${String(n).padStart(2)} meetings  ${k}`);

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

const res = enc.recordMany(build);
console.log(`\n${'='.repeat(74)}`);
console.log(`APPLIED — ${res.added} written, ${res.alreadyKnown} already known (idempotent).`);
const s = enc.stats();
console.log(`log now holds ${s.encounters} encounter(s) across ${s.objects} object(s).`);
process.exit(0);
