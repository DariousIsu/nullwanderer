/**
 * track_index — the Tracks REGISTRY: resolve which completed/active research Track a question is about,
 * by TOPIC, across ALL tracks — not just the most-recent one.
 *
 * The gap this closes (docs/TRACKS_PRIORITY_DESIGN.md §1; live 2026-06-29): "do we have a wrap-up for
 * the think tanks?" must resolve the completed #2027 think-tank dossier, but buildQueryTrack only knew
 * the current-or-last track (then AI-safety) → it couldn't find it. The registry enumerates every
 * directed run and matches the question's topic against each track's goal + covered org names, so a
 * topic-addressed query lands on the RIGHT track.
 *
 * PURE: the caller (main.js) builds the track descriptors from meta/files and passes them in; this only
 * does the matching. Descriptor: { id, goal, covered:[…], status, hasDossier, ts }.
 */
'use strict';

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'do', 'does', 'did',
  'we', 'you', 'i', 'have', 'has', 'had', 'is', 'are', 'was', 'were', 'how', 'what', 'who', 'which',
  'wrap', 'up', 'list', 'lists', 'give', 'me', 'show', 'tell', 'about', 'your', 'our', 'my', 'covered',
  'cover', 'done', 'finished', 'find', 'found', 'research', 'researched', 'so', 'far', 'any', 'all',
  'these', 'those', 'them', 'org', 'orgs', 'organization', 'organizations', 'much', 'many', 'with']);

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
// Light stem: strip a trailing plural 's' (len>=4, not "ss") so "tanks"→"tank", "orgs"→"org",
// "institutes"→"institute" — the query's plural matches a goal's singular ("think tanks" vs "think tank").
function _stem(w) { return (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) ? w.slice(0, -1) : w; }
function _stemmed(s) { return _norm(s).split(' ').filter(Boolean).map(_stem).join(' '); }

function searchableText(track) {
  const cov = Array.isArray(track && track.covered) ? track.covered.join(' ') : '';
  return _stemmed(`${(track && track.goal) || ''} ${cov}`);
}

// Salient query terms: non-stop unigrams (len>=3) + non-stop adjacent bigrams (bigrams disambiguate —
// "ai safety" vs "think tank" point at different tracks even though "ai"/"safety" alone are ambiguous).
function topicTerms(query) {
  // stopword-check on the RAW word, then stem for matching (so "tanks" is kept then matched as "tank").
  const raw = _norm(query).split(' ').filter(Boolean);
  const unigrams = Array.from(new Set(raw.filter((w) => !STOP.has(w) && w.length >= 3).map(_stem)));
  // bigrams from ORIGINAL adjacency (stemmed) so a phrase still matches the uncompacted haystack.
  const bigrams = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i], b = raw[i + 1];
    if (a.length >= 2 && b.length >= 2 && !STOP.has(a) && !STOP.has(b)) bigrams.push(`${_stem(a)} ${_stem(b)}`);
  }
  return { unigrams, bigrams: Array.from(new Set(bigrams)) };
}

// Score one track against the query: bigram hit = 3 (strong topic signal), unigram hit = 1.
function scoreTrack(track, terms) {
  const hay = searchableText(track);
  let score = 0;
  for (const bg of terms.bigrams) if (hay.includes(bg)) score += 3;
  for (const ug of terms.unigrams) if (new RegExp(`\\b${ug}\\b`).test(hay)) score += 1;
  return score;
}

// Resolve the best-matching track for a topic-addressed query, or null if nothing matches (caller then
// falls back to current-or-last). Tie-break: score, then a real dossier, then more covered, then recency
// (higher id). minScore=2 avoids a single weak unigram hijacking the resolution.
function resolveByTopic(tracks, query, { minScore = 2 } = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return null;
  const terms = topicTerms(query);
  if (!terms.unigrams.length && !terms.bigrams.length) return null;
  let best = null;
  for (const t of list) {
    const score = scoreTrack(t, terms);
    if (score < minScore) continue;
    const cand = { track: t, score };
    if (!best
      || cand.score > best.score
      || (cand.score === best.score && !!t.hasDossier > !!best.track.hasDossier)
      || (cand.score === best.score && !!t.hasDossier === !!best.track.hasDossier && (t.covered || []).length > (best.track.covered || []).length)
      || (cand.score === best.score && !!t.hasDossier === !!best.track.hasDossier && (t.covered || []).length === (best.track.covered || []).length && (t.id || 0) > (best.track.id || 0))) {
      best = cand;
    }
  }
  return best ? best.track : null;
}

module.exports = { searchableText, topicTerms, scoreTrack, resolveByTopic };
