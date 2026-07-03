/**
 * lib/poll_wikipedia.js — Wikipedia poll-table PARSER (Suite-A adapter #1, the free backbone).
 *
 * Pure, dependency-free, offline-testable. Turns a Wikipedia polling page's `wikitable` HTML
 * (e.g. "Opinion polling on the second Trump presidency", generic-ballot / horse-race pages) into
 * NORMALIZED poll rows. Header-DRIVEN column mapping (robust to column order + table type: approval,
 * favorability, generic ballot, head-to-head), matching the codebase's hand-rolled-regex HTML idiom
 * (studio/feeds_view.js `stripHtml`/`parseAggMembers`) — no cheerio/jsdom (not a dep).
 *
 * The normalized shape is the SHARED adapter shape (docs/POLLING_SOURCE_MAP.md §4a): it lines up
 * field-for-field with the VoteHub API poll object AND Echo's `poll_fielding`+`poll_topline` model
 * (docs/WORLD_MODEL_FORECAST_BRAINSTORM.md §0), so every source — free or paid — normalizes to ONE
 * shape and lands the same way. This module is storage-agnostic: it PARSES; where rows land (Suite-A
 * bucket / Echo) is a later wiring slice. Fail-soft throughout — bad markup yields fewer rows, never a throw.
 *
 * NormalizedPoll = {
 *   source_kind:'wikipedia', tier:'free', poll_type, subject,      // poll_type/subject supplied by caller
 *   pollster, sponsor, population:'a'|'rv'|'lv'|'v'|null,          // population = VoteHub convention; Echo frame = uppercase
 *   sample_size:number|null, moe_pct:number|null,
 *   start_date, end_date,                                          // ISO 'YYYY-MM-DD' | null
 *   url:string|null, answers:[{choice, pct:number}], is_aggregate:bool, source_id
 * }
 *
 * Offline-testable: scripts/smoke_poll_wikipedia.js.
 * KNOWN LIMITATION (flagged, not faked — refine later): rows using rowspan (a pollster spanning several
 * polls) or colspan section/aggregate banners are SKIPPED and COUNTED in `.skipped` (no silent drop).
 */
'use strict';

// --- text helpers (mirror studio/feeds_view.js) ---
const ENT = (s) => String(s == null ? '' : s)
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&#039;/g, "'")
  .replace(/&quot;/g, '"').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&minus;/g, '−');
const stripRefs = (s) => String(s == null ? '' : s).replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '').replace(/\[\d+\]/g, '');
// Quote-AWARE tag strip: Wikipedia annotation spans carry embedded JSON in data-mw="{…>…}" attributes,
// so a naive /<[^>]+>/ stops on the `>` INSIDE the quoted attribute and leaks markup junk into the text.
// This tolerates `>` inside "…" / '…' attribute values.
const stripTags = (s) => String(s == null ? '' : s)
  .replace(/<[^>"']*(?:"[^"]*"|'[^']*'[^>"']*)*>/g, ' ')   // tags with (possibly `>`-containing) quoted attrs
  .replace(/<[^>]*>/g, ' ');                                // any remaining simple tags
const clean = (s) => ENT(stripTags(stripRefs(s))).replace(/\s+/g, ' ').trim();

