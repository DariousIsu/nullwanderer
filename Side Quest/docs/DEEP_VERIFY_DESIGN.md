# Deep Agentic Verification — Design Spec

> **Status: DESIGN ONLY (spec for review). No code yet.** Lucas ran the studio's Run checks on a real
> footnoted op-ed (ELI / Walker) and it "ran but shallow" versus the same job done by a frontier agent
> (see `Process_Log_ELI_Oped_Walker_v1.md`). This spec closes that depth gap by upgrading the harness's
> JUDGMENT step from a single caged model call into a per-claim agentic verification that reads primary
> sources, cross-checks independent data, and reasons about precision. Companion to the editor studio.

---

## 1. The gap (measured against the Claude process log)
Today's `studio/verify_harness` runs: extract → resolve → match → preflight → **classify** → contract. The
`classify` leaf is ONE caged model call per gray-band claim: `({claim, passage}) → {status, note}`. That is
shallow next to what the reference process actually did per footnote:

| Claude process did | Our harness does |
|---|---|
| Fetched + **read the full primary document** (39-pp PDF; recovered reversed text) | Matches a fetched **snippet** (lexical + embedding) |
| **Cross-checked each stat against a second, independent source** | Checks the one cited source |
| Flagged **precision caveats** ("1990s" vs. actual 1999–2000; paraphrase-in-quotes) | Single pass/fail-ish verdict |
| Adapted to blocked/JS-gated pages (found syndicated copies) | Resolve has a search fallback, no re-read |
| Emitted a **sources-consulted list** + a non-blocking **fairness/omission note** | Neither |

(A separate, already-fixed bug — docx extraction was dropping footnote hyperlink URLs — was a hard blocker
*upstream* of this; commit `9e974c8`. This spec is about the JUDGMENT depth, the remaining gap.)

## 2. Principle — keep the cheap stages, deepen the judgment
Don't throw away the deterministic pipeline; it correctly fast-paths the easy cases (a verbatim quote that
lexically matches its source needs no frontier model). **Route only the material/hard claims to a deep-verify
agent.** This mirrors the reference process: confirm the obvious fast, *read deeply* where it matters.

Fast-path (existing match, ~0 tokens): clean verbatim quote ↔ source match → Verified.
Deep-verify (new): numbers/statistics, paraphrases-in-quotes, characterizations, any claim whose source
didn't cleanly match, and important claims whose source was inaccessible.

## 3. The deep-verify agent (`studio/verify_deepcheck.js`, per claim)
A bounded agentic loop driving the **strongest available cloud reasoning model** with Echo's web tools the
harness ALREADY injects (`web_extract`, `web_search`, `wayback`). Every I/O dep injected → offline-testable
with mocks (same discipline as the rest of the harness).

