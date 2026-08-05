'use strict';
/**
 * lib/contact_finders.js — THE single source of truth for the per-person CONTACT FINDER SET, its ORDER, and
 * the grounding rules that gate each finder. Both the interactive roster fill (main.js _defaultListLookup →
 * runContactCascade) and, going forward, any other caller build their finders HERE, so the finding logic has
 * exactly ONE home rather than being re-wired inline at each call site.
 *
 * WHY (Lucas, 2026-08-05 — "why does it feel like we are reinventing this process?"): finding people has been
 * the program's near-sole mission for weeks. The cure for the reinvention was to converge on shared LEAF
 * ORGANS — one domain resolver (lib/domain_resolve), one Hunter tool (Echo hunter_find_email), one pattern
 * engine (puller_walk.patternFillCandidate), one cross-store bridge (puller_db). This module is the last step:
 * the ORDER those organs fire in, and the rules for when each is allowed to land, now live in one place too.
 * See [[list-completion-lane]] [[whackamole-to-merge]] [[crm-is-the-ultimate-store]].
 *
 * The background Puller move (puller_walk.runPullerMove) stays a SEPARATE orchestration on purpose — it is a
 * one-target-per-idle-tick loop that lands into puller_db + Echo and owns its own cooldowns; it already reuses
 * the same leaf organs. Merging the two loops into one function would regress both (interactive fill needs a
 * synchronous first-hit return per arbitrary person; the move needs pickTarget + persistent landing). They
 * share organs, not control flow.
 *
 * A finder is { name, run: async(person) => ({ value, source, confidence } | null) }. `person` =
 * { name, surname, org, domain, query }. A finder that hits a TRANSIENT tool error throws
 * Object.assign(new Error(...), { transient: true }) so runContactCascade defers the row instead of blanking a
 * findable contact. Finders never fabricate — a miss is null, always.
 */

// Pure-ish: extract the person shape from a roster row + resolve its org domain via the SHARED resolver
// (the same organ the Puller uses). domain is the universal key that gates Hunter + pattern-fill; an
// unresolvable org yields '' (never a fabricated domain), which safely disables those two finders.
async function buildPerson(identity, { webSearch, log = () => {} } = {}) {
  const ent = Object.entries(identity || {});
  const vals = ent.map(([, v]) => String(v || ''));
  const nameVal = (ent.find(([k]) => /\bname\b/i.test(k)) || [])[1] || vals[0] || '';
  let last = (ent.find(([k]) => /last/i.test(k)) || [])[1] || '';
  if (!last && nameVal) { try { last = require('./roster_intake').surnameOf(nameVal); } catch {} }
  const org = (ent.find(([k]) => /org|title|company|chamber|agency|affili|employer/i.test(k)) || [])[1] || '';
  let domain = '';
  try { domain = await require('./domain_resolve').resolveDomain(org, { webSearch, log }) || ''; } catch {}
  return { name: nameVal, surname: last, org, domain, query: `${vals.join(' ')} email address`.trim() };
}

