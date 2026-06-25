/*
 * Polling surface — the standardized VIEW model (the determinism-law "one output shape" layer for
 * the first ported Echo data-browser). Pure mappers from the engine's polling tool payloads
 * (list_pollings / get_poll / get_poll_question / list_poll_issues) → fixed render shapes the
 * surface draws. No model, no I/O here — Polling is a read-only dashboard, so the discipline is
 * just: every tool payload normalizes to one card/bar/row shape, grounded on the REAL shapes
 * captured live (2026-06-25). See docs/SUPER_SEARCH_SPEC.md for the studio idiom this follows.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PollView = api;
})(this, function () {
  'use strict';

  const SOURCE_LABEL = { rainey: 'Rainey', '538': '538', pew: 'Pew' };
  const FRAME_LABEL = { RV: 'Registered voters', LV: 'Likely voters', A: 'Adults', V: 'Voters' };
  // issue severity → the kit's verdict class (reused from the shared pill palette).
  const SEVERITY_VERDICT = { error: 'bad', warn: 'warn', info: 'info', notice: 'info' };

  function basename(p) { return String(p || '').split(/[\\/]/).pop() || ''; }
  function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }
  function dateRange(a, b) {
    if (a && b && a !== b) return `${a} – ${b}`;
    return a || b || '';
  }

  // One fielding (from list_pollings OR get_poll) → a compact list item for the left rail.
  function fieldingListItem(f) {
    const m = f.meta || {};
    return {
      id: f.fielding_id,
      title: f.title || f.fielding_id,
      date: f.fielded_start || '',
      source: f.source_kind || '',
      sourceLabel: SOURCE_LABEL[f.source_kind] || (f.source_kind || ''),
      sampleSize: num(f.sample_size),
      questionCount: num(m.question_count) || 0,
      hasIssues: Array.isArray(f.open_issues) ? f.open_issues.length > 0 : false,
    };
  }

  // Full fielding card (from get_poll) → the methodology header shape.
  function fieldingCard(f) {
    const m = f.meta || {};
    return {
      id: f.fielding_id,
      title: f.title || f.fielding_id,
      dateRange: dateRange(f.fielded_start, f.fielded_end),
      source: f.source_kind || '',
      sourceLabel: SOURCE_LABEL[f.source_kind] || (f.source_kind || ''),
      pollster: f.pollster || f.vendor || '',
      sponsor: f.sponsor || '',
      sampleSize: num(f.sample_size),
      moe: num(f.moe_pct),
      frame: f.frame || '',
      frameLabel: FRAME_LABEL[f.frame] || (f.frame || ''),
      mode: f.mode || '',
      weighting: f.weighting || '',
      themes: f.themes || '',
      notes: f.notes || '',
      files: (f.files || []).map(x => ({ role: x.role, name: basename(x.source_pdf_path || x.markdown_path), pages: num(x.page_count) })),
      openIssues: (f.open_issues || []).length,
      counts: {
        questions: num(m.question_count) || (f.questions || []).length,
        toplines: num(m.topline_count) || 0,
        crosstabs: num(m.crosstab_count) || 0,
        files: num(m.file_count) || (f.files || []).length,
      },
    };
  }

  // One question's topline (from get_poll questions[] OR get_poll_question) → wording + bars.
  // Each option becomes a bar with a clamped width %; net rows (is_net) are flagged so the surface
  // can render them distinctly (they sum differently — not part of the 100%).
  function toplineBars(q) {
    const opts = Array.isArray(q.options) ? q.options.slice() : [];
    opts.sort((a, b) => (num(a.ordinal) ?? 0) - (num(b.ordinal) ?? 0));
    const top = opts.filter(o => !o.is_net).reduce((mx, o) => Math.max(mx, num(o.pct) || 0), 0);
    return {
      id: q.question_id,
      number: q.question_number || '',
      wording: q.wording || '',
      isLeader: null,
      options: opts.map(o => {
        const pct = num(o.pct) || 0;
        return {
          label: o.label || '',
          pct,
          pctText: `${pct}%`,
          isNet: !!o.is_net,
          // bar width relative to the largest non-net option, so small spreads stay readable
          width: top > 0 ? Math.round((pct / top) * 100) : 0,
          isMax: !o.is_net && pct === top && top > 0,
        };
      }),
    };
  }

  // One triage issue (from list_poll_issues) → a row with a verdict class.
  function issueRow(i) {
    return {
      id: i.issue_id,
      fielding: i.fielding_id || '',
      severity: i.severity || 'info',
      verdict: SEVERITY_VERDICT[i.severity] || 'info',
      kind: i.kind || '',
      detail: i.detail || '',
      file: basename(i.source_path),
      open: i.resolved_at == null,
    };
  }

  // Whole get_poll payload → the surface's fielding view: { card, questions[] }.
  function pollView(f) {
    return { card: fieldingCard(f), questions: (f.questions || []).map(toplineBars) };
  }

  // list_pollings payload (or its .result) → list items, optionally filtered to a source kind.
  function fieldingList(payload, opts = {}) {
    const rows = Array.isArray(payload) ? payload : (payload && payload.result) || [];
    let items = rows.map(fieldingListItem);
    if (opts.source) items = items.filter(x => x.source === opts.source);
    return items;
  }

  return {
    SOURCE_LABEL, FRAME_LABEL, SEVERITY_VERDICT,
    basename, dateRange,
    fieldingListItem, fieldingCard, toplineBars, issueRow, pollView, fieldingList,
  };
});
