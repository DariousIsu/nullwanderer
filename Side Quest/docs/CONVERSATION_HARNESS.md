# Conversation Harness — structural dialogue scaffolding over the subconscious

**Status: BUILD IN PROGRESS (2026-06-23).** Piece 1 (open-question stack) shipping first.
Grounded in a full audit of the live chat path + a deep-research pass on dialogue-systems
theory. Companion design intent: [MEMORY_REDESIGN.md](MEMORY_REDESIGN.md) (long-term memory),
[MEMORY_GROUNDING.md](MEMORY_GROUNDING.md) (epistemic typing).

## The problem
Zoe has rich first-class machinery for her **interior** (monologue, knowledge retrieval,
lanes, commitments, threads, reflection, self-model) but the **live conversation** is the one
object with almost no first-class state. It floats on a raw 14-turn recency window
(`RECENT_TURN_LIMIT`, main.js) + relevance retrieval, with **zero salience anchors** for "what
we're doing now," "what I just asked," or "what just got said." Three observed failures:

- **A — loses the thread past a few turns.** Budget squeeze: ~3.4–3.8k tokens of static
  scaffolding before any live turns (num_ctx 8192), plus full `<think>` replay per assistant
  turn (context.js), evict the oldest real dialogue.
- **B — asks a question, forgets she asked.** The question text is still in context but
  **unlabeled**; nothing marks it as an open question. The only code that recognizes a
  question (`memory._isQuestionTurn`) exists *to drop questions from recall*.
- **C — disjointed pop-ups.** The interjection gate is backwards: conversational callbacks
  fall to lane HERS=9 (hardest bar); self-contained reading-tangents clear OURS/YOURS=5–6
  (lanes.js). The gate selects *against* the conversational continuations Lucas wants.

## The principle
**Scaffold the conversational structure; don't ask the 24B to infer it.** A local sub-frontier
model's implicit coreference (binding a terse "yeah" to a buried question) is weak — so we do
that binding in deterministic structure, not in the model's head. This is **explicitly the
substrate for a future voice-to-voice gate**: voice removes the scrollback escape hatch (the
structured state *is* her memory of the conversation), voice turns are short/elliptical
(coreference is weakest exactly there), and compact state lowers per-turn latency. The
subconscious is untouched — the harness is an additive layer above it + gate re-tuning.

## The three pieces (grounded, all feasible on the 24B, no fine-tune)

