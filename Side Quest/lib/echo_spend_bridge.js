'use strict';
/*
 * lib/echo_spend_bridge.js — F19 slice 2: fold Echo/Skuld cloud spend into the app's usage meter.
 *
 * THE GAP (measured 2026-08-20): usage_meter's only writers are the app's own ollama.js call sites,
 * so every cloud call made by the Python processes (Echo server, Skuld scheduler/worker — the
 * curator's gpt-oss:120b slice alone was ~2.7k requests that week) was invisible to spentSince and
 * spentLastHour. The dashboard-scrape true-up re-anchors pool STATE at scrape cadence, but the PACE
 * check — the thing the tier ladder throttles background lanes against — under-counted the trailing
 * hour by the whole Echo share, and lost everything if the scrape died.
 *
 * THE WIRE: Echo's side (echo/trajectory_log.record_llm_spend, local commit 8d402ab) now persists
 * every CLOUD completion's real token counts into agent_trajectory's OpenInference columns (built
 * 2026-06, never populated until now). This bridge reads those rows by id-watermark on the app's
 * 60s meter tick and replays them into usage_meter.record(model, tokens, ts) — after which the
 * quota gate's compute weighting and tier floors apply to the TRUE total burn with no further code.
 *
 * No double-count by construction: ollama.js meters only this process's calls; agent_trajectory
 * token rows come only from the Python processes. Rows older than usage_meter's 26h ring are
 * SKIPPED (not just pointless — record() appends, and _prune only strips a sorted prefix, so an
 * old-ts row appended after newer ones would survive pruning forever). Everything fails soft:
 * a missing saga.db, a locked read, a bad row — the tick just tries again next minute.
 *
 * Pure-testable via injected deps ({ dbPath, meter, getMeta, setMeta, now }); the live tick in
 * main.js calls foldOnce() bare. Smoke: scripts/smoke_echo_spend_bridge.js.
 */

const path = require('path');

const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const SAGA_DB = path.join(ECHO_CWD, 'data', 'saga.db');
const META_KEY = 'echo_spend.traj_watermark';
const MAX_AGE_MS = 26 * 3600 * 1000;   // usage_meter RETAIN_MS — see ring-order note above
const BATCH = 1000;                    // per-tick cap; a backlog drains over a few ticks

const TIP_SQL = 'SELECT MAX(id) m FROM agent_trajectory';
const ROWS_SQL =
  `SELECT id, asserted_at,
          COALESCE(llm_model_name, 'unknown') AS model,
          COALESCE(llm_token_count_total,
                   COALESCE(llm_token_count_prompt, 0) + COALESCE(llm_token_count_completion, 0)) AS tokens,
          COALESCE(llm_token_count_completion, 0) AS out,
          tags_json
   FROM agent_trajectory
   WHERE id > ?
     AND (llm_token_count_total IS NOT NULL
          OR llm_token_count_prompt IS NOT NULL
          OR llm_token_count_completion IS NOT NULL)
   ORDER BY id LIMIT ?`;

