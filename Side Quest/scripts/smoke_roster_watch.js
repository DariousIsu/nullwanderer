'use strict';
/* smoke_roster_watch.js — the election-night watch (lib/roster_watch.js). Hermetic temp sq.db.
 * Run: node scripts/smoke_roster_watch.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
process.env.ZOE_ROSTER_WATCH = '1';
const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const rw = require(path.join(__dirname, '..', 'lib', 'roster_watch'));
const civic = require(path.join(__dirname, '..', 'lib', 'civic_store'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── the matcher: seat-change events, not political noise ────────────────────────────────────────
ok('death fires', rw.titleSignals('News — Sen. Marlow Hutchins dies at 82, leaving Senate seat open'));
ok('resignation fires', rw.titleSignals('Rep. Ada Quill resigns amid ethics probe'));
ok('special election fires', rw.titleSignals("Special election set for Louisiana's 4th congressional district"));
ok('seat win fires', rw.titleSignals('Delia Fontenot wins the runoff for the statehouse seat'));
ok('appointment fires', rw.titleSignals('Governor names aide appointed to the Senate seat'));
ok('political noise does not fire', !rw.titleSignals('Senator blasts budget deal in fiery floor speech'));
ok('campaign coverage does not fire', !rw.titleSignals('Representative launches re-election campaign in Ohio'));
ok('non-office death does not fire', !rw.titleSignals('Beloved zoo elephant dies at 47'));

// ── scanNews over seeded docs (news source + fresh only) ────────────────────────────────────────
const now = Date.now();
db.insertDocument({ title: 'News — Sen. Marlow Hutchins dies at 82, leaving Senate seat open', body: 'x', source: 'news' });
db.insertDocument({ title: 'News — Senator blasts budget deal', body: 'x', source: 'news' });
db.insertDocument({ title: 'Rep. Ada Quill resigns amid ethics probe', body: 'not news source', source: 'inquiry' });
const hits = rw.scanNews({ db, now });
ok('one hit from the seeded news', hits.length === 1 && /Hutchins/.test(hits[0].title));
ok('non-news sources are not scanned', !hits.some((h) => /Quill/.test(h.title)));

// ── holder cross-ref: a tracked officeholder in the headline names the seat ─────────────────────
const ub = civic.upsertBody({ title: 'Senior United States Senator from Testonia', level: 'other', function: 'governing' });
civic.recordSeatHolder({ bodyKey: ub.bodyKey, personName: 'Marlow Hutchins', role: 'Senior United States Senator', sourceKind: 'official', sourceUrl: 'x' });
const matched = rw.matchHolders({ db, hits });
ok('tracked holder matched to his seat', matched[0].person === 'Marlow Hutchins' && /Testonia/.test(matched[0].seat));

// ── maybeTrigger: forces the refresh due, throttles, surfaces, kill-switches ────────────────────
db.setMeta('roster_refresh.last_ts', String(now));      // organ recently ran → not due
const t1 = rw.maybeTrigger({ db, now });
ok('a hit forces the refresh due', t1.forced === true && db.getMeta('roster_refresh.last_ts') === '0');
ok('the force is stamped', !!db.getMeta(rw.META_FORCED));
db.setMeta('roster_refresh.last_ts', String(now));
const t2 = rw.maybeTrigger({ db, now: now + 60000 });
ok('a second hit inside the gap does NOT re-force', t2.forced === false && db.getMeta('roster_refresh.last_ts') !== '0');
const t3 = rw.maybeTrigger({ db, now: now + rw.FORCE_GAP_MS + 60000 });
ok('past the gap it forces again', t3.forced === true);
const inbound = db.getDb().prepare("SELECT COUNT(*) n FROM inbound_messages WHERE source = 'roster-watch'").get().n;
ok('signals surface via the inbound door', inbound >= 1);
process.env.ZOE_ROSTER_WATCH = '0';
ok('kill switch skips', rw.maybeTrigger({ db, now }).skipped === 'kill-switch');
process.env.ZOE_ROSTER_WATCH = '1';

console.log(`smoke_roster_watch: ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