| Piece (fixes) | Canonical grounding | Implementation | Feasible |
|---|---|---|---|
| **1. Open-question stack** (B) | QUD stack — Roberts 2012; Ginzburg KoS / Dialogue Gameboard 1996; Clark & Schaefer grounding (present→accept). A pushed question stays open until resolved; the next move binds to it. | Detect her `<say>` question → record pending → surface labeled high-recency block on next user turn → resolve on reply. `lib/open_questions.js` + `open_questions` table. | ✅ deterministic, no model call |
| **2. Relevance-gated interjection** (C) | DiscussLLM (arXiv:2508.18167) — interjection gated by typed trigger + conversational relevance, default-silent, NOT free-form. QUD relevance constraint (a move that doesn't address the QUD is a non-sequitur). | Add a **callback lane** embedding candidate vs recent conversation turns (not just assignments) at a LOW threshold; feed recent turns into the importance scorer. Gate re-tune at heartbeat.js / lanes.js. | ✅ gate re-tune + one embed |
| **3. Running "where we are now" block** (A) | Recursive Summarization — Wang et al. 2023 (arXiv:2308.15022, validated on 6B); LangChain ConversationSummaryBufferMemory (running summary of old + recent verbatim under a token budget). | Per-session rolling summary updated incrementally each turn, injected as a labeled block; **+ budget hygiene** (cap replayed `<think>`). `conversation_state` row. | ✅ one cheap call/turn |

**Aspirational / not now:** full schema-guided DST (Rastogi AAAI 2020) is task-oriented
slot-filling, overkill for open chat; DiscussLLM's *trained* silent-token needs fine-tuning
(we approximate with the gate); full KoS/DGB formal information-state is more than this buys.

## Phasing (smallest viable first, each gated on a passing hard smoke)
- **Piece 1 — open-question stack. ✅ SHIPPED 2026-06-23** (`smoke_open_questions.js` 15/15).
- **Piece 2 — register gate + thread hygiene. ✅ SHIPPED 2026-06-23** (`smoke_register_gate.js` 19/19).
  Re-scoped from "pop-up gate" after a live diagnostic showed the dominant appropriateness
  failure was **open_threads bleeding into personal chat** (see below), not the pop-ups.
- **Piece 3 — running state block + budget hygiene. ✅ SHIPPED 2026-06-23** (`smoke_convo_state.js` 11/11).

## Piece 3 — what shipped (the lose-the-thread fix)
- **3b — running "where we are now" summary** (`lib/convo_state.js` + `conversation_state` table):
  recursive summarization (Wang 2023) — after each exchange, `update()` folds the latest turn into
  the prior summary (~120 words), **async + non-blocking** (fired after the reply is sent, one bounded
  call). `buildBlock()` injects it as a labeled WHERE-WE-ARE anchor ([context.js](../lib/context.js))
  so the conversation's arc survives turns scrolling out of the 14-turn window — and it's the voice-gate
  substrate (no scrollback to lean on). Wired in [main.js](../main.js): gather → pass → post-reply update.
- **3a — `<think>`-replay budget hygiene** ([context.js](../lib/context.js)): the turn-replay loop now
  caps full interior to the most-recent `KEEP_FULL_THINK=2` assistant turns; older assistant turns replay
  only `<say>`. Replaying every interior verbatim was evicting real dialogue under num_ctx 8192; the
  running summary now carries the older arc, so the budget goes to live conversation.
- **Known gaps:** (a) the summary update is one model call per turn (async, off the hot path) — fine on the
  loaded 24B; revisit if latency shows. (b) `KEEP_FULL_THINK=2` is a fixed cap, not budget-aware; a
  token-counted trim is a later refinement.

## Piece 2 — what shipped (the corporate-reply fix)
**Live failure (2026-06-23):** "Hey Zo, how are you doing?" → she answered with a status report,
thanked Lucas for a meeting reminder he never gave, talked "professionalism / active listening /
boundaries," and signed "Best, Zoe." DB diagnosis: the top-3 active `open_threads` are pinned at
**primacy** ([context.js:231](../lib/context.js)) every turn; among them self-coaching goals
("maintain professionalism in meetings", "ensure warm welcoming with new people"). 18 active
threads, runaway mention counts, **no active→stalled decay**, and `personal_mode=off`. So her most
heavily-weighted context on a warm check-in was professionalism self-coaching — which her idle loop
*also* worked, generating training-manual monologue ("prepare a standard greeting…").

**The fix (register separation — the harness thesis applied to threads):**
- `intent.isSocialTurn(msg)` — detects a personal/check-in turn (greeting / "how are you" / endearment),
  never fires on a task (`isActionable` wins) or a work-progress check ("how are you doing on the op-ed").
- On a social turn ([main.js](../main.js)): the work-thread **primacy block is withheld** (`openThreads=[]`)
  and the capability-proposal-on-return is suppressed; [context.js](../lib/context.js) appends a
  high-recency **register nudge** ("this is personal — be present, no professionalism/agenda/email signoff").
  Her threads still drive her idle loop + tools — they just stop colonizing a check-in.
- **Thread decay:** `curator.curateThreads` now ages **active/pending → stalled** at
  `ACTIVE_STALE_DAYS=10` (nothing demoted active threads on neglect before), feeding the existing
  stalled→abandoned(14d). One-time curation abandoned the two corporate threads (148/149).

**Known gaps:** (a) `personal_mode` is still a manual toggle — the register gate is per-turn and
automatic, but a full "off the clock" mode is separate. (b) `open_threads.js` extraction can re-mint
"professionalism"-type goals from a future meeting-prep turn; the register gate prevents the *bleed*
either way, but extraction tuning is a follow-up. (c) Her core drive #1 ("sharpen how you talk", thread 4)
still lives in `open_threads` — arguably belongs in `self_model`; left alone (the gate stops it bleeding).

## Piece 1 — what shipped
- `open_questions` table (db.js migration): `session_id, question, asked_turn_id, status
  (pending|answered|dropped), answer_turn_id, created_ts, resolved_ts` + index.
- `lib/open_questions.js`: `extractQuestion(say)` (trailing-question sentence), `recordFromSay`
  (store pending), `takePending` (fetch + resolve once, no nag), `buildBlock` (the labeled
  prompt string).
- Wiring (main.js): **detect** after her `ai_said` is stored → `recordFromSay`; **surface +
  resolve** on the next user turn → `takePending` → `openQuestionBlock`; passed to
  `buildChatPrompt`.
- Injection (context.js): `openQuestionBlock` prepended to the user message at the very tail
  (highest recency), so a terse reply binds to her question.
- Smoke: `scripts/smoke_open_questions.js`.

**Known v1 gaps (intentional, noted):** (a) detection runs on the main chat say-storage only;
the post-tool `fireToolFollowup` path doesn't yet record questions she asks in a tool
follow-up. (b) `extractQuestion` keys on a trailing `?` — a rhetorical final question can be
mis-captured (low cost: one reminder block). Refine with a 2nd-person cue if it shows up live.

## Sources
| # | Source | Bears on |
|---|---|---|
| 1 | Roberts, *Information Structure: Towards an integrated formal theory of pragmatics* (1996/2012) — QUD stack | Piece 1, 2 |
| 2 | Ginzburg, *The Interactive Stance* / KoS; Dialogue Gameboard (1996) | Piece 1 |
| 3 | Clark & Schaefer, *Contributing to Discourse* (1989); Clark & Brennan, *Grounding in Communication* (1991) | Piece 1 |
| 4 | Purver & Ginzburg — clarification requests in the BNC | Piece 1 |
| 5 | DiscussLLM — arXiv:2508.18167 (when-to-interject, silent token, typed triggers) | Piece 2 |
| 6 | Wang et al., *Recursive Summarization for Long-Term Dialogue Memory* — arXiv:2308.15022 | Piece 3 |
| 7 | LangChain `ConversationSummaryBufferMemory` (hybrid summary+recent buffer) | Piece 3 |
| 8 | Rastogi et al., *Schema-Guided Dialogue* — AAAI 2020 (DST; aspirational) | context |
| 9 | LD-Agent — arXiv:2406.05925 (two-tier short/long working memory) | Piece 3 |

> Research note: the deep-research verification pass was rate-limited (verifier votes failed,
> not the claims). Sources above are foundational dialogue-systems literature, confirmed on
> domain knowledge; treat as correctly-sourced. Re-run verification when rate limits clear.
