'use strict';
/**
 * lib/list_complete.js — the LIST-COMPLETION core: turn a canvas TABLE that has blank cells into per-ROW
 * research targets, and write a found value back into the exact cell. PURE (no I/O, no clock, no db) so it
 * is offline-smoke-testable; the pass in main.js does the canvas read/write and the grounded lookup.
 *
 * The gap it closes (2026-08-04): a "complete this list" focus fell into the org-DISCOVERY walk, which
 * opens NEW organizations — it mis-resolved a Louisiana parish roster to a Romanian university and never
 * touched the 45 blank email cells. A list is not a discovery target: its ROWS are the targets, each blank
 * cell in the requested column is ONE bounded lookup, and the answer goes back into that cell — not a
 * fresh org dossier. See [[detectors-vs-comprehension]] (the task shape was mis-read) and the audit that
 * caught it (2026-08-04). Related: lib/contacts_query.toTable is the same {headers, rows} table shape.
 */

// Identity columns describe WHO a row is (never fill these). Fillable columns are the ones a lookup can
// answer. The TASK picks the target column when it names one ("the missing emails" → 'email'); the
// most-blank-fillable fallback is only for a bare "complete this list" with no column named — and even
// then it never picks an identity column.
const _IDENTITY_HINTS = /^(office|chamber|body|last\s*name|first\s*name|full\s*name|name|party|district|parish|county|city|state|title|role|position|jurisdiction|seat)$/i;
const _FILLABLE_HINTS = /(e-?mail|phone|tel|mobile|cell|fax|url|web\s*site|website|address|contact|linkedin|twitter|handle)/i;

function _s(v) { return v == null ? '' : String(v); }
function _blank(v) { return _s(v).trim() === ''; }

// Accept the {headers, rows} shape (contacts_query.toTable) and tolerate {columns, data} variants.
function _shape(block) {
  const d = (block && (block.data || block)) || {};
  const headers = Array.isArray(d.headers) ? d.headers.map(_s)
    : Array.isArray(d.columns) ? d.columns.map((c) => _s(c && (c.label || c.name || c))) : [];
  const rows = Array.isArray(d.rows) ? d.rows.map((r) => (Array.isArray(r) ? r.map(_s) : []))
    : Array.isArray(d.data) ? d.data.map((r) => (Array.isArray(r) ? r.map(_s) : [])) : [];
  return { headers, rows };
}

// Pull the requested target column out of a free-text goal, e.g. "finding the missing emails" → 'email'.
function targetColumnFromGoal(goal) {
  const g = _s(goal).toLowerCase();
  const m = g.match(/\b(e-?mails?|phones?|phone numbers?|addresses?|websites?|urls?|faxes?|titles?|districts?)\b/);
  if (!m) return null;
  const w = m[1];
  if (/mail/.test(w)) return 'email';
  if (/phone/.test(w)) return 'phone';
  if (/address/.test(w)) return 'address';
  if (/website|url/.test(w)) return 'website';
  if (/fax/.test(w)) return 'fax';
  return null;
}

// Deterministic gate: is this goal a "complete / fill the missing <column> in this list/table" ask? A named
// fillable column + a complete/fill/missing verb + a list/table noun. Keeps a research or roster-BUILD ask
// from being hijacked (neither names a fillable column). PURE — the dispatch in main.js calls this.
function isListCompletionGoal(goal) {
  const g = _s(goal);
  return !!targetColumnFromGoal(g)
    && /\b(complete|fill|finish|populate|missing|fill\s*in)\b/i.test(g)
    && /\b(lists?|sheets?|tables?|rosters?|spreadsheets?|columns?|cells?)\b/i.test(g);
}

function parseTable(block, { targetColumn = null } = {}) {
  const { headers, rows } = _shape(block);
  if (!headers.length || !rows.length) return { ok: false, reason: 'not a populated table', headers, rows, targetIdx: -1, identityIdx: [] };
  let targetIdx = -1;
  if (targetColumn) {
    const want = _s(targetColumn).trim().toLowerCase();
    targetIdx = headers.findIndex((h) => h.trim().toLowerCase() === want);
    if (targetIdx < 0) targetIdx = headers.findIndex((h) => h.toLowerCase().includes(want)); // 'Email' matches 'Email Address'
  }
  if (targetIdx < 0) { // fallback: most-blank FILLABLE column (never an identity column)
    let best = -1, bestBlanks = -1;
    headers.forEach((h, i) => {
      if (_IDENTITY_HINTS.test(h.trim()) || !_FILLABLE_HINTS.test(h)) return;
      const blanks = rows.filter((r) => _blank(r[i])).length;
      if (blanks > bestBlanks) { bestBlanks = blanks; best = i; }
    });
    targetIdx = best;
  }
  if (targetIdx < 0) return { ok: false, reason: 'no fillable target column', headers, rows, targetIdx, identityIdx: [] };
  // identity columns = every non-target header that actually carries values (skip fully-empty columns)
  const identityIdx = headers.map((_, i) => i).filter((i) => i !== targetIdx && !_blank(headers[i]) && rows.some((r) => !_blank(r[i])));
  return { ok: true, reason: null, headers, rows, targetIdx, identityIdx };
}

