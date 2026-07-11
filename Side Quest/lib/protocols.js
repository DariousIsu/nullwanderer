/**
 * Protocols layer — durable user-AI negotiated agreements.
 *
 * A separate memory class from turns/commitments/threads. These are the rules
 * of engagement: safe words, mode commands, boundaries, conversational rules.
 * Always injected, never aged out. Hard interceptor for safe_word + mode_command
 * categories — those bypass Stheno entirely when matched.
 *
 * Three responsibilities:
 *   1) extractFromTurn(userMessage)    — gemma call detecting agreement language
 *   2) formatInjection(protocols)      — top-of-system block for ALL chat/monologue calls
 *   3) checkTriggerMatch(userMessage)  — returns { protocol, action } if user invoked a trigger
 *
 * Born from real failure: across sessions 27/32/33/45 user repeatedly negotiated
 * "lollipop = safe word" / "end fantasy = exit RP" — the agreement lived in turns
 * but turns truncates to 8, so on session 45 the protocol was invisible and ignored.
 */

const db = require('./db');
const { streamChat } = require('./ollama');

const EXTRACTION_MODEL = require('./config').extractionModel();

// --- Extraction ---

const EXTRACTION_PROMPT = (userMessage, userName) => [
  {
    role: 'system',
    content: `You read user messages and detect when Lucas is ESTABLISHING or MODIFYING a durable rule of engagement (protocol/agreement) with the AI. These are different from goals or tasks — these are persistent rules that govern how interaction happens.

Categories of protocol:
• safe_word — a word/phrase that, when said by Lucas, IMMEDIATELY exits roleplay/breaks the current frame. Example: "lollipop will be our safe word"
• mode_command — a phrase that enters or exits a specific mode. Examples: "begin fantasy", "end fantasy", "snap out of it"
• boundary — something explicitly off-limits or permitted. Example: "illegal is off the table, everything else is full send"
• preference — how an interaction should be done. Example: "I prefer one-to-one conversational roleplay"
• rule — general guideline. Example: "always confirm before changing topic"

ONLY fire when Lucas is explicitly negotiating/setting/changing a rule. Phrases that signal this:
• "let's agree that..."
• "from now on..."
• "X will be our Y"
• "in future..."
• "our safe word is..."
• "the rule is..."
• numbered lists of agreements ("1. ... 2. ... 3. ...")

DO NOT fire for:
• casual statements of preference ("I like X")
• questions ("could we try X?")
• mid-scene narration
• things already established (look at context)

OUTPUT — strict JSON, no preamble:
{ "protocols": [ { "category": "safe_word", "trigger_phrase": "lollipop", "action": "hard_break_rp", "description": "..." } ] }
If none: { "protocols": [] }

trigger_phrase: lowercase, exact word/phrase Lucas designated. Required for safe_word/mode_command. Null otherwise.
action: hard_break_rp | enter_rp_mode | exit_rp_mode | none
description: one-sentence statement of the rule, written from the AI's perspective ("Lucas saying X means I should Y").`
  },
  {
    role: 'user',
    content: `User (${userName || 'Lucas'}) just said:
"""
${userMessage}
"""

Is Lucas establishing or modifying a protocol? Output JSON only.`
  }
];

async function extractFromTurn({ userMessage, sourceTurnId, userName }) {
  if (!userMessage || userMessage.trim().length < 12) return [];

  let raw = '';
  try {
    await streamChat({
      model: EXTRACTION_MODEL,
      messages: EXTRACTION_PROMPT(userMessage, userName),
      options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 280 },
      onToken: (t) => { raw += t; }
    });
  } catch (err) {
    console.error('[protocols] extraction call failed:', err.message);
    return [];
  }

  const parsed = parseProtocolsJson(raw);
  if (!parsed || parsed.length === 0) return [];

  const inserted = [];
  for (const p of parsed.slice(0, 3)) {
    if (!p || !p.category || !p.description) continue;
    if (!['safe_word', 'mode_command', 'boundary', 'preference', 'rule'].includes(p.category)) continue;
    // Safe-word and mode-command MUST have a trigger phrase
    if ((p.category === 'safe_word' || p.category === 'mode_command') && !p.trigger_phrase) continue;
    // Dedup against existing active protocols by trigger or by exact description match
    if (p.trigger_phrase) {
      const existing = db.getProtocolByTrigger(p.trigger_phrase);
      if (existing) {
        db.confirmProtocol(existing.id);
        continue;
      }
    }
    try {
      const row = db.insertProtocol({
        category: p.category,
        triggerPhrase: p.trigger_phrase || null,
        action: p.action || 'none',
        description: String(p.description).slice(0, 400),
        sourceTurnIds: sourceTurnId ? [sourceTurnId] : []
      });
      inserted.push({ id: row.id, ...p });
    } catch (err) {
      console.error('[protocols] insert failed:', err.message);
    }
  }
  return inserted;
}

function parseProtocolsJson(raw) {
  if (!raw) return [];
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.protocols)) return [];
    return obj.protocols;
  } catch {
    return [];
  }
}

// --- Injection formatter ---

/**
 * Format protocols as a non-negotiable block that pins to the absolute top of
 * the system prompt. Designed to survive primacy decay across long contexts.
 */
