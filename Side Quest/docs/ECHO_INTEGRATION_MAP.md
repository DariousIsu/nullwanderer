# Echo ↔ Zoe Integration Map

_Started 2026-06-22. The "Zoe wears the Echo suit" build. Companion to memory `project_nx_echo_zoe_integration`._

## The model

Echo is not something Zoe *connects to as a peer* — Echo is the **suit she wears**: **518 pre-mapped tools** (data + KG), an independent agent workforce, and a governed frontier-model fuel line, navigated via Echo's own self-describing **atlas** (small-model-validated). Echo's *own* intelligence (Saga's chat brain + the deliverable voice) gets retired; **Zoe is the only mind in the system**, driving the suit.

Echo's LLM layer is already a clean chokepoint (audited): `llm_gateway.py` routes persona/orchestrator/long_context to Ollama Cloud frontier models with a local floor, retry, circuit-breaker, and a GPU-time **governor**; `tier_router.py` decides deterministic-vs-LLM; `swarm.py` runs the parallel agent workforce. Saga (`echo/saga/brain.py`) is just `Agent(model) + FastMCPToolset(external) + system_prompt` — so "retire the brain, keep the toolset" is the move, with Zoe replacing Saga on top of the toolset.

## Transport — DECIDED: stdio (Zoe spawns Echo)

Zoe launches `python -m echo.mcp_server` (Echo's default stdio mode) as a **child process** and frames MCP JSON-RPC over its stdin/stdout. She owns the suit's process — boots it with her. No HTTP port, no token surface. (An HTTP transport is also built, for connecting to a separately-running Echo, but stdio is the chosen path.)

## Built so far (inert — not wired into her live loops, no reboot)

- **`lib/echo.js`** — transport-agnostic MCP client (the keyhole, Zoe's side):
  - protocol core: `initialize` → `tools/list` → `tools/call`, JSON-RPC id/error handling, tool cache.
  - `stdioTransport` — spawns Echo, newline-delimited JSON framing, id correlation, request timeout, lifecycle. `spawnEcho()` reads `ECHO_CWD` (nx-echo repo root) + `ECHO_PYTHON`.
  - `httpTransport` — Streamable-HTTP (bearer `NX_ECHO_SHARED_TOKEN`, JSON+SSE bodies, session id).
- **`scripts/smoke_echo_client.js`** — 22/22 offline (mock transport + fake child process; no real Echo, no reboot).
- **LIVE CONNECTION VERIFIED 2026-06-22** — `spawnEcho()` → `initialize` (`nx-echo v3.3.1`) → `tools/list` = **518 tools** → `callTool` round-trips. Params: `ECHO_PYTHON=C:/Users/azrae/Desktop/NX ECHO/nx-echo/.venv/Scripts/python.exe`, `ECHO_CWD=C:/Users/azrae/Desktop/NX ECHO/nx-echo`, launch `python -m echo.mcp_server`. Cold boot ≈ **26s** (loads the big DBs). All 10 atlas/introspection tools present + working: `get_atlas`, `get_tool_map`, `describe_tool`, `get_db_map`, `get_schema`, `get_usage_guide`, `get_master_index`, `get_corpus_inventory`, `get_integration_status`, `summarize_universe` (+ `db_query`).

## Decisions — LOCKED 2026-06-22

1. **Live connection** — ✅ done & verified (see above).
2. **Access tier** — **read + propose**: reader scope for all search/retrieve/KG-read + `db_query`, plus the curation pipeline (`propose_entity`/`propose_relation`/`propose_link`/`decide_resolution_proposal`). NOT admin/direct-write. A **daily cloud-model Echo agent processes her proposals** (review → promote/verify) — that review job IS the subconscious-tick's mandate.
3. **Saga/chat strip** — **deferred to LAST** (not blocking; Echo's tools work today regardless). `saga_render_*` / `vault_render_*` / `saga_canvas_*` are CONFIRMED separable from the brain → they survive as suit templates Zoe drives directly. Saga retirement = remove `build_saga_agent()` + `/saga/chat` (~150 lines `http_routes.py` + `saga/brain.py`); the LLM gateway + agent workforce + data/verification spine are untouched.
4. **Corpus** — she wears the live Rainey KB (read), curates via propose+verify; truth/commit authority stays in Echo's verification spine + Lucas.

## LOCKED DESIGN — Component 2: atlas-first dispatch bridge

The suit is navigated through Echo's OWN **atlas** (the self-describing introspection layer Lucas built + small-model-validated), NOT a hardcoded tool subset. A 24B holds ~5 navigation verbs, not 518 tools, and reaches the whole surface on demand the way the atlas was tested.

**Lifecycle.** ONE persistent Echo process per session (26s cold boot → never spawn per-call). Spawned in the BACKGROUND shortly after her model warms (non-blocking — boot isn't held for 26s), held warm for the session, surfaced as a status indicator like her browser; auto-restart on death. `lib/echo.js` `spawnEcho()` already does the spawn/lifecycle.

**Context pinning.** On connect, call `get_usage_guide()` + `get_atlas()` once and pin their output into a cached **Echo-suit context block** (refreshed on reconnect), so the map + contract are always in front of her — matches Echo's own "load this BEFORE other tool calls" contract. This is the only always-on Echo context.

**Her tags (the ~5 navigation verbs):**
- `<echo-guide>` → `get_usage_guide` / `get_atlas` — (re)load the contract + map.
- `<echo-find>` → `get_tool_map` (intent-grouped) then `describe_tool(name)` — discover & inspect a capability (describe_tool returns schema + up-to-5 real successful-invocation examples = built-in few-shot).
- `<echo-do>` → generic `callTool(name, args)` — invoke ANY of the 518 by name once found. (Tool errors return as structured CONTENT, not thrown — the bridge inspects results for `isError`/validation text and feeds that back to her so she can self-correct args.)
- `<echo-delegate>` → `spawn_agent_async` + poll `agent_inbox`/`agent_status` — hand heavy/multi-step jobs to a cloud agent; integrate when it lands (rides her existing inbound-message + heartbeat machinery).
- `<echo-propose>` → `propose_entity` / `propose_relation` / `propose_link` — her curation (read+propose tier).

**Optional fast-paths** (optimization, not backbone): pin `search_knowledge` + `db_query`-via-atlas-recipes as direct shortcuts for the constant-use lookups; everything else routes through `<echo-find>`→`<echo-do>`.

**Build order from here:** (2) this bridge as a new inert `lib/` layer + tags in her dispatcher + the suit-context block + warm-process lifecycle, hard-smoked offline against a mock transport (then a live-connection smoke); → (3) subconscious tick = the daily proposal-processing cloud agent + ~hourly consolidation; → (4) Saga/chat retirement (Echo-side, last). Wiring into her live loops needs a reboot (gated on Lucas's approval).
