/* Smoke: streamChat inactivity watchdog. Stubs global fetch — no Ollama needed.
 * Proves: a stalled stream (no tokens) is aborted ~inactivityMs; a normal stream still streams.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_stream_watchdog.js
 */
const ollama = require('C:/Users/azrae/Desktop/Side Quest/lib/ollama');
const realFetch = globalThis.fetch;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const enc = new TextEncoder();

(async () => {
  try {
    // 1) STALLED stream: reader.read() never resolves until the fetch signal aborts.
    globalThis.fetch = async (_url, opts) => {
      const sig = opts && opts.signal;
      return { ok: true, body: { getReader: () => ({
        read: () => new Promise((_, rej) => {
          if (sig) sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        })
      }) } };
    };
    const t0 = Date.now();
    let threw = false;
    try { await ollama.streamChat({ model: 'x', messages: [], onToken: () => {}, inactivityMs: 150 }); }
    catch { threw = true; }
    const dt = Date.now() - t0;
    console.log('stalled stream:');
    ok(threw, 'watchdog aborted the hung generation (did not hang forever)');
    ok(dt >= 100 && dt < 2000, `aborted promptly (~inactivityMs, took ${dt}ms)`);

    // 2) NORMAL stream: yields two tokens then done → onToken called, returns without abort.
    globalThis.fetch = async () => {
      const chunks = [
        enc.encode(JSON.stringify({ message: { content: 'Hel' } }) + '\n'),
        enc.encode(JSON.stringify({ message: { content: 'lo' } }) + '\n'),
        enc.encode(JSON.stringify({ done: true }) + '\n'),
      ];
      let i = 0;
      return { ok: true, body: { getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true })
      }) } };
    };
    const toks = [];
    let normalThrew = false;
    try { await ollama.streamChat({ model: 'x', messages: [], onToken: (t) => toks.push(t), inactivityMs: 5000 }); }
    catch { normalThrew = true; }
    console.log('normal stream:');
    ok(!normalThrew, 'a healthy stream completes without aborting');
    ok(toks.join('') === 'Hello', 'tokens streamed through intact ("Hello")');

    // 3) complete() STALL: fetch never resolves until the signal aborts → overall timeout fires.
    globalThis.fetch = (_url, opts) => new Promise((_, rej) => {
      const sig = opts && opts.signal;
      if (sig) sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const c0 = Date.now();
    let cThrew = false;
    try { await ollama.complete({ model: 'x', messages: [], timeoutMs: 150 }); } catch { cThrew = true; }
    const cdt = Date.now() - c0;
    console.log('complete() stalled:');
    ok(cThrew && cdt >= 100 && cdt < 2000, `complete() aborts a hung call (~timeoutMs, took ${cdt}ms)`);

    // 4) complete() NORMAL: resolves with content.
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'hi there' } }) });
    let cText = null, cnThrew = false;
    try { cText = await ollama.complete({ model: 'x', messages: [], timeoutMs: 5000 }); } catch { cnThrew = true; }
    console.log('complete() normal:');
    ok(!cnThrew && cText === 'hi there', 'a healthy complete() returns its content');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
