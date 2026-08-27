/**
 * lib/site_crawler.js — THE SITE-SWEEP WALKER (2026-08-27).
 *
 * The missing half of the 07-23 site ledger. Lucas (07-20, tagged pre-compact): "capture whole
 * websites plus multi step page depth and translate into memory objects"; (07-23): "the whole site
 * can be swept correctly, each page only once … I would rather get explained that a site is taking
 * longer to digest than realize we took 500 calls to interact with the landing page."
 *
 * Measured before this organ: site_ledger.buildPlan runs on EVERY page read (web.js:741) — the
 * frontier is drawn constantly — and nextPending/markDone had ZERO production callers. The map was
 * drawn on every landing and never walked. gap_plan's AGGRESSIVE bucket advertised "a full crawl of
 * the official site" with the go-phrase "run the deep crawl on X" while no lane could actually
 * sweep — a say-do gap in the approval surface itself.
 *
 * THE WALKER: one active sweep at a time (the don't-hammer doctrine). Each metabolism tick takes a
 * bounded bite: nextPending → (TTL reuse | dead-host breaker | robots) → the escalation ladder
 * (plain fetch → archive → vision; the shared VISIBLE browser is deliberately NOT a door here — a
 * 100-page sweep must never fight her other lanes for the page). Landing is NOT this organ's job:
 * web_search.fetchPage lands every good read as the URL's one living doc (origin = the page URL,
 * ingestReading), and the decompose sweep digests landed docs on its own daily budget — capture and
 * digestion stay decoupled, planLine explains the lag.
 *
 * ORIGIN DOCTRINE (the whole risk of adding a crawler, enforced by construction): every page lands
 * with origin = its own URL; insertDocument derives origin_host; independence() counts distinct
 * HOSTS — so ten pages of one site are ONE source automatically. The walker adds no collapsing
 * logic and must never "help" by stamping the site root as origin (that would destroy per-page
 * provenance and buy nothing).
 *
 * Pure decision helpers (orderMatch/parseRobots/parseSitemap/robotsBlocked) + injectable I/O on
 * sweepTick → hermetically smokeable. Fail-soft: a walker error pauses the sweep with a note,
 * never throws into the metabolism.
 */
'use strict';

