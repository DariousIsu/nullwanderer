/* smoke_cloud_stream.js — streaming from the CLOUD tier (the enabler for cloud-writes-the-reply).
 *
 * streamChat was hardcoded to OLLAMA_BASE with no auth headers, which is the only reason cloud
 * answers had to be fetched as one blocking block — the endpoint speaks the same /api/chat
 * streaming protocol. That mattered the moment the cloud started writing the user-facing reply: a
 * long generation with no token flow is indistinguishable from a hang, and streamChat's stall
 * watchdog can only work if tokens are actually arriving to reset it.
 *
 * Fully offline — the stream fn is injected, so nothing here touches a network or a model.
 */
'use strict';
const cloud = require('../lib/cloud_logic');
const ollama = require('../lib/ollama');

// a stand-in cloud tier so this runs with no keychain, no token, no network
const SRC = { tier: 'cloud', base: 'https://cloud.example/api', token: 'test-token' };

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// A fake stream that emits tokens then resolves, capturing what it was called with.
function fakeStream(tokens, { throwAfter = -1 } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    for (let i = 0; i < tokens.length; i++) {
      if (throwAfter >= 0 && i === throwAfter) throw new Error('stream stalled');
      args.onToken(tokens[i]);
    }
    return '';
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // ── streamChat now ACCEPTS a base + headers (the actual gap) ─────────────────────────────────
  {
    const src = String(ollama.streamChat);
    ok(/base\s*=\s*OLLAMA_BASE/.test(src), 'streamChat takes a `base` (defaulting to local)');
    ok(/headers\s*=\s*\{\}/.test(src), 'streamChat takes `headers` (for the cloud bearer token)');
    ok(/\$\{_base\}\/api\/chat/.test(src), 'REGRESSION: it fetches the resolved base, not hardcoded OLLAMA_BASE');
    ok(/\.\.\.\(headers \|\| \{\}\)/.test(src), 'caller headers are merged into the request');
  }

  // ── streamCloud delivers tokens as they arrive, with progress ────────────────────────────────
  {
    const stream = fakeStream(['Hel', 'lo ', 'Lucas']);
    const seen = [];
    const r = await cloud.streamCloud([{ role: 'user', content: 'hi' }], {
      model: 'test-model', deps: { streamChat: stream, cloudSource: SRC },
      onToken: (t, p) => seen.push({ t, tokens: p.tokens, hasElapsed: typeof p.elapsedMs === 'number' }),
    });
    if (!r) { ok(false, 'streamCloud returned null — no cloud tier configured in this environment'); }
    else {
      ok(r.text === 'Hello Lucas', 'tokens are accumulated into the full text');
      ok(seen.length === 3, 'onToken fired per token');
      ok(seen[2].tokens === 3, 'a running TOKEN COUNT is reported (progress, not a spinner)');
      ok(seen.every(s => s.hasElapsed), 'elapsed time reported alongside — a stall shows as a frozen counter');
      ok(r.tokens === 3 && typeof r.elapsedMs === 'number', 'final result carries tokens + elapsed');
      const call = stream.calls[0];
      ok(!!call.base, 'the cloud BASE is passed through to streamChat');
      ok(/^Bearer /.test((call.headers || {}).Authorization || ''), 'the bearer token is attached');
      ok(call.options && call.options.num_ctx === 8192, 'context/temperature options are forwarded');
      ok(typeof call.inactivityMs === 'number', 'the stall watchdog is armed');
    }
  }

  // ── SAFETY: a stalled stream keeps the partial answer ────────────────────────────────────────
  {
    const stream = fakeStream(['The answer ', 'is forty', 'CUT'], { throwAfter: 2 });
    const r = await cloud.streamCloud([{ role: 'user', content: 'hi' }], { model: 'm', deps: { streamChat: stream, cloudSource: SRC } });
    if (r) {
      ok(r.partial === true, 'a stalled stream is flagged partial rather than silently complete');
      ok(r.text === 'The answer is forty', 'SAFETY: partial text is RETAINED, not discarded');
    } else { ok(false, 'a stall discarded the partial answer entirely'); }
  }

  // ── SAFETY: a throwing onToken (UI hiccup) must not kill the stream ──────────────────────────
  {
    const stream = fakeStream(['a', 'b', 'c']);
    const r = await cloud.streamCloud([{ role: 'user', content: 'hi' }], {
      model: 'm', deps: { streamChat: stream, cloudSource: SRC }, onToken: () => { throw new Error('renderer blew up'); },
    });
    ok(r && r.text === 'abc', 'SAFETY: a failing progress callback does not break the answer');
  }

  // ── nothing emitted + a throw → null, so the caller falls back ───────────────────────────────
  {
    const stream = fakeStream(['x'], { throwAfter: 0 });
    const r = await cloud.streamCloud([{ role: 'user', content: 'hi' }], { model: 'm', deps: { streamChat: stream, cloudSource: SRC } });
    ok(r === null, 'no text at all → null → caller uses its local path');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
