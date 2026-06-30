/* Test gate — runs every scripts/smoke_*.js through Electron-as-Node and reports aggregate
 * pass/fail. This is the regression gate for the memory/curation/retrieval work; run it before
 * any restart or after touching lib/ or main.js.
 *
 * Run: npm test   (or: node scripts/run_smokes.js)
 * This runner itself runs under plain Node — it only SPAWNS the smokes with the Electron binary
 * (so better-sqlite3's Electron-built ABI loads inside each child). It does not touch the DB.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');              // in plain Node this resolves to the binary path
const dir = __dirname;

// The GATE set: OFFLINE-DETERMINISTIC smokes only (isolated temp DB, no live model / network /
// Echo). The repo has ~120 smoke_*.js total, but many are live-integration (model/Echo/network)
// and can't run headless — running them all is always red and useless as a gate. This curated
// list is the regression suite for the memory / curation / retrieval / resilience work. Add a
// smoke here only once it's confirmed to pass offline with no external dependency.
const smokes = [
  'smoke_unprompted.js',
  'smoke_relevance_floor.js',
  'smoke_stream_watchdog.js',
  'smoke_email_killswitch.js',
  'smoke_cloud_curator.js',
  'smoke_self_evolution_merge.js',
  'smoke_neardup_knowledge.js',
  'smoke_graph_adjudicate.js',
  'smoke_daily_pass.js',
  'smoke_goal_guard.js',
  'smoke_verified_capture.js',
  'smoke_verified_reconcile.js',
  'smoke_verified_boost.js',
  'smoke_iterate_block.js',
  'smoke_cloud_logic.js',
  'smoke_interests.js',
  'smoke_meta.js',
  'smoke_active_recall.js',
  'smoke_swirl_iterate.js',
  'smoke_live_info.js',
  'smoke_preferences.js',
  'smoke_personal_facts.js',
  'smoke_metacognition.js',
  'smoke_calibration_pressure.js',
  'smoke_focus.js',
  'smoke_condense.js',
  'smoke_assemble.js',
  'smoke_track.js',
  'smoke_track_index.js',
  'smoke_poll.js',
  'smoke_activity.js',
  'smoke_canvas_route.js',
  'smoke_leakguard.js',
  'smoke_research.js',
  'smoke_research_enrich.js',
  'smoke_self_dev.js',
  'smoke_self_state.js',
  'smoke_self_narrative.js',
  'smoke_mood.js',
  'smoke_voice.js',
  'smoke_personal.js',
  'smoke_reawaken.js',
  'smoke_vision.js',
  'smoke_vision_surfaces.js',
  'smoke_distill.js',
  'smoke_echo_cloud_route.js',
  'smoke_echo_tier.js',
  'smoke_tool_router.js',
  'smoke_subconscious.js',
  'smoke_extract_offload.js',
  'smoke_subconscious_tier.js',
  'smoke_model_sweep.js',
  'smoke_media_search_watch.js',
  'smoke_web_verify.js',
  'smoke_listen.js',
  'smoke_answer_draft.js',
  'smoke_operator.js',
];

let passed = 0, failed = 0;
const failures = [];
for (const s of smokes) {
  let out = '';
  try {
    out = execFileSync(electron, [path.join(dir, s)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const m = out.match(/(PASS|FAIL) — (\d+) ok, (\d+) failed/);
  if (m && m[1] === 'PASS') { passed++; console.log(`PASS  ${s.padEnd(30)} (${m[2]} ok)`); }
  else { failed++; failures.push(s); console.log(`FAIL  ${s.padEnd(30)} ${m ? `(${m[3]} failed)` : '(no result line — crashed?)'}`); }
}

console.log(`\n${failed === 0 ? '✅ ALL GREEN' : '❌ FAILURES'} — ${passed} suites passed, ${failed} failed`);
if (failures.length) console.log('   failed:', failures.join(', '));
process.exit(failed === 0 ? 0 : 1);
