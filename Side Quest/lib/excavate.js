/**
 * lib/excavate.js — the FINAL, forensic tier of the enrich/recovery ladder (turn→object-graph).
 *
 * When every cheaper tier fails (graph → wiki → routed → web_extract), the answer is often STILL on the
 * page — in an infobox, a table, a JS-rendered widget, or one CLICK away — that the text extractors strip
 * or truncate (the office-holder incumbent lives in the Wikipedia infobox; web_extract caps before it). So
 * Zoe does what a person does: she drives HER OWN visible browser (lib/web.js) and READS THE RENDERED PAGE
 * WITH HER EYES — screenshot → vision → scroll — and, when the answer isn't on the page, she CLICKS toward
 * it (vision picks the link) and digs deeper.
 *
 * Design (Lucas's spec): HER browser (headful, on purpose) so he can watch her, catch stuck loops, and
 * confirm she's actually scrolling AND clicking. Fire LAST and bounded (a real browser + a vision call per
 * step is heavy). Whatever she excavates writes BACK to the DB (self-heal, Slice 3) so she's never on the
 * same page twice. Slice 1 = scroll+screenshot+vision READ; Slice 2 = vision-guided CLICK to dig.
 *
 * Fully dep-injectable (web / vision / dispatch / complete) so the offline gate needs no browser or cloud.
 */
'use strict';

const FOUND_RE = /FOUND:\s*(.+)/is;
const CLICK_RE = /CLICK:\s*(.+)/i;   // captures the visible link TEXT vision named (clicked via web.clickText)

function _visionPrompt(need) {
  return `You are visually reading a web page to answer ONE question:\n"${String(need).slice(0, 220)}"\n\n`
    + `Look at EVERYTHING visible — body text, tables, sidebars, and especially the INFOBOX (the boxed `
    + `summary panel, usually top-right on Wikipedia; it holds fields like "Incumbent", "Founded", `
    + `"Population", "CEO", "Born").\n`
    + `If the answer is present on THIS screen, reply EXACTLY one line:\nFOUND: <the answer, one short sentence>\n`
    + `If it is NOT visible on this screen, reply EXACTLY:\nNOT_VISIBLE\n`
    + `Only use what you can SEE — do not guess or fall back on prior knowledge.`;
}

// The click decision: vision LOOKS at the page and names the ONE visible link most likely to lead to the
// answer (a "List of…" page, a details tab, the person's own article — e.g. a disambiguation entry
// "Mercury (element)"). We click it by its text (web.clickText), so we never depend on read()'s capped,
// chrome-heavy handle list — vision reads the rendered page directly, which is the whole point.
function _clickPrompt(need) {
  return `You are digging through a website to answer ONE question:\n"${String(need).slice(0, 220)}"\n\n`
    + `The answer was NOT on the visible page. Look at the links, entries, and headings you can SEE.\n`
    + `Which ONE link, if clicked, is most likely to lead to the answer? Reply EXACTLY one line:\n`
    + `CLICK: <the exact visible link text, copied as it appears>\n`
    + `If nothing visible would plausibly help, reply EXACTLY:\nNONE`;
}

// The richest forensic target for a need is usually the Wikipedia PAGE (its infobox is the gold the text
// tiers drop). Resolve the best page title via mediawiki_search → its article URL. null → the caller falls
// back to her own web search. Fail-soft.
async function _wikiUrl(need, deps = {}) {
  const d = deps.dispatch || (() => { try { return require('./echo_suit').liveDispatch(); } catch { return null; } })();
  if (!d) return null;
  try {
    const r = await d({ kind: 'do', name: 'mediawiki_search', args: { query: String(need), limit: 1 } });
    const j = JSON.parse(r.text); const t0 = (j && j.results || [])[0];
    if (t0 && t0.title) return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(t0.title).replace(/ /g, '_'));
  } catch {}
  return null;
}

