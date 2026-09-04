'use strict';
/*
 * lib/executor_pick.js — PARTITIONS AS EXECUTORS (stage 4.5 D, 2026-09-04; docs/ZOE_MERGE_MAP §"Stage
 * 4.5", contract part 4): "A swarm is a partition of a roster dispatched to executors. An executor is
 * whichever registry row fits the partition's goal: an Echo agent for Echo-native work such as bills
 * and contacts, a Side Quest worker for web research. Partitions inherit the parent's tier."
 *
 * PURE: pick() reads the beat, the plan, the partition's targets and the role registry's rows and
 * returns {executor, role, why}. It never dispatches. The policy meta `swarm.executors` ('sq' | 'mixed',
 * default mixed) lets the operator pin every partition to this side's workers; the engine being
 * disconnected or the role missing from the registry always falls to 'sq' with the reason named.
 *
 * WHAT IS ECHO-NATIVE (his law, the foundation): work whose answers live in the program's own stores
 * and connected APIs — bills (the bill-tracker), and rosters of PEOPLE/CONTACTS (the collector, whose
 * mandatory order is the database first, the API second, the web last). A roster of governing bodies
 * validated against county websites, and a topic's sub-topics, are web research: this side's worker.
 */

const ECHO_NATIVE = [
  // bills and legislation → the bill tracker (Echo-native: the bills store, LegiScan, the feeds)
  { role: 'bill-tracker', kind: 'bill', goal: /\b(bills?|legislation|statutes?|resolutions?|ordinances?)\b/i, why: 'bills are engine-native (the bills store, LegiScan, the feeds)' },
  // people / contact rosters → the collector (the database first, the API second, the web last)
  { role: 'collector', kind: 'contact', goal: /\b(contacts?|contact (?:information|details|info)|emails?|phone numbers?|staff(?:ers)?|donors?|lobbyists?|members of (?:the )?(?:board|committee|commission)|roster of (?:people|members|officials|staff))\b/i, why: 'a contact roster is engine-native (the CRM first, the APIs, the web last — P15)' },
];

const POLICIES = ['sq', 'mixed'];

function _goalOf(beat, plan) { return `${(beat && beat.goal) || ''} ${(plan && (plan.goal || plan.shape)) || ''}`.trim(); }

/**
 * pick({ beat, plan, targets, roles, policy, engineConnected }) → { executor: 'sq'|'echo', role, why }
 *   beat.kind may name the work directly ('bill' | 'contact'); a beat may also declare `executor`.
 *   roles = lib/role_registry.table().rows (or any list of {name, executor}); a missing role → sq.
 */
function pick({ beat = null, plan = null, targets = [], roles = [], policy = 'mixed', engineConnected = true } = {}) {
  const pol = POLICIES.includes(policy) ? policy : 'mixed';
  const goal = _goalOf(beat, plan);
  const declared = beat && beat.executor;
  if (declared === 'sq') return { executor: 'sq', role: 'swarm-worker', why: 'the beat pins this side' };
  if (pol === 'sq') return { executor: 'sq', role: 'swarm-worker', why: 'policy swarm.executors=sq' };
  const has = (name) => (roles || []).some((r) => r && r.name === name && r.executor === 'echo');
  const consider = (role, why) => {
    if (!engineConnected) return { executor: 'sq', role: 'swarm-worker', why: `${role} fits but the engine is not connected` };
    if (!has(role)) return { executor: 'sq', role: 'swarm-worker', why: `${role} fits but is not in the registry` };
    return { executor: 'echo', role, why };
  };
  if (declared && declared !== 'echo') return consider(String(declared), 'the beat names its executor role');
  const kind = String((beat && beat.kind) || '').toLowerCase();
  for (const rule of ECHO_NATIVE) {
    if (kind === rule.kind || rule.goal.test(goal)) return consider(rule.role, rule.why);
  }
  if (declared === 'echo') return consider('collector', 'the beat asks for the engine without a role — the collector is the general engine-native worker');
  return { executor: 'sq', role: 'swarm-worker', why: 'web research (a roster validated against the web, or a topic) — this side\'s worker' };
}

/** The brief an engine-executed partition receives: the goal, its targets, and the shape the fold reads. */
function brief({ goal = '', targets = [], index = 1, of = 1, facets = null } = {}) {
  const list = (targets || []).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const fac = Array.isArray(facets) && facets.length ? `\nFacets to establish for each target: ${facets.join('; ')}.` : '';
  return `${String(goal || '').trim()}\n\nThis is partition ${index}/${of} of a swarm. Your targets — establish each one, in order:\n${list}${fac}\n\n`
    + 'Your final reply IS the return value — not a message to anyone. End with a compact summary in this shape: '
    + 'FOUND: <one line per target you established, each STARTING WITH THE TARGET NAME EXACTLY AS LISTED, then what you established and its source> · '
    + 'NOT FOUND: <the targets you could not establish, each starting with its name as listed> · SOURCES: <the urls/records behind the found items>.';
}

module.exports = { ECHO_NATIVE, POLICIES, pick, brief };
