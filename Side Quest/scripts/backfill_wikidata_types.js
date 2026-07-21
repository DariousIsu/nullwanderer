/* scripts/backfill_wikidata_types.js — resolve QIDs against Wikidata and record type CLAIMS.
 *
 * The last rung of the ladder Lucas asked about (§2a-ii step 1): "if its just program run can we
 * validate with a cloud call?" — for these rows the answer turned out to be better than a cloud call.
 * Wikidata is an authoritative register with a public API, so 370 rows get typed for the cost of eight
 * HTTP requests and no model tokens at all.
 *
 * lib/id_scheme_type.js refuses QIDs precisely because a QID says nothing about kind on its own
 * (Q1264404 is a utility, Q34296 is a president). This is the lookup that answers it, via P31
 * ("instance of"), mapped by lib/wikidata_type.js.
 *
 * ── IT RECORDS CLAIMS, NOT COLUMNS ──────────────────────────────────────────────────────────────
 *
 * Like every other source, Wikidata competes on T3's ladder rather than overwriting it, and
 * scripts/migrate_entity_types.js applies whatever wins. Authority is `official`: Wikidata is a curated
 * register, and its P31 is the kind of structured assertion this system was built to grade. But it is
 * one source — all of these claims share an origin, so they corroborate nothing but themselves.
 *
 * NETWORK. Batches of 50, sequential, with a real User-Agent per Wikimedia's policy.
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_wikidata_types.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const https = require('https');
const db = require('../lib/db');
const ot = require('../lib/object_type');
const wt = require('../lib/wikidata_type');
const mt = require('../lib/mint_type');
const { parseEntity } = require('../lib/entity_match');

db.init();
const APPLY = process.argv.includes('--apply');

// BE A POLITE CLIENT. Running the probe and two dry runs back to back earned a "You are making too many
// requests to the API" from Wikimedia — which arrives as plain text, so it also blows up JSON.parse and
// looks like a parse bug rather than what it is. A pause between batches and a single backoff retry.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_MS = 1200;

const getOnce = (url) => new Promise((res, rej) => {
  https.get(url, { headers: { 'User-Agent': 'SideQuest/1.0 (civic research; contact via repo owner)' } }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => {
      if (/^\s*You are making too many requests/i.test(b)) return rej(new Error('rate limited'));
      let j;
      try { j = JSON.parse(b); } catch { return rej(new Error(`unparseable response (${r.statusCode}): ${b.slice(0, 80)}`)); }
      // A rate limit also arrives as well-formed JSON with an `error` and NO `entities`. Parsed
      // blindly that looks like "the API returned nothing for these 50", which is how 250 QIDs got
      // reported as unreturned instead of as throttled. An error is an error, not an empty result.
      if (j && j.error) return rej(new Error(`api error: ${j.error.code || ''} ${String(j.error.info || '').slice(0, 90)}`));
      res(j);
    });
  }).on('error', rej);
});

async function get(url) {
  try { return await getOnce(url); } catch (e) {
    if (!/rate limited/.test(e.message)) throw e;
    await sleep(15000);                       // one backoff, then give up rather than hammer
    return getOnce(url);
  }
}

(async () => {
  console.log(`\nWIKIDATA TYPE CLAIMS — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);

  // Only rows still on a placeholder: a row already typed by better evidence is not this pass's business.
  const rows = db.getDb().prepare('SELECT id, name, entity_type FROM graph_entities').all()
    .filter((e) => mt.isPlaceholder(e.entity_type));
  const byQid = new Map();
  for (const e of rows) {
    const q = (parseEntity({ name: e.name }).ids || {}).wikidata;
    if (!q) continue;
    if (!byQid.has(q)) byQid.set(q, []);
    byQid.get(q).push(e);
  }
  const qids = [...byQid.keys()];
  console.log(`placeholder rows            ${rows.length}`);
  console.log(`carrying a QID              ${[...byQid.values()].reduce((n, v) => n + v.length, 0)}  (${qids.length} distinct)`);

  const build = [];
  const refused = {};
  const unmappedSamples = [];
  let fetched = 0;
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    let j;
    try { j = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('%7C')}&props=claims&format=json`); } catch (err) {
      console.error(`  batch ${i} failed: ${err.message} — skipped, not guessed`);
      refused['fetch failed'] = (refused['fetch failed'] || 0) + batch.length;
      continue;
    }
    fetched += batch.length;
    // EVERY REQUESTED QID MUST LAND IN EXACTLY ONE BUCKET. The first cut reported 116 claims and 4
    // refusals out of 370 — 250 rows silently vanished, because a QID the API answers under a different
    // key (a redirect) hit `byQid.get(q) || []` and was counted as neither. A report that does not add
    // up is worse than no report: it reads as "we looked at 370" when we looked at 120.
    const seen = new Set();
    for (const [q, ent] of Object.entries(j.entities || {})) {
      const owners = byQid.get(q) || [];
      if (!owners.length) { refused['API answered under a different QID (redirect) — unmatched'] = (refused['API answered under a different QID (redirect) — unmatched'] || 0) + 1; continue; }
      seen.add(q);
      if (ent.missing !== undefined) { refused['QID does not exist on Wikidata'] = (refused['QID does not exist on Wikidata'] || 0) + 1; continue; }
      const p31 = (ent.claims && ent.claims.P31 || [])
        .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id).filter(Boolean);
      const r = wt.typeFromP31(p31);
      if (!r) {
        const k = p31.length ? 'P31 class not in the map — held' : 'no P31 on the entity';
        refused[k] = (refused[k] || 0) + 1;
        if (p31.length && unmappedSamples.length < 10) unmappedSamples.push(`${q}  P31=${p31.join(',')}  (${owners[0].name.slice(0, 40)})`);
        continue;
      }
      if (!r.type) { refused[r.why] = (refused[r.why] || 0) + 1; continue; }
      for (const e of owners) {
        build.push({
          label: e.name,
          type: r.type,
          sourceKind: 'register',
          sourceRef: `wikidata:${q}`,
          origin: `https://www.wikidata.org/wiki/${q}`,
          originHost: 'wikidata.org',
          contentHash: `wd:${q}:${r.type}`,
          authority: 'official',
        });
      }
    }
    for (const q of batch) if (!seen.has(q)) { refused['requested but never returned by the API'] = (refused['requested but never returned by the API'] || 0) + 1; }
    process.stderr.write('.');
    if (i + 50 < qids.length) await sleep(RATE_MS);
  }

  const byType = {};
  for (const b of build) byType[b.type] = (byType[b.type] || 0) + 1;
  console.log(`\nQIDs fetched                ${fetched}`);
  console.log(`claims to record            ${build.length}`);
  console.log(`  by type                   ${JSON.stringify(byType)}`);
  console.log(`\nnot claimed (held, never guessed):`);
  for (const [k, v] of Object.entries(refused).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

  // The books must balance, and it says so out loud rather than leaving it to be noticed.
  const claimedQids = new Set(build.map((b) => b.sourceRef.replace('wikidata:', ''))).size;
  const accounted = claimedQids + Object.values(refused).reduce((a, b) => a + b, 0);
  console.log(`\naccounting: ${claimedQids} claimed + ${accounted - claimedQids} refused = ${accounted} of ${qids.length} requested`
    + `  ${accounted === qids.length ? '(balances)' : '← DOES NOT BALANCE'}`);
  if (unmappedSamples.length) {
    console.log(`\nunmapped P31 classes — each is a deliberate decision to add, not a bug:`);
    for (const s of unmappedSamples) console.log(`   ${s}`);
  }

  if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

  const res = ot.recordMany(build);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`APPLIED — ${res.added} new, ${res.alreadyKnown} already on file (idempotent), ${res.refused} refused.`);
  console.log(`\nSpot-check:`);
  for (const b of build.slice(0, 6)) {
    const t = ot.typeOf(b.label);
    console.log(`  ${String(b.label).slice(0, 42).padEnd(44)} → ${String(t.type).padEnd(15)} ${t.grade} ×${t.sources} ${t.settled ? 'settled' : 'UNSETTLED'}${t.contested ? ' CONTESTED' : ''}`);
  }
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
