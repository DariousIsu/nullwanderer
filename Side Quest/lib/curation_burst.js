/* lib/curation_burst.js — W2 of the swarm substrate (docs/SWARM_SUBSTRATE_2026-08-30.md §T3):
 * THE CURATION SWARM, PEOPLE FIRST. The people-curator (registered engine-side 08-30, revet-clean)
 * rides the nightly dedup/fusion drain as a PROPOSER burst: it sweeps duplicate-suspect person
 * records at cluster context and files proposals; the existing gates (run_dedup_adjudication, the
 * fusion gate, operator review) keep the pen. THE ONE RAIL: curators PROPOSE, gates DECIDE — the
 * agent's manifest holds no merge/decide/update tool, and this module never dispatches one.
 * Pure logic here (gates, seed SQL, task spec, deposit note); the spawn/harvest lives in main.js
 * beside the flare it mirrors. Kill switch: meta swarm.curators=off. Operator kick: meta
 * curation.kick=1 fires the next watcher tick (the acceptance-drive door), then clears itself. */
'use strict';

const AGENT = 'people-curator';        // the registry's hyphenated name (the §70 law)
const CURATOR_TAB = 'curation-swarm';  // quiet canvas (rail 3) — never litters the workspace
const KILL_KEY = 'swarm.curators';     // meta 'off' disarms the whole tier without a build
const PACE_KEY = 'curator.people.last_ts';
const KICK_KEY = 'curation.kick';      // operator knob: '1' → fire once, self-clearing
const PACE_MS = (parseFloat(process.env.ZOE_CURATOR_PACE_HRS) || 12) * 60 * 60 * 1000;

// THE COUNTED ROWS seed (the §59b law: evidence is queried, never storied) — duplicate-suspect
// person names. The import disease writes "Name [source-fragment]" variants beside the bare name
// (the Keeter case: one bare + five suffixed rows). But a bracket suffix is only NOISE when it is
// import-text; an FEC/bioguide ID in brackets ([P00017020], [H2CO01165]) is a PER-PERSON identity
// marker — the curator's own kick-3 flag: distinct IDs sharing a name are distinct humans, not
// dupes. So only a suffix containing a lowercase letter folds — detected as "differs from its own
// upper()" because the engine's db_query AST gate refuses GLOB (proven live) and LIKE is
// case-blind. Groups that actually contain suffixed variants rank first, so the import disease
// outranks mere name-twins in the worklist (proven: keeter c=6 rides the refined top-12; the
// catalano-class FEC twins dropped out).
const SEED_SQL = `WITH p AS (
  SELECT id, name,
         CASE WHEN instr(name, ' [') > 0 AND substr(name, instr(name, ' [')) <> upper(substr(name, instr(name, ' [')))
              THEN lower(trim(substr(name, 1, instr(name, ' [') - 1)))
              ELSE lower(trim(name)) END AS base,
         (instr(name, ' [') > 0 AND substr(name, instr(name, ' [')) <> upper(substr(name, instr(name, ' [')))) AS folded
  FROM entities WHERE entity_type = 'person'
)
SELECT base, COUNT(*) AS c, group_concat(id) AS ids, group_concat(name, ' | ') AS names
FROM p GROUP BY base HAVING COUNT(*) >= 2
ORDER BY MAX(folded) DESC, COUNT(*) DESC, base LIMIT 12`;

// One gate, three doors: kill switch first (no pace burn), the operator kick second (consumed on
// read, stamps pace), the drain-pace floor last. Stamps only on fire — a skipped burst never
// steals the next drain's slot.
function shouldFire({ getMeta, setMeta, now = Date.now(), kickKey = KICK_KEY, paceKey = PACE_KEY } = {}) {
  if (String(getMeta(KILL_KEY) || '') === 'off') return { fire: false, why: `kill switch (${KILL_KEY}=off)` };
  if (String(getMeta(kickKey) || '') === '1') {
    setMeta(kickKey, ''); setMeta(paceKey, String(now));
    return { fire: true, why: 'operator kick' };
  }
  const last = parseInt(getMeta(paceKey) || '0', 10) || 0;
  if (now - last < PACE_MS) return { fire: false, why: `paced (last sweep ${Math.round((now - last) / 60000)}min ago, floor ${Math.round(PACE_MS / 3600000)}h)` };
  setMeta(paceKey, String(now));
  return { fire: true, why: 'drain pace due' };
}

