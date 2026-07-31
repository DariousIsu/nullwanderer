/* Smoke: the say-token STREAM DISCRIMINATOR (reply-delivery-path root fix, 2026-07-30).
 * The latch class died because chat:say-token carried a bare token with NO stream id — three
 * writers on one channel forced the renderer's heuristic tangle. This smoke reads the SOURCES
 * (the tag-list-drift lesson: pin the real code, never restate it) and asserts:
 *   1. every chat:say-token emitter stamps a stream ({t, s}) — no bare-token writer remains;
 *   2. every streaming emitter's chat:complete carries the same stream stamp;
 *   3. preload forwards (token, stream) and still passes legacy bare strings;
 *   4. the renderer routes discriminated streams by FACT (reply → transcript, others → sheep
 *      buffers) and keeps the legacy latch only as a fallback;
 *   5. a truncated prompted reply is VISIBLY stamped (the honest-cut rule).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_stream_discriminator.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const main = read('main.js');
const heartbeat = read('lib/heartbeat.js');
const continuity = read('lib/continuity.js');
const preload = read('preload.js');
const chat = read('renderer/chat.js');

// --- 1. every say-token send is stamped ---
const sayTokenSends = [];
for (const [name, src] of [['main.js', main], ['heartbeat.js', heartbeat], ['continuity.js', continuity]]) {
  const re = /send\('chat:say-token',\s*([^)]+)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) sayTokenSends.push({ name, arg: m[1] });
}
ok(sayTokenSends.length >= 4, `found the say-token emitters (${sayTokenSends.length})`);
ok(sayTokenSends.every((s) => /s:\s*'(reply|heartbeat|continuity|auto)'/.test(s.arg)),
  'EVERY say-token emitter stamps its stream — no bare-token writer remains');

// --- 2. the streaming completes carry the same stamp ---
ok(/send\('chat:complete',\s*\{\s*\.\.\.\(info \|\| \{\}\),\s*s:\s*'reply'/.test(main), "the prompted turn's complete is stamped s:'reply'");
ok((heartbeat.match(/'chat:complete'/g) || []).length >= 2 && !/send\('chat:complete',(?![^)]*s: 'heartbeat')/.test(heartbeat.replace(/\n/g, ' ')),
  "every heartbeat complete is stamped s:'heartbeat' (incl. the silent one)");
ok((continuity.match(/s: 'continuity'/g) || []).length >= 3, "every continuity complete + token is stamped s:'continuity'");

// --- 3. preload forwards the pair, legacy strings still pass ---
ok(/onSayToken: \(cb\) => ipcRenderer\.on\('chat:say-token', \(_e, p\) => \{ if \(p && typeof p === 'object'\) cb\(String\(p\.t \|\| ''\), p\.s\); else cb\(p\); \}\)/.test(preload),
  'preload forwards (token, stream) and passes legacy bare tokens unchanged');

// --- 4. the renderer routes by fact ---
ok(/onSayToken\(\(token, stream\) =>/.test(chat), 'renderer token handler accepts the stream discriminator');
ok(/if \(stream && stream !== 'reply'\) \{\s*sheepBufs\[stream\]/.test(chat), 'discriminated autonomous tokens buffer per-stream — never the transcript, no latch');
ok(/if \(stream === 'reply'\) \{/.test(chat), 'discriminated reply tokens go to the transcript unconditionally');
ok(/if \(info && info\.s && info\.s !== 'reply'\) \{/.test(chat), 'discriminated autonomous completes flush to sheep without touching prompted state');
ok(/!\(info && info\.s === 'reply'\) && !currentAiTurnDiv/.test(chat), "a stamped reply complete can never be shunted by the legacy unprompted gate");
ok(/unpromptedActive = false;\s*unpromptedBuffer = '';\s*\}/.test(chat) && /stale unpromptedActive latch cleared/.test(chat),
  'the legacy latch + its self-heal survive for unstamped emitters only');

// --- 5. the honest cut ---
ok(/that reply was cut off mid-stream/.test(chat),
  'a genuinely cut reply is visibly stamped on the turn (a cut you can SEE)');
// ⭐ …and ONLY a genuine one. The stamp keyed on the RAW `truncated` flag, which means only that the
// stream ended without a closing </say> — main.js measured 3 of 18 cloud replies carrying it with
// ZERO actually cut. So finished answers were announced to Lucas as broken, repeatedly. The stamp now
// keys on `cutOff`, the backend's real verdict (ollama.sayLooksCutOff), which is the same test that
// decides whether to regenerate — so the screen and the recovery path can no longer disagree.
ok(/typeof info\.cutOff === 'boolean' \? info\.cutOff : !!info\.truncated/.test(chat),
  '⭐ the stamp keys on cutOff, falling back to truncated only for an older payload');
ok(!/if \(turnDiv && info && info\.truncated\)/.test(chat),
  '…and never on the raw truncated flag again');
{
  const m = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  ok(/cutOff: _cutOff/.test(m) && /sayLooksCutOff\(finalSaid \|\| say, truncated\)/.test(m),
    'the backend computes cutOff with the SAME predicate that gates regeneration');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
