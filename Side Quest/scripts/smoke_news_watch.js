/* Smoke: lib/news_watch — the deterministic watchlist matcher (design §"Mode 1 — WATCH"). Proves the
 * pure match semantics (keyword/phrase/concept), idempotent term add, the hourly feed, item matching +
 * hit recording, and active/deactivate. ISOLATED temp DB. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_watch.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_newswatch_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const w = require('../lib/news_watch');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- termMatches (PURE) ---
ok(w.termMatches('Kyiv', 'keyword', 'At least 18 killed in Kyiv attack') === true, 'keyword matches whole word');
ok(w.termMatches('Kyiv', 'keyword', 'Kyivstar telecom outage') === false, 'keyword does NOT match inside a larger word (boundary)');
ok(w.termMatches('End EPA Abuse Act', 'phrase', 'Mike Lee introduced the End EPA Abuse Act today') === true, 'phrase matches contiguous substring');
ok(w.termMatches('End EPA Abuse Act', 'phrase', 'End of the EPA Abuse Act') === false, 'phrase requires contiguity');
ok(w.termMatches('crypto Trump finances', 'concept', 'Questions about his finances: Trump crypto business boomed') === true, 'concept matches all significant words, any order');
ok(w.termMatches('crypto Trump finances', 'concept', 'Trump gave a speech about crypto') === false, 'concept fails when a significant word is missing');
ok(w.termMatches('anything', 'keyword', '') === false && w.termMatches('', 'keyword', 'x') === false, 'empty text/term → no match (no throw)');

// --- add / idempotency / reactivate ---
const A = w.addTerm({ term: 'Mike Lee', kind: 'phrase', origin: 'conversation' });
ok(A.added === true && A.id, 'addTerm adds a new term');
const A2 = w.addTerm({ term: 'mike   lee', kind: 'phrase' });   // normalized dup
ok(A2.added === false && A2.id === A.id, 'addTerm is idempotent on normalized term_key');
ok(w.addTerm({ term: '  ' }).added === false, 'empty term rejected');

// --- hourly feed ---
const F = w.feedTerm('gas station heroin');
ok(F.id && w.activeTerms().some(t => t.term === 'gas station heroin' && t.origin === 'hourly'), 'feedTerm adds an hourly-origin concept term');

// --- active list + deactivate (2 distinct terms so far: "Mike Lee", "gas station heroin") ---
ok(w.activeTerms().length === 2, 'two active terms');
ok(w.deactivate('Mike Lee') === true && w.activeTerms().length === 1, 'deactivate drops a term from the active set');
w.addTerm({ term: 'Mike Lee', kind: 'phrase' });   // re-seeing reactivates
ok(w.activeTerms().length === 2, 'adding an existing term reactivates it');

// --- matchItem + hit recording ---
const item = { title: 'Mike Lee and the End EPA Abuse Act', summary: 'A new crackdown on gas station heroin was also discussed.' };
const hits = w.matchItem(item);
const terms = hits.map(h => h.term).sort();
ok(terms.includes('mike lee') && terms.includes('gas station heroin'), 'matchItem returns all matching terms');
const mikeRow = w.activeTerms().find(t => t.term === 'mike lee');
ok(mikeRow.hits === 1 && mikeRow.last_hit_ts, 'matchItem records a hit (count + last_hit_ts)');
const noHits = w.matchItem({ title: 'Unrelated weather story', summary: 'sunny' });
ok(noHits.length === 0, 'a non-matching item yields no hits');
const peek = w.matchItem(item, { record: false });
const mikeRow2 = w.activeTerms().find(t => t.term === 'mike lee');
ok(peek.length >= 1 && mikeRow2.hits === 1, 'matchItem {record:false} matches without bumping the counter');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
