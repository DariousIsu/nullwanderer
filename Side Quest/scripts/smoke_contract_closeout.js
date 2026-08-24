'use strict';
/* smoke_contract_closeout.js — CONTRACT AGENT slice 5 (docs/CONTRACT_AGENT_SPEC_2026-08-22.md §11).
 * The close-out gate: sweep → deterministic render → delivery audit → bank the harvest → graduation
 * → completion surfacing → closed. Real contract_store (temp db) + real renderArtifact + real
 * delivery_audit; the banking organs (registry/land/writeFile/saveWebSource/inquiry) are fakes that
 * record their calls. NOTE the render includes the ask verbatim + slot descriptions, so the audit's
 * topic/subject checks are structurally satisfied — the audit-failure REOPEN path is driven by an
 * injected verdict; the audit's teeth on contract content live in the shared pure module. */
const path = require('path'), os = require('os'), fs = require('fs');

const dbDir = path.join(os.tmpdir(), `sq_closeout_${process.pid}`);
fs.mkdirSync(dbDir, { recursive: true });
process.env.CONTRACTS_DB_PATH = path.join(dbDir, 'contracts.db');
const cs = require('../lib/contract_store');
const co = require('../lib/contract_closeout');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── fixture: a closing contract, 2 filled + 1 flagged, one expired question on the flagged slot ─
function makeContract({ withOpenSlot = false } = {}) {
  const c = cs.openContract({ title: 'LA data-center community benefits — close-out fixture', askVerbatim: 'Fill the teacher bonus, water restoration, and tax cells for the Louisiana projects.', topicTokens: ['louisiana', 'teacher', 'bonus', 'water'] });
  cs.upsertSlot({ contractId: c.contractId, slotId: 'teacher-bonus', description: 'teacher bonus commitments' });
  cs.upsertSlot({ contractId: c.contractId, slotId: 'water-restoration', description: 'water restoration commitments' });
  cs.upsertSlot({ contractId: c.contractId, slotId: 'tax-cell', description: 'tax framing' });
  cs.upsertSlot({ contractId: c.contractId, slotId: 'teacher-bonus', status: 'filled', contentRef: 'inline:$1,000 bonuses announced for Richland teachers', citations: [{ src: 'https://example.com/meta-la', date: '2026-07-01' }] });
  cs.upsertSlot({ contractId: c.contractId, slotId: 'water-restoration', status: 'filled', contentRef: 'inline:200M gallons restoration committed', citations: [{ src: 'https://example.com/meta-la', date: '2026-07-01' }, { src: 'canvas:community_benefits_la', date: 'held' }] });
  if (!withOpenSlot) {
    const q = cs.openQuestion({ contractId: c.contractId, slotId: 'tax-cell', text: 'ITEP or ad valorem framing?', assumption: 'ITEP framing', windowMs: 1 });
    cs.expireDueQuestions(Date.now() + 10);   // → tax-cell flagged with the assumption
    c._qid = q.questionId;
  }
  cs.setStatus(c.contractId, 'closing');
  return c;
}

const fakes = () => {
  const calls = { writes: [], recorded: [], landed: [], saved: [], inquiries: [] };
  return {
    calls,
    registry: {
      resolveOrMint: ({ topic }) => ({ slug: 'contract-fixture', relPath: 'notes/contract-fixture.md', nextVersion: 1, existing: false }),
      record: ({ slug, relPath, title }) => { calls.recorded.push(slug); return { slug, version: 3 }; },
    },
    writeFile: (rel, text) => { calls.writes.push({ rel, len: text.length }); return rel; },
    land: ({ title, body, source, ref }) => { calls.landed.push({ ref, source }); return { id: 42, landed: true }; },
    saveWebSource: async ({ url }) => { calls.saved.push(url); },
    inquiry: { open: (args) => { calls.inquiries.push(args); return { id: 7 }; } },
  };
};

