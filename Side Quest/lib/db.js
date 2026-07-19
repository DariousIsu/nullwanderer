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
  `CREATE INDEX IF NOT EXISTS idx_monologue_type_ts ON monologue(type, ts)`,
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
  // SUBSTANTIATION SUBSTRATE (docs/SUBSTANTIATION_IMPL_PLAN.md Slice 1, 2026-07-15). Two orthogonal axes
  // every node/observation carries: substantiation_state ∈ {source-vouched,identity-confirmed,unsubstantiated}
  // (decides WHERE it lives — long-term vs short-term prove-or-fade; grade rides as explore-priority) and
  // frame ∈ real|fiction:<work>|domain:<x> (drives the Slice-5 intake wall + Slice-6 fade rate). Nullable +
  // record-only in Slice 1 — nothing gates on them yet. Assigned by lib/substantiation via curation_store.
  `ALTER TABLE kg_observations ADD COLUMN substantiation_state TEXT`,
  `ALTER TABLE kg_observations ADD COLUMN frame TEXT`,
  `ALTER TABLE graph_entities ADD COLUMN substantiation_state TEXT`,
  `ALTER TABLE graph_entities ADD COLUMN frame TEXT`
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

function endSession(id) {
  if (!id) return;
  getDb().prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);
}

function insertTurn({ sessionId, speaker, content, model = null, truncated = 0, unprompted = 0 }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO turns (session_id, ts, speaker, content, model, truncated, unprompted) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, ts, speaker, content, model, truncated, unprompted ? 1 : 0);
  return { id: info.lastInsertRowid, ts };
}

function getRecentTurns(n) {
  // last N turns across history, oldest first
  const rows = getDb()
    .prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?')
    .all(n);
  return rows.reverse();
}

