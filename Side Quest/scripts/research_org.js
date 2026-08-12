/* scripts/research_org.js — research an ORGANISATION by reading its own website.
 *
 * The missing lane, narrow slice. Lucas: *"why wouldn't these be researched by the program and then
 * properly linked?"* Because nothing could: the Puller's 271,334 targets are 100% `kind='person'`, so
 * `The Joseph Rainey Center for Public Policy` sat in a queue looking for its email address, and
 * raineycenter.org had never been fetched.
 *
 * This fetches the org's own site, PROVES the page is theirs, and lands it as a normal document with a
 * real origin. Everything after that is the existing pipeline — doc-decompose extracts the entities and
 * relations, now under V1's veto and V2's surface-form retention. Building a second extraction stack
 * beside a working one would be the actual mistake.
 *
 * ── NO DOMAIN GUESSING ──────────────────────────────────────────────────────────────────────────
 *
 * A URL must be ASSERTED by someone — the operator, or Wikidata P856 on a resolved QID. Guessing
 * "Rainey Center" → raineycenter.org manufactures an ORIGIN, and origin is what the whole grading model
 * rests on. The corpus already holds `alconacountyfair.com` (not the county) and `countynewscenter.com`
 * (not a county): a plausible hostname is provably not evidence.
 *
 * Usage:
 *   --name "<org>" --url <https://…>     research one org from an operator-supplied URL
 *   --qid Q12345 --name "<org>"          resolve the site from Wikidata P856, then research
 *   --apply                              actually write (default is a dry run)
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/research_org.js --name "…" --url … [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const https = require('https');
const db = require('../lib/db');
const orgSite = require('../lib/org_site');

db.init();
const argv = process.argv;
const arg = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const NAME = arg('--name');
const URL_IN = arg('--url');
const QID = arg('--qid');

if (!NAME) { console.error('need --name "<organisation>"'); process.exit(1); }

const get = (url, { json = false } = {}) => new Promise((res, rej) => {
  https.get(url, { headers: { 'User-Agent': 'SideQuest/1.0 (civic research; contact via repo owner)' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      return res(get(new URL(r.headers.location, url).toString(), { json }));
    }
    let b = ''; r.on('data', (c) => { b += c; });
    r.on('end', () => { if (json) { try { return res(JSON.parse(b)); } catch (e) { return rej(e); } } res({ status: r.statusCode, body: b, url }); });
  }).on('error', rej);
});

// Strip tags/scripts to readable text. Deliberately crude — this feeds the extractor, which reads prose.
function toText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

(async () => {
  console.log(`\nORG RESEARCH — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);
  console.log(`organisation: ${NAME}`);

  // 1. WHERE THE URL CAME FROM. Provenance decides admissibility, not plausibility.
  let accepted = null;
  if (URL_IN) accepted = orgSite.acceptUrl(URL_IN, 'operator');
  else if (QID) {
    const j = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(QID)}&props=claims&format=json`, { json: true });
    const ent = (j.entities || {})[QID];
    const site = ((ent && ent.claims && ent.claims.P856) || [])
      .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value).filter(Boolean)[0];
    if (site) accepted = orgSite.acceptUrl(site, 'register');
    console.log(`wikidata P856: ${site || '(none on this entity)'}`);
  }
  if (!accepted) {
    console.error(`\nREFUSED — no URL from an admissible source. Supply --url (operator) or --qid with a P856.`);
    console.error(`A guessed domain is not evidence: the corpus already contains alconacountyfair.com,`);
    console.error(`which is a county FAIR, not the county.`);
    process.exit(2);
  }
  console.log(`url         : ${accepted.url}  (provenance: ${accepted.provenance})`);

  // 2. FETCH.
  let page;
  try { page = await get(accepted.url); } catch (e) { console.error(`fetch failed: ${e.message} — nothing written`); process.exit(3); }
  const text = toText(page.body);
  console.log(`fetched     : HTTP ${page.status}, ${text.length} chars of text`);

  // 3. THE PAGE MUST PROVE IT IS THEIRS. Domains lapse, get parked, get resold.
  const v = orgSite.verifyPage(NAME, text, { url: accepted.url });
  console.log(`verify      : ${v.ok ? 'OK' : 'REFUSED'} — ${v.why}`);
  if (!v.ok) {
    console.error(`\nNot landed. An asserted URL is still only a claim until the page names the organisation.`);
    process.exit(4);
  }

  console.log(`\nfirst 220 chars: ${text.slice(0, 220)}`);
  if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

  // 4. LAND IT through doc_store.land (2026-08-12 review H6 family) — the SAME door the live org
  //    lane uses since 7990c4b, so the manual one-shot and the autonomous stage cannot drift apart:
  //    importance stamped (org_research=6, feeds C2/C3), content-dedup, hash + origin normalised.
  const inserted = require('../lib/doc_store').land({
    title: `${NAME} — official website`,
    body: text,
    source: 'org_research',
    ref: accepted.url,
    origin: accepted.url,
  });
  console.log(`\n${'='.repeat(78)}`);
  const id = inserted && inserted.id;
  if (!id) { console.error('insertDocument refused (empty body?) — nothing written'); process.exit(5); }
  const row = db.getDocument(id) || {};
  console.log(`LANDED — doc:${id}`);
  console.log(`  origin_host : ${row.origin_host}`);
  console.log(`  content_hash: ${row.content_hash}`);
  console.log(`  authority it will carry as a self-published source: ${orgSite.selfSiteAuthority()}`);
  console.log(`\nThe decompose lane picks this up as a normal landed document — under V1's resolver veto`);
  console.log(`and V2's surface-form retention. Nothing here extracts facts; that lane already does.`);
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
