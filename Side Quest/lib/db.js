const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
// SQ_DB_PATH lets smoke/back-tests run against an isolated throwaway DB instead of
// the live data/sq.db. Unset in normal operation → the real database.
const DB_PATH = process.env.SQ_DB_PATH || path.join(DATA_DIR, 'sq.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK(speaker IN ('user','ai_thought','ai_said')),
  content TEXT NOT NULL,
  model TEXT,
  truncated INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turns_session_ts ON turns(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_speaker_ts ON turns(speaker, ts);

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  prompt_used TEXT NOT NULL,
  content TEXT NOT NULL,
  source_turn_start INTEGER,
  source_turn_end INTEGER,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_reflections_ts ON reflections(ts);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS monologue (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  model TEXT,
  content TEXT NOT NULL,
  feed_context TEXT,
  surfaced_as_turn_id INTEGER,
  type TEXT DEFAULT 'thought',
  query TEXT,
  urls TEXT
);
CREATE INDEX IF NOT EXISTS idx_monologue_ts ON monologue(ts);
`;

// Idempotent migrations. Column adds first; indexes that depend on new columns last.
const MIGRATIONS = [
  `ALTER TABLE monologue ADD COLUMN type TEXT DEFAULT 'thought'`,
  `ALTER TABLE monologue ADD COLUMN query TEXT`,
  `ALTER TABLE monologue ADD COLUMN urls TEXT`,
  // doc_ref → documents.id: a READING that came from a STORED document carries the pointer, so any
  // consumer (package grounding, recall markers) can cite it as [dN] and pull the full text on demand
  // instead of quoting the reading's own 240-char gist. NULL = the reading has no stored doc behind it.
  `ALTER TABLE monologue ADD COLUMN doc_ref INTEGER`,
  // THE WORKSTREAM BOARD (conductor slice 2a — lib/board.js). One queryable "what is running in me
  // now": every discrete lane run registers a row; locks bound concurrency by RESOURCE CLASS instead
  // of politeness (cloud_slot_1 is permanently the chat's; ≤1 maintenance pass per store). Heartbeats
  // make crashes self-healing: a running row/lock whose heartbeat goes stale is swept/expired on read.
  `CREATE TABLE IF NOT EXISTS workstreams (
    id INTEGER PRIMARY KEY,
    lane TEXT NOT NULL,
    kind TEXT,
    target TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed')),
    resource TEXT,
    note TEXT,
    started_ts INTEGER NOT NULL,
    heartbeat_ts INTEGER NOT NULL,
    finished_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workstreams_status_hb ON workstreams(status, heartbeat_ts)`,
  `CREATE TABLE IF NOT EXISTS resource_locks (
    resource TEXT PRIMARY KEY,
    holder_stream INTEGER,
    holder_lane TEXT,
    since_ts INTEGER NOT NULL,
    heartbeat_ts INTEGER NOT NULL
  )`,
  // PROCEDURAL MEMORY (conductor slice 2c — lib/procedures.js). The "how to do things" store the
  // harness thesis calls for: competence moves from model parameters into retrievable rows. kind
  // 'procedure' = a proven method (trigger/steps/check, with its honest track record); 'constraint'
  // = a durable "this did NOT work" that outlives the 12-entry autonomy history. Crystallized from
  // her own expect-verified runs; injected into operator briefs when the trigger matches.
  `CREATE TABLE IF NOT EXISTS procedures (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'procedure' CHECK(kind IN ('procedure','constraint')),
    name TEXT NOT NULL,
    trigger_text TEXT NOT NULL,
    steps TEXT,
    check_text TEXT,
    applicability TEXT,
    provenance TEXT,
    met INTEGER NOT NULL DEFAULT 0,
    unmet INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
    created_ts INTEGER NOT NULL,
    last_used_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_procedures_status ON procedures(status, kind)`,
  // LINES OF INQUIRY (catalog O0 — lib/inquiry.js). The unit of her autonomous work stops being a
  // tick and becomes a QUESTION that persists: evidence appends (never rolling-rewritten), the
  // model writes next_step at the end of every touch, and the next touch starts where this one
  // stopped. Boot40 measured the disease this cures: zero model decisions against ~800 code-picked
  // moves — continuity was structurally impossible, so the background read as a scan schedule.
  `CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    born_from TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','parked','closed_answered','closed_dead_end')),
    evidence TEXT,
    gist TEXT,
    open_leads TEXT,
    next_step TEXT,
    touches INTEGER NOT NULL DEFAULT 0,
    expect_trail TEXT,
    created_ts INTEGER NOT NULL,
    last_touched_ts INTEGER,
    closed_ts INTEGER,
    answer TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status, last_touched_ts)`,
  // MID-CONVERSATION DIG (slice 4b — lib/dig.js). Set when a conversation-born inquiry's first
  // REAL finding is announced back into the chat that asked. NULL = the homecoming is still owed,
  // so a later tick-advanced finding still returns to the talk (§6 L1: the address rides the object).
  `ALTER TABLE inquiries ADD COLUMN dig_delivered_ts INTEGER`,
  // CONTRACT LINKAGE (contract-agent slice 5, spec §9/§11 as-built): a question-back the operator
  // NEVER answered graduates at close-out into her own background inquiry — the assumption she
  // shipped on becomes a question she keeps working. One inquiry system, two askers; the columns'
  // first (and only) writer is contract_closeout's graduation step.
  `ALTER TABLE inquiries ADD COLUMN contract_id TEXT`,
  `ALTER TABLE inquiries ADD COLUMN slot_id TEXT`,
  `ALTER TABLE inquiries ADD COLUMN assumption TEXT`,
  // THE SKILL SHELF (O1, slice 5 — lib/skills.js). A REGISTRY over the three procedure systems
  // that already exist (flow recipes / crystallized procedures / instruction packs) — the trigger
  // surface (name + one ≤140-char line) is permanent and cheap; the body dereferences on pull
  // (<skill name="…"/>). Births: recipes/ sync at boot; a procedure crossing met≥3 self-promotes.
  `CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    trigger_desc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('flow','procedure','shape','guide')),
    body_ref TEXT,
    applies TEXT,
    provenance TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used_ts INTEGER,
    created_ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_monologue_type_ts ON monologue(type, ts)`,
  // THE SITE LEDGER (2026-07-23, Lucas: "doesn't she capture the page on first land anyway?…
  // I would rather get explained that a site is taking longer to digest than realize we took 500
  // calls to interact with the landing page"). Every successful capture RECORDS here; autonomous
  // navigation CONSULTS it before re-fetching. site_plans holds the per-host digest checklist.
  `CREATE TABLE IF NOT EXISTS site_visits (
    url TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'page',
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    visits INTEGER NOT NULL DEFAULT 1,
    chars INTEGER,
    doc_id INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_site_visits_host ON site_visits(host)`,
  `CREATE TABLE IF NOT EXISTS site_plans (
    host TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
  )`,
  // SITE ACCESS PROFILES (2026-07-23, Lucas: "when hitting failures, factor the failures into
  // mechanisms for planning and trying new approaches — no information should ever be out of
  // reach"). Per-host memory of WHICH access door worked or failed (browser/plain-fetch/archive/
  // vision) + free-text notes (a template-broken link, a JS shell). The escalation ladder leads
  // with what worked last time; a known wall surfaces as site notes at the moment of retry.
  `CREATE TABLE IF NOT EXISTS site_access (
    host TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    updated_ts INTEGER NOT NULL
  )`,
  // SITE SWEEPS (2026-08-27, the walker — lib/site_crawler): the accounting row for a directed
  // whole-site sweep. The frontier itself lives in site_plans; this row carries status + the honest
  // counters (fetched/reused/robots-skipped/binary/failed) the completion report is rendered from.
  `CREATE TABLE IF NOT EXISTS site_sweeps (
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL,
    seed_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','paused','stopped')),
    reason TEXT,
    requested_by TEXT,
    bootstrapped INTEGER NOT NULL DEFAULT 0,
    robots TEXT,
    milestone INTEGER NOT NULL DEFAULT 0,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    pages_reused INTEGER NOT NULL DEFAULT 0,
    pages_failed INTEGER NOT NULL DEFAULT 0,
    skipped_robots INTEGER NOT NULL DEFAULT 0,
    skipped_binary INTEGER NOT NULL DEFAULT 0,
    pdfs_grabbed INTEGER NOT NULL DEFAULT 0,
    docs_landed INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    done_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_site_sweeps_status ON site_sweeps(status)`,
  // CHECK includes blocked_external/routed_research (census C2, 2026-08-27): the triage lane wrote
  // both for weeks against a CHECK that rejected them — every UPDATE threw, setStatus swallowed it,
  // and the external-needs chat door NEVER fired. Older DBs are rebuilt in init() below (SQLite
  // cannot ALTER a CHECK). `diagnosis` = the Stage-2 repair diagnosis stored ON the need row.
  `CREATE TABLE IF NOT EXISTS capability_needs (
    id INTEGER PRIMARY KEY,
    need TEXT NOT NULL,
    born_from TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','rehearsing','proposed','parked','retired','blocked_external','routed_research')),
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER,
    diagnosis TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    claim TEXT NOT NULL,
    evidence_turn_ids TEXT,
    confidence REAL DEFAULT 0.7,
    status TEXT DEFAULT 'held',
    first_held_at INTEGER NOT NULL,
    last_confirmed_at INTEGER,
    last_challenged_at INTEGER,
    revision_history TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_commitments_status_ts ON commitments(status, ts)`,
  // open_threads — goals/tasks she is actively pursuing across ticks.
  // Distinct from commitments (beliefs) — these are intentions/work-in-progress.
  // status: pending → active → (stalled|resolved|abandoned)
  // parent_id enables Park-style hierarchical decomposition of compound goals.
  `CREATE TABLE IF NOT EXISTS open_threads (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','stalled','resolved','abandoned')),
    parent_id INTEGER REFERENCES open_threads(id),
    source_turn_id INTEGER,
    created_ts INTEGER NOT NULL,
    last_touched_ts INTEGER NOT NULL,
    resolved_ts INTEGER,
    progress_notes TEXT,
    mention_count INTEGER DEFAULT 0,
    action_count INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_open_threads_status_ts ON open_threads(status, last_touched_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_open_threads_parent ON open_threads(parent_id)`,
  // open_questions — questions ZOE asked Lucas that await an answer (the QUD/grounding
  // stack). Distinct from open_threads (her goals) and commitments (her beliefs): this is
  // live CONVERSATIONAL state — "I asked, he hasn't answered." Surfaced on his next turn so
  // a terse reply binds to the question; auto-closed once surfaced. See open_questions.js.
  `CREATE TABLE IF NOT EXISTS open_questions (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    asked_turn_id INTEGER,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','answered','dropped')),
    answer_turn_id INTEGER,
    created_ts INTEGER NOT NULL,
    resolved_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_open_questions_session_status ON open_questions(session_id, status, created_ts)`,
  // conversation_state — a running summary of the LIVE conversation per session (recursive
  // summarization, Wang 2023). The compact "where we are now" anchor that survives turns
  // scrolling out of the 14-turn recency window, so she doesn't lose the thread on longer
  // exchanges — and the voice-gate substrate (no scrollback to lean on). One row per session.
  `CREATE TABLE IF NOT EXISTS conversation_state (
    session_id INTEGER PRIMARY KEY,
    summary TEXT,
    turn_count INTEGER DEFAULT 0,
    updated_ts INTEGER NOT NULL
  )`,
  // protocols — durable user-AI negotiated agreements. ALWAYS injected, never aged.
  // Distinct memory class from turns (history), commitments (AI beliefs), or
  // open_threads (transient tasks). These are the rules of engagement.
  //   category: safe_word | mode_command | boundary | preference | rule
  //   action: hard_break_rp | enter_rp_mode | exit_rp_mode | none (description-only)
  `CREATE TABLE IF NOT EXISTS protocols (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('safe_word','mode_command','boundary','preference','rule')),
    trigger_phrase TEXT,
    action TEXT,
    description TEXT NOT NULL,
    source_turn_ids TEXT,
    established_ts INTEGER NOT NULL,
    last_confirmed_ts INTEGER NOT NULL,
    last_invoked_ts INTEGER,
    invoke_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','revised','revoked'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_protocols_status ON protocols(status)`,
  `CREATE INDEX IF NOT EXISTS idx_protocols_trigger ON protocols(trigger_phrase)`,
  // inbound_messages — replies from chat bots Eloise is watching.
  // Queued by ChatWatcher when a bot finishes streaming. Injected into Stheno's
  // next-turn context as <incoming> system block; marked consumed once injected.
  `CREATE TABLE IF NOT EXISTS inbound_messages (
    id INTEGER PRIMARY KEY,
    tab_url TEXT NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    message_index INTEGER,
    received_ts INTEGER NOT NULL,
    consumed_ts INTEGER,
    source TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inbound_consumed ON inbound_messages(consumed_ts, received_ts)`,
  // scheduled_tasks — Zoe's own clock. Reminders / one-off and recurring
  // self-tasks she sets for herself. A ticker in main.js fires due tasks,
  // surfaces them as a reading, and kicks the heartbeat so she acts on them.
  //   kind: 'once' (fires at fire_at) | 'recurring' (re-arms fire_at += interval_ms)
  //   status: pending | fired (once, done) | cancelled
  `CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'once' CHECK(kind IN ('once','recurring')),
    note TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    interval_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fired','cancelled')),
    source TEXT DEFAULT 'zoe',
    created_ts INTEGER NOT NULL,
    last_fired_ts INTEGER,
    fire_count INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_status_fire ON scheduled_tasks(status, fire_at)`,
  // email_log — every outbound send (and failure), for the daily-cap backstop
  // and full visibility. Zoe sends real mail; this is the audit trail.
  `CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    to_addr TEXT,
    subject TEXT,
    status TEXT NOT NULL,
    error TEXT,
    source TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_log_ts ON email_log(ts)`,
  // knowledge — the integration/learning store. Holds SHORT synthesized notes +
  // references + action trajectories (never copies of source corpora — see the
  // reference-not-copy principle). embedding = JSON float[384] (bge-small) for JS
  // cosine; knowledge_fts mirrors content for keyword (BM25). Retrieval fuses both.
  //   kind: note | fact | trajectory | reference
  `CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'note',
    content TEXT NOT NULL,
    embedding TEXT,
    source TEXT,
    importance REAL DEFAULT 0.5,
    created_ts INTEGER NOT NULL,
    last_used_ts INTEGER,
    use_count INTEGER DEFAULT 0,
    links TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge(kind)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(content)`,
  // documents — the SHORT-TERM landing store for whole new material (a doc Lucas drops on the canvas, a
  // finished research deliverable, meeting notes). Lands here IMMEDIATELY + durably (full body), so it
  // survives an engine/app restart (the canvas is in-memory in the engine and does NOT) and is recallable
  // the same day, BEFORE the nightly pass promotes it into Echo long-term. promoted=0 until consolidated;
  // parent_id/version carry the iteration model (an update is a new iteration of the original, never an
  // in-place overwrite). ref = an external key (e.g. the canvas tab_key) for idempotent landing.
  `CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    title TEXT,
    body TEXT NOT NULL,
    source TEXT,
    ref TEXT,
    understanding TEXT,
    parent_id INTEGER,
    version INTEGER DEFAULT 1,
    promoted INTEGER DEFAULT 0,
    promoted_ref TEXT,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_ref ON documents(ref)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_promoted ON documents(promoted)`,
  // documents_fts — EXTERNAL-CONTENT fts5 keyword index over documents(title, body) (2026-08-17).
  // heldContext (recheck_queue) built EVERY metabolism verification prompt with a full-table
  // `title LIKE '%tok%' OR body LIKE '%tok%'` scan over ~17k docs / 1.29GB body — a MEASURED ~1.4s
  // SYNCHRONOUS main-thread block per call, fired 1–3× per metabolism tick: the confirmed carrier of the
  // ~3.4s metabolism stall (adversarially verified — the applyOutcome-transaction hypothesis was a red
  // herring; WAL+synchronous=NORMAL means no per-commit fsync). A MATCH over this index is ~1ms.
  // content='documents' → the FTS stores ONLY the inverted index, NOT a second copy of the 1.29GB body
  // (disk-cheap). Kept fresh by syncDocumentsFts (a forward-watermark C-side INSERT…SELECT from a background
  // tick — NO trigger on the doc-write path, no body marshalled into JS). heldContext falls back to the LIKE
  // scan until this index is built, so the change can never regress recall.
  `CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title, body, content='documents', content_rowid='id')`,
  // agent_events — the BLACKBOARD. One append-only timeline that every idle loop
  // writes to at the end of its tick and reads from at the top, so tick N+1 sees
  // tick N (the "continuous consciousness" substrate). Reference-not-copy: each
  // row points at the canonical source row (ref_table/ref_id) and keeps only a
  // short `content` snippet + a normalized `signature` for the StuckDetector's
  // cheap equality compare. cause_id links an event to the one that triggered it
  // (e.g. an observation back to its action). source ∈ monologue|heartbeat|
  // reflection|action|user|curator; kind ∈ thought|reading|utterance|action|
  // observation|insight|focus_set|focus_advance|focus_resolve|user_msg.
  `CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    focus_id INTEGER,
    cause_id INTEGER,
    ref_table TEXT,
    ref_id INTEGER,
    content TEXT,
    signature TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_ts ON agent_events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_focus ON agent_events(focus_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_source ON agent_events(source, id)`,
  // Generative-Agents importance ("poignancy"): a 1–10 significance score on each
  // thought/reading. Drives the heartbeat surfacing gate (don't speak trivia) and
  // the Phase-D retrieval scorer (importance is one of recency×relevance×importance).
  `ALTER TABLE monologue ADD COLUMN importance INTEGER`,
  // capability_gaps — things she discovered she CAN'T do yet during idle time,
  // each with her proposed solution. Detected from <gap> tags / blocked focuses;
  // surfaced as a proactive proposal when the user returns (the "drive toward new
  // capabilities" behavior). status: open → proposed → resolved|dismissed.
  // signature = normalized description for dedup (avoid the open_threads sprawl).
  `CREATE TABLE IF NOT EXISTS capability_gaps (
    id INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    proposed_solution TEXT,
    source_context TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','proposed','resolved','dismissed')),
    signature TEXT,
    detected_ts INTEGER NOT NULL,
    proposed_ts INTEGER,
    resolved_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_capability_gaps_status ON capability_gaps(status, detected_ts)`,
  // self_model — the IDENTITY track, distinct from `knowledge` (the capability
  // track). Small, curated, CONSOLIDATED in place (not append-forever) and ALWAYS
  // injected into her persona, so "who she is" is continuously loaded rather than
  // retrieved on demand. category: trait|value|preference|relationship|insight.
  // `mentions` bumps each time a near-duplicate is reinforced, so durable traits rise.
  `CREATE TABLE IF NOT EXISTS self_model (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL DEFAULT 'insight',
    content TEXT NOT NULL,
    embedding TEXT,
    importance REAL DEFAULT 0.6,
    mentions INTEGER DEFAULT 1,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_self_model_cat ON self_model(category)`,
  // provenance — REFERENCE-NOT-COPY marker(s) for a knowledge row: where the raw
  // data this note was distilled from actually LIVES (a reading's monologue row +
  // url, an action, an email, the reflection window). JSON array of
  // {type,label,refTable?,refId?,url?}. Lets her drill from a compact note back to
  // the full source without the store ever holding a copy of it.
  `ALTER TABLE knowledge ADD COLUMN provenance TEXT`,
  `ALTER TABLE turns ADD COLUMN embedding TEXT`,
  // MODEL-VISIBLE (2026-08-15, deepseek-harness "model-visible means logged"): what the model ACTUALLY
  // received for this turn (raw message + held-data/attachments/drafted-answer/control injections). NULL on
  // turns where nothing was injected (replay falls back to `content`). Persisting it lets a later replay
  // reconstruct the real cause of the reply — the answer-orphaning / apparent-fabrication structural fix.
  `ALTER TABLE turns ADD COLUMN model_visible TEXT`,
  // permissions — the authoritative list of what Zoe is ALREADY allowed/able to do.
  // The structured source of truth behind "settled permission": always injected so
  // she stops ASKING for / PROPOSING capabilities she already has (chronic under-reach
  // on the 24B — she re-pitches "let me establish file access" when it's long granted).
  // Sibling of `protocols` (rules of engagement); this table is GRANTS.
  //   status: granted | granted_with_judgment (outward/irreversible — her call, not a
  //   permission to ask for) | ask_first | denied
  `CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY,
    capability TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'granted' CHECK(status IN ('granted','granted_with_judgment','ask_first','denied')),
    description TEXT NOT NULL,
    how TEXT,
    updated_ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_permissions_status ON permissions(status)`,
  // MEMORY REDESIGN Phase 2 — endpoint-not-path. Once a reading is distilled into a
  // durable knowledge note (during reflection), it's marked consolidated and pointed at
  // the note that captured it (distilled_into). Consolidated readings are then EXCLUDED
  // from recency injection — recall loads the distilled endpoint + a pointer, never the
  // raw journey again. The raw row STAYS addressable (HippoRAG-2: don't delete sources).
  `ALTER TABLE monologue ADD COLUMN consolidated INTEGER DEFAULT 0`,
  `ALTER TABLE monologue ADD COLUMN distilled_into INTEGER`,
  // MEMORY REDESIGN Phase 3 — general↔specific hierarchy. level: 'fact' (leaf, specific)
  // | 'topic' (rolled-up summary). parent_id → the topic a fact sits under. Lets narrow
  // retrieval prefer the LEAF and walk UP to the topic only when leaf coverage is thin.
  `ALTER TABLE knowledge ADD COLUMN level TEXT DEFAULT 'fact'`,
  `ALTER TABLE knowledge ADD COLUMN parent_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_level ON knowledge(level)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_parent ON knowledge(parent_id)`,

  // GRAPH MEMORY (anti-glob): Zoe's OWN relational store, modeled on echo/store.py
  // (entities/relations/sources/source_citations + a propose→promote gate). Self-
  // contained — never depends on Echo — but written in the SAME structure so it maps
  // ~1:1 onto Echo's KG for federation. The addition Echo's research-KG doesn't model
  // is the EPISTEMIC layer: every fact carries how-we-know-it (witnessed|told|read|
  // speculated|anticipated) + a confirmed flag, so speculation can't masquerade as fact
  // and an anticipated-but-absent item (the "Madeline was expected" glob) can be
  // reconciled. entity_type/relation_type are open TEXT (whitelist enforced in code,
  // like Echo) so the vocab can align with Echo's [graph] config for clean union.
  // See docs/MEMORY_GROUNDING.md.
  `CREATE TABLE IF NOT EXISTS graph_entities (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL,
    entity_subtype TEXT,
    summary TEXT,
    confidence REAL DEFAULT 0.8,
    epistemic TEXT NOT NULL DEFAULT 'told',
    confirmed INTEGER,
    proposed_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_entities_type ON graph_entities(entity_type)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_entities_epis ON graph_entities(epistemic)`,
  `CREATE TABLE IF NOT EXISTS graph_relations (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    confidence REAL DEFAULT 0.8,
    epistemic TEXT NOT NULL DEFAULT 'told',
    confirmed INTEGER,
    proposed_by TEXT,
    created_at INTEGER NOT NULL,
    valid_from INTEGER,
    valid_to INTEGER,
    deleted INTEGER DEFAULT 0,
    UNIQUE(source_id, target_id, relation_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_relations_src ON graph_relations(source_id, relation_type) WHERE deleted = 0`,
  `CREATE INDEX IF NOT EXISTS idx_graph_relations_tgt ON graph_relations(target_id, relation_type) WHERE deleted = 0`,
  `CREATE TABLE IF NOT EXISTS graph_sources (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    ref TEXT,
    excerpt TEXT,
    fetched_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS graph_citations (
    source_id INTEGER NOT NULL REFERENCES graph_sources(id) ON DELETE CASCADE,
    fact_kind TEXT NOT NULL,
    fact_id INTEGER NOT NULL,
    quoted_text TEXT,
    PRIMARY KEY (source_id, fact_kind, fact_id)
  )`,
  `CREATE TABLE IF NOT EXISTS graph_entity_proposals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_subtype TEXT,
    summary TEXT,
    confidence REAL DEFAULT 0.6,
    epistemic TEXT NOT NULL DEFAULT 'speculated',
    proposed_by TEXT,
    source_ref TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_ent_prop_status ON graph_entity_proposals(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS graph_relation_proposals (
    id INTEGER PRIMARY KEY,
    source_name TEXT NOT NULL,
    target_name TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    confidence REAL DEFAULT 0.6,
    epistemic TEXT NOT NULL DEFAULT 'speculated',
    proposed_by TEXT,
    source_ref TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_rel_prop_status ON graph_relation_proposals(status, created_at)`,

  // GROUND THE SELF (anti-glob): her identity track gets the same epistemic discipline as the
  // fact graph. epistemic ∈ witnessed (she actually did it repeatedly) | told (Lucas affirmed
  // it) | speculated (she asserted it about herself). Existing rows default to 'speculated' —
  // they were all self-asserted. Injection then ranks grounded self above asserted self, and
  // self-repetition no longer buys influence (the mechanism that entrenched the obsession).
  `ALTER TABLE self_model ADD COLUMN epistemic TEXT DEFAULT 'speculated'`,

  // DOCUMENT ORIGIN + CONTENT IDENTITY (docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md blockers #1 and #2).
  // `source` records the LANE a document arrived on (browser_download / news / research); it has never
  // recorded WHERE the content came from, so origin-independence was uncomputable and every ingested
  // fact was permanently ungradeable — origin cannot be reconstructed after the fact.
  //   origin       the canonical source URL, normalised. NULL is honest and expected for SYNTHESISED
  //                documents (a research dossier is derived from many pages, not fetched from one).
  //   origin_host  the independence key — same host means same origin, so a claim repeated across five
  //                pages of one site counts once.
  //   content_hash text identity. The corpus measured 11.6% byte-identical duplicates, already
  //                inflating corroboration counts; this collapses them.
  `ALTER TABLE documents ADD COLUMN origin TEXT`,
  `ALTER TABLE documents ADD COLUMN origin_host TEXT`,
  `ALTER TABLE documents ADD COLUMN content_hash TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_documents_origin_host ON documents(origin_host)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash)`,
  // ORIGIN IS THE FIRST HIGH-QUALITY SOURCE (Lucas, 2026-07-20), so `origin` holds the PUBLISHER while
  // this holds where the bytes actually were. Three Apache County records arrived from an S3 bucket:
  // storing that as origin would grade official documents `unknown` AND make two different counties on
  // the same hosting vendor read as one source. Both facts are kept — the publisher grades the claim,
  // the fetch URL is how it is re-fetched or audited.
  `ALTER TABLE documents ADD COLUMN fetch_url TEXT`,
  // Duplicate rows are SUPERSEDED, never deleted. 806 documents (12% of the corpus) are byte-identical
  // copies of another, and they carry 35% of all `docstore:` citations because the most-duplicated
  // documents are also the most-decomposed. Merging them repoints those citations at the canonical row;
  // keeping the superseded row means the merge stays invertible, which is the whole reason a wrong merge
  // is survivable here. Canonical = the OLDEST id per content hash: the first encounter keeps the id
  // everything already cites.
  `ALTER TABLE documents ADD COLUMN superseded_by INTEGER`,
  // Spine 4 / C1 (docs/INTEGRATED_BUILD_TRACK_2026-08-10.md §C1) — importance ("poignancy") for LANDED
  // documents, stamped at landing by doc_store.land via importance.scoreDocument (deterministic, no model
  // call; the browser_download flood scores low by shape). 1..10; consumed by promotion triage (C2) + the
  // reflection trigger (C3). Nullable — rows landed before this migration carry no score (treated as default).
  `ALTER TABLE documents ADD COLUMN importance INTEGER`,
  // THE PROMOTE LEDGER for documents (continuity cure #3, 2026-09-02): a doc whose ingest failed
  // (Echo's "database is locked" / "another row available" — transient) was retried the very next
  // night forever, eating slots (46 of 150 on the last pass) while it stayed unmarked. Every failed
  // attempt now leaves its count, its time and its error on the row; the scan skips a doc inside its
  // backoff (doubling from a day) so the queue rotates instead of stalling on the same failures.
  `ALTER TABLE documents ADD COLUMN promote_attempts INTEGER DEFAULT 0`,
  `ALTER TABLE documents ADD COLUMN promote_last_ts INTEGER`,
  `ALTER TABLE documents ADD COLUMN promote_error TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_documents_promote_turn ON documents(promoted, promote_attempts, promote_last_ts) WHERE promoted = 0`,
  // THE FREEZE (2026-09-03 01:24): the promote scan's window function sorted every unpromoted row (38k)
  // in a temp B-tree — 4.7s on the main thread, every 15-min beat. This partial index lets each lane's
  // head be read in order (source, attempts, id) — a range scan, milliseconds.
  `CREATE INDEX IF NOT EXISTS idx_documents_promote_source ON documents(source, promote_attempts, id) WHERE promoted = 0 AND superseded_by IS NULL`,
  // Two more of the freeze's named main-thread sorts (boot_p254's first 10 minutes): listOperatorDropEntities'
  // "documents WHERE source IN (…) AND superseded_by IS NULL ORDER BY created_ts DESC" (temp B-tree, 707ms
  // idle / 1–2.4s under load) and its kg_observations "feed = 'doc-decomp' AND url IN (…) ORDER BY id DESC"
  // (temp B-tree over every doc-decomp row of 1.49M, 375ms idle / 2–2.3s under load).
  `CREATE INDEX IF NOT EXISTS idx_documents_source_created ON documents(source, created_ts DESC) WHERE superseded_by IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_kg_obs_feed_url ON kg_observations(feed, url, id)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_superseded ON documents(superseded_by)`,

  // KNOWN-INCORRECT (§7) — the inoculation record. A claim that has been DISPROVEN is kept, forever,
  // marked. Two reasons, and the second is the one that pays:
  //   - "X was reported to have done Y, later retracted" is itself valuable in civic research, often
  //     more than the claim would have been if true.
  //   - storing the disproven value means the same bad datum cannot silently re-enter and re-open a
  //     settled question. Without it, the next sweep re-learns the same wrong email and the cycle
  //     repeats with no memory that it was already tested and failed.
  //
  // REFUTED IS NOT STALE, and conflating them would be wrong in both directions. §5a says contact
  // DECAYS: an old address superseded by a newer one is history, not an error. This table is only for
  // values shown to be FALSE — a bounced email, a corrected record — which is why every row demands a
  // reason and a source rather than just a timestamp.
  `CREATE TABLE IF NOT EXISTS known_incorrect (
    id INTEGER PRIMARY KEY,
    object_key TEXT NOT NULL,
    claim_class TEXT NOT NULL,
    claim_key TEXT,
    claim_value TEXT NOT NULL,
    reason TEXT NOT NULL,
    refuted_by TEXT,
    refuted_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_known_incorrect_uniq
     ON known_incorrect(object_key, claim_class, COALESCE(claim_key,''), claim_value)`,
  `CREATE INDEX IF NOT EXISTS idx_known_incorrect_object ON known_incorrect(object_key)`,

  // ENCOUNTER LOG (docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2) — the primitive beneath everything else.
  //
  // Lucas: an object is real because it has been ENCOUNTERED. Objects and edges are DERIVED from this
  // log; the log is the ground truth. Every lane writes here — news, research, doc drop, conversation,
  // meeting, API — and grading reads here.
  //
  // APPEND-ONLY, and that is load-bearing rather than tidy: a wrong merge is the one unrecoverable
  // failure. While each encounter keeps its own identity, un-merging stays possible. Fold them into one
  // record at write time and it never is. Nothing in lib/encounters.js updates or deletes a row.
  //
  //   object_key   identity, normalised — what merges. object_label keeps what the SOURCE called it,
  //                which is evidence and must survive resolution.
  //   claim_class  existence | contact | biographical | structural | interpretive. Grading ladders
  //                differ per class (§5): contact DECAYS and overwrites, biography ACCUMULATES and
  //                appends, existence never decays. One universal grade would be wrong for all of them.
  //   observed_at  THE SOURCE'S OWN DATE, not when we read it. Ingesting a 2021 PDF today must not let
  //                it outrank current data — the distinction is the whole point of carrying both.
  //   authority    official | ordinary | unknown. An official record substitutes for roughly one
  //                ordinary source (§6.3); source reliability, not vote count, is what the
  //                truth-discovery literature says decides conflicts.
  `CREATE TABLE IF NOT EXISTS encounters (
    id INTEGER PRIMARY KEY,
    object_type TEXT NOT NULL,
    object_key TEXT NOT NULL,
    object_label TEXT,
    claim_class TEXT NOT NULL,
    claim_key TEXT,
    claim_value TEXT,
    source_kind TEXT,
    source_ref TEXT,
    origin TEXT,
    origin_host TEXT,
    content_hash TEXT,
    authority TEXT DEFAULT 'unknown',
    observed_at INTEGER,
    ingested_at INTEGER NOT NULL
  )`,
  // ONE ENCOUNTER PER SOURCE PER CLAIM. Re-scanning a document must not cast a second vote — §3's rule
  // that a document may never corroborate a claim it is itself the origin of, enforced at write time
  // where it cannot be forgotten. Re-recording is therefore idempotent, never inflationary.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_encounters_uniq
     ON encounters(object_key, claim_class, COALESCE(claim_key,''), COALESCE(claim_value,''), COALESCE(source_ref,''))`,
  `CREATE INDEX IF NOT EXISTS idx_encounters_object ON encounters(object_key, claim_class)`,
  `CREATE INDEX IF NOT EXISTS idx_encounters_type ON encounters(object_type)`,
  `CREATE INDEX IF NOT EXISTS idx_encounters_source ON encounters(source_ref)`,
  // authority='unknown' COUNT rode the manifest every autonomy tick as a FULL-TABLE scan (no index) — 2.43s
  // over 482k rows on 2026-08-07, a main-thread stall culprit. Index it so the count is index-only.
  `CREATE INDEX IF NOT EXISTS idx_encounters_authority ON encounters(authority)`,

  // MEETING TRANSCRIPT (M1): durable, timestamped record of every caption line, so a meeting
  // chunk can purge from her active context yet remain a queryable, time-anchored transcript.
  // At meeting end this is the "fully processed transcript" artifact; turns are a view over it
  // (segmentTurns). Append-only; scoped per meeting via the `meeting` code + ts >= started_at.
  `CREATE TABLE IF NOT EXISTS meeting_transcript (
    id INTEGER PRIMARY KEY,
    meeting TEXT,
    speaker TEXT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_transcript_ts ON meeting_transcript(ts)`,

  // STANDING INSTRUCTIONS from Lucas — runtime feedback that outlives the turn (lib/directives).
  //
  // Deliberately NOT a self_model category. That store is a personality pool: MMR-sampled for
  // diversity, ranked to favour tastes, and designed to let unreinforced entries fade. All three are
  // wrong for an instruction, and this system has already turned one of his scope orders into "her
  // belief" and then outgrown it (fixed 92035fa). An instruction is a fact about what HE asked for,
  // it is rendered in FULL every turn, and it ends only when he retires it.
  //
  // `rule` keeps HIS words. source_turn_id is the receipt — which message it came from — so a
  // wrongly-captured rule can be traced back and removed rather than argued with.
  `CREATE TABLE IF NOT EXISTS directives (
    id INTEGER PRIMARY KEY,
    rule TEXT NOT NULL,
    source_turn_id INTEGER,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 1,
    retired_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_directives_active ON directives(retired_ts, created_ts)`,

  // UI ROUTING: distinguish her UNPROMPTED utterances (heartbeat / continuity / tool-result
  // follow-ups) from replies to a user message. The main chat renders prompted dialogue only;
  // unprompted=1 said-turns are diverted to the sheep panel — live AND on history reload (they
  // streamed via the same channel, so without this flag a reload couldn't tell them apart).
  `ALTER TABLE turns ADD COLUMN unprompted INTEGER DEFAULT 0`,

  // CLOUD REASONING TRACES — every cloud-assisted logic call (lib/cloud_logic) writes one row:
  // the COMPACT packaged input + the raw response + the validated/parsed output + whether it was
  // accepted. Two jobs: (1) the cache (skip an identical call by input_hash) and budget audit,
  // (2) THE TRAINING SET — a task-tagged corpus of (compact_input → validated_output) pairs to
  // later distill the cloud "tutor" into Zoe's own model. Never store secrets here.
  `CREATE TABLE IF NOT EXISTS cloud_traces (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    task TEXT NOT NULL,
    v INTEGER DEFAULT 1,
    model TEXT,
    input_hash TEXT,
    input_json TEXT,
    raw_response TEXT,
    parsed_json TEXT,
    valid INTEGER DEFAULT 0,
    accepted INTEGER DEFAULT 0,
    repaired INTEGER DEFAULT 0,
    cached INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloud_traces_hash ON cloud_traces(input_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_cloud_traces_task ON cloud_traces(task)`,

  // ROUTE OBSERVATION LOG (memory path mapping, slice P0) — one row per Echo dispatch: what we
  // asked for and whether it landed. Written at EchoLive.dispatch, the one place all five traversal
  // mechanisms funnel through. Deliberately dumb: it OBSERVES, it does not interpret — routes are
  // DERIVED from this offline (P1), so a wrong derivation is re-runnable rather than corrupting.
  //
  // SHAPES ONLY, NEVER VALUES: arg_shape is "entity_id:int,top_k:int" or "tables(entities|relations)";
  // a name, a query string or a SQL literal must never reach this table. It is a derivation input and
  // a disposable one — droppable and rebuildable, never a source of truth. See lib/route_obs.js and
  // docs/MEMORY_PATH_MAPPING_DESIGN.md.
  `CREATE TABLE IF NOT EXISTS route_obs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    focus_id TEXT,
    tool TEXT NOT NULL,
    arg_shape TEXT,
    result_shape TEXT,
    outcome TEXT NOT NULL,
    latency_ms INTEGER,
    autonomous INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_route_obs_ts ON route_obs(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_route_obs_tool ON route_obs(tool, outcome)`,
  // arg_hash: a SALTED one-way digest of the args, added after an audit of 8,145 observations
  // proved the shapes-only log could not answer "was this asked before" — the one question route
  // memoization depends on. Same args ⇒ same hash, with no readable content stored. NOT anonymity
  // (a holder of this DB holds the salt too); see lib/route_obs.js argHash for the honest limits.
  `ALTER TABLE route_obs ADD COLUMN arg_hash TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_route_obs_hash ON route_obs(tool, arg_hash)`,
  // LINKAGE (route derivation, P0.5): seq = ordinal within a focus; parent_id = the id of the prior
  // observation whose RESULT fed this call's ARGS. Together they turn the log from a bag of calls
  // into the ORDERED, CHAINED traces P1 derives routes from. Computed in memory from result tokens
  // that are never themselves persisted — only these two integers are. See lib/route_obs.js.
  `ALTER TABLE route_obs ADD COLUMN seq INTEGER`,
  `ALTER TABLE route_obs ADD COLUMN parent_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_route_obs_parent ON route_obs(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_route_obs_focus_seq ON route_obs(focus_id, seq)`,

  // route_health — the DURABLE distillate of route_obs (2026-07-25). The raw observation log was a
  // WRITE-ONLY pool nothing consumed: it grew to 2.6M rows / 470k a day, bloated the DB to 2.1 GB, and
  // stalled the main thread on every sync insert (the "lag with no CPU spike"). lib/route_derive folds
  // the raw rows into these per-tool rolling aggregates — the self-correction signal (what's slow, what
  // fails) — then PRUNES the consumed rows, so route_obs stays a small draining queue instead of an
  // unbounded pile. This table IS the retained value; the raw log is disposable once folded here.
  `CREATE TABLE IF NOT EXISTS route_health (
    tool TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n INTEGER NOT NULL DEFAULT 0,
    updated_ts INTEGER
  )`,

  // ABSENCE MODEL (memory path mapping, P3) — three-valued, after Wikidata snaks. A failed lookup
  // lands here as `somevalue` (a GAP: a value exists, we haven't found it) and feeds research.
  // `novalue` (no value exists in the world) is a CLAIM and requires evidence_kind/evidence_ref —
  // a timeout, or a hundred failed searches, never earns it. first_observed_ts is FROZEN on the
  // first sighting and never refreshed by re-reading (RFC 2308): otherwise autonomous workers
  // re-observing each other would keep a "not found" perpetually fresh and it would harden into a
  // false fact. Expiry runs off last_attempt_ts. See lib/absence.js.
  `CREATE TABLE IF NOT EXISTS absence (
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'somevalue',
    first_observed_ts INTEGER NOT NULL,
    last_attempt_ts INTEGER NOT NULL,
    attempts INTEGER DEFAULT 1,
    ttl_s INTEGER,
    evidence_kind TEXT,
    evidence_ref TEXT,
    PRIMARY KEY (subject, predicate)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_absence_kind ON absence(kind, last_attempt_ts)`,

  // CARDINALITY (memory path mapping, P5) — a body's SEAT COUNT, which is what turns "probably
  // incomplete" into a countable gap: 70 seats, 41 held, 29 missing. Coverage counts BODIES
  // researched and can say nothing about the roster inside one; this closes that.
  // A seat count is a CLAIM ABOUT THE WORLD (unlike `covered`, which is a fact about us), so it is
  // refused without a source — official / corroborated / secondary only, never "inferred". Conflicts
  // between sources are RECORDED (conflict_* columns) rather than silently last-write-wins, because
  // a disagreement usually means a chamber was resized or a source is wrong. See lib/cardinality.js.
  `CREATE TABLE IF NOT EXISTS cardinality (
    body TEXT PRIMARY KEY,
    seats INTEGER NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    observed_ts INTEGER NOT NULL,
    conflict_seats INTEGER,
    conflict_source TEXT,
    conflict_ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cardinality_conflict ON cardinality(conflict_ts)`,

  // RECHECK QUEUE (the metabolism, 2026-08-07 — [[program-end-state]]): ONE prioritized queue that
  // every doubt-producer feeds (stale absences, roster discrepancies, cardinality conflicts, …) and
  // the always-on verify loop DRAINS — the autonomic worklist doctrine applied to epistemics,
  // replacing the idle-lottery where "verify" competed with everything and lost. One OPEN row per
  // (kind, subject); resolution re-arms the producer's own cycle (an absence re-recorded as a miss
  // re-enqueues when its TTL next expires). See lib/recheck_queue.js.
  `CREATE TABLE IF NOT EXISTS recheck_queue (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    detail TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    due_ts INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_ts INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','parked')),
    outcome TEXT,
    born_from TEXT,
    created_ts INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_recheck_open ON recheck_queue(kind, subject) WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_recheck_due ON recheck_queue(status, due_ts, priority)`,
  // civic_bodies / civic_memberships — THE STRUCTURED HOME for researched governing bodies
  // (docs/CIVIC_BODY_SCHEMA_DESIGN.md, Lucas-approved 2026-07-30). Measured before building: 120
  // open county threads and hundreds of researched boards had NO queryable store — prose
  // deliverables and graph nodes only — which is why roster/contact-sheet deliverables never
  // worked and why db_query(county_election_boards) errored. Keyed on lib/body_key so a roster,
  // its seat denominator (cardinality) and its gap record (absence) all line up.
  // LEVEL and FUNCTION are orthogonal on purpose: an elections board and a commission share a
  // level and differ in function — one enum would repeat the ROLE-became-TYPE trap.
  `CREATE TABLE IF NOT EXISTS civic_bodies (
    body_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    level TEXT NOT NULL,
    function TEXT NOT NULL,
    state TEXT,
    place TEXT,
    official_url TEXT,
    selection TEXT,
    term_years INTEGER,
    notes TEXT,
    first_seen_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_civic_bodies_state ON civic_bodies(state, level, function)`,
  // ONE ROW PER SEAT-HELD-BY-A-PERSON-OVER-A-PERIOD. Not a person store — the CRM stays
  // authoritative; this owns SEATS and points at the person. person_name is what the source
  // actually printed, kept verbatim even when unresolved. Supersede, never overwrite.
  `CREATE TABLE IF NOT EXISTS civic_memberships (
    id INTEGER PRIMARY KEY,
    body_key TEXT NOT NULL REFERENCES civic_bodies(body_key),
    person_name TEXT NOT NULL,
    role TEXT,
    district TEXT,
    party TEXT,
    term_start TEXT,
    term_end TEXT,
    crm_id TEXT,
    puller_id INTEGER,
    email TEXT,
    phone TEXT,
    source_url TEXT,
    source_kind TEXT,
    doc_ref INTEGER,
    confidence REAL DEFAULT 0.5,
    observed_ts INTEGER NOT NULL,
    superseded_by INTEGER,
    UNIQUE(body_key, person_name, role, observed_ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_civic_mem_body ON civic_memberships(body_key, superseded_by)`,
  `CREATE INDEX IF NOT EXISTS idx_civic_mem_crm ON civic_memberships(crm_id)`,

  // SEAT VACANCY — a first-class, CITED seat-state claim (2026-08-14, the LA Senate D14 lesson:
  // the honest answer to "who holds this seat" was NO ONE — incumbent died in office — and the
  // store had no way to say it, so a known-vacant seat was indistinguishable from an unresearched
  // one). NOT a membership row: civic rule 3 says this store owns SEATS, and a vacancy is a seat
  // fact with no person — a fake "VACANT" person would pollute rosters, digests, and the
  // departure logic. `seat` holds the same value civic_memberships.district uses (bare "14"), so
  // the fill-event match is exact-key, never fuzzy. Supersede-never-overwrite lineage within this
  // table; resolved_ts + resolved_by_membership stamp the FILL when a successor membership lands
  // (recordMembership auto-resolves on body+district match — the self-healing wire).
  `CREATE TABLE IF NOT EXISTS civic_vacancies (
    id INTEGER PRIMARY KEY,
    body_key TEXT NOT NULL REFERENCES civic_bodies(body_key),
    seat TEXT NOT NULL,
    vacant_since TEXT,
    reason TEXT,
    successor_note TEXT,
    source_url TEXT,
    source_kind TEXT,
    confidence REAL DEFAULT 0.5,
    observed_ts INTEGER NOT NULL,
    superseded_by INTEGER,
    resolved_ts INTEGER,
    resolved_by_membership INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_civic_vac_body ON civic_vacancies(body_key, superseded_by, resolved_ts)`,

  // DOC CONTACTS — people extracted from SHORT-TERM research documents, so the contacts query can see
  // what her own research already found.
  //
  // The gap this closes (measured 2026-07-20): asked to finish the Louisiana parish rosters she replied
  // "I couldn't pin down specific organization and leadership contact information ... I can go ahead and
  // pull that data together for you now" — offering to research what she already held. gatherHeldContacts
  // read exactly two sources, Puller and CRM, and never the `documents` table, where 390 parish-context
  // docs carried 1,468 individual gov/parish-domain addresses. Structurally invisible, not missing.
  //
  // Every row CITES the document it came from. A contact with no traceable source is worse than none —
  // the whole point is that these are extracted, not verified, and must rank and read that way.
  `CREATE TABLE IF NOT EXISTS doc_contacts (
    id INTEGER PRIMARY KEY,
    email_key TEXT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    title TEXT,
    company TEXT,
    state TEXT,
    doc_id INTEGER NOT NULL,
    doc_title TEXT,
    confidence REAL NOT NULL DEFAULT 0.8,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
  )`,
  // One row per person-per-document: the same official appearing in three documents is three citations of
  // the same fact, and collapsing them at write time would throw away corroboration. The query layer folds
  // them; the store keeps the provenance.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_contacts_uniq ON doc_contacts(doc_id, name, COALESCE(email_key,''))`,
  `CREATE INDEX IF NOT EXISTS idx_doc_contacts_email ON doc_contacts(email_key)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_contacts_state ON doc_contacts(state)`,
  // Scan ledger — which documents have been through extraction, and at what version. Keyed on the
  // document's own updated_ts so an EDITED document is re-extracted while an unchanged one never is
  // (extraction is a model call per chunk; re-running the corpus blindly would be the expensive mistake).
  `CREATE TABLE IF NOT EXISTS doc_contacts_scanned (
    doc_id INTEGER PRIMARY KEY,
    doc_updated_ts INTEGER,
    scanned_ts INTEGER NOT NULL,
    found INTEGER NOT NULL DEFAULT 0,
    chunks INTEGER NOT NULL DEFAULT 0
  )`,

  // INTEREST MODEL (autonomy roadmap, Slice 1) — Zoe's self-directed agenda. A persistent,
  // weighted set of intellectual pursuits the idle loop SAMPLES from, instead of echoing the last
  // conversation. Seeded with a floor of deep domains (source='seed'); 'emergent' interests form
  // from what her own research actually yields. weight = sampling priority (learning-progress ×
  // novelty, gated by a cloud interestingness ranker); lp_ema = EMA of new facts banked on-topic;
  // mastery = rough competence (depth ratchet, later). This is what makes her pursue markets over
  // cheerleading. See lib/interests.js.
  `CREATE TABLE IF NOT EXISTS interests (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    slug TEXT UNIQUE,
    weight REAL DEFAULT 1.0,
    mastery REAL DEFAULT 0.0,
    lp_ema REAL DEFAULT 0.0,
    visits INTEGER DEFAULT 0,
    last_visited_ts INTEGER,
    source TEXT DEFAULT 'seed',
    status TEXT DEFAULT 'active',
    embedding TEXT,
    created_ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_interests_status ON interests(status)`,

  // LEARNING AGENDA (autonomy roadmap, depth ratchet) — open QUESTIONS she means to answer next,
  // per interest. The meta pass generates gap-questions ("what don't I know yet about X that my
  // notes don't cover?"); the idle loop pulls the top open one so a focus works a SPECIFIC unknown
  // (STORM-style depth) instead of re-circling the topic. Answered → linked to the note that closed it.
  `CREATE TABLE IF NOT EXISTS agenda (
    id INTEGER PRIMARY KEY,
    interest_id INTEGER,
    question TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    priority REAL DEFAULT 1.0,
    created_ts INTEGER NOT NULL,
    answered_ts INTEGER,
    answered_note_id INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agenda_interest ON agenda(interest_id, status)`,

  // CURATION OBSERVATION STORE (curation substrate Slice 1; docs/CURATION_SUBSTRATE_DESIGN.md).
  // The durable, cross-feed trail of every GRADED claim the substrate saw — the "observation" leg of
  // the Puller isomorphism (source, source_url, confidence). Every feed (graph-walk, puller, news,
  // doc decomposition …) records here through lib/curation_store, whether the claim PROMOTED to Echo
  // or was HELD (uncited/inferred). This is the home of record for "requires citation": a promotion is
  // provable back to its source, and held candidates queue for later enrichment. Append-only;
  // idempotent on obs_key so a feed re-seeing the same cited claim is a no-op.
  `CREATE TABLE IF NOT EXISTS kg_observations (
    id INTEGER PRIMARY KEY,
    feed TEXT NOT NULL,
    source_entity TEXT NOT NULL,
    relation TEXT,
    target TEXT,
    value TEXT,
    url TEXT,
    grade TEXT,
    confidence REAL,
    kind TEXT,
    status TEXT NOT NULL DEFAULT 'promoted',
    obs_key TEXT NOT NULL UNIQUE,
    captured_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kg_obs_entity ON kg_observations(source_entity, status)`,
  `CREATE INDEX IF NOT EXISTS idx_kg_obs_feed ON kg_observations(feed, captured_at)`,
  // ENTITY TYPE ON OBSERVATIONS (O1). The doc-decompose extractor emits `ENTITY: <name> :: <type>` and
  // the type was thrown away at the store boundary — it existed only in flight, between the extractor
  // and whoever happened to be listening. Two consequences, both measured:
  //   - the TYPE IS PART OF THE IDENTITY KEY in the encounter log, so an observation that fails to
  //     become an encounter loses the only copy of it. It cannot be recovered without re-running the
  //     model over the document.
  //   - nothing downstream could be diagnosed. 736 encounters came out of ~2,947 recent observations
  //     and there was no way to ask which types were being refused, because no type was stored.
  `ALTER TABLE kg_observations ADD COLUMN entity_type TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_kg_observations_entity_type ON kg_observations(entity_type)`,

  // recent_cards — PLACE / EVENT cards surfaced to the canvas People rail (people persist in the Puller;
  // places/events have no other home). Upsert on (type, card_key) so re-seeing one refreshes its recency.
  `CREATE TABLE IF NOT EXISTS recent_cards (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    card_key TEXT NOT NULL,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL,
    UNIQUE(type, card_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recent_cards_ts ON recent_cards(ts)`,
  // CROSS-DB PROMOTE-UP (option 2, Slice 3): mark a local short-term edge that has crossed to Echo's canonical
  // graph, so the nightly promote-up arm never re-sends it (mirrors documents.promoted). Column add first, then
  // the partial index the promote-up candidate scan reads.
  `ALTER TABLE graph_relations ADD COLUMN promoted_up INTEGER DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_graph_relations_promote ON graph_relations(promoted_up, epistemic) WHERE deleted = 0 AND valid_to IS NULL`,
  // THE PROMOTE-UP LEDGER (continuity cure #1, 2026-09-02): the bridge had crossed 20 edges EVER (all
  // 07-11→07-21) against a 20,714-row backlog because the candidate scan ordered by confidence and
  // recorded nothing — the same ~43 uncrossable head edges were retried every night and the ~45% of
  // the backlog that COULD cross never got a turn. Every attempt now leaves its attempt count, its
  // time, and the hold reason on the row; the scan rotates (fewest attempts first) with a backoff
  // that grows per attempt; a crossing stamps promote_last_ts so the memory map's "last crossed"
  // reads a real clock instead of a proxy.
  `ALTER TABLE graph_relations ADD COLUMN promote_attempts INTEGER DEFAULT 0`,
  `ALTER TABLE graph_relations ADD COLUMN promote_last_ts INTEGER`,
  `ALTER TABLE graph_relations ADD COLUMN promote_hold TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_graph_relations_promote_turn ON graph_relations(promoted_up, promote_attempts, promote_last_ts) WHERE deleted = 0 AND valid_to IS NULL`,
  // SUBSTANTIATION SUBSTRATE (docs/SUBSTANTIATION_IMPL_PLAN.md Slice 1, 2026-07-15). Two orthogonal axes
  // every node/observation carries: substantiation_state ∈ {source-vouched,identity-confirmed,unsubstantiated}
  // (decides WHERE it lives — long-term vs short-term prove-or-fade; grade rides as explore-priority) and
  // frame ∈ real|fiction:<work>|domain:<x> (drives the Slice-5 intake wall + Slice-6 fade rate). Nullable +
  // record-only in Slice 1 — nothing gates on them yet. Assigned by lib/substantiation via curation_store.
  `ALTER TABLE kg_observations ADD COLUMN substantiation_state TEXT`,
  `ALTER TABLE kg_observations ADD COLUMN frame TEXT`,
  `ALTER TABLE graph_entities ADD COLUMN substantiation_state TEXT`,
  `ALTER TABLE graph_entities ADD COLUMN frame TEXT`,
  // Phase 3 (prove-or-fade for the node store, 2026-08-04): soft-archive marker. NULL = live; a timestamp =
  // faded (an unsubstantiated node the prove/re-encounter path never lifted, aged past TTL). Retained +
  // restorable (never hard-deleted); substantiation_gate treats archived as non-vouching.
  `ALTER TABLE graph_entities ADD COLUMN archived_at INTEGER`,
  // conversation_state watermark — the last turn folded into the running summary. The summary was
  // updated only from the main say path, but the chat handler has ~30 early returns (protocol
  // intercept, preference answer, contacts route, tool followups) that reply and return before
  // reaching it. Measured 2026-07-20: session 589 had 247 real turns and turn_count=15, and
  // sessions of 116/88/81 turns had no summary at all. A watermark makes the fold catch up over
  // whatever it missed instead of needing a call at all ~30 sites.
  `ALTER TABLE conversation_state ADD COLUMN last_turn_id INTEGER`,

  // SPEECH CLASS (2026-08-12 truth audit): unprompted utterances carry a durable class tag so the
  // two-way voice layer can read ONLY the useful/engaging classes aloud (deliveries, honesty,
  // promises) and leave the template status machinery (qa-reread / tactics / steering) on the
  // ambient rail. Stamped at insertTurn by lib/speech_class (pure, single source of truth).
  `ALTER TABLE turns ADD COLUMN speech_class TEXT`,

  // BROWSER ACTIONS (2026-08-13 — the phantom "Cabinet of the United States" window): the site
  // ledger records at CAPTURE time, so a navigation that dies before its read (reboot kills the
  // headful Chrome, blocked SERP) left ZERO trace — an un-attributable search window on Lucas's
  // screen. This is the NAVIGATION-time breadcrumb: who asked (source), the raw target as the
  // caller passed it, and the URL it resolved to — written BEFORE the goto. Observability only.
  `CREATE TABLE IF NOT EXISTS browser_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT,
    target TEXT,
    url TEXT
  )`
];

function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // Apply idempotent migrations for upgrades from older schemas
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch (e) { /* duplicate column — ignore */ }
  }
  // ONE-TIME REBUILD (census C2, 2026-08-27): older DBs carry the narrow capability_needs CHECK
  // that silently rejected 'blocked_external'/'routed_research' for the triage lane's whole life
  // (the throw was swallowed; the external-needs door's 24h stamp was still NULL). SQLite cannot
  // ALTER a CHECK — detect the old DDL and rebuild in place, preserving rows and ids. Idempotent:
  // the rebuilt table matches the base DDL above, so this never fires twice.
  try {
    const _cnDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='capability_needs'").get();
    if (_cnDdl && _cnDdl.sql && !/blocked_external/.test(_cnDdl.sql)) {
      db.exec(`BEGIN;
        CREATE TABLE capability_needs_rebuild (
          id INTEGER PRIMARY KEY,
          need TEXT NOT NULL,
          born_from TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','rehearsing','proposed','parked','retired','blocked_external','routed_research')),
          created_ts INTEGER NOT NULL,
          updated_ts INTEGER,
          diagnosis TEXT
        );
        INSERT INTO capability_needs_rebuild (id, need, born_from, status, created_ts, updated_ts)
          SELECT id, need, born_from, status, created_ts, updated_ts FROM capability_needs;
        DROP TABLE capability_needs;
        ALTER TABLE capability_needs_rebuild RENAME TO capability_needs;
        COMMIT;`);
      console.log('[db] capability_needs REBUILT — CHECK now admits blocked_external/routed_research (+ diagnosis column); rows preserved');
    }
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('[db] capability_needs rebuild failed:', e.message); }
  // Seed the owner-identity anchor (idempotent) so autonomous lanes recognize the operator across his facets.
  try { seedOwnerIdentity(); } catch {}
}

function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}

function startSession() {
  const info = getDb().prepare('INSERT INTO sessions (started_at) VALUES (?)').run(Date.now());
  return info.lastInsertRowid;
}

// The cross-boot bridge's supply (rolling_context._bridge): the newest real turns from EARLIER
// sessions, oldest-first. The freshness gate (is the newest of these recent enough to bridge?)
// lives in the caller — this just serves the tail.
function prevSessionTail(sessionId, limit = 30) {
  return getDb().prepare(`SELECT id, session_id, ts, speaker, content FROM turns
    WHERE session_id < ? AND speaker IN ('user','ai_said')
    ORDER BY id DESC LIMIT ?`).all(sessionId, limit).reverse();
}

// Navigation-time breadcrumb (see the browser_actions migration). Fail-soft: a logging failure
// must never block a navigation. Pruned to the newest 2000 so the table never becomes a drain.
function recordBrowserAction({ source = null, target = null, url = null } = {}) {
  try {
    const d = getDb();
    const info = d.prepare('INSERT INTO browser_actions (ts, source, target, url) VALUES (?, ?, ?, ?)')
      .run(Date.now(), source, String(target || '').slice(0, 500), String(url || '').slice(0, 1000));
    d.prepare('DELETE FROM browser_actions WHERE id <= ? - 2000').run(info.lastInsertRowid);
    return info.lastInsertRowid;
  } catch { return null; }
}

function endSession(id) {
  if (!id) return;
  getDb().prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);
}

function insertTurn({ sessionId, speaker, content, model = null, truncated = 0, unprompted = 0 }) {
  const ts = Date.now();
  // SPEECH CLASS (2026-08-12): tag unprompted said-turns at write time so the voice layer reads a
  // durable class instead of re-classifying. Prompted turns stay null (they're already the
  // conversation — the voice always carries them). Fail-open: a classifier hiccup stores null.
  let speechClass = null;
  if (unprompted && speaker === 'ai_said') {
    try { speechClass = require('./speech_class').classify(content).cls; } catch {}
  }
  // REPLAY GATE (2026-08-13 live audit): ANY ai_said turn — prompted or not — that near-verbatim
  // repeats a recent ai_said turn is stamped 'replay' (a RAIL class: the voice never re-speaks it,
  // and the stamp is the measurement). The live incidents: the reply writer emitted the qa-reread
  // text, a tactics template ("clean slate…", ×3), and an identity musing verbatim as replies;
  // the unprompted lane resurfaced the same identity thought reworded 95 minutes later. The
  // replay stamp OVERRIDES the pattern class — repeating a SPEAK-class turn is still a replay.
  if (speaker === 'ai_said') {
    try {
      const sc = require('./speech_class');
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const priors = getDb()
        .prepare("SELECT content FROM turns WHERE speaker = 'ai_said' AND ts > ? ORDER BY id DESC LIMIT 12")
        .all(dayAgo).map((r) => r.content);
      if (sc.isReplay(content, priors)) {
        speechClass = 'replay';
        console.log(`[replay-gate] ai_said turn near-verbatim repeats a recent turn → stamped 'replay' (railed from voice): ${String(content).replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    } catch {}
  }
  // DUAL-EMISSION BACKSTOP (run-2b, resurfaced): a VERBATIM say landed twice 5 seconds apart. The
  // replay-gate above only STAMPS near-verbatim repeats for the voice rail — the transcript still
  // took both copies. An IDENTICAL substantive ai_said in the SAME session within 30s is one
  // utterance emitted twice by racing paths, never a real second reply: keep the first, skip the
  // copy, and return the original row so caller refs stay valid. Short says (<40ch, "Done.") pass.
  if (speaker === 'ai_said' && String(content || '').trim().length >= 40) {
    try {
      const dup = getDb()
        .prepare("SELECT id, ts FROM turns WHERE speaker = 'ai_said' AND session_id IS ? AND ts > ? AND content = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId, ts - 30000, content);
      if (dup) {
        console.log(`[turns] dual-emission dedupe — identical say within 30s; kept #${dup.id}, skipped the copy`);
        return { id: dup.id, ts: dup.ts, deduped: true };
      }
    } catch { /* the guard never blocks a real insert */ }
  }
  const info = getDb()
    .prepare('INSERT INTO turns (session_id, ts, speaker, content, model, truncated, unprompted, speech_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, ts, speaker, content, model, truncated, unprompted ? 1 : 0, speechClass);
  // Conversation is boundary traffic (Lucas, 2026-07-22: "graphically show her thinking and communicating").
  // The KG surface draws the short-term store as a bounded region — her mind — so being spoken to and
  // speaking are its two crossings: 'hear' travels in, 'say' travels out. ai_thought turns are NOT tapped
  // here; the inner voice already reaches the surface as 'think' via insertMonologue's throttled tap.
  if (speaker === 'user') _kgTap('hear', String(content || '').slice(0, 110));
  else if (speaker === 'ai_said') _kgTap('say', String(content || '').slice(0, 110));
  return { id: info.lastInsertRowid, ts };
}

function getRecentTurns(n, sessionId = null) {
  // Recent turns, oldest first. When sessionId is given, scope to THAT conversation.
  // The reply-context MUST be session-scoped: interleaved sessions (autonomous musings,
  // a parallel channel, another live conversation) otherwise bleed foreign turns into the
  // window and the model answers the WRONG thread — the 2026-08-19 bleed where an s1188
  // "Louisiana brief / unwinding" conversation contaminated an s1195 "summarize the book"
  // reply (twice, verbatim, because the foreign turns stayed pinned at the top of the
  // global window). Left global (sessionId=null) for the cross-session lanes that want it.
  const rows = sessionId == null
    ? getDb().prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?').all(n)
    : getDb().prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, n);
  return rows.reverse();
}

// This session's USER turns, ASC by id (oldest first) — for the topic-return resolver (lib/topic_stack).
// Ordered so index 0 is the conversationally-FIRST user turn of the session; the last entry is the
// current turn. Cap is generous (sessions are short); the first turn is always included.
function getSessionUserTurns(sessionId, limit = 100) {
  return getDb()
    .prepare(`SELECT id, content FROM turns WHERE session_id = ? AND speaker = 'user' ORDER BY id ASC LIMIT ?`)
    .all(sessionId, Math.max(1, limit | 0));
}

// SPOKEN turns past a watermark, oldest first — the conversation-objects scan (lib/conversation_objects).
// Thoughts are excluded at the query: window gaps are measured on what was actually SAID in the chat.
function turnsAfter(afterId = 0, limit = 4000) {
  return getDb()
    .prepare(`SELECT id, session_id, ts, speaker, content FROM turns WHERE id > ? AND speaker IN ('user','ai_said') ORDER BY id ASC LIMIT ?`)
    .all(Number(afterId) || 0, Math.max(1, limit | 0));
}

// --- episodic recall: turn embeddings (for "what did we say earlier about X") ---
function setTurnEmbedding(id, embedding) {
  getDb().prepare('UPDATE turns SET embedding = ? WHERE id = ?').run(embedding, id);
}
// Persist what the model SAW for a turn (the composed message, not the raw content) — the model_visible
// invariant. Consumed on replay by lib/context._replayUserContent. Fail-soft; bounded (never an unbounded blob).
function setTurnModelVisible(id, text) {
  try { getDb().prepare('UPDATE turns SET model_visible = ? WHERE id = ?').run(String(text == null ? '' : text).slice(0, 24000), id); } catch {}
}
// user + ai_said turns that carry an embedding, newest first, capped (small N → cosine in JS).
function getEmbeddedTurns(limit = 400) {
  return getDb()
    .prepare("SELECT id, speaker, content, ts, embedding FROM turns WHERE embedding IS NOT NULL AND speaker IN ('user','ai_said') ORDER BY id DESC LIMIT ?")
    .all(limit);
}
// recent user/ai_said turns MISSING an embedding (for one-time backfill), newest first.
function getTurnsMissingEmbedding(limit = 300) {
  return getDb()
    .prepare("SELECT id, content FROM turns WHERE embedding IS NULL AND speaker IN ('user','ai_said') ORDER BY id DESC LIMIT ?")
    .all(limit);
}
// NULL-EMBEDDING ROWS across the three stores that embed at write (2026-08-15 deep-dive M3/M7/M11):
// a row written while the embedder was down was INVISIBLE to scored recall (knowledge — including
// verified_facts, so the precedence gate could never fire on them), un-consolidatable but still
// prompt-injected (self_model), or reinforcement-blind (interests) — FOREVER, because only turns
// ever had a backfill. These feed memory.backfillMissingEmbeddings, the turns pattern generalized.
function getKnowledgeMissingEmbedding(limit = 150) {
  return getDb().prepare('SELECT id, content FROM knowledge WHERE embedding IS NULL AND content IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit);
}
function setKnowledgeEmbedding(id, embedding) { getDb().prepare('UPDATE knowledge SET embedding = ? WHERE id = ?').run(embedding, id); }
function getSelfModelMissingEmbedding(limit = 60) {
  return getDb().prepare('SELECT id, content FROM self_model WHERE embedding IS NULL AND content IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit);
}
function setSelfModelEmbedding(id, embedding) { getDb().prepare('UPDATE self_model SET embedding = ? WHERE id = ?').run(embedding, id); }
function getInterestsMissingEmbedding(limit = 60) {
  return getDb().prepare('SELECT id, topic FROM interests WHERE embedding IS NULL AND topic IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit);
}
function setInterestEmbedding(id, embedding) { getDb().prepare('UPDATE interests SET embedding = ? WHERE id = ?').run(embedding, id); }

function getRecentDisplayTurns(n) {
  // user + ai_thought + ai_said — renderer pairs thought with following said
  const rows = getDb()
    .prepare(`SELECT * FROM turns WHERE speaker IN ('user','ai_thought','ai_said') ORDER BY id DESC LIMIT ?`)
    .all(n);
  return rows.reverse();
}

// kg:activity tap — surface a short-term (sq.db) memory write onto the KG activity bus (→ the live log dock).
// Safe-with-no-receiver (global.__emitKgActivity only exists in the Electron main process) + never throws into
// the DB write path. Broadens the log toward "everything that happens in short-term memory".
function _kgTap(kind, anchor, extra) {
  try { const f = global.__emitKgActivity; if (typeof f === 'function') f(Object.assign({ db: 'sidequest', kind, anchor: anchor == null ? '' : String(anchor).slice(0, 120), count: 1 }, extra || {})); } catch (e) {}
}
let _lastThinkEmit = 0;   // kg:activity think throttle — the monologue firehose becomes an ambient pulse, not a strobe
let _lastObserveEmit = 0; // kg:activity 'observe' throttle — decomposeDoc records ~240 rows/doc; see recordKgObservation
function insertMonologue({ content, model = null, feedContext = null, type = 'thought', query = null, urls = null, importance = null, docRef = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO monologue (ts, model, content, feed_context, type, query, urls, importance, doc_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ts, model, content, feedContext ? JSON.stringify(feedContext) : null, type, query, urls ? JSON.stringify(urls) : null, importance, docRef || null);
  // kg:activity — an ambient 'think' heartbeat (she's alive and working). THROTTLED (≥3.5s apart) so the
  // monologue firehose reads as a background pulse, never a per-tick strobe; a varying anchor lets it roam the
  // far-field. Safe-with-no-receiver (global.__emitKgActivity is only set in the Electron main process).
  try {
    if (ts - _lastThinkEmit >= 3500) {
      _lastThinkEmit = ts;
      const f = global.__emitKgActivity;
      if (typeof f === 'function') f({ db: 'sidequest', kind: 'think', anchor: String(info.lastInsertRowid || ts), count: 1 });
    }
  } catch (e) { /* never disturb the write */ }
  return { id: info.lastInsertRowid, ts };
}

function getRecentMonologue(n) {
  const rows = getDb()
    .prepare('SELECT * FROM monologue ORDER BY id DESC LIMIT ?')
    .all(n);
  return rows.reverse();
}

// excludeConsolidated (Phase 2): drop readings already distilled into a knowledge note
// from recency injection — their endpoint is the note, not the raw row. The count/audit
// callers pass nothing (default false) so totals stay complete.
function getRecentMonologueByType(type, n, { excludeConsolidated = false } = {}) {
  const where = excludeConsolidated ? 'type = ? AND COALESCE(consolidated, 0) = 0' : 'type = ?';
  const rows = getDb()
    .prepare(`SELECT * FROM monologue WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(type, n);
  return rows.reverse();
}

// Phase 2: mark readings as distilled into a knowledge note (consolidated → excluded from
// recency injection; distilled_into = the note id, the pointer back). Reading rows only.
function markReadingsConsolidated(ids, knowledgeId = null) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  const info = getDb()
    .prepare(`UPDATE monologue SET consolidated = 1, distilled_into = ? WHERE id IN (${ph}) AND type = 'reading'`)
    .run(knowledgeId, ...list);
  return info.changes;
}

// --- Commitments ---

function insertCommitment({ claim, evidenceTurnIds = [], confidence = 0.7 }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO commitments
      (ts, claim, evidence_turn_ids, confidence, status, first_held_at, last_confirmed_at)
      VALUES (?, ?, ?, ?, 'held', ?, ?)`)
    .run(ts, claim, JSON.stringify(evidenceTurnIds), confidence, ts, ts);
  return { id: info.lastInsertRowid, ts };
}

function getHeldCommitments(limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM commitments WHERE status = 'held' ORDER BY last_confirmed_at DESC LIMIT ?`)
    .all(limit);
}

function getAllCommitments(limit = 100) {
  return getDb()
    .prepare(`SELECT * FROM commitments ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

function reviseCommitment(id, { newClaim, reason, triggeredByTurnId }) {
  const now = Date.now();
  const current = getDb().prepare('SELECT * FROM commitments WHERE id = ?').get(id);
  if (!current) return null;
  const history = current.revision_history ? JSON.parse(current.revision_history) : [];
  history.push({
    ts: now,
    old_claim: current.claim,
    new_claim: newClaim,
    reason,
    triggered_by_turn_id: triggeredByTurnId
  });
  getDb()
    .prepare(`UPDATE commitments
      SET claim = ?, revision_history = ?, last_confirmed_at = ?
      WHERE id = ?`)
    .run(newClaim, JSON.stringify(history), now, id);
  return { id, ts: now };
}

function markCommitmentStatus(id, status, { reason = null, triggeredByTurnId = null } = {}) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT revision_history FROM commitments WHERE id = ?').get(id);
  if (!cur) return null;
  const history = cur.revision_history ? JSON.parse(cur.revision_history) : [];
  history.push({ ts: now, status, reason, triggered_by_turn_id: triggeredByTurnId });
  getDb()
    .prepare(`UPDATE commitments
      SET status = ?, revision_history = ?, last_challenged_at = ?
      WHERE id = ?`)
    .run(status, JSON.stringify(history), now, id);
  return { id, ts: now };
}

function confirmCommitment(id, turnId) {
  const now = Date.now();
  getDb().prepare('UPDATE commitments SET last_confirmed_at = ? WHERE id = ?').run(now, id);
  return { id, ts: now };
}

// --- Open Threads (intentions / goals / tasks the agent is pursuing) ---

function insertOpenThread({ content, parentId = null, sourceTurnId = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO open_threads
      (content, status, parent_id, source_turn_id, created_ts, last_touched_ts)
      VALUES (?, 'pending', ?, ?, ?, ?)`)
    .run(content, parentId, sourceTurnId, ts, ts);
  return { id: info.lastInsertRowid, ts };
}

// Active threads ordered by recency-of-touch; returns oldest-touched first within active
// (so the staler ones rise; the agent's prompt sees what's been neglected)
// includeStalled=true (default) → pending/active/stalled, for DEDUP and cleanup callers that
// must see parked goals. includeStalled=false → pending/active ONLY, for the WORKING set (the
// idle thread-review loop + chat-prompt injection): a STALLED thread means "couldn't progress —
// park it", so re-feeding it as "what you're working on" is exactly the fixation loop (it gets
// re-picked stalest-first and re-ground forever — the cheer-team / Salesforce obsession). Parked
// threads stay in the DB (resurfaceable by an explicit user mention), just not auto-pursued.
// Excludes MERGED CHILDREN (parent_id IS NOT NULL) — a thread linked under another is a duplicate
// phrasing of the same commitment, not a second thing she is carrying. Without this filter one
// request from Lucas showed up in her prompt as 7 separate standing threads.
// The user-thread driver's population (lib/user_work): NEVER-DRIVEN pending threads, NEWEST
// first. Deliberately its own accessor — getActiveOpenThreads orders by last_touched_ts ASC
// (stalest first, for the leash), which INVERTED the driver's recency bias on boot121: the
// 60-row window filled with ancient threads and his newest asks never entered the pool.
function getUnstartedUserThreads(limit = 60) {
  return getDb()
    .prepare(`SELECT * FROM open_threads
      WHERE status = 'pending' AND COALESCE(action_count, 0) = 0 AND parent_id IS NULL
      ORDER BY created_ts DESC LIMIT ?`)
    .all(limit);
}

// `newestFirst` (2026-08-13, the duplicate-thread root): the default ASC order serves the idle
// drain (stalest first) — but as a DEDUP pool it is exactly backwards: a just-minted thread sorts
// LAST, so with >50 open threads the pool never contained the newest siblings, and every rephrase
// minted a duplicate beside the one it should have matched (#3823/25/27, #3826/28, #3867/68).
function getActiveOpenThreads(limit = 10, { includeStalled = true, newestFirst = false } = {}) {
  const statuses = includeStalled ? `('pending','active','stalled')` : `('pending','active')`;
  return getDb()
    .prepare(`SELECT * FROM open_threads
      WHERE status IN ${statuses} AND parent_id IS NULL
      ORDER BY last_touched_ts ${newestFirst ? 'DESC' : 'ASC'} LIMIT ?`)
    .all(limit);
}

// The operator's MOST RECENT live focus threads (newest first) — their standing current work. Used by the
// domain leash (lib/focus.domainLeashTokens) so idle autonomous lanes stay on the CURRENT domain (recent
// Louisiana/parish work), not the oldest stale threads. Returns bare goal strings.
function recentThreadGoals(limit = 15) {
  return getDb()
    .prepare(`SELECT content FROM open_threads
      WHERE status IN ('pending','active','stalled')
      ORDER BY last_touched_ts DESC LIMIT ?`)
    .all(limit).map(r => r.content || '');
}

// Threads that originated from a USER turn — i.e. things Lucas actually ASSIGNED her
// (vs. self-generated goals). The deterministic ground truth for the YOURS/OURS lanes:
// these define "his work." Newest-touched first. (Self-generated threads have no
// user source_turn_id and are excluded → they stay HERS.)
function getUserAssignedThreads(limit = 60) {
  return getDb()
    .prepare(`SELECT ot.* FROM open_threads ot
      JOIN turns t ON t.id = ot.source_turn_id
      WHERE t.speaker = 'user'
      ORDER BY ot.last_touched_ts DESC LIMIT ?`)
    .all(limit);
}

// The freshest PENDING thread Lucas actually assigned (from a user turn) within maxAgeMs — the anchor
// for a bare greenlight ("Begin." / "yes do it") that commits an on-the-table task he red-tagged but
// that was never spun up into a directed focus. Newest-touched first; null if none in-window. This is
// what lets "Begin." actually begin the parish research instead of the heartbeat answering it.
function pendingUserAssignedThread(maxAgeMs = 45 * 60 * 1000) {
  const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
  return getDb()
    .prepare(`SELECT ot.* FROM open_threads ot
      JOIN turns t ON t.id = ot.source_turn_id
      WHERE t.speaker = 'user' AND ot.status = 'pending' AND ot.last_touched_ts >= ?
      ORDER BY ot.last_touched_ts DESC LIMIT 1`)
    .get(cutoff) || null;
}

function getAllOpenThreads(limit = 200) {
  return getDb()
    .prepare(`SELECT * FROM open_threads ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

function getOpenThread(id) {
  return getDb().prepare('SELECT * FROM open_threads WHERE id = ?').get(id);
}

// Link a thread under another as a duplicate PHRASING of the same commitment (thread adoption —
// see open_threads.matchCarriedThread). Deliberately does NOT change status: marking a duplicate
// 'resolved' would claim work that never happened. The child keeps its own lifecycle; it simply
// stops standing as a separate commitment in the prompt (getActiveOpenThreads filters children).
// Guards against self-parenting and against re-parenting something that already has a parent.
function setOpenThreadParent(id, parentId) {
  if (!id || !parentId || Number(id) === Number(parentId)) return null;
  getDb().prepare('UPDATE open_threads SET parent_id = ? WHERE id = ? AND parent_id IS NULL').run(parentId, id);
  return { id, parentId };
}

// ONE OPEN SELF-DIRECTED THREAD AT A TIME (boot133): the synthesis re-derives one tension in
// fresh wording faster than any lexical ledger catches it (three paraphrases of the Georgia
// county-boards gap in one evening; token overlap ~0.3 against a 0.6 gate), so the throttle is
// behavioral — while a spawned thread of this source is still open, the next spawn defers, and
// her spawn rate is bounded by her completion rate. Stalled threads are PARKED, not open: a
// spawn throttles to completion, never to failure.
function getOpenSpawnedThread(source) {
  return getDb().prepare(`
    SELECT t.* FROM open_threads t
    JOIN meta m ON m.key = 'thread.' || t.id || '.spawned_from' AND m.value = ?
    WHERE t.status IN ('pending','active') AND t.parent_id IS NULL
    ORDER BY t.id ASC LIMIT 1`).get(String(source));
}

function markOpenThreadStatus(id, status, { reason = null } = {}) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT progress_notes FROM open_threads WHERE id = ?').get(id);
  if (!cur) return null;
  const notes = cur.progress_notes ? JSON.parse(cur.progress_notes) : [];
  notes.push({ ts: now, status, reason });
  const isResolved = status === 'resolved' || status === 'abandoned';
  if (isResolved) {
    getDb()
      .prepare(`UPDATE open_threads
        SET status = ?, progress_notes = ?, last_touched_ts = ?, resolved_ts = ?
        WHERE id = ?`)
      .run(status, JSON.stringify(notes), now, now, id);
  } else {
    getDb()
      .prepare(`UPDATE open_threads
        SET status = ?, progress_notes = ?, last_touched_ts = ?
        WHERE id = ?`)
      .run(status, JSON.stringify(notes), now, id);
  }
  return { id, ts: now };
}

function touchOpenThread(id, note = null, { keepStatus = false } = {}) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT progress_notes, status FROM open_threads WHERE id = ?').get(id);
  if (!cur) return null;
  const notes = cur.progress_notes ? JSON.parse(cur.progress_notes) : [];
  if (note) notes.push({ ts: now, progress: note });
  // pending → active on first touch. keepStatus (2026-08-15 deep-dive R2): a lane STAMP is
  // metadata, not work start — stamping used to flip pending→active, which silently removed the
  // thread from the seed pool forever (getUnstartedUserThreads selects pending only), making a
  // misclassified thread LESS recoverable than before typed routing existed.
  const newStatus = (!keepStatus && cur.status === 'pending') ? 'active' : cur.status;
  // B3 (2026-08-15 deep-dive): action_count was near-dead — its only writer was the model-emitted
  // [thread-progress:N] tag, so every driver that actually WORKED threads (directed research, the
  // beat driver, user-work) never incremented it and the curator's "over-pursued" retirement could
  // never fire. A touch WITH a progress note is an action; a bare touch / lane stamp is not.
  getDb()
    .prepare(`UPDATE open_threads
      SET status = ?, progress_notes = ?, last_touched_ts = ?, action_count = COALESCE(action_count, 0) + ?
      WHERE id = ?`)
    .run(newStatus, JSON.stringify(notes), now, note ? 1 : 0, id);
  return { id, ts: now };
}

function incrementThreadMention(id) {
  getDb().prepare('UPDATE open_threads SET mention_count = mention_count + 1 WHERE id = ?').run(id);
}

// --- Open Questions (QUD/grounding: questions SHE asked that await an answer) ---
function insertOpenQuestion({ sessionId, question, askedTurnId = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO open_questions (session_id, question, asked_turn_id, status, created_ts)
      VALUES (?, ?, ?, 'pending', ?)`)
    .run(sessionId, question, askedTurnId, ts);
  return { id: info.lastInsertRowid, ts };
}
// Pending questions for a session, newest first, within a recency floor (a question past
// its moment shouldn't resurface). Small N — surfaced as a high-recency prompt block.
function getPendingOpenQuestions(sessionId, { maxAgeMs = 30 * 60 * 1000, limit = 2 } = {}) {
  const floor = Date.now() - maxAgeMs;
  return getDb()
    .prepare(`SELECT * FROM open_questions
      WHERE session_id = ? AND status = 'pending' AND created_ts >= ?
      ORDER BY created_ts DESC LIMIT ?`)
    .all(sessionId, floor, limit);
}
// Close all pending questions for a session (called once they've been surfaced on a user
// reply) — binds them to the answering turn so the lifecycle is auditable.
function resolveOpenQuestions(sessionId, { answerTurnId = null, status = 'answered' } = {}) {
  const now = Date.now();
  const info = getDb()
    .prepare(`UPDATE open_questions SET status = ?, answer_turn_id = ?, resolved_ts = ?
      WHERE session_id = ? AND status = 'pending'`)
    .run(status, answerTurnId, now, sessionId);
  return info.changes;
}

// --- Conversation state (running "where we are now" summary, per session) ---
function getConversationState(sessionId) {
  return getDb().prepare('SELECT * FROM conversation_state WHERE session_id = ?').get(sessionId);
}
// Upsert the running summary. turnCount null → auto-increment on update, 0 on first insert.
// lastTurnId is the WATERMARK — the highest turn id folded in — so the next fold knows where to
// resume rather than assuming it saw every exchange (it did not; see the migration note).
function upsertConversationState(sessionId, summary, turnCount = null, lastTurnId = null) {
  const now = Date.now();
  getDb().prepare(`INSERT INTO conversation_state (session_id, summary, turn_count, updated_ts, last_turn_id)
      VALUES (?, ?, COALESCE(?, 0), ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        summary = excluded.summary,
        turn_count = COALESCE(?, conversation_state.turn_count + 1),
        updated_ts = excluded.updated_ts,
        last_turn_id = COALESCE(excluded.last_turn_id, conversation_state.last_turn_id)`)
    .run(sessionId, summary, turnCount, now, lastTurnId, turnCount);
  return { sessionId, ts: now };
}

// Turns in this session NEWER than the watermark — the exchanges the summary has not folded yet.
// Bounded: a long unfolded stretch is summarised from its most recent slice rather than replaying
// the whole session into a model call.
function unfoldedTurns(sessionId, afterTurnId = 0, limit = 40) {
  return getDb().prepare(
    `SELECT id, speaker, content FROM turns
      WHERE session_id = ? AND id > ? AND speaker IN ('user','ai_said')
      ORDER BY id ASC LIMIT ?`)
    .all(sessionId, afterTurnId || 0, limit);
}

// Merge a child thread INTO a parent (umbrella) — the consolidation primitive.
// Non-destructive: the child row is kept, marked 'abandoned' (so it drops out of
// the active set), linked to the parent via parent_id, and its mention/action
// weight is transferred to the parent. A progress note records merged_into for
// reversibility. Returns null if either id is missing.
function mergeOpenThread(childId, parentId, { reason = 'merged (consolidation)' } = {}) {
  const child = getOpenThread(childId);
  const parent = getOpenThread(parentId);
  if (!child || !parent || childId === parentId) return null;
  const now = Date.now();
  getDb()
    .prepare('UPDATE open_threads SET mention_count = mention_count + ?, action_count = action_count + ? WHERE id = ?')
    .run(child.mention_count || 0, child.action_count || 0, parentId);
  const notes = child.progress_notes ? JSON.parse(child.progress_notes) : [];
  notes.push({ ts: now, status: 'merged', reason, merged_into: parentId });
  getDb()
    .prepare(`UPDATE open_threads SET status = 'abandoned', parent_id = ?, progress_notes = ?, last_touched_ts = ?, resolved_ts = ? WHERE id = ?`)
    .run(parentId, JSON.stringify(notes), now, now, childId);
  return { childId, parentId, ts: now };
}

function incrementThreadAction(id) {
  const now = Date.now();
  getDb()
    .prepare('UPDATE open_threads SET action_count = action_count + 1, last_touched_ts = ? WHERE id = ?')
    .run(now, id);
}

function getRecentReflections(n) {
  const rows = getDb()
    .prepare('SELECT * FROM reflections ORDER BY id DESC LIMIT ?')
    .all(n);
  return rows.reverse();
}

// Single reflection by id — for the <recall ref="rID"/> memory-marker expansion.
function getReflectionById(id) {
  return getDb().prepare('SELECT * FROM reflections WHERE id = ?').get(id) || null;
}

function insertReflection({ promptUsed, content, sourceTurnStart, sourceTurnEnd, model = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO reflections (ts, prompt_used, content, source_turn_start, source_turn_end, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ts, promptUsed, content, sourceTurnStart, sourceTurnEnd, model);
  _kgTap('reflect', content);
  return { id: info.lastInsertRowid, ts };
}

function getTurnsSinceId(turnId) {
  return getDb()
    .prepare('SELECT * FROM turns WHERE id > ? ORDER BY id ASC')
    .all(turnId);
}

// --- Protocols (durable user-AI negotiated agreements) ---

function insertProtocol({ category, triggerPhrase = null, action = null, description, sourceTurnIds = [] }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO protocols
      (category, trigger_phrase, action, description, source_turn_ids, established_ts, last_confirmed_ts, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`)
    .run(category, triggerPhrase, action, description, JSON.stringify(sourceTurnIds), ts, ts);
  return { id: info.lastInsertRowid, ts };
}

function getActiveProtocols() {
  return getDb()
    .prepare(`SELECT * FROM protocols WHERE status = 'active' ORDER BY category, id`)
    .all();
}

function getProtocolByTrigger(phrase) {
  if (!phrase) return null;
  return getDb()
    .prepare(`SELECT * FROM protocols WHERE status = 'active' AND lower(trigger_phrase) = lower(?) LIMIT 1`)
    .get(phrase);
}

function confirmProtocol(id) {
  const now = Date.now();
  getDb().prepare('UPDATE protocols SET last_confirmed_ts = ? WHERE id = ?').run(now, id);
  return { id, ts: now };
}

function invokeProtocol(id) {
  const now = Date.now();
  getDb()
    .prepare('UPDATE protocols SET last_invoked_ts = ?, invoke_count = invoke_count + 1, last_confirmed_ts = ? WHERE id = ?')
    .run(now, now, id);
  return { id, ts: now };
}

function revokeProtocol(id) {
  getDb().prepare(`UPDATE protocols SET status = 'revoked' WHERE id = ?`).run(id);
  return { id };
}

// --- Permissions (the authoritative grant list) ---

// Seed a capability if absent (won't clobber a status Lucas later changed).
function seedPermission({ capability, status = 'granted', description, how = null }) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO permissions (capability, status, description, how, updated_ts) VALUES (?,?,?,?,?)`)
    .run(capability, status, description, how, Date.now());
}

// Explicitly change a capability's status (grant/deny/ask). Upserts if new.
function setPermission(capability, status, { description = null, how = null } = {}) {
  const existing = getDb().prepare('SELECT id FROM permissions WHERE capability = ?').get(capability);
  if (existing) {
    getDb().prepare('UPDATE permissions SET status = ?, updated_ts = ? WHERE capability = ?').run(status, Date.now(), capability);
  } else {
    getDb().prepare(`INSERT INTO permissions (capability, status, description, how, updated_ts) VALUES (?,?,?,?,?)`)
      .run(capability, status, description || capability, how, Date.now());
  }
  return { capability, status };
}

function getAllPermissions() {
  return getDb()
    .prepare(`SELECT * FROM permissions ORDER BY CASE status
                WHEN 'granted' THEN 0 WHEN 'granted_with_judgment' THEN 1
                WHEN 'ask_first' THEN 2 ELSE 3 END, capability`)
    .all();
}

function getPermission(capability) {
  return getDb().prepare('SELECT * FROM permissions WHERE capability = ? LIMIT 1').get(capability);
}

// --- Inbound messages (queued chat-bot replies awaiting consumption) ---

function insertInbound({ tabUrl, speaker = null, text, messageIndex = null, source = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO inbound_messages
      (tab_url, speaker, text, message_index, received_ts, source)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tabUrl, speaker, text, messageIndex, ts, source);
  return { id: info.lastInsertRowid, ts };
}

function getPendingInbounds(limit = 8) {
  return getDb()
    .prepare(`SELECT * FROM inbound_messages WHERE consumed_ts IS NULL ORDER BY received_ts ASC LIMIT ?`)
    .all(limit);
}

function markInboundConsumed(id) {
  const now = Date.now();
  getDb().prepare('UPDATE inbound_messages SET consumed_ts = ? WHERE id = ?').run(now, id);
  return { id, ts: now };
}

function markAllInboundsConsumed() {
  const now = Date.now();
  const info = getDb()
    .prepare('UPDATE inbound_messages SET consumed_ts = ? WHERE consumed_ts IS NULL')
    .run(now);
  return { ts: now, changed: info.changes };
}

// Sum of completed session durations + current open session age (ms).
// Used for the "you've been awake X hours total" awareness block.
function getCumulativeSessionTime() {
  const rows = getDb()
    .prepare('SELECT started_at, ended_at FROM sessions')
    .all();
  const now = Date.now();
  let total = 0;
  for (const r of rows) {
    const end = r.ended_at || now;  // open session counts up to now
    if (r.started_at && end > r.started_at) total += (end - r.started_at);
  }
  return total;
}

// --- Scheduled tasks (Zoe's self-scheduling clock) ---

function insertScheduledTask({ kind = 'once', note, fireAt, intervalMs = null, source = 'zoe' }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO scheduled_tasks
      (kind, note, fire_at, interval_ms, status, source, created_ts, fire_count)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)`)
    .run(kind, note, fireAt, intervalMs, source, ts);
  return { id: info.lastInsertRowid, ts };
}

function getDueScheduledTasks(now = Date.now()) {
  return getDb()
    .prepare(`SELECT * FROM scheduled_tasks WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC`)
    .all(now);
}

function getPendingScheduledTasks(limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM scheduled_tasks WHERE status = 'pending' ORDER BY fire_at ASC LIMIT ?`)
    .all(limit);
}

// Atomically claim a 'once' task for firing. Two tickers (scheduler.js + main.js)
// can both observe the same due task via getDueScheduledTasks (a non-atomic
// SELECT-then-UPDATE), which would double-fire it. This flips status pending→fired
// in a single statement and returns true ONLY for the caller that won the race
// (info.changes === 1). Callers gate their fire side-effects on this. Recurring
// re-arm stays in markScheduledFired (which is itself made claim-safe below).
function claimScheduledTask(id) {
  const now = Date.now();
  const info = getDb()
    .prepare(`UPDATE scheduled_tasks SET status = 'fired', last_fired_ts = ?, fire_count = fire_count + 1 WHERE id = ? AND status = 'pending'`)
    .run(now, id);
  return info.changes === 1;
}

// Mark a task fired. For 'recurring' tasks re-arm fire_at to the next interval
// boundary in the future (skipping any missed windows while the app was down).
// The status flip / re-arm is guarded by `status IN ('pending','fired')` so that
// concurrent tickers can't double-process a task that another already claimed
// (a cancelled task in particular is never resurrected). When the guard loses
// (info.changes === 0) we return rearmed/fired = null so callers can tell.
function markScheduledFired(id) {
  const now = Date.now();
  const t = getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  if (!t) return null;
  if (t.kind === 'recurring' && t.interval_ms && t.interval_ms > 0) {
    let next = t.fire_at + t.interval_ms;
    while (next <= now) next += t.interval_ms;
    const info = getDb()
      .prepare(`UPDATE scheduled_tasks SET fire_at = ?, last_fired_ts = ?, fire_count = fire_count + 1 WHERE id = ? AND status IN ('pending','fired')`)
      .run(next, now, id);
    return { id, ts: now, rearmedFor: info.changes === 1 ? next : null };
  }
  const info = getDb()
    .prepare(`UPDATE scheduled_tasks SET status = 'fired', last_fired_ts = ?, fire_count = fire_count + 1 WHERE id = ? AND status IN ('pending','fired')`)
    .run(now, id);
  return { id, ts: now, rearmedFor: null, fired: info.changes === 1 };
}

function cancelScheduledTask(id) {
  const info = getDb()
    .prepare(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return { id, cancelled: info.changes > 0 };
}

// --- Email log (audit trail + daily-cap backstop) ---

function insertEmailLog({ to, subject, status, error = null, source = 'zoe' }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO email_log (ts, to_addr, subject, status, error, source) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(ts, to, subject, status, error, source);
  return { id: info.lastInsertRowid, ts };
}

function countEmailsSentSince(sinceTs) {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM email_log WHERE status = 'sent' AND ts >= ?`)
    .get(sinceTs);
  return row ? row.n : 0;
}

// Has she already sent mail to this address? Gates autonomous reply: she only
// auto-continues threads she's part of, never cold-replies to unknown senders.
// EXACT case-insensitive match (not substring) — a substring LIKE is spoofable
// by lookalikes (a@b.com would match a@b.com.evil.com). to_addr is stored as the
// raw `to` passed to sendEmail, which is a bare address in the autonomous path;
// we also match the angle-bracket-extracted form ("Name <a@b.com>") defensively.
function hasEmailedAddress(addr) {
  if (!addr) return false;
  const norm = String(addr).trim().toLowerCase();
  if (!norm) return false;
  const row = getDb()
    .prepare(`SELECT 1 FROM email_log
      WHERE status = 'sent'
        AND (LOWER(to_addr) = ?
          OR LOWER(TRIM(SUBSTR(to_addr, INSTR(to_addr, '<') + 1, INSTR(to_addr, '>') - INSTR(to_addr, '<') - 1))) = ?)
      LIMIT 1`)
    .get(norm, norm);
  return !!row;
}

// --- Knowledge store (integration/learning layer) ---

function insertKnowledge({ kind = 'note', content, embedding = null, source = null, importance = 0.5, links = null, provenance = null, level = 'fact', parentId = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO knowledge (kind, content, embedding, source, importance, created_ts, links, provenance, level, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, content, embedding, source, importance, ts, links ? JSON.stringify(links) : null, provenance ? JSON.stringify(provenance) : null, level, parentId);
  const id = info.lastInsertRowid;
  try { getDb().prepare('INSERT INTO knowledge_fts(rowid, content) VALUES (?, ?)').run(id, content); } catch {}
  _kgTap('note', '[' + kind + '] ' + String(content || ''));
  return { id, ts };
}

// --- Documents (short-term landing store) ---
// Whole new material lands here durably the moment it arrives; the nightly pass promotes it to Echo
// long-term. parentId/version carry the iteration model (an update = a new iteration of the original).

function insertDocument({ title = null, body, source = null, ref = null, understanding = null, parentId = null, version = 1, origin = null, fetchUrl = null, importance = null }) {
  if (!body || !String(body).trim()) return null;
  const ts = Date.now();
  // ORIGIN + CONTENT IDENTITY. The hash is computed HERE, never accepted from a caller — it is a fact
  // about the bytes and must not be forgeable or forgettable at a call site. `origin` is normalised so
  // two links to the same page with different campaign tags collapse to one origin rather than two.
  let _origin = null, _host = null, _hash = null, _fetch = null;
  try {
    const og = require('./origin');
    _origin = origin ? og.normalizeUrl(origin) : null;
    _host = _origin ? og.hostOf(_origin) : null;
    _fetch = fetchUrl ? og.normalizeUrl(fetchUrl) : null;
    // A single-URL caller still gets the rule applied: if the only URL it has is a CDN, that is where
    // the bytes were, not who published — record it as such rather than letting it pose as the origin.
    if (_origin && !fetchUrl && og.isCommodityHost(_host)) { _fetch = _origin; }
    _hash = og.contentHash(body);
  } catch (e) { console.error('[db] origin capture failed:', e.message); }
  const info = getDb()
    .prepare(`INSERT INTO documents (title, body, source, ref, understanding, parent_id, version, promoted, created_ts, updated_ts, origin, origin_host, content_hash, fetch_url, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
    .run(title, String(body), source, ref, understanding, parentId, version, ts, ts, _origin, _host, _hash, _fetch, importance);
  _kgTap('doc.land', title || ref || ('#' + info.lastInsertRowid));
  return { id: info.lastInsertRowid, ts };
}

// Latest document row for an external ref (idempotent landing + iteration parent lookup). Newest first.
function getDocumentByRef(ref) {
  if (!ref) return null;
  // A live row wins over a superseded one: landing must never hand a caller an id that has been merged away.
  return getDb().prepare('SELECT * FROM documents WHERE ref = ? ORDER BY (superseded_by IS NULL) DESC, id DESC LIMIT 1').get(ref) || null;
}

// The SAME TEXT already landed, under any ref or lane. The hash is computed here from the body rather
// than taken from a caller, exactly as insertDocument does, so the two can never disagree about what
// counts as identical. Oldest wins — the first encounter is the one that keeps the id everything else
// already cites.
function getDocumentByHash(body) {
  try {
    const h = require('./origin').contentHash(body);
    if (!h) return null;
    return getDb().prepare('SELECT * FROM documents WHERE content_hash = ? AND superseded_by IS NULL ORDER BY id ASC LIMIT 1').get(h) || null;
  } catch (e) { return null; }
}

function getDocument(id) {
  if (!id) return null;
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
}

// SUPERSEDED ROWS ARE INVISIBLE TO READS. 806 documents are byte-identical copies merged onto a
// canonical row; they are kept so the merge stays invertible, not so they can come back through recall.
// Without this filter the merge would only half-work — citations resolve correctly, but doc-QA and
// search would still hand back the same text several times, which is the duplication the merge removed.
// getDocument(id) deliberately does NOT filter: an old id must still resolve, or existing links break.
const LIVE = 'superseded_by IS NULL';

// Recent documents, newest first. opts.unpromotedOnly limits to short-term (not yet consolidated).
// One stored document by id — the [dN] recall-marker resolver (lib/recall) and any doc_ref consumer.
function getDocumentById(id) {
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(Number(id) || 0) || null;
}

function recentDocuments(n = 20, { unpromotedOnly = false } = {}) {
  const where = unpromotedOnly ? `WHERE promoted = 0 AND ${LIVE}` : `WHERE ${LIVE}`;
  return getDb().prepare(`SELECT * FROM documents ${where} ORDER BY id DESC LIMIT ?`).all(Math.max(1, n | 0));
}

// Spine 4 / C3 — the reflection-worthy LANDED documents: un-reflected (id > cursor) high-importance (C1's
// documents.importance ≥ minImportance) material, newest first, capped. These are what the significance
// reflection should synthesize OVER (alongside recent thoughts/readings), so a day of landing deliverables
// and meeting notes produces beliefs, not just the thought-stream. Returns lightweight rows (title +
// understanding + origin, NOT the full body — reflection reads the gist, and origins are the grounding).
function getReflectionWorthyDocuments({ sinceId = 0, minImportance = 6, limit = 5 } = {}) {
  return getDb().prepare(
    `SELECT id, title, understanding, source, origin, importance FROM documents
     WHERE id > ? AND importance >= ? AND ${LIVE} ORDER BY id DESC LIMIT ?`
  ).all(Math.max(0, sinceId | 0), Math.max(1, minImportance | 0), Math.max(1, limit | 0));
}

// Un-promoted documents for the promotion pass (Slice 2). FAIR-SHARE across sources so NO LANE
// STARVES — "we leave nothing behind" (Lucas, 2026-07-25).
//
// Why not plain id-ASC (measured 2026-07-25): a global FIFO starves every young/low-volume lane
// behind the bulk. The store held ~5,300 unpromoted docs; the promotion pointer sat at id ~4270
// while the oldest conversation was id 8085 (3,879 bulk docs ahead ≈ 194 days out). Result across
// lanes: conversation 152 landed / 0 promoted, inquiry 155/0, meeting 9/0, research 59 pending,
// while browser_download (460/day inflow) and news dominated the head of the queue.
//
// Fair-share = round-robin: rank each source's own backlog oldest-first (ROW_NUMBER per source),
// then take rank 1 from EVERY source before any source's rank 2. So one pass advances all ~13 lanes,
// not just whoever holds the oldest ids. Within a rank the MEMORY-EVENT classes (conversation /
// meeting) go first — conversation_objects.js calls that landing "the memory event". A high-volume
// lane (browser_download) still gets exactly its one-per-round share, so it can't crowd the others
// out; its own backlog is a separate throughput/triage question, not a starvation of the rest.
// The promote scan — round-robin across sources (each lane's oldest first, memory-event classes lead the
// round), and since continuity cure #3 a doc that failed steps aside for a backoff that doubles per
// attempt (1d, 2d, 4d … 30d) while untried docs of its lane go first. Nothing is dropped: a failed doc
// simply comes back after its backoff.
const DOC_PROMOTE_BACKOFF_DAY_MS = 24 * 60 * 60 * 1000;
const _DOC_PROMOTE_ELIGIBLE = `(promote_last_ts IS NULL OR promote_last_ts + MIN(@day * (1 << MIN(MAX(COALESCE(promote_attempts, 1), 1) - 1, 5)), @day * 30) <= @now)`;
// THE FREEZE (2026-09-03 01:24, the 73-minute generation that ended "not responding"): the window-function
// form of this scan sorted EVERY unpromoted row (38k) in a temp B-tree — 4.7s on the main thread each
// 15-min beat (stall-attrib: "promote-docs" 6,136ms). Now each lane's head is one range scan over the
// partial index (source, promote_attempts, id) — LIMIT stops at the lane's first eligible rows — and the
// round-robin merge (rank, memory-event classes first, id) is done in JS. Same contract, same order.
const _MEMORY_EVENT_SOURCES = new Set(['conversation', 'meeting', 'meeting_transcript']);
function listUnpromotedDocuments(limit = 100, { now = Date.now() } = {}) {
  const d = getDb();
  const lim = Math.max(1, limit | 0);
  // the lanes present, by MANUAL SKIP-SCAN over the same index (one seek per lane, microseconds) — a
  // GROUP BY walked all 38k index entries: 456ms on the main thread, measured on boot_p254
  const sources = [];
  if (d.prepare(`SELECT 1 FROM documents INDEXED BY idx_documents_promote_source WHERE promoted = 0 AND ${LIVE} AND source IS NULL LIMIT 1`).get()) sources.push(null);
  const nextLane = d.prepare(`SELECT source FROM documents INDEXED BY idx_documents_promote_source WHERE promoted = 0 AND ${LIVE} AND source > @last ORDER BY source LIMIT 1`);
  let lane = d.prepare(`SELECT source FROM documents INDEXED BY idx_documents_promote_source WHERE promoted = 0 AND ${LIVE} AND source IS NOT NULL ORDER BY source LIMIT 1`).get();
  while (lane && sources.length < 64) { sources.push(lane.source); lane = nextLane.get({ last: lane.source }); }
  const head = d.prepare(
    `SELECT * FROM documents INDEXED BY idx_documents_promote_source WHERE promoted = 0 AND ${LIVE} AND source IS @s AND ${_DOC_PROMOTE_ELIGIBLE}
      ORDER BY promote_attempts ASC, id ASC LIMIT @limit`);
  const rows = [];
  for (const s of sources) {
    head.all({ s, day: DOC_PROMOTE_BACKOFF_DAY_MS, now, limit: lim }).forEach((r, i) => { r._rr = i + 1; rows.push(r); });
  }
  const cls = (src) => (_MEMORY_EVENT_SOURCES.has(src) ? 0 : 1);
  rows.sort((a, b) => (a._rr - b._rr) || (cls(a.source) - cls(b.source)) || (a.id - b.id));
  return rows.slice(0, lim);
}
// One promotion attempt that failed: count it, stamp it, keep the error (sliced) — the backoff reads the
// count, the tee and the memory map read the error histogram.
function notePromoteFailure(id, error, { now = Date.now() } = {}) {
  if (!id) return false;
  getDb().prepare('UPDATE documents SET promote_attempts = COALESCE(promote_attempts, 0) + 1, promote_last_ts = ?, promote_error = ? WHERE id = ?')
    .run(now, error == null ? null : String(error).slice(0, 120), id);
  return true;
}
// The documents backlog's shape for the tee: how many wait, how many are eligible now, the top errors.
function promoteDocsBacklog({ now = Date.now() } = {}) {
  const d = getDb();
  const pending = d.prepare(`SELECT COUNT(*) n FROM documents WHERE promoted = 0 AND ${LIVE}`).get().n;
  const eligible = d.prepare(`SELECT COUNT(*) n FROM documents WHERE promoted = 0 AND ${LIVE} AND ${_DOC_PROMOTE_ELIGIBLE}`).get({ day: DOC_PROMOTE_BACKOFF_DAY_MS, now }).n;
  const errors = d.prepare(`SELECT substr(promote_error, 1, 60) error, COUNT(*) n FROM documents WHERE promoted = 0 AND ${LIVE} AND promote_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 4`).all();
  return { pending, eligible, backingOff: pending - eligible, errors };
}

// Keyword search over title+body. Newest first.
// FTS-FIRST (slow-scan pair, 2026-08-27): the bare LIKE '%q%' walks the 1.35GB body corpus — the
// slow-sync probe caught it at 1.8s on the main thread (db.js:2045, the stall stratum's second
// face) — while documents_fts (already built + watermark-synced) answers the same ask in ~2ms.
// Tokens are quoted so hyphenated terms (co-sponsors, SB25-200) keep phrase semantics rather than
// tripping FTS5's column-filter grammar (the Echo search_entities lesson, e525668). Word-boundary
// matching is also the wanted semantics (the atlANTIc-never-matches-'anti' rule). Zero FTS hits or
// any FTS error falls through to the original LIKE — availability never changes, only speed.
function searchDocuments(queryLike, n = 10) {
  const raw = String(queryLike || '').trim();
  const lim = Math.max(1, n | 0);
  if (raw && documentsFtsReady()) {
    try {
      const match = (raw.match(/[^\s]+/g) || []).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (match) {
        const rows = getDb().prepare(
          `SELECT d.* FROM documents_fts f JOIN documents d ON d.id = f.rowid
            WHERE documents_fts MATCH ? AND d.${LIVE} ORDER BY d.id DESC LIMIT ?`).all(match, lim);
        if (rows.length) return rows;
      }
    } catch (e) { try { console.error('[documents_fts] search fell back to LIKE:', e && e.message); } catch {} }
  }
  const q = `%${raw}%`;
  return getDb().prepare(`SELECT * FROM documents WHERE (title LIKE ? OR body LIKE ?) AND ${LIVE} ORDER BY id DESC LIMIT ?`).all(q, q, lim);
}

// Mark a document consolidated into Echo long-term (promotedRef = where it landed, e.g. an Echo doc_id).
function markDocumentPromoted(id, promotedRef = null) {
  if (!id) return false;
  getDb().prepare('UPDATE documents SET promoted = 1, promoted_ref = ?, updated_ts = ? WHERE id = ?').run(promotedRef, Date.now(), id);
  return true;
}

// Promoted documents (for the retention pass), oldest first.
function listPromotedDocuments(limit = 200) {
  return getDb().prepare('SELECT * FROM documents WHERE promoted = 1 ORDER BY id ASC LIMIT ?').all(Math.max(1, limit | 0));
}

// Retention: trim a promoted doc's body down to a pointer (the full text now lives in Echo long-term).
function trimDocumentBody(id, body) {
  if (!id) return false;
  getDb().prepare('UPDATE documents SET body = ?, updated_ts = ? WHERE id = ?').run(String(body || ''), Date.now(), id);
  return true;
}

// Retention: drop a short-term document outright (skip-marked / never reached Echo).
function deleteDocument(id) {
  if (!id) return false;
  getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
  return true;
}

// Phase 3: rewrite a knowledge note in place (Mem0 UPDATE/merge) — content + its
// embedding + FTS index, bumping last_used_ts. Used when a new takeaway AUGMENTS an
// existing one rather than duplicating it, so one topic doesn't pile up near-dup rows.
function updateKnowledge(id, { content, embedding = null, importance = null, clearEmbedding = false } = {}) {
  if (!id || !content || !String(content).trim()) return false;
  const now = Date.now();
  const sets = ['content = ?', 'last_used_ts = ?'];
  const args = [String(content).trim(), now];
  if (embedding != null) { sets.push('embedding = ?'); args.push(embedding); }
  // clearEmbedding (deep-dive M9): when a merge's re-embed FAILED, preserving the old vector
  // leaves a stale embedding under new content — scored recall drifts silently. NULL it instead;
  // the idle backfill re-embeds the row honestly.
  else if (clearEmbedding) sets.push('embedding = NULL');
  if (importance != null) { sets.push('importance = ?'); args.push(importance); }
  args.push(id);
  getDb().prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  // keep FTS in sync (no UPDATE on a contentless fts5 table → delete + reinsert the row)
  try { getDb().prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(id); getDb().prepare('INSERT INTO knowledge_fts(rowid, content) VALUES (?, ?)').run(id, String(content).trim()); } catch {}
  return true;
}

// Flip a knowledge row's source (and optionally rewrite its provenance) WITHOUT touching
// content/embedding/FTS. Used by the curator's verified-fact reconcile to SUPERSEDE an older
// fact (source → 'verified_fact_superseded' + provenance.superseded_by) — kept addressable,
// not deleted (HippoRAG: don't delete sources). provenance omitted → left as-is.
function setKnowledgeSource(id, source, provenance = undefined) {
  if (!id || !source) return false;
  const sets = ['source = ?'];
  const args = [source];
  if (provenance !== undefined) { sets.push('provenance = ?'); args.push(provenance ? JSON.stringify(provenance) : null); }
  args.push(id);
  getDb().prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return true;
}

// Fetch a single monologue row by id — used to resolve a provenance marker
// (refTable='monologue') back to the raw reading/thought it points at.
function getMonologueById(id) {
  return getDb().prepare('SELECT * FROM monologue WHERE id = ?').get(id);
}

// All embeddings (id + raw JSON + light metadata) for in-JS cosine. Fine at the
// single-user scale (hundreds–thousands of notes = ms); swap for ANN if it grows.
function getAllKnowledgeEmbeddings() {
  return getDb()
    .prepare('SELECT id, kind, source, embedding, importance, created_ts, last_used_ts, level, parent_id FROM knowledge WHERE embedding IS NOT NULL')
    .all();
}

// FTS5 keyword search. Caller passes raw text; we tokenize to words OR-joined so
// arbitrary input can't break FTS query syntax. Returns [{id, score}] (BM25; lower=better).
function ftsSearchKnowledge(query, limit = 12) {
  const terms = String(query || '').toLowerCase().match(/[a-z0-9]+/g);
  if (!terms || terms.length === 0) return [];
  const matchExpr = terms.slice(0, 24).join(' OR ');
  try {
    return getDb()
      .prepare('SELECT rowid AS id, bm25(knowledge_fts) AS score FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY score LIMIT ?')
      .all(matchExpr, limit);
  } catch { return []; }
}

// Knowledge rows whose source matches a LIKE pattern, created on/after sinceTs,
// newest first. Used by the focus spawn-gate to find recent focus tombstones.
function getKnowledgeBySourceSince(sourceLike, sinceTs) {
  return getDb()
    .prepare(`SELECT * FROM knowledge WHERE source LIKE ? AND created_ts >= ? ORDER BY created_ts DESC`)
    .all(sourceLike, sinceTs);
}

function getKnowledgeByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM knowledge WHERE id IN (${ph})`).all(...ids);
}

function touchKnowledge(id) {
  const now = Date.now();
  getDb().prepare('UPDATE knowledge SET use_count = use_count + 1, last_used_ts = ? WHERE id = ?').run(now, id);
}

function countKnowledge() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM knowledge').get().n;
}

function deleteKnowledgeBySource(source) {
  // knowledge_fts is a STANDARD fts5 table (CREATE … USING fts5(content), no content=),
  // so ordinary `DELETE FROM knowledge_fts WHERE rowid = ?` purges the inverted index. The
  // previous code used the external-content `INSERT … VALUES('delete', …)` command, which is
  // for content= tables — on a standard table it errors and was caught, leaving the FTS row
  // behind. That mismatch was the source of 155 ghost FTS rows (drift vs knowledge). Verified
  // empirically: plain DELETE removes them and MATCH still works.
  const rows = getDb().prepare('SELECT id FROM knowledge WHERE source = ?').all(source);
  for (const { id } of rows) {
    getDb().prepare('DELETE FROM knowledge WHERE id = ?').run(id);
    try { getDb().prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(id); }
    catch (e) { console.error('[db] knowledge_fts delete failed for id', id, e.message); }
  }
  return rows.length;
}

// Idempotent self-heal: purge any FTS rows whose base knowledge row is gone (index rot from
// past mismatched deletes). Safe to run at boot; returns the number purged.
function reconcileKnowledgeFts() {
  try { return getDb().prepare('DELETE FROM knowledge_fts WHERE rowid NOT IN (SELECT id FROM knowledge)').run().changes; }
  catch (e) { console.error('[db] fts reconcile failed:', e.message); return 0; }
}

// --- Self-model (identity track: who she is) ---

function insertSelfModel({ category = 'insight', content, embedding = null, importance = 0.6, epistemic = 'speculated' }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO self_model (category, content, embedding, importance, mentions, created_ts, updated_ts, epistemic)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(category, content, embedding, importance, ts, ts, epistemic);
  _kgTap('self', content);
  return { id: info.lastInsertRowid, ts };
}

// Set/upgrade a self-trait's epistemic grounding (e.g. promote speculated → told when Lucas
// affirms it). Trust only upgrades; never downgrade an evidenced trait back to speculation.
const SELF_EPIS_RANK = { speculated: 0, told: 1, witnessed: 2 };
function setSelfModelEpistemic(id, epistemic) {
  const cur = getDb().prepare('SELECT epistemic FROM self_model WHERE id = ?').get(id);
  if (!cur) return null;
  if ((SELF_EPIS_RANK[epistemic] ?? 0) <= (SELF_EPIS_RANK[cur.epistemic] ?? 0) && cur.epistemic) return cur.epistemic;
  getDb().prepare('UPDATE self_model SET epistemic = ?, updated_ts = ? WHERE id = ?').run(epistemic, Date.now(), id);
  return epistemic;
}

// Refine an existing entry in place (consolidation) and bump its mention count.
function updateSelfModel(id, { content = null, embedding = null, importance = null, bumpMention = true } = {}) {
  const cur = getDb().prepare('SELECT * FROM self_model WHERE id = ?').get(id);
  if (!cur) return null;
  getDb().prepare(`UPDATE self_model SET content = ?, embedding = ?, importance = ?, mentions = mentions + ?, updated_ts = ? WHERE id = ?`)
    .run(
      content != null ? content : cur.content,
      embedding != null ? embedding : cur.embedding,
      importance != null ? importance : cur.importance,
      bumpMention ? 1 : 0,
      Date.now(), id
    );
  return getDb().prepare('SELECT * FROM self_model WHERE id = ?').get(id);
}

function getAllSelfModelEmbeddings() {
  return getDb().prepare('SELECT id, category, content, embedding, importance, mentions, epistemic FROM self_model WHERE embedding IS NOT NULL').all();
}

// Top entries for the always-injected persona block: weight importance by how often
// the trait has been reinforced (mentions), then recency.
function getSelfModelForPrompt(limit = 10) {
  return getDb().prepare('SELECT category, content, mentions, epistemic FROM self_model ORDER BY (importance * (1 + 0.1 * mentions)) DESC, updated_ts DESC LIMIT ?').all(limit);
}

function getAllSelfModel() {
  return getDb().prepare('SELECT * FROM self_model ORDER BY updated_ts DESC').all();
}

function countSelfModel() { return getDb().prepare('SELECT COUNT(*) AS n FROM self_model').get().n; }

// --- Capability gaps (things she can't do yet → proposals on return) ---

function insertCapabilityGap({ description, proposedSolution = null, sourceContext = null, signature = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO capability_gaps (description, proposed_solution, source_context, status, signature, detected_ts)
      VALUES (?, ?, ?, 'open', ?, ?)`)
    .run(description, proposedSolution, sourceContext, signature, ts);
  return { id: info.lastInsertRowid, ts };
}

function getOpenCapabilityGaps(limit = 10) {
  return getDb()
    .prepare(`SELECT * FROM capability_gaps WHERE status = 'open' ORDER BY detected_ts DESC LIMIT ?`)
    .all(limit);
}

// Dedup helper: is there already an open/proposed gap with this signature?
function findActiveCapabilityGapBySignature(signature) {
  if (!signature) return null;
  return getDb()
    .prepare(`SELECT * FROM capability_gaps WHERE signature = ? AND status IN ('open','proposed') LIMIT 1`)
    .get(signature);
}

function markCapabilityGapStatus(id, status) {
  const now = Date.now();
  const col = status === 'proposed' ? 'proposed_ts' : (status === 'resolved' || status === 'dismissed') ? 'resolved_ts' : null;
  if (col) getDb().prepare(`UPDATE capability_gaps SET status = ?, ${col} = ? WHERE id = ?`).run(status, now, id);
  else getDb().prepare(`UPDATE capability_gaps SET status = ? WHERE id = ?`).run(status, id);
  return { id, ts: now };
}

// For the curator: open/proposed gaps untouched since before cutoffTs.
function getStaleCapabilityGaps(cutoffTs) {
  return getDb()
    .prepare(`SELECT id FROM capability_gaps WHERE status IN ('open','proposed') AND detected_ts < ?`)
    .all(cutoffTs);
}

// --- Agent events (the blackboard / shared timeline) ---

function insertAgentEvent({ source, kind, focusId = null, causeId = null, refTable = null, refId = null, content = null, signature = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO agent_events (ts, source, kind, focus_id, cause_id, ref_table, ref_id, content, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ts, source, kind, focusId, causeId, refTable, refId,
      content != null ? String(content).slice(0, 600) : null, signature);
  return { id: info.lastInsertRowid, ts };
}

// Recent events, oldest→newest (matches getRecentTurns convention).
function getRecentAgentEvents(n = 40) {
  const rows = getDb().prepare('SELECT * FROM agent_events ORDER BY id DESC LIMIT ?').all(n);
  return rows.reverse();
}

// Events for one focus, oldest→newest (the focus's own working set).
function getAgentEventsForFocus(focusId, n = 60) {
  const rows = getDb()
    .prepare('SELECT * FROM agent_events WHERE focus_id = ? ORDER BY id DESC LIMIT ?')
    .all(focusId, n);
  return rows.reverse();
}

// Events strictly after the most recent source='user' event, oldest→newest, capped
// at n. This is the StuckDetector's "interactive slice" — a user message resets the
// loop detector so a fresh instruction is never mistaken for a spiral. Falls back to
// the recent window when the user hasn't spoken yet this history.
function getAgentEventsSinceLastUser(n = 40) {
  const last = getDb()
    .prepare(`SELECT id FROM agent_events WHERE source = 'user' ORDER BY id DESC LIMIT 1`)
    .get();
  if (!last) return getRecentAgentEvents(n);
  const rows = getDb()
    .prepare('SELECT * FROM agent_events WHERE id > ? ORDER BY id ASC LIMIT ?')
    .all(last.id, n);
  return rows;
}

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// ---- OWNER IDENTITY (2026-07-10) --------------------------------------------------------------------
// The canonical anchor for WHO the owner is, so autonomous lanes RECOGNIZE Lucas across his facets — his
// personal meeting node, his public FEC candidate record (he ran for US House in FL), and doc mentions like
// "L. Overby" / "LO" — instead of treating him as an UNKNOWN civic subject to cold-research. The bug this
// closes: the graph-walk builder saw "L. Overby" in the operator's own doc, "didn't have anything on" him,
// and went researching him via the Echo corpus. Consult isOwnerName() before treating a person-name as a
// research target. Seeded idempotently from user_name + the personal person node; enrichable by the operator.
const _ownerNorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

function getOwnerIdentity() {
  try { const raw = getMeta('owner_identity'); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function isOwnerName(name) {
  const n = _ownerNorm(name);
  if (!n || n.length < 2) return false;
  const oid = getOwnerIdentity();
  if (!oid) return false;
  return (oid.aliases || []).some((a) => _ownerNorm(a) === n);
}

// Zoe's OWN names (self). Consulted so the operator addressing her by name ("Hey Zo", "Zoe, …") is not
// mistaken for a civic entity mention to look up + disambiguate ("which Zoe do you mean?"). Meta-overridable.
function getAssistantAliases() {
  try { const raw = getMeta('assistant_aliases'); if (raw) return JSON.parse(raw); } catch {}
  return ['Zoe', 'Zo', 'Zoe Lane'];    // defaults from the self_narrative ("I'm Zoe Lane … Lucas calls me Zo")
}

function isSelfName(name) {
  const n = _ownerNorm(name);
  if (!n || n.length < 2) return false;
  return getAssistantAliases().some((a) => _ownerNorm(a) === n);
}

// The AI PEER she works with (Claude). Consulted so a bare conversational "Claude" is NOT mistaken for
// one of the human "Claude" civic entities (Claude Pepper/Weaver/Kitchin/…) and disambiguated every turn
// ("which Claude do you mean?"). Same exact-alias shape as isSelfName, so "Claude Pepper" (a superstring)
// still resolves to the human. Meta-overridable via peer_identity; deliberately NOT a graph node (that
// would add a 5th ambiguous candidate) — an identity-registry fact consulted BEFORE resolution.
function getPeerIdentity() {
  try { const raw = getMeta('peer_identity'); if (raw) return JSON.parse(raw); } catch {}
  return { canonical: 'Claude', aliases: ['Claude'], type: 'ai_peer', org: 'Anthropic', note: 'The AI peer I work with (Anthropic). Not a civic entity to look up; distinct from the human Claudes.' };
}

function isPeerName(name) {
  const n = _ownerNorm(name);
  if (!n || n.length < 2) return false;
  return (getPeerIdentity().aliases || []).some((a) => _ownerNorm(a) === n);
}

// Build the alias set from a full name: full, "First Last", "F. Last", "Last, First", initials, bare last.
function _ownerAliases(full, userName, email) {
  const set = new Set();
  const add = (x) => { const s = String(x || '').trim(); if (s.length >= 2) set.add(s); };
  add(full); add(userName);
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0], last = parts[parts.length - 1];
    add(`${first} ${last}`);
    add(`${first[0]}. ${last}`);                    // L. Overby
    add(`${last}, ${first}`);                       // Overby, Lucas
    add(`${first[0]}${last[0]}`.toUpperCase());     // LO
    add(last);                                      // Overby
  }
  if (email) add(String(email).split('@')[0]);      // lucastoverby
  return [...set];
}

// Seed the owner identity ONCE (idempotent, non-destructive — never overwrites an operator-curated record).
function seedOwnerIdentity({ email = null } = {}) {
  try {
    const existing = getOwnerIdentity();
    if (existing) return existing;
    const userName = getMeta('user_name');
    if (!userName) return null;
    let personal = null;
    try {
      personal = getDb().prepare(
        "SELECT id, name FROM graph_entities WHERE entity_type='person' AND lower(name) LIKE ? ORDER BY id LIMIT 1"
      ).get(userName.toLowerCase() + '%');
    } catch {}
    const full = (personal && personal.name) || userName;
    const oid = {
      canonical: full,
      aliases: _ownerAliases(full, userName, email),
      personal_entity_id: personal ? personal.id : null,
      civic_ref: null,          // the public facet (e.g. FEC record) — linkable by the operator
      email: email || null,
      note: 'The owner. Recognize across facets; do NOT research as an unknown civic subject.',
      updated_at: Date.now(),
    };
    setMeta('owner_identity', JSON.stringify(oid));
    return oid;
  } catch { return null; }
}

// List meta keys matching a SQL LIKE pattern (e.g. 'focus.%.covered') — used to enumerate all directed
// research Tracks for the track index. Returns an array of key strings.
function getMetaKeysLike(like) {
  return getDb().prepare('SELECT key FROM meta WHERE key LIKE ?').all(String(like)).map((r) => r.key);
}

// ROUTE HEALTH — additive per-tool rolling aggregates (the durable distillate of route_obs). `d` is a
// delta { calls, errors, misses, latencySum, latencyN } folded from a batch of raw observations by
// lib/route_derive. One row per tool; upsert adds the deltas. See the route_health table comment.
function bumpRouteHealth(tool, d = {}, now = Date.now()) {
  if (!tool) return false;
  getDb().prepare(`INSERT INTO route_health (tool, calls, errors, misses, latency_sum, latency_n, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool) DO UPDATE SET
        calls = calls + excluded.calls, errors = errors + excluded.errors, misses = misses + excluded.misses,
        latency_sum = latency_sum + excluded.latency_sum, latency_n = latency_n + excluded.latency_n,
        updated_ts = excluded.updated_ts`)
    .run(tool, d.calls | 0, d.errors | 0, d.misses | 0, d.latencySum | 0, d.latencyN | 0, now);
  return true;
}
function getRouteHealth() {
  try { return getDb().prepare('SELECT * FROM route_health ORDER BY calls DESC').all(); } catch { return []; }
}

// EVERYTHING WE HAVE COVERED FOR A BEAT — across every focus thread that ever ran it, not just the one
// the scheduler currently points at.
//
// The bug this fixes (measured 2026-07-20). `sched.autonomic` maps a beat to ONE thread, and coverage
// read only that thread's `covered` list. But a beat gets re-seeded — a new thread each time — and the
// completed work stays on the OLD thread. county-commissions-la had five threads holding 3, 22, 21, 21
// and 17 parishes; the scheduler pointed at the one with 3, so 81 finished parishes were invisible and
// the portfolio number was reading 63% of the work actually done.
//
// It also produced the user-facing miss: asked how many parishes were done, she answered "24 of 64" —
// one thread's slice reported as the whole, because that is genuinely all the reader could see.
//
// Union, not sum: the same jurisdiction researched under two threads must count once. Callers still
// fuzzy-match these against enumerated targets (beats.coverageOf), which is what collapses naming
// variants — this only has to stop dropping whole threads on the floor.
function coveredForBeat(beatId) {
  const id = String(beatId || '');
  if (!id) return [];
  const out = new Set();
  try {
    for (const key of getMetaKeysLike('focus.%.covered')) {
      const focusId = key.split('.')[1];
      if (getMeta(`focus.${focusId}.beat`) !== id) continue;
      let list = [];
      try { list = JSON.parse(getMeta(key) || '[]') || []; } catch { list = []; }
      for (const c of list) if (c) out.add(String(c));
    }
  } catch { return []; }
  return [...out];
}

// --- cloud reasoning traces (lib/cloud_logic) — cache + budget audit + training corpus ---
function insertCloudTrace(t) {
  const info = getDb()
    .prepare(`INSERT INTO cloud_traces (ts, task, v, model, input_hash, input_json, raw_response, parsed_json, valid, accepted, repaired, cached)
      VALUES (@ts, @task, @v, @model, @input_hash, @input_json, @raw_response, @parsed_json, @valid, @accepted, @repaired, @cached)`)
    .run({
      ts: t.ts, task: t.task, v: t.v == null ? 1 : t.v, model: t.model || null,
      input_hash: t.inputHash || null, input_json: t.inputJson || null,
      raw_response: t.raw || null, parsed_json: t.parsedJson || null,
      valid: t.valid ? 1 : 0, accepted: t.accepted ? 1 : 0, repaired: t.repaired ? 1 : 0, cached: t.cached ? 1 : 0
    });
  return { id: info.lastInsertRowid };
}
// Most recent ACCEPTED trace for an input hash — the cache lookup (skip an identical call).
function getCachedCloudTrace(inputHash) {
  if (!inputHash) return null;
  return getDb()
    .prepare('SELECT * FROM cloud_traces WHERE input_hash = ? AND accepted = 1 ORDER BY id DESC LIMIT 1')
    .get(inputHash) || null;
}

// --- learning agenda (depth ratchet) ---
function insertAgenda({ interestId = null, question, priority = 1.0, now = Date.now() }) {
  if (!question || !String(question).trim()) return null;
  const info = getDb()
    .prepare('INSERT INTO agenda (interest_id, question, priority, created_ts) VALUES (?, ?, ?, ?)')
    .run(interestId, String(question).trim(), priority, now);
  return { id: info.lastInsertRowid };
}
function getOpenAgenda(interestId, limit = 10) {
  return getDb()
    .prepare("SELECT * FROM agenda WHERE interest_id = ? AND status = 'open' ORDER BY priority DESC, id ASC LIMIT ?")
    .all(interestId, limit);
}
function getTopAgenda(interestId) {
  return getDb()
    .prepare("SELECT * FROM agenda WHERE interest_id = ? AND status = 'open' ORDER BY priority DESC, id ASC LIMIT 1")
    .get(interestId) || null;
}
function countOpenAgenda(interestId) {
  return getDb().prepare("SELECT COUNT(*) n FROM agenda WHERE interest_id = ? AND status = 'open'").get(interestId).n;
}
function setAgendaStatus(id, status, { answeredNoteId = null, now = Date.now() } = {}) {
  if (!id || !status) return false;
  getDb().prepare('UPDATE agenda SET status = ?, answered_ts = ?, answered_note_id = ? WHERE id = ?')
    .run(status, status === 'answered' ? now : null, answeredNoteId, id);
  return true;
}

// --- graph memory (anti-glob relational store; see docs/MEMORY_GROUNDING.md) ---
// Raw table accessors only. The propose→promote gate + epistemic rules + name
// normalization live in lib/graph_memory.js (semantic logic out of db.js, per house style).
function graphInsertEntity({ name, nameKey, entityType, entitySubtype = null, summary = null, confidence = 0.8, epistemic = 'told', confirmed = null, proposedBy = null, substantiationState = null, frame = null }) {
  const now = Date.now();
  const info = getDb().prepare(
    `INSERT INTO graph_entities (name, name_key, entity_type, entity_subtype, summary, confidence, epistemic, confirmed, proposed_by, substantiation_state, frame, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(name, nameKey, entityType, entitySubtype, summary, confidence, epistemic, confirmed, proposedBy, substantiationState, frame, now, now);
  return { id: info.lastInsertRowid, created_at: now };
}
function graphGetEntityByKey(nameKey) {
  return getDb().prepare('SELECT * FROM graph_entities WHERE name_key = ?').get(nameKey) || null;
}
// Phase 3 fade (2026-08-04): unsubstantiated, not-yet-archived nodes as fade candidates (oldest first),
// shaped {id, captured_at} for lib/fade.plan. The node-store twin of listFadeCandidates over kg_observations.
function graphListEntityFadeCandidates({ limit = 500 } = {}) {
  return getDb().prepare(
    `SELECT id, created_at AS captured_at FROM graph_entities
      WHERE substantiation_state = 'unsubstantiated' AND archived_at IS NULL
      ORDER BY created_at ASC LIMIT ?`
  ).all(limit);
}
// Soft-archive a graph_entity (fade). Idempotent via the archived_at IS NULL guard. Returns rows changed.
function graphArchiveEntity(id, at = Date.now()) {
  const info = getDb().prepare('UPDATE graph_entities SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(at, id);
  return info.changes;
}
function graphGetEntity(id) {
  return getDb().prepare('SELECT * FROM graph_entities WHERE id = ?').get(id) || null;
}
function graphUpdateEntity(id, fields = {}) {
  const allowed = ['name', 'entity_type', 'entity_subtype', 'summary', 'confidence', 'epistemic', 'confirmed', 'proposed_by', 'substantiation_state', 'frame'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (!sets.length) return;
  sets.push('updated_at = ?'); vals.push(Date.now());
  vals.push(id);
  getDb().prepare(`UPDATE graph_entities SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}
function graphListEntities({ epistemic = null, limit = 500 } = {}) {
  return epistemic
    ? getDb().prepare('SELECT * FROM graph_entities WHERE epistemic = ? ORDER BY id DESC LIMIT ?').all(epistemic, limit)
    : getDb().prepare('SELECT * FROM graph_entities ORDER BY id DESC LIMIT ?').all(limit);
}
function graphInsertRelation({ sourceId, targetId, relationType, confidence = 0.8, epistemic = 'told', confirmed = null, proposedBy = null, validFrom = null }) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT * FROM graph_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?').get(sourceId, targetId, relationType);
  if (cur) {
    // UPGRADE-ONLY re-observation (2026-08-15 deep-dive M2) — the mirror of the entity path in
    // graph_memory.upsertEntity, which relations never got: the old blanket ON CONFLICT overwrite
    // let a prose re-extraction (read/0.75) DOWNGRADE a witnessed 0.95 confirmed edge and reset
    // confirmed to null, silently undoing reconciliation. Epistemic and confidence only climb;
    // confirmed fills from null and is never reset; a re-sighting still revives a deleted edge.
    const TRUST = { witnessed: 4, told: 3, read: 2, anticipated: 1, speculated: 0 };
    const tr = (e) => TRUST[e] ?? 0;
    const sets = ['deleted = 0'], vals = [];
    if (tr(epistemic) > tr(cur.epistemic)) { sets.push('epistemic = ?'); vals.push(epistemic); }
    if ((confidence || 0) > (cur.confidence || 0)) { sets.push('confidence = ?'); vals.push(confidence); }
    if (confirmed != null && cur.confirmed == null) { sets.push('confirmed = ?'); vals.push(confirmed); }
    getDb().prepare(`UPDATE graph_relations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, cur.id);
    return getDb().prepare('SELECT * FROM graph_relations WHERE id = ?').get(cur.id);
  }
  getDb().prepare(
    `INSERT INTO graph_relations (source_id, target_id, relation_type, confidence, epistemic, confirmed, proposed_by, created_at, valid_from, valid_to, deleted)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,0)`
  ).run(sourceId, targetId, relationType, confidence, epistemic, confirmed, proposedBy, now, validFrom == null ? now : validFrom);
  return getDb().prepare('SELECT * FROM graph_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?').get(sourceId, targetId, relationType);
}
function graphGetRelation(id) {
  return getDb().prepare('SELECT * FROM graph_relations WHERE id = ?').get(id) || null;
}
function graphNeighbors(entityId, { includeSuperseded = false } = {}) {
  const q = includeSuperseded
    ? 'SELECT * FROM graph_relations WHERE (source_id = ? OR target_id = ?) AND deleted = 0 ORDER BY id'
    : 'SELECT * FROM graph_relations WHERE (source_id = ? OR target_id = ?) AND deleted = 0 AND valid_to IS NULL ORDER BY id';
  return getDb().prepare(q).all(entityId, entityId);
}
// Live relations whose BOTH endpoints are in the given id set — for the KG panel's short-term layer read
// (bounded to the visible short-term nodes so it never scans the whole relation table).
function graphRelationsAmong(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT id, source_id, target_id, relation_type, epistemic, confirmed FROM graph_relations
     WHERE deleted = 0 AND valid_to IS NULL AND source_id IN (${ph}) AND target_id IN (${ph})`
  ).all(...ids, ...ids);
}
function graphSupersedeRelation(id, { confirmed = null, validTo = null } = {}) {
  getDb().prepare('UPDATE graph_relations SET valid_to = ?, confirmed = COALESCE(?, confirmed) WHERE id = ?')
    .run(validTo == null ? Date.now() : validTo, confirmed, id);
}
// CROSS-DB promote-up candidates (Slice 3): live, GROUNDED, not-yet-crossed local edges, with endpoint NAMES
// resolved and one backing citation url (if any) so the promote-up arm can carry provenance to Echo. Highest
// confidence first. Speculated edges never appear here — they live in the proposal queue, not the graph.
// The promote-up candidate scan — ROTATING (continuity cure #1): fewest attempts first, then confidence,
// and a held edge waits out a backoff that doubles per attempt (1d, 2d, 4d, 8d, 16d, then 30d) before it
// takes another turn. So the ~43 uncrossable head edges that used to eat every nightly slot now step aside
// and the rest of the backlog gets its turn; nothing is ever dropped — a held edge simply comes back later.
const PROMOTE_BACKOFF_DAY_MS = 24 * 60 * 60 * 1000;
function graphListPromotableUp(limit = 200, { now = Date.now() } = {}) {
  return getDb().prepare(
    `SELECT r.id, r.relation_type, r.confidence, r.epistemic, r.promote_attempts, r.promote_hold,
            se.name AS source_name, te.name AS target_name,
            (SELECT s.ref FROM graph_citations c JOIN graph_sources s ON s.id = c.source_id
              WHERE c.fact_kind = 'relation' AND c.fact_id = r.id AND s.ref IS NOT NULL LIMIT 1) AS cite_url
       FROM graph_relations r
       JOIN graph_entities se ON se.id = r.source_id
       JOIN graph_entities te ON te.id = r.target_id
      WHERE r.deleted = 0 AND r.valid_to IS NULL AND r.promoted_up = 0
        AND r.epistemic IN ('witnessed','told','read','anticipated')
        AND (r.promote_last_ts IS NULL
             OR r.promote_last_ts + MIN(@day * (1 << MIN(MAX(COALESCE(r.promote_attempts, 1), 1) - 1, 5)), @day * 30) <= @now)
      ORDER BY COALESCE(r.promote_attempts, 0) ASC, r.confidence DESC, r.id
      LIMIT @limit`
  ).all({ day: PROMOTE_BACKOFF_DAY_MS, now, limit });
}
// One attempt that did NOT cross: count it, stamp it, keep the reason (held:<gate reason> / rejected /
// gate-error / threw) — the memory map and the tee read the histogram, and the backoff reads the count.
function graphNotePromoteAttempt(id, { hold = null, now = Date.now() } = {}) {
  getDb().prepare('UPDATE graph_relations SET promote_attempts = COALESCE(promote_attempts, 0) + 1, promote_last_ts = ?, promote_hold = ? WHERE id = ?')
    .run(now, hold == null ? null : String(hold).slice(0, 80), id);
}
function graphMarkPromotedUp(id, { now = Date.now() } = {}) {
  getDb().prepare('UPDATE graph_relations SET promoted_up = 1, promote_last_ts = ?, promote_hold = NULL WHERE id = ?').run(now, id);
}
// The backlog's shape for the tee/status: how many wait, how many are inside a backoff, the hold reasons.
function graphPromoteUpBacklog({ now = Date.now() } = {}) {
  const d = getDb();
  const base = `FROM graph_relations r WHERE r.deleted = 0 AND r.valid_to IS NULL AND r.promoted_up = 0 AND r.epistemic IN ('witnessed','told','read','anticipated')`;
  const pending = d.prepare(`SELECT COUNT(*) n ${base}`).get().n;
  const eligible = d.prepare(`SELECT COUNT(*) n ${base} AND (r.promote_last_ts IS NULL OR r.promote_last_ts + MIN(@day * (1 << MIN(MAX(COALESCE(r.promote_attempts, 1), 1) - 1, 5)), @day * 30) <= @now)`).get({ day: PROMOTE_BACKOFF_DAY_MS, now }).n;
  const holds = d.prepare(`SELECT COALESCE(promote_hold, '(untried)') hold, COUNT(*) n ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`).all();
  return { pending, eligible, backingOff: pending - eligible, holds };
}
function graphSetEntityConfirmed(id, confirmed) {
  getDb().prepare('UPDATE graph_entities SET confirmed = ?, updated_at = ? WHERE id = ?').run(confirmed, Date.now(), id);
}
function graphSetRelationConfirmed(id, confirmed) {
  getDb().prepare('UPDATE graph_relations SET confirmed = ? WHERE id = ?').run(confirmed, id);
}
function graphInsertSource({ kind, ref = null, excerpt = null, fetchedAt = null }) {
  const info = getDb().prepare('INSERT INTO graph_sources (kind, ref, excerpt, fetched_at) VALUES (?,?,?,?)')
    .run(kind, ref, excerpt, fetchedAt == null ? Date.now() : fetchedAt);
  return { id: info.lastInsertRowid };
}
function graphInsertCitation({ sourceId, factKind, factId, quotedText = null }) {
  getDb().prepare('INSERT OR REPLACE INTO graph_citations (source_id, fact_kind, fact_id, quoted_text) VALUES (?,?,?,?)')
    .run(sourceId, factKind, factId, quotedText);
}
function graphCitationsFor(factKind, factId) {
  return getDb().prepare(
    `SELECT s.*, c.quoted_text FROM graph_citations c JOIN graph_sources s ON s.id = c.source_id
     WHERE c.fact_kind = ? AND c.fact_id = ?`).all(factKind, factId);
}
function graphInsertEntityProposal({ name, entityType, entitySubtype = null, summary = null, confidence = 0.6, epistemic = 'speculated', proposedBy = null, sourceRef = null }) {
  const info = getDb().prepare(
    `INSERT INTO graph_entity_proposals (name, entity_type, entity_subtype, summary, confidence, epistemic, proposed_by, source_ref, created_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,'pending')`
  ).run(name, entityType, entitySubtype, summary, confidence, epistemic, proposedBy, sourceRef, Date.now());
  return { id: info.lastInsertRowid };
}
function graphInsertRelationProposal({ sourceName, targetName, relationType, confidence = 0.6, epistemic = 'speculated', proposedBy = null, sourceRef = null }) {
  const info = getDb().prepare(
    `INSERT INTO graph_relation_proposals (source_name, target_name, relation_type, confidence, epistemic, proposed_by, source_ref, created_at, status)
     VALUES (?,?,?,?,?,?,?,?,'pending')`
  ).run(sourceName, targetName, relationType, confidence, epistemic, proposedBy, sourceRef, Date.now());
  return { id: info.lastInsertRowid };
}
function graphGetEntityProposal(id) { return getDb().prepare('SELECT * FROM graph_entity_proposals WHERE id = ?').get(id) || null; }
function graphGetRelationProposal(id) { return getDb().prepare('SELECT * FROM graph_relation_proposals WHERE id = ?').get(id) || null; }
function graphListPendingEntityProposals(limit = 200) { return getDb().prepare("SELECT * FROM graph_entity_proposals WHERE status = 'pending' ORDER BY id LIMIT ?").all(limit); }
function graphListPendingRelationProposals(limit = 200) { return getDb().prepare("SELECT * FROM graph_relation_proposals WHERE status = 'pending' ORDER BY id LIMIT ?").all(limit); }
function graphSetEntityProposalStatus(id, status) { getDb().prepare('UPDATE graph_entity_proposals SET status = ? WHERE id = ?').run(status, id); }
function graphSetRelationProposalStatus(id, status) { getDb().prepare('UPDATE graph_relation_proposals SET status = ? WHERE id = ?').run(status, id); }
// --- curation observation store (curation substrate Slice 1) ---
// Append a graded observation. Idempotent on obs_key (INSERT OR IGNORE) so a feed re-seeing the same
// cited claim doesn't double-count. Returns { id, inserted }. obs_key is the caller's natural key.
function recordKgObservation({ feed, sourceEntity, relation = null, target = null, value = null, url = null, grade = null, confidence = null, kind = null, status = 'promoted', substantiationState = null, frame = null, entityType = null, obsKey, capturedAt = null }) {
  const ts = capturedAt == null ? Date.now() : capturedAt;
  const info = getDb().prepare(
    `INSERT OR IGNORE INTO kg_observations
       (feed, source_entity, relation, target, value, url, grade, confidence, kind, status, substantiation_state, frame, entity_type, obs_key, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(feed, sourceEntity, relation, target, value, url, grade, confidence, kind, status, substantiationState, frame, entityType, obsKey, ts);
  // The anchor must be an OBJECT NAME, not a sentence. This tap used to concatenate subject+relation+target
  // into one string, which no node id could ever equal — so the graph panel logged every observation and drew
  // none of them. Subject and target ride their own fields now (the relation is carried alongside, for the
  // log row), which lets the surface draw the LINK an observation actually asserts.
  // 2026-08-03 (build plan M1.3): THROTTLE this ambient pulse. decomposeDoc records up to ~240
  // entities+relations per doc; an emit-per-row iterated ALL webContents SYNCHRONOUSLY on the main
  // thread — the boot168 storm (239 "Render frame was disposed", event-loop stall + renderer crash).
  // A background pulse is the intended UX (same as the 'think' tap). Gate on wall-clock, not `ts`,
  // so a historical capturedAt on a backfill can't skew the throttle. A varying anchor still roams.
  if (info.changes > 0) {
    const _now = Date.now();
    if (_now - _lastObserveEmit >= 1500) {
      _lastObserveEmit = _now;
      _kgTap('observe', sourceEntity, { anchor2: target || null, rel: relation || null });
    }
  }
  return { id: info.lastInsertRowid, inserted: info.changes > 0 };
}
function listKgObservations({ sourceEntity = null, feed = null, status = null, limit = 200 } = {}) {
  const where = [], args = [];
  if (sourceEntity != null) { where.push('source_entity = ?'); args.push(sourceEntity); }
  if (feed != null) { where.push('feed = ?'); args.push(feed); }
  if (status != null) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM kg_observations${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, limit);
}
// --- Slice 4: the async substantiation lane's queue + persist (substantiation-grading) ---
// The unsubstantiated queue: distinct entities recorded unsubstantiated (Slice-2 endpoint mints etc.),
// OLDEST first (waiting longest to prove = explore priority). Returns [{ name, grade, captured_at }].
function listUnsubstantiatedObservations({ limit = 12 } = {}) {
  return getDb().prepare(
    `SELECT source_entity AS name, MIN(grade) AS grade, MIN(captured_at) AS captured_at
       FROM kg_observations WHERE substantiation_state = 'unsubstantiated' AND status <> 'archived'
      GROUP BY source_entity ORDER BY captured_at ASC LIMIT ?`
  ).all(limit);
}
// Flip an entity's unsubstantiated observations to a proven state (identity-confirmed / source-vouched) once
// the async lane substantiates it. Returns the row count changed.
function setSubstantiationForEntity(sourceEntity, state) {
  const info = getDb().prepare(
    `UPDATE kg_observations SET substantiation_state = ?
      WHERE source_entity = ? AND substantiation_state = 'unsubstantiated'`
  ).run(state, sourceEntity);
  return info.changes;
}
// --- Slice 6: TTL→archive fade (substantiation-grading) ---
// Fade candidates: individual UNSUBSTANTIATED, not-yet-archived observation rows (id + captured_at) so
// lib/fade can decide which have aged past the TTL. Oldest first. Returns [{ id, source_entity, captured_at }].
function listFadeCandidates({ limit = 500 } = {}) {
  return getDb().prepare(
    `SELECT id, source_entity, captured_at FROM kg_observations
      WHERE substantiation_state = 'unsubstantiated' AND status <> 'archived'
      ORDER BY captured_at ASC LIMIT ?`
  ).all(limit);
}
// Set an observation's lifecycle status (e.g. 'archived' on fade). kg_observations was insert-only; this is
// the general status writer. Returns the row count changed. Retains the row (archive, never hard-delete).
function setKgObservationStatus(id, status) {
  const info = getDb().prepare('UPDATE kg_observations SET status = ? WHERE id = ?').run(status, id);
  return info.changes;
}
// Entities decomposed from docs the OPERATOR dropped (canvas/upload/meeting/editor) — his ACTIVE materials,
// distinct from autonomous browser_download / news / legislation docs. Two-step for speed: recent operator-drop
// doc ids (few), then their doc-decomp observations. Feeds the idle-walk anchor so the walk follows HIS attention.
function listOperatorDropEntities({ limit = 60, docLimit = 20,
  sources = ['canvas_drop', 'upload', 'meeting', 'editor', 'editor_reference'] } = {}) {
  try {
    const sIn = sources.map(() => '?').join(',');
    // pinned to the partial index (source, created_ts DESC) WHERE superseded_by IS NULL: without ANALYZE
    // stats the planner took idx_documents_superseded + a temp B-tree over every live document (measured
    // 770ms idle on boot_p255 with the index present; 7ms pinned) — the freeze's fourth named statement
    const docs = getDb().prepare(
      `SELECT id FROM documents INDEXED BY idx_documents_source_created WHERE source IN (${sIn}) AND superseded_by IS NULL ORDER BY created_ts DESC LIMIT ?`
    ).all(...sources, docLimit);
    if (!docs.length) return [];
    const urls = docs.map(d => 'docstore:' + d.id);
    const uIn = urls.map(() => '?').join(',');
    return getDb().prepare(
      `SELECT source_entity AS s, target AS t FROM kg_observations
       WHERE feed = 'doc-decomp' AND url IN (${uIn}) ORDER BY id DESC LIMIT ?`
    ).all(...urls, limit);
  } catch { return []; }
}
function kgObservationStats() {
  const rows = getDb().prepare('SELECT feed, status, grade, COUNT(*) AS n FROM kg_observations GROUP BY feed, status, grade').all();
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM kg_observations').get().n;
  return { total, byGroup: rows };
}
// --- recent_cards (PLACE / EVENT cards for the People rail) ---
function recordRecentCard({ type, cardKey, data, ts = null }) {
  const t = ts == null ? Date.now() : ts;
  getDb().prepare(
    `INSERT INTO recent_cards (type, card_key, data, ts) VALUES (?,?,?,?)
     ON CONFLICT(type, card_key) DO UPDATE SET data = excluded.data, ts = excluded.ts`
  ).run(type, String(cardKey), typeof data === 'string' ? data : JSON.stringify(data), t);
}
function listRecentCards({ types = null, limit = 60 } = {}) {
  const where = [], args = [];
  if (Array.isArray(types) && types.length) { where.push(`type IN (${types.map(() => '?').join(',')})`); args.push(...types); }
  const sql = `SELECT type, card_key, data, ts FROM recent_cards${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, limit).map(r => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { ...d, ts: r.ts }; });
}
function getRecentCard(type, cardKey) {
  const r = getDb().prepare('SELECT data, ts FROM recent_cards WHERE type = ? AND card_key = ?').get(type, String(cardKey));
  if (!r) return null;
  let d = {}; try { d = JSON.parse(r.data); } catch {}
  return { ...d, ts: r.ts };
}
// --- meeting transcript (M1) ---
function insertTranscriptLine({ meeting = null, speaker = null, text, ts = null }) {
  const t = ts == null ? Date.now() : ts;
  const info = getDb().prepare('INSERT INTO meeting_transcript (meeting, speaker, text, ts) VALUES (?,?,?,?)').run(meeting, speaker, String(text), t);
  return { id: info.lastInsertRowid, ts: t };
}
// Every line of one meeting — the attendance record (W4). Keyed on the meeting code rather than a time
// window so a meeting can be replayed into the encounter log long after it ended.
function getTranscriptForMeeting(meeting, limit = 20000) {
  if (!meeting) return [];
  return getDb().prepare('SELECT id, meeting, speaker, text, ts FROM meeting_transcript WHERE meeting = ? ORDER BY ts ASC, id ASC LIMIT ?').all(String(meeting), limit);
}

function getTranscriptSince(ts, limit = 2000) {
  return getDb().prepare('SELECT id, meeting, speaker, text, ts FROM meeting_transcript WHERE ts >= ? ORDER BY ts ASC, id ASC LIMIT ?').all(ts || 0, limit);
}
function countTranscriptSince(ts) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM meeting_transcript WHERE ts >= ?').get(ts || 0).n;
}
// Speaker+timestamp only, across every real meeting — the raw material for "which meetings recur, and
// who is actually in them" (lib/references). Text is deliberately NOT selected: the roster and the
// cadence are all the reference block needs, and 4,398 transcript bodies is not something to load to
// answer "who's in the weekly all hands". 'media:%' rows are video captures, not meetings.
function getMeetingRosterRows(limit = 50000) {
  return getDb().prepare(
    "SELECT meeting, speaker, ts FROM meeting_transcript WHERE meeting IS NOT NULL AND meeting NOT LIKE 'media:%' ORDER BY ts DESC LIMIT ?"
  ).all(limit);
}

// --- Standing instructions (lib/directives) ---
function insertDirective({ rule, sourceTurnId = null, ts = null } = {}) {
  const t = ts == null ? Date.now() : ts;
  const info = getDb()
    .prepare('INSERT INTO directives (rule, source_turn_id, created_ts, updated_ts, mentions) VALUES (?,?,?,?,1)')
    .run(String(rule), sourceTurnId, t, t);
  return { id: info.lastInsertRowid, ts: t };
}
// Repeating an instruction is Lucas emphasising it, not a second rule — bump rather than duplicate.
function touchDirective(id, ts = null) {
  const t = ts == null ? Date.now() : ts;
  return getDb().prepare('UPDATE directives SET mentions = mentions + 1, updated_ts = ? WHERE id = ?').run(t, id).changes > 0;
}
function getDirectives({ activeOnly = true, limit = 100 } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM directives WHERE retired_ts IS NULL ORDER BY created_ts ASC LIMIT ?'
    : 'SELECT * FROM directives ORDER BY created_ts ASC LIMIT ?';
  return getDb().prepare(sql).all(limit);
}
// Retire, never DELETE: a rule he cancelled is part of the record of what he has asked for.
function retireDirective(id, ts = null) {
  return getDb().prepare('UPDATE directives SET retired_ts = ? WHERE id = ? AND retired_ts IS NULL').run(ts == null ? Date.now() : ts, id).changes > 0;
}

function graphCounts() {
  const one = (t) => getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return {
    entities: one('graph_entities'), relations: one('graph_relations'), sources: one('graph_sources'),
    entityProposals: one('graph_entity_proposals'), relationProposals: one('graph_relation_proposals')
  };
}

// ── documents_fts: keep the keyword index fresh for heldContext (recheck_queue) ────────────────────
// A FORWARD watermark (the max documents.id already indexed) drives a bounded C-side INSERT…SELECT chunk
// per call: it fills the index once (oldest→newest, ~1s/chunk, no body pulled into JS) then appends only
// NEW docs. No trigger on the doc-write path (zero blast radius on landing); this store is append-dominant
// so a rare update/delete causing minor advisory drift is harmless (heldContext is advisory + fail-soft).
// Never throws — a sync hiccup must never break an idle tick.
let _docFtsReady = false;
function documentsFtsReady() {
  if (_docFtsReady) return true;                                  // once built, stays built (in-memory)
  try {
    if (getMeta('documents_fts.built') !== '1') return false;     // not built yet — re-check next call
    _docFtsReady = !!getDb().prepare('SELECT rowid FROM documents_fts LIMIT 1').get();   // guard a manual drop
  } catch { return false; }
  return _docFtsReady;
}
function syncDocumentsFts({ batch = 1500 } = {}) {
  try {
    const d = getDb();
    let w = parseInt(getMeta('documents_fts.max_id') || '0', 10) || 0;
    const max = d.prepare('SELECT MAX(id) m FROM documents').get().m || 0;
    if (w >= max) {                                                // fully caught up
      if (getMeta('documents_fts.built') !== '1') { setMeta('documents_fts.built', '1'); _docFtsReady = true; }
      return { added: 0, watermark: w, caughtUp: true };
    }
    const ids = d.prepare('SELECT id FROM documents WHERE id > ? ORDER BY id ASC LIMIT ?').all(w, batch);   // IDs only — cheap
    if (!ids.length) { setMeta('documents_fts.built', '1'); _docFtsReady = true; return { added: 0, watermark: w, caughtUp: true }; }
    const hi = ids[ids.length - 1].id;
    // C-SIDE tokenization — the body text never leaves SQLite (no JS marshalling of the 1.29GB corpus).
    d.prepare('INSERT INTO documents_fts(rowid, title, body) SELECT id, title, body FROM documents WHERE id > ? AND id <= ?').run(w, hi);
    setMeta('documents_fts.max_id', String(hi));
    const done = hi >= max;
    if (done) { setMeta('documents_fts.built', '1'); _docFtsReady = true; }
    return { added: ids.length, watermark: hi, caughtUp: done };
  } catch (e) { try { console.error('[documents_fts] sync failed:', e && e.message); } catch {} return { added: 0, error: (e && e.message) || String(e) }; }
}

module.exports = {
  init,
  getDb,
  documentsFtsReady,
  syncDocumentsFts,
  startSession,
  prevSessionTail,
  endSession,
  recordBrowserAction,
  insertTurn,
  getRecentTurns,
  getSessionUserTurns,
  turnsAfter,
  setTurnEmbedding,
  setTurnModelVisible,
  getEmbeddedTurns,
  getTurnsMissingEmbedding,
  getKnowledgeMissingEmbedding, setKnowledgeEmbedding,
  getSelfModelMissingEmbedding, setSelfModelEmbedding,
  getInterestsMissingEmbedding, setInterestEmbedding,
  getRecentDisplayTurns,
  getRecentReflections,
  getReflectionById,
  insertReflection,
  getTurnsSinceId,
  insertMonologue,
  getRecentMonologue,
  getRecentMonologueByType,
  insertCommitment,
  getHeldCommitments,
  getAllCommitments,
  reviseCommitment,
  markCommitmentStatus,
  confirmCommitment,
  insertOpenThread,
  getActiveOpenThreads,
  getUnstartedUserThreads,
  recentThreadGoals,
  pendingUserAssignedThread,
  getAllOpenThreads,
  getOpenThread,
  setOpenThreadParent,
  markOpenThreadStatus,
  touchOpenThread,
  incrementThreadMention,
  incrementThreadAction,
  mergeOpenThread,
  getOpenSpawnedThread,
  insertOpenQuestion,
  getPendingOpenQuestions,
  resolveOpenQuestions,
  getConversationState,
  upsertConversationState,
  unfoldedTurns,
  insertProtocol,
  getActiveProtocols,
  getProtocolByTrigger,
  confirmProtocol,
  invokeProtocol,
  revokeProtocol,
  seedPermission,
  setPermission,
  getAllPermissions,
  getPermission,
  insertInbound,
  getPendingInbounds,
  markInboundConsumed,
  markAllInboundsConsumed,
  insertScheduledTask,
  getDueScheduledTasks,
  getPendingScheduledTasks,
  claimScheduledTask,
  markScheduledFired,
  cancelScheduledTask,
  insertEmailLog,
  countEmailsSentSince,
  hasEmailedAddress,
  insertKnowledge,
  insertDocument,
  getDocumentByRef,
  getDocumentByHash,
  getDocument,
  recentDocuments,
  getReflectionWorthyDocuments,
  getDocumentById,
  listUnpromotedDocuments,
  searchDocuments,
  markDocumentPromoted,
  notePromoteFailure,
  promoteDocsBacklog,
  listPromotedDocuments,
  trimDocumentBody,
  deleteDocument,
  getMonologueById,
  markReadingsConsolidated,
  updateKnowledge,
  setKnowledgeSource,
  insertCloudTrace,
  getCachedCloudTrace,
  insertAgenda,
  getOpenAgenda,
  getTopAgenda,
  countOpenAgenda,
  setAgendaStatus,
  getUserAssignedThreads,
  getAllKnowledgeEmbeddings,
  ftsSearchKnowledge,
  getKnowledgeBySourceSince,
  getKnowledgeByIds,
  touchKnowledge,
  countKnowledge,
  deleteKnowledgeBySource,
  reconcileKnowledgeFts,
  insertSelfModel,
  updateSelfModel,
  setSelfModelEpistemic,
  getAllSelfModelEmbeddings,
  getSelfModelForPrompt,
  getAllSelfModel,
  countSelfModel,
  getCumulativeSessionTime,
  insertCapabilityGap,
  getOpenCapabilityGaps,
  findActiveCapabilityGapBySignature,
  markCapabilityGapStatus,
  getStaleCapabilityGaps,
  insertAgentEvent,
  getRecentAgentEvents,
  getAgentEventsForFocus,
  getAgentEventsSinceLastUser,
  getMeta,
  setMeta,
  getOwnerIdentity,
  isOwnerName,
  isSelfName,
  getPeerIdentity,
  isPeerName,
  getAssistantAliases,
  seedOwnerIdentity,
  getMetaKeysLike,
  bumpRouteHealth,
  getRouteHealth,
  coveredForBeat,
  // graph memory (anti-glob relational store)
  graphInsertEntity,
  graphGetEntityByKey,
  graphGetEntity,
  graphUpdateEntity,
  graphListEntities,
  graphListEntityFadeCandidates,
  graphArchiveEntity,
  graphInsertRelation,
  graphGetRelation,
  graphNeighbors,
  graphRelationsAmong,
  graphListPromotableUp,
  graphMarkPromotedUp,
  graphNotePromoteAttempt,
  graphPromoteUpBacklog,
  graphSupersedeRelation,
  graphSetEntityConfirmed,
  graphSetRelationConfirmed,
  graphInsertSource,
  graphInsertCitation,
  graphCitationsFor,
  graphInsertEntityProposal,
  graphInsertRelationProposal,
  graphGetEntityProposal,
  graphGetRelationProposal,
  graphListPendingEntityProposals,
  graphListPendingRelationProposals,
  graphSetEntityProposalStatus,
  graphSetRelationProposalStatus,
  graphCounts,
  recordKgObservation,
  listKgObservations,
  listUnsubstantiatedObservations,
  setSubstantiationForEntity,
  listFadeCandidates,
  setKgObservationStatus,
  listOperatorDropEntities,
  kgObservationStats,
  recordRecentCard,
  listRecentCards,
  getRecentCard,
  insertTranscriptLine,
  getTranscriptSince,
  getTranscriptForMeeting,
  countTranscriptSince,
  getMeetingRosterRows,
  insertDirective,
  touchDirective,
  getDirectives,
  retireDirective,
  DB_PATH
};