(async () => {
  // ── the happy path ────────────────────────────────────────────────────────────────────────────
  {
    const c = makeContract();
    const f = fakes();
    const r = await co.closeOut(c.contractId, { store: cs, ...f });
    ok(r.closed === true, '⭐ the gate closes a clean closing contract');
    ok(cs.getContract(c.contractId).status === 'closed', 'status lands closed');
    ok(f.calls.writes.length === 1 && f.calls.recorded[0] === 'contract-fixture', 'the canonical artifact is written and registry-recorded');
    ok(f.calls.landed[0] && f.calls.landed[0].ref === `contract-${c.contractId}` && f.calls.landed[0].source === 'contract', 'the findings document lands in the store, ref-keyed on the contract');
    ok(f.calls.saved.length === 1 && f.calls.saved[0] === 'https://example.com/meta-la', 'web citations bank ONCE (deduped); held refs (canvas:) never re-bank');
    ok(f.calls.inquiries.length === 1 && f.calls.inquiries[0].contractId === c.contractId && f.calls.inquiries[0].slotId === 'tax-cell' && f.calls.inquiries[0].assumption === 'ITEP framing', '⭐ the never-answered question GRADUATES into her own inquiry with the contract linkage');
    const mi = cs.unvoiced().find((o) => o.kind === 'milestone' && o.contractId === c.contractId);
    ok(mi && /2 filled, 1 flagged of 3/.test(mi.text) && /tax-cell/.test(mi.text), 'the completion surfacing is measured and names the honest holes');
    ok(/keeping 1 unanswered question/.test(mi.text), 'the surfacing says the question lives on as her own inquiry');
  }

  // ── the render ────────────────────────────────────────────────────────────────────────────────
  {
    const c = makeContract();
    const body = co.renderArtifact(cs.getContract(c.contractId), cs.slots(c.contractId));
    ok(/\$1,000 bonuses announced/.test(body) && !/inline:/.test(body), 'inline content renders stripped of its prefix');
    ok(/Sources: https:\/\/example\.com\/meta-la \(2026-07-01\)/.test(body), 'citations render verbatim');
    ok(/FLAGGED — honest hole/.test(body) && /Flags & exclusions/.test(body) && /ITEP framing/.test(body), 'the flagged slot and its assumption survive INTO the artifact');
    cs.setStatus(c.contractId, 'closed');   // park the fixture (via closing already set) — keep the drain fixtures separate
  }

  // ── slot sweep: an unresolved slot reopens, never closes ──────────────────────────────────────
  {
    const c = makeContract({ withOpenSlot: true });   // tax-cell left open
    const r = await co.closeOut(c.contractId, { store: cs, ...fakes() });
    ok(r.closed === false && r.reason === 'slot-sweep', 'sweep refuses a closing contract with an open slot');
    ok(cs.getContract(c.contractId).status === 'open', 'the contract reopens for the waves');
    ok(cs.readInbox(c.contractId).some((m) => m.kind === 'audit_failure' && /tax-cell/.test(m.text)), 'the next wave sees WHY (audit_failure inbox)');
  }

  // ── audit failure: closing→open with the violations in the inbox ──────────────────────────────
  {
    const c = makeContract();
    const f = fakes();
    const r = await co.closeOut(c.contractId, { store: cs, ...f, audit: () => ({ ok: false, violations: [{ check: 'subject-missing', detail: 'the topic names hyperion — absent' }] }) });
    ok(r.closed === false && r.reason === 'audit' && r.violations[0].check === 'subject-missing', 'a failed audit refuses the close');
    ok(cs.getContract(c.contractId).status === 'open', 'the contract reopens on the audit verdict');
    ok(cs.readInbox(c.contractId).some((m) => m.kind === 'audit_failure' && /subject-missing/.test(m.text)), 'the violations reach the inbox in the audit\'s own words');
    ok(f.calls.writes.length === 0 && f.calls.saved.length === 0, 'NOTHING banks on a failed audit (the done-claim stays unreachable)');
  }

  // ── banking failure: stays closing, retries — never closed, never reopened ────────────────────
  {
    const c = makeContract();
    const f = fakes();
    f.saveWebSource = async () => { throw new Error('Echo engine not connected'); };
    const r = await co.closeOut(c.contractId, { store: cs, ...f });
    ok(r.closed === false && r.reason === 'banking', 'a banking failure refuses the close');
    ok(cs.getContract(c.contractId).status === 'closing', 'the contract STAYS closing for the retry (banking is a gate, not a habit)');
  }

  // ── wiring greps ──────────────────────────────────────────────────────────────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/SLICE 5 \(spec §11\)/.test(src) && /contract_closeout'\)\.closeOut/.test(src), 'wiring: the closing drain rides the contract tick');
    ok(/callTool\('save_source'/.test(src) && /closeoutBlockedPosted/.test(src), 'wiring: web sources bank through Echo save_source; a stuck banking stands down ONCE');
    const inq = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inquiry.js'), 'utf8');
    ok(/contract_id, slot_id, assumption/.test(inq), 'wiring: inquiry.open persists the contract linkage columns');
  }

  try { cs.close(); fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_contract_closeout: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
