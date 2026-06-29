/**
 * Personal-fact layer — durable capture of facts ABOUT THE USER (family, names,
 * relationships, biography) from chat, plus the retrieve-or-admit guard for personal
 * questions.
 *
 * Why this exists (diagnostic 2026-06-28): asked "what's my youngest daughter's name?"
 * she fabricated "Kate" AND invented a justification ("Lucas mentioned Kate a moment
 * ago"). The real answer (Alice) had been told a day earlier but only ever lived in raw
 * `turns`, which scroll out of the recency window — there was no durable, retrievable
 * fact, and no guard against guessing. Two responsibilities:
 *   A) extractFromUserTurn — when the user states a durable personal fact, store it as
 *      retrievable knowledge (source 'personal_fact') so it surfaces on a later ask.
 *   B) detectPersonalFactQuestion + groundingDirective — on a "what's my X" question,
 *      inject a directive: answer ONLY from real memory/context, else admit it; never
 *      invent a name/date or claim he "just mentioned" something.
 *
 * Mirrors the existing chat-turn extractors (open_threads.extractFromUserTurn,
 * protocols.extractFromTurn, self_model.detectAffirmedTrait): conservative model JSON
 * call, deps-injectable for offline smokes, fail-safe (never throws into the turn).
 */

const memory = require('./memory');
const { streamChat } = require('./ollama');
const MODEL = require('./config').extractionModel();

// ---------------------------------------------------------------------------
// A) Capture durable personal facts about the user from a chat message.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = (userMessage, userName) => [
  {
    role: 'system',
    content: `You read a message from ${userName || 'the user'} and extract DURABLE PERSONAL FACTS about THEM and their life — the kind a close companion must remember and must never get wrong. Be conservative. The default is { "facts": [] }.

A fact IS (extract these):
• Family / relationships and their NAMES: "my youngest daughter Alice", "my wife Sarah", "my son goes by Jay"
• Stable biography: someone's age, what they do, where they live, a birthday, a pet's name, a job, a hometown
• Examples → "Lucas's youngest daughter is Alice", "Lucas's daughter Alice does elite competitive cheerleading", "Lucas coached sports for years"

A fact is NOT (output empty for ALL of these):
• Plans, to-dos, or anything happening just today ("taking Alice to the gym", "working on your program") — that is transient, not a durable fact
• Questions, opinions, small talk, emotional sharing
• Anything about YOU (the companion) — only facts about ${userName || 'the user'} and the people in their life
• Speculation or anything you'd have to infer — only what is plainly stated

CRITICAL — DO NOT INVENT (this causes real harm):
• A NAME or NICKNAME by itself is NOT a fact. Never invent a pet, child, spouse, or any relationship FROM a name. (e.g., seeing "Zo" does NOT mean there is a dog/person named Zo. "Zo" may simply be how someone is addressed.)
• Use ${userName || 'the user'}'s OWN WORDS. Do NOT add a category, relationship, or attribute they did not literally state. If they didn't say "dog", "daughter", "wife", etc., do not write it.
• Every fact you output must be word-for-word supported by the message. If you can't point to the exact words that state it, it is NOT a fact — output nothing.

PERSPECTIVE: the message is from ${userName || 'the user'}. Resolve first person to them: "I/me/my" = ${userName || 'the user'}. Write every fact in the THIRD PERSON about ${userName || 'the user'}, naming the person it concerns. Combine related details about one person into ONE fact when stated together.

OUTPUT — strict JSON, no preamble:
{ "facts": ["fact one", "fact two"] }
If none (the default for most messages): { "facts": [] }
Each fact: a complete declarative sentence, 4–24 words, no quotes inside.`
  },
  {
    role: 'user',
    content: `${userName || 'They'} just said:\n"""\n${userMessage}\n"""\n\nExtract durable personal facts as JSON.`
  }
];

function parseFactsJson(raw) {
  if (!raw) return [];
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.facts)) return [];
    return obj.facts.filter(f => typeof f === 'string');
  } catch { return []; }
}

