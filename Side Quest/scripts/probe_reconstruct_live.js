/* scripts/probe_reconstruct_live.js — LIVE proof of chunked reconstruction against the real cloud model.
 * Pulls REAL raw ALL-CAPS caption items from news_bucket.db, groups them into per-stream segments, and runs
 * the NEW chunked reconstructBatch through the actual gemma4:31b (editor) on Ollama Cloud. Shows before→after
 * and times each chunk — answering "does the model work at this pace" with real output + latency.
 * Read-only on the store (reconstructBatch takes no store; only the cloud budget counter ticks).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_reconstruct_live.js
 */
const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);
const one = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

(async () => {
  require(path.join(SQ, 'lib', 'db')).init();
  try { require(path.join(SQ, 'lib', 'keystore')).hydrateFromEcho(['OLLAMA_API_KEY'], { python: path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe'), cwd: ECHO_CWD }); } catch (e) { L('key hydrate warn: ' + e.message); }
  const models = require(path.join(SQ, 'lib', 'models'));
  const cloudSrc = (models.sources() || []).find((s) => s.tier === 'cloud' && s.token);
  L('cloud tier: ' + (cloudSrc ? cloudSrc.base + ' (key present)' : 'NONE — cannot run live'));
  if (!cloudSrc) process.exit(0);
  const model = models.getModelFor('editor', null);
  L('editor model: ' + model + '\n');

  const VR = require(path.join(SQ, 'lib', 'video_reconstruct'));
  const cloud = require(path.join(SQ, 'lib', 'cloud_logic'));
  const db = require(path.join(SQ, 'lib', 'news_db')).get();

  // real RAW caption items (ALL-CAPS or ">>"), a couple of streams, most recent
  const raw = db.prepare(
    "SELECT id, source, source_kind, source_url AS sourceUrl, ts, summary, title FROM news_items " +
    "WHERE source_kind='video' AND (title LIKE '%>>%' OR (title=UPPER(title) AND title<>LOWER(title))) " +
    "ORDER BY ts DESC LIMIT 9"
  ).all();
  L(`pulled ${raw.length} raw video items`);
  const segs = VR.groupIntoSegments(raw, { gapMs: 120000 });
  L(`grouped into ${segs.length} segments across streams: ${[...new Set(segs.map((s) => s.stream))].join(', ')}`);
  const chunks = VR.chunkSegments(segs, { maxSegments: 6, maxChars: 16000 });
  L(`→ ${chunks.length} bounded cloud call(s) (≤6 segs, single-stream each)\n`);

  const t0 = Date.now();
  const out = await VR.reconstructBatch(segs, { ask: cloud.ask, model, maxSegments: 6, maxChars: 16000 });
  const dt = Date.now() - t0;

  let clean = 0;
  for (const seg of segs) {
    const v = out[seg.repId];
    L(`[${seg.stream}] seg rep=${seg.repId}`);
    L(`   RAW : ${one(seg.captions).slice(0, 120)}`);
    if (v && v.isNews === false) { L('   →   (dropped: is_news=false)'); }
    else if (v && v.headline) { L(`   NEW : ${v.headline}`); L(`   ent : ${(v.entities || []).join(', ')}`); if (v.headline !== v.headline.toUpperCase()) clean++; }
    else { L('   →   (left raw — model omitted this id)'); }
    L('');
  }
  L('════ PACE ════');
  L(`  ${segs.length} segments in ${chunks.length} chunk(s) → ${(dt / 1000).toFixed(1)}s total (~${(dt / Math.max(1, chunks.length) / 1000).toFixed(1)}s/call)`);
  L(`  reconstructed clean (mixed-case) headlines: ${clean}/${segs.length}`);
  L(`  → at ~${(dt / Math.max(1, chunks.length) / 1000).toFixed(1)}s/call, a busy hour (~10-13 chunks) ≈ ${(13 * dt / Math.max(1, chunks.length) / 1000).toFixed(0)}s of model time — well inside the 60-min pass.`);
  process.exit(0);
})().catch((e) => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