// --- episodic recall: turn embeddings (for "what did we say earlier about X") ---
function setTurnEmbedding(id, embedding) {
  getDb().prepare('UPDATE turns SET embedding = ? WHERE id = ?').run(embedding, id);
}
// user + ai_said turns that carry an embedding, newest first, capped (small N → cosine in JS).
function getEmbeddedTurns(limit = 400) {
  return getDb()
    .prepare("SELECT id, speaker, content, embedding FROM turns WHERE embedding IS NOT NULL AND speaker IN ('user','ai_said') ORDER BY id DESC LIMIT ?")
    .all(limit);
}
// recent user/ai_said turns MISSING an embedding (for one-time backfill), newest first.
function getTurnsMissingEmbedding(limit = 300) {
  return getDb()
    .prepare("SELECT id, content FROM turns WHERE embedding IS NULL AND speaker IN ('user','ai_said') ORDER BY id DESC LIMIT ?")
    .all(limit);
}

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
function insertMonologue({ content, model = null, feedContext = null, type = 'thought', query = null, urls = null, importance = null }) {
  const ts = Date.now();
  const info = getDb()
    .prepare('INSERT INTO monologue (ts, model, content, feed_context, type, query, urls, importance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ts, model, content, feedContext ? JSON.stringify(feedContext) : null, type, query, urls ? JSON.stringify(urls) : null, importance);
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
function getActiveOpenThreads(limit = 10, { includeStalled = true } = {}) {
  const statuses = includeStalled ? `('pending','active','stalled')` : `('pending','active')`;
  return getDb()
    .prepare(`SELECT * FROM open_threads
      WHERE status IN ${statuses}
      ORDER BY last_touched_ts ASC LIMIT ?`)
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

function touchOpenThread(id, note = null) {
  const now = Date.now();
  const cur = getDb().prepare('SELECT progress_notes, status FROM open_threads WHERE id = ?').get(id);
  if (!cur) return null;
  const notes = cur.progress_notes ? JSON.parse(cur.progress_notes) : [];
  if (note) notes.push({ ts: now, progress: note });
  // pending → active on first touch
  const newStatus = cur.status === 'pending' ? 'active' : cur.status;
  getDb()
    .prepare(`UPDATE open_threads
      SET status = ?, progress_notes = ?, last_touched_ts = ?
      WHERE id = ?`)
    .run(newStatus, JSON.stringify(notes), now, id);
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
function upsertConversationState(sessionId, summary, turnCount = null) {
  const now = Date.now();
  getDb().prepare(`INSERT INTO conversation_state (session_id, summary, turn_count, updated_ts)
      VALUES (?, ?, COALESCE(?, 0), ?)
      ON CONFLICT(session_id) DO UPDATE SET
        summary = excluded.summary,
        turn_count = COALESCE(?, conversation_state.turn_count + 1),
        updated_ts = excluded.updated_ts`)
    .run(sessionId, summary, turnCount, now, turnCount);
  return { sessionId, ts: now };
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

function insertDocument({ title = null, body, source = null, ref = null, understanding = null, parentId = null, version = 1 }) {
  if (!body || !String(body).trim()) return null;
  const ts = Date.now();
  const info = getDb()
    .prepare(`INSERT INTO documents (title, body, source, ref, understanding, parent_id, version, promoted, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(title, String(body), source, ref, understanding, parentId, version, ts, ts);
  _kgTap('doc.land', title || ref || ('#' + info.lastInsertRowid));
  return { id: info.lastInsertRowid, ts };
}

// Latest document row for an external ref (idempotent landing + iteration parent lookup). Newest first.
function getDocumentByRef(ref) {
  if (!ref) return null;
  return getDb().prepare('SELECT * FROM documents WHERE ref = ? ORDER BY id DESC LIMIT 1').get(ref) || null;
}

function getDocument(id) {
  if (!id) return null;
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
}

// Recent documents, newest first. opts.unpromotedOnly limits to short-term (not yet consolidated).
function recentDocuments(n = 20, { unpromotedOnly = false } = {}) {
  const where = unpromotedOnly ? 'WHERE promoted = 0' : '';
  return getDb().prepare(`SELECT * FROM documents ${where} ORDER BY id DESC LIMIT ?`).all(Math.max(1, n | 0));
}

// Un-promoted documents for the nightly promotion pass (Slice 2), oldest first (FIFO consolidation).
function listUnpromotedDocuments(limit = 100) {
  return getDb().prepare('SELECT * FROM documents WHERE promoted = 0 ORDER BY id ASC LIMIT ?').all(Math.max(1, limit | 0));
}

// Keyword search over title+body (simple LIKE; embedding search can layer on later). Newest first.
function searchDocuments(queryLike, n = 10) {
  const q = `%${String(queryLike || '').trim()}%`;
  return getDb().prepare('SELECT * FROM documents WHERE title LIKE ? OR body LIKE ? ORDER BY id DESC LIMIT ?').all(q, q, Math.max(1, n | 0));
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
function updateKnowledge(id, { content, embedding = null, importance = null } = {}) {
  if (!id || !content || !String(content).trim()) return false;
  const now = Date.now();
  const sets = ['content = ?', 'last_used_ts = ?'];
  const args = [String(content).trim(), now];
  if (embedding != null) { sets.push('embedding = ?'); args.push(embedding); }
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
function graphInsertEntity({ name, nameKey, entityType, entitySubtype = null, summary = null, confidence = 0.8, epistemic = 'told', confirmed = null, proposedBy = null }) {
  const now = Date.now();
  const info = getDb().prepare(
    `INSERT INTO graph_entities (name, name_key, entity_type, entity_subtype, summary, confidence, epistemic, confirmed, proposed_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(name, nameKey, entityType, entitySubtype, summary, confidence, epistemic, confirmed, proposedBy, now, now);
  return { id: info.lastInsertRowid, created_at: now };
}
function graphGetEntityByKey(nameKey) {
  return getDb().prepare('SELECT * FROM graph_entities WHERE name_key = ?').get(nameKey) || null;
}
function graphGetEntity(id) {
  return getDb().prepare('SELECT * FROM graph_entities WHERE id = ?').get(id) || null;
}
function graphUpdateEntity(id, fields = {}) {
  const allowed = ['name', 'entity_type', 'entity_subtype', 'summary', 'confidence', 'epistemic', 'confirmed', 'proposed_by'];
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
  getDb().prepare(
    `INSERT INTO graph_relations (source_id, target_id, relation_type, confidence, epistemic, confirmed, proposed_by, created_at, valid_from, valid_to, deleted)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,0)
     ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
       confidence = excluded.confidence, epistemic = excluded.epistemic,
       confirmed = excluded.confirmed, deleted = 0`
  ).run(sourceId, targetId, relationType, confidence, epistemic, confirmed, proposedBy, now, validFrom == null ? now : validFrom);
  // lastInsertRowid is unreliable on an upsert-update path — re-read the canonical row.
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
function graphListPromotableUp(limit = 200) {
  return getDb().prepare(
    `SELECT r.id, r.relation_type, r.confidence, r.epistemic,
            se.name AS source_name, te.name AS target_name,
            (SELECT s.ref FROM graph_citations c JOIN graph_sources s ON s.id = c.source_id
              WHERE c.fact_kind = 'relation' AND c.fact_id = r.id AND s.ref IS NOT NULL LIMIT 1) AS cite_url
       FROM graph_relations r
       JOIN graph_entities se ON se.id = r.source_id
       JOIN graph_entities te ON te.id = r.target_id
      WHERE r.deleted = 0 AND r.valid_to IS NULL AND r.promoted_up = 0
        AND r.epistemic IN ('witnessed','told','read','anticipated')
      ORDER BY r.confidence DESC, r.id
      LIMIT ?`
  ).all(limit);
}
function graphMarkPromotedUp(id) {
  getDb().prepare('UPDATE graph_relations SET promoted_up = 1 WHERE id = ?').run(id);
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
function recordKgObservation({ feed, sourceEntity, relation = null, target = null, value = null, url = null, grade = null, confidence = null, kind = null, status = 'promoted', substantiationState = null, frame = null, obsKey, capturedAt = null }) {
  const ts = capturedAt == null ? Date.now() : capturedAt;
  const info = getDb().prepare(
    `INSERT OR IGNORE INTO kg_observations
       (feed, source_entity, relation, target, value, url, grade, confidence, kind, status, substantiation_state, frame, obs_key, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(feed, sourceEntity, relation, target, value, url, grade, confidence, kind, status, substantiationState, frame, obsKey, ts);
  if (info.changes > 0) _kgTap('observe', sourceEntity + (relation ? ' ' + relation + (target ? ' ' + target : '') : ''));
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
    const docs = getDb().prepare(
      `SELECT id FROM documents WHERE source IN (${sIn}) ORDER BY created_ts DESC LIMIT ?`
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
function getTranscriptSince(ts, limit = 2000) {
  return getDb().prepare('SELECT id, meeting, speaker, text, ts FROM meeting_transcript WHERE ts >= ? ORDER BY ts ASC, id ASC LIMIT ?').all(ts || 0, limit);
}
function countTranscriptSince(ts) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM meeting_transcript WHERE ts >= ?').get(ts || 0).n;
}

function graphCounts() {
  const one = (t) => getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return {
    entities: one('graph_entities'), relations: one('graph_relations'), sources: one('graph_sources'),
    entityProposals: one('graph_entity_proposals'), relationProposals: one('graph_relation_proposals')
  };
}

module.exports = {
  init,
  getDb,
  startSession,
  endSession,
  insertTurn,
  getRecentTurns,
  setTurnEmbedding,
  getEmbeddedTurns,
  getTurnsMissingEmbedding,
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
  recentThreadGoals,
  pendingUserAssignedThread,
  getAllOpenThreads,
  getOpenThread,
  markOpenThreadStatus,
  touchOpenThread,
  incrementThreadMention,
  incrementThreadAction,
  mergeOpenThread,
  insertOpenQuestion,
  getPendingOpenQuestions,
  resolveOpenQuestions,
  getConversationState,
  upsertConversationState,
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
  getDocument,
  recentDocuments,
  listUnpromotedDocuments,
  searchDocuments,
  markDocumentPromoted,
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
  getAssistantAliases,
  seedOwnerIdentity,
  getMetaKeysLike,
  // graph memory (anti-glob relational store)
  graphInsertEntity,
  graphGetEntityByKey,
  graphGetEntity,
  graphUpdateEntity,
  graphListEntities,
  graphInsertRelation,
  graphGetRelation,
  graphNeighbors,
  graphRelationsAmong,
  graphListPromotableUp,
  graphMarkPromotedUp,
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
  countTranscriptSince,
  DB_PATH
};
