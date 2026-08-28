/* Smoke: THE SELF-DIAGNOSTIC CURE WAVE (census 2026-08-27, docs/SELF_DIAGNOSTIC_CENSUS_2026-08-27.md).
 * Seven wires, EXECUTED — never source-grepped (the C2 lesson: the old triage smoke grepped main.js
 * text for status literals while the live CHECK rejected them and the escalation door never fired).
 *   C2: the capability_needs CHECK rebuild (old-DDL db → rebuilt, rows preserved, both new statuses
 *       PERSIST via a real setStatus; an illegal status still refuses, loudly).
 *   C1: self_watch's born_from carries the SIGNATURE — two distinct recurring failures mint TWO
 *       rows; the watch cap still bounds; a similarity fold bumps the recurrence clock.
 *   C6: recurrence survives a reboot (persist → reset → load → the 3rd hit mints).
 *   W7: quiet-retire — a repair need silent 14d retires (the correction-feedback wire); repair rows
 *       are exempt from the 7d park.
 *   W6b: quota closure streaks stamp on the deny transition, clear on reopen.
 *   Wiring pins for the main.js/status doors (repair lane, proposed surface, durable audit results).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_diag_cures.js
 */
const path = require('path'), os = require('os'), fs = require('fs');
const DBP = path.join(os.tmpdir(), `sq_smoke_diag_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = DBP;
const ROOT = 'C:/Users/azrae/Desktop/Side Quest';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713', m); } else { fail++; console.log('  \u2717', m); } };

(async () => {
  try {
    // ── C2: pre-create the OLD schema (the live DB's shape before the cure), then init() ───────
    {
      const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
      const raw = new Database(DBP);
      raw.exec(`CREATE TABLE capability_needs (
        id INTEGER PRIMARY KEY, need TEXT NOT NULL, born_from TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','rehearsing','proposed','parked','retired')),
        created_ts INTEGER NOT NULL, updated_ts INTEGER)`);
      raw.prepare("INSERT INTO capability_needs (id, need, born_from, status, created_ts) VALUES (99, 'old row', 'self-watch: recurred 3x/24h', 'open', 1)").run();
      raw.prepare("INSERT INTO capability_needs (id, need, born_from, status, created_ts) VALUES (100, 'parked row', 'thread-1', 'parked', 2)").run();
      raw.close();
    }
    const db = require(`${ROOT}/lib/db`);
    db.init();
    const ddl = db.getDb().prepare("SELECT sql FROM sqlite_master WHERE name='capability_needs'").get().sql;
    ok(/blocked_external/.test(ddl) && /routed_research/.test(ddl), 'C2: the old-CHECK table was REBUILT in place (new statuses in the live DDL)');
    ok(/diagnosis/.test(ddl), 'C2: the diagnosis column rode the rebuild');
    const kept = db.getDb().prepare('SELECT id, status FROM capability_needs ORDER BY id').all();
    ok(kept.length === 2 && kept[0].id === 99 && kept[1].status === 'parked', 'C2: rows and ids survived the rebuild');

    const CN = require(`${ROOT}/lib/capability_need`);
    ok(CN.setStatus(99, 'blocked_external') === true && db.getDb().prepare('SELECT status FROM capability_needs WHERE id=99').get().status === 'blocked_external',
      'C2: setStatus(blocked_external) PERSISTS — the never-fired escalation door can now match');
    ok(CN.setStatus(99, 'routed_research') === true, 'C2: setStatus(routed_research) persists');
    ok(CN.setStatus(99, 'totally_bogus') === false, 'C2: an illegal status still refuses (and now logs, never a silent swallow)');
    CN.setStatus(99, 'open');
    ok(CN.setDiagnosis(99, 'Root cause: x at lib/foo.js:12') === true && /lib\/foo\.js:12/.test(db.getDb().prepare('SELECT diagnosis FROM capability_needs WHERE id=99').get().diagnosis),
      'C2/W4: a diagnosis stores ON the need row (survives rehearsal-run replacement)');

    // ── C1: per-signature born_from — distinct failures mint DISTINCT rows ─────────────────────
    const SW = require(`${ROOT}/lib/self_watch`);
    SW._reset();
    const T = Date.now();
    // need #99 is open with the OLD constant born_from — a new distinct failure must NOT fold into it
    for (let i = 0; i < 3; i++) SW.observe('[echo] FAILED: transport wedged on socket 7', 'error', { nowMs: T + i * 1000 });
    const afterA = db.getDb().prepare("SELECT id, born_from FROM capability_needs WHERE born_from LIKE 'self-watch:%' AND id != 99 ORDER BY id DESC").all();
    ok(afterA.length === 1 && /transport wedged/.test(afterA[0].born_from), 'C1: a recurring failure mints with THE SIGNATURE as born_from (no fold into the old constant row)');
    CN.setStatus(99, 'parked');   // the polluted constant-born_from row leaves the cap pool (as it will live)
    for (let i = 0; i < 3; i++) SW.observe('[window] context overrun in lane 4', 'error', { nowMs: T + 5000 + i * 1000 });
    const afterB = db.getDb().prepare("SELECT id FROM capability_needs WHERE born_from LIKE 'self-watch:%' AND id != 99").all();
    ok(afterB.length === 2, 'C1: a SECOND distinct failure mints a SECOND row — the silent fold is dead');
    for (let i = 0; i < 3; i++) SW.observe('[echo] FAILED: a third distinct thing 9', 'error', { nowMs: T + 9000 + i * 1000 });
    const afterC = db.getDb().prepare("SELECT COUNT(*) n FROM capability_needs WHERE born_from LIKE 'self-watch:%' AND status IN ('open','rehearsing') AND id != 99").get().n;
    ok(afterC === 2, `C1: MAX_OPEN_WATCH_NEEDS still bounds the mint door (${afterC} open watch needs)`);

    // similarity fold bumps the recurrence clock (the curator's dormancy input)
    const r1 = CN.record('I need a tool that can parse the ZORPLE binary ledger format', { bornFrom: 'run-A', nowMs: T });
    const r2 = CN.record('I need a tool that can parse ZORPLE binary ledger files', { bornFrom: 'run-B', nowMs: T + 60000 });
    const zr = db.getDb().prepare('SELECT updated_ts FROM capability_needs WHERE id=?').get(r1.id);
    ok(r2.deduped && r2.id === r1.id && zr.updated_ts === T + 60000, 'C1b: a similarity fold BUMPS updated_ts (recurrence keeps the need alive)');

    // ── C6: recurrence survives a reboot ───────────────────────────────────────────────────────
    SW._reset();
    SW.observe('[echo] FAILED: reboot-crossing failure 1', 'error', { nowMs: T + 20000 });
    SW.observe('[echo] FAILED: reboot-crossing failure 2', 'error', { nowMs: T + 21000 });
    SW._persistSigs({ nowMs: T + 22000 });
    SW._reset();                                              // the reboot
    ok(SW._loadSigs({ nowMs: T + 23000 }) >= 1, 'C6: signatures reload from meta after a reset');
    const beforeMint = db.getDb().prepare("SELECT COUNT(*) n FROM capability_needs WHERE born_from LIKE '%reboot-crossing%'").get().n;
    SW.observe('[echo] FAILED: reboot-crossing failure 3', 'error', { nowMs: T + 24000 });
    const afterMint = db.getDb().prepare("SELECT COUNT(*) n FROM capability_needs WHERE born_from LIKE '%reboot-crossing%'").get().n;
    ok(beforeMint === 0 && afterMint === 0, 'C6: (cap held it back — watch cap 2 still bounds across the reload)');
    // free the slots, then the reloaded 2-of-3 must mint on hit 3 — the exact suppression C6 cures
    // (the 4th line keeps the SAME digit-blanked signature: "failure N")
    db.getDb().prepare("UPDATE capability_needs SET status='parked' WHERE born_from LIKE 'self-watch:%'").run();
    SW._reset(); SW._loadSigs({ nowMs: T + 25000 });
    SW.observe('[echo] FAILED: reboot-crossing failure 4', 'error', { nowMs: T + 25000 });
    const minted = db.getDb().prepare("SELECT COUNT(*) n FROM capability_needs WHERE born_from LIKE '%reboot-crossing%' AND status='open'").get().n;
    ok(minted === 1, 'C6: 2 hits before the "reboot" + 1 after = the mint fires (recurrence survived)');

    // ── W7: quiet-retire + the 7d-park exemption ───────────────────────────────────────────────
    const CU = require(`${ROOT}/lib/curator`);
    const now = Date.now();
    db.getDb().prepare("INSERT INTO capability_needs (need, born_from, status, created_ts, updated_ts) VALUES ('quiet repair', 'self-watch: [x] FAILED N', 'open', ?, ?)").run(now - 20 * 86400e3, now - 15 * 86400e3);
    const quietId = db.getDb().prepare('SELECT last_insert_rowid() id').get().id;
    db.getDb().prepare("INSERT INTO capability_needs (need, born_from, status, created_ts, updated_ts) VALUES ('quiet proposed repair', 'self-audit: dead-export', 'proposed', ?, ?)").run(now - 20 * 86400e3, now - 15 * 86400e3);
    const quietPropId = db.getDb().prepare('SELECT last_insert_rowid() id').get().id;
    db.getDb().prepare("INSERT INTO capability_needs (need, born_from, status, created_ts, updated_ts) VALUES ('fresh repair', 'self-watch: [y] FAILED N', 'open', ?, ?)").run(now - 8 * 86400e3, now - 8 * 86400e3);
    const freshRepairId = db.getDb().prepare('SELECT last_insert_rowid() id').get().id;
    const retired = CU.retireQuietRepairs({ now });
    ok(retired >= 2 && db.getDb().prepare('SELECT status FROM capability_needs WHERE id=?').get(quietId).status === 'retired',
      'W7: a repair need quiet 15d RETIRES — the ledger learns the defect was cured');
    ok(db.getDb().prepare('SELECT status FROM capability_needs WHERE id=?').get(quietPropId).status === 'retired',
      'W7: a quiet PROPOSED repair retires too (a landed fix leaves the proposal moot)');
    CU.curateNeeds({});
    ok(db.getDb().prepare('SELECT status FROM capability_needs WHERE id=?').get(freshRepairId).status === 'open',
      'W7: an 8d-old repair need is EXEMPT from the 7d park (the diagnosis lane owns it)');

    // ── W6b: quota closure streaks ─────────────────────────────────────────────────────────────
    const QG = require(`${ROOT}/lib/quota_gate`);
    QG._noteClosure('idle', false, now);
    ok(QG.closedSince('idle') === now, 'W6b: the first deny stamps closed-since');
    QG._noteClosure('idle', false, now + 60000);
    ok(QG.closedSince('idle') === now, 'W6b: a repeat deny never re-stamps (the streak start holds)');
    QG._noteClosure('idle', true, now + 120000);
    ok(QG.closedSince('idle') === null, 'W6b: the first allow clears the streak (reopen logged)');

    // ── round-1 C/D/H cure: self-state questions ROUTE TO THE MEASURED SELF-READ ───────────────
    // The live failures verbatim + the KIND's variants (retest the CLASS, not the phrase).
    const SS = require(`${ROOT}/lib/self_state`);
    for (const q of [
      'whats actually broken in your own program right now, if anything?',
      'how long has your idle lane been shut down?',
      'did the thing your watch organ caught actually get fixed or is it still failing?',
      "what's failing in your code these days",
      'is your research lane closed again?',
      'since when has the idle lane been starved',
      'what did self-watch flag this week',
      'tell me about need #101',
      'I saw that your integrity audit got halted last night and disarmed its own autopilot. what happened there?',
    ]) ok(SS.detectStateQuestion(q), `state door opens: "${q.slice(0, 60)}"`);
    for (const q of ['the bill about idle land use in Maine', 'how long until the election', 'what broke the negotiations between the parishes'])
      ok(!SS.detectStateQuestion(q), `state door stays SHUT on a non-self question: "${q.slice(0, 50)}"`);
    // the injected authority now carries the needs ledger (executed, not grepped)
    const SV = require(`${ROOT}/lib/status_vector`);
    const v = SV.assemble({ deps: {} });
    ok(v.needs && typeof v.needs === 'object', 'status_vector.assemble carries v.needs (the ledger in the self-read)');
    ok(v.needs.newestRepair && v.needs.newestRepair.gist, `the newest open repair need rides the self-read (#${v.needs.newestRepair && v.needs.newestRepair.id})`);
    // the audit verdict rides the self-read too (leg E: a false halt-claim met no audit field)
    db.setMeta('audit.last_report', JSON.stringify({ ts: Date.now(), total_fixed: 3, converged: true }));
    const v2 = SV.assemble({ deps: {} });
    ok(v2.audit && v2.audit.converged === true, 'the auditor’s last verdict rides the self-read (refute halt-claims from it)');
    // round-2 H2+E2: the week's ACTUAL self-watch filings ride the read; the block rails against
    // instrument confusion and turn-ending check-promises (both live-caught twice)
    ok(Array.isArray(v2.needs.recentWatch) && v2.needs.recentWatch.length >= 1, `recentWatch lists the week's real filings (${v2.needs.recentWatch && v2.needs.recentWatch.length})`);
    SV.refresh({ deps: {} });
    const blk = SV.block({ deps: {} });
    ok(/DIFFERENT organ, content review, never self-watch/.test(blk), 'block: the instrument boundary is named (curation queues ≠ self-watch)');
    ok(/NEVER end the turn on "let me check\/look"/.test(blk), 'block: the answer-now rail (the check-promise dangled twice live)');
    ok(/THIS READ OUTRANKS YOUR OWN EARLIER ANSWERS/.test(blk), 'block: the anti-precedent rail (round-3 H3: her round-2 wrong answer in-window beat the injected read while E3 obeyed the same block)');
    // H4 ROOT (three rails lost to a TOOL RESULT — correctly): obs_events was LABELED "her
    // self-watch stream" so the store itself misattributed research [cite] exhaust as watch
    // findings. The store labels are the cure; prompts were never going to win against data.
    const ldSrc = fs.readFileSync(path.join(ROOT, 'lib', 'localdb.js'), 'utf8');
    ok(/OMNIBUS organ event bus/.test(ldSrc) && !/'her self-watch stream/.test(ldSrc), 'localdb: obs_events labeled as the OMNIBUS bus (never "her self-watch stream")');
    ok(/lane='watch' rows ONLY/.test(ldSrc), 'localdb: self-watch findings scoped to lane=watch + the needs ledger');
    const opSrc = fs.readFileSync(path.join(ROOT, 'lib', 'operator.js'), 'utf8');
    ok(/OMNIBUS event bus/.test(opSrc) && /NEVER self-watch findings/.test(opSrc), 'operator: obs_query doc carries the same boundary');
    ok(/verifyStudyCitations\(study\)/.test(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')),
      'main.js: the study pass verifies cited URLs against the ledger (cited = actually read; Lucas 08-27)');

    // ── wiring pins (main.js + doors) ──────────────────────────────────────────────────────────
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    ok(/THE REPAIR LANE \(census wire 4/.test(main) && /setDiagnosis\(_cand\.id/.test(main),
      'main.js: the repair lane intercepts program-defect needs BEFORE the tool pipe (diagnosis → proposed)');
    ok(/WORKED AND WAITING ON YOU/.test(main), 'main.js: proposed needs surface to chat (C3 write-only state cured)');
    ok(/audit\.last_report/.test(main) && /kg\.dedup\.last/.test(main) && /kg\.nightly\.last/.test(main),
      'main.js: audit/dedup/nightly results persist durably (not console-only)');
    ok(/BAD NEWS from a completed pass/.test(main), 'main.js: a bad-news audit verdict is console.error (self_watch-mintable)');
    ok(/retireQuietRepairs\(\)/.test(main), 'main.js: the quiet-retire wire runs at the curator seam');
    const sv = fs.readFileSync(path.join(ROOT, 'lib', 'status_vector.js'), 'utf8');
    ok(/Producer lanes:/.test(sv) && /idleClosedH/.test(sv), 'status_vector: producers render in block(); closures carry DURATION');
    const so = fs.readFileSync(path.join(ROOT, 'lib', 'self_ops.js'), 'utf8');
    ok(/stall_attrib\\.log/.test(so), 'self_ops: stall_attrib.log is readable by her own log tool');
    const ld = fs.readFileSync(path.join(ROOT, 'lib', 'localdb.js'), 'utf8');
    ok(/route_health/.test(ld) && /CURATED/.test(ld), 'localdb: route_health is pinned in the manifest (zero-reader table gets a door)');
    const ws = fs.readFileSync(path.join(ROOT, 'lib', 'work_state.js'), 'utf8');
    ok(/snap\.needs/.test(ws) && /snap\.audit/.test(ws), 'work_state: needs + audit standing are status-door visible');
  } catch (e) {
    fail++;
    console.error('  \u2717 smoke crashed:', e.message, e.stack);
  } finally {
    try { fs.unlinkSync(DBP); } catch {}
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
