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
  'smoke_fallthrough.js',
  'smoke_media_cc.js',
  'smoke_teams.js',
  'smoke_swarm_roster.js',
  'smoke_importance.js',
  'smoke_c3_reflection.js',
  'smoke_c4_persona.js',
  'smoke_salience.js',
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
  'smoke_content_firewall.js',
  'smoke_stake.js',
  'smoke_tier_gate.js',
  'smoke_quota.js',
  'smoke_quota_scrape.js',
  'smoke_lane_tier.js',        // H2/M5 (2026-08-12 review): spend-tier resolution + ambient carriage

  'smoke_review_fanout.js',
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
  // Puller core (2026-08-07: were on disk but never gated — Standing Debt "the real number is
  // unverifiable"; each verified passing offline before adding. puller_ingest's 2 vaporware
  // size-seed asserts neutralized to a visible PENDING note).
  'smoke_puller.js',
  'smoke_puller_ingest.js',
  'smoke_puller_confidence.js',
  'smoke_puller_export.js',
  'smoke_puller_ipc.js',
  'smoke_puller_negatives.js',
  'smoke_puller_org_door.js',
  'smoke_org_walk.js',
  'smoke_org_fetch.js',        // H1 (2026-08-12 review): every fetch exit SETTLES — the subconscious-killing hang

  'smoke_puller_priors.js',
  'smoke_puller_variants.js',
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
  'smoke_verify_claim.js',
  'smoke_delivery.js',
  'smoke_spreadsheet_out.js',
  'smoke_local_frame.js',
  'smoke_local_roster.js',
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
  'smoke_canvas_emit.js',
  'smoke_canvas_split.js',
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
  // (smoke_file_ingest.js was registered here a SECOND time — review M6: the "396" headline ran 395
  // unique suites with one counted twice. Kept at its first registration above.)
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
  'smoke_self_ops.js',
  'smoke_research_preflight.js',
  'smoke_adaptive_loop.js',
  'smoke_need_triage.js',
  'smoke_report_command.js',
  'smoke_deferral_pause.js',
  'smoke_roster_refresh.js',
  'smoke_product_ledger.js',
  'smoke_roster_watch.js',
  'smoke_meeting_leave.js',
  'smoke_gmeet_leave.js',
  'smoke_meeting_scribe.js',   // H7 (2026-08-12 review): carries the 5c6ba20 finalize re-entrancy regression asserts — was offline-green but UNGATED

  'smoke_canvas_command.js',
  'smoke_org_backfill.js',
  'smoke_recheck_queue.js',
  'smoke_test_port.js',
  'smoke_work_coords.js',
  'smoke_pathway_cadence.js',
  'smoke_fetch_reuse.js',
  'smoke_artifact_intent.js',
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
  // Engine supervisor (2026-08-08: on disk, never gated — hermetic: fetch monkeypatched, spawn
  // injected. Carries the fresh46 zombie-respawn-loop regression cases.)
  'smoke_engine.js',
  // Scenario lane (2026-08-07: on disk, never gated — now verified passing offline and brought in).
  'smoke_scenario_analogs.js',
  'smoke_scenario_engine.js',
  'smoke_scenario_estimate.js',
  'smoke_scenario_workmove.js',
  'smoke_forecast_scenario_ipc.js',
  // API management stream — catalog + authenticated client + management layer (pure, offline; mocked fetch/clock)
  'smoke_api_client.js',
  'smoke_api_manager.js',
  'smoke_api_stream.js',
  'smoke_api_landing.js',
  'smoke_api_bulk.js',
  // Voice registry — the voice-cloning-suite foundation (migration + resolve precedence + fail-soft; temp dir, no GPU/net)
  'smoke_voices.js',
  // ── UNGATED-SMOKES AUDIT, wave 1 (2026-08-12 review follow-through) ─────────────────────────────
  // A read-only audit classified all 109 ungated suites: 106 gate-worthy, 3 live-integration, 0 stale.
  // These are the top live-incident-coverage candidates, each VERIFIED passing offline before
  // admission (the array's own rule). Three of them FAILED first verification — all three were
  // STALE-ASSERT (zero regressions): roster_intake pinned pre-refactor main.js source text (the
  // cascade moved to lib/contact_finders), meeting_engagement pinned the old 90s leave window
  // (300s since "far too eager"), smoke_gmeet pinned the pre-CHAT-DOOR always-posts world. Each
  // updated to the CURRENT contract (gmeet now pins BOTH door sides) and admitted. The remaining
  // ~93 gate-worthy suites are mapped in the audit — admit in waves, verified, never in bulk.
  'smoke_meeting_recall.js',        // post-meeting awareness must say she ATTENDED (anti-confabulation window)
  'smoke_meeting_transcript.js',    // durable timestamped transcript + segmentTurns
  'smoke_meeting_episodic.js',      // first-class episodic meeting memory
  'smoke_echo_suit.js',             // all 5 dispatch verbs incl. malformed-JSON self-correct (offline mock client)
  'smoke_echo_client.js',           // real socket-reuse incidents (UND_ERR_SOCKET, PARAGRAPH SEPARATOR)
  'smoke_choke_gate.js',            // the ollama choke-point spend gate's MUTE-SAFETY invariant
  'smoke_usage_meter_durable.js',   // the meter survives reboot (persist/restore)
  'smoke_contact_finders.js',       // single finder source-of-truth (order/escalation)
  'smoke_contact_cascade.js',       // the fill cascade over injected fakes
  'smoke_domain_resolve.js',        // org→domain resolver
  'smoke_roster_intake.js',         // the 2026-08-05 live regression (10-person LA paste → category dump) + routing guard
  'smoke_meeting_engagement.js',    // the three live-witnessed fixes (search guard, directive capture, grounded follow-along)
  'smoke_gmeet.js',                 // base stage machine + MANDATORY disclosure + BOTH chat-door sides
  // ── UNGATED-SMOKES AUDIT, wave 2 (2026-08-12) — 68 verified clean passers ──────────────────────
  // Every suite below ran individually green (zero failed) before admission; all fast (<3s) except
  // smoke_stt (~19s, noted). NOT admitted, deferred to wave 3 with the stale-vs-regression triage
  // discipline: 8 suites with failures (act_on_page 1, canvas_view 1, curator 3, kg_view 1,
  // meeting_research 2, news_snapshot 1, recipes_heavy 1, rumination_breaker 5) and ~14
  // embedder/silent suites that end with no verdict line or crash tails (the unref()'d WASM embed
  // worker class — the reason they were never gated; needs the memory.embed stub pattern from
  // smoke_c3_reflection before they can join).
  'smoke_actionable_gate.js', 'smoke_audit_fixes.js', 'smoke_availability.js', 'smoke_blackboard.js',
  'smoke_blockers.js', 'smoke_browse_redirect.js', 'smoke_byline.js', 'smoke_calendar_view.js',
  'smoke_canvas_layout.js', 'smoke_capability_doubt.js', 'smoke_caption_stream.js', 'smoke_cert_template.js',
  'smoke_checks_contract.js', 'smoke_comfort_fixation.js', 'smoke_commit_guardrail.js', 'smoke_consolidate.js',
  'smoke_creator.js', 'smoke_creator_proofread.js', 'smoke_creator_research.js', 'smoke_creator_sources.js',
  'smoke_creator_stats.js', 'smoke_crm_view.js', 'smoke_curation.js', 'smoke_doc_concept_lane.js',
  'smoke_doc_view.js', 'smoke_downtime.js', 'smoke_fixation_brake.js', 'smoke_flow_runner.js',
  'smoke_gaps.js', 'smoke_graph_extract.js', 'smoke_graph_memory.js', 'smoke_graph_phase3.js',
  'smoke_graph_phase4.js', 'smoke_inbox_junk.js', 'smoke_inbox_voice.js', 'smoke_intent.js',
  'smoke_interweave.js', 'smoke_leg_view.js', 'smoke_memory_gap.js', 'smoke_memory_phase2.js',
  'smoke_models.js', 'smoke_open_questions.js', 'smoke_permissions.js', 'smoke_play_runtick.js',
  'smoke_play_session.js', 'smoke_play_startchat.js', 'smoke_poll_view.js', 'smoke_query_class.js',
  'smoke_recipes.js', 'smoke_recorder.js', 'smoke_register_gate.js', 'smoke_retrieval.js',
  'smoke_self_check.js', 'smoke_shared_link.js', 'smoke_sheet_view.js', 'smoke_snapback.js',
  'smoke_stt.js', 'smoke_super_search_card.js', 'smoke_super_search_external.js', 'smoke_super_search_ingest.js',
  'smoke_super_search_ledger.js', 'smoke_super_search_modelio.js', 'smoke_super_search_recipes.js', 'smoke_super_search_run.js',
  'smoke_touchpoint.js', 'smoke_variety.js', 'smoke_web.js', 'smoke_web_downloads.js',
  // ── wave 3a (2026-08-12): the 7 of 8 failing candidates repaired — ALL stale-assert vs deliberate
  // contract changes, zero regressions: act_on_page pinned the wiped-page BUG as expected behavior;
  // canvas_view's "bad kind" example (pie) became a real kind; news_snapshot pinned the pre-split
  // corroboration/reach label; meeting_research pinned the pre-CHAT-DOOR CONTRIBUTE; curator +
  // rumination_breaker pinned the pre-S3 self-spawn world (now pin the autonomic default AND the
  // legacy mechanics under ZOE_AUTONOMIC=0); recipes_heavy's targeted[0] ignored optional steps.
  // NOT admitted: smoke_kg_view (1 fail, edge styling — the PARALLEL kg3d lane's deliberate change;
  // theirs to reconcile) + the ~14 embedder/silent suites (need the memory.embed stub pattern).
  // ⚠OPEN DESIGN QUESTION surfaced by this triage: rumination.escalate → setFromText is INERT under
  // the S3 default (monologue.js ~1069 still calls it live; window consumed, nothing ever spawns) —
  // whether the escalation valve is meant to be dead is Lucas's call.
  'smoke_act_on_page.js', 'smoke_canvas_view.js', 'smoke_news_snapshot.js', 'smoke_meeting_research.js',
  'smoke_curator.js', 'smoke_rumination_breaker.js', 'smoke_recipes_heavy.js',
  'smoke_rumination.js',   // was CRASHING on the same S3 root (null focus after demoted setFromText) — repaired + kill-switch-pinned, 8/8
  // ── truth-audit builds (2026-08-12 late) ─────────────────────────────────────────────────────
  'smoke_speech_class.js',  // which unprompted utterances deserve the VOICE (rail vs speak) + the insertTurn stamp
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
    // ⚠ CONCURRENCY-SAFE (2026-08-07). The tmpdir is SHARED across every gate run on the machine —
    // including a rehearsal SANDBOX gate running at the same time as this one. Sweeping by name alone
    // deleted a CONCURRENT run's in-flight temp DBs out from under it, so its suites failed when their
    // database vanished mid-test — measured live: need #48's sandbox gate flaked on a rotating set
    // (vision/operator/cognition) that all pass in isolation, which kept the R2 proposal card just out
    // of reach. An ORPHAN is by definition from a process that already exited, so it is OLD; a live
    // run's files are FRESH. Skip anything modified within the grace window — a concurrent gate's
    // files are never younger-bounded away, and real orphans still age past it and get swept later.
    const GRACE_MS = 5 * 60 * 1000;
    const cutoff = Date.now() - GRACE_MS;
    let swept = 0;
    for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      const isDir = e.isDirectory();
      if (!(isDir ? DIR_RE : FILE_RE).test(e.name)) continue;
      const full = path.join(tmpDir, e.name);
      try { if (fs.statSync(full).mtimeMs > cutoff) continue; } catch { continue; }   // fresh (maybe a live run's) → leave it
      try { fs.rmSync(full, { force: true, recursive: isDir }); swept++; } catch { /* still locked by a live run */ }
    }
    if (swept) console.log(`swept ${swept} orphaned smoke temp file(s) ${label}`);
  } catch { /* never let housekeeping block the gate */ }
}
// BEFORE: nothing from an earlier run can be adopted or counted. AFTER: the children have exited, so
// their handles are released and this run's own files can finally be removed — sweeping only at the
// start would leave a full run's residue (~1,000 files) sitting on the machine until next time.
sweepOrphanedTempDbs('before the run\n');

