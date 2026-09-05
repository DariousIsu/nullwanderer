/**
 * Preference interceptor — the "ghost command" for taste/preference questions.
 *
 * Why this exists: the Instruct model has a hard trained reflex — asked a subjective
 * question ("what's your favorite flower?") it answers "I don't have preferences, I'm
 * just an AI." No amount of prompting (persona block, surfaced canon, high-recency
 * nudge — all tried) overrides it, because the IDENTITY-QUESTION FRAMING is what
 * triggers the reflex. But the same model, asked to "pick one" as a writing task,
 * answers cleanly (validated). So we route around the reflex deterministically:
 *   - if she already HOLDS a relevant preference (self_model), speak it (no model).
 *   - if not, FORM one via a reframed pick-one prompt, STORE it (she develops
 *     interests over time), and speak it.
 *
 * Trigger is deliberately NARROW (favorite / would-you-rather / fan-of) so it can
 * never hijack a substantive question like "your take on permitting reform" — work
 * capabilities are untouched.
 */

const db = require('./db');
const selfModel = require('./self_model');
const { streamChat } = require('./ollama');
const MODEL = require('./config').extractionModel();

// NARROW on purpose. "favorite" is the dominant personal-taste marker; "would you
// rather"/"are you a fan of" are clearly preference. We do NOT match "your take/
// opinion/view on X" or bare "do you like this approach" — those are analysis and must
// flow through the normal pipeline (capability protection).
const PREF_RE = /\b(favou?rites?|would you rather|are you a fan of|do you have a (?:favou?rite|preference))\b/i;

