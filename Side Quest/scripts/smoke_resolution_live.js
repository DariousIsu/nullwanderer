/* Smoke: lib/resolution_live — live Echo deps (orchestration only; mock dispatch). Proves the raw-ARRAY
 * parse (the bug that gave earlier probes a false 0%), the {result:[]} envelope fallback, block-key→query
 * translation, kg_neighborhood id extraction (any shape, self excluded), and fail-soft.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_resolution_live.js
 */
'use strict';
const L = require('../lib/resolution_live');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- _parseEntities: both shapes ------------------------------------------------------------------
ok(L._parseEntities('[{"id":1,"name":"A","entity_type":"person"}]')[0].type === 'person', 'parse: raw ARRAY text → {id,name,type} (the suit.dispatch shape)');
ok(L._parseEntities('{"result":[{"id":2,"name":"B"}]}')[0].id === 2, 'parse: {result:[…]} envelope fallback');
ok(L._parseEntities('not json').length === 0, 'parse: bad json → [] (fail-soft)');

(async () => {
  const calls = [];
  const dispatch = async (tag) => {
    calls.push(tag);
    const n = tag.name, q = tag.args && tag.args.query;
    if (n === 'search_entities') {
      if (/howell/i.test(q || '')) return { ok: true, text: '[{"id":9,"name":"Janet D. Howell (VA)","entity_type":"person","degree":900}]' };
      if (q === 'Q6396892') return { ok: true, text: '[{"id":1,"name":"Kevin McCarty [wd:Q6396892]","entity_type":"person"}]' };
      return { ok: true, text: '[]' };
    }
    if (n === 'get_entity') return { ok: true, text: '{"id":42,"name":"Some Entity","relations":[{"target_id":100,"target_name":"X"},{"target_id":101,"target_name":"Y"}]}' };
    return { ok: false, isError: true, text: 'unknown' };
  };
  const deps = L.makeLiveDeps(dispatch);

  ok((await deps.byAnn('Howell'))[0].id === 9 && (await deps.byAnn('Howell'))[0].degree === 900, 'byAnn: hybrid search → shaped candidate with degree');
  ok((await deps.byStrongId('wikidata', 'Q6396892'))[0].id === 1, 'byStrongId: searches the id token → the tagged entity');
  ok((await deps.byNameKey('nothing here')).length === 0, 'byNameKey: no hit → []');

  // block-key → query translation
  calls.length = 0;
  await deps.byBlock('sn:howell|va');
  ok(calls[0].args.query === 'howell va', 'byBlock: "sn:howell|va" → search "howell va"');
  await deps.byBlock('sn:mccarty|g:k');
  ok(calls[1].args.query === 'mccarty k', 'byBlock: "sn:mccarty|g:k" → search "mccarty k"');
  await deps.byBlock('tok:sacramento treasury');
  ok(calls[2].args.query === 'sacramento treasury', 'byBlock: "tok:…" → the raw tokens');

  // neighborsOf: civic relation target_ids from get_entity (the correct id space for the collective guard)
  const nb = await deps.neighborsOf({ id: 42, name: 'Some Entity' });
  ok(nb.includes(100) && nb.includes(101), 'neighborsOf: civic relation target_ids from get_entity');
  ok((await deps.neighborsOf({ id: 1 })).length === 0, 'neighborsOf: no name → [] (get_entity is keyed on name)');

  // fail-soft
  const soft = L.makeLiveDeps(async () => { throw new Error('echo down'); });
  ok((await soft.byAnn('x')).length === 0 && (await soft.neighborsOf({ id: 1 })).length === 0, 'fail-soft: a throwing dispatch → [] everywhere');
  ok((await L.makeLiveDeps(null).byAnn('x')).length === 0, 'fail-soft: no dispatch → [] (never throws)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
