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
const NOOP_STREAK_CAP = 4;      // consecutive REFUNDED picks (schema/cloud) before the run parks — a refund is a free spin, and an unbounded streak retries at drain pace forever
const FILE_CAP = 24000;         // chars of each watched file the edit-picker sees — sized TO the window
                                // ([[artificial-caps-truncate]]): at 6000 the picker saw 34% of need-1's
                                // lib/intent.js (17.8k) and every edit against the unseen 66% was refused
                                // as inexact (5/5 failed, boot117). The cap is a runaway guard, not a budget.
const RESULT_CAP = 3000;        // chars of raw test output that ride the next attempt

// Squeeze a test/gate dump to its SIGNAL for the pick brief: a full-gate tail is ~3000 chars of
// PASS-table noise with the failing-suite names buried at the very end — the model drowned in it
// and returned schema-invalid picks three boots running (mislabeled "cloud unavailable"). Keep the
// head line, every failure-ish line, and the closing tally; drop the green wall.
function _squeezeTestOutput(s, cap = RESULT_CAP) {
  const raw = str(s);
  if (!raw.trim()) return '';
  const lines = raw.split(/\r?\n/);
  if (raw.length <= cap && lines.length <= 30) return raw;
  const keep = [];
  if (lines[0]) keep.push(lines[0]);
  for (const ln of lines) {
    if (/FAIL|failed:|✗|Error|error TS|Cannot|Traceback|✖/i.test(ln) && !/0 failed/.test(ln)) keep.push(ln);
  }
  for (const ln of lines.slice(-4)) if (!keep.includes(ln) && ln.trim()) keep.push(ln);
  const out = keep.join('\n');
  return (out.length > cap ? out.slice(0, cap) : out) || raw.slice(-cap);
}

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
  let c = str(_rehearsal(deps).create({ slug }));
  let cm = /^sandbox "([^"]+)" created/.exec(c);
  // SLOT RECLAIM (boot132: need #2's open refused — "already 2 live sandboxes" — while both
  // squatters were stuck/parked LEFTOVERS whose lessons live in the run journal, not the working
  // copy). Discard the OLDEST leftover and retry once. Safe: start() already refused above if a
  // run is ACTIVE, so every listed sandbox here is a leftover.
  if (!cm && /already \d+ live sandboxes/.test(c)) {
    try {
      const R = _rehearsal(deps);
      const live = (R.list() || []).slice().sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0));
      if (live.length) {
        R.discard({ slug: live[0].slug });
        c = str(R.create({ slug }));
        cm = /^sandbox "([^"]+)" created/.exec(c);
        if (cm) console.log(`[rehearsal] reclaimed sandbox "${live[0].slug}" (stuck/parked leftover) so "${slug}" could open`);
      }
    } catch { /* fall through to the honest refusal */ }
  }
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
    try {
      const raw = str(fs.readFileSync(path.join(base, f), 'utf8'));
      const cut = raw.length > FILE_CAP;
      // A silent cut makes the model quote text it cannot see — the exact-match applier then refuses
      // every edit. If we must truncate, SAY SO where the model will read it.
      parts.push(`── ${f} (sandbox, current) ──\n${raw.slice(0, FILE_CAP)}`
        + (cut ? `\n…[TRUNCATED — ${raw.length - FILE_CAP} more chars exist below this point; NEVER propose an edit quoting text you cannot see above]` : ''));
    } catch { parts.push(`── ${f} — unreadable in the sandbox ──`); }
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
  // SANDBOX SELF-HEAL (boot128: need-1 burned 4 sittings against "no sandbox — create it first").
  // start() created the sandbox, but a reboot or tidy() prune can take it out from under an ACTIVE
  // run — after which EVERY file action refuses until the budget parks it. A live run re-creates
  // its sandbox once per sitting; only an unrecreatable sandbox parks the run, honestly named.
  try {
    if (!R.list().some((s) => s.slug === run.slug)) {
      const cr = str(R.create({ slug: run.slug }));
      if (/^sandbox "/.test(cr)) console.log(`[rehearsal] sandbox "${run.slug}" was lost — re-created for the active run`);
      else {
        run.status = 'parked'; _save(run, deps);
        return { ok: true, status: 'parked', note: `sandbox lost and not recreatable (${cr.slice(0, 80)}) — parked, resumable` };
      }
    }
  } catch { /* self-heal is best-effort; the normal refusal path still rides */ }
  run.iteration++;
  const ask = (deps.ask) || require('./cloud_logic').ask;
  let pick = null, _pickThrew = null;
  try {
    pick = await ask({
      task: 'rehearsal_iterate', v: 1,
      input: {
        goal: run.goal, suite: run.suite, iteration: run.iteration,
        files: _fileBlock(run, deps),
        diff_so_far: (() => { try { return str(R.diff({ slug: run.slug })).slice(0, 2500); } catch { return '(diff unavailable)'; } })(),
        last_test_output: _squeezeTestOutput(run.lastResult) || '(no test run yet)',
      },
      want: EDIT_WANT, validate: validateEditPick, numPredict: 1400, think: false,
    });
  } catch (e) { _pickThrew = e; console.error('[rehearsal-driver] edit pick failed:', e.message); }
  if (!pick) {
    // A failed cloud pick did NO work (no edit, no test) — it must not spend budget: a flaky
    // cloud stretch could park the run without it ever actually iterating (live, boot110).
    // Refund the increment and stay active. NAME THE TRUE DOOR (boot113: three "cloud
    // unavailable" notes were really schema-invalid picks — nothing had thrown at all).
    // …but a refund is a FREE SPIN, and an unbounded streak of them retries at drain pace
    // forever (boot117: schema-invalid picks recurring across boots). A streak cap PARKS the
    // run — the same deferral as budget-spent, resumable, never a silent kill.
    run.iteration--;
    run.noopStreak = (run.noopStreak || 0) + 1;
    if (run.noopStreak >= NOOP_STREAK_CAP) {
      run.status = 'parked'; _save(run, deps);
      return { ok: true, status: 'parked', note: `${run.noopStreak} consecutive no-op picks (schema-invalid or cloud) — parked to stop the free spin; resumable` };
    }
    _save(run, deps);
    return { ok: false, status: 'active', note: _pickThrew
      ? 'cloud unavailable — budget refunded, run stays active'
      : 'edit pick returned but FAILED VALIDATION (schema) — budget refunded; the squeezed test output rides the next attempt' };
  }
  run.noopStreak = 0;   // a pick landed — the free-spin streak is over

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
  run.status = 'active'; run.iteration = 0; run.sameFailStreak = 0; run.noopStreak = 0;
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
  // A DEAD LANE MUST SAY SO (boot130: the decider chose rehearse 4× in one boot and every pick
  // no-oped — a stuck run's line read like work). When the run can't advance AND no open need
  // could start a new one, the line tells the decider plainly not to spend a pick here.
  if (run.status !== 'active') {
    let openNeeds = 0;
    try { openNeeds = require('./capability_need').listOpen({ deps }).length; } catch {}
    if (!openNeeds) return `   - [rehearsal ${run.slug}] ${run.status} — NOTHING ACTIONABLE (no open capability needs); do NOT choose rehearse this tick`;
    return `   - [rehearsal ${run.slug}] ${run.status} — but ${openNeeds} open capability need(s) could start a NEW run`;
  }
  return `   - [rehearsal ${run.slug}] ${run.status} at iteration ${run.iteration} — "${run.goal.slice(0, 80)}" (suite ${run.suite})`;
}

module.exports = { RUN_KEY, ITER_BUDGET, NOOP_STREAK_CAP, FILE_CAP, EDIT_WANT, load, start, validateEditPick, iterate, resume, discard, manifestLine, _squeezeTestOutput, _fileBlock };
