/**
 * READ-ONLY back-check for the automatic DB-growth systems.
 *
 * Reconciles what the two autonomous producers CLAIM to have grown against
 * what actually landed in the master KG (Echo). Answers the core audit
 * question: is "status='promoted'" in the local observation trail real growth,
 * or bookkeeping that never reaches ground truth?
 *
 *   Producers audited
 *     1. subconscious graph-walk  (feed='graph-walk' in kg_observations → Echo propose_*)
 *     2. doc-decomp / puller feeds (feed='doc-decomp' / 'puller')
 *     3. Puller discovery          (puller.db targets/observations/beliefs)
 *
 * NO WRITES. Opens sq.db, puller.db, and Echo civic_graph.db read-only.
 * Run:  $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron scripts\audit_growth_backcheck.js
 * Emits a scorecard + detail to stdout and writes data/reports/growth_backcheck_<ts>.md
 */
'use strict';
const path = require('path');
const fs = require('fs');
const DB = require(path.join(process.cwd(), 'node_modules/better-sqlite3'));

const SQ_PATH = path.join(process.cwd(), 'data/sq.db');
const PULLER_PATH = path.join(process.cwd(), 'data/puller.db');
const ECHO_PATH = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/civic_graph.db';

const open = (p) => new DB(p, { readonly: true, fileMustExist: true });
const sq = open(SQ_PATH);
const pl = open(PULLER_PATH);
let echo = null; let echoErr = null;
try { echo = open(ECHO_PATH); } catch (e) { echoErr = e.message; }

const NOW = Date.now();
const H = 3600 * 1000, D = 24 * H;
const one = (db, sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return { ERR: e.message }; } };
const all = (db, sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ ERR: e.message }]; } };
const num = (v) => (typeof v === 'number' ? v : 0);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const scorecard = [];
const flag = (name, verdict, detail) => scorecard.push({ name, verdict, detail });

say('# Automatic DB-growth back-check');
say(`_generated ${new Date(NOW).toLocaleString()}_`);
if (echoErr) say(`\n⚠ Echo DB not opened (${echoErr}） — Echo-side checks skipped.`);

/* ─────────────────────────────────────────────────────────────────────────
 * 1. LANDING RECONCILIATION — local "promoted" claims vs Echo ground truth
 * ──────────────────────────────────────────────────────────────────────── */
say('\n## 1. Landing reconciliation (claimed vs landed)');

// Local claims: promoted observations per feed per window
const feeds = all(sq, `SELECT DISTINCT feed FROM kg_observations`).map(r => r.feed).filter(Boolean);
const winDefs = [['24h', NOW - D], ['3d', NOW - 3 * D], ['7d', NOW - 7 * D]];
const claimRows = [];
for (const f of feeds) {
  const row = { feed: f };
  for (const [label, since] of winDefs) {
    row[`promoted_${label}`] = num(one(sq,
      `SELECT COUNT(*) n FROM kg_observations WHERE feed=? AND status='promoted' AND captured_at>?`, f, since).n);
  }
  claimRows.push(row);
}
say('\n**Local claims — `kg_observations status=promoted` per feed:**');
say('```'); console.table(claimRows); say('```');

