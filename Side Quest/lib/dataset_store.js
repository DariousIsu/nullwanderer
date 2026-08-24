'use strict';
// ── DATASETS UNDER DOCUMENTS (Phase 2, THE CORE) ────────────────────────────────────────────────
// docs/DOCUMENT_PRODUCTION_PLAN_2026-08-21.md §3 Phase 2 — Root B: documents had NO DATA. The
// prose pipeline (topic → doc-soup gather → one-shot LLM) made every count, table, and roster
// survive a generative pass, which is exactly where fabrication and starvation live (the compose
// caps truncated 3 of 7 perfect sheets; "how many bills total" was unanswerable).
//
// The constitution: a data-shaped deliverable carries a DATASET — rows landed by acquisition
// (entity, attributes, source URL, fetch date, query provenance) keyed to the PROJECT slug — and
// every quantitative artifact (counts, per-state tables, rosters) is RENDERED DETERMINISTICALLY
// from those rows by the functions below. The model writes narrative AROUND the renders and may
// never author a number. "How many bills total" = SELECT COUNT — exact, every time, from chat.
//
// The store is generic (attrs = JSON): bills now; rosters/contacts ride the same table in P3.

function _d() { return require('./db').getDb(); }
let _dbh = null;                                   // test injection (smoke drives an in-memory db)
function _setDb(h) { _dbh = h; }
function _handle() { return _dbh || _d(); }

