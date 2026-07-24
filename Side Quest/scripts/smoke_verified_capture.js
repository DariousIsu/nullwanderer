/* Smoke: lib/learning CAPTURE (Accrete) — deterministic, injected extract+store.
 * Proves: provenance gate (URL required) + thin gate; the claim gate rejects hedged/pronoun lines;
 * a substantive read banks claims with NO interrogative-query gate; DATED claims → verified_fact,
 * UNDATED → learning; multiple distinct facts about ONE subject all accrue (no subject dedup for
 * learnings); an identical claim already live is skipped (replay); the GROUNDING GATE — a claim or
 * recovered answer whose anchors (numbers, proper nouns) are absent from the read text never banks
 * (the fusion-confabulation fix: an invented statute number can't ride a real URL into the DB).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_verified_capture.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_vcap_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const learning = require('C:/Users/azrae/Desktop/Side Quest/lib/learning');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
// > MIN_CONTENT_LEN, and it STATES the mock claims' anchors (Tampa Bay, April) — extraction claims
// are restatements of the text, and the grounding gate holds the smoke to the same honesty.
const LONG = 'Florida Top Dog is a cheer team based in Tampa Bay; the squad holds tryouts in April and ranked #2 nationally in 2026. '.repeat(4);

(async () => {
  try {
    db.init();

    // --- pure unit: slug + claim gate (dated vs undated, hedge, distinct-subject) -----------
    ok(learning.slugify('Florida Top Dog All-Stars') === 'florida-top-dog-all-stars', 'slugify makes a stable key');
    const parsed = learning.parseClaims(
      [
        'The team ranked #2 nationally. | national ranking | 2026',           // dated
        'The team is based in Tampa Bay. | Florida Top Dog | UNKNOWN',        // undated, subject A
        'The team holds tryouts in April. | Florida Top Dog | UNKNOWN',       // undated, SAME subject — must still keep
        'It might be the best team ever. | Florida Top Dog | UNKNOWN',        // hedge + pronoun → reject
        'NONE'
      ].join('\n'),
      { url: 'https://src' }
    );
    ok(parsed.length === 3, 'claim gate keeps 3 clean claims (hedge/pronoun rejected), incl. two SAME-subject');
    ok(parsed[0].asOf === '2026' && parsed[1].asOf === null, 'dated claim carries as_of; undated → null');

    // --- gates on the hook ------------------------------------------------------------------
    const noUrl = await learning.maybeCaptureLearnings({ query: 'anything', content: LONG, urls: null, deps: { skipThrottle: true } });
    ok(noUrl.skipped === 'no-url', 'provenance gate: no URL → skipped');
    const thin = await learning.maybeCaptureLearnings({ query: 'anything', content: 'short', urls: ['https://x'], deps: { skipThrottle: true } });
    ok(thin.skipped === 'thin', 'thin content → skipped');

    // --- a clean capture from a NON-interrogative research read (the cheer-team case) --------
    const stored = [];
    const extract = async () => [
      'The team ranked #2 nationally. | national ranking | 2026',
      'The team is based in Tampa Bay. | Florida Top Dog | UNKNOWN',
      'The team holds tryouts in April. | Florida Top Dog | UNKNOWN'
    ].join('\n');
    const cap = await learning.maybeCaptureLearnings({
      query: 'Florida Top Dog All-Stars program details', content: LONG, urls: ['https://src/team'],
      deps: { skipThrottle: true, extract, storeFn: async (rec) => { stored.push(rec); return { id: stored.length }; } }
    });
    ok(cap.captured === 3, 'non-interrogative read still banks (no fact-query gate) — 3 captured');
    ok(cap.verified === 1 && cap.learned === 2, 'dated→verified_fact (1), undated→learning (2)');
    const v = stored.find(r => r.source === 'verified_fact');
    const ls = stored.filter(r => r.source === 'learning');
    ok(v && v.importance === learning.VERIFIED_IMPORTANCE && v.provenance.dated === true && v.provenance.as_of === '2026', 'verified_fact: high importance, dated, as_of from source');
    ok(ls.length === 2 && ls.every(r => r.importance === learning.LEARNING_IMPORTANCE && r.provenance.dated === false), 'learnings: lower importance, undated');
    ok(ls[0].provenance.subject_key === ls[1].provenance.subject_key, 'two learnings share a subject_key — and BOTH were kept (accumulation, not subject-dedup)');

    // --- replay dedup: an identical claim already live is skipped ----------------------------
    db.insertKnowledge({ kind: 'note', content: 'The team is based in Tampa Bay.', source: 'learning', importance: 0.6, embedding: null, provenance: { subject_key: 'florida-top-dog', as_of: '2026-06-27' } });
    const stored2 = [];
    const replay = await learning.maybeCaptureLearnings({
      query: 'Florida Top Dog All-Stars', content: LONG, urls: ['https://src/team'],
      deps: { skipThrottle: true, storeFn: async (rec) => { stored2.push(rec); return { id: 1 }; },
        extract: async () => 'The team is based in Tampa Bay. | Florida Top Dog | UNKNOWN' }
    });
    ok(replay.captured === 0 && stored2.length === 0, 'identical claim already live → skipped (no re-bank)');

    // --- GROUNDING GATE (boot47 root cause #3: the fusion-confabulation fix) ------------------
    // A true headline wrapped in invented specifics (wrong statute, invented HTS code) was banked as a
    // verified_fact with a real URL stamped on — the write-back manufactured provenance. The gate: a
    // claim banked against a source must restate the source's ANCHORS (numbers + proper nouns).
    const SRC338 = 'President Trump announced 50% tariffs on Canadian goods under Section 338 of the Trade Act of 1930, citing discrimination against U.S. commerce. '.repeat(2);
    const gBad = learning.groundedInSource('Trump imposed the tariffs under Section 301 covering HTS code 1202.', SRC338);
    ok(gBad.checked && !gBad.grounded && gBad.missing.includes('301') && gBad.missing.includes('1202'), 'grounding: invented statute + HTS code → NOT grounded (the confabulation shape is caught)');
    const gPara = learning.groundedInSource('Trump hit Canada with 50% tariffs under Section 338 of the Trade Act.', SRC338);
    ok(gPara.checked && gPara.grounded && gPara.missing.length <= 1, 'grounding: faithful paraphrase survives (≥70% of anchors found; "Canada" vs "Canadian" tolerated)');
    ok(learning.groundedInSource('Anything At All 999', 'tiny').checked === false, 'grounding: source too thin to judge → uncheckable (no false block)');
    ok(learning.groundedInSource('the sky is blue today.', SRC338).grounded === true, 'grounding: a claim with no anchors passes vacuously');
    const SRCDATE = 'The measure took effect on July 21, 2026, according to the published notice in the register. '.repeat(3);
    const gIso = learning.groundedInSource('The rule took effect on 2026-07-21.', SRCDATE);
    ok(gIso.grounded === true, 'grounding: ISO date vs prose date tolerated (zero-padded month fragment never demanded)');

    // captureRecovered: an ungrounded fused answer is BLOCKED — nothing banked, no supersede fired
    const recB = [];
    const wbBlocked = await learning.captureRecovered({ query: 'latest tariff action', answer: 'Trump imposed the tariffs under Section 301 covering HTS code 1202.', url: 'https://x/tariffs', content: SRC338, source: 'excavation', now: Date.parse('2026-07-02T12:00:00-04:00'), storeFn: async (r) => { recB.push(r); return { id: 9 }; } });
    ok(wbBlocked.skipped === 'ungrounded' && recB.length === 0 && wbBlocked.missing.includes('301'), 'captureRecovered: fused answer with invented specifics → BLOCKED (skipped=ungrounded, nothing stored)');
    // …and a faithful recovery still banks when the source text rides along
    const recG = [];
    const wbGood = await learning.captureRecovered({ query: 'current tariff statute', answer: 'Trump hit Canada with 50% tariffs under Section 338 of the Trade Act.', url: 'https://x/tariffs', content: SRC338, source: 'excavation', now: Date.parse('2026-07-02T12:00:00-04:00'), storeFn: async (r) => { recG.push(r); return { id: 10 }; } });
    ok(wbGood.captured === 1 && recG.length === 1 && recG[0].source === 'verified_fact', 'captureRecovered: grounded answer + source text → banks as before');
    // (backward compat — the earlier captureRecovered tests pass NO content and still bank: uncheckable → prior behavior)

    // maybeCaptureLearnings: an extracted "claim" whose anchors are absent from the TEXT was invented,
    // not extracted → dropped; the genuinely-stated claim still banks
    const stored3 = [];
    const capMix = await learning.maybeCaptureLearnings({
      query: 'Florida Top Dog All-Stars', content: LONG, urls: ['https://src/team'],
      deps: { skipThrottle: true, storeFn: async (rec2) => { stored3.push(rec2); return { id: 1 }; },
        extract: async () => [
          'The team holds tryouts in April. | Florida Top Dog | UNKNOWN',
          'The program relocated to Orlando in 1999. | Florida Top Dog | 1999'
        ].join('\n') }
    });
    ok(capMix.captured === 1 && capMix.dropped_ungrounded === 1 && stored3.length === 1 && /April/.test(stored3[0].content), 'extraction grounding: invented claim (Orlando/1999 not in text) dropped; stated claim banks');

    // R8 — identity seed: canonical facts stored as high-importance verified_facts, idempotent
    const idStored = [];
    const seed1 = await learning.seedIdentityFacts({ storeFn: async (rec) => { idStored.push(rec); return { id: idStored.length }; } });
    ok(seed1.added === 2, 'seeds 2 canonical identity facts');
    const nameRec = idStored.find(r => r.provenance.subject_key === 'zoe-name-origin');
    ok(nameRec && /Zoe Barnes/.test(nameRec.content) && /Lois Lane/.test(nameRec.content) && nameRec.source === 'verified_fact' && nameRec.importance === 0.95, 'name-origin fact: Zoe Barnes + Lois Lane, verified_fact, high importance');
    // idempotent: one already live → only the other is added
    db.insertKnowledge({ kind: 'note', content: 'name origin', source: 'verified_fact', importance: 0.95, embedding: null, provenance: { subject_key: 'zoe-name-origin' } });
    const seed2 = await learning.seedIdentityFacts({ storeFn: async () => ({ id: 1 }) });
    ok(seed2.added === 1, 'idempotent — skips the already-seeded identity fact');

    // SELF-HEAL write-back — an externally RECOVERED answer (forensic excavation) → banked as a dated
    // verified_fact so she's never on the same page twice. Direct store (no claim-extraction).
    const rec = [];
    const wb = await learning.captureRecovered({ query: 'who is the current US Secretary of Defense', answer: 'Pete Hegseth is the current U.S. Secretary of Defense.', url: 'https://en.wikipedia.org/wiki/United_States_Secretary_of_Defense', source: 'excavation', now: Date.parse('2026-07-02T12:00:00-04:00'), storeFn: async (r) => { rec.push(r); return { id: 1 }; } });   // noon Eastern — a bare date is UTC midnight = the previous Eastern day
    ok(wb.captured === 1 && rec.length === 1, 'captureRecovered banks the recovered answer');
    ok(rec[0].source === 'verified_fact' && rec[0].provenance.dated === true && rec[0].provenance.as_of === '2026-07-02', 'banked as a DATED verified_fact (as_of=today) → reconcile can supersede stale');
    ok(rec[0].provenance.url === 'https://en.wikipedia.org/wiki/United_States_Secretary_of_Defense' && rec[0].provenance.capturedBy === 'excavation' && /Hegseth/.test(rec[0].content), 'carries source URL + capturedBy=excavation + the answer');
    ok((await learning.captureRecovered({ query: 'x', answer: 'y', url: null, storeFn: async () => ({}) })).skipped === 'incomplete', 'no URL → skipped (provenance gate)');

    // RECONCILE-AWARE recovery (research adapter, §7): a recovered fact that CONTRADICTS a held verified_fact
    // SUPERSEDES it and RETIRES the stale one (the correction sticks) — not a naive re-bank.
    db.insertKnowledge({ kind: 'note', content: 'Lloyd Austin is the current US Secretary of Defense.', source: 'verified_fact', importance: 0.9, embedding: null, provenance: { subject_key: 'who-is-the-current-us-secretary-of-defense', as_of: '2025-01-01', capturedBy: 'wiki' } });
    const recS = [];
    const supS = await learning.captureRecovered({ query: 'who is the current US Secretary of Defense', answer: 'Pete Hegseth is the current US Secretary of Defense.', url: 'https://en.wikipedia.org/wiki/x', source: 'excavation', now: Date.parse('2026-07-02'), storeFn: async (r) => { recS.push(r); return { id: 99 }; } });
    ok(supS.action === 'supersede' && supS.captured === 1, 'captureRecovered: contradicting recovery vs a held belief → SUPERSEDE (reconcile-aware, not a naive re-bank)');
    const austin = db.getDb().prepare("SELECT importance, provenance FROM knowledge WHERE content LIKE 'Lloyd Austin%'").get();
    const ap = (() => { try { return JSON.parse(austin.provenance); } catch { return {}; } })();
    ok(austin.importance <= 0.2 && ap.superseded === true, 'captureRecovered supersede → the stale verified_fact is RETIRED (demoted + tagged superseded) — the correction sticks');
    ok(learning.verifiedFactBySlot('who-is-the-current-us-secretary-of-defense') === null, 'verifiedFactBySlot: skips the now-retired record (slot empty)');

    // no incumbent → the recovered fact banks as NEW (unchanged behavior for the common path)
    const recN = [];
    const newR = await learning.captureRecovered({ query: 'who founded Acme Corp', answer: 'Jane Doe founded Acme Corp.', url: 'https://acme.com/about', source: 'wiki', now: Date.parse('2026-07-02'), storeFn: async (r) => { recN.push(r); return { id: 5 }; } });
    ok(newR.action === 'new' && newR.captured === 1 && recN[0].source === 'verified_fact', 'captureRecovered: no incumbent → NEW verified_fact (backward-compatible)');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