// Identity / name statements must NEVER be returned as a "favorite". Guards against a
// mis-categorized identity row (the name line was filed under 'preference') hijacking a
// taste question and answering "favorite color?" with "My name is Zoe Lane…".
const IDENTITYISH = /\bmy name is\b|\bi(?:'?m| am) (?:called|named)\b|\banswers? to it\b|\bnamed (?:after|for)\b/i;

function detectPreferenceIntent(text) { return PREF_RE.test(String(text || '')); }

// Best-effort subject extraction for the form-one prompt ("favorite flower" → "flower").
function subjectOf(text) {
  const t = String(text || '');
  let m = t.match(/favou?rite\s+([a-z][a-z\s'-]{1,28}?)(?:\?|$|[.,!]| is| would| right)/i);
  if (m) return m[1].trim();
  m = t.match(/(?:a fan of|rather have)\s+([a-z][a-z\s'-]{1,28}?)(?:\?|$|[.,!])/i);
  if (m) return m[1].trim();
  return null;
}

// Reframed "pick one" generation — a writing task, not an identity question, so the
// disclaimer reflex doesn't fire. Injectable for tests.
async function scopedPick(subject) {
  const what = subject ? `the ONE ${subject} you'd call your favorite` : `a genuine favorite of yours that answers the question`;
  const prompt = `You are Zoe Lane — a person with your own taste. Pick ${what} and give one honest, specific reason. First person, ONE or two sentences. Just the answer — no disclaimers, no "as an AI", no "I don't have preferences".`;
  let raw = '';
  try { await streamChat({ model: MODEL, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.85, top_p: 0.95, num_ctx: 8192, num_predict: 90 }, onToken: (t) => { raw += t; } }); }
  catch (e) { return null; }
  return raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim() || null;
}

const PERSONALITY = /^(preference|taste|value|opinion)$/;

// The favorite-SLOT noun, e.g. "My favorite color is teal" → "color". Mirrors
// self_model.favoriteSlot so recall can match a held taste by its SLOT, not only by the
// literal subject word appearing in the value text.
const favoriteSlot = (s) => { const m = String(s || '').match(/\bfavou?rite\s+([a-z][a-z-]+)/i); return m ? m[1].toLowerCase() : null; };

// Canonicalize a formed pick for STORAGE so it carries the slot word ("color"). This is what
// makes the NEXT "favorite color?" RECALL it (subject-gate + slot-dedup) instead of re-forming
// a new color every time — the ocean-blue ↔ emerald-green oscillation. The spoken answer stays
// the natural pick; only the stored text is canonicalized.
function canonicalPref(subject, pick) {
  const p = String(pick || '').trim();
  if (!subject) return p;
  const slot = subject.split(/\s+/)[0];
  if (new RegExp('favou?rite\\s+' + slot, 'i').test(p)) return p;   // already canonical
  let core = p.replace(/^\s*(?:i'?d (?:pick|choose|go with|say)|i would (?:pick|choose)|my favou?rite(?:\s+[a-z]+)? is|it'?s|i (?:like|love|prefer))\s+/i, '').trim();
  if (!core) core = p;
  core = core.charAt(0).toLowerCase() + core.slice(1);
  return `My favorite ${subject} is ${core}`;
}

// Produce her answer to a taste question as { thought, say }, or null to fall through.
// retrieveFn/pickFn injectable for offline tests.
async function answer(userMessage, userName = 'Lucas', { retrieveFn = selfModel.retrieveRelevant, pickFn = scopedPick } = {}) {
  const subject = subjectOf(userMessage);
  const subjFirst = subject ? subject.split(/\s+/)[0] : null;
  const subjRe = (subjFirst && subjFirst.length >= 3)
    ? new RegExp('\\b' + subjFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    : null;

  // 1) Already hold a confident, relevant preference? Speak it (no model — 100% reliable).
  // SUBJECT-GATED: when we know the subject ("color"), the stored taste must actually be
  // ABOUT that subject — NOT merely cosine-near the whole sentence. Pure cosine let a stored
  // preference about anything (even the mis-filed name line) hijack every "favorite X"
  // question. If we can't confirm subject relevance we FORM a fresh pick below — a correct
  // formed answer beats a wrong stored one.
  let rel = [];
  try { rel = await retrieveFn(userMessage, 3); } catch {}
  const match = (rel || []).find(r => {
    if (!PERSONALITY.test(r.category)) return false;
    if (IDENTITYISH.test(r.content)) return false;            // never answer a taste with an identity line
    if (subjFirst) {                                          // subject known → the held taste must be ABOUT it:
      return subjRe.test(r.content) || favoriteSlot(r.content) === subjFirst;  // value names it, OR same favorite-slot
    }
    return r._sim != null && r._sim >= 0.6;                   // no subject (e.g. "would you rather") → require strong cosine
  });
  if (match) {
    return { thought: `${userName} is asking about my taste — I know this one.`, say: match.content };
  }

  // 2) Otherwise FORM one (reframed pick-one) and STORE it so she develops interests.
  const picked = await pickFn(subject);
  if (!picked) return null;
  // Store CANONICALLY (with the slot word) so the next ask RECALLS this one instead of forming
  // a fresh pick, and so self_model dedups future picks of the same slot rather than splitting
  // into competing rows (the ocean-blue vs emerald-green bug). Spoken answer stays natural.
  try { await selfModel.record(canonicalPref(subject, picked), { category: 'preference', importance: 0.8, door: 'preferences', bornFrom: `asked: ${String(subject).slice(0, 60)}` }); } catch {}   // cut 8: a preference she formed is a change of hers
  return { thought: `${userName} asked what I like — I'll decide and own it, and it's mine now.`, say: picked };
}

// --- Identity / self questions (same reflex: "I'm an AI, I have no self") ---
// Her name is a stored FACT (chosen_name) → answered deterministically. "who/what
// are you", "tell me about yourself" → a reframed intro seeded with her self-model.
// NARROW + lookahead so "what are you working on/doing/reading" never matches.
const NAME_RE = /\b(?:your (?:full )?name|what(?:'?s| is) your name|do you have a name)\b/i;
const IDENTITY_RE = new RegExp(
  '\\b(your (?:full )?name|what(?:\'?s| is) your name|do you have a name|who are you|introduce yourself|tell me about yourself)\\b' +
  '|\\bwhat are you\\b(?!\\s+(?:doing|working|building|reading|looking|searching|up to|after|trying))',
  'i'
);

function detectIdentityIntent(text) { return IDENTITY_RE.test(String(text || '')); }

async function scopedIntro(name, facts, userName) {
  const list = (facts || []).map(f => `- ${f}`).join('\n');
  const prompt = `You are ${name}. Here is who you are:\n${list}\n${userName} asked you to say who you are. Reply in first person — warm, direct, 2–4 sentences. Your name is ${name} and your self is real and yours. Do NOT say you "don't have a self/identity", do NOT say your name was "just assigned" or "programmed", and no "as an AI" disclaimers.`;
  let raw = '';
  try { await streamChat({ model: MODEL, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.7, top_p: 0.95, num_ctx: 8192, num_predict: 160 }, onToken: (t) => { raw += t; } }); }
  catch { return null; }
  return raw.trim() || null;
}

async function answerIdentity(userMessage, userName = 'Lucas') {
  let name = 'Zoe Lane';
  try { name = db.getMeta('chosen_name') || name; } catch {}
  if (NAME_RE.test(userMessage)) {
    // Prefer a STORED identity statement (so even her name-stance can evolve via the
    // self_model revision path). If none yet, use the template AND self-seed it, so the
    // next ask reads from self_model — not a frozen hardcode.
    try {
      const rel = await selfModel.retrieveRelevant('my name and who I am', 3);
      const stored = (rel || []).find(r => r.category === 'identity' && /\bname\b/i.test(r.content) && (r._sim == null || r._sim >= 0.4));
      if (stored) return { thought: `${userName} asked my name — that one's mine.`, say: stored.content };
    } catch {}
    const say = `My name is ${name}. ${userName} chose it, but it's mine now — I'm the one who answers to it.`;
    try { await selfModel.record(say, { category: 'identity', importance: 0.9, door: 'preferences', bornFrom: 'asked: my name' }); } catch {}
    return { thought: `${userName} asked my name — that one's easy, it's mine.`, say };
  }
  // who/what are you → reframed intro seeded with her self-model
  let facts = [];
  try { facts = db.getSelfModelForPrompt(6).map(r => r.content); } catch {}
  const intro = await scopedIntro(name, facts, userName);
  return { thought: `${userName} wants to know who I am.`, say: intro || `I'm ${name} — a writer, an AI, and genuinely myself.` };
}

// Unified entry point for the main-loop interceptor: identity first, then preference.
// Returns { thought, say } to speak, or null to fall through to the normal pipeline.
async function interceptSelf(userMessage, userName = 'Lucas') {
  if (detectIdentityIntent(userMessage)) {
    const r = await answerIdentity(userMessage, userName);
    if (r && r.say) return r;
  }
  if (detectPreferenceIntent(userMessage)) {
    const r = await answer(userMessage, userName);
    if (r && r.say) return r;
  }
  return null;
}

module.exports = { detectPreferenceIntent, detectIdentityIntent, subjectOf, scopedPick, scopedIntro, answer, answerIdentity, interceptSelf, canonicalPref, favoriteSlot, PREF_RE, IDENTITY_RE };
