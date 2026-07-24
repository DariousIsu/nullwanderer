/**
 * lib/rehearsal_driver.js — O2 THE REHEARSAL DRIVER (catalog slice 5, 2026-07-23).
 *
 * R1 gave her hands (rehearsal.create/edit/test/diff on a full COPY of her source); this is the
 * ARM — the loop that makes them iterate. The load-bearing mechanic is retry-with-failure-context:
 * the failing output rides the next attempt RAW (the harness's own build loop; 44f8052 proved the
 * small version — an arg failure teaches the arg SHAPE). A mid model in a tight verify loop beats
 * a big model open-loop.
 *
 * Shape: a RUN is a journaled object {slug, goal, suite, iteration, lastResult, status} in meta —
 * it PARKS between ticks and resumes across reboots (the directed-focus iteration shape, #3542).
 * Never one blocking hours-long call. Each iteration: cloud picks ONE exact-match edit (seeing the
 * goal + the sandbox files' current content + the diff so far + the raw failing output) → edit →
 * test (the named suite; the FULL gate only at green-exit) → journal the verdict.
 *
 * Exits (all honest, none self-adopting — R3 is absolute):
 *   green  → the FULL gate in the sandbox passes → an R2 PROPOSAL CARD lands as a doc_store
 *            artifact (diff + gate verdict + rationale). The card is the ONLY thing that leaves
 *            the sandbox. Lucas + gate + commit remain the only path into the live program.
 *   parked → the iteration budget is spent. Resumable — a bound defers, never disappears.
 *   stuck  → the same suite failing with an UNCHANGED diff twice → stop + crystallize a
 *            constraint row (the lesson outlives the run).
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const RUN_KEY = 'rehearsal_driver.run';
const ITER_BUDGET = 6;          // per sitting; parked runs resume with a fresh budget
const FILE_CAP = 6000;          // chars of each watched file the edit-picker sees
const RESULT_CAP = 3000;        // chars of raw test output that ride the next attempt

function _dbm(deps) { return (deps && deps.db) || require('./db'); }
function _rehearsal(deps) { return (deps && deps.rehearsal) || require('./rehearsal'); }

function load({ deps = {} } = {}) {
  try { const r = JSON.parse(_dbm(deps).getMeta(RUN_KEY) || 'null'); return r && r.slug ? r : null; } catch { return null; }
}
function _save(run, deps) { try { _dbm(deps).setMeta(RUN_KEY, JSON.stringify(run)); } catch (e) { console.error('[rehearsal-driver] save failed:', e.message); } }

// Start (or restart) THE run — one at a time, deliberately: rehearsal sandboxes are bounded (≤2)
// and a queue of self-modification ideas is not a backlog worth holding. An existing active run
// must finish/park/discard first.
function start({ slug, goal, suite, files = [], deps = {}, nowMs = Date.now() } = {}) {
  const cur = load({ deps });
  if (cur && cur.status === 'active') return { ok: false, reason: `run "${cur.slug}" is already active — iterate, park, or discard it first` };
  const g = str(goal).trim(); const s = str(suite).trim();
  if (!slug || g.length < 20 || !/^smoke_[a-z0-9_]+\.js$/.test(s)) {
    return { ok: false, reason: 'a run needs a slug, a real goal sentence, and the smoke suite that will judge it (smoke_*.js)' };
  }
  // rehearsal.js speaks in operator-facing STRINGS — success is the created-sentence, anything
  // else is the honest refusal, passed through verbatim.
  const c = str(_rehearsal(deps).create({ slug }));
  const cm = /^sandbox "([^"]+)" created/.exec(c);
  if (!cm) return { ok: false, reason: c };
  const run = {
    slug: cm[1], goal: g, suite: s,
    files: (Array.isArray(files) ? files : []).map((f) => str(f)).filter(Boolean).slice(0, 4),
    iteration: 0, edits: [], lastResult: '', lastDiffSig: null, sameFailStreak: 0,
    status: 'active', startedTs: nowMs,
  };
  _save(run, deps);
  return { ok: true, run };
}

// The edit-picker envelope — defined at dispatch, validated in code (§6 L2).
const EDIT_WANT = `You are iterating on a REHEARSAL — a sandboxed copy of your own source, judged by your own smoke gate. Decide the SINGLE next action. Reply ONLY strict JSON, one of:
{"action":"edit","path":"lib/x.js","find":"<exact text currently in the file — copy it verbatim, it must occur EXACTLY ONCE>","replace":"<the replacement>","why":"<one line>"}
{"action":"new_file","path":"tools/x.py","content":"<the FULL new file — a python tool (tools/<name>.py), or its harness (scripts/smoke_<name>.js) which shells the tool via process.env.ZOE_PY and prints PASS/FAIL>","why":"<one line>"}
{"action":"test","why":"<the edits look complete — run the suite>"}
{"action":"give_up","why":"<honest: why this goal cannot be reached this way>"}
Ground the edit in the FILE CONTENT shown — never guess at text you cannot see. new_file is ONLY for a python tool or its harness that do not exist yet (build the tool, then the harness, then test); to CHANGE a file that exists, use edit. If the last test output shows a failure, fix THAT failure. Small, surgical edits win; rewrites lose.`;

function validateEditPick(raw) {
  try {
    const m = str(raw).match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    if (o.action === 'test' || o.action === 'give_up') return { valid: true, value: { action: o.action, why: str(o.why).slice(0, 240) } };
    if (o.action === 'new_file') {
      const nf = { action: 'new_file', path: str(o.path).trim(), content: str(o.content), why: str(o.why).slice(0, 240) };
      if (!nf.path || nf.content.length < 1) return { valid: false, error: 'new_file needs path + content' };
      return { valid: true, value: nf };
    }
    if (o.action !== 'edit') return { valid: false, error: 'action must be edit|new_file|test|give_up' };
    const out = { action: 'edit', path: str(o.path).trim(), find: str(o.find), replace: str(o.replace), why: str(o.why).slice(0, 240) };
    if (!out.path || !out.find || out.find === out.replace) return { valid: false, error: 'edit needs path + find + a real replacement' };
    return { valid: true, value: out };
  } catch (e) { return { valid: false, error: e.message }; }
}

// The current content of the run's watched files, from the SANDBOX (never the live tree).
function _fileBlock(run, deps) {
  const fs = (deps && deps.fs) || require('fs');
  const path = require('path');
  // Same root convention as lib/rehearsal (ZOE_REHEARSAL_DIR overrides for smokes).
  const base = (deps && deps.sandboxDir) ||
    path.join(process.env.ZOE_REHEARSAL_DIR || path.join(__dirname, '..', 'data', 'rehearsal'), run.slug);
  const parts = [];
  for (const f of (run.files || [])) {
    try { parts.push(`── ${f} (sandbox, current) ──\n${str(fs.readFileSync(path.join(base, f), 'utf8')).slice(0, FILE_CAP)}`); }
    catch { parts.push(`── ${f} — unreadable in the sandbox ──`); }
  }
  return parts.join('\n\n');
}

// One bounded iteration. Returns { ok, status, note } and journals everything. deps: ask (cloud),
// rehearsal, db, fs/sandboxDir (smokes), procedures (stuck-constraint), land (green card).
async function iterate({ deps = {}, nowMs = Date.now() } = {}) {
  const run = load({ deps });
  if (!run || run.status !== 'active') return { ok: false, status: (run && run.status) || 'none', note: 'no active run' };
  const R = _rehearsal(deps);
  if (run.iteration >= ITER_BUDGET) {
    run.status = 'parked'; _save(run, deps);
    return { ok: true, status: 'parked', note: `iteration budget spent at ${run.iteration} — resumable (a bound defers, never disappears)` };
  }
  run.iteration++;
  const ask = (deps.ask) || require('./cloud_logic').ask;
  let pick = null;
  try {
    pick = await ask({
      task: 'rehearsal_iterate', v: 1,
      input: {
        goal: run.goal, suite: run.suite, iteration: run.iteration,
        files: _fileBlock(run, deps),
        diff_so_far: (() => { try { return str(R.diff({ slug: run.slug })).slice(0, 2500); } catch { return '(diff unavailable)'; } })(),
        last_test_output: str(run.lastResult).slice(0, RESULT_CAP) || '(no test run yet)',
      },
      want: EDIT_WANT, validate: validateEditPick, numPredict: 1400, think: false,
    });
  } catch (e) { console.error('[rehearsal-driver] edit pick failed:', e.message); }
  if (!pick) { _save(run, deps); return { ok: false, status: 'active', note: 'cloud unavailable — iteration counted, run stays active' }; }

  if (pick.action === 'give_up') {
    run.status = 'stuck'; _save(run, deps);
    _crystallizeStuck(run, pick.why, deps, nowMs);
    return { ok: true, status: 'stuck', note: `gave up honestly: ${pick.why}` };
  }

  if (pick.action === 'new_file') {
    // R2 — originate a python tool or its harness (tools/*.py, scripts/smoke_*.js). A fresh file is
    // not yet judged; record it and let the NEXT iteration write its harness / edit / test. Refusals
    // ride the next attempt verbatim, same contract as a failed edit.
    const wr = str(R.writeFile({ slug: run.slug, path: pick.path, content: pick.content }));
    const wrote = /^wrote /.test(wr);
    run.edits.push({ i: run.iteration, path: pick.path, ok: wrote, why: pick.why, kind: 'new_file' });
    if (!wrote) {
      run.lastResult = `NEW_FILE FAILED (${pick.path}): ${wr}\nNew files may only be tools/<name>.py or scripts/smoke_<name>.js — change an existing file with an edit instead.`;
      _save(run, deps);
      return { ok: true, status: 'active', note: `new_file refused (${wr.slice(0, 60)}) — the refusal rides the next attempt` };
    }
    run.lastResult = `${wr}\n(build the rest, then pick "test" to run ${run.suite})`;
    _save(run, deps);
    return { ok: true, status: 'active', note: `created ${pick.path} — next iteration writes the harness / edits / tests` };
  }

  if (pick.action === 'edit') {
    const er = str(R.edit({ slug: run.slug, path: pick.path, find: pick.find, replace: pick.replace }));
    const edited = /^edited /.test(er);
    run.edits.push({ i: run.iteration, path: pick.path, ok: edited, why: pick.why });
    if (!edited) {
      // The failure IS the teaching (44f8052): the exact-match complaint rides the next attempt.
      run.lastResult = `EDIT FAILED (${pick.path}): ${er}\nRe-read the FILE CONTENT block and copy the find-text verbatim — it must occur exactly once.`;
      _save(run, deps);
      return { ok: true, status: 'active', note: `edit refused (${er.slice(0, 60)}) — the refusal rides the next attempt` };
    }
  }

  // test after every successful edit (and on an explicit "test" pick) — the tight loop IS the organ.
  // rehearsal.test resolves a STRING whose header carries the verdict: [sandbox "x" gate passed|FAILED…].
  let out = '';
  try { out = str(await R.test({ slug: run.slug, suite: run.suite })); } catch (e) { out = 'test threw: ' + e.message; }
  const passed = /"\s*gate passed\]/.test(out) || /gate passed\]/.test(out);
  run.lastResult = out.slice(-RESULT_CAP);

  // stuck detection: the suite still fails AND the diff hasn't changed since the last failure.
  const sig = (() => { try { return String(str(R.diff({ slug: run.slug })).length); } catch { return null; } })();
  if (!passed) {
    run.sameFailStreak = (sig != null && sig === run.lastDiffSig) ? run.sameFailStreak + 1 : 0;
    run.lastDiffSig = sig;
    if (run.sameFailStreak >= 2) {
      run.status = 'stuck'; _save(run, deps);
      _crystallizeStuck(run, `same failure with an unchanged diff twice on ${run.suite}`, deps, nowMs);
      return { ok: true, status: 'stuck', note: 'same failure, unchanged diff, twice — stopped; the lesson is crystallized' };
    }
    _save(run, deps);
    return { ok: true, status: 'active', note: `iteration ${run.iteration}: ${run.suite} still failing — the raw output rides the next attempt` };
  }

  // suite green → the FULL gate decides the exit (minutes; the one expensive step, spent only here).
  let gateOut = '';
  try { gateOut = str(await R.test({ slug: run.slug })); } catch (e) { gateOut = 'gate threw: ' + e.message; }
  const gateGreen = /gate passed\]/.test(gateOut);
  gateOut = gateOut.slice(-RESULT_CAP);
  if (!gateGreen) {
    run.lastResult = `SUITE GREEN but the FULL GATE failed:\n${gateOut}`;
    _save(run, deps);
    return { ok: true, status: 'active', note: 'suite green, full gate red — the gate output rides the next attempt' };
  }

  // GREEN EXIT → the R2 proposal card. The only thing that leaves the sandbox is a document.
  run.status = 'green'; _save(run, deps);
  let docId = null;
  try {
    const diff = (() => { try { return str(R.diff({ slug: run.slug })); } catch { return '(diff unavailable)'; } })();
    const land = deps.land || require('./doc_store').land;
    const body = [
      `_Rehearsal run "${run.slug}" · ${run.iteration} iteration(s) · suite ${run.suite} · FULL GATE GREEN_`,
      `## Goal\n${run.goal}`,
      `## The change (sandbox diff)\n\`\`\`\n${diff.slice(0, 8000)}\n\`\`\``,
      `## Gate verdict\n\`\`\`\n${gateOut.slice(-1200)}\n\`\`\``,
      `## Adoption\nNothing self-adopts (R3). If this earns it: apply by hand, run the gate on the live tree, commit. The sandbox holds until discarded.`,
    ].join('\n\n');
    const r = land({ title: `Rehearsal proposal — ${run.goal.slice(0, 80)}`, body, source: 'rehearsal', ref: `rehearsal-${run.slug}-${run.startedTs}` });
    docId = r && r.id;
  } catch (e) { console.error('[rehearsal-driver] proposal card failed:', e.message); }
  return { ok: true, status: 'green', note: `FULL GATE GREEN — proposal card${docId ? ` doc #${docId}` : ''} landed; the sandbox holds for Lucas`, docId };
}

function _crystallizeStuck(run, why, deps, nowMs) {
  try {
    require('./procedures').crystallize({
      decision: { move: 'rehearse', target: run.goal.slice(0, 120) },
      opRes: { answer: str(run.lastResult).slice(0, 800) },
      verdict: { met: false, why: str(why).slice(0, 160) },
      deps, nowMs,
    });
  } catch (e) { console.error('[rehearsal-driver] stuck constraint failed:', e.message); }
}

// Resume a parked run with a fresh budget; anything terminal must be discarded instead.
function resume({ deps = {} } = {}) {
  const run = load({ deps });
  if (!run || run.status !== 'parked') return { ok: false, reason: 'no parked run' };
  run.status = 'active'; run.iteration = 0; run.sameFailStreak = 0;
  _save(run, deps);
  return { ok: true, run };
}

function discard({ deps = {} } = {}) {
  const run = load({ deps });
  if (!run) return { ok: false, reason: 'no run' };
  try { _rehearsal(deps).discard({ slug: run.slug }); } catch {}
  try { _dbm(deps).setMeta(RUN_KEY, 'null'); } catch {}
  return { ok: true, slug: run.slug };
}

// One line for the autonomy manifest — the tick's continuity surface for the run.
function manifestLine({ deps = {} } = {}) {
  const run = load({ deps });
  if (!run) return '';
  return `   - [rehearsal ${run.slug}] ${run.status} at iteration ${run.iteration} — "${run.goal.slice(0, 80)}" (suite ${run.suite})`;
}

module.exports = { RUN_KEY, ITER_BUDGET, EDIT_WANT, load, start, validateEditPick, iterate, resume, discard, manifestLine };