function blankRows(parsed) {
  if (!parsed || !parsed.ok) return [];
  const out = [];
  parsed.rows.forEach((r, i) => { if (_blank(r[parsed.targetIdx])) out.push(i); });
  return out;
}

// A row's identity as {Header: value} over the identity columns — the material a lookup query is built from.
function rowIdentity(parsed, rowIndex) {
  const r = (parsed && parsed.rows[rowIndex]) || [];
  const id = {};
  (parsed.identityIdx || []).forEach((i) => { const v = r[i]; if (!_blank(v)) id[parsed.headers[i].trim()] = _s(v).trim(); });
  return id;
}

// Immutable cell write: returns a NEW {headers, rows} with (rowIndex, targetIdx) set to value.
function applyValue(parsed, rowIndex, value) {
  const rows = parsed.rows.map((r) => r.slice());
  if (rows[rowIndex]) rows[rowIndex][parsed.targetIdx] = _s(value).trim();
  return { headers: parsed.headers.slice(), rows };
}

// A local-part that names an OFFICE/ROLE rather than a person — the only kind of non-surname-matched address
// the looser mode will accept (see pickGroundedEmail). Generic role words + district-number patterns; a
// person-looking local-part (a DIFFERENT individual's name) is deliberately NOT here, so we never fill one
// row with another person's address.
const _ROLE_LOCALPART = /^(council|councilmember|clerk|office|info|contact|admin|administrator|mayor|president|chair|chairman|chairwoman|jury|policejury|board|government|govt|parish|county|city|district\d*|dist\d*|d\d+|main|general|reception|frontdesk|webmaster|help|support|hello|inquiries|enquiries|clerkofcourt|assessor)$/;

// Safety-critical: choose an email from search text that PLAUSIBLY belongs to `surname`, or null. A wrong
// email planted as fact is the failure to avoid, so the bar is high — the local-part must contain the
// surname (≥3 chars), junk/placeholder addresses are dropped, and an official (.gov/.us) host wins.
// opts.allowRoleGov (operator-approved 2026-08-04, opt-in — strict by default so the unit tests stay strict):
// when NO surname match exists, accept a ROLE/OFFICE address on an official (.gov/.us) host (council@,
// clerk@, district2@…). It still REJECTS a person-looking local-part on the page (that would be a DIFFERENT
// official, not this row's office). No acceptable email → null (leave the cell blank). PURE — unit-tested.
function pickGroundedEmail(text, surname, { allowRoleGov = false } = {}) {
  const last = _s(surname).toLowerCase().replace(/[^a-z]/g, '');
  const emails = Array.from(new Set((_s(text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => !/(example|sentry|noreply|no-reply|@2x|\.png|\.jpg|\.gif|domain\.com|email\.com|yourdomain)/.test(e))));
  if (!emails.length) return null;
  // BEST: an address whose local-part contains the person's surname (≥3 chars) — .gov/.us preferred.
  if (last.length >= 3) {
    const matches = emails.filter((e) => e.split('@')[0].replace(/[^a-z]/g, '').includes(last));
    if (matches.length) return matches.find((e) => /\.(gov|us)$/.test((e.split('@')[1] || ''))) || matches[0];
  }
  // LOOSER FALLBACK (opt-in): a role/office address on an OFFICIAL host, only when no surname match was found.
  if (allowRoleGov) {
    const roleGov = emails.filter((e) => {
      const [lp, host] = e.split('@');
      if (!/\.(gov|us)$/.test(host || '')) return false;
      const alpha = lp.replace(/[^a-z]/g, '');
      return _ROLE_LOCALPART.test(lp) || _ROLE_LOCALPART.test(alpha) || alpha.length <= 2;   // role word / district-number / non-name-like
    });
    if (roleGov.length) return roleGov[0];
  }
  return null;
}

module.exports = { parseTable, blankRows, rowIdentity, applyValue, targetColumnFromGoal, pickGroundedEmail, isListCompletionGoal };
