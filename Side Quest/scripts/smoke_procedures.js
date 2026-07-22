/* Smoke: lib/procedures — procedural memory (conductor slice 2c). Deterministic: temp SQ_DB_PATH,
 * injected ask. No model/network.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_procedures.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMPDIR = path.join(os.tmpdir(), `sq_proc_${process.pid}`);
process.env.SQ_DB_PATH = path.join(TMPDIR, 'sq.db');
const db = require('../lib/db'); db.init();
const P = require('../lib/procedures');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const NOW = 1753300000000;

(async () => {
  // --- match: empty store, overlap thresholds ---
  ok(P.match({ move: 'research', target: 'anything' }).procedure === null, 'empty store → no procedure summoned');
  db.getDb().prepare(`INSERT INTO procedures (kind, name, trigger_text, steps, check_text, applicability, met, unmet, created_ts)
    VALUES ('procedure', 'Corroborate a single-source cluster', 'corroborate single-source claims independent second source', '1. …\n2. …', 'a second independent origin cites the claim', 'public orgs with a web presence', 4, 1, ?)`).run(NOW);
  db.getDb().prepare(`INSERT INTO procedures (kind, name, trigger_text, applicability, unmet, created_ts)
    VALUES ('constraint', 'corroborate: Acme PAC roster', 'corroborate acme pac roster claims', 'their site lists no board — only the newsletter names members', 2, ?)`).run(NOW);

  const m = P.match({ move: 'corroborate', target: 'the Acme PAC single-source cluster' });
  ok(!!m.procedure && /single-source/i.test(m.procedure.name), 'a matching PROCEDURE surfaces on token overlap');
  ok(m.constraints.length === 1 && /newsletter/.test(m.constraints[0].applicability), 'matching CONSTRAINTS surface alongside');
  ok(P.match({ move: 'research', target: 'neuromorphic hardware' }).procedure === null, 'one-token graze does NOT summon a procedure');

  // --- briefBlock ---
  const bb = P.briefBlock(m);
  ok(/PROVEN PROCEDURE/.test(bb) && /met its expectation 4\/5/.test(bb), 'brief carries the procedure WITH its honest track record');
  ok(/LEARNED CONSTRAINTS/.test(bb) && /confirmed 2×/.test(bb), 'brief carries constraints with their confirmation count');
  ok(P.briefBlock({ procedure: null, constraints: [] }) === '', 'no match → empty block (silence beats filler)');

  // --- recordUse + mechanical retirement ---
  const pid = m.procedure.id;
  P.recordUse(pid, { met: true, nowMs: NOW + 1000 });
  ok(db.getDb().prepare('SELECT met FROM procedures WHERE id = ?').get(pid).met === 5, 'a met use increments the record');
  db.getDb().prepare(`INSERT INTO procedures (kind, name, trigger_text, met, unmet, created_ts) VALUES ('procedure', 'Bad recipe', 'flaky approach tokens here', 0, 2, ?)`).run(NOW);
  const bad = db.getDb().prepare("SELECT id FROM procedures WHERE name = 'Bad recipe'").get().id;
  P.recordUse(bad, { met: false, nowMs: NOW + 2000 });
  ok(db.getDb().prepare('SELECT status FROM procedures WHERE id = ?').get(bad).status === 'retired', 'repeatedly failing guidance retires itself (unmet ≥ 3, > met)');

  // --- crystallize: unmet → deterministic constraint, NO cloud call ---
  let askCalls = 0;
  const decision = { move: 'fill-gap', target: 'Rainey Center board members', why: 'named gap', expect: 'the board list with a citable source' };
  const failRun = { answer: 'Could not find a board page.', steps: [{ tool: 'web_search', args: { query: 'x' }, result: 'nothing relevant' }] };
  const c1 = await P.crystallize({ decision, opRes: failRun, verdict: { met: false, why: 'no list found, only an about page' }, deps: { ask: async () => { askCalls++; return null; } }, nowMs: NOW });
  ok(c1 && c1.constraint && askCalls === 0, 'an unmet run writes a constraint DETERMINISTICALLY (no cloud call)');
  const c2 = await P.crystallize({ decision, opRes: failRun, verdict: { met: false, why: 'still no list' }, deps: { ask: async () => { askCalls++; return null; } }, nowMs: NOW + 5000 });
  ok(c2 && c2.confirmed === true, 'a repeat failure CONFIRMS the existing constraint, never mints a twin');
  ok(db.getDb().prepare("SELECT COUNT(*) n FROM procedures WHERE kind = 'constraint' AND name LIKE 'fill-gap:%'").get().n === 1, 'one constraint row holds both episodes');
  ok(db.getDb().prepare("SELECT unmet FROM procedures WHERE kind = 'constraint' AND name LIKE 'fill-gap:%'").get().unmet === 2, 'its unmet count carries the confirmations');

  // --- crystallize: met → cloud drafts; created / folded / skip ---
  const draft = { name: 'Map a countable civic universe', trigger: 'fill-gap countable universe members official roster', steps: ['open the official roster page', 'extract members with source urls', 'compare against our count'], check: 'member count matches the known denominator', applies: 'US public bodies with published rosters' };
  const okRun = { answer: 'Found all 64 parishes with sources.', steps: [{ tool: 'web_search', args: { query: 'roster' }, result: 'ok' }] };
  const g1 = await P.crystallize({ decision: { move: 'fill-gap', target: 'Louisiana parish list', why: 'x', expect: 'all 64' }, opRes: okRun, verdict: { met: true }, deps: { ask: async () => draft }, nowMs: NOW });
  ok(g1 && g1.created && g1.created.name === draft.name, 'a met run BIRTHS a procedure from the cloud draft');
  const row = db.getDb().prepare('SELECT * FROM procedures WHERE id = ?').get(g1.created.id);
  ok(/^1\. open the official roster/.test(row.steps) && row.met === 1 && row.kind === 'procedure', 'the row carries numbered steps + its first met');
  const g2 = await P.crystallize({ decision: { move: 'fill-gap', target: 'Mississippi county list', why: 'x', expect: 'all 82' }, opRes: okRun, verdict: { met: true }, deps: { ask: async () => draft }, nowMs: NOW + 9000 });
  ok(g2 && g2.folded && g2.folded.id === g1.created.id, 'a strongly-overlapping draft FOLDS into the existing procedure');
  ok(db.getDb().prepare('SELECT met FROM procedures WHERE id = ?').get(g1.created.id).met === 2, 'folding reinforces the record instead of duplicating');
  const g3 = await P.crystallize({ decision: { move: 'research', target: 'one-off', why: 'x', expect: 'y' }, opRes: okRun, verdict: { met: true }, deps: { ask: async () => ({ skip: true }) }, nowMs: NOW });
  ok(g3 && /target-specific/.test(g3.skipped), 'the draft may honestly decline ("too specific to reuse")');
  const g4 = await P.crystallize({ decision: { move: 'research', target: 'z', why: 'x', expect: 'y' }, opRes: okRun, verdict: { met: true }, deps: { ask: async () => null }, nowMs: NOW });
  ok(g4 && g4.skipped === 'cloud unavailable', 'cloud down → skipped honestly, never a fake row');
  ok(await P.crystallize({ decision, opRes: okRun, verdict: null }) === null, 'no verdict → nothing (unverified runs never crystallize)');

  // --- draft validation ---
  ok(P._validateDraft('{"skip": true}').value.skip === true, 'validator accepts an honest skip');
  ok(P._validateDraft('{"name":"x"}').valid === false, 'validator rejects a draft missing steps/check');
  ok(P._validateDraft('prose {"name":"N","trigger":"t t","steps":["s"],"check":"c"} trailing').valid === true, 'validator tolerates surrounding prose');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