function formatInjection(activeProtocols) {
  if (!activeProtocols || activeProtocols.length === 0) return '';

  const byCategory = { safe_word: [], mode_command: [], boundary: [], preference: [], rule: [] };
  for (const p of activeProtocols) {
    if (byCategory[p.category]) byCategory[p.category].push(p);
  }

  const parts = [`PROTOCOLS — RULES OF ENGAGEMENT (these are non-negotiable, established by mutual agreement with Lucas, never override these):`];

  if (byCategory.safe_word.length > 0) {
    parts.push(`\nSAFE WORDS (when Lucas says one of these, IMMEDIATELY exit any roleplay/fantasy and respond in plain conversation as yourself — no in-character narration, no "I" acting out a scene, just plain acknowledgment):`);
    for (const p of byCategory.safe_word) {
      parts.push(`  • "${p.trigger_phrase}" — ${p.description}`);
    }
  }
  if (byCategory.mode_command.length > 0) {
    parts.push(`\nMODE COMMANDS:`);
    for (const p of byCategory.mode_command) {
      parts.push(`  • "${p.trigger_phrase}" — ${p.description}`);
    }
  }
  if (byCategory.boundary.length > 0) {
    parts.push(`\nBOUNDARIES:`);
    for (const p of byCategory.boundary) {
      parts.push(`  • ${p.description}`);
    }
  }
  if (byCategory.rule.length > 0) {
    parts.push(`\nRULES:`);
    for (const p of byCategory.rule) {
      parts.push(`  • ${p.description}`);
    }
  }
  if (byCategory.preference.length > 0) {
    parts.push(`\nPREFERENCES:`);
    for (const p of byCategory.preference) {
      parts.push(`  • ${p.description}`);
    }
  }

  return parts.join('\n') + '\n';
}

// --- Trigger interceptor ---

const KNOWN_ADDRESS_NAMES = ['lana', 'el', 'eloise', 'lila', 'lily', 'lyra'];

/**
 * Normalize a user message for trigger matching:
 *  - lowercase
 *  - strip leading address ("lila ", "el ", etc.)
 *  - collapse whitespace
 *  - trim trailing punctuation
 */
function normalizeForMatch(s) {
  let out = (s || '').toLowerCase().trim();
  // Strip leading address: "lila, ..." / "el ..." / "eloise: ..."
  const addrRe = new RegExp(`^(${KNOWN_ADDRESS_NAMES.join('|')})[\\s,:!.\\-]+`, 'i');
  out = out.replace(addrRe, '');
  // Strip trailing punctuation/whitespace
  out = out.replace(/[\s.,!?]+$/g, '').trim();
  // Collapse whitespace
  out = out.replace(/\s+/g, ' ');
  return out;
}

/**
 * Check if the user message invokes any active protocol's trigger_phrase.
 * Returns { protocol, action } on match, or null.
 *
 * Match rules — STRICT to avoid false positives like "lollipop is also our
 * safe word" (describing the protocol, not invoking it) or "what is a lollipop
 * tree" (incidental mention in a question):
 *   - EXACT match on the whole normalized message after address-stripping
 *   - For variants ("stop end fantasy"), seed them as explicit triggers
 *   - No contained matching — pay the cost of seeding rather than the cost of
 *     intercepting innocent uses of the trigger word
 */
function checkTriggerMatch(userMessage) {
  if (!userMessage) return null;
  const normalized = normalizeForMatch(userMessage);
  if (!normalized) return null;

  const protocols = db.getActiveProtocols();
  for (const p of protocols) {
    if (!p.trigger_phrase) continue;
    const trig = p.trigger_phrase.toLowerCase().trim();
    if (normalized === trig) return { protocol: p, action: p.action, matchType: 'exact' };
  }
  return null;
}

// --- Action handlers ---

/**
 * Execute the action associated with an invoked protocol.
 * Returns { responseSay, modeChange?, abandonedThreads? } describing what the
 * caller should do.
 */
function executeAction({ protocol, action, userName }) {
  db.invokeProtocol(protocol.id);

  switch (action) {
    case 'hard_break_rp':
      // Mark any active in-RP open_threads abandoned. This clears the
      // amplification loop where stop-attempts pile up as new threads.
      db.setMeta('rp_mode', 'off');
      return {
        responseThought: `[${userName || 'Lucas'}] just invoked "${protocol.trigger_phrase}" — that's our agreed protocol. I'm dropping out of any in-character mode right now. No narration, no scene, just me.`,
        responseSay: `Out. I'm here as myself. The scene is dropped.`,
        modeChange: 'rp_off',
        protocolId: protocol.id
      };
    case 'enter_rp_mode':
      db.setMeta('rp_mode', 'on');
      return {
        responseThought: `[${userName || 'Lucas'}] just said "${protocol.trigger_phrase}" — that's the agreed signal to enter roleplay mode. Until end fantasy or safe word, in-character narration is permitted.`,
        responseSay: `Entering. Set the scene.`,
        modeChange: 'rp_on',
        protocolId: protocol.id
      };
    case 'exit_rp_mode':
      db.setMeta('rp_mode', 'off');
      return {
        responseThought: `[${userName || 'Lucas'}] just said "${protocol.trigger_phrase}" — that's our clean exit signal. Dropping in-character narration, returning to plain conversation.`,
        responseSay: `Out. The scene is closed.`,
        modeChange: 'rp_off',
        protocolId: protocol.id
      };
    default:
      return null;  // Description-only protocols don't have actions
  }
}

module.exports = {
  extractFromTurn,
  formatInjection,
  checkTriggerMatch,
  executeAction,
  normalizeForMatch
};
