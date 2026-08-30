/* Smoke: lib/self_audit — Stage 1 of the native self-repair loop (IDENTIFY). Synthetic corpus
 * exhibiting each of the seven defect classes; proves every detector fires on its class and stays
 * quiet on clean code, the recurrence rule (≥2 passes ≥20h apart — one-pass noise never mints),
 * the capped mint door (≤1/pass, ≤2 open audit-born, born_from dedup), the obs summary, and the
 * due() clock. Also a REAL-corpus sanity pass: collectCorpus on the live repo runs without throwing.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_audit.js
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_selfaudit_${process.pid}_${Date.now().toString(36)}.db`);
process.env.SQ_DB_PATH = tmp;
const ROOT = 'C:/Users/azrae/Desktop/Side Quest';
const db = require(ROOT + '/lib/db');
const bus = require(ROOT + '/lib/obs_bus');
const sa = require(ROOT + '/lib/self_audit');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const F = (t, mtimeMs = Date.now()) => ({ text: t, mtimeMs });

(() => {
  try {
    db.init();
    const now = Date.now();

    // ── the synthetic corpus: one defect per class + clean counterparts ──
    const corpus = {
      docsText: 'ZOE_DOCUMENTED_FLAG is documented here.',
      files: {
        // 1. zero-caller export: darkFn exported, referenced only by a smoke; usedFn called from main.js
        'lib/dark.js': F('function darkExport() {}\nfunction usedExport() {}\nmodule.exports = { darkExport, usedExport };'),
        // 2. unread meta key + a read one + a dynamic-prefix-covered one
        'lib/meta_writer.js': F("db.setMeta('dead.key', '1'); db.setMeta('read.key', '2'); db.setMeta('focus.7.plan', 'x');"),
        'lib/meta_reader.js': F("db.getMeta('read.key'); const p = db.getMeta(`focus.${id}.plan`);"),
        // 3. orphan env flag + a documented one
        'lib/envs.js': F('const a = process.env.ZOE_SECRET_KNOB; const b = process.env.ZOE_DOCUMENTED_FLAG;'),
        // 4. advertised lane never emitted + one that is emitted
        'lib/lanes.js': F("// watch for `[ghost-lane] armed` in the boot log\n// acceptance: `[real-lane] fired`\nconsole.log('[real-lane] fired');"),
        // 5. LIVE claim over a STUBBED body
        'lib/liar.js': F('/** This organ is LIVE and wired end-to-end. */\nfunction x() { /* STUBBED until the provider lands */ }\nmodule.exports = { liarOrgan: x };'),
        // 6. fail-open catch in a gate file (undocumented) + a documented one that must be skipped
        'lib/toll_gate.js': F('function check() { try { hmm(); } catch (e) { return { allow: true }; } }\n// Fails OPEN by design — a throttle that bricks her would be worse.\nfunction check2() { try { hmm(); } catch (e) { return { allow: true }; } }'),
        // 7. ungated recent smoke + an OLD ungated one (deliberate live set) + a gated one
        'scripts/run_smokes.js': F("const smokes = ['smoke_gated.js'];"),
        'scripts/smoke_gated.js': F('// in the gate'),
        'scripts/smoke_fresh.js': F('// brand new, forgot the gate', now - 3600e3),
        'scripts/smoke_ancient_live.js': F('// live-integration by design', now - 30 * 24 * 3600e3),
        // callers file — makes usedExport live, exercises darkExport ONLY from a smoke.
        // liarOrgan (lib/liar.js) is deliberately caller-less too — it counts in zero-caller totals.
        'main.js': F("const { usedExport } = require('./lib/dark'); usedExport();"),
        'scripts/smoke_dark.js': F("require('../lib/dark').darkExport();", now - 30 * 24 * 3600e3),
        // 8. #110 (verified 08-29): WIRED_CONST is used inside its own module as a default — never
        // dark; DEAD_CONST is referenced nowhere at all — still genuinely dead, still flags.
        'lib/consts.js': F('const WIRED_CONST = 6 * 3600;\nconst DEAD_CONST = 42;\nfunction ttl(x = WIRED_CONST) { return x; }\nmodule.exports = { WIRED_CONST, DEAD_CONST, ttl };'),
      },
    };

    console.log('A) the seven detectors');
    const fx = sa.runDetectors(corpus, { nowMs: now });
    const by = (d) => fx.filter((f) => f.detector === d);
    const zc = by('zero-caller-export');
    ok(zc.some((f) => f.name === 'darkExport') && zc.some((f) => f.name === 'liarOrgan') && !zc.some((f) => f.name === 'usedExport'), 'zero-caller: darkExport + liarOrgan flagged, usedExport (live caller) not');
    ok(/smoke-only/.test(zc.find((f) => f.name === 'darkExport').text), 'zero-caller: smoke-only coverage named (the setProvider class)');
    ok(!zc.some((f) => f.name === 'WIRED_CONST'), '⭐ #110: a constant used inside its own module is WIRED, never dark (the DEFAULT_TTL_S false positive)');
    ok(zc.some((f) => f.name === 'DEAD_CONST'), '#110: a constant referenced nowhere at all still flags — the excuse is internal USE, not constant-ness');
    ok(by('unread-meta-key').length === 1 && by('unread-meta-key')[0].name === 'dead.key', 'meta: dead.key flagged; read.key + dynamic-prefix focus.7.plan not');
    ok(by('orphan-env-flag').length === 1 && by('orphan-env-flag')[0].name === 'ZOE_SECRET_KNOB', 'env: undocumented flag flagged, documented one not');
    ok(by('advertised-lane').length === 1 && by('advertised-lane')[0].name === 'ghost-lane', 'lanes: promised-never-emitted flagged, emitted one not');
    ok(by('live-claim').length === 1 && by('live-claim')[0].file === 'lib/liar.js', 'live-claim: LIVE header over STUBBED body flagged');
    ok(by('fail-open-gate').length === 1 && /toll_gate/.test(by('fail-open-gate')[0].file), 'fail-open: undocumented catch→allow flagged; "Fails OPEN" doc\'d one skipped');
    ok(by('ungated-smoke').length === 1 && by('ungated-smoke')[0].name === 'smoke_fresh.js', 'smokes: recent ungated flagged; ancient live-set + gated one not');

    // BACKCHECK fixes (2026-08-15): inline-documented fail-open skipped; $-in-name export probes correctly.
    console.log('A2) backcheck regressions');
    const fx2 = sa.runDetectors({
      docsText: '',
      files: {
        // a fail-open documented INLINE on the return line (was missed → spurious flag)
        'lib/inline_gate.js': F('function chk() { try { hmm(); } catch (e) { return { allow: true }; /* fails open: no store yet */ } }'),
        // a fail-open documented in the FILE HEADER (was missed)
        'lib/header_gate.js': F('/** This guard FAILS OPEN by design — a bricked throttle is worse. */\nfunction c() { try { x(); } catch (e) { return true; } }'),
        // an export whose name contains $ — the \\b regex mis-anchored and falsely flagged it dark
        'lib/dollar.js': F('function use$Thing() {}\nmodule.exports = { use$Thing };'),
        'main.js': F("const { use$Thing } = require('./lib/dollar'); use$Thing();"),
      },
    }, { nowMs: now });
    ok(fx2.filter((f) => f.detector === 'fail-open-gate').length === 0, 'inline + header "fails open" notes are now recognized (no spurious fail-open finding)');
    ok(!fx2.some((f) => f.detector === 'zero-caller-export' && f.name === 'use$Thing'), '$-in-name export with a real live caller → NOT flagged dark (identifier-boundary regex)');

    console.log('B) recurrence + the capped mint door');
    const needsMade = [];
    const cnFix = {
      listOpen: () => needsMade.filter((n) => n.open).map((n) => ({ born_from: n.bornFrom })),
      record: (text, { bornFrom }) => { needsMade.push({ text, bornFrom, open: true }); return { id: needsMade.length, deduped: false }; },
    };
    const p1 = sa.runPass({ deps: { capabilityNeed: cnFix }, nowMs: now, corpus });
    ok(p1.findings.length === 9 && p1.mintable.length === 0 && p1.minted === null, `pass 1: ${p1.findings.length} findings recorded, NOTHING mints (one-pass noise never does)`);
    const p2 = sa.runPass({ deps: { capabilityNeed: cnFix }, nowMs: now + 3600e3, corpus });
    ok(p2.mintable.length === 0, 'pass 2 only 1h later: recurrence needs ≥20h gap — still nothing mintable');
    const p3 = sa.runPass({ deps: { capabilityNeed: cnFix }, nowMs: now + 21 * 3600e3, corpus });
    ok(p3.mintable.length === 9 && p3.minted && p3.minted.id === 1, 'pass 3 (+21h): all recurred → exactly ONE minted (per-pass cap)');
    ok(needsMade[0].bornFrom.startsWith('self-audit:'), `minted need born_from carries the audit signature (${needsMade[0].bornFrom})`);
    const p4 = sa.runPass({ deps: { capabilityNeed: cnFix }, nowMs: now + 42 * 3600e3, corpus });
    ok(p4.minted && needsMade.length === 2, 'pass 4: second mint (still under the 2-open cap)');
    const p5 = sa.runPass({ deps: { capabilityNeed: cnFix }, nowMs: now + 63 * 3600e3, corpus });
    ok(p5.minted === null && needsMade.length === 2, 'pass 5: 2 audit-born needs open → the door is CLOSED (throttle-to-completion)');

    console.log('C) obs summary + clock');
    bus.flush();
    const evs = bus.latest({ lanes: ['audit'], kinds: ['self_audit'], limit: 10 });
    ok(evs.length >= 5 && /self-audit: 9 finding/.test(evs[evs.length - 1].text), `every pass leaves one obs summary (${evs[evs.length - 1].text.slice(0, 80)}…)`);
    ok(sa.due({ nowMs: now + 63 * 3600e3 }) === false, 'due(): just ran → not due');
    ok(sa.due({ nowMs: now + 63 * 3600e3 + sa.DUE_MS + 1 }) === true, 'due(): 24h later → due');

    console.log('D) clean corpus + real-repo sanity');
    const clean = { docsText: '', files: { 'lib/fine.js': F("function tidy() {}\nmodule.exports = { tidyThing: tidy };"), 'main.js': F("require('./lib/fine').tidyThing();") } };
    ok(sa.runDetectors(clean, { nowMs: now }).length === 0, 'clean corpus → zero findings');
    const real = sa.collectCorpus({});
    ok(real && real.files['main.js'] && Object.keys(real.files).length > 100, `real corpus collects (${Object.keys(real.files).length} files)`);
    const t0 = Date.now();
    const realFindings = sa.runDetectors(real, { nowMs: now });
    ok(Array.isArray(realFindings), `real-repo sweep runs deterministically in ${Date.now() - t0}ms (${realFindings.length} finding(s) — review candidates, not verdicts)`);
    for (const f of realFindings.slice(0, 8)) console.log('    ·', f.detector, '—', f.text.slice(0, 120));

    console.log('E) the child sweep path (the live entry — main thread never pays the ~8s)');
    const cp = require('child_process');
    const childOut = cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'self_audit_pass.js')],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 5 * 60e3, maxBuffer: 4 * 1048576 });
    const payload = JSON.parse(childOut.trim().split('\n').pop());
    ok(payload && Array.isArray(payload.findings) && payload.findings.length === realFindings.length, `child sweep returns the same findings payload (${payload.findings.length})`);
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { bus._stop(); } catch {}
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
