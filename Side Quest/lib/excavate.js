/**
 * lib/excavate.js — the FINAL, forensic tier of the enrich/recovery ladder (turn→object-graph).
 *
 * When every cheaper tier fails (graph → wiki → routed → web_extract), the answer is often STILL on the
 * page — in an infobox, a table, a JS-rendered widget — that the text extractors strip or truncate (the
 * office-holder incumbent lives in the Wikipedia infobox; web_extract caps before it). So Zoe does what a
 * person does: she drives HER OWN visible browser (lib/web.js) to the best source and READS THE RENDERED
 * PAGE WITH HER EYES — screenshot → vision → scroll → repeat, until she sees the answer or hits the bottom.
 *
 * Design (Lucas's spec): use HER browser (headful, on purpose) so he can watch her, catch stuck loops, and
 * confirm she's actually scrolling. Fire LAST and bounded (a real browser + a vision call per step is
 * heavy). Whatever she excavates is meant to write BACK to the DB (self-heal, Slice 3) so she's never on
 * the same page twice. Slice 1 = scroll+screenshot+vision READ; Slice 2 = click/tactile interaction.
 *
 * Fully dep-injectable (web / vision / dispatch / complete) so the offline gate needs no browser or cloud.
 */
'use strict';

const FOUND_RE = /FOUND:\s*(.+)/is;

function _visionPrompt(need) {
  return `You are visually reading a web page to answer ONE question:\n"${String(need).slice(0, 220)}"\n\n`
    + `Look at EVERYTHING visible — body text, tables, sidebars, and especially the INFOBOX (the boxed `
    + `summary panel, usually top-right on Wikipedia; it holds fields like "Incumbent", "Founded", `
    + `"Population", "CEO", "Born").\n`
    + `If the answer is present on THIS screen, reply EXACTLY one line:\nFOUND: <the answer, one short sentence>\n`
    + `If it is NOT visible on this screen, reply EXACTLY:\nNOT_VISIBLE\n`
    + `Only use what you can SEE — do not guess or fall back on prior knowledge.`;
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

// Excavate the answer to `need` by driving HER browser: open the best source, then screenshot→vision→scroll
// until the answer appears or the page bottoms out. Returns { found, answer?, url, steps, reason? }.
async function excavate(need, { url = null, maxSteps = 8, deps = {} } = {}) {
  const web = deps.web || require('./web');
  const vision = deps.vision || require('./vision');
  const log = deps.log || ((m) => console.log('[excavate] ' + m));
  const n = String(need || '').trim();
  if (!n) return { found: false, reason: 'no need' };

  // 1) get to the best source in HER visible browser
  let target = url || await _wikiUrl(n, deps);
  let nav;
  try {
    if (target) nav = await web.open(target);
    else { nav = await web.open(n); if (nav && nav.ok) { try { await web.openTopResult(); nav = { ...nav, ...(web.isConnected() ? {} : {}) }; } catch {} } }
  } catch (e) { return { found: false, reason: 'open failed: ' + e.message }; }
  if (!nav || !nav.ok) return { found: false, reason: 'could not open (' + ((nav && nav.reason) || '?') + ')' };
  if (nav.blocker) return { found: false, reason: 'blocker:' + nav.blocker.type, blocker: nav.blocker };
  log(`opened ${nav.url}`);

  // 2) screenshot → vision → scroll, bounded; stop at the answer, at the bottom, or at the step cap
  let prevShot = null;
  for (let step = 0; step < maxSteps; step++) {
    let shot;
    try { shot = await web.screenshot({}); } catch (e) { shot = { ok: false, reason: e.message }; }
    if (!shot || !shot.ok) { log(`screenshot failed: ${shot && shot.reason}`); break; }
    if (prevShot && shot.base64 === prevShot) { log(`no movement → bottom at step ${step}`); break; }
    prevShot = shot.base64;
    let v;
    try { v = await vision.describe({ imageBase64: shot.base64, prompt: _visionPrompt(n), completeFn: deps.complete }); }
    catch (e) { v = { ok: false, reason: e.message }; }
    const txt = (v && v.ok && v.text) ? v.text : '';
    log(`step ${step} @${shot.url || ''}: ${v && v.ok ? txt.replace(/\s+/g, ' ').slice(0, 90) : 'vision FAIL ' + (v && v.reason)}`);
    if (txt && !/not[_\s-]?visible/i.test(txt)) {
      const m = txt.match(FOUND_RE);
      if (m) return { found: true, answer: m[1].trim().replace(/\s+/g, ' '), url: shot.url, steps: step + 1 };
    }
    try { const s = await web.scroll('down'); if (!s || !s.ok) { log('scroll failed → stop'); break; } }
    catch { break; }
  }
  return { found: false, steps: maxSteps, url: nav.url };
}

module.exports = { excavate, _visionPrompt, _wikiUrl, FOUND_RE };