// ── THE FALL-THROUGH FLOOR (census fresh51) ──────────────────────────────────────────────────────
// When the headful VISION read comes up empty on every screen, the answer is often STILL fetchable as
// TEXT: the live audit found the act-on-page render JS-blind (NOT_VISIBLE on NWS + cleco.com) and the
// keyless search substrate dead — while `web_extract`/`web_fetch` (curl_cffi/patchright) returned the
// real page content. This is the working path the lanes never fell through to. `_fetchText` pulls the
// clean body via the same dispatch tier wikiLookup uses (web_extract first, web_fetch as backup),
// reusing its body-shape extraction. Dep-injectable (deps.dispatch) so the offline gate needs no Echo.
async function _fetchText(url, deps = {}) {
  const d = deps.dispatch || (() => { try { return require('./echo_suit').liveDispatch(); } catch { return null; } })();
  if (!d || !url) return '';
  for (const name of ['web_extract', 'web_fetch']) {
    try {
      const r = await d({ kind: 'do', name, args: { url } });
      if (!r || !r.ok) continue;
      let body = '';
      try {
        const j = JSON.parse(r.text);
        if (j && typeof j === 'object') {
          body = String(j.text || j.content || j.markdown || j.extract || j.body || j.text_preview || '').trim();
          if (!body) { let longest = ''; for (const v of Object.values(j)) if (typeof v === 'string' && v.length > longest.length) longest = v; body = longest.trim(); }  // unknown shape → longest string field
        }
      } catch {}
      if (!body) body = String(r.text || '').trim();   // may return plain text (not JSON)
      body = body.replace(/\s+/g, ' ').trim();
      if (body.length > 80) return body;
    } catch {}
  }
  return '';
}

