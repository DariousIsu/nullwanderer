/*
 * CRM (Rolodex) surface — standardized VIEW model. Pure mappers from the engine's contact tools
 * (contact_facets / list_contacts_compact / list_contacts_page / search_contacts / get_contact)
 * → fixed render shapes the surface draws. No model, no I/O — read-only browser. Grounded on the
 * REAL shapes captured live (2026-06-25). Second ported Echo surface; same idiom as poll_view.js.
 * v1 = browse + facets + search + detail card (scalars + related-list counts); rich related-list
 * rendering is polish-pass work (the doc flags CRM for a UI overhaul). See project_echo_surface_port.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CrmView = api;
})(this, function () {
  'use strict';

  const PARTY_LABEL = {
    R: 'Republican', D: 'Democrat', I: 'Independent', L: 'Libertarian', G: 'Green',
    W: 'Whig', WHIG: 'Whig', FED: 'Federalist', F: 'Federalist', J: 'Jacksonian', JACK: 'Jacksonian',
    O: 'Other', A: 'Anti-Admin', POPULIST: 'Populist', CONS: 'Conservative',
  };
  // RelatedLists key → friendly label (Salesforce-shape from get_contact include_related).
  const RELATED_LABEL = {
    committee_memberships: 'Committees', vote_records: 'Votes', donations_received: 'Donations received',
    donations_made: 'Donations made', polling_results: 'Polling', statements: 'Statements',
    press_mentions: 'Press', endorsements_given: 'Endorsements given', endorsements_received: 'Endorsements received',
    social_handles: 'Social', aliases: 'Aliases', bio_events: 'Bio events', media: 'Media', notes: 'Notes',
    known_associates_a: 'Associates', known_associates_b: 'Associates', tasks: 'Tasks', events: 'Events', staff_roster: 'Staff',
  };

  function stripMarks(s) { return String(s == null ? '' : s).replace(/<\/?mark>/gi, '').replace(/\s+/g, ' ').trim(); }
  function partyLabel(p) { return p ? (PARTY_LABEL[p] || p) : ''; }
  function chamberLabel(c) { return c ? String(c).replace(/_/g, ' ') : ''; }
  function fullName(fn, ln) { return `${fn || ''} ${ln || ''}`.replace(/\s+/g, ' ').trim(); }

  // contact_facets payload → filter groups for the toolbar. Top-N per facet by count, junk dropped.
  function facetGroups(payload, top = 16) {
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
      group('party', 'Party', partyLabel),
      group('chamber', 'Chamber', chamberLabel),
      group('state', 'State', null),
      group('tier', 'Tier', null),
    ].filter(g => g.options.length);
  }

  // list_contacts_compact payload → browse list: total + the 20-row sample mapped to items.
  function browseList(payload) {
    const p = payload || {};
    const cols = p.sample_columns || ['id', 'FirstName', 'LastName', 'MailingState', 'Chamber__c', 'District__c', 'Party__c'];
    const items = (p.sample || []).map(row => {
      const r = {}; cols.forEach((c, i) => { r[c] = row[i]; });
      return {
        id: r.id, name: fullName(r.FirstName, r.LastName), state: r.MailingState || '',
        chamber: r.Chamber__c || '', chamberLabel: chamberLabel(r.Chamber__c),
        district: r.District__c || '', party: r.Party__c || '', partyLabel: partyLabel(r.Party__c),
      };
    });
    return { total: Number(p.total) || items.length, items, cursor: p.cursor || null, shown: items.length };
  }

  // search_contacts payload (full rows + rank) → search result items.
  function searchList(payload) {
    const rows = (payload && payload.result) || [];
    return {
      items: rows.map(r => ({
        id: r.id, name: fullName(r.FirstName, r.LastName) || stripMarks(r.name_snippet),
        title: r.Title || '', state: r.MailingState || r.District__c || '', chamber: r.Chamber__c || '',
        chamberLabel: chamberLabel(r.Chamber__c), party: r.Party__c || '', partyLabel: partyLabel(r.Party__c),
        snippet: stripMarks(r.notes_snippet),
      })),
    };
  }

  // Minimal quote-aware CSV row splitter (names contain commas — must respect quotes).
  function csvSplit(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  // list_contacts_page payload {csv, next_cursor} → more items + next cursor.
  function pageRows(payload) {
    const p = payload || {};
    const lines = String(p.csv || '').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return { items: [], cursor: p.next_cursor || null };
    const header = csvSplit(lines[0]);
    const items = lines.slice(1).map(line => {
      const cells = csvSplit(line); const r = {}; header.forEach((h, i) => { r[h] = cells[i]; });
      return {
        id: r.id, name: fullName(r.FirstName, r.LastName), state: r.MailingState || '',
        chamber: r.Chamber__c || '', chamberLabel: chamberLabel(r.Chamber__c),
        district: r.District__c || '', party: r.Party__c || '', partyLabel: partyLabel(r.Party__c),
      };
    });
    return { items, cursor: p.next_cursor || null };
  }

  // get_contact payload → detail card: scalar fields + non-empty related-list counts.
  function contactCard(c) {
    if (!c || !c.id) return null;
    const rl = c.RelatedLists || {};
    const related = Object.keys(rl)
      .filter(k => Array.isArray(rl[k]) && rl[k].length)
      .map(k => ({ key: k, label: RELATED_LABEL[k] || k.replace(/_/g, ' '), count: rl[k].length }))
      // merge the two known_associates buckets into one chip
      .reduce((acc, x) => { const hit = acc.find(a => a.label === x.label); if (hit) hit.count += x.count; else acc.push(x); return acc; }, []);
    return {
      id: c.id, name: fullName(c.FirstName, c.LastName), title: c.Title || '',
      party: c.Party__c || '', partyLabel: partyLabel(c.Party__c),
      chamber: c.Chamber__c || '', chamberLabel: chamberLabel(c.Chamber__c),
      state: c.MailingState || c.District__c || c.Jurisdiction__c || '', jurisdiction: c.Jurisdiction__c || '',
      district: c.District__c || '', kind: c.Contact_Kind__c || '',
      email: c.Email || c.Official_Email || '', phone: c.Phone || c.MobilePhone || '',
      tier: c.Tier__c || '', engagement: c.Engagement_Stage__c || '',
      activeElected: c.Active_Elected__c === 1 || c.Active_Elected__c === true,
      account: c.Account && c.Account.Name ? c.Account.Name : '',
      bioguide: c.Bioguide_Id__c || '', ocd: c.OCD_Person_Id__c || '',
      notesPublic: c.Notes_Public__c || '',
      ids: [c.Bioguide_Id__c && `Bioguide ${c.Bioguide_Id__c}`, c.OCD_Person_Id__c && 'OCD'].filter(Boolean),
      related,
    };
  }

  return { PARTY_LABEL, RELATED_LABEL, stripMarks, partyLabel, chamberLabel, fullName, facetGroups, browseList, searchList, csvSplit, pageRows, contactCard };
});
