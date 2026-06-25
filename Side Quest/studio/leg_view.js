/*
 * Legislation surface — standardized VIEW model. Pure mappers from the engine's bill tools
 * (bill_facets / list_bills / search_bills / get_bill) → fixed render shapes. No model, no I/O —
 * read-only browser over ~1.46M bills. Grounded on REAL shapes captured live (2026-06-25). Third
 * ported Echo surface; same idiom as poll_view/crm_view. With 1.46M rows there is no "list all":
 * browse by facets (state/session/type/chamber/year, offset-paginated) or FTS search. See
 * project_echo_surface_port.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.LegView = api;
})(this, function () {
  'use strict';

  // Common bill-type codes → readable labels (the long tail keeps its raw code).
  const TYPE_LABEL = {
    HB: 'House Bill', SB: 'Senate Bill', A: 'Assembly', S: 'Senate', H: 'House', AB: 'Assembly Bill',
    HR: 'House Resolution', SR: 'Senate Resolution', HJR: 'House Joint Res', SJR: 'Senate Joint Res',
    HCR: 'House Concurrent Res', SCR: 'Senate Concurrent Res', HF: 'House File', SF: 'Senate File', LB: 'Legislative Bill',
  };
  const CHAMBER_LABEL = { house: 'House', senate: 'Senate', joint: 'Joint' };

  function stripMarks(s) { return String(s == null ? '' : s).replace(/<\/?mark>/gi, '').replace(/\s+/g, ' ').trim(); }
  function typeLabel(t) { return t ? (TYPE_LABEL[t] || t) : ''; }
  function chamberLabel(c) { return c ? (CHAMBER_LABEL[c] || c) : ''; }
  function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
  // bill summary fields carry "snippet — full"; take the lead clause for list rows.
  function leadSummary(s) { return stripMarks(s).split(' — ')[0].trim(); }

  // bill_facets payload → filter groups for the toolbar. Top-N per facet by count.
  function facetGroups(payload, top = 20) {
    const p = payload || {};
    const group = (key, label, labeler) => {
      const arr = Array.isArray(p[key]) ? p[key] : [];
      const opts = arr
        .filter(o => o && o.value != null && o.value !== '' && Number(o.count) > 0)
        .slice(0, top)
        .map(o => ({ value: String(o.value), label: labeler ? labeler(o.value) : String(o.value), count: Number(o.count) }));
      return { key, label, options: opts };
    };
    return [
      group('state', 'State', null),
      group('session', 'Session', null),
      group('bill_type', 'Type', typeLabel),
      group('chamber_origin', 'Chamber', chamberLabel),
      group('year', 'Year', null),
    ].filter(g => g.options.length);
  }

  // One bill row (from list_bills.rows OR search_bills.result) → a list item.
  function billRow(r) {
    return {
      id: r.bill_id,
      name: r.name || `${r.bill_type || ''} ${r.bill_number || ''}`.trim(),
      state: r.state || '', session: r.session || '', type: r.bill_type || '', typeLabel: typeLabel(r.bill_type),
      number: r.bill_number || '', year: r.introduced_year || null,
      chamber: r.chamber_origin || '', chamberLabel: chamberLabel(r.chamber_origin),
      sponsors: num(r.sponsor_count), yea: num(r.yea_count), nay: num(r.nay_count), related: num(r.related_count),
      summary: leadSummary(r.summary_match || r.summary_snippet),
    };
  }

  // list_bills payload {rows,total,has_more} → browse list.
  function billList(payload, offset = 0) {
    const p = payload || {};
    const items = (p.rows || []).map(billRow);
    return { total: num(p.total) || items.length, items, hasMore: !!p.has_more, offset: offset + items.length };
  }

  // search_bills payload {result:[...]} → search list.
  function searchList(payload) {
    return { items: ((payload && payload.result) || []).map(billRow) };
  }

  // get_bill payload → detail card with sponsors / votes / related bills.
  function billCard(b) {
    if (!b || !b.bill_id) return null;
    const rl = b.RelatedLists || {};
    const sponsors = (rl.sponsors || []).map(s => ({
      name: s.sponsor_name || `${s.FirstName || ''} ${s.LastName || ''}`.trim() || 'Unknown',
      party: s.Party__c || '', chamber: chamberLabel(s.Chamber__c) || (s.Chamber__c || ''),
      state: s.MailingState || '', linked: s.contact_id != null, contactId: s.contact_id || null,
      confidence: s.confidence != null ? s.confidence : null,
    }));
    const voterNames = (arr) => (arr || []).map(v => v.voter_name || v.sponsor_name || `${v.FirstName || ''} ${v.LastName || ''}`.trim()).filter(Boolean);
    return {
      id: b.bill_id, name: b.name || '', summary: stripMarks(b.summary_full || b.summary_snippet),
      state: b.state || '', session: b.session || '', type: b.bill_type || '', typeLabel: typeLabel(b.bill_type),
      number: b.bill_number || '', year: b.introduced_year || null,
      chamber: b.chamber_origin || '', chamberLabel: chamberLabel(b.chamber_origin),
      ocd: b.ocd_bill_id || '',
      counts: { sponsors: num(b.sponsor_count) || sponsors.length, yea: num(b.yea_count), nay: num(b.nay_count), related: num(b.related_count) },
      sponsors,
      votesYea: voterNames(rl.votes_yea), votesNay: voterNames(rl.votes_nay),
      related: (rl.related_bills || []).map(x => ({ name: x.name || x.bill_name || '', relation: x.relation || x.type || '', id: x.bill_id || null })),
    };
  }

  return { TYPE_LABEL, CHAMBER_LABEL, stripMarks, typeLabel, chamberLabel, leadSummary, facetGroups, billRow, billList, searchList, billCard };
});
