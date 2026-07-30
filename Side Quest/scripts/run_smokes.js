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
const os = require('os');
const path = require('path');

const electron = require('electron');              // in plain Node this resolves to the binary path
const dir = __dirname;

// The GATE set: OFFLINE-DETERMINISTIC smokes only (isolated temp DB, no live model / network /
// Echo). The repo has ~120 smoke_*.js total, but many are live-integration (model/Echo/network)
// and can't run headless — running them all is always red and useless as a gate. This curated
// list is the regression suite for the memory / curation / retrieval / resilience work. Add a
// smoke here only once it's confirmed to pass offline with no external dependency.
const smokes = [
  'smoke_manifest.js',
  'smoke_owner_world.js',
  'smoke_boot_grace.js',
  'smoke_event_lane.js',
  'smoke_echo_tier_desktop.js',
  'smoke_dispatch_timeout.js',
  'smoke_coverage_count.js',
  'smoke_meeting_grounding.js',
  'smoke_crm_door.js',
  'smoke_canvas_awareness.js',
  'smoke_unprompted.js',
  'smoke_greenlight.js',
  'smoke_soft_leash.js',
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
  'smoke_reconcile.js',
  'smoke_revise.js',
  'smoke_belief_correction.js',
  'smoke_iterate_block.js',
  'smoke_cloud_logic.js',
  'smoke_cloud_stream.js',
  'smoke_cloud_window.js',
  'smoke_package.js',
  'smoke_fit_window.js',
  'smoke_run_closure.js',
  'smoke_doc_set.js',
  'smoke_obs_bus.js',
  'smoke_self_watch.js',
  'smoke_stream_discriminator.js',
  'smoke_backoff.js',
  'smoke_civic_store.js',
  'smoke_civic_capture.js',
  'smoke_double_reply.js',
  'smoke_self_question.js',
  'smoke_stage_direction.js',
  'smoke_child_env.js',
  'smoke_interests.js',
  'smoke_meta.js',
  'smoke_active_recall.js',
  'smoke_graph_walk.js',
  'smoke_idle_anchors.js',
  'smoke_self_repetition.js',
  'smoke_unprompted_gate.js',
  'smoke_recency_fixation.js',
  'smoke_beats.js',
  'smoke_beat_scheduler.js',
  'smoke_swarm.js',
  'smoke_route_obs.js',
  'smoke_route_drain.js',
  'smoke_coalesce.js',
  'smoke_memo.js',
  'smoke_lane.js',
  'smoke_thread_adopt.js',
  'smoke_thought_gate.js',
  'smoke_route_derive.js',
  'smoke_absence.js',
  'smoke_coverage_gaps.js',
  'smoke_cardinality.js',
  'smoke_cardinality_capture.js',
  'smoke_referent.js',
  'smoke_covered_union.js',
  'smoke_body_key.js',
  'smoke_doc_contacts.js',
  'smoke_origin.js',
  'smoke_observed_at.js',
  'smoke_decomp_encounters.js',
  'smoke_news_encounters.js',
  'smoke_meeting_encounters.js',
  'smoke_place_key.js',
  'smoke_contacts_evidence.js',
  'smoke_coverage_evidence.js',
  'smoke_pdf_wasm.js',
  'smoke_known_incorrect.js',
  'smoke_strong_id.js',
  'smoke_object_type.js',
  'smoke_mint_type.js',
  'smoke_id_scheme_type.js',
  'smoke_birth_context.js',
  'smoke_org_site.js',
  'smoke_decompose_sweep.js',
  'smoke_type_adjudicator.js',
  'smoke_wikidata_type.js',
  'smoke_curation_gate.js',
  'smoke_curation_store.js',
  'smoke_substantiation.js',
  'smoke_entity_match.js',
  'smoke_entity_block.js',
  'smoke_entity_collective.js',
  'smoke_entity_fuse.js',
  'smoke_resolution_gate.js',
  'smoke_resolution_live.js',
  'smoke_strongid_backfill.js',
  'smoke_civic_canon.js',
  'smoke_doc_decompose.js',
  'smoke_corroboration.js',
  'smoke_confidence_model.js',
  'smoke_confidence_decay.js',
  'smoke_decay_pass.js',
  'smoke_civic_domain.js',
  'smoke_promote_gate.js',
  'smoke_supersession.js',
  'smoke_identity_gate.js',
  'smoke_ingest_lane.js',
  'smoke_substantiate_lane.js',
  'smoke_research_lane.js',
  'smoke_research_exec.js',
  'smoke_research_sources.js',
  'smoke_email_prefilter.js',
  'smoke_bounce_normalizer.js',
  'smoke_puller_bounce_ingest.js',
  'smoke_puller_name_gate.js',
  'smoke_puller_revise.js',
  'smoke_puller_migration.js',
  'smoke_owner_identity.js',
  'smoke_vocative_self.js',
  'smoke_identity_dedup.js',
  'smoke_puller_corrections.js',
  'smoke_certainty.js',
  'smoke_puller_supersession.js',
  'smoke_decomp_lane.js',
  'smoke_substantiation_gate.js',
  'smoke_contact_extract.js',
  'smoke_contact_card.js',
  'smoke_puller_walk.js',
  'smoke_contacts_query.js',
  'smoke_contacts_intent.js',
  'smoke_prospect_fetch.js',
  'smoke_enrich_maigret.js',
  'smoke_sheet_extract.js',
  'smoke_file_ingest.js',
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
  'smoke_record_completeness.js',
  'smoke_records_interp.js',
  'smoke_research_plan.js',
  'smoke_compose.js',
  'smoke_canvas_ingest.js',
  'smoke_canvas_docs.js',
  'smoke_canvas_layout_db.js',
  'smoke_sources.js',
  'smoke_doc_qa.js',
  'smoke_doc_store.js',
  'smoke_promote.js',
  'smoke_retention.js',
  'smoke_fade.js',
  'smoke_meeting_lane.js',
  'smoke_meeting_audio.js',
  'smoke_localdb.js',
  'smoke_convo_state.js',
  'smoke_convo_tier.js',
  'smoke_recovery_encounters.js',
  'smoke_convo_encounters.js',
  'smoke_encounters.js',
  'smoke_localdb_attach.js',
  'smoke_intake.js',
  'smoke_estimate_correction.js',
  'smoke_poll.js',
  'smoke_activity.js',
  'smoke_activity_coverage.js',   // every kg:activity kind must reach a gesture — catches log-without-visual
  'smoke_canvas_route.js',
  'smoke_leakguard.js',
  'smoke_research.js',
  'smoke_research_enrich.js',
  'smoke_known.js',
  'smoke_calendar.js',
  'smoke_self_dev.js',
  'smoke_self_state.js',
  'smoke_awareness_standing.js',
  'smoke_background_bleed.js',
  'smoke_not_a_question.js',
  'smoke_references.js',
  'smoke_meeting_chat_gate.js',
  'smoke_scribe_append.js',
  'smoke_assignment_plan.js',
  'smoke_canvas_layout_migrate.js',
  'smoke_echo_batch_args.js',
  'smoke_arg_feedback.js',
  'smoke_dispatch_guards.js',
  'smoke_crm_upsert.js',
  'smoke_graph_integrity.js',
  'smoke_graph_integrity_tick.js',
  'smoke_doc_shapes.js',
  'smoke_tz.js',
  'smoke_directives.js',
  'smoke_thinking_channel.js',
  'smoke_planning_leak.js',
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
  'smoke_echo_tier_families.js',
  'smoke_tool_router.js',
  'smoke_echo_resolve.js',
  'smoke_subconscious.js',
  'smoke_extract_offload.js',
  'smoke_subconscious_tier.js',
  'smoke_model_sweep.js',
  'smoke_media_search_watch.js',
  'smoke_web_verify.js',

  // EDITOR STUDIO — the whole verification spine. These were absent from the gate entirely, so the
  // subsystem could be refactored end-to-end without a single gated test running. All offline and
  // deterministic (temp DBs, mock callTool, stub embedder, no model / network / Echo).
  'smoke_doc_extract.js',
  'smoke_file_ingest.js',
  'smoke_editor_import.js',
  'smoke_editor_registry.js',
  'smoke_editor_roundtrip.js',
  'smoke_editor_attach.js',
  'smoke_editor_checks.js',
  'smoke_editor_cert.js',
  'smoke_verify_extract.js',
  'smoke_source_reader.js',            // the ONE owner of "is this the document's text, or its container?"
  'smoke_verify_resolve.js',
  'smoke_verify_match.js',
  'smoke_verify_preflight.js',
  'smoke_verify_modelio.js',
  'smoke_verify_classify.js',
  'smoke_verify_deepcheck.js',
  'smoke_verify_factcheck.js',
  'smoke_verify_pipeline.js',
  'smoke_verify_harness.js',
  'smoke_listen.js',
  'smoke_answer_draft.js',
  'smoke_turn_router.js',
  'smoke_tag_parser.js',
  'smoke_tag_contract.js',
  'smoke_operator.js',
  'smoke_autonomy.js',
  'smoke_approvals.js',
  'smoke_user_work.js',
  'smoke_packaging.js',
  'smoke_week_context.js',
  'smoke_conversation_objects.js',
  'smoke_story_follow.js',
  'smoke_recall.js',
  'smoke_board.js',
  'smoke_procedures.js',
  'smoke_self_source.js',
  'smoke_rehearsal.js',
  'smoke_inquiry.js',
  'smoke_dig.js',
  'smoke_skills.js',
  'smoke_spreadsheet.js',
  'smoke_site_ledger.js',
  'smoke_respin.js',
  'smoke_fetch_escalation.js',
  'smoke_rehearsal_driver.js',
  'smoke_rehearsal_py.js',
  'smoke_analysis_lane.js',
  'smoke_table_extract.js',
  'smoke_held_roster.js',
  'smoke_capability_need.js',
  'smoke_ner.js',
  'smoke_mention.js',
  'smoke_cognition.js',
  'smoke_intent_parse.js',
  'smoke_self_guardrail.js',
  'smoke_deep_budgets.js',
  'smoke_reasoning_headroom.js',
  'smoke_pipeline.js',
  'smoke_md_to_docx.js',
  'smoke_photo_grab.js',
  'smoke_face_match.js',
  'smoke_profile_confirm.js',
  'smoke_email_harvest.js',
  'smoke_tts.js',
  'smoke_tts_service.js',
  'smoke_concept_ground.js',
  'smoke_brainstorm.js',
  'smoke_usage_meter.js',
  'smoke_avatar_state.js',
  'smoke_vrm_state.js',
  'smoke_excavate.js',
  'smoke_staleness.js',
  // Data-Stream (news) lane — isolated NEWS_DB_PATH / pure; offline-deterministic
  'smoke_feeds_view.js',
  'smoke_news_store.js',
  'smoke_news_migrate.js',
  'smoke_news_poll.js',
  'smoke_news_watch.js',
  'smoke_news_lane.js',
  'smoke_news_gate.js',
  'smoke_news_transcript.js',
  'smoke_speech_intent.js',
  'smoke_news_claim.js',
  'smoke_news_objects.js',
  'smoke_news_brief.js',
  'smoke_news_ads.js',
  'smoke_video_capture.js',
  'smoke_video_reconstruct.js',
  'smoke_email_intake.js',
  'smoke_truth_poll.js',
  'smoke_news_topics.js',
  'smoke_news_rank.js',
  // Forecasting suite — Suite-A polling adapters (pure, offline-deterministic)
  'smoke_poll_wikipedia.js',
  'smoke_poll_votehub.js',
  'smoke_poll_538legacy.js',
  // Forecasting suite — Suite-B models (pure, offline-deterministic)
  'smoke_poll_average.js',
  'smoke_forecast_service.js',
  'smoke_forecast_sim.js',
  'smoke_news_feed.js',
  'smoke_forecast_reactor.js',
  'smoke_forecast_registry.js',
  'smoke_forecast_assess.js',
  'smoke_econ_feed.js',
  'smoke_forecast_fundamentals.js',
  'smoke_candidate_party.js',
  'smoke_seat_map.js',
  'smoke_sidecar.js',
  'smoke_coverage.js',
  'smoke_calibration.js',
  'smoke_backtest.js',
  'smoke_congress_backtest.js',
  'smoke_forecast_loop.js',
  // API management stream — catalog + authenticated client + management layer (pure, offline; mocked fetch/clock)
  'smoke_api_client.js',
  'smoke_api_manager.js',
  'smoke_api_stream.js',
  'smoke_api_landing.js',
  'smoke_api_bulk.js',
];