// Build the ordered finder array + the escalation callback. Deps are the app's I/O organs (kept as callbacks
// so this module stays offline-smoke-testable): webSearch (stealth lane), echoSuit (Echo dispatch), fetchPage.
function buildContactFinders({ webSearch, echoSuit, fetchPage, log = () => {} } = {}) {
  const lc = require('./list_complete');
  const pw = require('./puller_walk');

  // FINDER 0 — PULLER-DB BRIDGE: an email the background Puller already landed for this person flows back into
  // the canvas cell HERE (the cross-store bridge is a READ, not a new pipe). Masked/broker teasers rejected.
  const pullerdbFinder = { name: 'pullerdb', run: async (p) => {
    try {
      const pdb = require('./puller_db'); pdb.init();
      const t = pdb.findTargetByName && pdb.findTargetByName(p.name);
      if (t && t.id) { const b = pdb.getBelief(t.id, 'email'); const v = b && b.value;
        if (v && /@/.test(v) && !pw.looksMasked(v)) return { value: v, source: 'prior record (Puller)', confidence: (b && b.confidence != null ? Math.round(Number(b.confidence) * 100) : null) }; }
    } catch {}
    return null;
  }};
  // FINDER 1 — PATTERN-FILL: the domain's own LEARNED email format (cheap, no network; fires only above the
  // belief floor, so an absent/guessed domain safely yields nothing rather than a fabricated address).
  const patternFinder = { name: 'pattern', run: async (p) => {
    if (!p.domain || !p.name) return null;
    try {
      const pdb = require('./puller_db'); pdb.init();
      const cand = pw.patternFillCandidate(pdb.getPatternState(p.domain), p.name, p.domain, {});
      return cand && cand.email ? { value: cand.email, source: `domain pattern · ${p.domain}`, confidence: (cand.confidence != null ? Math.round(cand.confidence * 100) : null) } : null;
    } catch { return null; }
  }};
  // FINDER 2 — HUNTER.IO: name + explicit domain (or a company name Hunter resolves itself) → a scored,
  // verified email. Highest yield for corporate/.gov addresses. Runs THROUGH Echo (the HUNTER_API_KEY resolves
  // in Echo's keychain, not SQ's env). Tries the explicit domain first, then the company. Never fabricates.
  const hunterFinder = { name: 'hunter', run: async (p) => {
    if (!p.name) return null;
    const toks = p.name.replace(/\([^)]*\)/g, '').replace(/[^A-Za-z .'-]/g, '').trim().split(/\s+/).filter(Boolean);
    const first = toks[0] || '';
    const lastNm = p.surname || toks[toks.length - 1] || '';
    if (!first || !lastNm) return null;
    const attempts = [];
    if (p.domain) attempts.push({ first_name: first, last_name: lastNm, domain: p.domain });
    if (p.org) attempts.push({ first_name: first, last_name: lastNm, company: p.org });
    for (const args of attempts) {
      let r = null;
      try { r = await echoSuit.dispatch({ kind: 'do', name: 'hunter_find_email', args }); }
      catch (e) { throw Object.assign(new Error(`hunter dispatch threw: ${(e && e.message) || e}`), { transient: true }); }
      // Echo momentarily unreachable → dispatch resolves with a soft error, not a throw. That's TRANSIENT (a
      // findable contact must not be blanked by a blip): signal a retry rather than a miss.
      if (r && r.ok === false && /isn'?t connected|not connected|fetch failed|offline|not reachable|still starting/i.test(String(r.text || ''))) {
        throw Object.assign(new Error('echo suit unreachable this pass'), { transient: true });
      }
      let d = null; try { d = JSON.parse(String((r && r.text) || '')); } catch {}
      if (d && d.ok && d.email && /@/.test(d.email)) return { value: d.email, source: `Hunter · ${d.domain || p.domain || 'company'}`, confidence: (Number(d.score) || null) };
    }
    return null;
  }};
  // FINDER 3 — WEB: the app's working keyless stealth-Bing lane + full-page fetch → grounded extraction.
  // Echo's keyless web_search is only a last-ditch fallback (it returns nothing on this box, but costs nothing).
  const webFinder = { name: 'web', run: async (p) => {
    let text = '', urls = [];
    try { const sr = await webSearch(p.query); const rows = (sr && sr.results) || []; text = rows.map((r) => `${r.title || ''} ${r.snippet || ''} ${r.url || ''}`).join('\n'); urls = rows.map((r) => r.url).filter(Boolean); } catch {}
    if (!text.trim()) { try { const r = await echoSuit.dispatch({ kind: 'do', name: 'web_search', args: { query: p.query } }); text = String((r && r.text) || ''); urls = Array.from(new Set((text.match(/https?:\/\/[^\s"'<>)\]]+/g) || []))); } catch {} }
    try {
      const top = urls.filter((u) => !/\.(png|jpe?g|gif|svg|pdf|zip|docx?|xlsx?)$/i.test(u))
        .sort((a, b) => (/\.(gov|us|edu)(\/|$)/i.test(b) ? 1 : 0) - (/\.(gov|us|edu)(\/|$)/i.test(a) ? 1 : 0)).slice(0, 3);
      for (const u of top) { try { const fr = await fetchPage(u, { maxChars: 20000 }); const ft = typeof fr === 'string' ? fr : String((fr && fr.text) || ''); if (ft) text += '\n' + ft.slice(0, 20000); } catch { /* per-url fail-soft */ } }
    } catch { /* fetch stage fail-soft */ }
    const pick = lc.pickGroundedEmail(text, p.surname, { allowRoleGov: true });
    return pick ? { value: pick, source: 'web · grounded', confidence: null } : null;
  }};

  // ESCALATION — total miss hands the person to the model-driven Puller: seed a target so puller_walk's
  // discovery (pattern + her-browser web-discovery + extraction) pursues them; a later pass reads the landed
  // email via FINDER 0. Best-effort; a failure never fabricates a cell.
  const escalate = async (p) => {
    try {
      const pdb = require('./puller_db'); pdb.init();
      if (!(pdb.findTargetByName && pdb.findTargetByName(p.name))) {
        pdb.createTarget({ kind: 'person', name: p.name, company: p.org || null, domain: p.domain || null, notes: 'seeded by roster fill (web miss)' });
      }
    } catch {}
  };

  return { finders: [pullerdbFinder, patternFinder, hunterFinder, webFinder], escalate };
}

module.exports = { buildPerson, buildContactFinders };
