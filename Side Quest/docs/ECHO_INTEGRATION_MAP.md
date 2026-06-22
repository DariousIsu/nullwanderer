# Echo ↔ Zoe Integration Map

_Started 2026-06-22. The "Zoe wears the Echo suit" build. Companion to memory `project_nx_echo_zoe_integration`._

## The model

Echo is not something Zoe *connects to as a peer* — Echo is the **suit she wears**: ~400 pre-mapped tools (data + KG), an independent agent workforce, and a governed frontier-model fuel line. Echo's *own* intelligence (Saga's chat brain + the deliverable voice) gets retired; **Zoe is the only mind in the system**, driving the suit.

Echo's LLM layer is already a clean chokepoint (audited): `llm_gateway.py` routes persona/orchestrator/long_context to Ollama Cloud frontier models with a local floor, retry, circuit-breaker, and a GPU-time **governor**; `tier_router.py` decides deterministic-vs-LLM; `swarm.py` runs the parallel agent workforce. Saga (`echo/saga/brain.py`) is just `Agent(model) + FastMCPToolset(external) + system_prompt` — so "retire the brain, keep the toolset" is the move, with Zoe replacing Saga on top of the toolset.

## Transport — DECIDED: stdio (Zoe spawns Echo)

Zoe launches `python -m echo.mcp_server` (Echo's default stdio mode) as a **child process** and frames MCP JSON-RPC over its stdin/stdout. She owns the suit's process — boots it with her. No HTTP port, no token surface. (An HTTP transport is also built, for connecting to a separately-running Echo, but stdio is the chosen path.)

## Built so far (inert — not wired into her live loops, no reboot)

- **`lib/echo.js`** — transport-agnostic MCP client (the keyhole, Zoe's side):
  - protocol core: `initialize` → `tools/list` → `tools/call`, JSON-RPC id/error handling, tool cache.
  - `stdioTransport` — spawns Echo, newline-delimited JSON framing, id correlation, request timeout, lifecycle. `spawnEcho()` reads `ECHO_CWD` (nx-echo repo root) + `ECHO_PYTHON`.
  - `httpTransport` — Streamable-HTTP (bearer `NX_ECHO_SHARED_TOKEN`, JSON+SSE bodies, session id).
- **`scripts/smoke_echo_client.js`** — 22/22 offline (mock transport + fake child process; no real Echo, no reboot).

## Open decisions (gate the next steps)

1. **Live connection test** — spawn the real Echo over stdio and `tools/list` it (validates the contract end-to-end). Needs Echo's Python env runnable + `ECHO_CWD`/`ECHO_PYTHON`. Spawns a *python* child, not a Zoe reboot — but it's launching your Echo, so it waits for your go.
2. **Tool surface** — which of the ~400 tools does Zoe get, and how do they reach her (a new `<echo …>` tag in her dispatcher vs an auto-exposed subset)?
3. **Retire Saga/chat** (touches your *production* Echo) — do the `saga_render_*`/`vault_render_*` deliverable renderers survive as "suit" templates Zoe drives, or retire with Saga's brain? Whose corpus does she wear (your Rainey KB vs sandbox)?
4. **Frontier path** — the subconscious tick (every ~30–60 min the big model organizes what she's been doing) routes through Echo's governed gateway; confirm model + mandate (consolidation vs planning vs both).

## Next build (once #1/#2 land)

stdio is the seam; the next inert layer is the **tool-dispatch bridge** — surfacing a curated Echo tool subset into her tag system + a `delegate-to-Echo-agent` path — followed by the subconscious frontier tick. Wiring any of it into her live loops requires a reboot (gated on your approval).
