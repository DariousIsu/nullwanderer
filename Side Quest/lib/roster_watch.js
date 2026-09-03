/*
 * lib/roster_watch.js — ELECTION-NIGHT / OUT-OF-CYCLE roster monitoring. PURE core + sq.db edge.
 *
 * Lucas (2026-08-07): "state and fed are a matter of checking official databases and monitoring
 * election night news." The roster-refresh organ handles the first half on a weekly cadence; this
 * watch handles the second: an officeholder-change SIGNAL in the news stream (a death, a
 * resignation, a special election, a seat won) should not wait up to a week — it clears the
 * refresh cadence so the next daily due-check runs the full official-feed validation, and it
 * flags WHICH tracked officeholder the signal names when it can.
 *
 * Deliberately cheap and honest: one SELECT over recent news TITLES + two regexes. A false
 * positive costs one extra (throttled) roster refresh against official feeds — during an election
 * season that degenerates to near-daily refreshes, which is exactly the desired behavior. The
 * watch never edits rosters itself: the OFFICIAL FEEDS remain the only source of roster truth.
 * Kill switch ZOE_ROSTER_WATCH=0.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// A seat-CHANGE event (not mere political news — "Senator blasts budget" must not fire).
const SIGNAL = /\b(special election|resigns?|resignation|dies(?: at)?|died|death of|passed away|appointed to (?:the )?(?:senate|house|seat)|sworn in|wins? (?:the )?(?:seat|election|runoff|special)|elected to|steps? down|stepping down|vacanc(?:y|ies)|vacates?|succeed(?:s|ed)? (?:the )?(?:late|retiring|outgoing)|expelled from|recall election|concedes?)\b/i;
// …about an elected OFFICE this program tracks.
const OFFICE = /\b(senators?|senate|representatives?|congress(?:man|woman|ional)?|house seat|governors?|legislature|legislators?|delegates?|lieutenant governor|assembly(?:man|woman)?|statehouse)\b|\b(?:sen|rep|gov)\./i;

function titleSignals(title) {
  const t = str(title);
  return SIGNAL.test(t) && OFFICE.test(t);
}

// Recent news titles → change-signal hits. Titles only: the news lane's docs are "News — <headline>"
// and the headline carries the event; scanning bodies would mostly add false positives from roundups.
function scanNews({ db, sinceMs, now = Date.now() } = {}) {
  const hits = [];
  try {
    // superseded_by IS NULL — a superseded row is an older copy of a headline its successor carries; the
    // predicate also lets idx_documents_source_created serve the scan (freeze cut 5: without it the
    // planner scanned every document + a temp B-tree, 807ms idle / 2.9s under load).
    const rows = db.getDb().prepare(
      `SELECT id, title, created_ts FROM documents WHERE source = 'news' AND superseded_by IS NULL AND created_ts > ? ORDER BY created_ts DESC LIMIT 500`
    ).all(sinceMs != null ? sinceMs : now - 26 * 3600 * 1000);
    for (const r of rows) if (titleSignals(r.title)) hits.push({ docId: r.id, title: str(r.title).replace(/^News —\s*/i, '').slice(0, 160), ts: r.created_ts });
  } catch { /* fail-soft: no news read, no hits */ }
  return hits;
}

// Which TRACKED officeholders does a hit name? Cross-ref against the civic store's live rows —
// a named current holder turns "some senator somewhere" into "OUR tracked seat changed".
function matchHolders({ db, hits = [] } = {}) {
  let holders = [];
  try {
    holders = db.getDb().prepare(
      `SELECT m.person_name, b.title body FROM civic_memberships m JOIN civic_bodies b ON m.body_key = b.body_key
       WHERE m.superseded_by IS NULL AND LENGTH(m.person_name) >= 8`
    ).all();
  } catch { return hits.map((h) => ({ ...h, seat: null, person: null })); }
  return hits.map((h) => {
    const t = h.title.toLowerCase();
    const m = holders.find((x) => t.includes(str(x.person_name).toLowerCase()));
    return { ...h, seat: m ? m.body : null, person: m ? m.person_name : null };
  });
}

const META_FORCED = 'roster_watch.last_forced';
const FORCE_GAP_MS = 20 * 3600 * 1000;   // at most one forced refresh per ~day — election night still refreshes daily

/**
 * maybeTrigger({ db, now }) → { hits, forced } — scan the last ~26h of news; on any hit, clear the
 * roster-refresh cadence stamp (the caller's daily runner then treats it as due) at most once per
 * FORCE_GAP. Surfaces a one-line inbound so the change is visible even before the refresh lands.
 */
function maybeTrigger({ db, now = Date.now() } = {}) {
  if (String(process.env.ZOE_ROSTER_WATCH || '1') === '0') return { skipped: 'kill-switch', hits: [], forced: false };
  const hits = matchHolders({ db, hits: scanNews({ db, now }) });
  if (!hits.length) return { hits, forced: false };
  const last = parseInt(db.getMeta(META_FORCED) || '0', 10);
  let forced = false;
  if (!last || now - last > FORCE_GAP_MS) {
    try {
      db.setMeta('roster_refresh.last_ts', '0');    // the organ's cadence guard now reads "due"
      db.setMeta(META_FORCED, String(now));
      forced = true;
    } catch { /* fail-soft */ }
  }
  try {
    const named = hits.filter((h) => h.person);
    const line = `roster-watch: ${hits.length} officeholder-change signal(s) in the news` +
      (named.length ? ` — tracked: ${named.slice(0, 3).map((h) => `${h.person} (${h.seat})`).join('; ')}` : '') +
      (forced ? ' → roster refresh forced due' : ' (refresh already forced recently)');
    db.insertInbound({ tabUrl: 'note://roster-watch', speaker: 'system', text: line, source: 'roster-watch' });
  } catch { /* surfacing is best-effort */ }
  return { hits, forced };
}

module.exports = { titleSignals, scanNews, matchHolders, maybeTrigger, META_FORCED, FORCE_GAP_MS };