// The task spec: the rail leads, the counted rows ride, the deposit envelope closes. An unseeded
// sweep (seed query failed or clean table) still works — the curator picks its own slice.
// The fired-stamp is a NONCE, not decoration (second first-fire lesson, 08-31 p203): the B1
// agent-consume dedupe is input-hashed with a 1h window, and a deterministic prompt meant a
// retry after a failed sweep was served the failed run's own corpse ("reusing run e55873ad…").
// Pacing owns anti-hammer for this lane; the stamp makes every fire's input unique.
function curatorPrompt({ seedRows = [], firedAt = Date.now() } = {}) {
  const seed = seedRows.length
    ? 'THE COUNTED ROWS — duplicate-suspect person names from the entities table this drain '
      + '(base name | row count | entity ids | stored names), deterministic:\n'
      + seedRows.map((r) => `- ${r.base} | ${r.c} | ids ${r.ids} | ${String(r.names || '').slice(0, 220)}`).join('\n')
    : 'No seed rows landed this sweep — pick your own slice: search for bracket-suffixed person names ("Name [source]") and degree-0 person orphans.';
  return `CURATION SWEEP (fired ${new Date(firedAt).toISOString()}) — people cluster. You PROPOSE, the gates decide; you hold no pen. `
    + 'Work the slice below at cluster context.\n\n' + seed + '\n\n'
    + 'For each suspect group: pull the records (get_entity, get_contact, kg_neighborhood), confirm same-human '
    + 'with evidence (shared email, office, FEC id, the import-suffix pattern), check list_resolution_proposals '
    + 'FIRST so you never re-file a queued pair, then propose_relation with relation_type DUPLICATE_OF '
    + '(allow_open_type=true) and relation_metadata carrying the evidence verbatim. A hunch with no shared '
    + 'identifier is SKIPPED, not filed. Never merge, decide, or edit anything. '
    + 'End with exactly: FILED: <one line per proposal with its evidence> · SKIPPED: <group + why> · ERRORS: <tool errors verbatim, or none>.';
}

