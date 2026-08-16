/* Smoke: lib/doc_set — CANVAS-SET ANALYSIS reach (Lucas 2026-07-30: "I don't need the report, I
 * need the program to be able to generate it"). Pins the 07-28 failure shape: nine rosters held
 * durably, an analytical ask, and the run reaching for canvas tabs / re-asking Lucas for files.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_doc_set.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';
const db = require('../lib/db');
db.init();
const ds = require('../lib/doc_set');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- the detector: analytical verb + set noun, both or neither ---
ok(ds.detectSetAnalysisAsk('can I get a quick frequency report on the documents I dropped on the canvas'), 'his actual ask shape detects');
ok(ds.detectSetAnalysisAsk('how many times does each person appear across these files'), 'appear-across phrasing detects');
ok(ds.detectSetAnalysisAsk('compare the rosters and tell me the overlap'), 'compare/overlap phrasing detects');
ok(ds.detectSetAnalysisAsk('tally attendance across the nine lists'), 'tally phrasing detects');
ok(!ds.detectSetAnalysisAsk('how many senators does Ohio have'), 'a plain lookup (no set noun) stays a lookup');
ok(!ds.detectSetAnalysisAsk('read the document I just dropped'), 'a single-doc read (no analytic verb) stays doc-QA');
ok(!ds.detectSetAnalysisAsk('') && !ds.detectSetAnalysisAsk(null), 'empty/null never throws');

// --- canvas as OUTPUT DESTINATION is not a document-SET to analyze (T11 residual, 2026-08-16) ---
ok(!ds.detectSetAnalysisAsk('compare the two florida senate candidates FEC numbers and drop a comparison table on the canvas'),
  'THE T11 residual: external "compare … and drop a table on the canvas" (output tail) → NOT a set-analysis ask');
ok(ds.detectSetAnalysisAsk('compare the documents on the canvas and tell me the overlap'),
  'canvas as the SUBJECT of the analysis ("compare the documents on the canvas") → STILL detects (no output verb at a boundary)');

// --- the set: canvas drops only, recency-bounded, newest first ---
const land = (title, body, source, ts) => {
  const r = db.insertDocument({ title, body, source });
  if (ts) db.getDb().prepare('UPDATE documents SET created_ts = ? WHERE id = ?').run(ts, r.id);
  return r.id;
};
const NOW = Date.now();
const d1 = land('LAMP 2025 Guest List (Master)', 'x'.repeat(500), 'canvas_drop');
const d2 = land('RSVPify - Full Invite list', 'y'.repeat(300), 'canvas_drop');
land('a research dossier', 'z'.repeat(400), 'research');
const old = land('ancient drop', 'w'.repeat(200), 'canvas_drop', NOW - 30 * 864e5);
{
  const set = ds.dropSet(db, { now: NOW });
  const ids = set.map((s) => s.id);
  ok(ids.includes(d1) && ids.includes(d2), 'canvas drops are in the set');
  ok(!ids.some((i) => i === old), 'a 30-day-old drop is outside the recency window');
  ok(!set.some((s) => /research dossier/.test(s.title)), 'non-drop sources stay out');
  ok(ids[0] === d2 || ids[0] > ids[1], 'newest first');
}

// --- the manifest: ids reachable, compute API taught, never-re-ask discipline ---
{
  const block = ds.buildBlock(ds.dropSet(db, { now: NOW }));
  ok(new RegExp(`doc ${d1} `).test(block) && new RegExp(`IN \\(.*${d1}.*\\)`).test(block), 'the manifest carries exact ids into the SQL example');
  ok(/analyze_data/.test(block) && /zoe_data\.query\('sq'/.test(block), 'the compute route is taught by name (analyze_data + zoe_data.query)');
  ok(/SCRIPT job, never a from-memory estimate/.test(block), 'counting is named a script job');
  ok(/Do NOT ask Lucas to re-share/.test(block), 'the never-re-ask discipline rides (she asked him for files she already held)');
  ok(/FILTER artifacts/.test(block) && /STATE the counting method/.test(block) && /SAVED IN FULL/.test(block),
    'first-live-run lessons ride: artifact filtering, stated method, save-the-full-table (chat clipped her table)');
  ok(ds.buildBlock([]) === '' && ds.buildBlock(null) === '', 'an empty set builds nothing');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
