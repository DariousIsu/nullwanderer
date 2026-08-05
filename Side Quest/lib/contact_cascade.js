'use strict';
/**
 * lib/contact_cascade.js — a per-person CONTACT CASCADE: run EVERY available finder in priority order and
 * return the FIRST grounded hit; on a total miss, ESCALATE the person to the model-driven Puller so the
 * background lane keeps working them. Pure orchestration — every I/O dep is a finder/escalate callback, so
 * this is fully offline-smoke-testable and tool-agnostic.
 *
 * WHY (Lucas, 2026-08-05): "we should be using all available tools at all times … if web fails we turn the
 * full weight of the puller on the problem, driven by the model." The list-completion fill was a LONE
 * lookup wired to Echo's keyless web_search (dead → 0 fills). This makes the lookup a cascade instead:
 *   finder order = [ puller-db (the bridge), pattern-fill, web, (her-browser, hunter …) ]
 * The FIRST finder reads the Puller's OWN store, so an email the background Puller lands later flows back
 * into the canvas cell on a subsequent fill pass — that is the cross-store bridge, done as a read, not a
 * new pipe. The LAST resort (all finders null) seeds the person as a Puller target, so the model-driven
 * discovery loop (puller_walk: pattern + her-browser web-discovery + extraction) pursues them over time.
 *
 * A finder is { name, run: async(person) => ({ value, source }) | null }. `person` = {name, surname, org,
 * domain, query}. runContactCascade never throws — a finder that throws is logged and skipped, so one bad
 * tool never sinks the row. Returns { value, source, via, tried } or null. See [[list-completion-lane]].
 */

async function runContactCascade(person, { finders = [], escalate = null, log = null } = {}) {
  const tried = [];
  let transient = false;   // a finder couldn't RUN (tool unreachable) — distinct from a genuine no-result
  for (const f of finders) {
    if (!f || typeof f.run !== 'function') continue;
    let r = null;
    try { r = await f.run(person); }
    catch (e) { if (e && e.transient) transient = true; log && log(`[cascade] ${f.name} threw${e && e.transient ? ' (transient)' : ''}: ${(e && e.message) || e}`); }
    tried.push(f.name);
    if (r && r.value) {
      log && log(`[cascade] ${f.name} found ${r.value} for "${(person && person.name) || '?'}"${r.confidence != null ? ` (${r.confidence}%)` : ''}`);
      return { value: r.value, source: r.source || f.name, via: f.name, confidence: (r.confidence != null ? r.confidence : null), tried };
    }
  }
  // A TRANSIENT tool error (e.g. Echo momentarily unreachable) is NOT a real miss — signal a retry so the
  // caller leaves the row for a later pass instead of blanking a findable contact. Don't escalate on this.
  if (transient) { log && log(`[cascade] transient tool error on "${(person && person.name) || '?'}" — retry later (${tried.join(',')})`); return { retry: true, tried }; }
  // Genuine total miss → hand the person to the model-driven Puller (best-effort; a failure here is non-fatal
  // and must NOT turn into a fabricated cell — the caller still leaves the cell blank).
  if (typeof escalate === 'function') {
    try { await escalate(person); log && log(`[cascade] miss on "${(person && person.name) || '?'}" → escalated to Puller (${tried.join(',')})`); }
    catch (e) { log && log(`[cascade] escalate failed: ${(e && e.message) || e}`); }
  }
  return null;
}

module.exports = { runContactCascade };
