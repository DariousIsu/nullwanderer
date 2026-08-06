/**
 * lib/need_triage.js — P0b: THE NEEDS GET CONSUMED (ADAPTIVE_RESEARCH_DESIGN §P0b, Lucas
 * 2026-08-06: "research design and implement the missing tools before beginning").
 *
 * The missing half was never the build machinery — rehearsal_driver (O2) already opens a run from
 * a need with a study-first pass, iterates edit→test with failure context, and exits to an R2
 * proposal card (Lucas + gate + commit stay the only path into the live program). What was missing:
 *   • SELECTION PRESSURE — the rehearse move competed in the idle-move lottery and rarely won
 *     (measured: 30 needs piled up, most never attempted).
 *   • TRIAGE — half the filed needs are not code-buildable at all (paid subscriptions, credentials,
 *     data gaps, harvested junk); untriaged they sit 'open' forever, clogging the queue the
 *     pressure would drain.
 *
 * This module is the PURE half: the triage contract (one cloud verdict per need), the deterministic
 * pressure rule that forces the autonomy tick onto needs-work when it is due, and the consolidated
 * external ask. The autonomy tick owns all I/O (asks, status writes, inquiry opens, chat emit).
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// ── the triage contract ─────────────────────────────────────────────────────────────────────────
function triageInput(need = {}) {
  const o = { need: str(need.need).slice(0, 500) };
  if (need.born_from) o.bornFrom = str(need.born_from).slice(0, 160);
  if (Number(need.recurrence) > 1) o.recurrence = Number(need.recurrence);
  return o;
}

function triageWant() {
  return `You are TRIAGING one capability need an autonomous research program filed for itself. Decide what KIND of gap it is. Reply with ONE JSON object and nothing else:
{"class": "buildable"|"external"|"research"|"junk", "reason": string, "build_sketch": string, "study_query": string, "ask": string}
- buildable: she can author it HERSELF in her sandbox — a python tool, a parser, a scraper for a PUBLIC page, a client for a FREE API, a fix to her own program's code. build_sketch: 1-3 sentences on how to build it; study_query: one web query to learn how existing implementations do it. ask: "".
- external: needs something ONLY her operator can provide — a paid subscription, an account/credentials, an API key with billing, hardware. ask: the ONE-sentence request to the operator. build_sketch/study_query: "".
- research: not a tool at all — a DATA or KNOWLEDGE gap answerable by researching (it belongs in the inquiry queue, not the build queue).
- junk: not a real capability — vague prose, a duplicate phrasing, or a harvesting artifact.
Be strict about buildable: "access to <paid database>" is external, not buildable; "parse XLS rosters" is buildable; "who funds X" is research.`;
}

function triageValidator(raw) {
  try {
    const cleaned = str(raw).replace(/<(think|thoughts?|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const obj = JSON.parse(m[0]);
    if (!['buildable', 'external', 'research', 'junk'].includes(obj.class)) return { valid: false, error: 'class must be buildable|external|research|junk' };
    return { valid: true, value: obj };
  } catch (e) { return { valid: false, error: e.message }; }
}

// ── the pressure rule ───────────────────────────────────────────────────────────────────────────
// Deterministic: given the live rehearsal run, the open needs (each annotated with its stored
// triage class or null), and the last time needs-work ran, decide what is DUE:
//   {kind:'iterate'}            — a live (active|parked) run to advance; one-at-a-time discipline
//                                 means nothing opens while a run exists.
//   {kind:'triage', needId}     — the oldest OPEN need with no triage verdict yet.
//   {kind:'open',   needId}     — the oldest OPEN need already triaged buildable.
//   null                        — nothing due, or the calm gap has not elapsed.
// The gap paces EVERYTHING (a triage verdict is cheap but the tick is not free); lastRehearseTs=0
// (fresh boot) is immediately due by construction.
function duePressure({ run = null, needs = [], lastRehearseTs = 0, nowMs = Date.now(), gapMs = 30 * 60 * 1000 } = {}) {
  if (nowMs - (Number(lastRehearseTs) || 0) < gapMs) return null;
  if (run && (run.status === 'active' || run.status === 'parked')) return { kind: 'iterate' };
  const open = (Array.isArray(needs) ? needs : [])
    .filter((n) => n && n.status === 'open')
    .sort((a, b) => (Number(a.created_ts) || 0) - (Number(b.created_ts) || 0));
  const untriaged = open.find((n) => !n.triage);
  if (untriaged) return { kind: 'triage', needId: untriaged.id };
  const buildable = open.find((n) => n.triage === 'buildable');
  if (buildable) return { kind: 'open', needId: buildable.id };
  return null;
}

// ── the consolidated external ask ───────────────────────────────────────────────────────────────
// One honest, actionable chat message for the blocked-external pile — never a per-need nag.
function renderExternalAsk(rows = []) {
  const items = (Array.isArray(rows) ? rows : [])
    .map((r) => r && (str(r.ask).trim() || str(r.need).trim()))
    .filter(Boolean).slice(0, 3);
  if (!items.length) return '';
  const head = items.length === 1
    ? `One capability I can't build myself needs your help: `
    : `${items.length} capabilities I can't build myself need your help: `;
  return `${head}${items.map((a, i) => items.length === 1 ? a : `(${i + 1}) ${a}`).join(' ')} — I've routed everything I CAN build into my own build queue; these are the ones only you can unlock. No rush, just don't want them invisible.`;
}

module.exports = { triageInput, triageWant, triageValidator, duePressure, renderExternalAsk };
