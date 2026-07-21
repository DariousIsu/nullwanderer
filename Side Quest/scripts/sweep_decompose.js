/* scripts/sweep_decompose.js — read the documents that landed and were never read.
 *
 * `decomposeLandedDoc` (main.js:9029) fires from five specific INGEST paths, so decomposition is
 * coupled to how a document ARRIVED rather than to the document itself. A document landing any other
 * way is invisible to the graph forever — proven by scripts/research_org.js, which landed
 * raineycenter.org and raineyfreedom.org with correct origins and produced ZERO encounters while the
 * sentence naming the sister organisation sat in the corpus, unread.
 *
 * The dependency wiring below MIRRORS main.js:9029-9050 deliberately — same cloud extractor, same
 * gate-first resolver, same observe fan-out — so a swept document is read exactly as a landed one is,
 * and cannot drift into a second, subtly different pipeline. Where main.js and this disagree, main.js
 * is right and this is the bug.
 *
 * Requires the live engine (Echo on :8765) and a cloud extractor, because that is what reading a
 * document takes. Records an ATTEMPT per document, so a page of navigation chrome that honestly yields
 * nothing is not re-read forever.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write. --limit N (default 20), --sources a,b to narrow.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/sweep_decompose.js [--apply] [--limit N]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
// The cloud extractor's key lives in .env, and lib/config is what loads it into process.env. The
// Electron main process does this at boot; a standalone script has to ask for it, or models.sources()
// reports "no cloud extractor available" while the key sits on disk.
require('../lib/config').loadEnv();
const db = require('../lib/db');
const sweep = require('../lib/decompose_sweep');

db.init();
const argv = process.argv;
const arg = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const LIMIT = Number(arg('--limit', 20)) || 20;
const SOURCES = (arg('--sources', null) || '').split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  console.log(`\nDECOMPOSE SWEEP — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);

  // BUDGETED AND CHEAPEST-FIRST by default. The backlog is 3,211 documents / 405M chars ≈ 69,000
  // chunks, so an unbounded run is a major spend rather than a housekeeping pass. `--all` opts out of
  // the budget for a deliberate, supervised batch.
  const budgeted = !argv.includes('--all');
  const batch = budgeted ? sweep.nextBatch(db, { limit: LIMIT }) : null;
  const candidates = budgeted
    ? batch.picks
    : sweep.findUndecomposed(db, { limit: LIMIT, sources: SOURCES.length ? SOURCES : null });
  if (budgeted) {
    console.log(`budget today: ${batch.budget.spent}/${batch.budget.limit} chunks spent, ${batch.budget.remaining} left`);
    console.log(`this batch: ~${batch.estChunks} chunk(s)`);
  }
  console.log(`documents that landed and were never read: ${candidates.length}${SOURCES.length ? `  (sources: ${SOURCES.join(', ')})` : ''}`);
  for (const c of candidates) {
    console.log(`  doc:${String(c.id).padEnd(6)} ${String(c.origin_host || '—').slice(0, 24).padEnd(26)} ${String(c.chars).padStart(6)}ch  ${String(c.title || '').slice(0, 40)}`);
  }
  if (!candidates.length) { console.log('\nNothing to sweep.'); process.exit(0); }
  if (!APPLY) { console.log(`\nDry run — nothing read. Re-run with --apply.`); process.exit(0); }

  // ── the same wiring main.js uses, assembled here because a script has no live singleton ─────────
  const echoSuitLib = require('../lib/echo_suit');
  const config = require('../lib/config');
  // ECHO'S PORT COMES FROM ITS OWN config.toml, exactly as main.js:101 readEchoConfig does. `fromEnv({})`
  // defaults to :9000 and the engine runs on :8765, so passing nothing silently produced "fetch failed"
  // and looked like the engine was down when it was answering fine the whole time.
  const echoCfg = (() => {
    const fs = require('fs'); const path = require('path');
    const dir = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
    let token = process.env.NX_ECHO_ADMIN_TOKEN || null;
    let port = 8765;
    try {
      const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
      if (!token) { const m = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m); if (m) token = m[1]; }
      const p = toml.match(/^\s*port\s*=\s*(\d+)/m); if (p) port = parseInt(p[1], 10);
    } catch { /* fall through to the default port */ }
    const envPort = parseInt(process.env.ECHO_PORT || '', 10);
    if (!Number.isNaN(envPort)) port = envPort;
    return { url: process.env.ECHO_MCP_URL || `http://127.0.0.1:${port}/mcp/`, token };
  })();
  const suit = echoSuitLib.createSuit({ client: require('../lib/echo').fromEnv({ url: echoCfg.url, token: echoCfg.token }) });
  await suit.connect();
  if (!suit.connected) { console.error(`Echo is not connected (${suit.lastError || 'unknown'}) — nothing read.`); process.exit(2); }
  // REGISTER THE SUIT AS THE LIVE ONE. `echo_suit.resolveMention` is a MODULE-level function that
  // dispatches through `_live`, set by setLiveSuit — main.js does this at boot. Without it the
  // resolver's dispatch is null, every entity resolves to {status:'error'}, resolveExtracted returns
  // `skip`, and the whole document holds: 30 observations, 0 mints, 0 encounters. The symptom looks
  // like a bad extraction and is actually an unbound resolver.
  echoSuitLib.setLiveSuit(suit);
  console.log(`\nEcho: connected (${suit.status().tools} tools), registered as the live suit`);

  // THE CLOUD KEY IS NOT IN .env — it lives in ECHO'S keychain, and main.js:1197 hydrates it at boot
  // via keystore.hydrateFromEcho. A standalone script that skips this sees no cloud tier and reports
  // "no cloud extractor available" while the key is sitting in Echo the whole time. The value is never
  // printed or written anywhere — only pulled into this process's env, exactly as main.js does.
  if (!process.env.OLLAMA_API_KEY && !process.env.OLLAMA_CLOUD_KEY) {
    try {
      const r = require('../lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], {
        python: process.env.ECHO_PYTHON || 'python',
        cwd: process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo',
      });
      console.log(`cloud key: ${process.env.OLLAMA_API_KEY ? `hydrated from Echo (${(r && r.resolved || []).join(',')})` : 'not resolved'}`);
    } catch (e) { console.error(`cloud key hydration failed: ${e.message}`); }
  }

  const src = (require('../lib/models').sources() || []).find((s) => s.tier === 'cloud' && s.token);
  if (!src) { console.error('no cloud extractor available — nothing read.'); process.exit(3); }

  const decompLane = require('../lib/decomp_lane');
  const curationStore = require('../lib/curation_store');
  const { completeDetailed } = require('../lib/ollama');
  const _encLib = require('../lib/decomp_encounters');
  const _encounters = require('../lib/encounters');
  const objectType = require('../lib/object_type');
  const model = config.extractionModel() || config.subconsciousModel();
  const extract = decompLane.makeCloudExtractor({ completeFn: completeDetailed, model, base: src.base, token: src.token });
  const _gateDeps = require('../lib/resolution_live').makeLiveDeps((t) => suit.dispatch(t));
  const resolve = (name, opts) => require('../lib/resolution_gate').preResolve(name, opts || {}, {
    deps: _gateDeps, fallback: (n, o) => echoSuitLib.resolveMention(n, o),
  });
  const dispatch = (tag) => suit.dispatch(tag);
  console.log(`extractor: ${model} @ ${src.base}\n`);

  let totalEnc = 0, totalObs = 0;
  const attempted = [];
  for (const c of candidates) {
    const row = db.getDocument(c.id);
    if (!row || !String(row.body || '').trim()) continue;
    const prov = {
      id: row.id, source: row.source || null, origin: row.origin || null, origin_host: row.origin_host || null,
      content_hash: row.content_hash || null,
      observed_at: (() => { try { const o = require('../lib/observed_at').extractObservedAt({ text: row.body, title: row.title }); return o ? o.ts : null; } catch { return null; } })(),
    };
    let enc = 0, obs = 0;
    const observe = (o) => {
      try { curationStore.record(db, { ...o, feed: 'doc-decomp' }); obs += 1; } catch {}
      try { const e = _encLib.toEncounter(o, prov); if (e && _encounters.record(e)) enc += 1; } catch {}
      try { const t = _encLib.toTypeClaim(o, prov); if (t) objectType.recordType(t); } catch {}
    };
    const { chunks } = require('../lib/contact_extract').chunkForExtraction(String(row.body));
    let minted = 0, reused = 0, held = 0;
    for (const chunk of chunks) {
      try {
        const r = await decompLane.decomposeLanding({ id: row.id, title: row.title, body: chunk, ref: row.origin || undefined },
          { extract, resolve, dispatch, observe, cap: { entities: 40, relations: 40 }, log: () => {} });
        if (r && !r.skipped) { minted += r.minted || 0; reused += r.reused || 0; held += r.held || 0; }
      } catch (e) { console.error(`  doc:${row.id} chunk failed: ${e.message}`); }
    }
    attempted.push(row.id);
    totalEnc += enc; totalObs += obs;
    // The counter the other lane asked for: mint vs reuse is how V1's over-blocking risk gets WATCHED
    // rather than asserted. A large swing toward mint means the veto is fragmenting real entities.
    console.log(`  doc:${String(row.id).padEnd(6)} ${chunks.length} chunk(s) → +${minted} mint / ${reused} reuse / ${held} held · ${enc} encounter(s), ${obs} observation(s)`);
  }

  sweep.markAttempted(db, attempted);
  if (budgeted) sweep.spendBudget(db, batch.estChunks);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`READ ${attempted.length} document(s) → ${totalEnc} encounter(s), ${totalObs} observation(s).`);
  console.log(`attempts recorded, so a document that honestly yields nothing is not re-read forever.`);
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