// A sweep that died of system-wide tool failure did NO work — it must return its pace slot so
// the next drain retries instead of quietly burning 12h on a zero-work run (first-fire lesson,
// 08-31 p202: the kick fired ~5min into engine store-init warm-up; every tool bounced "Store not
// initialized" and the honest deposit carried it). Detection rides the deposit's OWN envelope:
// nothing filed AND a non-none ERRORS segment. A sweep that filed anything keeps its slot —
// work happened, partial errors are the curator's honest margin, not a failure.
// Markdown-normalize before parsing (third first-fire lesson, 08-31 run 542857bd): the agent
// wrapped the envelope in bold — `**FILED:** none` — and the raw-text parser matched FILED:
// inside the markers, captured "** none —…", failed the none-check, and the monologue claimed
// "filed 2 duplicate proposals" over a zero-work sweep (the DB delta caught the lie). A prompt
// rule ("end with exactly") is a request; a tolerant parser is the gate.
function _normalize(deposit) { return String(deposit || '').replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '').replace(/^#+\s*/gm, ''); }

// FOURTH shape lesson (08-31 run 2704033b, the acceptance sweep): the model restyled the envelope
// again — "## FILED (14 DUPLICATE_OF proposals)" as a markdown H2 with a parenthetical count and
// NO COLON — and the colon-bound parser called a 14-filing sweep "empty" while the 14 rows sat
// verified in tenant_rainey.relation_proposals. The cure: parse SECTIONS by word boundary, colon
// optional; a count in the header line outranks body-line counting.
function _sections(deposit) {
  const s = _normalize(deposit);
  // A section starts at a line start OR after a '·' separator (the one-line envelope);
  // its head is the rest of that line up to the next '·'.
  const head = (name) => {
    const m = new RegExp(`(?:^|\\n|·)\\s*${name}\\b:?([^\\n·]*)`, 'i').exec(s);
    return m ? m[1].trim() : null;
  };
  const body = (name) => {
    // The head part must consume NEITHER the trailing newline NOR a '·' — the lookahead needs
    // them to see the next section, and a one-line envelope's extra filings live between '·'s
    // (regexes here run without the m flag, so ^ is string-start).
    const m = new RegExp(`(?:^|\\n|·)\\s*${name}\\b:?[^\\n·]*([\\s\\S]*?)(?=(?:\\n|·)\\s*(?:FILED|SKIPPED|ERRORS)\\b|$)`, 'i').exec(s);
    return m ? (m[1] || '').trim() : null;
  };
  return { filedHead: head('FILED'), filedBody: body('FILED'), errorsHead: head('ERRORS'), errorsBody: body('ERRORS') };
}

function _filedCount(deposit) {
  const { filedHead, filedBody } = _sections(deposit);
  if (filedHead === null) return 0;
  const inline = `${filedHead} ${filedBody || ''}`.trim();
  if (/^\(?\s*(none\b|nothing\b|0\b)/i.test(inline)) return 0;
  const headNum = /\((\d+)\b/.exec(filedHead) || /^\s*(\d+)\b/.exec(filedHead);
  if (headNum) return parseInt(headNum[1], 10);
  // No declared count: the head's own inline filing (if any) + one per body line OR per
  // '·'-separated body segment (the one-line envelope carries extra filings between '·'s —
  // the p205 people sweep filed 2 that way and the line-counter saw 1).
  const bodyLines = (filedBody || '').split('\n').filter((l) => l.trim()).length;
  const bodySegs = (filedBody || '').split('·').filter((seg) => seg.trim() && !/^\s*(none|nothing)\b/i.test(seg)).length;
  return (/\S/.test(filedHead) ? 1 : 0) + Math.max(bodyLines, bodySegs);
}

// SYSTEMIC failure only (p205 lesson: document-curator's single "document not found" error on an
// otherwise-honest empty sweep was called "system-wide" and its slot returned — over-classified;
// harmless but a false say). The proven systemic signatures gate the failure verdict now.
const _SYSTEMIC_RE = /store not initialized|not initialized|system-?wide|unreachable|environment failure|every (read )?tool/i;

function sweepFailed(deposit) {
  const { errorsHead, errorsBody } = _sections(deposit);
  const errs = `${errorsHead || ''} ${errorsBody || ''}`.trim();
  const skippedAll = /SKIPPED:?[^·\n]*\b(all|every)\b[^·\n]*(tool failure|store|unavailable)/i.test(_normalize(deposit));
  return Boolean(_filedCount(deposit) === 0 && errs && !/^\(?\s*(none\b|nothing\b|verbatim\)?\s*$)/i.test(errs)
    && (_SYSTEMIC_RE.test(errs) || skippedAll));
}

// The deposit lands in the MONOLOGUE, never the chat (the unprompted-channel law — a curation
// triage is housekeeping, not a discovered connection). This note is that monologue line.
function burstNote({ deposit = '', agent = AGENT, sweeps = 'the person records' } = {}) {
  if (sweepFailed(deposit)) return `[Curation] The ${agent}'s sweep hit a system-wide tool failure — nothing was actually swept; the slot is returned and the next drain retries.`;
  const n = _filedCount(deposit);
  return n
    ? `[Curation] The ${agent} swept ${sweeps} and filed ${n} proposal${n === 1 ? '' : 's'} for the gates to judge — I hold no pen there.`
    : `[Curation] The ${agent} swept ${sweeps}; nothing worth proposing this pass — an honest empty sweep.`;
}

// ── THE CURATOR REGISTRY (W3, his 08-31 order: "run the other three curators through the same
// funnel") — one funnel, four noticing organs. people keeps its original keys/seed byte-for-byte;
// document/civic/owner ride DIRECTED slices v1 (an unseeded sweep still works — the curator finds
// its slice with its own tools; per-table seed SQL can come later, studied not guessed). One
// shared kill switch (the tier dies as one), per-curator pace + kick keys.
const CURATORS = {
  people: { agent: AGENT, paceKey: PACE_KEY, kickKey: KICK_KEY, seedSql: SEED_SQL, prompt: curatorPrompt, sweeps: 'the person records' },
  document: {
    agent: 'document-curator', paceKey: 'curator.document.last_ts', kickKey: 'curation.kick.document', seedSql: null, sweeps: 'the document corpus',
    // The 08-30 orphan trio was this slice's first draft — p205 first fire proved those are
    // ZOE-SIDE workspace artifacts the engine corpus cannot see ("not found in corpus" ×3,
    // honestly). They ride the down-window chores; this curator's beat is the ENGINE corpus.
    prompt: ({ firedAt = Date.now() } = {}) => `CURATION SWEEP (fired ${new Date(firedAt).toISOString()}) — documents cluster (the ENGINE corpus). You PROPOSE, the gates decide; you hold no pen. `
      + 'Sweep recent documents (recent_documents, search_documents_semantic) for: superseded canonicals — two documents on one topic where the newer plainly replaces the older → propose_link(kind "supersedes") with the rationale; and absent provenance — a document making factual claims where get_sources_for returns nothing → name the document and the unsourced claims in the deposit. Never archive or edit anything. '
      + 'End with exactly: FILED: <one line per proposal with evidence> · SKIPPED: <item + why> · ERRORS: <tool errors verbatim, or none>.',
  },
  civic: {
    agent: 'civic-curator', paceKey: 'curator.civic.last_ts', kickKey: 'curation.kick.civic', seedSql: null, sweeps: 'the civic rosters',
    prompt: ({ firedAt = Date.now() } = {}) => `CURATION SWEEP (fired ${new Date(firedAt).toISOString()}) — civic cluster. You PROPOSE, the gates decide; you hold no pen. `
      + 'THE PLACE-KEY LAW rides every judgment: roster rows key on PLACE — same-named chambers in different places are different bodies, never duplicates. '
      + 'Sweep a slice of local-government roster entities (search_entities for parish/county/city council and commission bodies): flag staleness (a member\'s own newer facts contradict the row), miskeyed rows (a member on the wrong place\'s body), and thin rosters. '
      + 'propose_relation only with matching place keys and evidence in relation_metadata; staleness flags ride the deposit. '
      + 'End with exactly: FILED: <proposals with evidence> · SKIPPED: <item + why> · ERRORS: <tool errors verbatim, or none>.',
  },
  owner: {
    agent: 'owner-curator', paceKey: 'curator.owner.last_ts', kickKey: 'curation.kick.owner', seedSql: null, sweeps: 'the owner orbit',
    prompt: ({ firedAt = Date.now() } = {}) => `CURATION SWEEP (fired ${new Date(firedAt).toISOString()}) — the OWNER ORBIT, small and high-trust. You PROPOSE, the gates decide; you hold no pen. `
      + 'Sweep the orbit anchors and their neighborhoods: "Rainey Center for Public Policy", "LAMP" (the network — never the band or a civic namesake), and the owner\'s records (Lucas Overby; FEC H4FL13077 is the anchor). '
      + 'Hunt orbit duplicates bearing SHARED HARD IDENTIFIERS (email, FEC id, ocd id) → propose_relation DUPLICATE_OF (allow_open_type=true) with the identifier in relation_metadata. Anchor drift and alias gaps are FLAGGED in the deposit, never merged by you. '
      + 'Check list_resolution_proposals FIRST — never re-file. One well-evidenced filing outranks ten maybes; SKIP loudly when in doubt. '
      + 'End with exactly: FILED: <proposals with identifiers> · SKIPPED: <item + why> · ERRORS: <tool errors verbatim, or none>.',
  },
};
const CURATOR_KEYS = Object.keys(CURATORS);

module.exports = { AGENT, CURATOR_TAB, KILL_KEY, PACE_KEY, KICK_KEY, PACE_MS, SEED_SQL, CURATORS, CURATOR_KEYS, shouldFire, curatorPrompt, burstNote, sweepFailed };
