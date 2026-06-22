/** Smoke for the two audit fixes:
 *  F2 — anti-fixation thought drop (diversifySeeds detects the Otter-style loop; the drop
 *       predicate fires unless Lucas's latest message is on that anchor).
 *  F1 — ECHO_INVOKE_RE binds "use the db / power suit / our records / LAMP" to the echo nudge,
 *       without firing on casual chat. (Regex mirrored from main.js.) */
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_af_${Date.now()}`, 'sq.db');
require('../lib/db').init();
const mono = require('../lib/monologue');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

// ---- F2: fixation detection + drop predicate (mirrors the runOneTick gate) ----
const otterThoughts = [
  { content: "Lucas's comment about Otter AI's forced meeting emails stuck with me." },
  { content: "Otter AI and its automated emails are a broader pattern in automation." },
  { content: "The Otter automation forced on participants is an interesting professional norm." },
  { content: "Otter's marketing ploys and forced emails keep nagging at me." },
  { content: "Otter AI again — the forced-email automation and what it says about norms." },
];
function dropPredicate(trimmed, recentThoughts, lastUserContent) {
  const fix = mono.diversifySeeds(recentThoughts, { window: 6, domFrac: 0.6 });
  if (!(fix.monoFixated && fix.anchor)) return { drop: false, fix };
  const anchorRe = new RegExp(`\\b${fix.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const userOnAnchor = !!(lastUserContent && anchorRe.test(lastUserContent));
  return { drop: anchorRe.test(trimmed) && !userOnAnchor, fix };
}

const det = mono.diversifySeeds(otterThoughts, { window: 6, domFrac: 0.6 });
ok(`detects the Otter fixation (anchor="${det.anchor}")`, det.monoFixated && /otter/i.test(det.anchor || ''));

let r = dropPredicate("Still turning over Otter AI's forced emails and automation.", otterThoughts, "Look up how many members of LAMP, use the db");
ok('DROPS a new Otter thought when Lucas has moved on (LAMP/db)', r.drop === true);

r = dropPredicate("Still turning over Otter AI's forced emails.", otterThoughts, "otter ai is such a marketing ploy lol");
ok('KEEPS it when Lucas is actively talking Otter (live processing)', r.drop === false);

r = dropPredicate("Let me sketch the speaker short-list for the energy event.", otterThoughts, "Look up LAMP, use the db");
ok('KEEPS a genuinely different thought (anchor not present → topic change)', r.drop === false);

r = dropPredicate("thinking about otter", [{ content: 'a' }, { content: 'b' }], "hi");
ok('does NOT drop when there is no fixation (sparse, varied thoughts)', r.drop === false);

// ---- F1: ECHO_INVOKE_RE (mirrored from main.js) ----
const ECHO_INVOKE_RE = /\b(the\s+)?(power\s*)?suit\b|\becho\b|\b(use|search|query|check|look\s*up\s+in|pull\s+from)\b[^.?!]{0,30}\b(the\s+)?(db|database|knowledge\s*base|kb|graph|kg|our\s+(records|data|kb|knowledge|graph|contacts|bills))\b|\bthe\s+db\b|\bour\s+(records|knowledge\s*base|kb|graph|database)\b|\blamp\b/i;
console.log('\nF1 — ECHO_INVOKE_RE:');
ok('"...use the db" → fires', ECHO_INVOKE_RE.test('Look up how many members of LAMP there are, use the db'));
ok('"with the power suit on" → fires', ECHO_INVOKE_RE.test('do an inventory of your tools with the power suit on'));
ok('"search our knowledge base" → fires', ECHO_INVOKE_RE.test('can you search our knowledge base for the FERC rule'));
ok('"look up X in our graph" → fires', ECHO_INVOKE_RE.test('look up Duke Energy in our graph'));
ok('bare "LAMP" → fires', ECHO_INVOKE_RE.test('how many people are in LAMP'));
ok('"how are you?" → does NOT fire', !ECHO_INVOKE_RE.test('how are you today?'));
ok('"tell me about your day" → does NOT fire', !ECHO_INVOKE_RE.test('tell me about your day'));
ok('"what do you think of the data" → does NOT fire (bare data)', !ECHO_INVOKE_RE.test('what do you think of the data'));

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ` - ${pass} passed, ${fail} failed`);
try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
