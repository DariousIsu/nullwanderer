/* Smoke: lib/approvals — O4 ONE APPROVAL SURFACE (the read-model over the propose-shaped stores).
 * Pure/offline: sections are injected; the Echo list parse runs on fixtures.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_approvals.js
 */
'use strict';
const ap = require('../lib/approvals');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- snapshot with injected sources (the aggregate is pure given its sources) ---
  const snap = await ap.snapshot({ sources: [
    { key: 'puller-revisions', label: 'Puller belief revisions', count: 3, top: 'amazon.com: email_pattern first.last → flast' },
    null,   // a broken store yields null — it must simply drop out
    { key: 'rehearsal-card', label: 'Rehearsal proposal card', count: 1, top: 'systematic method to locate page controls' },
  ] });
  ok(snap.sections.length === 2 && snap.total === 4, `null sources drop out; total sums counts (${snap.total} across ${snap.sections.length})`);

  // --- buildBlock: the one block, grounded + honest about the empty state ---
  const block = ap.buildBlock(snap, 'Lucas');
  ok(/AWAITING LUCAS — 4 item\(s\) across 2 queue\(s\)/.test(block), 'block leads with the total + queue count');
  ok(/Puller belief revisions: 3 pending — top: amazon\.com/.test(block), 'each queue names its count + top item');
  ok(/never invent a queue or a count/.test(block), 'block carries the grounding instruction');
  ok(/nothing is waiting on your sign-off/.test(ap.buildBlock({ sections: [] })), 'empty state is an ANSWER, not silence');
  ok(/nothing is waiting/.test(ap.buildBlock(null)), 'null snapshot never throws');
  const capped = ap.buildBlock(await ap.snapshot({ sources: [{ key: 'x', label: 'Echo dedup', count: ap.CAP, top: 'a ↔ b' }] }));
  ok(new RegExp(`Echo dedup: ${ap.CAP}\\+ pending`).test(capped), `a count at the cap displays as ${ap.CAP}+ (never a false exact)`);

  // --- detector: the questions this surface exists for; near-misses stay quiet ---
  for (const q of ["what's waiting on me?", 'anything I need to approve?', 'does anything need my sign-off',
    'what do I need to sign off on', 'is anything awaiting my approval', "what's pending for me"]) {
    ok(ap.detectApprovalsQuestion(q), `detects: "${q}"`);
  }
  for (const q of ['approve of her plan?', 'what is pending in the queue for the crawler', 'I signed off already', 'review the op-ed draft']) {
    ok(!ap.detectApprovalsQuestion(q), `stays quiet on: "${q}"`);
  }

  // --- parseProposalList: tolerant of Echo's shapes; unparseable → null (say nothing, not wrong) ---
  const arr = ap.parseProposalList('[{"id":9,"name":"Baton Rouge dedup"},{"id":10,"name":"x"}]');
  ok(arr && arr.count === 2 && /Baton Rouge/.test(arr.top), 'bare JSON array parses (count + top name)');
  const wrapped = ap.parseProposalList('{"proposals":[{"source_name":"J. Smith","target_name":"John Smith"}]}');
  ok(wrapped && wrapped.count === 1 && /J\. Smith ↔ John Smith/.test(wrapped.top), 'wrapped {proposals} parses; pair names render');
  const noisy = ap.parseProposalList('Result: 1 rows\n[{"title":"merge A into B"}]\n(done)');
  ok(noisy && /merge A into B/.test(noisy.top), 'JSON embedded in prose still parses');
  ok(ap.parseProposalList('no proposals pending') === null && ap.parseProposalList('') === null && ap.parseProposalList(null) === null,
    'prose/empty/null → null, never a throw and never a fake count');

  // --- TENANT BACKLOG section (inventory §3): visibility, never a timer — the charter's rule ---
  {
    const fs = require('fs'), path = require('path'), os = require('os');
    const Database = require('better-sqlite3');
    const tmp = path.join(os.tmpdir(), `smoke_tenant_${process.pid}.db`);
    const d = new Database(tmp);
    d.exec('CREATE TABLE entity_proposals (id INTEGER PRIMARY KEY, confidence REAL); CREATE TABLE relation_proposals (id INTEGER PRIMARY KEY)');
    d.prepare('INSERT INTO entity_proposals (confidence) VALUES (0.95), (0.85), (0.5)').run();
    d.prepare('INSERT INTO relation_proposals DEFAULT VALUES').run();
    d.close();
    process.env.ZOE_TENANT_DB = tmp;
    const snap = await ap.snapshot({ echoSuit: null });
    const sec = snap.sections.find((s) => s.key === 'tenant-backlog');
    ok(sec && sec.count === 4 && /2 entity proposal\(s\) at\/above the 0.8 floor/.test(sec.top), 'the tenant backlog rides the manifest with honest counts');
    ok(/YOUR explicit call/.test(sec.label), 'the label says the drain is his call — never a timer (the charter)');
    // Freeze cut 6: through the db worker the counts are the same — the three COUNT(*)s over ~146k
    // proposals (~1s each on p256) no longer run on the main thread.
    const dbw = require('../lib/db_worker');
    const snapW = await ap.snapshot({ echoSuit: null, query: dbw.query });
    const secW = snapW.sections.find((s) => s.key === 'tenant-backlog');
    ok(secW && secW.count === 4 && /2 entity proposal\(s\) at\/above the 0.8 floor/.test(secW.top), 'CRITICAL: the tenant counts through the db worker match the inline read exactly');
    await dbw.close(tmp); await new Promise((r) => setTimeout(r, 100));
    process.env.ZOE_TENANT_DB = path.join(os.tmpdir(), 'definitely-missing-tenant.db');
    const snap2 = await ap.snapshot({ echoSuit: null });
    ok(!snap2.sections.some((s) => s.key === 'tenant-backlog'), 'a missing tenant DB drops the section — never a fake zero');
    try { fs.unlinkSync(tmp); } catch {}
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
