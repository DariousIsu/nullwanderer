'use strict';
/* lib/fallthrough.js — A1: the fall-through floor, generalized (docs/INTEGRATED_BUILD_TRACK_2026-08-10.md §A1).
 *
 * THE DISEASE (census fresh51, reproduced across ≥4 lanes): a content lane picks ONE primary reader, the
 * primary fails, and the lane reports "couldn't" instead of descending to a working alternative that would
 * have answered. The fix already landed ONCE for vision — lib/excavate.js (commit 9cbdf83): headful vision
 * miss → web_extract → web_fetch → distil. This lifts that pattern out of excavate into a reusable shape.
 * WIRED CONSUMERS (honest ledger, corrected 2026-08-12 review): media_cc's caption cascade. The MEETING
 * lanes (gmeet/teams) deliberately do NOT descend to av_transcribe mid-call (in-lane comments own that
 * choice — a live meeting can't block on a download+transcribe); their caption-drought path surfaces
 * honestly and stays instead (A1 steps 3-4). If a lane later earns the descent, wire it here.
 *
 * THE CONTRACT (inherited from the excavate floor, non-negotiable):
 *   - Try readers in order; the FIRST whose result passes ok() wins.
 *   - FAIL-OPEN / NEVER INVENT: if every reader is empty or throws, return {ok:false, via:'none'} — the
 *     caller then reports an HONEST not-found. A fall-through floor exists to reach a real answer, never to
 *     manufacture one. A thrown reader is a miss, not a success (it falls through, it does not abort).
 *   - Each lane keeps its OWN readers, prompts, and instruments; only the DESCENT is shared here.
 *
 * Pure control flow — no I/O, no deps of its own. Readers are thunks the caller injects, so this is fully
 * offline-testable. Run: node scripts/smoke_fallthrough.js
 */

// Default success test. A reader "succeeded" iff it returned something non-empty. Handles the shapes the
// real lanes actually return; callers with a different shape pass opts.ok to override.
function _defaultOk(r) {
  if (r == null || r === false) return false;
  if (typeof r === 'string') return r.trim().length > 0;
  if (Array.isArray(r)) return r.length > 0;
  if (typeof r === 'object') {
    if ('found' in r) return !!r.found;                                   // excavate shape {found, answer}
    if ('ok' in r) return !!r.ok;                                         // {ok, ...} result shape
    if ('lines' in r) return Array.isArray(r.lines) && r.lines.length > 0; // caption shape {lines}
    if ('text' in r) return String(r.text || '').trim().length > 0;       // fetched-text shape {text}
    return Object.keys(r).length > 0;
  }
  return true;   // numbers / other truthy scalars
}

// descend(readers, opts): run each reader thunk in order, returning the first whose result passes ok().
// Returns { ok, via, index, result }:
//   ok:true, via:'primary'|'fallback:<i>', index:<i>, result:<the winning value>
//   ok:false, via:'none', index:-1, result:<last attempted value, for the caller's honest report>
// opts: { ok?(result)->bool, log?(msg), label?:string }. Fail-open: a reader throwing is logged + skipped.
async function descend(readers, opts = {}) {
  const ok = typeof opts.ok === 'function' ? opts.ok : _defaultOk;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const label = opts.label || 'read';
  const list = Array.isArray(readers) ? readers.filter((r) => typeof r === 'function') : [];
  if (!list.length) return { ok: false, via: 'none', index: -1, result: undefined };
  let last;
  for (let i = 0; i < list.length; i++) {
    let res, err = null;
    try { res = await list[i](); } catch (e) { err = e; }
    if (!err && ok(res)) {
      if (i > 0) log(`${label}: reader ${i + 1}/${list.length} answered after ${i} empty — fell through`);
      return { ok: true, via: i === 0 ? 'primary' : `fallback:${i}`, index: i, result: res };
    }
    last = err ? last : res;
    const why = err ? `threw (${err.message})` : 'empty';
    const more = i < list.length - 1 ? ' → falling through' : ' — every reader empty, honest not-found';
    log(`${label}: reader ${i + 1}/${list.length} ${why}${more}`);
  }
  return { ok: false, via: 'none', index: -1, result: last };
}

// withFallthrough(primary, fallback, opts): the 2-reader case, named as the handoff specifies. A lane that
// needs a longer cascade (media_cc: textTracks → DOM overlay → av_transcribe) passes an array to descend().
async function withFallthrough(primary, fallback, opts = {}) {
  return descend([primary, fallback], opts);
}

module.exports = { descend, withFallthrough, _defaultOk };
