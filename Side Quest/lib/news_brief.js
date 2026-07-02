/**
 * lib/news_brief.js — the CONSISTENT news-brief DOCUMENT: schema-locked cloud fill + deterministic
 * renderer (design §"Compression behavior").
 *
 * Goal (Lucas): a brief the cloud can "get right every time," with the formatting ready to be filled.
 * The reliable pattern (same as research_plan.js / the saga deliverables): the model fills a small FIXED
 * SCHEMA of grounded fields (edition line + per-story summary + developing note); a DETERMINISTIC renderer
 * applies all formatting + attribution. So layout never varies, sources are never confabulated (they're
 * rendered from OUR data, not the model), and a story that isn't in the input can't be invented (the model
 * references stories by the id we give it). Fail-safe: cloud down / invalid → a deterministic fallback
 * built from the story data itself, so a brief ALWAYS renders.
 *
 * PURE + deps-injected: `ask` (cloud_logic.ask) is passed to generateBrief; everything else is offline-
 * testable (scripts/smoke_news_brief.js). The cloud call + wiring live in main.js.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const oneLine = (s, n = 400) => str(s).replace(/\s+/g, ' ').trim().slice(0, n);
const uniq = (a) => [...new Set((a || []).filter(Boolean))];

// --- the model INPUT: compact, grounded, id-referenced story payload -------
// stories: hydrated news_stories rows (entity_set/source_set are Sets); deltasByStory: {id: updates[]}.
function briefInput(stories, { deltasByStory = {}, top = 12 } = {}) {
  return (stories || []).slice(0, top).map((s) => {
    const deltas = (deltasByStory && deltasByStory[s.id]) || [];
    const outlets = uniq([...(s.outlet_set instanceof Set ? s.outlet_set : (s.outlet_set || []))]);
    const outletCount = Number(s.outlet_count) || outlets.length;
    // CORROBORATION = min(distinct outlets, distinct reports) — bounded by BOTH so neither cross-outlet
    // syndication (10 outlets / 1 headline) nor a single-outlet multi-article cluster (1 outlet / 10
    // headlines) inflates it. reportCount = distinct headlines (syndication-collapsed by news_lane).
    const reportCount = Number(s.report_count) || (s.report_set instanceof Set ? s.report_set.size : 0) || (outletCount ? 1 : 0);
    const corroborationCount = Math.min(outletCount, reportCount);
    return {
      id: s.id,
      headline: oneLine(s.title, 200),
      sourceCount: Number(s.source_count) || 0,
      sources: uniq([...(s.source_set instanceof Set ? s.source_set : (s.source_set || []))]).slice(0, 8),
      // CONFIRMATION (rendered from OUR data, never the model): report corroboration + reach + integrity
      outlets: outlets.slice(0, 12),
      outletCount,
      reportCount,
      corroborationCount,
      syndicated: outletCount > corroborationCount && corroborationCount > 0,
      corroboration: corroborationCount >= 5 ? 'widely reported' : (corroborationCount >= 2 ? 'corroborated' : ''),
      redaction: !!s.redaction,
      redactionNote: s.redaction_note || null,
      developing: (Number(s.update_count) || 1) > 1,
      snippet: oneLine(s.summary, 400),
      // the delta trail (how it evolved) — headlines oldest→newest, for the "Developing" line
      priorHeadlines: deltas.map((u) => oneLine(u.title, 160)).filter(Boolean).slice(-6),
    };
  });
}

// --- the model INSTRUCTIONS (system) + the response CONTRACT (want) --------
// The system prompt: the strict grounding rules that make the fill reliable.
const SYSTEM = `You are compiling Zoe's hourly NEWS BRIEF from PRE-CLUSTERED stories. Each story is already grouped across sources. Your ONLY job is to write neutral, factual prose from the material given — you are not gathering news, you are writing it up.

STRICT RULES:
- Ground every sentence in the provided story material. Do NOT add facts, numbers, names, quotes, or context that are not present. If the material is thin, keep the summary short — a thin story gets one sentence.
- NEVER invent or name sources — sources are supplied and rendered for you; do not mention outlets in your prose.
- Neutral wire-service register: what happened, who is involved, where it stands. No opinion, no speculation, no editorializing, no flourish.
- Reference each story by its given "id". Do NOT create stories absent from the input, and do NOT merge or split the given stories.
- For a story marked developing, add ONE line on what has changed across its updates (the delta) — otherwise set it null.
- Output ONLY a single JSON object matching the schema. No prose, no markdown, nothing outside the JSON.`;

// The response contract handed to the cloud (JSON only). Terse + explicit.
function briefWant() {
  return `Produce the brief as a single JSON object and nothing else:
{"edition": string, "stories": [{"id": number, "summary": string, "developing": string|null}]}
- edition: ONE neutral sentence capturing the through-line of the hour's news (a headline of headlines). If the stories share no theme, describe the spread plainly.
- stories: one entry per input story you include, most significant first. Reference the input "id" exactly.
  - summary: 2-3 neutral sentences (1 for a thin story) of what happened, grounded ONLY in that story's material.
  - developing: for a story marked developing, ONE line on what changed across its updates; else null.
- Include every input story unless it is empty; keep the order most-significant first.`;
}

// Validate/parse the cloud reply → {valid, value}. Accepts a JSON object with a stories array.
function briefValidator(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, error: 'not an object' };
    if (!Array.isArray(obj.stories)) return { valid: false, error: 'missing stories[]' };
    return { valid: true, value: obj };
  } catch (e) { return { valid: false, error: e.message }; }
}

// --- deterministic FALLBACK (no cloud): a brief built from the data itself --
function fallbackBrief(input) {
  return {
    edition: '',
    stories: (input || []).map((s) => ({
      id: s.id,
      summary: s.snippet || s.headline,
      developing: s.developing && s.priorHeadlines.length > 1 ? `${s.priorHeadlines.length} updates so far.` : null,
    })),
  };
}

// --- the DETERMINISTIC RENDERER (the fixed formatting) ---------------------
// Joins the model's grounded prose with OUR attribution + structure. Unknown ids are dropped (anti-
// hallucination); sources/counts come from `input`, never the model. topN get full treatment, the rest
// go to "Also Tracking".
function renderBrief(brief, input, { windowLabel = 'the last hour', nowIso = '', topN = 6 } = {}) {
  const byId = new Map((input || []).map((s) => [s.id, s]));
  const modelById = new Map(((brief && brief.stories) || []).map((s) => [s.id, s]));
  // order: follow the model's ordering for known ids, then any input stories the model omitted
  const ordered = [];
  for (const s of ((brief && brief.stories) || [])) if (byId.has(s.id)) ordered.push(byId.get(s.id));
  for (const s of (input || [])) if (!ordered.includes(s)) ordered.push(s);

  const head = [`# 📰 News Brief — ${windowLabel}`, `_${nowIso}${input && input.length ? ` · ${input.length} stories tracked` : ''}_`];
  if (brief && oneLine(brief.edition)) head.push('', `**${oneLine(brief.edition, 300)}**`);

  const out = [head.join('\n')];
  const top = ordered.slice(0, topN), also = ordered.slice(topN);

  if (top.length) {
    const secs = ['## Top Stories'];
    top.forEach((s, i) => {
      const m = modelById.get(s.id) || {};
      const summary = oneLine(m.summary, 800) || s.snippet || s.headline;
      const attribution = (s.outlets && s.outlets.length ? s.outlets : (s.sources || []));
      const meta = [`**Reporting:** ${attribution.join(', ') || '—'}`];
      if (s.corroboration) meta.push(`_${s.corroboration} — ${s.corroborationCount} report${s.corroborationCount === 1 ? '' : 's'}${s.outletCount > s.corroborationCount ? ` across ${s.outletCount} outlets` : ''}_`);
      if (s.developing) meta.push('_developing_');
      const block = [`### ${i + 1}. ${s.headline}`, summary, meta.join('  ·  ')];
      if (s.redaction) block.push(`> ⚠ **Integrity:** a source has issued a ${s.redactionNote || 'correction/retraction'} on this story.`);
      const dev = oneLine(m.developing, 300);
      if (s.developing && dev) block.push(`> **Developing:** ${dev}`);
      secs.push(block.join('\n'));
    });
    out.push(secs.join('\n\n'));
  }
  if (also.length) {
    const lines = also.map((s) => `- ${s.headline} — ${s.corroborationCount || 1} report${(s.corroborationCount || 1) === 1 ? '' : 's'}${s.outletCount > (s.corroborationCount || 1) ? ` / ${s.outletCount} outlets` : ''}${s.corroboration ? ` (${s.corroboration})` : ''}${s.developing ? ' · developing' : ''}${s.redaction ? ' · ⚠correction' : ''}`);
    out.push(['## Also Tracking', lines.join('\n')].join('\n'));
  }
  if (!top.length && !also.length) out.push('_No stories in this window yet._');
  return out.join('\n\n');
}

// --- orchestration: input → cloud fill (or fallback) → render --------------
// deps.ask = cloud_logic.ask (injected). Returns { markdown, brief, viaCloud, input }.
async function generateBrief({ stories, deltasByStory = {}, windowLabel = 'the last hour', nowIso = '', ask = null, top = 12, model = null, numPredict = 1500 } = {}) {
  const input = briefInput(stories, { deltasByStory, top });
  let brief = null, viaCloud = false;
  if (typeof ask === 'function' && input.length) {
    try {
      // cloud_logic.ask has no `system` param — the grounding rules go in `want`. Pass the caller's FAST
      // model + headroom: the cloud DEFAULT is a reasoning model that hides its answer in `thinking` and
      // returns empty text → the brief would ALWAYS fall back to raw snippets (same fix as research_plan).
      const r = await ask({ task: 'news_brief', v: 1, input, want: `${SYSTEM}\n\n${briefWant()}`, validate: briefValidator, model, numPredict });
      if (r && Array.isArray(r.stories)) { brief = r; viaCloud = true; }
    } catch { /* fall through to fallback */ }
  }
  if (!brief) brief = fallbackBrief(input);
  const markdown = renderBrief(brief, input, { windowLabel, nowIso });
  return { markdown, brief, viaCloud, input };
}

module.exports = { SYSTEM, briefInput, briefWant, briefValidator, fallbackBrief, renderBrief, generateBrief };
