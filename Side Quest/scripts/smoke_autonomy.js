/* Smoke: the AUTONOMY decision layer (lib/autonomy — SUBCONSCIOUS_AUTONOMY_DESIGN S1–S4).
 * Deterministic: in-memory DB for the manifest, injected ask for the decision. No model/network.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_autonomy.js
 */
'use strict';
// The stories manifest grab reaches the news bucket — point it at a temp file BEFORE any lib require
// (news_db reads the env at module load) so an offline smoke can never create tables in prod data/.
process.env.NEWS_DB_PATH = require('path').join(require('os').tmpdir(), `zoe-smoke-autonomy-news-${process.pid}.db`);
const auto = require('../lib/autonomy');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const NOW = 1753200000000;   // fixed epoch MS (sq.db convention)

  // --- S1: manifest over a real (in-memory) store ---
  const Database = require('better-sqlite3');
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE absence (subject TEXT, predicate TEXT, kind TEXT, first_observed_ts INTEGER, last_attempt_ts INTEGER, attempts INTEGER DEFAULT 1, ttl_s INTEGER, evidence_kind TEXT, evidence_ref TEXT, PRIMARY KEY(subject,predicate));
    CREATE TABLE cardinality (body TEXT PRIMARY KEY, seats INTEGER, source_kind TEXT, source_ref TEXT, observed_ts INTEGER, conflict_seats INTEGER, conflict_source TEXT, conflict_ts INTEGER);
    CREATE TABLE encounters (id INTEGER PRIMARY KEY, object_type TEXT, object_key TEXT, object_label TEXT, claim_class TEXT, claim_key TEXT, claim_value TEXT, source_kind TEXT, source_ref TEXT, origin TEXT, origin_host TEXT, content_hash TEXT, authority TEXT DEFAULT 'unknown', observed_at INTEGER, ingested_at INTEGER);
    CREATE TABLE interests (id INTEGER PRIMARY KEY, topic TEXT, slug TEXT, weight REAL DEFAULT 1.0, mastery REAL DEFAULT 0.0, lp_ema REAL, visits INTEGER DEFAULT 0, last_visited_ts INTEGER, source TEXT, status TEXT DEFAULT 'active', embedding TEXT, created_ts INTEGER);
    CREATE TABLE open_threads (id INTEGER PRIMARY KEY, content TEXT, status TEXT DEFAULT 'pending', parent_id INTEGER, source_turn_id INTEGER, created_ts INTEGER, last_touched_ts INTEGER, resolved_ts INTEGER, progress_notes TEXT, mention_count INTEGER, action_count INTEGER);
  `);
  mem.prepare('INSERT INTO absence VALUES (?,?,?,?,?,?,NULL,NULL,NULL)').run('Rainey Center', 'board members', 'somevalue', NOW - 86400e3, NOW - 3600e3, 2);
  mem.prepare('INSERT INTO cardinality (body,seats,source_kind,source_ref,observed_ts,conflict_seats) VALUES (?,?,?,?,?,?)').run('Louisiana Parishes', 64, 'gov', 'la.gov', NOW, 62);
  mem.prepare("INSERT INTO encounters (object_key,object_label,claim_class,origin_host,authority,ingested_at) VALUES ('k1','Acme PAC','role','one-site.org','unknown',?)").run(NOW);
  mem.prepare("INSERT INTO encounters (object_key,object_label,claim_class,origin_host,authority,ingested_at) VALUES ('k1','Acme PAC','role','one-site.org','unknown',?)").run(NOW);
  mem.prepare("INSERT INTO interests (topic,weight,mastery,visits,last_visited_ts,created_ts) VALUES ('neuromorphic computing',1.4,0.2,3,?,?)").run(NOW - 2 * 86400e3, NOW);
  mem.prepare("INSERT INTO open_threads (content,status,created_ts,last_touched_ts) VALUES ('map the state AI task forces','active',?,?)").run(NOW - 5 * 86400e3, NOW - 5 * 86400e3);
  // O0 surfaces: an open inquiry + a failed board row (§6 L4 — errors are results).
  mem.exec(`CREATE TABLE inquiries (id INTEGER PRIMARY KEY, question TEXT, born_from TEXT, status TEXT DEFAULT 'active', evidence TEXT, gist TEXT, open_leads TEXT, next_step TEXT, touches INTEGER DEFAULT 0, expect_trail TEXT, created_ts INTEGER, last_touched_ts INTEGER, closed_ts INTEGER, answer TEXT);
    CREATE TABLE workstreams (id INTEGER PRIMARY KEY, lane TEXT, kind TEXT, target TEXT, status TEXT, resource TEXT, note TEXT, started_ts INTEGER, heartbeat_ts INTEGER, finished_ts INTEGER)`);
  mem.prepare("INSERT INTO inquiries (question,status,evidence,open_leads,expect_trail,next_step,touches,created_ts,last_touched_ts) VALUES ('Which states have standing AI task forces?','active','[]','[]','[]','work the NCSL tracker M-W',2,?,?)").run(NOW - 86400e3, NOW - 3600e3);
  mem.prepare("INSERT INTO workstreams (lane,kind,target,status,note,started_ts,heartbeat_ts,finished_ts) VALUES ('autonomy','research','doomed run','failed','operator returned no answer',?,?,?)").run(NOW - 7200e3, NOW - 7200e3, NOW - 7000e3);

  const man = auto.buildManifest({ db: { getDb: () => mem }, now: NOW });
  ok(/Rainey Center — board members/.test(man.text), 'manifest names the absence gap');
  ok(/Louisiana Parishes: 64 vs 62/.test(man.text), 'manifest surfaces the cardinality CONFLICT');
  ok(/Acme PAC \(2 claims, one source\)/.test(man.text), 'manifest finds the single-source encounter cluster');
  ok(/neuromorphic computing \(weight 1.40/.test(man.text), 'manifest carries her interests as idea material');
  ok(/map the state AI task forces.*untouched 5d ago/.test(man.text), 'manifest lists the stalest open thread with age');
  ok(man.counts.absence === 1 && man.counts.encounters === 2, 'counts ride alongside the text');
  ok(/OPEN LINES OF INQUIRY \(advancing one is the DEFAULT move\)/.test(man.text) && /\[inquiry #1\].*standing AI task forces.*next: work the NCSL tracker/.test(man.text),
    'O0: the manifest carries open inquiries with their own next steps');
  ok(/RECENT FAILURES/.test(man.text) && /doomed run.*operator returned no answer/.test(man.text),
    '§6 L4: failed board rows finally have a reader');

  // A missing table drops its section, never the manifest.
  const mem2 = new Database(':memory:');
  mem2.exec('CREATE TABLE interests (id INTEGER PRIMARY KEY, topic TEXT, weight REAL, mastery REAL, visits INTEGER, last_visited_ts INTEGER, status TEXT DEFAULT \'active\')');
  mem2.prepare("INSERT INTO interests (topic,weight,mastery,visits,last_visited_ts) VALUES ('solar microgrids',1.0,0,0,NULL)").run();
  const man2 = auto.buildManifest({ db: { getDb: () => mem2 }, now: NOW });
  ok(/solar microgrids/.test(man2.text) && !/NAMED GAPS/.test(man2.text), 'a missing table drops only its own section');

  // --- S2: decision validation (typed plan; nothing first-class; engage needs say) ---
  const v1 = auto.validateDecision('{"move":"research","target":"neuromorphic computing","why":"least mastered high-weight interest","steps":["search our records","read one primary source"],"expect":"3 substantive learnings"}');
  ok(v1.valid && v1.value.move === 'research' && v1.value.steps.length === 2, 'valid research decision parses');
  ok(auto.validateDecision('{"move":"nothing","why":"every target just ran"}').valid, 'nothing + why is a complete decision');
  ok(!auto.validateDecision('{"move":"research","why":"x"}').valid, 'a work move without a target is invalid');
  ok(!auto.validateDecision('{"move":"engage","why":"x","say":"hi"}').valid, 'engage without a real message is invalid');
  ok(auto.validateDecision('{"move":"engage","why":"found something","say":"I dug into the parish counts and two sources disagree on the total — 62 vs 64. Want me to chase the official list?"}').valid, 'engage with a grounded message is valid');
  ok(!auto.validateDecision('{"move":"conquer","why":"x","target":"y"}').valid, 'an unknown move is rejected');
  ok(auto.validateDecision('The plan: {"move":"clean","target":"encounters dupes","why":"x"} — done').valid, 'JSON is found inside surrounding prose');
  // O0 continuity moves
  ok(auto.validateDecision('{"move":"advance-inquiry","target":"inquiry #12","why":"lead open","expect":"3 more states confirmed"}').valid, 'advance-inquiry with its token validates');
  ok(!auto.validateDecision('{"move":"advance-inquiry","target":"the AI question","why":"x"}').valid, 'advance-inquiry WITHOUT the token is rejected');
  ok(auto.validateDecision('{"move":"open-inquiry","target":"Which counties in Georgia changed election boards since 2024?","why":"born from the encounters gap line"}').valid, 'open-inquiry with a full question validates');
  ok(!auto.validateDecision('{"move":"open-inquiry","target":"counties?","why":"x"}').valid, 'open-inquiry with a stub is rejected');
  ok(auto.validateDecision('{"move":"close-inquiry","target":"inquiry #12","why":"answered","expect":"Nine states; chairs in the trail."}').valid, 'close-inquiry validates');
  ok(/THE DEFAULT IS CONTINUITY/.test(auto.DECISION_WANT) && /ACROSS inquiries, never WITHIN one/.test(auto.DECISION_WANT),
    'the decision prompt states continue-first + the variety inversion');

  // --- decide(): empty manifest never calls the cloud; injected ask round-trips ---
  let askCalls = 0;
  const fakeAsk = async (o) => { askCalls++; return o.validate('{"move":"build","target":"gap report","why":"turn 670 gaps into a document","expect":"a saved markdown file"}').value; };
  ok((await auto.decide({ manifestText: '', deps: { ask: fakeAsk } })) === null && askCalls === 0, 'empty manifest → null, NO cloud call');
  const dec = await auto.decide({ manifestText: man.text, history: [], now: NOW, deps: { ask: fakeAsk } });
  ok(dec && dec.move === 'build' && askCalls === 1, 'decide() returns the typed plan through ask');

  // --- history: rolling, honest ---
  const store = {}; const H = { getMeta: (k) => store[k], setMeta: (k, v) => { store[k] = v; } };
  for (let i = 0; i < 15; i++) auto.historyPush(H, { ts: NOW + i, move: 'research', target: 't' + i, outcome: 'ok' });
  const hist = auto.historyRead(H.getMeta);
  ok(hist.length === auto.HISTORY_MAX && hist[hist.length - 1].target === 't14', 'history rolls at HISTORY_MAX, newest kept');
  ok(/research → t14 → ok/.test(auto.historyBlock(hist, NOW)), 'history block renders move/target/outcome');

  // --- S3: operator briefs per move ---
  const bBuild = auto.buildOperatorBrief({ move: 'build', target: 'State AI task forces — gap report', why: 'w', steps: [], expect: 'e' }, { now: NOW });
  ok(/notes\/autonomy\/\d{4}-\d{2}-\d{2}-state-ai-task-forces-gap-report\.md/.test(bBuild), 'build brief names a dated notes/autonomy/ path');
  ok(/"op":"write"/.test(bBuild), 'build brief instructs the file tool explicitly');
  const bCorr = auto.buildOperatorBrief({ move: 'corroborate', target: 'Acme PAC', why: 'one source', steps: ['find a second source'], expect: 'independent confirmation' });
  ok(/INDEPENDENT second source/.test(bCorr) && /1\. find a second source/.test(bCorr), 'corroborate brief demands independence + carries steps');
  ok(/writes are gated/i.test(auto.buildOperatorBrief({ move: 'clean', target: 'x', why: 'w' })), 'clean brief states the write gate honestly');
  // maintain (conductor 2d): a first-class move whose brief names the curated allowlist
  ok(auto.MOVES.includes('maintain') && auto.validateDecision('{"move":"maintain","target":"integrity audit — civic graph","why":"loop is stale"}').valid, 'maintain is a first-class, validatable move');
  const bMaint = auto.buildOperatorBrief({ move: 'maintain', target: 'integrity audit — civic graph', why: 'stale', steps: [], expect: 'a violation report with counts' });
  ok(/AUTONOMOUS MAINTENANCE/.test(bMaint) && /run_integrity_audit/.test(bMaint) && /run_blocking_dedup/.test(bMaint), 'maintain brief names the allowlisted loops');
  ok(/report-only or proposal-only/i.test(bMaint) && /worth Lucas applying/i.test(bMaint), 'maintain brief states the unattended contract + the report product');

  // --- outcome: record what HAPPENED ---
  const opRes = { answer: 'Saved the report.', steps: [
    { tool: 'localdb', args: { sql: 'SELECT 1' }, result: 'rows' },
    { tool: 'file', args: { op: 'write', path: 'notes/autonomy/x.md' }, result: 'ok' },
    { tool: 'file', args: { op: 'write', path: 'notes/autonomy/broken.md' }, result: 'ERROR: disk' },
  ] };
  const sum = auto.summarizeOutcome({ move: 'build', target: 'gap report' }, opRes, { now: NOW });
  ok(sum.ok && sum.artifacts.length === 1 && sum.artifacts[0] === 'notes/autonomy/x.md', 'artifact detection counts only SUCCESSFUL file writes');
  ok(/chose=build/.test(sum.report) && /artifacts=1/.test(sum.report), 'tick report line carries move + artifact count');
  const sumNull = auto.summarizeOutcome({ move: 'research', target: 't' }, null, { now: NOW });
  ok(/no-run/.test(sumNull.entry.outcome) && !sumNull.ok, 'a run that never happened is recorded as no-run, not success');

  // --- S3 expect-vs-actual: the verdict rides the record ---
  ok(auto._validateExpectVerdict('{"met": false, "why": "found 9 of 64"}').valid, 'expect verdict validates');
  ok(!auto._validateExpectVerdict('{"why": "no met field"}').valid, 'a verdict without met:boolean is invalid');
  const vNo = await auto.verifyExpect({ decision: { expect: 'all 64 parishes listed' }, opRes: { answer: 'Found 9 parishes.', steps: [] }, deps: { ask: async (o) => o.validate('{"met": false, "why": "9 of 64"}').value } });
  ok(vNo && vNo.met === false, 'verifyExpect returns the judged verdict');
  ok((await auto.verifyExpect({ decision: { expect: '' }, opRes: { answer: 'x' }, deps: { ask: async () => { throw new Error('must not be called'); } } })) === null, 'no expect → no verify call');
  const sumV = auto.summarizeOutcome({ move: 'fill-gap', target: 'parishes' }, opRes, { now: NOW, verify: { met: false, why: '9 of 64' } });
  ok(/expect NOT met — 9 of 64/.test(sumV.entry.outcome) && sumV.entry.expectMet === false, 'an unmet expectation is written into history where the next decision reads it');
  ok(/expect=NOT-met/.test(sumV.report), 'the tick report line carries the verdict');

  // --- delegation return path: inbox parsing + dedupe ---
  const inboxText = 'Inbox: [{"title":"LAMP roster brief","summary":"42 members compiled","agent_name":"opposition_researcher","deliverable_kind":"briefing","created_at":"2026-07-22T19:00:00Z"},{"title":"","summary":""}]';
  const items = auto.parseAgentInbox(inboxText);
  ok(items.length === 1 && items[0].agent === 'opposition_researcher' && items[0].kind === 'briefing', 'inbox JSON parses inside surrounding prose, empty rows dropped');
  ok(auto.parseAgentInbox('no json at all').length === 0, 'garbage inbox text → empty, never a throw');
  ok(auto.inboxSeenKey(items[0]) === 'LAMP roster brief::2026-07-22T19:00:00Z', 'seen-key is stable title+created_at');

  // --- the manifest surfaces returned work ---
  const memDb3 = { getDb: () => mem2, getMeta: (k) => (k === 'autonomy.inbox_recent' ? JSON.stringify(items) : null) };
  const man3 = auto.buildManifest({ db: memDb3, now: NOW });
  ok(/FINISHED DELEGATED WORK/.test(man3.text) && /LAMP roster brief/.test(man3.text), 'returned delegated work rides the tick manifest');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
