# Organ Donor Registry — 2026-08-03

The missing mechanisms in Zoe's harness-ported organs ("hollow transplants" — see [PROGRAM_REVIEW_2026-08-03.md](PROGRAM_REVIEW_2026-08-03.md)) all live in published harness code. This registry maps each missing organ to verified donor source, breaks down the donor's mechanism, and states the circulation spec — *what happens between the model's calls* — that must come with the transplant.

**Standing rule:** no organ gets installed from recollection. Every install cites (1) donor source below, (2) where applicable, an observed trace from Claude Code's own session transcripts on this machine (`C:\Users\azrae\.claude\projects\` — JSONL records of compaction boundaries, subagent spawns, truncation-with-continuation), and (3) a circuit-proof: all six transplant-checklist links fired live.

**The transplant checklist** (every organ ships with explicit answers or doesn't ship):
1. **Cursor** — when output exceeds the cap, what call gets the rest?
2. **Iteration** — who decides "done," and does the budget assume the loop or the single pass?
3. **Fan-out** — what feeds it work, and is that feeder ON in the default config?
4. **Compaction** — what survives when the loop's own history outgrows the window?
5. **Enforcement point** — is the rule at a choke point, or per-caller by convention?
6. **Discoverability** — does the model that's supposed to use it SEE it in its prompt?

Link-stability notes (verified 2026-08-03): Anthropic Agent SDK docs canonical host is now `code.claude.com` (platform.claude.com 307-redirects there). OpenAI Codex docs serve from `learn.chatgpt.com` (developers.openai.com 308-redirects). OpenHands org renamed from All-Hands-AI.

---

## O1 — Compaction <a name="o1-compaction"></a>

**Fixes:** operator history shredding early reads (`lib/operator.js:156` uncapped `history`); heartbeat `[fit]` evicting 4–10 turns every beat with no summary (28×/session); local-fallback prompt overruns.

**Donors:**
- Claude Agent SDK auto-compaction — [code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview); API-level compaction: [platform.claude.com/docs/en/build-with-claude/compaction](https://platform.claude.com/docs/en/build-with-claude/compaction). Emits a `compact_boundary` system message with `compact_metadata.trigger` + `pre_tokens`; server-side `compact_20260112` triggers at 150k input tokens by default and replaces everything before a compaction block with a model-written summary.
- gemini-cli `ChatCompressionService` — [packages/core/src/context/chatCompressionService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts) (Apache-2.0; call site [client.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/client.ts)). Constants: `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` (fraction of model window), `COMPRESSION_PRESERVE_THRESHOLD = 0.3` (newest 30% kept verbatim), `COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET = 50_000` (oversized tool outputs truncated first). `findCompressSplitPoint()` picks the oldest safe boundary (user message, no dangling function responses); older history is summarized into a structured `<state_snapshot>` (goals/progress/state); a verification pass confirms actual token reduction before replacing history.
- OpenHands `LLMSummarizingCondenser` — [openhands-sdk/…/context/condenser/](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-sdk/openhands/sdk/context/condenser) (MIT; docs: [arch/condenser](https://docs.openhands.dev/sdk/arch/condenser), [guides/context-condenser](https://docs.openhands.dev/sdk/guides/context-condenser)). Fires past `max_size` (default 120 events), keeps `keep_first` head events (default 4 — system prompt + task), keeps a recent tail, replaces the middle with a summary targeting `max_size // 2`, records a `Condensation` event listing forgotten IDs; `CondensationRequest` forces it on context-window errors.
- Anthropic context editing (`clear_tool_uses_20250919`) — [platform.claude.com/docs/en/build-with-claude/context-editing](https://platform.claude.com/docs/en/build-with-claude/context-editing): clear old tool RESULTS first (`trigger` 100k, `keep` 3 recent pairs, placeholder left where content removed) — cheaper than summarizing and often sufficient.

**Circulation spec:** compaction is (a) threshold-triggered as a *fraction of the actual window* (never a constant), (b) boundary-safe (never splits a tool call from its result), (c) summary-producing (eviction leaves a structured summary, never a hole), (d) tool-results-first (clear/truncate bulky outputs before touching dialogue), (e) verified (token count must actually drop), (f) marked (a visible boundary event, so downstream knows it happened).

**Install in Zoe:** `lib/operator.js` (`_buildPrompt` history), `main.js` heartbeat `[fit]` path, the local-fallback prompt builder. Threshold from `cloud_window.resolve(model)`, not literals. **Proof gate:** a 20-step operator run where step 20's prompt still contains a summary of step 2's findings; a heartbeat session with zero un-summarized turn drops.

---

## O2 — Cursors / pagination <a name="o2-cursors"></a>

**Fixes:** `readSource` 24k cap with a fake "ask again for a later section" (no offset param — 97.7% of main.js unreachable); the map/search escape hatches that reference each other while both are broken.

**Donors:**
- Claude Code's own Read/Grep tool contracts — dumpable verbatim from a running session (the schemas are in-context): Read takes `offset` + `limit` (line-addressed, `cat -n` format); Grep bounds *results* (`head_limit`, `offset`) never the corpus, and every truncation states what was dropped and how to get the rest.
- Anthropic memory tool command spec — [platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) + reference implementations: [anthropic-sdk-python examples/memory/basic.py](https://github.com/anthropics/anthropic-sdk-python/blob/main/examples/memory/basic.py), [anthropic-sdk-typescript examples/tools-helpers-memory.ts](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/examples/tools-helpers-memory.ts), [claude-cookbooks tool_use/memory_cookbook.ipynb](https://github.com/anthropics/claude-cookbooks) (MIT). Worth copying for its *return-string discipline*: exact per-command result formats (6-char right-aligned line numbers, mandated error strings, path-traversal rejection) — the contract precision that makes a tool learnable by a model.

**Circulation spec:** a cap is a page size only if the same tool accepts a position argument and the truncation note names it with values (`first 24000 of 1026566 chars — call source_read with offset=24000`). The continuation must be *tested*: page 2 must actually return page 2.

**Install in Zoe:** `lib/self_source.js:99` (`readSource(rel, {offset, maxChars})`), tool schema at `main.js:9755`, same pattern for any capped read surface. **Proof gate:** smoke asserting `readSource('main.js',{offset:24000})` returns different content than offset 0, and that the truncation note's suggested call works verbatim.

---

## O3 — Repo map / source outline <a name="o3-repomap"></a>

**Fixes:** `sourceMap` 9k truncation showing 46/1,113 files; no navigable view of a 1 MB `main.js`; docs crowding out `lib/`.

**Donor:** Aider repo-map — source: [aider/repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) (Apache-2.0; docs: [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html)). Mechanism from source: `get_tags()` extracts definition/reference tags per file via tree-sitter (SQLite mtime-keyed cache, `cache_threshold = 0.95`); `get_ranked_tags()` builds a directed multigraph (files as nodes, identifier references as edges) and runs `nx.pagerank()` with personalization boosting files already in the conversation; `get_ranked_tags_map_uncached()` **binary-searches the number of included tags** to fit `max_map_tokens` within 15% (`ok_err = 0.15`). Default budget 1,000 tokens, expanding when no files are in chat.

**Circulation spec:** the map is (a) symbol-level, not filename-level, (b) *ranked by relevance to the current task*, not alphabetical, (c) sized to a token budget by search, not truncated at a char count, (d) cached against mtime so it's cheap to rebuild.

**Install in Zoe:** replace `sourceMap()`'s alphabetical dir-dump (`lib/self_source.js:82-96`) with rank-and-fit (JS: tree-sitter via `web-tree-sitter` or a regex symbol extractor for .js as v1); add `source_outline {path}` returning exports + line numbers for one file. **Proof gate:** `sourceMap()` for a review turn includes `main.js` and the top `lib/` modules by reference-rank; `source_outline('main.js')` returns a navigable symbol list under 20k chars.

---

## O4 — Budget enforcement at a choke point <a name="o4-budgets"></a>

**Fixes:** Disease A — quota gate guarding 3 of ~50+ spend sites with `estimate: 1`; ∞/h pacing; in-memory meter; 6-call ungated reply chain; 429 storms.

**Donor:** LiteLLM proxy (MIT, `enterprise/` dir separately licensed) — [virtual keys + max_budget](https://docs.litellm.ai/docs/proxy/virtual_keys), [budgets & rate limits per key/user/team/model](https://docs.litellm.ai/docs/proxy/users), [spend tracking](https://docs.litellm.ai/docs/proxy/cost_tracking), [Ollama fronting](https://docs.litellm.ai/docs/providers/ollama). Mechanism: keys minted with `max_budget` + `budget_duration` (auto-reset, e.g. "30d"); `tpm_limit`/`rpm_limit` and per-model caps; exceeding budget returns a hard 401 (`ExceededTokenBudget`); all spend lands in `LiteLLM_SpendLogs`, queryable, with `x-litellm-response-cost` on every response. Confirmed it fronts Ollama endpoints (`model: ollama_chat/…` → localhost:11434).

**Two install options:**
- **(a) Deploy LiteLLM as-is** between Zoe and ollama.com/localhost: one key per lane (interactive / directed / research / idle), budgets in real units, durable ledger, structurally unbypassable — every one of the 36 direct `require('./ollama')` callers is governed without touching them. Also gives the concurrency limiting that would kill the 429 storm.
- **(b) Port the mechanism** into `lib/ollama.js`/`cloud_logic.js`: admission check (real `costOf` estimate) at `completeDetailed`/`streamChat`/`streamCloud`, durable spend ledger (db meta or `cloud_traces`), per-lane budgets with auto-reset `reset_at`, hard-fail response on exceeded.

**Circulation spec:** enforcement lives where the request *must* pass, not where callers remember to ask; the ledger survives reboot; budgets reset themselves on a clock; the estimate is derived from model × tokens, never a placeholder; refusal is a typed error the caller can catch.

**Proof gate:** set a 1-unit idle budget → the idle lane hard-stops with the typed error while interactive still flows; reboot → `spent()` unchanged.

---

## O5 — Fan-out / subagent scheduling <a name="o5-fanout"></a>

**Fixes:** swarm + background workers dead at `research.workers=1`; no parallel path for work exceeding one context (the reason "review your whole program" is impossible for her in one sitting).

**Donors:**
- Claude Agent SDK subagents — [code.claude.com/docs/en/agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents): agents defined as `name → AgentDefinition {description, prompt, tools, model, permissionMode, background, maxTurns}`; the parent delegates by matching `description`; each subagent runs in a **fresh context and returns only its final message** — that contract (isolation in, summary out) is the load-bearing part.
- OpenHands TaskToolSet / DelegateTool — [docs.openhands.dev/sdk/guides/task-tool-set](https://docs.openhands.dev/sdk/guides/task-tool-set), example [25_agent_delegation.py](https://github.com/OpenHands/software-agent-sdk) (MIT): `register_agent()` named factories; TaskToolSet = blocking/sequential with disk-persisted task IDs for resumption; DelegateTool = parallel spawn-and-collect.

**Circulation spec:** fan-out is (a) fed by a work queue that is ON by default, (b) slot-limited with join semantics, (c) context-isolated — children return conclusions, not transcripts, (d) resumable — a dead child's task survives on disk, (e) discoverable — the parent's prompt says delegation exists and when to use it.

**Install in Zoe:** Echo already has `spawn_agent`/`team_spawn` + `agent_inbox` (the join half works — the drain runs every 5 min). Missing: the feeder defaults (`research.workers=2`, swarm gated by an explicit flag rather than dead-by-config), tier-tagging the spawn tools (Disease B), and a review-lane fan-out: self-review splits `lib/` into shards, one delegate each, parent compiles. **Proof gate:** one live self-review that provably read >20 files via ≥3 parallel delegates and compiled their returns.

---

## O6 — Permission choke point / approvals <a name="o6-permissions"></a>

**Fixes:** Disease H — 430/532 untagged tools; admin token for all traffic; autonomous gate never in force; the phantom `actions.run_powershell` grant; the future shell lane.

**Donors:**
- Claude Agent SDK permissions — [code.claude.com/docs/en/agent-sdk/permissions](https://code.claude.com/docs/en/agent-sdk/permissions): a **fixed six-step pipeline** evaluated at dispatch — hooks (PreToolUse) → deny rules → ask rules → permission mode → allow rules → `canUseTool` callback. Key property: deny rules and hooks apply **even in bypassPermissions mode** — there is no mode that disables the choke point itself.
- Codex CLI sandbox/approvals — [repo](https://github.com/openai/codex) (Apache-2.0), docs: [sandboxing](https://learn.chatgpt.com/docs/sandboxing). Current terms: `sandbox_mode` = `read-only` | `workspace-write` | `danger-full-access`; `approval_policy` = `untrusted` | `on-request` | `on-failure` | `never`. Two load-bearing ideas: (1) the sandbox is **OS-enforced on spawned commands** (Seatbelt / bubblewrap), not an allowlist the model can route around; (2) an approval **runs the one command outside the sandbox without widening the standing boundary** — escalation is per-action, never persistent. Both keys are deliberately ignored in project-local config so a repo can't grant itself power.

**Circulation spec:** permission is evaluated once, at dispatch, in a fixed order; the mutating default is deny; approval is per-action and non-widening; the model can never edit its own grants (Zoe already has this right: `os_set_policy`/`os_approval_resolve` outside the autonomous carve — keep it).

**Install in Zoe:** Echo tag-by-default wrapper (everything `write` unless in an explicit read allowlist), entitlements *generated* from the registry; Side Quest on the reader token except `dispatch`; route `pollCallTool` through `EchoSuit.dispatch`; the shell lane gets a distinct `shell` tier NOT admitted by `DESKTOP_CONTROL_RE`, with `SENSITIVE_TARGETS` confirm retained. **Proof gate:** reader-token session provably cannot call `gui_do`/`spawn_agent`/`browser_click`; a shell command on the autonomous loop is refused with a door-naming message.

---

## O7 — Iteration-trusted agent loop (Ollama-native references) <a name="o7-loop"></a>

**Fixes:** 4-step chat-turn operator; "coverage from one pass" assumptions; the write→run→read→fix cycle the analysis lane can't complete.

**Donors (all run her model fleet — reference AND potential scaffold):**
- goose — [github.com/block/goose](https://github.com/block/goose) (Apache-2.0, Linux Foundation), providers docs incl. Ollama: [goose-docs.ai/docs/getting-started/providers](https://goose-docs.ai/docs/getting-started/providers). MCP-native tool surface (70+ extensions), install/execute/edit/test loop; docs explicitly note non-tool-calling models degrade — relevant to kimi/gemma capability testing.
- opencode — [github.com/sst/opencode](https://github.com/sst/opencode) (MIT), providers: [opencode.ai/docs/providers](https://opencode.ai/docs/providers) — any OpenAI-compatible endpoint via `@ai-sdk/openai-compatible` with `baseURL: "http://localhost:11434/v1"`, per-model `context`/`output` overrides (a live example of window-derived caps).
- Aider's edit loop — [github.com/Aider-AI/aider](https://github.com/Aider-AI/aider) (Apache-2.0): edit → lint/test → feed failures back → retry as a loop property.

**Circulation spec:** the model decides "done" inside a generous ceiling; errors are inputs to the next iteration, not terminal; per-call output is bounded because the loop provides continuation; entering a work lane (script/review) raises the step budget automatically.

**Install in Zoe:** step budget keyed to lane (`main.js:9886`: review/script lanes get 24+/300s); `analysis_lane` workbench persistence (the dropped arg) so iteration has state; retry-on-stderr steer in the operator prompt. **Proof gate:** one turn where a script fails, she reads stderr, edits, re-runs, and succeeds — all inside one operator run.

---

## O8 — Memory write discipline <a name="o8-memory"></a>

**Optional donor for the ledger work:** the memory tool's command set (`view/create/str_replace/insert/delete/rename` against a jailed path prefix) and its auto-injected "check memory first / assume interruption" system line — [memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). Relevant to `self_dev`/changelog self-writing (M2.5) and to making owner_world edits model-driveable later without a new bespoke API each time.

---

## License summary
Apache-2.0: aider, gemini-cli, codex, goose. MIT: opencode, OpenHands, LiteLLM (core), Anthropic Python SDK + cookbooks. **Flag:** Claude Agent SDK **TypeScript** repo is under Anthropic's Commercial Terms (read as reference; don't vendor); LiteLLM `enterprise/` dir is commercially licensed (core proxy is MIT and sufficient).