// --- numeric parsing ---
function parsePct(s) {
  const t = clean(s).replace(/[%−]/g, (c) => (c === '−' ? '-' : ''));   // strip %, unicode-minus→'-'
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
// "1,002 (A)" / "800 (LV)" / "1,500 RV" / "≈1000" → { sample_size, population }
function parseSample(s) {
  const t = clean(s);
  const num = (t.replace(/,/g, '').match(/\d{2,}/) || [])[0];
  const popM = t.match(/\b(LV|RV|A|V|likely voters?|registered voters?|adults?|all voters?)\b/i);
  let population = null;
  if (popM) {
    const p = popM[1].toLowerCase();
    population = p.startsWith('likely') || p === 'lv' ? 'lv'
      : p.startsWith('registered') || p === 'rv' ? 'rv'
        : p.startsWith('adult') || p === 'a' ? 'a'
          : p.startsWith('all') || p === 'v' ? 'v' : null;
  }
  return { sample_size: num ? Number(num) : null, population };
}
// "±3.5%" / "3.2" / "—" → number|null
function parseMoe(s) {
  const m = clean(s).match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, mo, d) => (y && mo && d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
// "July 7–21, 2026" / "June 30 – July 2, 2026" / "July 21, 2026" / "2026-07-21" → { start_date, end_date }
function parseDateRange(s) {
  const t = clean(s).replace(/[–—]/g, '-');   // en/em dash → hyphen
  const isoM = t.match(/(\d{4})-(\d{2})-(\d{2})/);       // already ISO?
  if (isoM) { const d = iso(+isoM[1], +isoM[2], +isoM[3]); return { start_date: d, end_date: d }; }
  const year = (t.match(/\b(20\d{2})\b/) || [])[1];
  if (!year) return { start_date: null, end_date: null };
  // collect "Mon D" tokens (each optionally carrying its own month). Strip the 4-digit year first so its
  // digits aren't mis-read as a day (e.g. "2026" → 20, 26).
  const body = t.replace(/\b20\d{2}\b/g, ' ');
  const toks = [];
  const re = /([A-Za-z]{3,9})?\.?\s*(\d{1,2})(?:st|nd|rd|th)?/g;
  let m; let lastMo = null;
  while ((m = re.exec(body))) {
    const moKey = m[1] ? m[1].slice(0, 3).toLowerCase() : null;
    const mo = moKey && MONTHS[moKey] ? MONTHS[moKey] : lastMo;
    if (!mo) continue;
    lastMo = mo;
    toks.push({ mo, d: Number(m[2]) });
  }
  if (!toks.length) return { start_date: null, end_date: null };
  const a = toks[0], b = toks[toks.length - 1];
  return { start_date: iso(+year, a.mo, a.d), end_date: iso(+year, b.mo, b.d) };
}

// Wikipedia poll cells often embed template annotations as ESCAPED text (`&lt;/span>{"template":…}` —
// abbr/partisan tags). A real pollster/sponsor name is plain text, so truncate at the first markup/JSON
// metacharacter — that strips the leaked annotation without a full wikitext parser.
const cleanName = (s) => clean(s).split(/&lt;|&gt;|[<>{}[\]|"]/)[0].replace(/\s+/g, ' ').trim();

// pollster cell → { pollster, sponsor, url } (first <a> = pollster + href; "A/B" or "A (sponsor)" → sponsor)
function parsePollster(cellHtml) {
  const href = (String(cellHtml).match(/<a[^>]+href="([^"]+)"/i) || [])[1] || null;
  const full = cleanName(cellHtml);
  let pollster = full, sponsor = '';
  const slash = full.split('/');
  if (slash.length === 2) { pollster = slash[0].trim(); sponsor = slash[1].trim(); }
  const paren = full.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren && !sponsor) { pollster = paren[1].trim(); sponsor = paren[2].trim(); }
  return { pollster, sponsor, url: href };
}

// --- table extraction (regex, tolerant) ---
function extractTables(html) {
  const out = [];
  const re = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function extractRows(tableHtml) {
  return (tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || []);
}
function extractCells(rowHtml) {
  const cells = [];
  const re = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(rowHtml))) {
    const attrs = m[2] || '';
    const colspan = Number((attrs.match(/colspan="?(\d+)/i) || [])[1] || 1);
    const rowspan = Number((attrs.match(/rowspan="?(\d+)/i) || [])[1] || 1);
    cells.push({ tag: m[1].toLowerCase(), html: m[3], text: clean(m[3]), colspan, rowspan });
  }
  return cells;
}

// header text → role. Meta roles are recognized; anything else is an ANSWER column (choice = header text).
const META = [
  { role: 'pollster', re: /pollster|poll source|poll(?:ing)? (?:firm|org)|source/i },
  { role: 'date', re: /date/i },
  { role: 'sample', re: /sample|\bn\b/i },
  { role: 'moe', re: /margin|error|\bmoe\b/i },
];
// derived/meta columns that are NOT a poll answer (word-boundary, so "Net approval"/"Net favorability" match)
const SKIP_ANSWER = /^(net|spread|lead|margin|error|moe|source|notes?|winner|result|ref)\b/i;
function mapHeaders(headerCells) {
  const cols = headerCells.map((c) => {
    const hit = META.find((x) => x.re.test(c.text));
    return hit ? { kind: hit.role } : { kind: 'answer', choice: c.text };
  });
  return cols;
}

const AGG_RE = /average|aggregat|rcp|realclear|fivethirtyeight|538|polling average|consensus/i;
function slug(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

/**
 * Parse one Wikipedia polling table's HTML into normalized rows.
 * opts: { subject, poll_type, source_kind='wikipedia', tier='free' }
 * returns { polls:[NormalizedPoll], skipped:number }
 */
function parseTable(tableHtml, opts = {}) {
  const { subject = '', poll_type = '', source_kind = 'wikipedia', tier = 'free' } = opts;
  const rows = extractRows(tableHtml);
  const polls = []; let skipped = 0; let cols = null;
  for (const r of rows) {
    const cells = extractCells(r);
    if (!cells.length) continue;
    const isHeader = cells.every((c) => c.tag === 'th') || (!cols && cells.some((c) => c.tag === 'th'));
    if (isHeader && !cols) { cols = mapHeaders(cells); continue; }
    if (!cols) continue;                                  // data before any header → skip
    if (cells.some((c) => c.colspan > 1) || cells.some((c) => c.rowspan > 1)) { skipped++; continue; } // span rows (limitation)
    if (cells.length !== cols.length) { skipped++; continue; }

    const rec = {
      source_kind, tier, poll_type, subject,
      pollster: '', sponsor: '', population: null, sample_size: null, moe_pct: null,
      start_date: null, end_date: null, url: null, answers: [], is_aggregate: false,
    };
    cells.forEach((c, i) => {
      const col = cols[i]; if (!col) return;
      if (col.kind === 'pollster') { const p = parsePollster(c.html); rec.pollster = p.pollster; rec.sponsor = p.sponsor; rec.url = p.url; }
      else if (col.kind === 'date') { const d = parseDateRange(c.text); rec.start_date = d.start_date; rec.end_date = d.end_date; }
      else if (col.kind === 'sample') { const s = parseSample(c.text); rec.sample_size = s.sample_size; rec.population = s.population; }
      else if (col.kind === 'moe') { rec.moe_pct = parseMoe(c.text); }
      else if (col.kind === 'answer' && col.choice && !SKIP_ANSWER.test(col.choice)) {
        const pct = parsePct(c.text);
        if (pct != null) rec.answers.push({ choice: col.choice, pct });
      }
    });
    if (!rec.pollster && !rec.answers.length) { skipped++; continue; }   // empty/garbage row
    rec.is_aggregate = AGG_RE.test(rec.pollster);
    rec.source_id = slug([source_kind, poll_type, subject, rec.pollster, rec.start_date, rec.end_date].join('|'));
    polls.push(rec);
  }
  return { polls, skipped };
}

/**
 * Parse a whole page. `tables` maps which wikitable indices carry what:
 *   parsePage(html, { subject:'Donald Trump', tables:[{poll_type:'approval'}] })  // index-aligned to extractTables()
 * If `tables` omitted, every wikitable is parsed with the page-level {subject, poll_type}.
 * Returns { polls, skipped, tableCount }.
 */
function parsePage(html, opts = {}) {
  const tbls = extractTables(html);
  const all = []; let skipped = 0;
  tbls.forEach((t, i) => {
    const per = (opts.tables && opts.tables[i]) || {};
    if (opts.tables && !opts.tables[i]) return;           // explicit table list → parse only listed indices
    const r = parseTable(t, { ...opts, ...per });
    all.push(...r.polls); skipped += r.skipped;
  });
  return { polls: all, skipped, tableCount: tbls.length };
}

module.exports = {
  parsePage, parseTable, extractTables, extractRows, extractCells,
  parsePct, parseSample, parseMoe, parseDateRange, parsePollster, mapHeaders, clean,
};
