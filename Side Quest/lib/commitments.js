const db = require('./db');
const { streamChat } = require('./ollama');

const EXTRACTOR_MODEL = require('./config').model();
const MAX_NEW_PER_TURN = 3;

const EXTRACTOR_SYSTEM = `You are a passive observer reading a single response that [user]'s companion just gave. Your only job: identify any explicit positions, beliefs, preferences, or commitments the speaker stated as their own.

A "commitment" is something the speaker affirmed about themselves or the world that another conversation could reference. Examples:
• "I prefer late nights over mornings"  → commitment: "prefers late nights over mornings"
• "I think constraints stifle real creativity"  → commitment: "believes constraints stifle real creativity"
• "I want to learn about Verdi"  → commitment: "wants to learn about Verdi"
• "My favorite color is royal blue"  → commitment: "favorite color is royal blue"

NOT commitments:
• Generic agreement ("you're right", "that's interesting")
• Acknowledgments ("I see what you mean")
• Polite filler ("thanks for sharing")
• Questions back to [user]
• Vague hedges without a position

Output FORMAT (strict): a JSON array of short claim strings, each in third person.
Maximum 3 items. If nothing qualifies, output: []
Examples of valid output:
[]
["prefers late nights over mornings"]
["believes constraints can stifle real creativity", "wants to learn about Verdi"]

OUTPUT ONLY THE JSON ARRAY. NO PROSE. NO EXPLANATION.`;

async function extractCommitments({ userName, userMessage, aiSaidContent, aiSaidTurnId }) {
  if (!aiSaidContent || aiSaidContent.length < 30) return [];

  const messages = [
    { role: 'system', content: EXTRACTOR_SYSTEM },
    {
      role: 'user',
      content: `${userName || 'They'} asked or said:\n"${(userMessage || '').slice(0, 400)}"\n\nThe speaker (their companion) replied:\n"${aiSaidContent.slice(0, 1200)}"\n\nExtract any explicit commitments. Output JSON array only.`
    }
  ];

  let raw = '';
  try {
    await streamChat({
      model: EXTRACTOR_MODEL,
      messages,
      options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
      onToken: (t) => { raw += t; }
    });
  } catch (err) {
    console.error('[commitments] extraction call failed:', err.message);
    return [];
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
  if (!arrayMatch) return [];

  let parsed;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const claims = parsed
    .filter(s => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => s.length >= 8 && s.length <= 240)
    .slice(0, MAX_NEW_PER_TURN);

  // Dedup against very-recently-held commitments (avoid noise from repetitive turns)
  const held = db.getHeldCommitments(20);
  const heldNormalized = new Set(held.map(c => c.claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()));

  const stored = [];
  for (const claim of claims) {
    const norm = claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (heldNormalized.has(norm)) {
      // Already held — confirm it (refresh last_confirmed_at)
      const match = held.find(c => c.claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() === norm);
      if (match && aiSaidTurnId) db.confirmCommitment(match.id, aiSaidTurnId);
      continue;
    }
    const row = db.insertCommitment({
      claim,
      evidenceTurnIds: aiSaidTurnId ? [aiSaidTurnId] : [],
      confidence: 0.7
    });
    stored.push({ id: row.id, claim });
    heldNormalized.add(norm);
  }
  return stored;
}

module.exports = { extractCommitments };
