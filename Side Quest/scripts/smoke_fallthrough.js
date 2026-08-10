'use strict';
/* smoke_fallthrough.js — A1 generic organ (lib/fallthrough.js).
 * The contract: try readers in order, first non-empty wins; a thrown reader is a MISS (falls through, never
 * aborts); if EVERY reader is empty the result is an honest not-found (ok:false) — NEVER invented. The
 * fallback must NOT run when the primary already answered. Pure, offline. Run: node scripts/smoke_fallthrough.js */
const ft = require('../lib/fallthrough');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // ── primary wins → fallback is never called ───────────────────────────────────────────────────────────────
  {
    let fbCalls = 0;
    const r = await ft.withFallthrough(() => 'the answer', () => { fbCalls++; return 'fallback'; });
    ok(r.ok && r.via === 'primary' && r.index === 0, 'primary succeeds → via:primary, index 0');
    ok(r.result === 'the answer', 'primary result returned verbatim');
    ok(fbCalls === 0, 'fallback NOT called when primary answers (no wasted work)');
  }

  // ── primary empty → fall through to fallback ──────────────────────────────────────────────────────────────
  {
    const r = await ft.withFallthrough(() => null, () => 'from the floor');
    ok(r.ok && r.via === 'fallback:1' && r.index === 1, 'primary empty → fallback wins, via:fallback:1');
    ok(r.result === 'from the floor', 'fallback result returned');
  }

  // ── both empty → honest not-found, NEVER invented ────────────────────────────────────────────────────────
  {
    const r = await ft.withFallthrough(() => '', () => null);
    ok(r.ok === false && r.via === 'none' && r.index === -1, 'both empty → ok:false, via:none (honest not-found)');
    ok(!r.result, 'nothing fabricated when both readers came up empty');
  }

  // ── a thrown reader is a MISS, not an abort ──────────────────────────────────────────────────────────────
  {
    let reached = false;
    const r = await ft.withFallthrough(() => { throw new Error('vision blind'); }, () => { reached = true; return 'text floor'; });
    ok(reached && r.ok && r.result === 'text floor', 'primary throws → falls through (throw = miss, not abort)');
  }
  {
    const r = await ft.withFallthrough(() => null, () => { throw new Error('av_transcribe down'); });
    ok(r.ok === false && r.via === 'none', 'both fail (one throws) → honest not-found, no crash');
  }

  // ── N-reader cascade (media_cc: textTracks → DOM → av_transcribe) ────────────────────────────────────────
  {
    const calls = [];
    const r = await ft.descend([
      () => { calls.push('textTracks'); return []; },        // empty array
      () => { calls.push('domOverlay'); return ''; },         // empty string
      () => { calls.push('avTranscribe'); return { lines: ['line one', 'line two'] }; },
    ], { label: 'captions' });
    ok(r.ok && r.index === 2 && r.via === 'fallback:2', 'three readers: third answers → index 2');
    ok(calls.length === 3 && calls[2] === 'avTranscribe', 'readers tried in order until one answers');
  }
  {
    const calls = [];
    const r = await ft.descend([
      () => { calls.push('a'); return 'first'; },
      () => { calls.push('b'); return 'second'; },
    ]);
    ok(r.index === 0 && calls.length === 1, 'descend stops at the first non-empty reader (no over-reading)');
  }

  // ── ok() override for a custom success shape ─────────────────────────────────────────────────────────────
  {
    const isBig = (r) => r && r.count >= 10;
    const r = await ft.descend([() => ({ count: 3 }), () => ({ count: 42 })], { ok: isBig });
    ok(r.ok && r.result.count === 42, 'custom ok(): a "small" primary falls through to a "big" fallback');
  }

  // ── empty / malformed reader list → honest not-found, no throw ───────────────────────────────────────────
  {
    const r = await ft.descend([]);
    ok(r.ok === false && r.via === 'none', 'no readers → ok:false, never throws');
    const r2 = await ft.descend([null, 'not a fn', () => 'ok']);
    ok(r2.ok && r2.result === 'ok', 'non-function entries are skipped, real readers still run');
  }

  // ── _defaultOk shape coverage ────────────────────────────────────────────────────────────────────────────
  {
    ok(ft._defaultOk('x') && !ft._defaultOk('  '), '_defaultOk: non-empty string yes, whitespace no');
    ok(ft._defaultOk([1]) && !ft._defaultOk([]), '_defaultOk: non-empty array yes, empty no');
    ok(ft._defaultOk({ found: true }) && !ft._defaultOk({ found: false }), '_defaultOk: excavate {found} flag honored');
    ok(ft._defaultOk({ lines: ['a'] }) && !ft._defaultOk({ lines: [] }), '_defaultOk: caption {lines} honored');
    ok(ft._defaultOk({ text: 'hi' }) && !ft._defaultOk({ text: ' ' }), '_defaultOk: fetched {text} honored');
    ok(!ft._defaultOk(null) && !ft._defaultOk(false) && !ft._defaultOk(undefined), '_defaultOk: null/false/undefined are misses');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
