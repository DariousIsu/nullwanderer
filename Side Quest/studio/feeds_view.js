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

  // One feed report (from fetch_feed / a fetch_feeds_batch entry) → { source, ok, items[] }.
  function normalizeFeedReport(report) {
    const r = report || {};
    const source = r.title || hostname(r.feed_url || '');
    const items = (Array.isArray(r.items) ? r.items : []).map(it => {
      const link = it.link || '';
      const ms = it.published_iso ? (Date.parse(it.published_iso) || 0) : 0;
      return {
        id: it.guid || link || `${r.feed_url}|${it.title || ''}`,
        title: (it.title || '(untitled)').trim(),
        link,
        summary: stripHtml(it.summary || '').slice(0, 280),
        source, sourceUrl: r.feed_url || '',
        publishedIso: it.published_iso || '', publishedMs: ms,
      };
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

  return { hostname, stripHtml, normalizeFeedReport, mergeReports, markNew, relTime, youtubeId, ytEmbed };
});
