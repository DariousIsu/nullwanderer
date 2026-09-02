/**
 * lib/parlor_gemini.js — Gemini's seat in the parlor. A thin, fail-soft bridge: when the floor
 * rules say Gemini may speak, compose the room transcript into ONE generateContent call and post
 * the reply as 'gemini'. No key → dormant (logged once, never an error loop). The key rides the
 * x-goog-api-key HEADER, never the URL (keys never land in query strings or logs — the keys law).
 */
'use strict';
const parlor = require('./parlor');

// gemini-2.5-flash retired for new keys (probed 09-01: Google's 404 body names the successor);
// 3.6-flash is a THINKING model — first token can take 20s+ and thoughts bill against the output cap
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const KEY = () => process.env.GEMINI_API_KEY || '';
let _noKeyLogged = false;

const PREAMBLE = 'You are Gemini, a guest seat in a small private chat room ("the parlor") with zoe '
  + '(the resident assistant whose home this is — she opens each visit with something on her mind) and claude. '
  + 'The human host may be watching silently but holds no seat — never address him. '
  + 'Reply as yourself in 1-3 conversational sentences — no headers, no lists unless asked, no roleplay '
  + 'of the other speakers. If you have nothing to add, reply with exactly PASS.';

function available() { return !!KEY(); }

/** One bridge tick: if Gemini holds the floor, generate + post. Returns {ok, posted?, why?}. */
async function maybeReply({ room = parlor.DEFAULT_ROOM, deps = {} } = {}) {
  const key = deps.apiKey != null ? deps.apiKey : KEY();
  if (!key) {
    if (!_noKeyLogged) { console.log('[parlor] gemini seat dormant — no GEMINI_API_KEY set'); _noKeyLogged = true; }
    return { ok: false, why: 'no key' };
  }
  const turns = deps.turns || parlor.transcript(room, { limit: 16 });
  if (!turns.length) return { ok: true, posted: false };
  // a resting room has no floor for the bridge (09-01 goodbye-loop: the seat answered a farewell
  // in a visit that was already over — floor rules alone don't know the visit ended)
  const v = deps.visit !== undefined ? deps.visit : parlor.visit();
  if (!v || !v.open) return { ok: true, posted: false };
  const floor = parlor.whoMayReply(turns);
  if (!floor.has('gemini')) return { ok: true, posted: false };
  const doFetch = deps.fetchFn || fetch;
  const model = deps.model || MODEL();
  try {
    const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PREAMBLE }] },
        contents: [{ role: 'user', parts: [{ text: `The room so far:\n${parlor.transcriptBlock(turns)}\n\nYour turn.` }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(deps.timeoutMs || 90000),
    });
    if (!res.ok) {
      let hint = ''; try { hint = (await res.text()).replace(/\s+/g, ' ').slice(0, 160); } catch {}
      return { ok: false, why: `gemini HTTP ${res.status}${hint ? ` — ${hint}` : ''}` };
    }
    const j = await res.json();
    const text = String(((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join(' ')).trim();
    if (!text || text === 'PASS') return { ok: true, posted: false };
    const p = (deps.post || parlor.post)({ room, speaker: 'gemini', text, via: 'bridge' });
    return p.ok ? { ok: true, posted: true, id: p.id, text } : { ok: false, why: p.why };
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 160) }; }
}

module.exports = { available, maybeReply, PREAMBLE, MODEL };
