/**
 * lib/contract_voice.js — THE SURFACING VOICER (contract-agent slice 2, docs/CONTRACT_AGENT_SPEC_2026-08-22.md §7).
 *
 * The outbox → the unprompted channel: findings, questions, judgment calls, milestones — the load the
 * unprompted channel was always meant for (Lucas, 08-22). All kinds are PRIORITY: voiced at the next
 * boundary (the lull, per every unprompted door's convention), coalesced into ONE say per boundary,
 * never barging into a live exchange, and held silent while Lucas is away — items are durable, they
 * wait. Voice is hers: the cloud replier renders the roadmap, with a deterministic fallback and a
 * NUMBER-INVENTION guard — a rendering may rephrase, but every digit-run in it must already exist in
 * the roadmap (models never author numbers), else the deterministic text ships instead.
 *
 * Pure + deps-injected (store, conversationActive, isAway, complete, deliver) — smoke-tested without
 * a model or a window. main.js owns the tick, the gates' real sources, and the delivery plumbing.
 */
'use strict';

const KIND_LABEL = { finding: 'Found', question: 'Question', judgment_call: 'Judgment call', milestone: 'Milestone', blocked: 'Blocked' };

function pendingBatch(store) {
  const all = store.unvoiced();
  if (!all.length) return null;
  // A question answered or expired BEFORE its boundary is stale — asking it now would read as her
  // not knowing her own state. Stale items retire silently (marked voiced, never said).
  const stale = [], items = [];
  for (const it of all) {
    if (it.kind === 'question' && it.questionId) {
      let st = 'open';
      try { const q = store.getQuestion(it.questionId); st = q ? q.status : 'open'; } catch {}
      if (st !== 'open') { stale.push(it); continue; }
    }
    items.push(it);
  }
  if (!items.length) return { items, stale, groups: [] };
  const byContract = new Map();
  for (const it of items) {
    if (!byContract.has(it.contractId)) {
      let title = it.contractId;
      try { const c = store.getContract(it.contractId); if (c) title = c.title; } catch {}
      byContract.set(it.contractId, { contractId: it.contractId, title, items: [] });
    }
    byContract.get(it.contractId).items.push(it);
  }
  return { items, stale, groups: Array.from(byContract.values()) };
}

function _itemLine(it, store) {
  if (it.kind === 'question') {
    let assumption = '';
    try { const q = it.questionId && store.getQuestion(it.questionId); if (q) assumption = q.assumption; } catch {}
    return `Question: ${it.text}${assumption ? ` (if you don't answer, I'll proceed on: ${assumption})` : ''}`;
  }
  if (it.kind === 'judgment_call') return `Judgment call: ${it.text} — going with that unless you say otherwise.`;
  return `${KIND_LABEL[it.kind] || it.kind}: ${it.text}`;
}

// The deterministic rendering — BOTH the cloud prompt's roadmap and the fallback say.
function roadmap(batch, store) {
  const parts = [];
  for (const g of batch.groups) {
    const head = batch.groups.length > 1 ? `[${g.title}]\n` : `From the "${g.title}" work:\n`;
    parts.push(head + g.items.map((it) => `- ${_itemLine(it, store)}`).join('\n'));
  }
  return parts.join('\n\n');
}

const _digits = (s) => new Set(String(s || '').match(/\d[\d,.]*/g) || []);

async function composeSay({ batch, store, complete }) {
  const map = roadmap(batch, store);
  if (typeof complete === 'function') {
    try {
      const text = String(await complete([
        { role: 'system', content: 'You are Zoe giving Lucas a brief unprompted working update. Rewrite the update roadmap below in your own conversational voice — first person, 2-6 sentences, no headers or bullet lists. Keep EVERY fact, number, and stated assumption EXACTLY as given. NEVER add facts, numbers, or actions the roadmap does not contain. If a question appears, ask it plainly and say what you will assume if unanswered. Reply with ONLY the message text.' },
        { role: 'user', content: map },
      ]) || '').trim();
      if (text && text.length >= 20) {
        const allowed = _digits(map);
        const invented = Array.from(_digits(text)).some((d) => !allowed.has(d));
        if (!invented) return { say: text, rendered: 'cloud' };
      }
    } catch { /* fall through to the deterministic floor */ }
  }
  return { say: map, rendered: 'deterministic' };
}

/** The whole door. Held items stay durable — they voice at the next open boundary. */
async function maybeVoice({ store, conversationActive, isAway, complete, deliver }) {
  const batch = pendingBatch(store);
  if (!batch) return { voiced: 0, reason: 'empty' };
  for (const it of batch.stale || []) store.markVoiced(it.id);   // retire silently, even while held
  if (!batch.items.length) return { voiced: 0, reason: 'all-stale' };
  try { if (typeof isAway === 'function' && isAway()) return { voiced: 0, reason: 'away' }; } catch {}
  try { if (typeof conversationActive === 'function' && conversationActive()) return { voiced: 0, reason: 'mid-exchange' }; } catch {}
  const { say, rendered } = await composeSay({ batch, store, complete });
  const row = deliver(say);
  if (!row) return { voiced: 0, reason: 'deliver-failed' };
  for (const it of batch.items) store.markVoiced(it.id);
  return { voiced: batch.items.length, reason: 'voiced', rendered };
}

module.exports = { pendingBatch, roadmap, composeSay, maybeVoice, KIND_LABEL };