**FRONTIER-FIRST MANDATE (Lucas): this is a deliberate, operator-invoked audit — spend for frontier-quality
output, no compromise.** Default to the top reasoning tier (gpt-oss:120b class) with generous reasoning
headroom (high num_predict so a reasoning model isn't truncated) and long context for reading full sources.
Do NOT prefer the smaller/cheaper local tier here — local is a LAST-RESORT fallback only when the cloud is
entirely unavailable, and its output is labeled degraded. Quality beats cost/latency for this pass.

Steps per claim:
1. **Read the source.** Use the resolved source text; if it's large (a long PDF/report), fetch the full doc
   and **locate the relevant passage** (chunk + keyword/embedding locate) rather than trusting a snippet.
2. **Cross-check.** One independent `web_search` for a *second* source that isn't the cited one; fetch the
   top non-blocked hit. Two confirmations beat one.
3. **Judge with a caveat-aware rubric** → structured verdict:
   `{ uid, verdict: verified | verified_caveat | contradicted | unsupported | inaccessible,
      caveat?: string, confidence: 0..1, evidence_quote: string, sources_consulted: [{url,title}] }`.
   The rubric explicitly asks: is the number exact? is a quotation verbatim or a paraphrase presented in
   quotes? does the timeframe/qualifier hold? — the precision checks a single match can't make.
4. **Bounded**: a hard per-claim tool-call budget (e.g. ≤4 fetches/searches) + a global concurrency cap, so a
   run is predictable in cost/latency.

Fallback: no cloud key → degrade to today's caged `classify` leaf (never a hard failure).

## 4. Output enrichment (so the cert/report can match the reference)
The findings contract + templates gain three fields the deep pass produces:
- **caveat** on a finding → renders the "Verified · caveat" pill + the precision note.
- **sources_consulted** (per finding, deduped run-wide) → a "Sources consulted" section in the report/cert
  (the reference cert has this; `lib/sources.js` already has dedupe/render helpers to reuse).
- **omission/fairness note** (run-level, non-blocking) → the auditor's-note field the reference process used
  (e.g. "subject has an on-the-record rebuttal the piece omits"). Author-facing, never a required correction.

## 5. Where it plugs in
- `studio/verify_deepcheck.js` — **new**: the per-claim agentic verify (pure orchestration, injected model +
  web tools). Returns the structured verdict above.
- `studio/verify_harness.js` — route the preflight residue to `deepVerify` when provided, else `classify`
  (one new branch; the pipeline shape is unchanged).
- `lib/editor_checks.js` — build the deep-verify injections (cloud reasoning model endpoint/creds — reuse the
  cloud resolution already in `editor:run-checks`; the same `callTool` web tools) and pass `deepVerify` in.
- `studio/checks_contract.js` — carry `caveat` / `sources_consulted` through to findings.
- `studio/cert_template.js` (`renderReport` + `renderCertificate`) — render caveats, the sources-consulted
  section, and the omission note.
- `main.js` `editor:run-checks` — a **mode** flag: `deep` (agentic, default for real audits) vs `quick`
  (today's local harness). Deep needs the cloud key (already resolved there).
- `renderer/editor.{html,js}` — a "Deep verify" affordance + progress (the run is longer; stream stage ticks).

## 6. Decision — local orchestration, not the Echo Rainey agents
Echo has `delegate_to_rainey_fact_checker` + `delegate_to_rainey_citation_verifier` (a two-pass chain). We do
NOT build on them here: their prompts/tools live in Echo (uncontrollable + untunable from this repo), they
have **zero successful calls on record**, and their async canvas-deliverable model doesn't cleanly return
structured findings to the studio. A local orchestration driving the cloud model with injected web tools is
controllable, tunable (the rubric is ours), testable offline, and returns structured findings directly. The
Rainey delegate path stays available as a future offload, not the primary engine.

## 7. Build slices (deepest-testable first)
- **S0 — the deep-verify agent, pure core.** `verify_deepcheck.js` with injected model + fetch + search →
  the structured verdict. Offline-smoke: a mock source that supports the claim → verified; a mock that differs
  on a number → contradicted with the exact discrepancy; a paraphrase-in-quotes → verified_caveat; an
  inaccessible source with a corroborating search hit → resolved via the second source. No network/model.
- **S1 — harness routing.** `verify_harness` routes residue to deepVerify; `editor_checks` builds the
  injections + cloud creds; quick/deep mode in `editor:run-checks`.
- **S2 — richer output.** contract + cert_template caveats / sources-consulted / omission note.
- **S3 — studio UX.** Deep-verify mode toggle + stage-progress streaming (runs are longer).
- **S4 — calibrate against the benchmark.** Run the ELI op-ed end-to-end; tune the rubric + routing until the
  studio's findings match the reference certification (the 13-claim matrix, the two caveats, the fairness note).
  Ship the ELI paper as a regression fixture.

## 8. Open questions
- **Large-source reading.** Locating the right passage in a long PDF cheaply (chunk + embedding-locate vs.
  feeding the whole doc to a long-context model). Start with chunk+locate; escalate to full-doc for the model
  tier that affords it.
- **Independent-source selection.** How aggressively to require a *second* source — always, or only for
  statistics/headline claims (the reference process cross-checked the two headline stats specifically). Likely
  gate the second-source pass to numeric/headline kinds to bound cost.
- **Cost ceiling.** A real audit is ~13 claims × up to 4 tool calls × a reasoning model — bound per run and
  surface the budget; this is a deliberate, operator-invoked deep pass, not the 30-min background loop.
- **Omission note.** Auto-detected (search for a named rebuttal) vs. an operator-added field. Start operator-
  optional; auto-detection is a later enhancement.
