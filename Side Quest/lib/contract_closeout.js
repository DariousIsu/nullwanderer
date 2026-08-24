/**
 * lib/contract_closeout.js — THE CLOSE-OUT GATE (contract-agent slice 5, docs/CONTRACT_AGENT_SPEC_2026-08-22.md §11).
 *
 * Ordered, all mandatory: slot sweep → deterministic render → delivery audit → BANK THE HARVEST
 * (registry canonical file + findings doc into the store + web-source records + never-answered
 * question graduation into her own inquiries) → completion surfacing → closed. A failed audit
 * REOPENS the contract (closing→open) with the violations posted to the inbox — the done-claim
 * stays structurally unreachable for a wrong artifact (the pre-announce pattern). A failed
 * banking step leaves the contract in closing for the next tick's retry — banking is a GATE,
 * not a habit (§12): skipped harvest = not closed.
 *
 * The render is DETERMINISTIC — every figure in the artifact is a slot's own cited content;
 * no model authors a number here. Pure + deps-injected: { store, db, registry, land, inquiry,
 * audit, writeFile, saveWebSource, now } — main.js wires the live organs; the smoke drives fakes.
 */
'use strict';

const _cap = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
const _inline = (ref) => { const r = String(ref || ''); return r.startsWith('inline:') ? r.slice(7) : (r ? `(content ref: ${r})` : ''); };
const _URLISH = /^https?:\/\//i;