// Run ONE suite and classify its result → true (pass) | false (fail). `quiet` suppresses the
// per-suite PASS/FAIL line (used on the retry pass, which prints its own labels).
const fallbackPasses = [];   // M6: suites green only via the exit-0 fallback — surfaced in the summary
function runSuite(s, { quiet = false } = {}) {
  let out = '', childOk = true;   // childOk = the child exited 0 (execFileSync throws on nonzero/timeout)
  try {
    out = execFileSync(electron, [path.join(dir, s)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
    });
  } catch (e) { childOk = false; out = (e.stdout || '') + (e.stderr || ''); }
  // Two result-line dialects are in use: "PASS — n ok, m failed" (memory/curation smokes) and
  // "ALL PASS — n passed, m failed" (the editor/verify suites). Accept both — the editor suites were
  // silently outside the gate for want of a matching regex, so the whole verification spine could be
  // refactored without one gated test running.
  const m = out.match(/(ALL PASS|FAILURES|PASS|FAIL) — (\d+) (?:ok|passed), (\d+) failed/);
  let ok, label;
  if (m && /^(ALL )?PASS$/.test(m[1])) { ok = true; label = `(${m[2]} ok)`; }
  // THIRD dialect: a suite that prints a bare "SMOKE PASSED"/"SMOKE FAILED" with no counts (e.g.
  // smoke_activity_coverage). It was reported as a FAILURE for want of a matching regex — the same
  // bug the comment above describes, one dialect later. A green suite counted as red is not the safe
  // direction it looks like: it trains everyone to read past a red gate.
  else if (!m && /^\s*SMOKE PASSED\s*$/m.test(out)) { ok = true; label = '(no count reported)'; }
  // FIFTH dialect, GENERALIZED (2026-08-12 review M6 follow-through + the wave-2 audit's dialect
  // zoo): the verdict is any count line `N passed, M failed` (em dash, hyphen, self-named prefix,
  // "CURATION OK —", "COMMIT GUARDRAIL OK —", "SOME FAILURES —" — all carry it) or a bare
  // `name: N ok`. Read the LAST count line as the suite's verdict: failed===0 → pass. This is a
  // REAL verdict with counts, strictly stronger than the exit-0 fallback below — and one general
  // matcher ends the dialect whack-a-mole (three specific dialects grew to six in one audit).
  else if (!m && /\d+\s+passed,\s+\d+\s+failed/.test(out)) {
    const g = [...out.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)].pop();
    ok = Number(g[2]) === 0; label = ok ? `(${g[1]} ok)` : `(${g[2]} failed)`;
  }
  else if (!m && /:\s*\d+\s+ok\s*$/m.test(out) && !/✗|FAIL/i.test(out)) { ok = true; label = '(n-ok line)'; }
  // FOURTH dialect (measured 2026-08-06): Electron's piped stdout can DROP the final console.log
  // when process.exit fires before the pipe drains — a suite whose ok() is success-silent
  // (smoke_self_question) then produces ZERO output on a clean pass, and three others lose only
  // their tail "PASS —" line. The EXIT CODE is the suite's own verdict (every suite ends
  // process.exit(fail ? 1 : 0)), so exit 0 with no failure marker in what DID arrive is a pass.
  // A crash/timeout still throws (childOk=false) and a lost-line FAILING suite still exits 1.
  // TIGHTENED (2026-08-12 review M6): this fallback was silently load-bearing for ~23 gated suites
  // and would have counted an ASSERT-FREE EARLY EXIT (chatter, no ✓, exit 0) as green. Exit 0 may
  // stand in for a lost result line ONLY when the output matches the measured pipe-race shapes:
  // completely empty (a success-silent suite) or visibly-ran asserts (✓ marks, tail line lost).
  // Anything else exiting 0 without a recognized verdict is a FAILURE to declare loudly.
  else if (!m && childOk && !/✗|FAIL/.test(out) && (out.trim() === '' || /✓/.test(out))) { ok = true; label = '(exit 0 — result line lost to the stdout pipe race)'; fallbackPasses.push(s); }
  else { ok = false; label = m ? `(${m[3]} failed)` : '(no result line — crashed?)'; }
  if (!quiet) console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.padEnd(30)} ${label}`);
  return ok;
}

let passed = 0;
let failures = [];
for (const s of smokes) { if (runSuite(s)) passed++; else failures.push(s); }
// M6 visibility: how much of the green depended on the exit-0 fallback — the gate's optimism must
// be a NUMBER in the output, never an invisible assumption.
if (fallbackPasses.length) console.log(`\nℹ ${fallbackPasses.length} suite(s) passed via the exit-0 fallback (no recognized result line): ${fallbackPasses.slice(0, 8).join(', ')}${fallbackPasses.length > 8 ? ` (+${fallbackPasses.length - 8} more)` : ''}`);

// FLAKE-TOLERANT EXIT (2026-08-07). This 360+-suite gate spawns one Electron child per suite, back to
// back, and when it runs as a REHEARSAL SANDBOX gate it competes with the whole live app for CPU/IO —
// so a timing-sensitive suite occasionally misses under load (measured: vision/operator pass solo
// every time but flake inside the full sandbox gate). Requiring all N green in ONE shot made the
// rehearsal's green exit — and the R2 proposal card — hostage to a load flake with nothing wrong in
// the code. A load flake passes when re-run alone in a quieter moment; a REAL failure (a broken edit)
// fails every time. So: re-run each failure ALONE, up to a few times with a short settle between —
// the machine is still hot right after the main pass, so a single immediate retry can itself flake;
// extra attempts (spaced) catch a clear window. A suite that passes on ANY attempt was a flake
// (absolved, named); one that fails EVERY attempt is real and keeps the gate red. Only retried when
// the failure set is SMALL (a pile of failures is real breakage, not flakes).
const RETRY_MAX = parseInt(process.env.SMOKE_FLAKE_RETRY_MAX || '', 10) || 5;
const RETRY_ATTEMPTS = parseInt(process.env.SMOKE_FLAKE_RETRY_ATTEMPTS || '', 10) || 3;
const RETRY_SETTLE_MS = parseInt(process.env.SMOKE_FLAKE_RETRY_SETTLE_MS || '', 10) || 750;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → no delay */ } };
const flakes = [];
if (failures.length && failures.length <= RETRY_MAX) {
  console.log(`\n↻ ${failures.length} suite(s) failed — re-running each ALONE up to ${RETRY_ATTEMPTS}× (a load flake recovers in a quieter window; a real failure fails every time):`);
  const stillFailed = [];
  for (const s of failures) {
    let recovered = false, tries = 0;
    for (let a = 1; a <= RETRY_ATTEMPTS && !recovered; a++) {
      tries = a;
      if (a > 1) sleepSync(RETRY_SETTLE_MS);   // let a transient load spike subside before the next try
      if (runSuite(s, { quiet: true })) recovered = true;
    }
    if (recovered) { flakes.push(s); passed++; console.log(`  ✓ ${s.padEnd(30)} passed on retry (attempt ${tries}/${RETRY_ATTEMPTS}) → FLAKE (absolved)`); }
    else { stillFailed.push(s); console.log(`  ✗ ${s.padEnd(30)} failed all ${RETRY_ATTEMPTS} retries → REAL failure`); }
  }
  failures = stillFailed;
} else if (failures.length > RETRY_MAX) {
  console.log(`\n${failures.length} failures (> ${RETRY_MAX}) — NOT a flake pattern; reporting as a real breakage without retry.`);
}

sweepOrphanedTempDbs('after the run');
const failed = failures.length;
if (flakes.length) console.log(`\n⚠ ${flakes.length} flaky suite(s) passed only on retry (absolved, gate stays green): ${flakes.join(', ')}`);
console.log(`${failed === 0 ? '✅ ALL GREEN' : '❌ FAILURES'} — ${passed} suites passed, ${failed} failed${flakes.length ? ` (${flakes.length} recovered on retry)` : ''}`);
if (failures.length) console.log('   failed:', failures.join(', '));
process.exit(failed === 0 ? 0 : 1);