// GROUNDING GATE (the deterministic backstop the prompt alone can't guarantee). A fact is kept only
// if its distinctive content words are actually present in the source message — so an INVENTED entity
// ("Lucas has a dog named Zo" from the nickname "Zo": "dog" never appears) is rejected. Precision >>
// recall on purpose: a dropped real fact resurfaces; a poisoned one corrodes the memory that IS Zoe.
const _STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had', 'his', 'her', 'their', 'my', 'your', 'our', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'named', 'goes', 'by', 'does', 'do', 'did', 'they', 'them', 'he', 'she', 'it', 'who', 'that', 'this', 'as', 'from', 'about', 'into']);
const _ANIMAL_RE = /\b(dog|puppy|cat|kitten|pet|hamster|rabbit|bird|parrot|fish|horse|pony|gerbil|ferret|snake|lizard)\b/;
// A fact is grounded unless it INVENTS something not in the message. Two things can't be invented:
// (1) a NAME (catches "daughter Kate" / "dog named Zo" when the name isn't in the text), and (2) a PET
// (catches "a dog named Zo" — the word "dog" never appears). Plus a light anchor check. Legit
// rephrasing/enrichment ("youngest"→"daughter") passes; pure fabrication does not.
function _grounded(fact, message, userName) {
  const msg = ' ' + String(message || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const factStr = String(fact || '');
  const lc = factStr.toLowerCase();
  const uname = String(userName || '').toLowerCase();
  const unameParts = new Set(uname.split(/\s+/).concat([uname, uname + 's', uname + "'s"]));

  // (1) NAMES can't be invented — every proper name in the fact (not the user's) must be in the message.
  const names = (factStr.match(/\b[A-Z][a-z]{2,}\b/g) || []).map(n => n.toLowerCase())
    .filter(n => !unameParts.has(n) && !['she', 'her', 'his', 'they', 'the'].includes(n));
  for (const n of names) if (!msg.includes(n)) return false;

  // (2) A PET/animal can't be invented — if the fact claims one, the message must mention that animal.
  const am = lc.match(_ANIMAL_RE);
  if (am && !msg.includes(am[0])) return false;

  // (3) light anchor — at least one distinctive content word of the fact is present in the message.
  const words = lc.replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !_STOP.has(w) && !unameParts.has(w));
  if (!words.length) return false;
  return words.some(w => { const stem = w.replace(/(es|ed|ing|er|s|'s)$/, ''); return msg.includes(w) || (stem.length > 2 && msg.includes(stem)); });
}

// Run the extraction and store each durable fact as retrievable knowledge. storeFn
// injectable for offline tests (defaults to memory.storeDeduped). Fail-safe → [].
async function extractFromUserTurn({ userMessage, sourceTurnId = null, userName = 'Lucas', storeFn = null, _genFn = null } = {}) {
  if (!userMessage || userMessage.trim().length < 6) return [];
  const store = storeFn || memory.storeDeduped;

  let raw = '';
  try {
    if (_genFn) { raw = await _genFn(userMessage); }
    else {
      await streamChat({
        model: MODEL,
        messages: EXTRACTION_PROMPT(userMessage, userName),
        options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
        onToken: (t) => { raw += t; }
      });
    }
  } catch (err) {
    console.error('[personal_facts] extraction call failed:', err.message);
    return [];
  }

  const facts = parseFactsJson(raw);
  if (!facts.length) return [];

  const stored = [];
  for (const f of facts.slice(0, 5)) {
    const text = (f || '').trim();
    if (text.length < 4 || text.length > 240) continue;
    if (!_grounded(text, userMessage, userName)) { console.warn(`[personal_facts] DROPPED ungrounded fact (confab guard): "${text}"`); continue; }
    try {
      // High importance + a dedicated source so these outrank ambient notes in retrieval
      // and so the curator/guard can recognize them as grounded facts about the user.
      const r = await store({
        kind: 'reference',
        content: text,
        source: 'personal_fact',
        importance: 0.85,
        provenance: sourceTurnId ? `turn:${sourceTurnId}` : null
      });
      stored.push({ content: text, action: r && r.action, id: r && r.id });
    } catch (e) { console.error('[personal_facts] store failed:', e.message); }
  }
  return stored;
}

// ---------------------------------------------------------------------------
// B) Retrieve-or-admit guard for personal questions about the user.
// ---------------------------------------------------------------------------

// Interrogative/recall framing that points at the user's own sphere ("…my…").
const PERSONAL_Q_RE = /\b(what(?:'?s| is| are| was)|who(?:'?s| is| are)|when(?:'?s| is| was)|where(?:'?s| is| does| do)|how old (?:is|are)|do you (?:remember|know|recall))\b[^?]*\bmy\b/i;
// Personal/biographical nouns — keeps the guard off work questions ("what's my next task").
const PERSONAL_NOUN_RE = /\b(daughter|son|child|children|kid|kids|wife|husband|spouse|partner|fianc(?:e|é|ée)?|mother|father|mom|mum|dad|parent|parents|sister|brother|sibling|siblings|family|cousin|aunt|uncle|grand(?:mother|father|ma|pa|parents)|niece|nephew|in-law|pet|dog|cat|name|names|nickname|birthday|anniversary|age|hometown|wedding)\b/i;

function detectPersonalFactQuestion(text) {
  const s = String(text || '');
  return PERSONAL_Q_RE.test(s) && PERSONAL_NOUN_RE.test(s);
}

// The anti-confabulation directive. Correct whether or not she holds the fact: if it's in
// her retrieved memory/context she uses it; if not she admits it. No grounding-detection
// needed (so it can't wrongly suppress a fact she actually has).
function groundingDirective(userName = 'Lucas') {
  return `[${userName} is asking for a specific fact about himself or someone in his life. Answer ONLY from what is actually in your memory and the context above. If the answer is genuinely there, give it directly. If it is NOT there, say plainly that you don't have it and ask him — do NOT invent a name, date, age, or detail, and never claim he "just mentioned" or "told you earlier" something you cannot actually see. Guessing wrong here is far worse than admitting you don't know.]`;
}

module.exports = {
  extractFromUserTurn,
  parseFactsJson,
  detectPersonalFactQuestion,
  groundingDirective,
  EXTRACTION_PROMPT,
  PERSONAL_Q_RE,
  PERSONAL_NOUN_RE,
  _grounded
};
