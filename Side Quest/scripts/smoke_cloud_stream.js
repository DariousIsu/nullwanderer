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

  // ── `think` reaches streamChat — a reasoning model must obey the <think>/<say> contract ──────────
  // Without this the cloud model silos its reasoning into message.thinking (which the stream reader
  // drops) and answers in bare content with no tags, so the reply parser sees a truncated, tagless
  // stream. The local reply call has set think:false for exactly this reason; the cloud writer needs it.
  {
    const stream = fakeStream(['x']);
    await cloud.streamCloud([{ role: 'user', content: 'hi' }], {
      model: 'm', think: false, deps: { streamChat: stream, cloudSource: SRC },
    });
    ok(stream.calls[0].think === false, 'think is forwarded to streamChat');
    const s2 = fakeStream(['x']);
    await cloud.streamCloud([{ role: 'user', content: 'hi' }], { model: 'm', deps: { streamChat: s2, cloudSource: SRC } });
    ok(s2.calls[0].think === undefined, 'omitted by default — existing callers are unchanged');
  }

  // ── WIRING: the reply path actually hands cloud-owned turns to the cloud ─────────────────────────
  // The enabler is useless if nothing calls it. These assert the V1 wiring in main.js survives, since
  // the failure mode is silent: the local model just keeps writing and truncating, and every metric
  // still reports success.
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    ok(/cloudOwnsAnswer && process\.env\.ZOE_CLOUD_WRITES_REPLY !== '0'/.test(src),
      'cloud-owned turns route to the cloud writer, behind a kill-switch');
    ok(/streamCloud\(messages,/.test(src), 'the cloud is handed the SAME package the local side assembled');
    ok(/onToken: \(chunk\) => parser\.feed\(chunk\)/.test(src), 'cloud tokens go through the same parser/leak-filter/emit');
    ok(/replyWriter !== MODEL[^\n]*\r?\n\s*else await streamChat/.test(src), 'the local generation is SKIPPED when the cloud wrote it');
    ok((src.match(/model: replyWriter,/g) || []).length === 2,
      'both turn rows record WHO wrote the reply — the only way truncation is measurable per writer');
    ok(!/model: MODEL,\r?\n\s*truncated/.test(src), 'REGRESSION: no reply row is still hardcoded to the local model');

    // The cloud writer gets the tool surface the local model was denied — now carried in the
    // package's `tools` section (lib/package). Built for the CLOUD's copy only: a cloud outage must
    // not hand the local 12b a tool menu it fumbles.
    ok(/tools: suit \|\| ''/.test(src), 'the Echo suit rides the package tools section');
    ok(/streamCloud\(cloudMessages,/.test(src), 'the cloud is called with the built package');
    ok(/echoSuitBlock: \(echoSuit && !cloudOwnsAnswer\)/.test(src),
      'REGRESSION: the LOCAL package still has no tool menu on cloud-owned turns');

    // The follow-up is the harder half — it authors the NEXT tool call — so it must not fall back
    // to the local model while the first hop runs on the cloud.
    ok(/CLOUD wrote the tool-followup/.test(src), 'the tool-followup routes to the cloud too');
    ok(/if \(followupWriter === MODEL\) await streamChat/.test(src),
      'the local follow-up runs ONLY when the cloud did not write it');
    ok((src.match(/model: followupWriter/g) || []).length === 2,
      'follow-up turn rows record their writer as well');
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
