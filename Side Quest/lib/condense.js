/**
 * condense — the Consolidate + Iterate half of a directed research run's lifecycle.
 *
 * "Zoe IS the memory": a research run ACCRETES raw slices (the directed-focus driver), then this
 * layer CONDENSES them into one clean dossier at the end (Consolidate), and a later "expand / go
 * deeper" instruction re-inflates a slice of that dossier into a fresh, deeper run (Iterate). Same
 * Accrete→Consolidate→Iterate pattern the knowledge base already runs on, applied to research.
 *
 * This module is PURE (prompt builders, the map-reduce chunker, the expand-order detector + goal
 * seeder). All I/O — the cloud reasoner call, reading the run's file, writing the dossier, storing
 * the knowledge node — lives in main.js (where the tools/models are), so this is fully offline-
 * testable. Fail-safe by construction: every function returns a value, never throws on bad input.
 */
'use strict';

// ---------------------------------------------------------------------------
// CONDENSE — fold the raw accreted slices into one clean, deduped dossier.
// ---------------------------------------------------------------------------

const CONDENSE_SYS = `You are condensing a night's worth of raw research notes into ONE clean, final dossier for Lucas. Rules:
• Ground EVERY line in the raw notes below — never add an organization, person, email, or phone the notes don't contain. Omit what isn't there.
• NEVER carry over initials, abbreviations, or placeholders as if they were a real name (e.g. "R. Z." or "P. C." is NOT a name — write "not found"). Drop any leaked JSON, tool calls, or control text ({"thought":…}, {"action":…}) — it is noise, never content.
• DEDUPE ruthlessly: the notes repeat the same organizations many times in slightly different words — collapse each to a SINGLE entry.
• One section per organization, in this exact uniform shape:
  ## <Organization name>
  - **Focus:** <areas, one line>
  - **Key people:** <named individuals with roles; "not found" if the notes lack them>
  - **Contact:** <website / general email / phone / address / social; "not found" for any the notes lack>
• Open with a 2–3 sentence **Summary** and a count of organizations covered.
• End with a **Gaps** list naming organizations whose people or contacts are still missing (so the next pass knows where to dig).
Output clean Markdown only — no preamble, no "here is".`;

function buildCondensePrompt({ goal = '', raw = '' } = {}) {
  return [
    { role: 'system', content: CONDENSE_SYS },
    { role: 'user', content: `TASK THIS RESEARCH SERVED:\n${String(goal).slice(0, 600)}\n\nRAW RESEARCH NOTES (accreted slice by slice — full of repeats to collapse):\n"""\n${String(raw)}\n"""\n\nProduce the clean final dossier now.` }
  ];
}

// Merge step for a large run: several per-chunk condensations are themselves condensed into one.
function buildMergePrompt({ goal = '', parts = [] } = {}) {
  const joined = (Array.isArray(parts) ? parts : []).map((p, i) => `--- PARTIAL DOSSIER ${i + 1} ---\n${String(p || '')}`).join('\n\n');
  return [
    { role: 'system', content: CONDENSE_SYS + '\n\nThese inputs are ALREADY-condensed partial dossiers — MERGE them: combine duplicate organizations across partials into one entry each, union their people/contacts, and produce a single unified dossier.' },
    { role: 'user', content: `TASK THIS RESEARCH SERVED:\n${String(goal).slice(0, 600)}\n\nPARTIAL DOSSIERS TO MERGE:\n${joined}\n\nProduce the single unified dossier now.` }
  ];
}

// Split raw notes into chunks under maxChars for a map-reduce condense (the accreted file can exceed
// the model's context). Breaks on org/section boundaries ("## " headings) so an organization is never
// split across two chunks; a single oversized section is hard-split as a last resort.
function chunkForCondense(raw, maxChars = 24000) {
  const text = String(raw || '');
  if (text.length <= maxChars) return text.trim() ? [text] : [];
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur); cur = ''; };
  for (const line of lines) {
    const isHeading = /^##\s+/.test(line);
    if (cur && (isHeading && cur.length > maxChars * 0.6 || cur.length + line.length + 1 > maxChars)) push();
    if (line.length > maxChars) {            // a single monster line/section → hard-split
      if (cur) push();
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    cur += (cur ? '\n' : '') + line;
  }
  push();
  return chunks;
}

// ---------------------------------------------------------------------------
// EXPAND — recognize a "go deeper" order + seed a fresh, deeper directed run.
// ---------------------------------------------------------------------------

// Fires on an explicit deepen verb. main.js only ACTS on it when a prior dossier actually exists
// (meta research.last_dossier), so a liberal match here can't run off with a normal turn.
const EXPAND_RE = /\b(expand|go(?:ing)? deeper|dig(?:ging)? deeper|drill (?:down|into)|flesh(?:ing)? out|elaborate|deepen|go further|more detail|in more depth)\b/i;
const EXPAND_TARGET_RE = /\b(?:expand(?: on| the)?|go(?:ing)? deeper (?:on|into)|dig(?:ging)? deeper (?:on|into)|drill (?:down (?:on|into)|into)|flesh(?:ing)? out|elaborate on|deepen|more detail on|go further on)\s+(.*)$/i;