// Echo ground truth: net-new entities + relations per window, and attribution
if (echo) {
  const secNow = Math.floor(NOW / 1000);
  const gt = [];
  for (const [label, since] of winDefs) {
    const s = Math.floor(since / 1000);
    gt.push({
      window: label,
      echo_entities_new: num(one(echo, `SELECT COUNT(*) n FROM entities WHERE created_at>?`, s).n),
      echo_relations_new: num(one(echo, `SELECT COUNT(*) n FROM relations WHERE created_at>? AND deleted=0`, s).n),
      echo_facts_new: num(one(echo, `SELECT COUNT(*) n FROM entity_facts WHERE created_at>? AND deleted=0`, s).n),
    });
  }
  say('\n**Echo ground truth — rows actually created (ALL sources, incl. news/ETL):**');
  say('```'); console.table(gt); say('```');

  // Attribution: WHO produced Echo's recent rows
  say('\n**Echo entity growth by `proposed_by` (last 7d):**');
  const entBy = all(echo, `SELECT COALESCE(proposed_by,'(null)') proposed_by, entity_type, COUNT(*) n
     FROM entities WHERE created_at>? GROUP BY proposed_by, entity_type ORDER BY n DESC LIMIT 15`, secNow - 7 * 86400);
  say('```'); console.table(entBy); say('```');
  say('**Echo relation growth by `proposed_by` (last 7d):**');
  const relBy = all(echo, `SELECT COALESCE(proposed_by,'(null)') proposed_by, COUNT(*) n
     FROM relations WHERE created_at>? AND deleted=0 GROUP BY proposed_by ORDER BY n DESC LIMIT 15`, secNow - 7 * 86400);
  say('```'); console.table(relBy); say('```');

  const walkClaim24 = num(one(sq, `SELECT COUNT(*) n FROM kg_observations WHERE feed='graph-walk' AND status='promoted' AND captured_at>?`, NOW - D).n);
  const echoRel24 = gt[0].echo_relations_new;
  // Is ANY recent Echo relation attributable to the subconscious/walk (not ETL/news)?
  const bulkPat = /etl|pass\d|silo|refresh|_counts|bgov|rainey_ea|news|import|backfill|structural/i;
  const nonBulkRel = relBy.filter(r => !bulkPat.test(r.proposed_by) && r.proposed_by !== '(null)').reduce((a, r) => a + r.n, 0);
  say(`\ngraph-walk promoted (24h): **${walkClaim24}**   |   Echo relations created (24h, all sources): **${echoRel24}**   |   non-bulk/non-news Echo relations (7d): **${nonBulkRel}**`);
  if (walkClaim24 > 50 && echoRel24 === 0) flag('landing:graph-walk', 'FAIL', `${walkClaim24} promoted in 24h → 0 Echo relations landed`);
  else if (walkClaim24 > 0 && nonBulkRel === 0) flag('landing:graph-walk', 'FAIL', `walk active but 0 attributable Echo relations in 7d`);
  else flag('landing:graph-walk', 'OK', `${nonBulkRel} non-bulk relations landed (7d)`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 2. SAMPLED LANDING SPOT-CHECK — do the walk's claimed edges exist in Echo?
 * ──────────────────────────────────────────────────────────────────────── */
say('\n## 2. Sampled landing spot-check (graph-walk)');
if (echo) {
  const sample = all(sq, `SELECT source_entity, relation, target, grade, captured_at
     FROM kg_observations WHERE feed='graph-walk' AND status='promoted' AND target IS NOT NULL
     ORDER BY captured_at DESC LIMIT 200`);
  // resolve a source_entity label to an Echo entity id (id-token first, then exact name, then LIKE)
  const idTok = (s) => {
    let m = /\[wd:(Q\d+)\]/.exec(s); if (m) return { col: 'wikidata_qid', v: m[1] };
    m = /\[([A-Z]\d{6})\]/.exec(s); if (m) return { col: 'external_id', v: m[1] };
    return null;
  };
  const cleanName = (s) => s.replace(/\s*\[[^\]]*\]\s*/g, '').replace(/\s*\((?:US|[A-Z]{2})\)\s*$/,'').trim();
  // INDEXED lookups only (external_id / wikidata_qid / unique name / name_ascii) — no full scans.
  const findEntity = (label) => {
    const tok = idTok(label);
    if (tok) { const r = one(echo, `SELECT id, created_at FROM entities WHERE ${tok.col}=? LIMIT 1`, tok.v); if (r && r.id) return r; }
    const nm = cleanName(label);
    let r = one(echo, `SELECT id, created_at FROM entities WHERE name=? LIMIT 1`, label); if (r && r.id) return r;
    r = one(echo, `SELECT id, created_at FROM entities WHERE name=? LIMIT 1`, nm); if (r && r.id) return r;
    r = one(echo, `SELECT id, created_at FROM entities WHERE name_ascii=? LIMIT 1`, nm.toLowerCase()); if (r && r.id) return r;
    return null;
  };
  const relExists = (a, b) => {
    const r = one(echo, `SELECT 1 x FROM relations WHERE deleted=0 AND ((source_id=? AND target_id=?) OR (source_id=? AND target_id=?)) LIMIT 1`, a, b, b, a);
    return !!(r && r.x);
  };
  let edgePresent = 0, srcPresentNoEdge = 0, srcAbsent = 0, srcPreExisting = 0, srcCreatedByWalk = 0, checked = 0;
  for (const o of sample) {
    checked++;
    const src = findEntity(o.source_entity);
    if (!src) { srcAbsent++; continue; }
    // novelty: was the source entity already in Echo before the walk recorded this obs?
    if (num(src.created_at) * 1000 < num(o.captured_at) - 5 * 60 * 1000) srcPreExisting++; else srcCreatedByWalk++;
    const tgt = findEntity(o.target);
    if (tgt && relExists(src.id, tgt.id)) edgePresent++;
    else srcPresentNoEdge++;
  }
  const pct = (n) => checked ? (100 * n / checked).toFixed(1) + '%' : '—';
  say(`\nsample: ${checked} most-recent promoted graph-walk edges`);
  say('```');
  console.table([{
    edge_present_in_echo: `${edgePresent} (${pct(edgePresent)})`,
    source_present_no_edge: `${srcPresentNoEdge} (${pct(srcPresentNoEdge)})`,
    source_absent_from_echo: `${srcAbsent} (${pct(srcAbsent)})`,
    source_pre_existing: `${srcPreExisting} (${pct(srcPreExisting)})`,
    source_newly_by_walk: `${srcCreatedByWalk} (${pct(srcCreatedByWalk)})`,
  }]);
  say('```');
  say('_interpretation: high edge_present → walk re-derives already-known edges (deduped, wasted). high source_present_no_edge → proposals not landing as edges. high source_absent → walk mints novel nodes Echo never absorbed._');
  if (checked) {
    if (edgePresent / checked > 0.5) flag('novelty:graph-walk', 'FAIL', `${pct(edgePresent)} of sampled edges already existed (redundant work)`);
    else if (srcPresentNoEdge / checked > 0.6) flag('novelty:graph-walk', 'WARN', `${pct(srcPresentNoEdge)} edges not landing on present sources`);
    else flag('novelty:graph-walk', 'OK', `${pct(edgePresent)} redundant`);
    if (srcPreExisting / checked > 0.8) flag('effort:graph-walk', 'WARN', `${pct(srcPreExisting)} of effort on pre-existing (saturated) nodes`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 3. GROUNDING INTEGRITY
 * ──────────────────────────────────────────────────────────────────────── */
say('\n## 3. Grounding integrity');
const gw = one(sq, `SELECT COUNT(*) n,
   SUM(url IS NOT NULL AND url!='') has_url,
   SUM(url LIKE 'https://en.wikipedia.org/wiki/%') wiki_autominted
   FROM kg_observations WHERE feed='graph-walk' AND status='promoted'`);
say(`\ngraph-walk promoted: ${gw.n} | with URL: ${gw.has_url} (${(100*num(gw.has_url)/num(gw.n)||0).toFixed(1)}%) | Wikipedia auto-minted URL: ${gw.wiki_autominted} (${(100*num(gw.wiki_autominted)/num(gw.n)||0).toFixed(1)}%)`);
const entCite = num(one(sq, `SELECT COUNT(DISTINCT fact_id) n FROM graph_citations WHERE fact_kind='entity'`).n);
const entTot = num(one(sq, `SELECT COUNT(*) n FROM graph_entities`).n);
say(`local graph_entities carrying a citation: ${entCite}/${entTot}`);
if (entCite === 0 && entTot > 0) flag('grounding:entity-citations', 'WARN', `0/${entTot} local entities carry a citation (why-created not traceable)`);
if (num(gw.wiki_autominted) / (num(gw.n) || 1) > 0.3) flag('grounding:url-quality', 'WARN', `${(100*num(gw.wiki_autominted)/num(gw.n)).toFixed(0)}% of walk URLs are name-minted Wikipedia (page-aboutness unverified)`);

/* ─────────────────────────────────────────────────────────────────────────
 * 4. COST / YIELD — cloud tokens spent per net-new landed
 * ──────────────────────────────────────────────────────────────────────── */
say('\n## 4. Cost / yield');
const parseWindow = (key) => {
  try { return JSON.parse(one(sq, `SELECT value FROM meta WHERE key=?`, key).value || '[]'); } catch { return []; }
};
const spend = (arr, since) => arr.filter(p => Array.isArray(p) && p[0] > since).reduce((a, p) => a + num(p[1]), 0);
for (const [label, key] of [['graph-walk', 'graphwalk.budget.window'], ['puller', 'pullerwalk.budget.window'], ['subconscious', 'subc.budget.window']]) {
  const w = parseWindow(key);
  say(`  ${label.padEnd(14)} tokens last 1h: ${spend(w, NOW - H).toLocaleString().padStart(10)} | last 24h(window-capped): ${spend(w, NOW - D).toLocaleString().padStart(10)}`);
}
if (echo) {
  const echoRel24 = num(one(echo, `SELECT COUNT(*) n FROM relations WHERE created_at>? AND deleted=0`, Math.floor((NOW - D) / 1000)).n);
  const gwTok1h = spend(parseWindow('graphwalk.budget.window'), NOW - H);
  say(`\n  → graph-walk spent ~${gwTok1h.toLocaleString()} tok in the last hour; Echo gained ${echoRel24} relations in 24h.`);
  if (gwTok1h > 5000 && echoRel24 === 0) flag('cost:graph-walk', 'FAIL', `tokens burned, 0 relations landed — spend not converting to growth`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 5. PULLER / DISCOVERY belief health
 * ──────────────────────────────────────────────────────────────────────── */
say('\n## 5. Puller / discovery health');
const pTargets = num(one(pl, `SELECT COUNT(*) n FROM targets`).n);
const pPromoted = num(one(pl, `SELECT COUNT(*) n FROM targets WHERE status='promoted'`).n);
const pRev = num(one(pl, `SELECT COUNT(*) n FROM revisions`).n);
const pRetest = num(one(pl, `SELECT COUNT(*) n FROM retest_queue`).n);
const obsNoUrl = num(one(pl, `SELECT COUNT(*) n FROM observations WHERE (source_url IS NULL OR source_url='')`).n);
const obsTot = num(one(pl, `SELECT COUNT(*) n FROM observations`).n);
const obsNoDate = num(one(pl, `SELECT COUNT(*) n FROM observations WHERE source_date IS NULL`).n);
// confidence above the grade cap for guess-kind (cap 0.5)
const guessOver = num(one(pl, `SELECT COUNT(*) n FROM observations WHERE kind='guess' AND confidence>0.5`).n);
say(`  targets: ${pTargets} (promoted to CRM/graph: ${pPromoted})`);
say(`  belief revisions ever fired: ${pRev} | retest_queue: ${pRetest}`);
say(`  observations without source_url: ${obsNoUrl}/${obsTot} (${(100*obsNoUrl/(obsTot||1)).toFixed(1)}%)`);
say(`  observations without source_date: ${obsNoDate}/${obsTot} (${(100*obsNoDate/(obsTot||1)).toFixed(1)}%)`);
say(`  guess-kind observations stored above grade-D cap (0.5): ${guessOver}`);
if (pRev === 0) flag('puller:belief-revision', 'WARN', 'belief-revision has never fired autonomously (revisions=0)');
if (pPromoted / (pTargets || 1) < 0.01) flag('puller:promotion', 'WARN', `${pPromoted}/${pTargets} targets ever promoted — staging pool barely feeds the graph`);
if (obsNoDate / (obsTot || 1) > 0.9) flag('puller:source-date', 'WARN', `${(100*obsNoDate/obsTot).toFixed(0)}% of discovered facts have no as-of date`);

/* ─────────────────────────────────────────────────────────────────────────
 * SCORECARD
 * ──────────────────────────────────────────────────────────────────────── */
say('\n## Scorecard');
say('```'); console.table(scorecard); say('```');
const fails = scorecard.filter(s => s.verdict === 'FAIL').length;
const warns = scorecard.filter(s => s.verdict === 'WARN').length;
say(`\n**${fails} FAIL, ${warns} WARN, ${scorecard.filter(s=>s.verdict==='OK').length} OK**`);

// write report
try {
  const dir = path.join(process.cwd(), 'data/reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(NOW).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fp = path.join(dir, `growth_backcheck_${stamp}.md`);
  fs.writeFileSync(fp, out.join('\n'), 'utf8');
  console.log(`\n[report written] ${fp}`);
} catch (e) { console.log('report write failed:', e.message); }

sq.close(); pl.close(); if (echo) echo.close();
