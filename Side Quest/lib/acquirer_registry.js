'use strict';
// ── THE ACQUIRER REGISTRY (Phase 3) ─────────────────────────────────────────────────────────────
// docs/DOCUMENT_PRODUCTION_PLAN_2026-08-21.md §3 Phase 3: legis_acquire proved the pattern — a
// directed order fetches its OWN fuel inline and lands DATASET ROWS under the project. This
// registry generalizes it: acquirers keyed by what the topic actually names, each contributing
// (a) detect(topic) → a plan or null, (b) acquire({plan, slug, deps}) → rows landed, and
// (c) renderDims — which dimensions its data honestly supports (legislation: state × status;
// civic rosters: body × role). All directed-lane (inside a user-ordered turn — never
// quota-deferred), bounded, fail-soft: no acquirer match → the compose proceeds on held material.
//
// Acquirer #1 LEGISLATION wraps lib/legis_acquire verbatim (the P2 gate passed on it — its
// behavior must not drift). Acquirer #2 CIVIC-ROSTER reads the civic store (14k+ verified
// memberships: names, roles, districts, emails, phones, source URLs) — held data, zero network.

const la = require('./legis_acquire');

const _CIVIC_NOUN = /\b(?:contacts?|roster|leadership|directory|officials?|office\s*holders?|members?(?:hip)?)\b/i;
const _CIVIC_SCOPE = /\b(?:parish(?:es)?|county|counties|municipal|city|town|village|council|alderm[ae]n|police jur(?:y|ies)|school board|civic|mayor)\b/i;

const ACQUIRERS = [
  {
    name: 'legislation',
    renderDims: { rowKey: 'state', colKey: 'status', countKeys: ['state', 'status', 'tags'], trendKey: 'lastActionDate' },
    detect(topic) {
      const d = la.detect(topic);
      return d.states.length && d.query ? d : null;
    },
    async acquire({ plan, slug, deps }) {
      return la.acquire({
        ...plan,
        dispatch: deps.dispatch,
        insertDocument: deps.insertDocument,
        findExisting: deps.findExisting,
        landRows: deps.landRows,
        hasRowsFor: deps.hasRowsFor,
        log: deps.log,
      });
    },
  },
  {
    name: 'civic-roster',
    renderDims: { rowKey: 'body', colKey: 'role', countKeys: ['place', 'role'] },
    detect(topic) {
      const t = String(topic || '');
      if (!_CIVIC_NOUN.test(t) || !_CIVIC_SCOPE.test(t)) return null;
      let state = null;
      for (const [name, code] of Object.entries(la.STATE_CODES)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(t)) { state = code; break; }
      }
      // a place fragment ("Jefferson parish", "Terrebonne") narrows below; state alone is fine
      return { state, topic: t };
    },
    // Held data — the civic store IS the source; rows land instantly, no network, no sheets.
    async acquire({ plan, slug, deps }) {
      const out = { landed: 0, skipped: 0, rows: 0 };
      const d = deps.db.getDb();
      const args = [];
      let where = 'm.superseded_by IS NULL';
      if (plan.state) { where += ' AND b.state = ?'; args.push(plan.state); }
      const rows = d.prepare(
        `SELECT m.person_name, m.role, m.district, m.party, m.email, m.phone, m.source_url, m.confidence,
                b.title AS body_title, b.place, b.state
         FROM civic_memberships m JOIN civic_bodies b ON b.body_key = m.body_key
         WHERE ${where} ORDER BY b.place, b.title, m.person_name LIMIT 1200`
      ).all(...args);
      if (!rows.length) return out;
      const dsRows = rows.map((r) => ({
        entity: `${r.person_name} @ ${r.body_title}`,
        attrs: {
          name: r.person_name, body: r.body_title, place: r.place || undefined, state: r.state || undefined,
          role: r.role || undefined, district: r.district || undefined, party: r.party || undefined,
          email: r.email || undefined, phone: r.phone || undefined, confidence: r.confidence,
        },
        sourceUrl: r.source_url || '',
        provenance: `civic_store${plan.state ? ` state=${plan.state}` : ''}`,
      }));
      deps.landRows(dsRows);
      out.rows = dsRows.length;
      deps.log(`[civic-acquire] ${dsRows.length} verified membership row(s) → the project dataset (held data, no network)`);
      return out;
    },
  },
];

/** First acquirer whose detect fires → { name, plan, renderDims } | null. Pure. */
function detect(topic) {
  for (const a of ACQUIRERS) {
    try { const plan = a.detect(topic); if (plan) return { name: a.name, plan, renderDims: a.renderDims }; } catch {}
  }
  return null;
}

async function acquire({ name, plan, slug, deps }) {
  const a = ACQUIRERS.find((x) => x.name === name);
  if (!a) return { landed: 0, skipped: 0, rows: 0 };
  return a.acquire({ plan, slug, deps });
}

module.exports = { detect, acquire, ACQUIRERS };
