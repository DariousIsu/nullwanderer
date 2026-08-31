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
// person names, bracket-suffix-blind. The import disease writes "Name [source-fragment]" variants
// beside the bare name (the Keeter case: one bare + five suffixed rows); stripping at ' [' folds
// them onto one base so the collision count is deterministic before any model ever looks.
const SEED_SQL = `WITH p AS (
  SELECT id, name,
         lower(trim(CASE WHEN instr(name, ' [') > 0 THEN substr(name, 1, instr(name, ' [') - 1) ELSE name END)) AS base
  FROM entities WHERE entity_type = 'person'
)
SELECT base, COUNT(*) AS c, group_concat(id) AS ids, group_concat(name, ' | ') AS names
FROM p GROUP BY base HAVING COUNT(*) >= 2
ORDER BY COUNT(*) DESC, base LIMIT 12`;

// One gate, three doors: kill switch first (no pace burn), the operator kick second (consumed on
// read, stamps pace), the drain-pace floor last. Stamps only on fire — a skipped burst never
// steals the next drain's slot.
function shouldFire({ getMeta, setMeta, now = Date.now() } = {}) {
  if (String(getMeta(KILL_KEY) || '') === 'off') return { fire: false, why: `kill switch (${KILL_KEY}=off)` };
  if (String(getMeta(KICK_KEY) || '') === '1') {
    setMeta(KICK_KEY, ''); setMeta(PACE_KEY, String(now));
    return { fire: true, why: 'operator kick' };
  }
  const last = parseInt(getMeta(PACE_KEY) || '0', 10) || 0;
  if (now - last < PACE_MS) return { fire: false, why: `paced (last sweep ${Math.round((now - last) / 60000)}min ago, floor ${Math.round(PACE_MS / 3600000)}h)` };
  setMeta(PACE_KEY, String(now));
  return { fire: true, why: 'drain pace due' };
}

// The task spec: the rail leads, the counted rows ride, the deposit envelope closes. An unseeded
// sweep (seed query failed or clean table) still works — the curator picks its own slice.
function curatorPrompt({ seedRows = [] } = {}) {
  const seed = seedRows.length
    ? 'THE COUNTED ROWS — duplicate-suspect person names from the entities table this drain '
      + '(base name | row count | entity ids | stored names), deterministic:\n'
      + seedRows.map((r) => `- ${r.base} | ${r.c} | ids ${r.ids} | ${String(r.names || '').slice(0, 220)}`).join('\n')
    : 'No seed rows landed this sweep — pick your own slice: search for bracket-suffixed person names ("Name [source]") and degree-0 person orphans.';
  return 'CURATION SWEEP — people cluster. You PROPOSE, the gates decide; you hold no pen. '
    + 'Work the slice below at cluster context.\n\n' + seed + '\n\n'
    + 'For each suspect group: pull the records (get_entity, get_contact, kg_neighborhood), confirm same-human '
    + 'with evidence (shared email, office, FEC id, the import-suffix pattern), check list_resolution_proposals '
    + 'FIRST so you never re-file a queued pair, then propose_relation with relation_type DUPLICATE_OF '
    + '(allow_open_type=true) and relation_metadata carrying the evidence verbatim. A hunch with no shared '
    + 'identifier is SKIPPED, not filed. Never merge, decide, or edit anything. '
    + 'End with exactly: FILED: <one line per proposal with its evidence> · SKIPPED: <group + why> · ERRORS: <tool errors verbatim, or none>.';
}

// The deposit lands in the MONOLOGUE, never the chat (the unprompted-channel law — a curation
// triage is housekeeping, not a discovered connection). This note is that monologue line.
function burstNote({ deposit = '', agent = AGENT } = {}) {
  const m = /FILED:\s*([\s\S]*?)(?:SKIPPED:|$)/.exec(String(deposit));
  const filedTxt = m ? m[1].trim() : '';
  const n = filedTxt && !/^(none|nothing|0)\b/i.test(filedTxt) ? filedTxt.split('\n').filter((l) => l.trim()).length : 0;
  return n
    ? `[Curation] The ${agent} swept the person records and filed ${n} duplicate proposal${n === 1 ? '' : 's'} for the gates to judge — I hold no pen there.`
    : `[Curation] The ${agent} swept the person records; nothing worth proposing this pass — an honest empty sweep.`;
}

module.exports = { AGENT, CURATOR_TAB, KILL_KEY, PACE_KEY, KICK_KEY, PACE_MS, SEED_SQL, shouldFire, curatorPrompt, burstNote };
