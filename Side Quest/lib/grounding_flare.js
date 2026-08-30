/* THE GROUNDING FLARE — T1 of the swarm substrate (docs/SWARM_SUBSTRATE_2026-08-30.md, W1).
 *
 * When cognition's ladder exhausts and the reply is about to speak from the model (the atlas's
 * one red line — the standing doctrine violation), the flare fires 1-2 engine-side cluster
 * specialists to chase the answer. The reply is NEVER blocked — the flare chases it: deposits
 * land minutes later through the followup lane as an enrichment (the answer held up) or a
 * correction (it didn't — the antifab posture). Deterministic trigger (the exact branch that
 * logs the answering-from-the-model line), deterministic specialist pick — no new classifier.
 *
 * The rails that live in this module:
 *  - a flare is SMALL: at most 2 agents, picked by cluster tokens on the turn;
 *  - agent names are THE ENGINE REGISTRY'S, hyphenated (§70 — every underscored spawn since
 *    birth died "no run id"; _NAME_RE enforces the shape by construction);
 *  - quiet canvas: every spawn passes the designated FLARE_TAB so ambient flares never litter
 *    the workspace (the first dossier run rendered four tabs — right for a dossier, wrong for
 *    a background verify);
 *  - pacing + kill switch: one flare per FLARE_PACE_MS (meta flare.last_ts), meta
 *    swarm.flare=off disarms without a build — and a suppressed flare still logs at the call
 *    site, so the answering-from-the-model line never stands alone.
 */
'use strict';

const FLARE_TAB = 'research-flare';
const FLARE_PACE_MS = 5 * 60 * 1000;
const KILL_KEY = 'swarm.flare';
const PACE_KEY = 'flare.last_ts';

// The §70 law as a shape: only the registry's hyphenated names ever leave this module.
const _NAME_RE = /^[a-z]+(?:-[a-z]+)+$/;

// Cluster routing — the turn's tokens pick the specialists (the cluster map in the design doc).
// Every entry is a REGISTERED engine agent; fact-checker rides every pair because the flare's
// job is verification first, enrichment second. Order matters: first match wins.
const CLUSTERS = [
  { key: 'legislation', re: /\b(?:bill|act|statute|legislation|legislative|amendment|resolution|ordinance|committee|[hs]\.? ?b\.? ?\d+)\b/i, agents: ['legislative-analyst', 'fact-checker'] },
  { key: 'donors', re: /\b(?:donor|donation|fundrais\w*|fec|pac|contribution|campaign finance)\b/i, agents: ['donor-flow-analyst', 'fact-checker'] },
  { key: 'polling', re: /\b(?:poll(?:ing|ster)?|approval rating|survey|favorab\w*|crosstab)\b/i, agents: ['polling-strategist', 'fact-checker'] },
  { key: 'history', re: /\b(?:histor\w*|precedent|lineage|predecessor|founding|19[0-9]{2}\b)\b/i, agents: ['historical-researcher', 'fact-checker'] },
];

function pickSpecialists({ kind = null, topic = '', need = '', userMessage = '' } = {}) {
  // A current-office question is press-shaped: the freshest cluster plus the verifier.
  let picks;
  if (kind === 'office_holder') picks = ['fact-checker', 'press-monitor'];
  else {
    const hay = `${topic || ''} ${need || ''} ${userMessage || ''}`;
    const hit = CLUSTERS.find((c) => c.re.test(hay));
    picks = hit ? hit.agents : ['fact-checker'];
  }
  return picks.slice(0, 2).filter((a) => _NAME_RE.test(a));
}

// The task spec every specialist gets: verify-first, sources mandatory, deposit-shaped ending
// (the same FOUND/NOT FOUND/SOURCES envelope the road's gather swarm proved end-to-end in §72).
function flarePrompt({ userMessage = '', need = '', topic = '' } = {}) {
  const q = String(userMessage || '').slice(0, 300);
  const n = String(topic || need || '').slice(0, 200);
  return `VERIFY a chat answer that was just given from general knowledge — no records backed it.\n` +
    `The question asked: "${q}"\nThe unresolved need: ${n}\n` +
    `Find the current, sourced facts that actually answer it — check the stores and the open web, ` +
    `and bring back the sources themselves, not summaries of searching.\n\n` +
    `Your final reply IS the return value. End with: FOUND: <one line each> · NOT FOUND: <gaps> · SOURCES: <urls/records>.`;
}

// Pacing + kill switch. Stamps the pace key when it says fire — the caller that gets {fire:true}
// owns the window whether or not the spawns succeed (a failed spawn burning the slot is honest:
// the alternative re-fires into whatever broke the spawn).
function shouldFire({ getMeta = () => null, setMeta = () => {}, now = Date.now() } = {}) {
  try { if (String(getMeta(KILL_KEY) || '').trim().toLowerCase() === 'off') return { fire: false, why: `kill switch (${KILL_KEY}=off)` }; } catch {}
  let last = 0; try { last = Number(getMeta(PACE_KEY) || 0) || 0; } catch {}
  if (now - last < FLARE_PACE_MS) return { fire: false, why: `paced (last flare ${Math.round((now - last) / 1000)}s ago, window ${Math.round(FLARE_PACE_MS / 1000)}s)` };
  try { setMeta(PACE_KEY, String(now)); } catch {}
  return { fire: true, why: 'armed' };
}

// The harvest's followup instruction — the antifab posture rides it: confirm → enrich with the
// source; contradict → lead with the correction, never defend; empty → say so. The model has its
// own recent say in the rolling window, so "what you told them" resolves without a replay here.
function followupText({ topic = '', deposits = [], userName = 'Lucas' } = {}) {
  return `[Your research team just came back on "${String(topic || '').slice(0, 120)}" — a question you answered from general knowledge a few minutes ago. Their findings:\n` +
    `${deposits.join('\n\n')}\n` +
    `Compare the findings against what you told ${userName}. If they CONFIRM it, share the substance briefly, with its source, as an enrichment ("the research team came back with…"). ` +
    `If they CONTRADICT anything you said, lead with the correction plainly — never defend the earlier answer. ` +
    `If they came back empty or off-target, say the follow-up check found nothing solid. One to three sentences, your voice.]`;
}

module.exports = { pickSpecialists, flarePrompt, shouldFire, followupText, FLARE_TAB, FLARE_PACE_MS, KILL_KEY, PACE_KEY, CLUSTERS, _NAME_RE };