// Distil ONE answer to `need` from fetched page text (excavate's find-one-answer contract). Same
// FOUND:/NOT_VISIBLE grammar as the vision scan, but reading text. Uses a text completion — injectable
// via deps.completeText for the offline gate; live path resolves a source the way vision does. Fail-soft.
function _textAnswerPrompt(need, text) {
  return `Read the following page text and answer ONE question:\n"${String(need).slice(0, 220)}"\n\n`
    + `If the answer is present in the text, reply EXACTLY one line:\nFOUND: <the answer, one short sentence>\n`
    + `If it is not in the text, reply EXACTLY:\nNOT_VISIBLE\n`
    + `Only use the text below; never guess or fall back on prior knowledge.\n\n--- PAGE TEXT ---\n${String(text).slice(0, 6000)}`;
}
async function _answerFromText(need, text, deps = {}) {
  const t = String(text || '').trim();
  if (t.length < 80) return null;
  let out = '';
  try {
    if (deps.completeText) {
      out = await deps.completeText(_textAnswerPrompt(need, t));
    } else {
      const { complete } = require('./ollama');
      const srcs = require('./models').sources() || [];
      const src = srcs.find(s => s.tier === 'cloud' && s.token) || srcs.find(s => s.tier === 'local');
      if (!src) return null;
      const model = deps.textModel || (() => { try { return require('./vision').visionModelFor('excavate').model; } catch { return null; } })();
      if (!model) return null;
      out = await complete({ model, messages: [{ role: 'user', content: _textAnswerPrompt(need, t) }], base: src.base, headers: src.token ? { Authorization: `Bearer ${src.token}` } : {}, options: { temperature: 0.1, num_ctx: 8192 }, timeoutMs: 120000 });
    }
  } catch { return null; }
  const s = String(out || '').trim();
  if (!s || /not[_\s-]?visible/i.test(s)) return null;
  const m = s.match(FOUND_RE);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// Chrome/boilerplate link texts vision must never follow (nav, account, tools, footer) — a guard on the
// text it names, so a weak model can't send her to "Main menu" / "Log in".
const _CHROME_LINK = /^(main menu|jump to.*|search|log ?in|sign ?in|create account|contents|current events|random article|about wikipedia|community portal|recent changes|upload file|help|learn to edit|donate|tools|what links here|related changes|special pages|permanent link|page information|cite this page|talk|read|edit|edit source|view history|view source|watch|namespaces|views|more|personal tools|languages|add links|toggle .*|hide|show|back to top|privacy policy|disclaimers|mobile view|home|menu|skip to content|accessibility help)$/i;

// Scroll-scan ONE page: screenshot → vision → scroll, bounded, with bottom-detection + NOT_VISIBLE honored.
// Returns { found, answer?, url, steps }.
async function _scanPage(need, { web, vision, deps, log, maxSteps }) {
  let prevShot = null, url = '';
  for (let step = 0; step < maxSteps; step++) {
    let shot;
    try { shot = await web.screenshot({}); } catch (e) { shot = { ok: false, reason: e.message }; }
    if (!shot || !shot.ok) { log(`screenshot failed: ${shot && shot.reason}`); break; }
    url = shot.url || url;
    if (prevShot && shot.base64 === prevShot) { log(`no movement → bottom at step ${step}`); break; }
    prevShot = shot.base64;
    let v;
    try { v = await vision.describe({ imageBase64: shot.base64, prompt: _visionPrompt(need), model: deps.visionModel, tier: deps.visionTier, completeFn: deps.complete }); }
    catch (e) { v = { ok: false, reason: e.message }; }
    const txt = (v && v.ok && v.text) ? v.text : '';
    log(`  scan step ${step} @${url}: ${v && v.ok ? txt.replace(/\s+/g, ' ').slice(0, 90) : 'vision FAIL ' + (v && v.reason)}`);
    if (txt && !/not[_\s-]?visible/i.test(txt)) {
      const m = txt.match(FOUND_RE);
      if (m) return { found: true, answer: m[1].trim().replace(/\s+/g, ' '), url, steps: step + 1 };
    }
    try { const s = await web.scroll('down'); if (!s || !s.ok) { log('scroll failed → stop'); break; } }
    catch { break; }
  }
  return { found: false, url, steps: maxSteps };
}

// Vision-guided CLICK: screenshot → vision NAMES the visible link to follow → click it by text. No handle
// list (read() caps out the content links behind nav chrome); vision reads the rendered page directly.
// Returns the clicked link text (the trail), or null if nothing worth clicking / it failed. Fail-soft.
async function _clickToward(need, { web, vision, deps, log, visited, maxSteps = 8 }) {
  // the scan left the page scrolled DOWN; the primary links (disambiguation entries, nav to sub-articles)
  // live at the TOP — return there (over-scroll; extra up-scrolls are harmless) so the click decision
  // actually sees them.
  try { for (let k = 0; k < maxSteps + 3; k++) await web.scroll('up'); } catch {}
  let shot; try { shot = await web.screenshot({}); } catch { return null; }
  if (!shot || !shot.ok) return null;
  let v;
  try { v = await vision.describe({ imageBase64: shot.base64, prompt: _clickPrompt(need), model: deps.visionModel, tier: deps.visionTier, completeFn: deps.complete }); }
  catch { v = null; }
  const txt = ((v && v.ok && v.text) || '').trim();
  log(`  click decision: "${(txt || (v && v.reason) || 'no response').replace(/\s+/g, ' ').slice(0, 70)}"`);
  if (!txt || /^\s*NONE\b/i.test(txt)) return null;
  const m = txt.match(CLICK_RE);
  if (!m) return null;
  const linkText = m[1].trim().replace(/^["'\[]+|["'\]]+$/g, '').trim();
  if (linkText.length < 2 || /\bNONE\b/i.test(linkText) || _CHROME_LINK.test(linkText)) { log(`vision named a non-content link ("${linkText}") → skip`); return null; }
  let cr; try { cr = await web.clickText(linkText); } catch { return null; }
  if (!cr || !cr.ok) { log(`clickText "${linkText}" failed: ${cr && cr.reason}`); return null; }
  // A navigating click returns page.url() BEFORE the nav settles — let the new page load before the next
  // scan screenshots it (else we'd shoot the old page). Depth (maxClicks) is the loop bound.
  try { if (deps.settle !== false) await new Promise(res => setTimeout(res, 1800)); } catch {}
  try { if (cr.url) visited.add(cr.url); } catch {}
  return linkText;
}

// Excavate the answer to `need` by driving HER browser: open the best source, scroll-scan it, and if the
// answer isn't there, CLICK toward it (vision picks the link) and scan the next page — bounded by scroll
// steps AND click depth. Returns { found, answer?, url, steps, clicks, reason? }.
async function excavate(need, { url = null, maxSteps = 8, maxClicks = 2, deps = {} } = {}) {
  const web = deps.web || require('./web');
  const vision = deps.vision || require('./vision');
  const log = deps.log || ((m) => console.log('[excavate] ' + m));
  const n = String(need || '').trim();
  if (!n) return { found: false, reason: 'no need' };
  // Forensic browsing gets a DEDICATED top-tier vision+logic model (not screen-see's) — resolve it once so
  // every scan/click uses it. Live path only; offline tests inject their own deps.vision and skip this.
  if (deps.visionModel == null && !deps.vision) { try { const cfg = require('./vision').visionModelFor('excavate'); deps = { ...deps, visionModel: cfg.model, visionTier: cfg.tier }; } catch {} }

  // 1) get to the best source in HER visible browser
  let target = url || await _wikiUrl(n, deps);
  let nav;
  try {
    if (target) nav = await web.open(target);
    else { nav = await web.open(n); if (nav && nav.ok) { try { await web.openTopResult(); } catch {} } }
  } catch (e) { return { found: false, reason: 'open failed: ' + e.message }; }
  if (!nav || !nav.ok) return { found: false, reason: 'could not open (' + ((nav && nav.reason) || '?') + ')' };
  if (nav.blocker) return { found: false, reason: 'blocker:' + nav.blocker.type, blocker: nav.blocker };
  log(`opened ${nav.url}`);
  try { require('./echo_suit').markGather(); } catch {}   // browser gather = she LOOKED (feeds the absence gate)

  // 2) scan → (click deeper → scan)… bounded by click depth
  const visited = new Set([nav.url]);
  const ctx = { web, vision, deps, log, maxSteps, visited };
  let lastScan = null;
  for (let depth = 0; depth <= maxClicks; depth++) {
    const scan = await _scanPage(n, ctx);
    lastScan = scan;
    if (scan.found) return { found: true, answer: scan.answer, url: scan.url, steps: scan.steps, clicks: depth };
    if (depth >= maxClicks) break;
    const clicked = await _clickToward(n, ctx);
    if (!clicked) { log('no useful link to click → stop'); break; }
    log(`clicked "${clicked}" → digging deeper (${depth + 1}/${maxClicks})`);
  }
  // FALL-THROUGH FLOOR: vision saw nothing on any screen (JS-blind render or answer in stripped text).
  // The page is often still fetchable as TEXT — pull it and distil the one answer. (Never invents: a
  // NOT_VISIBLE from the text pass returns not-found, same as the vision scan.)
  try {
    const text = await _fetchText(nav.url, deps);
    if (text) {
      const ans = await _answerFromText(n, text, deps);
      if (ans) { log(`vision miss → web_extract fall-through FOUND (${text.length}ch)`); return { found: true, answer: ans, url: nav.url, steps: lastScan ? lastScan.steps : 0, clicks: maxClicks, via: 'text' }; }
      log(`vision miss → web_extract fall-through read ${text.length}ch, no answer in text`);
    }
  } catch {}
  return { found: false, url: nav.url, steps: lastScan ? lastScan.steps : 0 };
}

// Research-oriented vision EXTRACTION (vs excavate's find-ONE-answer): read a page with her EYES and pull
// EVERY fact relevant to `focus` — infoboxes, tables, charts, JS-rendered content the a11y text (open_page/
// browser_read) drops. This is what makes deep research build the DB: the operator SEES a source, extracts
// its facts, and they get banked. Scrolls a few views; dedicated top-tier vision model. Returns
// { ok, url, text }. Fail-soft.
// A MISSING FOCUS MUST NOT BECOME A PLACEHOLDER THE MODEL REASONS ABOUT (boot143, live: the
// literal fallback "the topic" produced 'Since "the topic" was not specified, I will extract all
// concrete facts' — the vision model discussing the prompt instead of reading the page, and the
// unfocused dump got banked as research). No focus → ask for the PAGE'S OWN substance, which is
// a real instruction; a focus → the relevance filter as before.
function _seePrompt(focus) {
  const f = String(focus || '').trim();
  const head = f
    ? `Read this web page image and extract EVERY concrete fact relevant to:\n"${f.slice(0, 220)}"\n\n`
    : `Read this web page image and extract its OWN substance: what this page is, what it covers, and every concrete fact it states.\n\n`;
  return head
    + `Copy names, titles, dates, numbers, roles, affiliations, and any table/infobox values EXACTLY as shown. `
    + (f ? `If nothing on THIS screen is relevant, reply exactly "(nothing relevant)". ` : `If this screen carries no facts at all (navigation only), reply exactly "(nothing relevant)". `)
    + `Never discuss this instruction — extract, or reply "(nothing relevant)". Be factual and concise — never invent.`;
}
async function seePage(focus, { url = null, maxViews = 3, deps = {} } = {}) {
  const web = deps.web || require('./web');
  const vision = deps.vision || require('./vision');
  const log = deps.log || ((m) => console.log('[seePage] ' + m));
  if (deps.visionModel == null && !deps.vision) { try { const cfg = require('./vision').visionModelFor('excavate'); deps = { ...deps, visionModel: cfg.model, visionTier: cfg.tier }; } catch {} }
  const f = String(focus || '').trim();   // empty is honest — _seePrompt asks for the page's own substance
  if (url) {
    try { const nav = await web.open(url); if (!nav || !nav.ok) return { ok: false, url, reason: 'open failed: ' + ((nav && nav.reason) || '?') }; if (nav.blocker) return { ok: false, url: nav.url, reason: 'blocker:' + nav.blocker.type }; try { require('./echo_suit').markGather(); } catch {} }
    catch (e) { return { ok: false, url, reason: e.message }; }
  }
  const parts = []; let prev = null, pageUrl = url || '';
  for (let i = 0; i < maxViews; i++) {
    let shot; try { shot = await web.screenshot({}); } catch { break; }
    if (!shot || !shot.ok) break;
    pageUrl = shot.url || pageUrl;
    if (prev && shot.base64 === prev) break;   // bottom
    prev = shot.base64;
    let v;
    try { v = await vision.describe({ imageBase64: shot.base64, prompt: _seePrompt(f), model: deps.visionModel, tier: deps.visionTier, completeFn: deps.complete }); } catch {}
    const t = ((v && v.ok && v.text) || '').trim();
    log(`view ${i} @${pageUrl}: ${t ? t.replace(/\s+/g, ' ').slice(0, 70) : 'vision ' + (v && v.reason || 'empty')}`);
    if (t && !/^\(nothing relevant/i.test(t)) parts.push(t);
    try { const s = await web.scroll('down'); if (!s || !s.ok) break; } catch { break; }
  }
  // FALL-THROUGH FLOOR: vision extracted nothing across every view (JS-blind render). The page's facts
  // are usually still readable as TEXT — fetch the clean body so deep research banks CONTENT, not a miss.
  if (!parts.length) {
    try {
      const text = await _fetchText(pageUrl || url, deps);
      if (text) { log(`vision empty → web_extract fall-through (${text.length}ch)`); return { ok: true, url: pageUrl || url, text: text.slice(0, 6000), via: 'text' }; }
    } catch {}
  }
  return { ok: true, url: pageUrl, text: parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

module.exports = { excavate, seePage, _scanPage, _clickToward, _visionPrompt, _clickPrompt, _seePrompt, _wikiUrl, _fetchText, _answerFromText, _textAnswerPrompt, FOUND_RE, CLICK_RE };