/** Deterministic artifact render — the contract's slots ARE the document. */
function renderArtifact(c, slots, { nowMs = Date.now() } = {}) {
  const filled = slots.filter((s) => s.status === 'filled');
  const flagged = slots.filter((s) => s.status === 'flagged');
  const lines = [];
  lines.push(`# ${c.title}`);
  lines.push(`_Contract ${c.contractId} · ${filled.length} filled / ${flagged.length} flagged of ${slots.length} slots · closed out ${new Date(nowMs).toISOString().slice(0, 10)}_`);
  lines.push('', `## The ask (verbatim)`, c.askVerbatim, '');
  for (const s of slots) {
    lines.push(`## ${s.slotId} — ${s.description}`);
    if (s.status === 'filled') {
      lines.push(_inline(s.contentRef) || '(no inline content)');
      if (s.citations.length) lines.push(`Sources: ${s.citations.map((x) => `${x.src}${x.date ? ` (${x.date})` : ''}`).join(' · ')}`);
      const labels = s.flags.filter((f) => f && f.text);
      for (const f of labels) lines.push(`_Label [${f.kind}]: ${f.text}_`);
    } else {
      lines.push(`**FLAGGED — honest hole.** ${s.flags.map((f) => `[${f.kind}] ${f.text || ''}`).join(' · ') || 'no source found'}`);
    }
    lines.push('');
  }
  if (flagged.length) {
    lines.push(`## Flags & exclusions`);
    for (const s of flagged) lines.push(`- ${s.slotId}: ${s.flags.map((f) => `[${f.kind}] ${f.text || ''}`).join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * Run the whole gate on one CLOSING contract.
 * Returns { closed, reason?, violations?, artifact?, banked?, graduated? }.
 */
async function closeOut(contractId, deps = {}) {
  const store = deps.store || require('./contract_store');
  const now = deps.now || (() => Date.now());
  const c = store.getContract(contractId);
  if (!c) return { closed: false, reason: 'no such contract' };
  if (c.status !== 'closing') return { closed: false, reason: `status is ${c.status}, not closing` };
  const slots = store.slots(contractId);

  // 1. SLOT SWEEP — closing with an unresolved slot is a wave-loop bug; reopen defensively.
  const unresolved = slots.filter((s) => s.status === 'open' || s.status === 'blocked_on_question');
  if (!slots.length || unresolved.length) {
    store.setStatus(contractId, 'open');
    store.postInbox({ contractId, kind: 'audit_failure', text: `close-out sweep found unresolved slots [${unresolved.map((s) => s.slotId).join(', ') || '(none defined)'}] — fill or flag them before done` });
    return { closed: false, reason: 'slot-sweep', unresolved: unresolved.map((s) => s.slotId) };
  }

  // 2+3. RENDER (deterministic) → DELIVERY AUDIT. Failed audit → closing→open, violations to the
  // inbox — the next wave reworks with the audit's own words; the done-claim stays unreachable.
  const body = renderArtifact(c, slots, { nowMs: now() });
  const audit = deps.audit || require('./delivery_audit').audit;
  const filled = slots.filter((s) => s.status === 'filled');
  const verdict = audit({ topic: `${c.title} ${c.askVerbatim}`, body, dsRows: [], dataShaped: false, doneScope: filled.map((s) => s.description) });
  if (!verdict.ok) {
    const detail = require('./delivery_audit').describe(verdict.violations);
    store.setStatus(contractId, 'open');
    store.postInbox({ contractId, kind: 'audit_failure', text: `the close-out audit REFUSED the artifact: ${_cap(detail, 400)}. Rework what the violations name, then done again.` });
    return { closed: false, reason: 'audit', violations: verdict.violations };
  }

  // 4. BANK THE HARVEST — any failure below leaves the contract in closing; the tick retries.
  const banked = { relPath: null, version: null, docId: null, webSources: 0, webSourceFails: 0 };
  try {
    // 4a. the registry canonical — re-closes update IN PLACE (document identity, never a sibling).
    const registry = deps.registry || require('./artifact_registry');
    const mint = registry.resolveOrMint({ topic: c.title, kind: 'contract' });
    const writeFile = deps.writeFile || ((rel, text) => {
      const path = require('path'), fs = require('fs');
      const abs = path.join(require('./files').resolvePath('notes'), path.basename(rel));
      fs.writeFileSync(abs, text, 'utf8');
      return abs;
    });
    writeFile(mint.relPath, body);
    const rec = registry.record({ slug: mint.slug, relPath: mint.relPath, title: c.title, topic: `${c.title} ${c.askVerbatim}`, now: now() });
    banked.relPath = mint.relPath; banked.version = rec.version;
    // 4b. the findings document into the store (content-deduped; ref keyed on the contract).
    const land = deps.land || require('./doc_store').land;
    const landed = land({ title: c.title, body, source: 'contract', ref: `contract-${contractId}` });
    banked.docId = landed && landed.id;
    // 4c. web-source records — every URL-shaped citation banks to Echo via the wired hook. Held
    // refs (canvas:/notes//doc#) are already owned and never re-banked. Hook absent → nothing to
    // bank counts as banked (the live wiring decides); hook FAILURE → retry next tick.
    if (typeof deps.saveWebSource === 'function') {
      const seen = new Set();
      for (const s of filled) for (const cite of s.citations) {
        const url = String((cite && cite.src) || '');
        if (!_URLISH.test(url) || seen.has(url)) continue;
        seen.add(url);
        try {
          await deps.saveWebSource({ url, title: `${c.title} — ${s.slotId}`, contentMd: `${s.description}\n\n${_inline(s.contentRef)}`, capturedAt: new Date(cite.date && /^\d{4}-\d{2}-\d{2}$/.test(cite.date) ? cite.date : now()).toISOString() });
          banked.webSources++;
        } catch (e) { banked.webSourceFails++; console.error(`[contract-closeout] save_source failed for ${_cap(url, 80)}: ${e.message}`); }
      }
      if (banked.webSourceFails) return { closed: false, reason: 'banking', banked };
    }
  } catch (e) {
    console.error('[contract-closeout] banking failed (stays closing, will retry):', e.message);
    return { closed: false, reason: 'banking', error: e.message, banked };
  }

  // 4d. INQUIRY GRADUATION — a question the operator NEVER answered, whose slot shipped flagged,
  // becomes her own background line (pursue-the-deliverable: the assumption she shipped on is a
  // question she keeps working). answered/answered_late questions are settled; slotless expired
  // questions graduate too. Fail-soft: a graduation error never blocks the close.
  const graduated = [];
  try {
    const inquiry = deps.inquiry || require('./inquiry');
    const flaggedIds = new Set(slots.filter((s) => s.status === 'flagged').map((s) => s.slotId));
    for (const q of store.expiredQuestions(contractId)) {
      if (q.slotId != null && !flaggedIds.has(q.slotId)) continue;
      const r = inquiry.open({
        question: `${q.text} (shipped on the assumption: ${q.assumption})`,
        bornFrom: `contract-${contractId}`, contractId, slotId: q.slotId, assumption: q.assumption,
        deps: deps.inquiryDeps || {}, nowMs: now(),
      });
      if (r && r.id) graduated.push(r.id);
    }
  } catch (e) { console.error('[contract-closeout] inquiry graduation failed (close proceeds):', e.message); }

  // 5. COMPLETION SURFACING — measured, honest, the flags list is part of done. Then closed.
  const flagged = slots.filter((s) => s.status === 'flagged');
  store.postOutbox({
    contractId, kind: 'milestone',
    text: `closed out "${c.title}" — ${flagged.length ? `${filled.length} filled, ${flagged.length} flagged of ${slots.length}` : `all ${slots.length} slots filled and cited`}. Artifact: ${banked.relPath} (v${banked.version}, doc#${banked.docId || '?'})${banked.webSources ? `; ${banked.webSources} web source(s) banked` : ''}${flagged.length ? `. Honest holes: ${flagged.map((s) => `${s.slotId} (${(s.flags[0] && s.flags[0].kind) || 'flagged'})`).join(', ')}` : ''}${graduated.length ? `. I'm keeping ${graduated.length} unanswered question(s) as my own open inquiries` : ''}.`,
  });
  store.setStatus(contractId, 'closed');
  return { closed: true, artifact: banked, graduated };
}

module.exports = { closeOut, renderArtifact };
