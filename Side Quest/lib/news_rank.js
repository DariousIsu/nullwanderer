/*
 * lib/news_rank.js — the News Tuner's SELECTOR (design: docs/NEWS_TUNER_DESIGN.md, slice 3).
 *
 * One pure, surface-agnostic arranger shared by the scrolling feed (base score = recency) and the brief
 * (base score = corroboration). Applies the tuner config: MUTE (weight 0) → RESERVE (top N slots for
 * PROTECTED hard-news categories) → FILL (everyone, by weighted score) → CAP (per-category share). UMD so it
 * runs in the browser (feed) and Node (brief). Fail-safe: a broken/missing config → today's behavior
 * (all weight 1, uncapped, default-protected set) so the surface never blanks.
 *
 * Locked (Lucas): fine per-category weight+cap sliders; RESERVED hard-news slots as the anti-drown rule;
 * Weather is protected AND uncapped.
 */
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NewsRank = api;
})(this, function (req) {
  'use strict';

  // Category keys + protected defaults, kept in sync with news_topics (duplicated as a literal so this stays
  // dependency-free in the browser; a mismatch would only affect defaults, not correctness).
  const DEFAULT_CATS = {
    world:    { weight: 1.4, capPct: null, protected: true },
    politics: { weight: 1.2, capPct: null, protected: true },
    local:    { weight: 1.3, capPct: null, protected: true },
    markets:  { weight: 1.0, capPct: null, protected: true },
    health:   { weight: 1.0, capPct: null, protected: true },
    weather:  { weight: 1.2, capPct: null, protected: true },   // uncapped by design (hard news, never capped)
    tech:     { weight: 1.0, capPct: 25,   protected: false },
    sports:   { weight: 0.6, capPct: 20,   protected: false },
    culture:  { weight: 0.5, capPct: 15,   protected: false },
  };
  const FALLBACK_CAT = 'culture';

  function defaultTuner() {
    const categories = {};
    for (const k of Object.keys(DEFAULT_CATS)) categories[k] = Object.assign({}, DEFAULT_CATS[k]);
    return { version: 1, reservedSlots: { feed: 12, brief: 5 }, categories };
  }

  // Merge a (possibly partial / user-edited / broken) config over the defaults. Never throws.
  function normalizeTuner(cfg) {
    const t = defaultTuner();
    if (!cfg || typeof cfg !== 'object') return t;
    if (cfg.reservedSlots && typeof cfg.reservedSlots === 'object') {
      if (Number.isFinite(cfg.reservedSlots.feed)) t.reservedSlots.feed = Math.max(0, cfg.reservedSlots.feed | 0);
      if (Number.isFinite(cfg.reservedSlots.brief)) t.reservedSlots.brief = Math.max(0, cfg.reservedSlots.brief | 0);
    }
    if (cfg.categories && typeof cfg.categories === 'object') {
      for (const k of Object.keys(t.categories)) {
        const c = cfg.categories[k];
        if (!c || typeof c !== 'object') continue;
        if (Number.isFinite(c.weight)) t.categories[k].weight = Math.max(0, Math.min(3, c.weight));
        if (c.capPct === null || Number.isFinite(c.capPct)) t.categories[k].capPct = (c.capPct === null ? null : Math.max(0, Math.min(100, c.capPct)));
        if (typeof c.protected === 'boolean') t.categories[k].protected = c.protected;
      }
    }
    return t;
  }

  function catOf(t, item) {
    const c = item && item.category;
    return (c && t.categories[c]) ? c : FALLBACK_CAT;
  }

  // Arrange items for ONE surface. opts:
  //   slots     — how many to return (feed ~20, brief ~8)
  //   reserved  — top slots held for PROTECTED categories (caller reads cfg.reservedSlots[surface])
  //   scoreOf   — (item) => base numeric score (recency for feed, corroboration for brief)
  //   freshnessOf — OPTIONAL (item) => freshness weight in (0,1]; multiplies the score so a stale item
  //                 decays in rank without being dropped (Phase A4). Default 1 → no behavior change. Used by
  //                 the BRIEF (corroboration base has no time-decay), NOT the feed (already recency-scored).
  // Returns { items, reservedFilled, total }. Order: reserved (protected, best-first) then fill (best-first).
  function arrange(items, cfg, { slots = 20, reserved = 0, scoreOf, freshnessOf } = {}) {
    const t = normalizeTuner(cfg);
    const score = typeof scoreOf === 'function' ? scoreOf : (it) => (it && Number(it.baseScore)) || 0;
    const fresh = typeof freshnessOf === 'function' ? freshnessOf : () => 1;
    const R = Math.max(0, Math.min(slots, reserved | 0));

    // weighted, non-muted; freshness multiplies (stale sinks in rank, never dropped)
    const live = [];
    for (const it of (items || [])) {
      const c = catOf(t, it);
      const w = t.categories[c].weight;
      if (!(w > 0)) continue;                      // muted (weight 0) → dropped
      live.push({ it, c, s: (Number(score(it)) || 0) * w * (Number(fresh(it)) || 1) });
    }
    live.sort((a, b) => b.s - a.s);

    const capOf = (c) => { const p = t.categories[c].capPct; return (p == null || p <= 0) ? Infinity : Math.max(1, Math.floor(p / 100 * slots)); };
    const used = Object.create(null);
    const atCap = (c) => (used[c] || 0) >= capOf(c);

    const chosen = []; const picked = new Set();
    // RESERVE — protected categories only, best weighted score first, respecting caps
    for (const e of live) {
      if (chosen.length >= R) break;
      if (!t.categories[e.c].protected || atCap(e.c) || picked.has(e.it)) continue;
      chosen.push(e); picked.add(e.it); used[e.c] = (used[e.c] || 0) + 1;
    }
    const reservedFilled = chosen.length;
    // FILL — everyone, best weighted score first, respecting caps, up to `slots`
    for (const e of live) {
      if (chosen.length >= slots) break;
      if (picked.has(e.it) || atCap(e.c)) continue;
      chosen.push(e); picked.add(e.it); used[e.c] = (used[e.c] || 0) + 1;
    }
    return { items: chosen.map((e) => e.it), reservedFilled, total: chosen.length };
  }

  return { DEFAULT_CATS, defaultTuner, normalizeTuner, catOf, arrange };
});