const SWEEP_BITE = parseInt(process.env.ZOE_SWEEP_BITE, 10) || 6;
const PAGE_DELAY_MS = parseInt(process.env.ZOE_SWEEP_PAGE_DELAY_MS, 10) || 9000;
const ROBOTS_ON = String(process.env.ZOE_SWEEP_ROBOTS || '1') !== '0';
// The leash-bypass window: docs from a swept host decompose without token overlap for this long
// (a directed sweep IS the vocabulary; the decompose sweep may reach a landed page days later).
const SWEPT_WINDOW_MS = (parseInt(process.env.ZOE_SWEEP_LEASH_DAYS, 10) || 14) * 24 * 3600 * 1000;
// Never fetched through the page ladder: no text to land. PDFs get their own door (the existing
// grab→downloads-watcher→ingest rail); the rest are counted and named, never silently dropped.
// xlsx/csv are DELIBERATELY absent — fetchPage's spreadsheet lane parses them like any page.
const PDF_RE = /\.pdf(?:$|[?#])/i;
const BINARY_RE = /\.(?:docx?|pptx?|zip|rar|7z|exe|dmg|iso|jpe?g|png|gif|svg|webp|ico|mp[34]|mov|avi|wmv|wav|css|js|woff2?|ttf|xml|rss)(?:$|[?#])/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const str = (v) => (v == null ? '' : String(v));
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }
function _sl() { return require('./site_ledger'); }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _eqHost = (a, b) => str(a).toLowerCase().replace(/^www\./, '') === str(b).toLowerCase().replace(/^www\./, '');

// ── sweep rows ──────────────────────────────────────────────────────────────────────────────────
function activeSweep() {
  try { return db().getDb().prepare(`SELECT * FROM site_sweeps WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get() || null; } catch { return null; }
}
function lastSweep() {
  try { return db().getDb().prepare(`SELECT * FROM site_sweeps ORDER BY id DESC LIMIT 1`).get() || null; } catch { return null; }
}
function _upd(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  try {
    db().getDb().prepare(`UPDATE site_sweeps SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_ts = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), Date.now(), id);
  } catch {}
}

/** Start a sweep. One at a time; same-host restart of an active sweep reports the existing one. */
function startSweep(seedUrl, { reason = null, requestedBy = 'order', now = Date.now() } = {}) {
  const sl = _sl();
  const seed = sl.normalizeUrl(/^https?:\/\//i.test(str(seedUrl).trim()) ? str(seedUrl).trim() : `https://${str(seedUrl).trim()}`);
  const host = sl.hostOf(seed);
  if (!host) return { ok: false, error: `no usable host in "${str(seedUrl).slice(0, 80)}"` };
  const cur = activeSweep();
  if (cur && _eqHost(cur.host, host)) return { ok: false, already: cur };
  if (cur) return { ok: false, busy: cur };
  try {
    const r = db().getDb().prepare(`INSERT INTO site_sweeps (host, seed_url, status, reason, requested_by, created_ts, updated_ts)
      VALUES (?, ?, 'active', ?, ?, ?, ?)`).run(host, seed, reason, requestedBy, now, now);
    // A re-sweep of a previously swept host is a REFRESH: reopen the plan entries whose captures
    // have aged past the TTL, so the walker re-fetches what's stale instead of instantly "completing".
    let reopened = 0;
    try { reopened = sl.reopenStale(host, { now }); } catch {}
    return { ok: true, id: r.lastInsertRowid, host, seed, reopened };
  } catch (e) { return { ok: false, error: e.message }; }
}
function stopSweep({ note = 'stopped by order', now = Date.now() } = {}) {
  const sw = activeSweep();
  if (!sw) return { ok: false, error: 'no active sweep' };
  _upd(sw.id, { status: 'stopped', note, done_ts: now });
  return { ok: true, host: sw.host };
}

/** Leash bypass authority: was this host the subject of a directed sweep, recently? */
function isSweptHost(host, { withinMs = SWEPT_WINDOW_MS, now = Date.now() } = {}) {
  const h = str(host).toLowerCase();
  if (!h) return false;
  try {
    const rows = db().getDb().prepare(`SELECT host, status, updated_ts FROM site_sweeps ORDER BY id DESC LIMIT 25`).all();
    return rows.some((r) => _eqHost(r.host, h) && (r.status === 'active' || (now - (r.updated_ts || 0)) <= withinMs));
  } catch { return false; }
}

// ── the order surface (pure) ────────────────────────────────────────────────────────────────────
// "run the deep crawl on X" (the gap_plan go-phrase) / "sweep the whole site" → start.
// Question-shaped mentions → standing (the backfill-door lesson: the organ's own measured standing
// answers its own status ask — never let the model compose an absence). No target → clarify.
const _CRAWL_RE = /\b(?:deep[ -]?crawl|(?:whole|entire|full)[- ]?site(?:\s+(?:crawl|sweep|capture))?|site[ -]?sweep|full\s+crawl|(?:crawl|sweep|capture)\s+the\s+(?:whole|entire|full)\s+site)\b/i;
const _STATUSY_RE = /\b(?:did|has|have|is|was|how(?:'s)?|status|progress|finish(?:ed)?|done|complete[ds]?|going|far along|stand(?:s|ing)?|never|didn'?t|hasn'?t|wasn'?t|happened|failed|stalled)\b/i;
const _STOP_RE = /\b(?:stop|cancel|kill|halt|abort|pause)\b/i;
const _URL_RE = /https?:\/\/[^\s"'<>)\]]+/i;
const _DOMAIN_RE = /\b((?:[a-z0-9][a-z0-9-]*\.)+(?:gov|org|com|net|edu|us|info|io|co|uk|ca)(?:\.[a-z]{2})?)\b/i;
const _STRONG_ORDER_RE = /\b(?:run|start|kick\s*off|launch|begin|fire\s+up|go\s+(?:run|crawl|sweep)|go\s+ahead)\b/i;
function orderMatch(text) {
  const t = str(text);
  if (!_CRAWL_RE.test(t)) return null;
  if (_STOP_RE.test(t)) return { kind: 'stop' };
  const url = (t.match(_URL_RE) || [])[0] || null;
  const dom = url ? null : (t.match(_DOMAIN_RE) || [])[1] || null;
  const target = url || dom;
  // A strong imperative beats status words ("run the deep crawl on x.gov — is it ready?" is an
  // ORDER); without one, question shape wins ("did the crawl of x.gov finish?" must never start).
  if (_STRONG_ORDER_RE.test(t) && target) return { kind: 'start', target };
  if (_STATUSY_RE.test(t)) return { kind: 'status' };
  if (target) return { kind: 'start', target };
  // An imperative crawl order with no nameable site: ask, never guess (bias-toward-clarifying).
  if (/\b(?:run|start|kick|launch|begin|do|go|fire|crawl|sweep|capture)\b/i.test(t)) return { kind: 'clarify' };
  return { kind: 'status' };
}

// ── robots + sitemap (pure parsers; minimal, honest) ────────────────────────────────────────────
function parseRobots(txt) {
  const out = { disallow: [], sitemaps: [] };
  let applies = false, prevWasUa = false;
  for (const raw of str(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) { prevWasUa = false; continue; }
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) { prevWasUa = false; continue; }
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { applies = prevWasUa ? (applies || v === '*') : (v === '*'); prevWasUa = true; continue; }
    prevWasUa = false;
    if (k === 'sitemap' && v) out.sitemaps.push(v);
    else if (k === 'disallow' && applies && v) out.disallow.push(v);
  }
  return out;
}
function _ruleRe(p) {
  let pat = str(p), anchored = false;
  if (pat.endsWith('$')) { anchored = true; pat = pat.slice(0, -1); }
  const esc = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + (anchored ? '$' : ''));
}
function robotsBlocked(url, rules) {
  if (!rules || !Array.isArray(rules.disallow) || !rules.disallow.length) return false;
  let path;
  try { const u = new URL(str(url)); path = u.pathname + u.search; } catch { return false; }
  return rules.disallow.some((p) => { try { return _ruleRe(p).test(path); } catch { return false; } });
}
function parseSitemap(xml) {
  return [...str(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]).slice(0, 1000);
}

async function _rawGet(url, { timeoutMs = 8000, maxBytes = 800000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const txt = await res.text();
    return txt.length > maxBytes ? txt.slice(0, maxBytes) : txt;
  } catch { return null; } finally { clearTimeout(t); }
}

// ── one page through the ladder ─────────────────────────────────────────────────────────────────
// escalatedRead only (plain fetch → archive → vision) — the visible browser is not a sweep door.
// fetchPage LANDS every good read itself (ingestReading, origin = page URL); archive/vision
// successes get a ledger record here so the sweep's bookkeeping never lies about coverage.
async function _fetchOne(url, host, deps) {
  const sl = deps.sl || _sl();
  const escalate = deps.escalate || require('./fetch_escalation').escalatedRead;
  const prefer = (() => { try { const b = sl.bestDoor(host); return b && b !== 'browser' ? b : null; } catch { return null; } })();
  const esc = await escalate(url, {
    fetchPage: deps.fetchPage || ((u, o) => require('./web_search').fetchPage(u, o)),
    seePage: deps.seePage || null,
    preferDoor: prefer,
    onAccess: (door, ok) => { try { sl.recordAccess(url, { door, ok }); } catch {} },
    log: deps.log || null,
  });
  if (esc && esc.ok && esc.via !== 'plain fetch') {
    try { if (!sl.seen(url)) sl.record(url, { kind: 'page', chars: str(esc.text).length }); } catch {}
  }
  return esc || { ok: false };
}

// ── the walker bite ─────────────────────────────────────────────────────────────────────────────
/** One bounded bite of the active sweep. Returns { status, say: [narration lines] }.
 *  deps (all injectable for the smoke): fetchPage, escalate, seePage, sl, sleep, log,
 *  bite, delayMs, downloadPdf, isBrowserConnected, rawGet, now. */
async function sweepTick(deps = {}) {
  const sl = deps.sl || _sl();
  const log = deps.log || ((m) => console.log(m));
  const sleep = deps.sleep || _sleep;
  const rawGet = deps.rawGet || _rawGet;
  const bite = deps.bite || SWEEP_BITE;
  const delayMs = deps.delayMs != null ? deps.delayMs : PAGE_DELAY_MS;
  const now = deps.now || Date.now();
  const say = [];

  let sw = activeSweep();
  // A breaker-paused sweep auto-resumes once the host's down-verdict clears (deferred, never gone).
  if (!sw) {
    try {
      const paused = db().getDb().prepare(`SELECT * FROM site_sweeps WHERE status = 'paused' ORDER BY id DESC LIMIT 1`).get();
      if (paused && !sl.hostDown(paused.host, { now })) {
        _upd(paused.id, { status: 'active', note: 'breaker cleared — resumed' });
        say.push(`The sweep of ${paused.host} is resuming — the host answered again after the outage pause.`);
        sw = activeSweep();
      }
    } catch {}
    if (!sw) return { status: 'idle', say };
  }

  try {
    // ── bootstrap tick: the seed page → host migration → robots → sitemap → the frontier ───────
    if (!sw.bootstrapped) {
      const seedRes = await _fetchOne(sw.seed_url, sw.host, deps);
      let base = sw.seed_url, links = (seedRes && seedRes.links) || [];
      // SEED-REDIRECT HOST MIGRATION (live catch #2, cityofbristolfl.gov 08-27): the ordered .gov
      // seed 301s to cityofbristolflorida.org — the sitemap's 87 real pages lived on the .org and
      // the same-host filter silently dropped the ENTIRE site body, leaving a thin 23-page shell
      // frontier. The seed is the operator-ordered entry point: wherever it lands IS the site, so
      // ANY host change on the seed redirect migrates the sweep (www-variants and cross-domain
      // canonical homes alike). Robots + sitemap are fetched AFTER migration so they read the real
      // host. Bounded like everything else by the frontier cap and page pacing.
      const finalUrl = seedRes && seedRes.finalUrl;
      const migratedFrom = (finalUrl && sl.hostOf(finalUrl) && sl.hostOf(finalUrl) !== sw.host) ? sw.host : null;
      if (migratedFrom) {
        _upd(sw.id, { host: sl.hostOf(finalUrl), note: `host migrated ${migratedFrom} → ${sl.hostOf(finalUrl)} (seed redirect — the ordered entry point lives there)` });
        sw = activeSweep(); base = finalUrl;
        try { sl.reopenStale(sw.host, { now }); } catch {}   // re-sweep freshness follows the migration — the real plan lives on the new host
      } else if (finalUrl) { base = finalUrl; }
      let rules = null;
      if (ROBOTS_ON) {
        const rtxt = await rawGet(`https://${sw.host}/robots.txt`, { timeoutMs: 6000 });
        rules = parseRobots(rtxt || '');
        if (rules.disallow.length || rules.sitemaps.length) _upd(sw.id, { robots: JSON.stringify(rules) });
      }
      const locs = [];
      for (const sm of (rules && rules.sitemaps.length ? rules.sitemaps.slice(0, 3) : [`https://${sw.host}/sitemap.xml`])) {
        const xml = await rawGet(sm, { timeoutMs: 8000 });
        if (!xml) continue;
        let found = parseSitemap(xml);
        // one nesting level of a sitemap index
        const nested = found.filter((u) => /\.xml(?:$|[?#])/i.test(u)).slice(0, 3);
        found = found.filter((u) => !/\.xml(?:$|[?#])/i.test(u));
        for (const nx of nested) { const inner = await rawGet(nx, { timeoutMs: 8000 }); if (inner) found.push(...parseSitemap(inner).filter((u) => !/\.xml(?:$|[?#])/i.test(u))); }
        locs.push(...found);
      }
      const plan = sl.buildPlan(base, [...links, ...locs], { now });
      const mapped = plan && plan.urls ? plan.urls.length : 0;
      _upd(sw.id, {
        bootstrapped: 1,
        pages_fetched: (sw.pages_fetched || 0) + (seedRes && seedRes.ok ? 1 : 0),
        pages_failed: (sw.pages_failed || 0) + (seedRes && seedRes.ok ? 0 : 1),
        docs_landed: (sw.docs_landed || 0) + (() => { try { const r = sl.seen(base); return r && r.doc_id ? 1 : 0; } catch { return 0; } })(),
      });
      say.push(`Site sweep of ${sw.host} is underway${migratedFrom ? ` (${migratedFrom} redirects there — following the site to its real home)` : ''} — ${mapped} page(s) mapped so far (the frontier grows as I read${locs.length ? `; sitemap contributed ${locs.length}` : ''}${rules && rules.disallow.length ? `; ${rules.disallow.length} robots rule(s) will be honored` : ''}). I'll report at each quarter and when it completes.`);
      log(`[site-sweep] bootstrap ${sw.host}: frontier ${mapped}, sitemap ${locs.length}, robots rules ${(rules && rules.disallow.length) || 0}`);
      return { status: 'active', say };
    }

    // ── walk ticks ─────────────────────────────────────────────────────────────────────────────
    const rules = (() => { try { return sw.robots ? JSON.parse(sw.robots) : null; } catch { return null; } })();
    const c = { fetched: 0, reused: 0, failed: 0, robots: 0, binary: 0, pdfs: 0, docs: 0 };
    // Counters flush BEFORE any exit that reads the row back — a tick that walks AND completes must
    // not lose its own counts (the completion report renders from the row; caught by the smoke).
    const flush = () => _upd(sw.id, {
      pages_fetched: (sw.pages_fetched || 0) + c.fetched, pages_reused: (sw.pages_reused || 0) + c.reused,
      pages_failed: (sw.pages_failed || 0) + c.failed, skipped_robots: (sw.skipped_robots || 0) + c.robots,
      skipped_binary: (sw.skipped_binary || 0) + c.binary, pdfs_grabbed: (sw.pdfs_grabbed || 0) + c.pdfs,
      docs_landed: (sw.docs_landed || 0) + c.docs,
    });
    for (let n = 0; n < bite; n++) {
      const url = sl.nextPending(sw.host);
      if (!url) {
        const plan = sl.getPlan(sw.host);
        const total = plan && plan.urls ? plan.urls.length : 0;
        flush();
        _upd(sw.id, { status: 'done', done_ts: Date.now() });
        const fin = db().getDb().prepare('SELECT * FROM site_sweeps WHERE id = ?').get(sw.id);
        say.push(`Site sweep of ${sw.host} is COMPLETE — ${total} page(s) mapped and walked: ${fin.pages_fetched} fetched live, ${fin.pages_reused} served from held copies, ${fin.skipped_robots} robots-disallowed, ${fin.skipped_binary} binary skipped, ${fin.pdfs_grabbed} PDF(s) grabbed, ${fin.pages_failed} unreachable. ${fin.docs_landed} document(s) landed; digestion continues on the decompose budget (all pages of this site count as ONE source — corroboration stays honest).`);
        log(`[site-sweep] ${sw.host} DONE — ${total} pages, fetched ${fin.pages_fetched}, reused ${fin.pages_reused}, failed ${fin.pages_failed}`);
        return { status: 'done', say };
      }
      // the dead-host breaker: pause, say so, auto-resume when it clears
      const down = (() => { try { return sl.hostDown(sw.host, { now: Date.now() }); } catch { return null; } })();
      if (down) {
        flush();
        _upd(sw.id, { status: 'paused', note: `breaker: ${down.fails} straight door failures` });
        say.push(`The sweep of ${sw.host} is paused — ${down.fails} straight access failures with no door working (the host looks down). I'll re-probe automatically in about ${Math.max(1, Math.ceil((down.retryAtTs - Date.now()) / 60000))} minutes.`);
        return { status: 'paused', say };
      }
      if (PDF_RE.test(url)) {
        try {
          const canGrab = deps.downloadPdf && (!deps.isBrowserConnected || deps.isBrowserConnected());
          if (canGrab) { const g = await deps.downloadPdf(url); if (g && g.ok) c.pdfs++; else c.binary++; }
          else c.binary++;
        } catch { c.binary++; }
        sl.markDone(sw.host, url); continue;
      }
      if (BINARY_RE.test(url)) { c.binary++; sl.markDone(sw.host, url); continue; }
      if (rules && robotsBlocked(url, rules)) { c.robots++; sl.markDone(sw.host, url); continue; }
      const sk = (() => { try { return sl.shouldSkip(url, { now: Date.now() }); } catch { return { skip: false }; } })();
      if (sk.skip) { c.reused++; sl.markDone(sw.host, url); continue; }   // each page only once
      const r = await _fetchOne(url, sw.host, deps);
      if (r && r.ok) {
        c.fetched++;
        try { const row = sl.seen(url); if (row && row.doc_id) c.docs++; } catch {}
        if (r.links && r.links.length) { try { sl.buildPlan(url, r.links, { now: Date.now() }); } catch {} }   // the frontier self-extends
      } else { c.failed++; }
      sl.markDone(sw.host, url);
      // the sweep's own governor — nothing else rate-limits page navigation; jitter through the
      // governed entropy lane (smooth dynamics, never a raw Math.random source)
      if (n < bite - 1) await sleep(Math.max(0, Math.round(require('./entropy').jitter('site-sweep', delayMs + 1500, 1500))));
    }
    flush();
    // quarter milestones — the "slowness EXPLAINED" narration Lucas asked for
    try {
      const plan = sl.getPlan(sw.host);
      if (plan && plan.urls.length) {
        const done = plan.urls.filter((e) => e.status === 'done').length;
        const q = Math.floor((4 * done) / plan.urls.length);
        if (q > (sw.milestone || 0) && q < 4) {
          _upd(sw.id, { milestone: q });
          say.push(`Sweep progress on ${sw.host}: ${done}/${plan.urls.length} pages digested (${q * 25}%) — still working through it.`);
        }
      }
    } catch {}
    return { status: 'active', say };
  } catch (e) {
    try { _upd(sw.id, { status: 'paused', note: `walker error: ${str(e.message).slice(0, 160)}` }); } catch {}
    log(`[site-sweep] tick error on ${sw && sw.host}: ${e.message} — sweep paused`);
    return { status: 'paused', say };
  }
}

// ── standing (the status door + work_state read this — measured, never composed) ────────────────
function standing() {
  const sw = activeSweep() || lastSweep();
  if (!sw) return null;
  let done = 0, total = 0;
  try { const p = _sl().getPlan(sw.host); if (p) { total = p.urls.length; done = p.urls.filter((e) => e.status === 'done').length; } } catch {}
  return { host: sw.host, status: sw.status, done, total, fetched: sw.pages_fetched, reused: sw.pages_reused, failed: sw.pages_failed, skippedRobots: sw.skipped_robots, skippedBinary: sw.skipped_binary, pdfs: sw.pdfs_grabbed, docs: sw.docs_landed, note: sw.note, updatedTs: sw.updated_ts };
}
function standingLine() {
  const s = standing();
  if (!s) return null;
  return `[site-sweep] ${s.host}: ${s.status} — ${s.done}/${s.total} pages (${s.fetched} fetched, ${s.reused} reused, ${s.failed} failed, ${s.docs} docs)${s.note ? ` · ${s.note}` : ''}`;
}

module.exports = {
  startSweep, stopSweep, activeSweep, lastSweep, sweepTick, isSweptHost,
  orderMatch, parseRobots, robotsBlocked, parseSitemap, standing, standingLine,
  SWEEP_BITE, PAGE_DELAY_MS, SWEPT_WINDOW_MS,
};