// FAST-FORWARD (2026-08-20, measured live): agent_trajectory holds 3.06M rows, and OLD callers DID
// populate token columns on a historical slice — so a low watermark crawls months-stale rows at
// BATCH/tick (~39h of ticks), folding none of them (all outside the 26h ring). Anything >100k rows
// behind the tip is pre-seam history by construction (Echo's writers are app children — no rows accrue
// while the app is down), so jump to the tip and fold only the fresh. Returns the result to return, or
// null to carry on.
function _fastForward(tip, wm, sm) {
  if (tip && tip.m && tip.m - wm > 100000) {
    console.log(`[echo-spend] watermark ${wm} is ${tip.m - wm} rows behind the tip — fast-forwarding past pre-seam history`);
    sm(META_KEY, String(tip.m));
    return { folded: 0, watermark: tip.m, why: 'fast-forwarded' };
  }
  return null;
}
// Replay the fetched rows into the meter and advance the watermark. Shared by both doors, so the
// worker path and the synchronous path cannot drift.
// THE LANE RIDES THE ROW (stage 4.5 item 3a, 2026-09-04): Echo stamps each spend row's usage-law tier as
// a 'lane:<tier>' tag (trajectory_log.record_llm_spend); the meter is charged under that lane. Before
// this every Echo-side row landed UNTAGGED ('?'), which the pace check counts as BACKGROUND — his
// chat-delegated agents and Saga's own replies paced her expansion (p285: 405k–570k "BACKGROUND"
// compute an hour against a 65k rate, 11 research deferrals in 20 minutes). Untagged stays '?'.
function laneOf(tagsJson) {
  try {
    const tags = JSON.parse(tagsJson || '[]');
    if (!Array.isArray(tags)) return '?';
    for (const t of tags) { const m = /^lane:([a-z_]+)$/i.exec(String(t || '')); if (m) return m[1].toLowerCase(); }
  } catch { /* an unreadable tag list is untagged */ }
  return '?';
}
function _fold(rows, { now, um, sm, wm }) {
  if (!rows || !rows.length) return { folded: 0 };
  let folded = 0, maxId = wm;
  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    if (!r.tokens || r.tokens <= 0) continue;
    const ts = (r.asserted_at || 0) * 1000;               // agent_trajectory stamps SECONDS
    if (!ts || now - ts > MAX_AGE_MS) continue;           // ring-order protection (header note)
    um.record(r.model, r.tokens, Math.min(ts, now), laneOf(r.tags_json), r.out || 0);   // never stamp the future; the row's lane; the completion share rides
    folded++;
  }
  sm(META_KEY, String(maxId));                            // advance even when all rows were skipped
  return { folded, watermark: maxId };
}
function _deps({ meter, getMeta, setMeta }) {
  return {
    um: meter || require('./usage_meter'),
    gm: getMeta || ((k) => require('./db').getMeta(k)),
    sm: setMeta || ((k, v) => require('./db').setMeta(k, v)),
  };
}

function foldOnce({ now = Date.now(), dbPath = SAGA_DB, meter, getMeta, setMeta } = {}) {
  try {
    const { um, gm, sm } = _deps({ meter, getMeta, setMeta });
    if (!require('fs').existsSync(dbPath)) return { folded: 0, why: 'saga.db not found' };
    const wm = parseInt(gm(META_KEY) || '0', 10) || 0;
    const Database = require('better-sqlite3');
    let conn, rows = [];
    try {
      conn = new Database(dbPath, { readonly: true });
      conn.pragma('busy_timeout = 3000');
      const ff = _fastForward(conn.prepare(TIP_SQL).get(), wm, sm);
      if (ff) return ff;
      rows = conn.prepare(ROWS_SQL).all(wm, BATCH);
    } finally { try { if (conn) conn.close(); } catch {} }
    return _fold(rows, { now, um, sm, wm });
  } catch (e) { return { folded: 0, why: String((e && e.message) || e) }; }
}

// CUT 18 (09-03): the same fold with its two reads in lib/db_worker — the 60s meter tick was paying
// 1.2–1.4s of synchronous saga.db scanning on the main thread (the OR-predicates walk every row past the
// watermark before LIMIT can stop them; agent_trajectory is 3M rows). `query(sql, params)` is injectable
// so the smoke proves the two doors fold identically from the same rows without a worker.
async function foldOnceAsync({ now = Date.now(), dbPath = SAGA_DB, meter, getMeta, setMeta, query } = {}) {
  try {
    const { um, gm, sm } = _deps({ meter, getMeta, setMeta });
    if (!require('fs').existsSync(dbPath)) return { folded: 0, why: 'saga.db not found' };
    const wm = parseInt(gm(META_KEY) || '0', 10) || 0;
    const q = query || ((sql, params) => require('./db_worker').query(dbPath, sql, params, { limit: BATCH + 10, timeoutMs: 60000 }));
    const tipRows = await q(TIP_SQL, []);
    const ff = _fastForward(tipRows && tipRows[0], wm, sm);
    if (ff) return ff;
    const rows = await q(ROWS_SQL, [wm, BATCH]);
    return _fold(rows, { now, um, sm, wm });
  } catch (e) { return { folded: 0, why: String((e && e.message) || e) }; }
}

module.exports = { foldOnce, foldOnceAsync, META_KEY, MAX_AGE_MS, SAGA_DB };
