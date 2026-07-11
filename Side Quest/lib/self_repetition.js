/**
 * lib/self_repetition.js — MEANING-level self-repetition detection for the idle voice.
 *
 * WHY: her unprompted utterances + reflections can loop — the same point restated in different words
 * (the 2026-07-11 silence-rule confirm loop, and more generally "all she can think is one thing"). The
 * heartbeat's lexical guard (tooSimilarToRecent, word-Jaccard) and a regex denylist both match STRINGS,
 * so a paraphrase slips through and a new phrasing needs a new pattern — whack-a-mole. This judges
 * repetition by EMBEDDING similarity instead: same meaning, any wording, no per-phrase rules. It's the
 * semantic sibling of the tiered cloud-cognition path, not another string matcher.
 *
 * Pure + deps-injected (embed/cosine passed in, default to lib/memory) so it's offline-testable with
 * deterministic fake vectors and no embedding model. Fail-soft: any embed error → not-a-repeat (never
 * blocks a genuine utterance on an infra hiccup).
 */
'use strict';

const MIN_LEN = 12;   // below this there's too little signal to embed meaningfully

// Is `text` a semantic near-repeat of any of `priors` (recent utterances / reflections)?
// priors: array of strings, or {content} rows, or {content|text, vector} (pre-embedded to skip a call).
// threshold: cosine at/above which two texts are "the same point"; minHits: how many priors must match.
async function isSemanticRepeat(text, priors, { embed, cosine, threshold = 0.88, minHits = 1, maxPriors = 8 } = {}) {
  const s = String(text == null ? '' : text).trim();
  if (s.length < MIN_LEN || !Array.isArray(priors) || !priors.length) return false;
  const _embed = embed || ((t) => require('./memory').embed(t));
  const _cos = cosine || require('./memory').cosine;

  let qv; try { qv = await _embed(s); } catch { return false; }
  if (!qv) return false;

  let hits = 0;
  for (const p of priors.slice(-maxPriors)) {
    let pv = (p && Array.isArray(p.vector)) ? p.vector : null;
    if (!pv) {   // only need to embed (and thus gate on text length) when no vector was supplied
      const ptext = typeof p === 'string' ? p : String((p && (p.content || p.text)) || '');
      if (ptext.trim().length < MIN_LEN) continue;
      try { pv = await _embed(ptext); } catch { continue; }
    }
    if (!pv) continue;
    let sim = 0; try { sim = _cos(qv, pv); } catch { sim = 0; }
    if (sim >= threshold) { hits++; if (hits >= minHits) return true; }
  }
  return false;
}

module.exports = { isSemanticRepeat, MIN_LEN };
