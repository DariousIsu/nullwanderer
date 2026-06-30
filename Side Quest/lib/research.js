/**
 * research — the DEPTH-FIRST loop logic for a directed research run.
 *
 * The first driver was breadth-first + one-and-done: pick an org, ONE pass, next org. Lucas wanted it
 * to FOLLOW a target until a decent share of the material on it is gathered before moving on, and for
 * the data to be ORGANIZED with cloud passes as it goes (not only at the end). This module is the pure
 * brain of that two-level loop: parse a pass's control lines, decide whether to keep deepening the
 * current target or advance, estimate how much NEW material a pass added, and build the three prompts
 * (new-target overview / deepen-a-facet / organize-one-target). All I/O (operator + reasoner cloud
 * calls, file, db) lives in main.js; this stays pure + offline-testable.
 */
'use strict';

const MAX_PASSES_PER_TARGET = 6;   // depth cap per org — "a decent percentage", not infinite
const MIN_NEW_CHARS = 220;         // a deepen pass adding less than this = diminishing returns → advance

// Parse one research pass. The prompts make the operator end with a control line:
//   TARGET: <org>   (new-target pass)   |   FACET: <what was added>   (deepen pass)
//   SATURATED       (target well-covered)   |   ALL-COVERED   (whole universe done)
function parsePass(answer) {
  const ans = String(answer || '').trim();
  const allCovered = /\bALL[-\s]?COVERED\b/i.test(ans);
  const saturated = /\bSATURATED\b/i.test(ans);
  const tm = ans.match(/^\s*TARGET:\s*(.+?)\s*$/im);
  const fm = ans.match(/^\s*FACET:\s*(.+?)\s*$/im);
  const clean = (s) => String(s || '').trim().replace(/[*_#`]/g, '').slice(0, 80);
  const target = tm ? clean(tm[1]) : '';
  const facet = fm ? clean(fm[1]) : '';
  const body = ans
    .replace(/^\s*(?:TARGET|FACET):.*$/gim, '')
    .replace(/\bALL[-\s]?COVERED\b/i, '')
    .replace(/\bSATURATED\b/i, '')
    // strip any leaked operator control JSON ({"thought":…,"action":…}) so it never reaches the
    // deliverable file (the line-30 `{"thought":…}` blob misattributing a CEI fact to Heritage).
    .replace(/\{[^{}]*"(?:thought|action)"[^{}]*\}/gi, '')
    .trim();
  return { target, facet, saturated, allCovered, body };
}

// How much of `body` is genuinely NEW vs what we already gathered for this target — a cheap repeat
// detector so a pass that just restates known material counts as diminishing returns.
function newContentChars(existing, body) {
  const ex = String(existing || '');
  const segs = String(body || '').split(/[\n.]+/).map(s => s.trim()).filter(s => s.length > 20);
  if (!ex) return segs.reduce((n, s) => n + s.length, 0);
  let novel = 0;
  for (const s of segs) if (!ex.includes(s)) novel += s.length;
  return novel;
}

// Stay on the target or advance to the next one. Advance when the model says it's SATURATED, when the
// depth cap is hit, or when a pass (after the first couple) stops adding meaningful new material.
function decideAdvance({ passes = 1, newChars = 0, saturated = false, maxPasses = MAX_PASSES_PER_TARGET, minNew = MIN_NEW_CHARS } = {}) {
  if (saturated) return { advance: true, reason: 'saturated' };
  if (passes >= maxPasses) return { advance: true, reason: 'pass cap' };
  if (passes >= 2 && newChars < minNew) return { advance: true, reason: 'diminishing returns' };
  return { advance: false, reason: 'keep deepening' };
}

function facetsSummary(facets = []) {
  const f = (Array.isArray(facets) ? facets : []).filter(Boolean);
  return f.length ? f.join('; ') : '(nothing yet)';
}

// --- mid-run CLARIFICATION (Lucas refining the standing task while it runs) -----------------------

// While a directed run is active, decide whether a message is a CLARIFICATION/refinement to fold into
// the task (vs unrelated chatter). Tuned 2026-06-29 after live mis-captures: "Thank you Zoe" was
// captured (assistantAskedQuestion fired on a social reply) and "Rainey Center is a right-of-center
// think tank for example" was MISSED (no imperative keyword). Fix: hard-exclude social/gratitude/ack,
// and broaden the refinement language to catch informative scope statements ("X is a …", "for example",
// "as well", "counts", "consider").
const REFINE_RE = /\b(also|as well|in addition|additionally|make sure|focus on|prioriti[sz]e|priority|include|exclude|only|don'?t|do not|instead|actually|i want|i'?d like|i need|should|besides|on top of|skip|ignore|add|plus|but also|prefer|narrow|broaden|limit (?:it )?to|make it|as well as|consider|note that|keep in mind|for example|e\.?g\.?|counts?|is (?:a|an|one)\b|are (?:also|one)\b|too\b)\b/i;
// Social / gratitude / greeting / pure-ack — NEVER a research clarification (optional trailing name).
const SOCIAL_CLOSER_RE = /^(?:thanks?|thank you|ty|cheers|much appreciated|appreciate it|great|nice|cool|awesome|perfect|ok(?:ay)?|sounds good|got it|gotcha|sure|will do|hi|hey|hello|good (?:morning|night|evening|afternoon)|love you|you'?re the best)\b(?:\s+(?:zoe|so much|a lot|man|dude|babe|then))?[\s!.,]*$/i;
function isClarification({ message = '', assistantAskedQuestion = false } = {}) {
  const s = String(message).trim();
  if (s.length < 6) return false;
  if (SOCIAL_CLOSER_RE.test(s)) return false;                 // gratitude/greeting/ack ≠ task guidance
  return REFINE_RE.test(s) || !!assistantAskedQuestion;        // substantive refinement, or an answer to her question
}

// Is the user asking for a STATUS/progress update on the running task? (Concern 1: these were falling
// to the local voice model, which truncates + lacks the real state — they should be answered by a
// frontier model reading the actual progress. Caller gates on "a directed run is active".)
// Broadened (2026-06-29) — the old version missed the most natural phrasings: "How IS the think tank
// project going?" (needs "how's") and "what is the LIST you've done so far". Three shapes: a how-…-going
// progress check (handles "how is/are/'s … going/coming/progressing", words between), explicit status
// words, and a what/which/how-many … done/covered/list enumeration request.
const STATUS_RE = /(\bhow(?:'?s| is| are| has| have)?\b[^?.!]{0,45}\b(?:go(?:ing|ne)|coming|progress(?:ing)?|along|far)\b)|(\b(?:status|update|progress|so far|fill me in|catch me up|where (?:are|r) (?:you|we|u))\b)|(\b(?:what|which|how many)\b[^?.!]{0,45}\b(?:done|covered|researched|finished|found|the list|a list|list of|organi[sz]ations|think tanks|ones)\b)/i;
function isStatusRequest(text) { return STATUS_RE.test(String(text || '')); }

// Render the accumulated clarifications as a guidance block injected into every subsequent pass.
function buildGuidanceBlock(clarifications = []) {
  const c = (Array.isArray(clarifications) ? clarifications : []).filter(Boolean);
  if (!c.length) return '';
  return `ADDITIONAL GUIDANCE FROM LUCAS — incorporate ALL of these into your research from here on (they refine the task):\n${c.map(x => `- ${x}`).join('\n')}`;
}

// --- the three prompts -------------------------------------------------------

// New-target pass: pick ONE not-yet-done org and establish an overview (deepened over later passes).
function buildNewTargetPrompt({ goal = '', covered = [], guidance = '' } = {}) {
  const done = (covered && covered.length)
    ? `ORGANIZATIONS ALREADY FULLY DOCUMENTED (do NOT pick any of these again):\n${covered.map(c => `- ${c}`).join('\n')}`
    : 'None documented yet.';
  const g = guidance ? `\n\n${guidance}` : '';
  return `You are researching a standing task for Lucas, ONE organization at a time, in DEPTH.\n\nTASK: ${goal}${g}\n\n${done}\n\nTHIS PASS: pick ONE specific organization that fits the task and is NOT already documented, and write an OVERVIEW — full name, what it is, its main focus areas — grounded ONLY in what web_search / browser_read / echo / recall actually return (never invent). You will deepen it (staff, contacts, positions) over the next passes, so just establish it now.\nIf EVERY relevant organization is already documented, reply with exactly ALL-COVERED.\nEnd with a final line: TARGET: <the organization name>`;
}

// Deepen pass: stay on the current target, pursue the next missing facet, or declare it SATURATED.
function buildDeepenPrompt({ goal = '', target = '', facets = [], guidance = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  return `You are DEEP-researching ONE organization for Lucas's task, staying on it until it is well covered.\n\nTASK: ${goal}\nCURRENT ORGANIZATION: ${target}\nFacets already gathered on it: ${facetsSummary(facets)}\n${g}\nTHIS PASS: pursue the NEXT most valuable facet you do NOT yet have on ${target}, in priority order: (1) named leadership & key staff with their roles, (2) direct contact details (work emails, phone numbers, mailing address, key social/LinkedIn) — check the org's own /contact or /about page, (3) detailed policy positions / notable work, (4) funding & affiliations, (5) recent activity / publications. EXHAUST a good source before moving on: when you land on the organization's OWN site, use open_page to go straight into its /team, /leadership, /about and /contact pages (and follow promising links) — do NOT bounce to a fresh web_search until you've actually used the site you're on. Ground EVERY detail in what the tools return — never invent a name, email, or number. If you cannot verify a real, FULL name, write "not found" — NEVER use initials, abbreviations, or any placeholder (e.g. "R. Z." or "VP") in place of a real name.\nIf you have already gathered a solid, well-rounded picture of ${target} (what it is, its people, how to reach it, its positions), reply with exactly SATURATED and nothing else.\nEnd with a final line: FACET: <the facet you added this pass>`;
}

// --- ENRICH / FACET-FILL mode -----------------------------------------------
// The discovery loop above WALKS NEW orgs and AVOIDS the covered set (buildNewTargetPrompt tells the
// model "do NOT pick any already-documented org"). Enrich is its mirror image: re-ENTER a KNOWN set of
// orgs (pulled from a prior dossier) and fill ONE named facet across all of them — "expand the 21 think
// tanks FOR THEIR policy/government-relations VPs + contacts". Without this, an "expand … for their VPs"
// order drifts into discovering brand-new orgs (the live #2027 failure), because the only deepening the
// discovery loop knows is its own next-facet pass on the org it JUST opened — never the existing set.

// Pick the next source org not yet enriched (case-insensitive), or null when the facet is filled across
// all of them. Deterministic order = the source dossier's order, so the run is resumable + predictable.
function pickEnrichTarget({ sourceOrgs = [], enriched = [] } = {}) {
  const done = new Set((Array.isArray(enriched) ? enriched : []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
  for (const o of (Array.isArray(sourceOrgs) ? sourceOrgs : [])) {
    const name = String(o || '').trim();
    if (name && !done.has(name.toLowerCase())) return name;
  }
  return null;
}

// A short, clean label for the facet (used as the section field name). The full facet text stays in the
// prompt; this is only for the "## Org\n- **<label>:** …" header so sections read uniformly.
function facetLabel(facet = '') {
  const s = String(facet || '').replace(/[*_#`"]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Findings';
  return (s.length > 56 ? s.slice(0, 56).replace(/\s+\S*$/, '') + '…' : s);
}

// Enrich pass: fill ONLY the named facet for ONE KNOWN org. No TARGET/discovery control line — the org
// is given, the pass is single-purpose. parsePass still strips any leaked control JSON from the body.
function buildEnrichPrompt({ goal = '', org = '', facet = '', guidance = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  return `You are FILLING IN one specific piece of information about a KNOWN organization for Lucas. You are NOT looking for new organizations — the organization is fixed below.\n\nTASK: ${goal}\nORGANIZATION: ${org}\nWHAT TO FIND THIS PASS: ${facet}\n${g}\nGo to ${org}'s OWN website — its /team, /leadership, /staff, /about, /contact, /press pages — and any reliable source, and gather ONLY: ${facet}. For EACH person, give their FULL name and exact title, plus a direct work email / phone / LinkedIn where available. When you land on the org's own site, use open_page to go straight into its /team, /leadership, /about and /contact pages and follow promising links — do NOT bounce to a fresh web_search until you've actually used the site you're on. Ground EVERY detail in what web_search / browser_read / echo actually return — never invent a name, title, email, or number. If a real, FULL name cannot be verified, write "not found" — NEVER use initials, abbreviations, or "VP"/"the VP" as a stand-in for a real name.\nReport what you found for ${org} now.`;
}

// --- TWO-LANE DEEP RESEARCH (web lane ∥ deep/structured lane → merge) ------------------------------
// One target, worked CONCURRENTLY by two operators on two cloud models: the WEB lane hunts primary
// sources on the open internet (her browser + reliable fetch), the DEEP lane pulls authoritative
// STRUCTURED records the web won't surface (990 financials, federal funding, FEC, our knowledge graph).
// A merge pass then reconciles both raw streams into one section. This is the multi-cloud win: each
// lane runs the model that fits its work, in parallel, then we fold the results together.

// WEB lane: find the people/contacts/recent-activity on the open web. Browser + web fetch only.
function buildWebLanePrompt({ goal = '', org = '', facet = '', guidance = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  return `You are the WEB-RESEARCH lane for a known organization. Use the OPEN INTERNET only (her browser + web fetch) — another lane is separately pulling structured database records, so you do NOT need those.\n\nORGANIZATION: ${org}\nWHAT TO FIND: ${facet}\n${g}\nGo to ${org}'s OWN website (/team, /leadership, /staff, /about, /contact, /press) and reputable open-web sources, and gather: ${facet}. Give each person's FULL name, exact title, and any direct work email / phone / LinkedIn. Ground EVERY detail in what the tools actually return — never invent; write "not found" rather than a placeholder or initials. Report what you found for ${org}.`;
}

// DEEP lane: pull STRUCTURED, authoritative records — the things you can't get by browsing.
function buildDeepLanePrompt({ goal = '', org = '', facet = '', guidance = '' } = {}) {
  const g = guidance ? `\n${guidance}\n` : '';
  return `You are the DEEP / STRUCTURED-DATA lane for a known organization. Do NOT browse the open web (another lane does that). Use the STRUCTURED tools — IRS 990 financials, federal funding, FEC, and OUR knowledge graph — to surface authoritative records.\n\nORGANIZATION: ${org}\nFACET OF INTEREST: ${facet}\n${g}\nGATHER, where available: (1) nonprofit_lookup → the org's 990 leadership/board + exec-comp + revenue (often names the very officers the facet asks about); (2) gov_funding → federal grants/contracts it receives; (3) fec_lookup → any affiliated committees/PACs; (4) kg_search (+ kg_neighborhood on the id) → what OUR graph already knows about it and its people; (5) knowledge_search → our vault. Ground EVERY detail in what the tools return — never invent; write "not found" for anything missing. Report the structured findings for ${org}.`;
}

// MERGE: a reasoner folds the two raw lanes into ONE clean, deduped section. Reconcile overlaps (a
// person found by BOTH lanes = one entry, richest version), keep the union, mark provenance lightly.
function buildMergeLanesPrompt({ org = '', facet = '', webRaw = '', deepRaw = '' } = {}) {
  const label = facetLabel(facet);
  return [
    { role: 'system', content: `You merge two research streams on ONE organization — a WEB-lane stream (open-internet) and a DEEP-lane stream (structured databases: 990s, funding, FEC, our graph) — into a SINGLE clean section. Rules:\n• Ground ONLY in the two streams below — never add a name, title, email, or number not present; write "not found" for anything missing. NEVER use initials/abbreviations/placeholders as a name.\n• DEDUPE across lanes: a person or fact found by BOTH lanes is ONE entry — keep the richest version (e.g. web gives the LinkedIn, the 990 gives the comp/role) and combine them.\n• Drop any leaked JSON / tool/control text.\nOutput EXACTLY this Markdown and nothing else:\n## ${org || '<organization>'}\n- **${label}:** <named individuals with roles + direct contacts, one per line; or "not found">\n- **Financials & funding (structured):** <990 revenue / exec-comp / federal funding / FEC ties the deep lane found; or "not found">` },
    { role: 'user', content: `WEB-LANE FINDINGS on ${org}:\n"""\n${String(webRaw || '(none)').slice(0, 7000)}\n"""\n\nDEEP-LANE FINDINGS on ${org}:\n"""\n${String(deepRaw || '(none)').slice(0, 7000)}\n"""\n\nProduce the single merged section now.` }
  ];
}

// Organize the enrich findings on ONE org into a clean, facet-scoped section appended to the deliverable.
function buildOrganizeEnrichPrompt({ org = '', facet = '', raw = '' } = {}) {
  const label = facetLabel(facet);
  return [
    { role: 'system', content: `You organize raw research findings about ONE named facet for ONE organization into a single clean section. Ground ONLY in the notes — never add a name, title, email, or number not present; write "not found" for anything missing. NEVER use initials, abbreviations, or a placeholder in place of a real name (e.g. "R. Z." or "VP" is NOT a name — write "not found"). Drop any leaked JSON or tool/control text. Dedupe repeats. Output EXACTLY this Markdown and nothing else:\n## ${org || '<organization>'}\n- **${label}:** <named individuals with their roles and direct contact details, one per line; or "not found">` },
    { role: 'user', content: `RAW FINDINGS ON ${org} (facet: ${facet}):\n"""\n${String(raw).slice(0, 12000)}\n"""\n\nProduce the clean section now.` }
  ];
}

// Organize pass (reasoner): fold ONE target's accumulated raw passes into a single clean section.
function buildOrganizeTargetPrompt({ target = '', raw = '' } = {}) {
  return [
    { role: 'system', content: `You organize raw research notes on ONE organization into a single clean dossier section. Ground ONLY in the notes — never add a name, email, or number not present; write "not found" for anything missing. NEVER use initials, abbreviations, or a placeholder in place of a real name (e.g. "R. Z." or "P. C." is NOT a name — write "not found" instead). Drop any leaked JSON or tool/control text. Dedupe repeats. Output EXACTLY this Markdown and nothing else:\n## ${target || '<organization>'}\n- **Focus:** …\n- **Key people:** <named individuals with roles, or "not found">\n- **Contact:** <website / email / phone / address / social, or "not found">\n- **Positions / work:** …\n- **Funding & affiliations:** <or "not found">` },
    { role: 'user', content: `RAW NOTES ON ${target}:\n"""\n${String(raw).slice(0, 16000)}\n"""\n\nProduce the clean section now.` }
  ];
}

module.exports = {
  parsePass, newContentChars, decideAdvance, facetsSummary,
  isClarification, buildGuidanceBlock, isStatusRequest,
  buildNewTargetPrompt, buildDeepenPrompt, buildOrganizeTargetPrompt,
  pickEnrichTarget, facetLabel, buildEnrichPrompt, buildOrganizeEnrichPrompt,
  buildWebLanePrompt, buildDeepLanePrompt, buildMergeLanesPrompt,
  MAX_PASSES_PER_TARGET, MIN_NEW_CHARS
};
