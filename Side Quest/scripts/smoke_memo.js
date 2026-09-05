/* smoke_memo.js — short-TTL result memo for Echo reads.
 *
 * Unlike coalescing, this one DOES outlive its call, so the load-bearing tests are the ones that
 * bound how wrong a served answer can be: writes are never cached, ERRORS are never cached (or a
 * transient fault hardens into a repeated false negative), entries expire, and a write invalidates
 * the reads that mention what it touched (or she re-reads a stale miss after her own write and
 * proposes the same entity twice).
 */
'use strict';
const m = require('../lib/memo');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }
const hashFn = (a) => (a == null ? null : JSON.stringify(a));
const R = (text) => ({ ok: true, text });

(async () => {
  // ── policy ───────────────────────────────────────────────────────────────────────────────────
  ok(m.isMemoizable('search_entities') && m.isMemoizable('db_query'), 'isMemoizable: reads allowed');
  ok(!m.isMemoizable('propose_entity'), 'SAFETY: propose_entity never memoized');
  ok(!m.isMemoizable('merge_entities'), 'SAFETY: merge_entities never memoized');
  ok(!m.isMemoizable('spawn_agent_async'), 'SAFETY: agent spawning never memoized');
  ok(!m.isMemoizable('totally_unknown_tool'), 'SAFETY: unknown tool defaults to NOT memoized');
  ok(!m.isMemoizable(null), 'isMemoizable: bad input → false');

  ok(m.isInvalidatingWrite('propose_entity') && m.isInvalidatingWrite('merge_entities'), 'writes detected');
  ok(m.isInvalidatingWrite('auto_promote_grounded'), 'promotion counts as a write');
  ok(!m.isInvalidatingWrite('search_entities'), 'a read is not a write');
  // the overlap trap: these START with a write prefix but ARE reads, so they must not invalidate
  ok(!m.isInvalidatingWrite('get_entity') && !m.isInvalidatingWrite('search_facts'), 'reads never classed as writes');
  // THE p300 HOLE (2026-09-05): create_* never counted as a write, so create_project repaired a project's
  // path and the next get_project — memoized 28 s earlier — served the pre-write row for its whole TTL.
  ok(m.isInvalidatingWrite('create_project') && m.isInvalidatingWrite('create_contact') && m.isInvalidatingWrite('create_account'), 'create_* is a write (create_project / create_contact / create_account invalidate)');
  {
    ok(m.isMemoizable('get_project'), 'get_project is a memoized read (the p300 stale answer came from here)');
    const memo = m.createMemo({ hashFn });
    memo.put('get_project', { project_name: 'Proposal' }, R('{"project_name":"Proposal","path":"C:/Users/x/Documents/Claude/Projects/Proposal"}'), 5);
    ok(memo.get('get_project', { project_name: 'Proposal' }), 'the pre-write row is cached');
    const n = memo.invalidate(m.writeArgsOf({ kind: 'do', name: 'create_project', args: { project_name: 'Proposal', project_type: 'research_topic', path: 'Vault/Proposal' } }));
    ok(n === 1 && memo.get('get_project', { project_name: 'Proposal' }) === null, 'create_project {project_name} drops the cached get_project for that project — the next read is fresh');
    ok(memo.get('get_project', { project_name: 'North Dakota' }) === null, 'unrelated projects were never cached here (no cross-talk)');
  }

  // ── fingerprint (drives invalidation) ────────────────────────────────────────────────────────
  {
    const f = m.fingerprint({ name: 'Michael Madigan', top_k: 8 });
    ok(f.has('michael') && f.has('madigan'), 'fingerprint: name tokens extracted');
    ok(f.has('#8'), 'fingerprint: integer args tokenised as ids');
    ok(!m.fingerprint({ sql: 'select * from entities' }).has('select'), 'fingerprint: SQL keywords dropped');
    ok(m.fingerprint({ sql: 'select * from relations where source_id=262716' }).has('#262716'),
      'fingerprint: ids inside SQL are visible to invalidation');
    ok(m.fingerprint(null).size === 0, 'fingerprint: null → empty');

    // the asymmetry: writes fingerprint NARROWLY (identifying keys only) or `entity_type:'person'`
    // would drop every cached read containing the word "person" — global invalidation in disguise
    const w = m.writeFingerprint({ entity_type: 'person', name: 'Jane Roe', summary: 'A state senator from Ohio' });
    ok(w.has('jane') && w.has('roe'), 'writeFingerprint: name tokens kept');
    ok(!w.has('person'), 'SAFETY: entity_type does not drive invalidation');
    ok(!w.has('senator') && !w.has('ohio'), 'SAFETY: summary prose does not drive invalidation');
    ok(m.writeFingerprint({ entity_id: 262716 }).has('#262716'), 'writeFingerprint: *_id keys kept');
    ok(!m.writeFingerprint({ top_k: 8 }).has('#8'), 'writeFingerprint: non-id numbers ignored');
  }

  // ── which field on a tag carries its arguments ───────────────────────────────────────────────
  // Regression: <echo-propose> puts its payload on .payload, not .args. Reading only .args made
  // invalidation a silent no-op for every proposal made through the tag syntax — wired but inert,
  // which reads as "nothing needed dropping" in the stats.
  {
    ok(m.writeArgsOf({ kind: 'do', name: 'propose_entity', args: { name: 'A' } }).name === 'A', 'do tag → .args');
    ok(m.writeArgsOf({ kind: 'propose', proposeKind: 'entity', payload: { name: 'B' } }).name === 'B',
      'SAFETY: propose tag → .payload (not silently empty)');
    ok(Object.keys(m.writeArgsOf({ kind: 'propose', proposeKind: 'entity' })).length === 0, 'no payload → {}');
    ok(Object.keys(m.writeArgsOf(null)).length === 0, 'writeArgsOf(null) → {}, no throw');
    // and end-to-end: a propose TAG must actually drop the matching cached read
    const memo = m.createMemo({ hashFn, ttlMs: 60000 });
    memo.put('search_entities', { q: 'Zzyzx Holloway' }, R('MISS'), 10);
    const tag = { kind: 'propose', proposeKind: 'entity', payload: { entity_type: 'person', name: 'Zzyzx Holloway' } };
    ok(memo.invalidate(m.writeArgsOf(tag)) === 1, 'SAFETY: propose TAG invalidates the stale read');
  }

  // ── core behaviour ───────────────────────────────────────────────────────────────────────────
  {
    let t = 1000;
    const memo = m.createMemo({ hashFn, ttlMs: 5000, now: () => t });
    ok(memo.get('search_entities', { q: 'a' }) === null, 'cold read → miss');
    memo.put('search_entities', { q: 'a' }, R('RESULT'), 900);
    const hit = memo.get('search_entities', { q: 'a' });
    ok(hit && hit.text === 'RESULT', 'warm read → hit');
    ok(memo.get('search_entities', { q: 'DIFFERENT' }) === null, 'different args → miss');
    ok(memo.stats().savedMs === 900, 'saved cost attributed from the original call');

    t += 5001;
    ok(memo.get('search_entities', { q: 'a' }) === null, 'SAFETY: entry expires past TTL');
    ok(memo.stats().expired === 1, 'expiry counted');
  }

  // ── SAFETY: failures are not answers ─────────────────────────────────────────────────────────
  {
    const memo = m.createMemo({ hashFn, ttlMs: 60000 });
    ok(memo.put('search_entities', { q: 'x' }, { ok: false, isError: true, text: 'boom' }, 10) === false,
      'SAFETY: error result refused');
    ok(memo.put('search_entities', { q: 'y' }, { ok: false, text: 'nope' }, 10) === false,
      'SAFETY: ok:false result refused');
    ok(memo.put('search_entities', { q: 'z' }, { ok: true, blocked: true, text: 'tier' }, 10) === false,
      'SAFETY: tier-blocked result refused');
    ok(memo.get('search_entities', { q: 'x' }) === null, 'SAFETY: refused error never served');
    // an EMPTY but successful read is a real answer and SHOULD cache
    ok(memo.put('search_entities', { q: 'e' }, R('{"result":[]}'), 10) === true, 'empty-but-ok result cached');
    ok(memo.put('propose_entity', { name: 'x' }, R('done'), 10) === false, 'SAFETY: write never cached');
  }

  // ── SAFETY: a write drops the reads that mention what it touched ─────────────────────────────
  {
    const memo = m.createMemo({ hashFn, ttlMs: 60000 });
    memo.put('search_entities', { q: 'Jane Roe' }, R('MISS'), 100);
    memo.put('search_entities', { q: 'Some Other Person' }, R('KEEP'), 100);
    memo.put('web_fetch', { url: 'https://example.com/jane' }, R('EXTERNAL'), 100);

    const dropped = memo.invalidate({ name: 'Jane Roe', entity_type: 'person' });
    ok(dropped >= 1, 'write invalidated the overlapping read');
    ok(memo.get('search_entities', { q: 'Jane Roe' }) === null,
      'SAFETY: stale miss for a just-written entity is NOT served');
    const kept = memo.get('search_entities', { q: 'Some Other Person' });
    ok(kept && kept.text === 'KEEP', 'unrelated entry survives (why invalidation is scoped, not global)');
  }

  // ── bounded ──────────────────────────────────────────────────────────────────────────────────
  {
    const memo = m.createMemo({ hashFn, ttlMs: 60000, max: 3 });
    for (let i = 0; i < 6; i++) memo.put('get_entity', { i }, R('v' + i), 1);
    ok(memo.stats().size <= 3, 'cache stays bounded');
    ok(memo.stats().evicted >= 3, 'eviction counted');
    ok(memo.get('get_entity', { i: 5 }) !== null, 'newest entry retained');
  }

  // ── never throws on junk ─────────────────────────────────────────────────────────────────────
  {
    const memo = m.createMemo({ hashFn: () => null });
    ok(memo.get('search_entities', { q: 'a' }) === null, 'null hash → miss, no throw');
    ok(memo.put('search_entities', { q: 'a' }, R('x'), 1) === false, 'null hash → no store, no throw');
    ok(memo.invalidate(null) === 0, 'invalidate(null) → 0, no throw');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
