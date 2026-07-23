/* smoke_convo_tier.js — the ladder can finally search OUR OWN CONVERSATION.
 *
 * Live 2026-07-20:
 *   Lucas: "something you said, about what you would look like with a body"
 *   Zoe:   "I checked our records and searched, but I couldn't pin down previous statements by the
 *           AI regarding its physical appearance or desired body."
 * She held it — a June turn described exactly that, and four minutes later she recognised the photo
 * as "just as I described". The ladder ran graph→wiki→routed→web→excavate: the civic knowledge
 * graph, Wikipedia and the open web. None of those contain her own conversations.
 *
 * Two defects, both fixed here:
 *   1. no CONVERSATION tier existed in the ladder at all
 *   2. retrieveTurns scanned only the newest 400 embedded turns, of 3,564 — the June row was ~2,000
 *      turns outside the window, so even a direct call would have missed it
 *
 * Offline: retrieveTurns is injected.
 */
'use strict';
const cognition = require('../lib/cognition');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

(async () => {
  // ── the tier reads turns and labels who said what ──────────────────────────────────────────────
  {
    let sawOpts = null;
    const deps = {
      retrieveTurns: async (q, o) => { sawOpts = o; return [
        { id: 10, speaker: 'ai_said', content: 'If I had a body I picture red shoulder-length hair, a black button-up shirt.' },
        { id: 11, speaker: 'user', content: 'That matches the photo I found.' },
      ]; },
    };
    const r = await cognition._enrichConvo('what she said about her appearance', deps);
    ok(/From our own past conversation/.test(r.text), 'the tier labels its grounding as OUR conversation');
    ok(/You said: If I had a body/.test(r.text), 'her own turn is attributed to HER');
    ok(/Lucas said: That matches/.test(r.text), "and Lucas's turn to HIM — attribution is the point of this tier");
    ok(r.url === null, 'no URL — this is memory, not a source to cite');

    // ⭐ the scan must reach past the recency window, or the tier is decorative
    ok(sawOpts && sawOpts.scan > 400, `scans deeper than the 400 default (got ${sawOpts && sawOpts.scan})`);
    ok(sawOpts && sawOpts.k >= 3, 'pulls several turns, not one');
  }

  // ── no hits / failure → empty, never a throw ───────────────────────────────────────────────────
  {
    const empty = await cognition._enrichConvo('x', { retrieveTurns: async () => [] });
    ok(empty.text === '', 'no hits → empty, so the ladder moves on');
    const threw = await cognition._enrichConvo('x', { retrieveTurns: async () => { throw new Error('embedder down'); } });
    ok(threw.text === '', 'a failing embedder cannot break the turn');
  }

  // ── ⭐ LADDER ORDER: cheapest + most-ours first, but never ahead of a CURRENT fact ──────────────
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cognition.js'), 'utf8');
    const m = src.match(/(?:const|let) _modes = ([\s\S]{0,400}?);/);
    ok(!!m, 'found the ladder definition');
    const modes = m ? m[1] : '';
    const office = modes.match(/'office_holder' \? \[([^\]]*)\]/);
    const fresh = modes.match(/needs_fresh \? \[([^\]]*)\]/);
    const dflt = modes.match(/:\s*\[([^\]]*)\];?\s*$/m) || modes.match(/\[([^\]]*)\]\s*$/);
    ok(office && !/convo/.test(office[1]),
      'convo is ABSENT from the office-holder ladder — a stale remark must not answer "who is president now"');
    ok(fresh && /convo/.test(fresh[1]) && fresh[1].indexOf('convo') > fresh[1].indexOf('wiki'),
      'on a fresh-fact question convo comes AFTER the external tiers');
    ok(dflt && /^\s*'convo'/.test(dflt[1]),
      'on a normal question convo LEADS — cheapest tier, no network, and the most relevant source');
    ok(/mode === 'convo' \? await _enrichConvo/.test(src), 'the tier is dispatched, not just declared');
  }

  // ── the scan window itself ─────────────────────────────────────────────────────────────────────
  {
    const fs = require('fs'), path = require('path');
    const mem = fs.readFileSync(path.join(__dirname, '..', 'lib', 'memory.js'), 'utf8');
    ok(/scan = 400 \} = \{\}\)/.test(mem), 'retrieveTurns takes a scan depth (default unchanged for existing callers)');
    ok(/db\.getEmbeddedTurns\(scan\)/.test(mem), 'REGRESSION: the scan depth is USED, not ignored');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