// A FACET-FILL expand names an ATTRIBUTE to collect ACROSS the already-known set ("…for their policy
// VPs", "get the government-relations contacts for each", "find the press leads at all of them"). When
// present, the expand is ENRICH (re-enter the known orgs + fill this facet), NOT discovery. The attribute
// vocabulary is deliberately about PEOPLE/CONTACTS/ROLES — the things a first-pass overview misses.
const ENRICH_ATTR = '(?:vice[\\s-]?presidents?|VPs?|directors?|heads?|chiefs?|officers?|leads?|managers?|executives?|leadership|staff|personnel|spokes\\w*|press\\s+(?:contacts?|leads?|secretar\\w+)|points?\\s+of\\s+contact|contacts?|emails?|phone\\s*numbers?|government[\\s-]?(?:affairs|relations)|public[\\s-]?(?:affairs|relations)|legislative\\s+(?:affairs|directors?)|policy\\s+(?:directors?|leads?|staff|teams?))';
// "for each / for their / on each / at all of them / across them …" + an attribute → a facet clause.
const ENRICH_FRAME_RE = new RegExp(`\\b(?:for|on|at|of|with|get|find|gather|pull|fill\\s+in|add)\\b[^.?!]{0,40}?\\b${ENRICH_ATTR}\\b`, 'i');
// Or the attribute simply appears alongside an "each / all of them / every one / their" quantifier.
const ENRICH_EACH_RE = new RegExp(`\\b${ENRICH_ATTR}\\b[^.?!]{0,40}?\\b(?:for\\s+)?(?:each|all\\s+of\\s+them|every\\s+(?:one|org\\w*)|their|them)\\b|\\b(?:each|all\\s+of\\s+them|every\\s+(?:one|org\\w*)|their|them|across)\\b[^.?!]{0,40}?\\b${ENRICH_ATTR}\\b`, 'i');

// Pull the facet phrase from a message that asks to enrich a known set. Returns a concise, self-contained
// description for the enrich prompt, or '' when no attribute clause is present.
function detectEnrichFacet(text) {
  const s = String(text || '');
  const m = s.match(ENRICH_FRAME_RE) || s.match(ENRICH_EACH_RE);
  if (!m) return '';
  // Use the whole clause around the match (clean, bounded) as the facet description.
  let facet = String(m[0] || '').replace(/\s+/g, ' ').trim().replace(/[.?!,;:]+$/, '');
  facet = facet.replace(/^(?:for|on|at|of|with|get|find|gather|pull|and|also)\s+/i, '').trim();
  return facet.slice(0, 140);
}

// The org names already in a dossier ("## <Org>" headings) — the work-list for an enrich run.
function dossierOrgs(dossier = '', limit = 60) {
  return (String(dossier).match(/^##\s+(.+)$/gim) || [])
    .map(h => h.replace(/^##\s+/, '').trim())
    .filter(Boolean)
    .filter(h => !/^(summary|gaps?|overview|notes?|task)\b/i.test(h))   // skip the dossier's own header sections
    .slice(0, limit);
}

function detectExpandOrder(text) {
  const s = String(text || '');
  if (!EXPAND_RE.test(s)) return { isExpand: false, target: '', enrichFacet: '' };
  const m = s.match(EXPAND_TARGET_RE);
  let target = m && m[1] ? m[1].trim() : '';
  target = target.replace(/^(the|on|about)\s+/i, '').replace(/[.?!]+$/, '').replace(/\s+/g, ' ').slice(0, 120);
  return { isExpand: true, target, enrichFacet: detectEnrichFacet(s) };
}

// Build the goal for the deepening sub-run. Concise + self-contained (it becomes the focus content,
// fed into every slice prompt) — names the in-scope orgs pulled from the prior dossier so the run
// deepens THOSE rather than starting from scratch, and demands the depth the first pass lacked.
function buildExpandGoal({ priorGoal = '', target = '', dossier = '' } = {}) {
  const orgs = (String(dossier).match(/^##\s+(.+)$/gim) || []).map(h => h.replace(/^##\s+/, '').trim()).filter(Boolean).slice(0, 20);
  const scope = target ? `, focusing specifically on: ${target}` : '';
  const orgList = orgs.length ? ` Organizations already identified${target ? ' (narrow to those that fit the focus)' : ''}: ${orgs.join(', ')}.` : '';
  const base = priorGoal ? ` This deepens the earlier task: "${String(priorGoal).slice(0, 160)}".` : '';
  return `Deepen and EXPAND prior research${scope}. For each relevant organization, go FURTHER than the earlier summary — full named staff/leadership with their roles, and direct contact details (work emails, phone numbers, LinkedIn/social).${orgList} Build on the prior findings and ADD depth; do not just restate them.${base}`.slice(0, 780);
}

module.exports = {
  buildCondensePrompt, buildMergePrompt, chunkForCondense,
  detectExpandOrder, buildExpandGoal, detectEnrichFacet, dossierOrgs,
  EXPAND_RE, CONDENSE_SYS
};
