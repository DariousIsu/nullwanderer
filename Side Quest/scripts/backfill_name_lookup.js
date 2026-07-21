/* scripts/backfill_name_lookup.js — catalogue the UNKNOWNS by looking each name up.
 *
 * The missing piece. T5 mints `unknown` when no source has said what a thing is, which is honest but
 * inert: `J. P. Morgan & Co.` and `Telemundo` sit unresolved forever because the corpus never typed
 * them. This asks an authoritative register instead of waiting for a document to arrive.
 *
 * Resolution is by ENGLISH WIKIPEDIA TITLE, not by search. An exact title match is strict by nature and
 * batches 50 at a time, so the whole placeholder population costs a few hundred requests and no model
 * tokens. Fuzzy search would be cheaper to write and would guess.
 *
 * ── THE OSCEOLA PROBLEM, WHICH IS THE WHOLE DIFFICULTY ──────────────────────────────────────────
 *
 * "Osceola" resolves to Q335165 — P31 Q5, human, the Seminole leader. In THIS corpus, built on Florida
 * and Georgia civic documents, "Osceola" is almost certainly Osceola COUNTY. Wikipedia's bare title
 * binds to the globally famous referent, which is not the locally relevant one, and a confident wrong
 * type is worse than no type. (It is the same "which Trump" salience problem already on file.)
 *
 * Two guards, both cheap and both grounded in Wikipedia's own structure:
 *   THE TITLE IS A DISAMBIGUATION PAGE   P31 = Q4167410. "Mercury" is a list of things, not a thing.
 *   THE NAME HAS A DISAMBIGUATION SIBLING  "<name> (disambiguation)" exists → the name is contested,
 *                                          so the bare title is a default, not an identification.
 * Osceola is caught by the second and held. That is the case this pass exists to get right.
 *
 * ── AUTHORITY IS `ordinary`, NOT `official` ─────────────────────────────────────────────────────
 *
 * Wikidata is authoritative about the ENTITY. It is not authoritative about our binding of this NAME to
 * that entity — we inferred that from a string. A claim is only as strong as its weakest link, so these
 * grade below a document that actually says what the thing is, and a real source can overrule them.
 * That is the difference between this pass and the QID pass, where the identifier was given to us.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write. --limit N to bound a run.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_name_lookup.js [--apply] [--limit N]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const https = require('https');
const db = require('../lib/db');
const ot = require('../lib/object_type');
const wt = require('../lib/wikidata_type');
const mt = require('../lib/mint_type');

db.init();
const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? Number(process.argv[i + 1]) || 0 : 0; })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_MS = 1200;

const getOnce = (url) => new Promise((res, rej) => {
  https.get(url, { headers: { 'User-Agent': 'SideQuest/1.0 (civic research; contact via repo owner)' } }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => {
      if (/^\s*You are making too many requests/i.test(b)) return rej(new Error('rate limited'));
      let j; try { j = JSON.parse(b); } catch { return rej(new Error(`unparseable (${r.statusCode}): ${b.slice(0, 70)}`)); }
      if (j && j.error) return rej(new Error(`api error: ${j.error.code || ''} ${String(j.error.info || '').slice(0, 80)}`));
      res(j);
    });
  }).on('error', rej);
});
async function get(url) {
  try { return await getOnce(url); } catch (e) {
    if (!/rate limited/.test(e.message)) throw e;
    await sleep(15000); return getOnce(url);
  }
}
const titlesUrl = (titles, props) => 'https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles='
  + titles.map(encodeURIComponent).join('%7C') + `&props=${props}&format=json`;

(async () => {
  console.log(`\nNAME → REGISTER LOOKUP — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(80)}`);

  // Only rows nothing has typed, and only names worth asking about. A common noun that leaked into the
  // entity slot (`health`, `counties`) would resolve to a real Wikipedia article and produce a confident
  // type for a junk node — the same trap T4's guard holds back.
  const isCommonNoun = (n) => { const s = String(n || '').trim(); return !!s && s === s.toLowerCase() && !/[0-9[\]]/.test(s) && s.split(/\s+/).length <= 2; };
  let rows = db.getDb().prepare('SELECT id, name, entity_type FROM graph_entities').all()
    .filter((e) => mt.isPlaceholder(e.entity_type))
    .filter((e) => !mt.hasStrongId(e.name))               // a strong id is a better path — already run
    .filter((e) => !isCommonNoun(e.name))
    .filter((e) => !ot.typeOf(e.name).settled);           // already answered by evidence

  const total = rows.length;
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`untyped rows worth asking about   ${total}${LIMIT ? `  (this run: ${rows.length})` : ''}`);

  const byName = new Map();
  for (const e of rows) { const n = String(e.name).trim(); if (!byName.has(n)) byName.set(n, []); byName.get(n).push(e); }
  const names = [...byName.keys()];

  const build = []; const refused = {}; const accepted = [];
  const bump = (k) => { refused[k] = (refused[k] || 0) + 1; };

  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    let ents, dis;
    try {
      ents = await get(titlesUrl(batch, 'claims%7Csitelinks'));
      await sleep(RATE_MS);
      // GUARD 2: does "<name> (disambiguation)" exist? If so the bare title is a default, not an ID.
      dis = await get(titlesUrl(batch.map((n) => `${n} (disambiguation)`), 'sitelinks'));
    } catch (err) {
      console.error(`  batch ${i} failed: ${err.message} — skipped, not guessed`);
      for (const n of batch) { void n; bump('fetch failed'); }
      continue;
    }

    const ambiguous = new Set();
    for (const e of Object.values(dis.entities || {})) {
      const t = e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title;
      if (t) ambiguous.add(String(t).replace(/\s*\(disambiguation\)\s*$/i, '').trim().toLowerCase());
    }

    const seen = new Set();
    for (const e of Object.values(ents.entities || {})) {
      const title = e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title;
      if (!title) continue;                                  // a missing title comes back as id -1
      const owners = byName.get(title) || byName.get(batch.find((b) => b.toLowerCase() === String(title).toLowerCase()));
      if (!owners) { bump('resolved to a different title than requested'); continue; }
      seen.add(String(title).toLowerCase());

      if (ambiguous.has(String(title).toLowerCase())) { bump('name has a disambiguation page — held (the Osceola case)'); continue; }
      const p31 = (e.claims && e.claims.P31 || [])
        .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id).filter(Boolean);
      const r = wt.typeFromP31(p31);
      if (!r) { bump(p31.length ? 'P31 class not in the map — held' : 'no P31 on the entity'); continue; }
      if (!r.type) { bump(r.why); continue; }

      accepted.push({ name: title, type: r.type, qid: e.id });
      for (const o of owners) {
        build.push({
          label: o.name, type: r.type, sourceKind: 'register',
          sourceRef: `enwiki-title:${e.id}`,
          origin: `https://www.wikidata.org/wiki/${e.id}`,
          originHost: 'wikidata.org',
          contentHash: `enwiki:${e.id}:${r.type}`,
          // The register is authoritative about the entity; OUR name→entity binding is an inference.
          authority: 'ordinary',
        });
      }
    }
    for (const n of batch) if (!seen.has(n.toLowerCase())) bump('no English Wikipedia article under this exact title');
    process.stderr.write('.');
    if (i + 50 < names.length) await sleep(RATE_MS);
  }

  const byType = {};
  for (const b of build) byType[b.type] = (byType[b.type] || 0) + 1;
  console.log(`\ndistinct names asked              ${names.length}`);
  console.log(`claims to record                  ${build.length}   ${JSON.stringify(byType)}`);
  console.log(`\nnot claimed (held, never guessed):`);
  for (const [k, v] of Object.entries(refused).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);

  const accountedNames = accepted.length + Object.values(refused).reduce((a, b) => a + b, 0);
  console.log(`\naccounting: ${accepted.length} resolved + ${accountedNames - accepted.length} held = ${accountedNames} of ${names.length} asked`
    + `  ${accountedNames === names.length ? '(balances)' : '← DOES NOT BALANCE'}`);
  console.log(`\nsample of what resolved:`);
  for (const a of accepted.slice(0, 15)) console.log(`   ${String(a.name).slice(0, 40).padEnd(42)} ${a.qid.padEnd(11)} → ${a.type}`);

  if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

  const res = ot.recordMany(build);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`APPLIED — ${res.added} new, ${res.alreadyKnown} already on file, ${res.refused} refused.`);
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