// SWEEP THE TEMP DATABASES THE SMOKES CANNOT DELETE THEMSELVES.
//
// Every db-backed smoke ends with `try { fs.unlinkSync(tmp); } catch {}` — and on Windows that
// ALWAYS throws EBUSY, because the better-sqlite3 handle is still open when the process exits. The
// error is swallowed, so the failure is invisible and all three WAL-mode files (.db, -wal, -shm)
// survive every run. Measured 2026-07-23: 3,192 orphaned files.
//
// That was not merely untidy. The paths were keyed on `process.pid`, PIDs recycle, and a later smoke
// landing on a recycled PID opened its predecessor's database believing it was empty — so
// smoke_covered_union intermittently saw the focus.* rows ITS OWN previous run had written and
// failed its first assertion while the other ten passed. A gate that reports red for a reason that
// has nothing to do with the code is worse than no gate: it teaches you to read past red. The paths
// now carry a random suffix so a leftover can never be adopted; this sweep stops them accumulating.
function sweepOrphanedTempDbs(label) {
  try {
    const tmpDir = os.tmpdir();
    // Smokes leave temp state in BOTH shapes: loose files (`sq_apibulk_<uniq>.db` plus its -wal/-shm)
    // and whole directories (`sq_personaltest_<uniq>/sq.db`). Matching only the files left 3,289
    // directories behind on the first pass.
    const FILE_RE = /^(?:sq_|ss_)[\w-]*\.(?:db|json)(?:-wal|-shm)?$/;
    const DIR_RE = /^(?:sq_|ss_)[\w-]+$/;
    let swept = 0;
    for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      const isDir = e.isDirectory();
      if (!(isDir ? DIR_RE : FILE_RE).test(e.name)) continue;
      try { fs.rmSync(path.join(tmpDir, e.name), { force: true, recursive: isDir }); swept++; } catch { /* still locked by a live run */ }
    }
    if (swept) console.log(`swept ${swept} orphaned smoke temp file(s) ${label}`);
  } catch { /* never let housekeeping block the gate */ }
}
// BEFORE: nothing from an earlier run can be adopted or counted. AFTER: the children have exited, so
// their handles are released and this run's own files can finally be removed — sweeping only at the
// start would leave a full run's residue (~1,000 files) sitting on the machine until next time.
sweepOrphanedTempDbs('before the run\n');

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
  // Two result-line dialects are in use: "PASS — n ok, m failed" (memory/curation smokes) and
  // "ALL PASS — n passed, m failed" (the editor/verify suites). Accept both — the editor suites were
  // silently outside the gate for want of a matching regex, so the whole verification spine could be
  // refactored without one gated test running.
  const m = out.match(/(ALL PASS|FAILURES|PASS|FAIL) — (\d+) (?:ok|passed), (\d+) failed/);
  if (m && /^(ALL )?PASS$/.test(m[1])) { passed++; console.log(`PASS  ${s.padEnd(30)} (${m[2]} ok)`); }
  // THIRD dialect: a suite that prints a bare "SMOKE PASSED"/"SMOKE FAILED" with no counts (e.g.
  // smoke_activity_coverage). It was reported as a FAILURE for want of a matching regex — the same
  // bug the comment above describes, one dialect later. A green suite counted as red is not the safe
  // direction it looks like: it trains everyone to read past a red gate.
  else if (!m && /^\s*SMOKE PASSED\s*$/m.test(out)) { passed++; console.log(`PASS  ${s.padEnd(30)} (no count reported)`); }
  else { failed++; failures.push(s); console.log(`FAIL  ${s.padEnd(30)} ${m ? `(${m[3]} failed)` : '(no result line — crashed?)'}`); }
}

sweepOrphanedTempDbs('after the run');
console.log(`\n${failed === 0 ? '✅ ALL GREEN' : '❌ FAILURES'} — ${passed} suites passed, ${failed} failed`);
if (failures.length) console.log('   failed:', failures.join(', '));
process.exit(failed === 0 ? 0 : 1);
