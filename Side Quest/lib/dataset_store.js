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

/** Per-entity roster lines — title, status/action, sponsors when held, ALWAYS the source URL. */
function renderRoster(rows, { cap = 200 } = {}) {
  if (!rows.length) return '';
  const L = rows.slice(0, cap).map((r) => {
    const a = r.attrs || {};
    const bits = [`- **${r.entity}${a.title ? ` — ${String(a.title).slice(0, 140)}` : ''}**`];
    if (a.state) bits.push(`[${a.state}]`);
    if (a.status) bits.push(`${a.status}.`);
    if (a.lastAction) bits.push(`${String(a.lastAction).slice(0, 110)}${a.lastActionDate ? ` (${a.lastActionDate})` : ''}.`);
    if (Array.isArray(a.sponsors) && a.sponsors.length) bits.push(`Sponsors: ${a.sponsors.slice(0, 15).join('; ')}${a.sponsors.length > 15 ? ` +${a.sponsors.length - 15} more` : ''}.`);
    if (a.email || a.phone) bits.push([a.email, a.phone].filter(Boolean).join(' · '));   // contact rows: reachability IS the payload
    if (r.sourceUrl) bits.push(`Source: ${r.sourceUrl}`);
    return bits.join(' ');
  });
  if (rows.length > cap) L.push(`(+${rows.length - cap} more rows in the dataset.)`);
  return L.join('\n');
}

/** The full deterministic data section for a report document. `dims` comes from the acquirer
 *  registry — each data shape names the dimensions it honestly supports (legislation:
 *  state × status; civic rosters: body × role). Omitted → the legislation defaults. */
function renderReportData(rows, dims = {}) {
  if (!rows.length) return '';
  const countKeys = dims.countKeys || ['state', 'status'];
  const rowKey = dims.rowKey || 'state', colKey = dims.colKey || 'status';
  return [
    `### Counts (deterministic — rendered from the dataset, ${rows.length} row(s))`, '', renderCounts(rows, countKeys), '',
    `### The table`, '', renderTable(rows, { rowKey, colKey }), '',
    `### Every row`, '', renderRoster(rows),
  ].join('\n');
}

module.exports = { ensure, upsertRows, rowsFor, countFor, hasRows, countsBy, renderCounts, renderTable, renderRoster, renderReportData, _setDb };
