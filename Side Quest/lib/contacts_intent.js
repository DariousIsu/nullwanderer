/**
 * lib/contacts_intent.js — LLM-PRIMARY intent classifier for the CONTACTS-LIST route.
 *
 * The disease this cures (Lucas): the contacts route was gated by a REGEX (contacts_query.detect) as the
 * PRIMARY classifier, with the LLM never consulted — the inverse of how it should be. Every novel phrasing
 * ("build a sheet", "create a sheet listing…", "A, B, and C level") slipped the regex and never routed.
 *
 * The fix, mirroring lib/intake.js: ONE fast cloud pass COMPREHENDS the turn — is this a request to LIST /
 * build a sheet of contacts we ALREADY HOLD, and with what filters — and returns the same ask shape the
 * regex produced. contacts_query.detect is DEMOTED to the fail-safe fallback (cloud down/invalid → the
 * caller uses the regex). EXECUTION stays local (Puller/CRM select + canvas) either way, so a cloud outage
 * degrades to the regex and still produces the list — the reliability the "local + early" design wanted,
 * without sacrificing natural-language understanding.
 *
 * classify() is the cloud seam (deps.ask injectable → fully offline-testable). Returns:
 *   { isQuery, type, grade, gradeDir, state, sectors, company, limit }  — same shape as detect(), OR
 *   null                                                                — cloud down/invalid → regex fallback.
 */
'use strict';
const cloud = require('./cloud_logic');
const cq = require('./contacts_query');

const _GRADES = new Set(['A', 'B', 'C', 'D', 'E']);
const _TYPES = new Set(['corporate', 'elected', 'gov']);
const _SECTOR_KEYS = Object.keys(cq.SECTORS);

// Sanitize the raw LLM object into the validated ask shape (never trust the model's fields blindly).
function _shape(raw) {
  const grade = raw && raw.grade && _GRADES.has(String(raw.grade).toUpperCase()) ? String(raw.grade).toUpperCase() : null;
  const type = raw && _TYPES.has(raw.type) ? raw.type : null;
  const state = raw && raw.state && /^[A-Za-z]{2}$/.test(String(raw.state).trim()) ? String(raw.state).trim().toUpperCase() : null;
  const sectors = raw && Array.isArray(raw.sectors) ? raw.sectors.filter((x) => _SECTOR_KEYS.includes(x)) : [];
  const company = raw && typeof raw.company === 'string' && raw.company.trim().length >= 2 ? raw.company.trim() : null;
  const limit = raw && Number.isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= 5000 ? raw.limit : null;
  const gradeDir = raw && raw.gradeDir === 'lte' ? 'lte' : 'gte';
  return { isQuery: true, type, grade, gradeDir, state, sectors, company, limit };
}

async function classify(message, { recent = '', deps = {} } = {}) {
  const ask = deps.ask || cloud.ask;
  const s = String(message || '').trim();
  if (s.length < 4) return { isQuery: false };
  const fastModel = (() => { try { return require('./models').getModelFor('editor', null); } catch { return null; } })();
  try {
    const raw = await ask({
      task: 'contacts_intent', v: 1, model: fastModel, numPredict: 320,
      input: { user: s.slice(0, 700), recent: String(recent).slice(0, 400) },
      want: 'You decide if the user is asking to LIST / compile / build a sheet of CONTACTS (people, companies, '
        + 'officials) we ALREADY HOLD — a pull of records we have on hand, NOT researching or finding NEW ones — '
        + 'and you extract the filters. '
        + 'Output ONLY JSON: {"isList":true|false,"type":"corporate"|"elected"|"gov"|null,"grade":"A"|"B"|"C"|"D"|"E"|null,'
        + '"gradeDir":"gte"|"lte","state":"2-letter US state code or null","sectors":[],"company":"a specific company name or null","limit":<int or null>}. '
        + 'isList=true for ANY phrasing that asks for the contacts/people/companies/officials we HAVE or HOLD — '
        + '"list / give me / show / pull / compile / export / build a sheet / create a spreadsheet / make a roster / '
        + 'draw up a table / who do we have". isList=FALSE for researching NEW contacts ("find new", "research", '
        + '"from scratch", "go discover"), a plain question, a status check, or chat. '
        + 'type: "corporate" = private companies/businesses; "elected" = elected officials/legislators; "gov" = '
        + 'government/agencies; null if unspecified OR if they want BOTH ("government and private", "public and '
        + 'private", "all types" → null = no type filter, include everyone). '
        + 'grade = the confidence-tier FLOOR (A is best … E worst). "C or higher" / "A, B, and C level" / "grade C '
        + 'and up" → grade="C", gradeDir="gte". "D or lower" → grade="D", gradeDir="lte". null if no tier mentioned. '
        + 'state = the 2-letter code if a US state is named (Louisiana→LA, Texas→TX), else null. '
        + `sectors = any of these industry tags the user named, else []: ${_SECTOR_KEYS.join(', ')}. `
        + 'company = a specific company name if they asked for one company ("contacts at Duke Energy"→"Duke Energy"), else null. '
        + 'limit = a requested count ("top 100")→100, else null. Be decisive.',
      validate: (r) => {
        const mm = String(r || '').match(/\{[\s\S]*\}/);
        if (!mm) return { valid: false, error: 'no json' };
        try { const o = JSON.parse(mm[0]); return o && typeof o.isList === 'boolean' ? { valid: true, value: o } : { valid: false, error: 'no isList' }; }
        catch (e) { return { valid: false, error: e.message }; }
      },
      deps,
    });
    if (raw == null) return null;                 // cloud down/invalid → caller falls back to the regex
    if (raw.isList !== true) return { isQuery: false };
    return _shape(raw);
  } catch (e) { console.error('[contacts-intent] classify failed:', e.message); return null; }
}

module.exports = { classify, _shape };
