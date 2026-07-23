/* Smoke: lib/fetch_escalation — the BLOCKER ESCALATION LADDER (hermetic; injected deps).
 * Proves: plain fetch wins first; archive snapshot next (labeled stale-honest); vision last;
 * total failure names every door tried; a thin "success" (shell page) does not count as a read;
 * and the operator TOOL_SPEC actually teaches the new interaction tools (schema-line law).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_fetch_escalation.js
 */
const FE = require('C:/Users/azrae/Desktop/Side Quest/lib/fetch_escalation');
const OP = require('C:/Users/azrae/Desktop/Side Quest/lib/operator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const LONG = 'Real page content about parish officials and their contact details. '.repeat(5);

(async () => {
  try {
    // 1) plain fetch wins first — no archive/vision touched
    let saw = [];
    const r1 = await FE.escalatedRead('https://x.gov/roster', {
      fetchPage: async (u) => { saw.push(u); return { ok: true, text: LONG }; },
      seePage: async () => { saw.push('vision'); return { ok: true, text: LONG }; },
    });
    ok(r1.ok && r1.via === 'plain fetch' && saw.length === 1, 'plain fetch wins → no further doors tried');

    // 2) plain fails → archive snapshot, honestly labeled
    saw = [];
    const r2 = await FE.escalatedRead('https://x.gov/roster', {
      fetchPage: async (u) => { saw.push(u); return u.startsWith(FE.ARCHIVE_PREFIX) ? { ok: true, text: LONG } : { ok: false }; },
    });
    ok(r2.ok && r2.via === 'archive snapshot' && /stale/.test(r2.note), 'archive snapshot next — labeled as possibly stale');
    ok(saw[1] === FE.ARCHIVE_PREFIX + 'https://x.gov/roster', 'the archive door is the Wayback nearest-capture URL');

    // 3) both fetches fail → vision
    const r3 = await FE.escalatedRead('https://x.gov/roster', {
      fetchPage: async () => ({ ok: false }),
      seePage: async () => ({ ok: true, text: LONG }),
    });
    ok(r3.ok && r3.via === 'vision' && /eyes/.test(r3.note), 'vision is the third door');

    // 4) every door fails → honest concession naming what was tried
    const r4 = await FE.escalatedRead('https://x.gov/roster', {
      fetchPage: async () => ({ ok: false }),
      seePage: async () => ({ ok: false }),
    });
    ok(!r4.ok && /plain fetch → archive snapshot → vision/.test(r4.error) && /needs a human/.test(r4.error), 'total failure names every door tried before conceding');

    // 5) a thin shell "success" is not a read
    const r5 = await FE.escalatedRead('https://x.gov/roster', {
      fetchPage: async () => ({ ok: true, text: 'Loading…' }),
      seePage: async () => ({ ok: true, text: LONG }),
    });
    ok(r5.ok && r5.via === 'vision', 'a shell page (thin text) falls through — length is the read bar');

    // 6) preferDoor: a host whose map says vision worked leads with vision — studying the process
    const seq = [];
    const r6 = await FE.escalatedRead('https://x.gov/roster', {
      fetchPage: async () => { seq.push('fetch'); return { ok: false }; },
      seePage: async () => { seq.push('vision'); return { ok: true, text: LONG }; },
      preferDoor: 'vision',
      onAccess: (door, ok) => seq.push(`${door}:${ok}`),
    });
    ok(r6.ok && r6.via === 'vision' && seq[0] === 'vision' && seq[1] === 'vision:true', 'preferDoor leads with the learned door and onAccess records the outcome');

    // 7) the TOOL_SPEC teaches the interaction tools + the escalation (schema-line law)
    ok(/web_click \{"handle"/.test(OP.TOOL_SPEC) && /web_type \{"handle"/.test(OP.TOOL_SPEC) && /page_back \{\}/.test(OP.TOOL_SPEC),
      'TOOL_SPEC carries web_click / web_type / page_back — the model can only use what the spec shows');
    ok(/AUTO-ESCALATES/.test(OP.TOOL_SPEC) && /do NOT give up on a source/.test(OP.TOOL_SPEC),
      'TOOL_SPEC teaches the escalation — a walled first open is not the end');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  }
  console.log(`\nPASS — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
