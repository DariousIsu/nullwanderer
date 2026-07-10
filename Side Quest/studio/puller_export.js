/* studio/puller_export.js — Puller → Echo handoff (Slice 6, chosen path: export in Contact shape).
 *
 * Maps promoted dossiers to rows shaped for Echo's CRM Contact table, so Echo can bulk-ingest them
 * (the planned pass76_bulk_prospects path) without any cross-process DB write. The qualification model
 * lands natively in Echo's own fields:
 *   Email_Quality_Score__c  ← qualification confidence (0–100)
 *   Email_Deliverable__c     ← 1 if independently verified (grade A/B), 0 if the held value bounced,
 *                              null (unknown) for pattern/guess/generic
 *   Contact_Kind__c='prospect', external_id='PULLER:<id>' (stable → pass78 dedupe/merge)
 *
 * PURE: takes already-built dossier items ({target, beliefs, qualification}); the IPC layer composes
 * them via buildDossier. SEND-SAFETY GATE (validated best practice): conflicted (bounced) contacts
 * are excluded by default, and an optional minGrade floor drops weak rows — never silently.
 */
'use strict';
const Q = require('./puller_confidence');

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function splitName(name) {
  const parts = String(name || '').replace(/['’]/g, '').split(/\s+/).filter(Boolean)
    .filter(p => !SUFFIXES.has(p.toLowerCase().replace(/\.$/, '')));
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: '', last: parts[0] };   // LastName is NOT NULL in Echo
  return { first: parts[0], last: parts[parts.length - 1] };
}
function beliefVal(beliefs, type) { const b = (beliefs || []).find(x => x.type === type); return b ? b.value : null; }

// A contact is SUPPRESSED if the held email carries a suppression observation (a complaint / do-not-send).
// Suppression ≠ invalidity, so it never shows as a bounce/conflict — but we must NEVER re-mail a complainer
// (CAN-SPAM/GDPR). Detected from the dossier's observation trail (kind 'suppressed') on the held value.
function isSuppressed(item) {
  const held = String(beliefVal(item && item.beliefs, 'email') || '').trim().toLowerCase();
  const obs = (item && item.observations) || [];
  return obs.some(o => o && o.kind === 'suppressed' && (!held || String(o.value || '').trim().toLowerCase() === held));
}

// grade → Email_Deliverable__c: only an independently-verified grade asserts deliverability.
function deliverableFlag(q) {
  if (!q || !q.grade) return null;
  if (q.conflicted) return 0;                          // held value bounced
  if (q.grade === 'A' || q.grade === 'B') return 1;    // dedicated source / independently verified
  return null;                                         // C/D/E — not asserted
}

// Map one dossier item → a Contact-shaped row. `Company` is a helper column (not a Contact column) for
// Echo's ingest to resolve → AccountId.
function contactRow(item) {
  const t = item.target || {};
  const q = item.qualification || null;
  const { first, last } = splitName(t.name);
  const grade = q && q.grade ? q.grade : '—';
  return {
    external_id: `PULLER:${t.id}`,
    FirstName: first,
    LastName: last,
    Title: beliefVal(item.beliefs, 'role') || '',
    Email: beliefVal(item.beliefs, 'email') || '',
    Phone: beliefVal(item.beliefs, 'phone') || '',
    Company: t.company || '',
    Contact_Kind__c: 'prospect',
    Email_Quality_Score__c: q ? Math.round((q.confidence || 0) * 100) : null,
    Email_Deliverable__c: deliverableFlag(q),
    Enrichment_Stage__c: 'complete',
    Notes_Private__c: `Puller prospect — qualification grade ${grade}${q && q.conflicted ? ' (CONFLICT/bounced)' : ''}; source: ${t.domain || 'n/a'}`,
  };
}

const COLUMNS = ['external_id', 'FirstName', 'LastName', 'Title', 'Email', 'Phone', 'Company',
  'Contact_Kind__c', 'Email_Quality_Score__c', 'Email_Deliverable__c', 'Enrichment_Stage__c', 'Notes_Private__c'];

// Build export rows with the send-safety gate. opts.minGrade (default 'E' = allow all positive grades;
// pass 'B' to send only verified). opts.includeConflicted (default false). Returns {rows, excluded[]}.
function toContactRows(items, opts = {}) {
  const minGrade = opts.minGrade || 'E';
  const includeConflicted = !!opts.includeConflicted;
  const floor = Q.ORDER.indexOf(minGrade);            // lower index = stronger
  const rows = [], excluded = [];
  for (const it of (items || [])) {
    const q = it.qualification;
    const grade = q && q.grade;
    if (!grade) { excluded.push({ id: it.target && it.target.id, reason: 'no grade' }); continue; }
    // SUPPRESSION gate — a complainer is NEVER re-mailed, regardless of grade (compliance). Not overridable.
    if (isSuppressed(it)) { excluded.push({ id: it.target.id, reason: 'suppressed/complaint' }); continue; }
    if (q.conflicted && !includeConflicted) { excluded.push({ id: it.target.id, reason: 'conflicted/bounced' }); continue; }
    if (Q.ORDER.indexOf(grade) > floor) { excluded.push({ id: it.target.id, reason: `below minGrade ${minGrade}` }); continue; }
    rows.push(contactRow(it));
  }
  return { rows, excluded };
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows) {
  const head = COLUMNS.join(',');
  const body = (rows || []).map(r => COLUMNS.map(c => csvCell(r[c])).join(',')).join('\n');
  return body ? head + '\n' + body : head + '\n';
}

module.exports = { toContactRows, contactRow, toCSV, splitName, deliverableFlag, isSuppressed, COLUMNS };