let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS project_datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_slug TEXT NOT NULL,
    entity TEXT NOT NULL,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    source_url TEXT,
    provenance TEXT,
    fetched_ts INTEGER,
    UNIQUE(project_slug, entity)
  )`);
  h.exec(`CREATE INDEX IF NOT EXISTS idx_project_datasets_slug ON project_datasets(project_slug)`);
  _ensured = true;
}

/** Land rows. A re-fetch of a known entity UPDATES its attrs/provenance (fresh beats stale);
 *  identity is (project, entity) so a bill re-found by a second query never duplicates. */
function upsertRows({ slug, rows = [], now = Date.now() } = {}) {
  ensure();
  const h = _handle();
  let inserted = 0, updated = 0;
  const ins = h.prepare(`INSERT INTO project_datasets (project_slug, entity, attrs_json, source_url, provenance, fetched_ts)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_slug, entity) DO UPDATE SET attrs_json = excluded.attrs_json,
      source_url = excluded.source_url, provenance = excluded.provenance, fetched_ts = excluded.fetched_ts`);
  for (const r of rows) {
    const entity = String(r.entity || '').trim();
    if (!entity) continue;
    const existed = h.prepare('SELECT 1 FROM project_datasets WHERE project_slug = ? AND entity = ?').get(slug, entity);
    ins.run(slug, entity, JSON.stringify(r.attrs || {}), String(r.sourceUrl || ''), String(r.provenance || ''), now);
    if (existed) updated++; else inserted++;
  }
  if (inserted || updated) console.log(`[dataset] "${slug}": +${inserted} row(s), ${updated} refreshed (${countFor(slug)} total)`);
  return { inserted, updated };
}

function rowsFor(slug) {
  ensure();
  try {
    return _handle().prepare('SELECT * FROM project_datasets WHERE project_slug = ? ORDER BY entity').all(slug)
      .map((r) => { let a = {}; try { a = JSON.parse(r.attrs_json || '{}'); } catch {} return { entity: r.entity, attrs: a, sourceUrl: r.source_url, provenance: r.provenance, fetchedTs: r.fetched_ts }; });
  } catch { return []; }
}
function countFor(slug) { ensure(); try { return _handle().prepare('SELECT COUNT(*) n FROM project_datasets WHERE project_slug = ?').get(slug).n; } catch { return 0; } }
function hasRows(slug, attrEq = null) {
  if (!attrEq) return countFor(slug) > 0;
  return rowsFor(slug).some((r) => Object.entries(attrEq).every(([k, v]) => String(r.attrs[k]) === String(v)));
}

// ── DETERMINISTIC RENDERS (pure over rows — the model NEVER authors these) ─────────────────────
function countsBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const v = String((r.attrs || {})[key] || '(unknown)'); m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderCounts(rows, keys = ['state', 'status']) {
  if (!rows.length) return '';
  const L = [`**Total: ${rows.length}**`];
  for (const k of keys) {
    const c = countsBy(rows, k);
    if (c.length > 1 || (c.length === 1 && c[0][0] !== '(unknown)')) L.push(`By ${k}: ${c.map(([v, n]) => `${v} ${n}`).join(' · ')}`);
  }
  return L.join('\n');
}

/** Cross-tab: rowsKey × colsKey counts as a markdown table. Columns missing from every row →
 *  falls back to a one-dimension count table (renders only what the rows actually hold). */
function renderTable(rows, { rowKey = 'state', colKey = 'status' } = {}) {
  if (!rows.length) return '';
  const haveCol = rows.some((r) => (r.attrs || {})[colKey] != null);
  const rKeys = countsBy(rows, rowKey).map(([v]) => v);
  if (!haveCol) {
    return [`| ${rowKey} | count |`, '|---|---|', ...countsBy(rows, rowKey).map(([v, n]) => `| ${v} | ${n} |`)].join('\n');
  }
  const cKeys = countsBy(rows, colKey).map(([v]) => v);
  const cell = (rv, cv) => rows.filter((r) => String((r.attrs || {})[rowKey] || '(unknown)') === rv && String((r.attrs || {})[colKey] || '(unknown)') === cv).length;
  const head = `| ${rowKey} \\ ${colKey} | ${cKeys.join(' | ')} | total |`;
  const sep = `|---|${cKeys.map(() => '---').join('|')}|---|`;
  const body = rKeys.map((rv) => `| ${rv} | ${cKeys.map((cv) => cell(rv, cv) || '').join(' | ')} | ${rows.filter((r) => String((r.attrs || {})[rowKey] || '(unknown)') === rv).length} |`);
  return [head, sep, ...body].join('\n');
}

/** Month buckets over a date attr (YYYY-MM-DD strings) → [['YYYY-MM', n], …] ascending. Pure. */
function trendBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const mm = String((r.attrs || {})[key] || '').match(/^(\d{4})-(\d{2})/);
    if (!mm) continue;
    const k = `${mm[1]}-${mm[2]}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** The trend graph as deterministic markdown (P2's last open render, 08-22): month × count with a
 *  scaled bar per row. One dated month is not a trend — returns ''. Rows without the date attr and
 *  months beyond the cap are NAMED, never silently dropped. */
function renderTrend(rows, { dateKey = 'lastActionDate', cap = 24 } = {}) {
  if (!rows.length) return '';
  const all = trendBy(rows, dateKey);
  if (all.length < 2) return '';
  const buckets = all.slice(-cap);
  const dated = all.reduce((n, [, c]) => n + c, 0);
  const max = Math.max(...buckets.map(([, c]) => c));
  const bar = (c) => '█'.repeat(Math.max(1, Math.round((c / max) * 20)));
  const L = ['| month | count | trend |', '|---|---|---|', ...buckets.map(([mo, c]) => `| ${mo} | ${c} | ${bar(c)} |`)];
  const notes = [];
  if (all.length > buckets.length) notes.push(`${all.length - buckets.length} earlier month(s) not shown`);
  if (dated < rows.length) notes.push(`${rows.length - dated} row(s) carry no ${dateKey}`);
  return `${L.join('\n')}${notes.length ? `\n\n_(${notes.join('; ')}.)_` : ''}`;
}

/** Word-boundary trim: never cut mid-word (the v10 roster carried "relative to lob"); a cut is
 *  always MARKED with an ellipsis so it reads as deliberate. */
function _trim(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/** Per-entity roster lines — title, status/action, sponsors when held, ALWAYS the source URL.
 *  Cap 200 → 2000 (v10 catch, 08-24: the alphabetical 200-row cap dropped the ENTIRE Texas and
 *  Utah rosters from a report titled for them). The file is the deliverable — it carries every
 *  row; the cap is a pathological-dataset backstop, and a drop NAMES what it cut per group. */
function renderRoster(rows, { cap = 2000 } = {}) {
  if (!rows.length) return '';
  const L = rows.slice(0, cap).map((r) => {
    const a = r.attrs || {};
    const bits = [`- **${r.entity}${a.title ? ` — ${_trim(a.title, 140)}` : ''}**`];
    if (a.state) bits.push(`[${a.state}]`);
    if (a.status) bits.push(`${a.status}.`);
    if (a.lastAction) bits.push(`${_trim(a.lastAction, 110)}${a.lastActionDate ? ` (${a.lastActionDate})` : ''}.`);
    if (Array.isArray(a.sponsors) && a.sponsors.length) bits.push(`Sponsors: ${a.sponsors.slice(0, 15).join('; ')}${a.sponsors.length > 15 ? ` +${a.sponsors.length - 15} more` : ''}.`);
    if (a.email || a.phone) bits.push([a.email, a.phone].filter(Boolean).join(' · '));   // contact rows: reachability IS the payload
    if (r.sourceUrl) bits.push(`Source: ${r.sourceUrl}`);
    return bits.join(' ');
  });
  if (rows.length > cap) {
    const dropped = countsBy(rows.slice(cap), 'state').map(([v, n]) => `${v} ${n}`).join(', ');
    L.push(`(+${rows.length - cap} more rows not rendered: ${dropped}.)`);
  }
  return L.join('\n');
}

/** Round-robin sample across `key` groups, cap total — every group is represented before any
 *  dominates, and the selected rows keep their original order. For PROMPT-sized views of a roster
 *  too big to ride whole (v10 catch: a blind 20k char slice of the alphabetical roster fed the
 *  composer AZ/FL rows only — two title states were invisible to the narrative). The rendered
 *  FILE always carries every row; only the model's view samples. */
function sampleBalanced(rows, key = 'state', cap = 120) {
  if (rows.length <= cap) return rows;
  const groups = new Map();
  rows.forEach((r, i) => { const v = String((r.attrs || {})[key] || '(unknown)'); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(i); });
  const lists = [...groups.values()];
  const picked = new Set();
  for (let round = 0; picked.size < cap; round++) {
    let any = false;
    for (const g of lists) { if (round < g.length && picked.size < cap) { picked.add(g[round]); any = true; } }
    if (!any) break;
  }
  return rows.filter((_, i) => picked.has(i));
}

/** The full deterministic data section for a report document. `dims` comes from the acquirer
 *  registry — each data shape names the dimensions it honestly supports (legislation:
 *  state × status; civic rosters: body × role). Omitted → the legislation defaults.
 *  opts.rosterRows/rosterNote: a prompt-sized view keeps the COMPLETE counts/table/trend but
 *  renders a sampled roster, labeled — the saved document never uses these. */
function renderReportData(rows, dims = {}, { rosterRows = null, rosterNote = '' } = {}) {
  if (!rows.length) return '';
  const countKeys = dims.countKeys || ['state', 'status'];
  const rowKey = dims.rowKey || 'state', colKey = dims.colKey || 'status';
  const trend = dims.trendKey ? renderTrend(rows, { dateKey: dims.trendKey }) : '';
  // The relevance split (v11 pass, 08-24): dims.classify(attrs) → true means the row's own
  // content names the subject; false means it merely matched an acquisition search. The split
  // renders BESIDE the raw total — both numbers are honest, neither hides the other.
  const cls = typeof dims.classify === 'function' ? (r) => { try { return !!dims.classify(r.attrs || {}); } catch { return true; } } : null;
  const clsLines = [];
  const rr = rosterRows || rows;
  let rosterLines;
  if (cls) {
    const nSub = rows.filter(cls).length;
    clsLines.push(`Subject relevance (deterministic, classified from each row's own title): substantive ${nSub} · incidental ${rows.length - nSub}`, '');
    const rrSub = rr.filter(cls), rrInc = rr.filter((r) => !cls(r));
    rosterLines = [
      `#### Substantive (${rrSub.length}${rosterRows ? ` of ${nSub}` : ''})`, '', renderRoster(rrSub),
      ...(rrInc.length ? ['', `#### Incidental (${rrInc.length}${rosterRows ? ` of ${rows.length - nSub}` : ''}) — matched the acquisition searches; the row's own title does not name the report subject`, '', renderRoster(rrInc)] : []),
    ];
  } else {
    rosterLines = [renderRoster(rr)];
  }
  return [
    `### Counts (deterministic — rendered from the dataset, ${rows.length} row(s))`, '', renderCounts(rows, countKeys), '',
    ...clsLines,
    `### The table`, '', renderTable(rows, { rowKey, colKey }), '',
    ...(trend ? [`### The trend (by ${dims.trendKey}, monthly)`, '', trend, ''] : []),
    `### Every row`, '', ...(rosterNote ? [rosterNote, ''] : []), ...rosterLines,
  ].join('\n');
}

module.exports = { ensure, upsertRows, rowsFor, countFor, hasRows, countsBy, renderCounts, renderTable, renderRoster, sampleBalanced, trendBy, renderTrend, renderReportData, _setDb };
