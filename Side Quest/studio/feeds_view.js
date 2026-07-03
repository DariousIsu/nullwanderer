/*
 * Monitors (news feeds) surface — pure VIEW model. Maps the engine's fetch_feed/fetch_feeds_batch
 * output → a merged, deduped, newest-first item stream the canvas Monitors widget renders. No I/O.
 * (Side Quest half: fetch + normalize + render. Storage + her cognition over items = Zoe-builder.)
 *
 * Runs in Node (smoke) and the browser (canvas widget): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FeedsView = api;
})(this, function () {
  'use strict';

  function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || '').slice(0, 40); } }
  function stripHtml(s) { return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }

  // Aggregator (e.g. Google News) items carry an <ol> of member outlets in the summary. Extract them
  // BEFORE stripHtml flattens the markup, so real-world corroboration (distinct outlet count) survives to
  // the reservoir. Returns [{outlet, headline}] or null when the summary isn't an aggregator list.
  function parseAggMembers(rawSummary) {
    const s = String(rawSummary == null ? '' : rawSummary);
    if (!/<li[\s>]/i.test(s)) return null;
    const out = []; const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi; let m;
    while ((m = liRe.exec(s)) !== null) {
      const li = m[1];
      const outlet = stripHtml((li.match(/<font[^>]*>([\s\S]*?)<\/font>/i) || [])[1] || '');
      const headline = stripHtml((li.match(/<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
      if (outlet || headline) out.push({ outlet: outlet || null, headline: headline || null });
    }
    return out.length ? out : null;
  }

  // One feed report (from fetch_feed / a fetch_feeds_batch entry) → { source, ok, items[] }.
  function normalizeFeedReport(report) {
    const r = report || {};
    const source = r.title || hostname(r.feed_url || '');
    const items = (Array.isArray(r.items) ? r.items : []).map(it => {
      const link = it.link || '';
      const ms = it.published_iso ? (Date.parse(it.published_iso) || 0) : 0;
      const members = parseAggMembers(it.summary);   // aggregator outlets, captured before stripHtml
      const item = {
        id: it.guid || link || `${r.feed_url}|${it.title || ''}`,
        title: (it.title || '(untitled)').trim(),
        link,
        summary: stripHtml(it.summary || '').slice(0, 280),
        source, sourceUrl: r.feed_url || '',
        publishedIso: it.published_iso || '', publishedMs: ms,
      };
      if (members) item.members = members;
      return item;
    });
    return { source, sourceUrl: r.feed_url || '', ok: r.bozo !== true, count: items.length, items };
  }

  // fetch_feeds_batch payload {feeds:[...]} (or an array of reports) → merged stream: dedup by id,
  // newest-first, capped. Items with no timestamp sort last (ms=0) but are kept.
  function mergeReports(payload, opts = {}) {
    const limit = opts.limit || 120;
    const reports = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.feeds) ? payload.feeds : []);
    const sources = reports.map(normalizeFeedReport);
    const seen = new Set(); const out = [];
    for (const s of sources) for (const it of s.items) { if (seen.has(it.id)) continue; seen.add(it.id); out.push(it); }
    out.sort((a, b) => b.publishedMs - a.publishedMs);
    return { items: out.slice(0, limit), sources: sources.map(s => ({ source: s.source, sourceUrl: s.sourceUrl, ok: s.ok, count: s.count })) };
  }

  // Normalized headline key for syndication grouping: lowercase, drop a trailing " - Outlet" aggregator
  // suffix, strip punctuation/emoji, collapse whitespace. Two outlets reprinting one wire story share this.
  function normTitle(t) {
    return String(t == null ? '' : t).toLowerCase()
      .replace(/\s+[-–—|]\s+[^-–—|]{1,40}$/, '')      // "…how to treat - cleveland.com" → drop the source tag
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
}

  // VIEW-ONLY syndication collapse (the Monitors widget, NOT the collector): items whose normalized
  // headlines match are the SAME story reprinted across outlets — collapse to ONE card carrying dupCount
  // + the outlet list, so the firehose stays scannable (the Advance Local "5× CDC parasite" wall). The
  // representative is the newest copy. NEVER call this on the collector path — the reservoir needs the
  // distinct copies for cross-outlet corroboration. Pure; order preserved by representative recency.
  function collapseDuplicates(items) {
    const groups = new Map();
    for (const it of (items || [])) {
      const key = normTitle(it.title);
      const gk = key || ('__solo_' + it.id);          // untitled/edge items never merge with each other
      const g = groups.get(gk);
      if (!g) groups.set(gk, { rep: it, sources: [it.source], seen: new Set([it.source]), count: 1 });
      else {
        g.count++;
        if (!g.seen.has(it.source)) { g.seen.add(it.source); g.sources.push(it.source); }
        if ((it.publishedMs || 0) > (g.rep.publishedMs || 0)) g.rep = it;
      }
    }
    const out = [];
    for (const g of groups.values()) {
      const rep = Object.assign({}, g.rep);
      if (g.count > 1) { rep.dupCount = g.count; rep.dupOutlets = g.sources.length; rep.dupSources = g.sources.slice(0, 10); }
      out.push(rep);
    }
    out.sort((a, b) => (b.publishedMs || 0) - (a.publishedMs || 0));
    return out;
  }

  // Flag items not in seenIds as new (for highlight). Mutates a copy; returns it.
  function markNew(items, seenIds) {
    const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
    return (items || []).map(it => ({ ...it, isNew: !seen.has(it.id) }));
  }

  // Compact relative age, e.g. "now", "5m", "3h", "2d". nowMs injectable for determinism.
  function relTime(ms, nowMs) {
    if (!ms) return '';
    const now = nowMs || Date.now();
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  // ---- YouTube monitors (embedded players in the widget) ----
  // Extract the 11-char video id from a watch / youtu.be / embed URL. null if not a YouTube URL.
  function youtubeId(url) {
    const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  // Privacy-enhanced embed URL for an id (or a YouTube URL). '' if not YouTube.
  function ytEmbed(idOrUrl) {
    const id = /^[A-Za-z0-9_-]{11}$/.test(String(idOrUrl || '')) ? idOrUrl : youtubeId(idOrUrl);
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : '';
  }

  return { hostname, stripHtml, parseAggMembers, normalizeFeedReport, mergeReports, normTitle, collapseDuplicates, markNew, relTime, youtubeId, ytEmbed };
});
