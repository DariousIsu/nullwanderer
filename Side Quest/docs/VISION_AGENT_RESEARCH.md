# Vision → Action: Research Brief for Zoe's UI Interaction

*Written 2026-06-28. Context: the image layer (chat attachments, `web-see`, `browse-see`, `screen-see`, image files) is live and working. This brief surveys the field of screenshot-driven UI interaction ("GUI agents" / "computer-use") and maps it to Zoe's architecture and the agreed access model.*

## 1. The goal
Close the loop from **seeing** a UI to **acting** on it, reliably:

> **perceive → reason → act → VERIFY → (repeat)**

The verify step — screenshot again to confirm the action landed — is what separates a working agent from demo-ware. Everything below orbits two hard problems: **grounding** (turn "click the blue Submit button" into an exact target) and **recovery** (notice when an action failed and fix it).

## 2. State of the field (2025–26)

**Benchmarks set sober expectations.**
- **OSWorld** — 369 open-ended real-computer tasks (Ubuntu/Windows/macOS). Even SOTA agentic success is modest: a strong grounding module lifts OSWorld success from ~5% to ~**27%**. Open-ended desktop autonomy is *not* solved. ([OSWorld](https://www.emergentmind.com/topics/osworld), [OSWorld-Human efficiency](https://arxiv.org/html/2506.16042v1))
- **OSWorld-G / ScreenSpot-v2 / ScreenSpot-Pro** — isolate *grounding* accuracy (can the model point at the right element?). ScreenSpot-Pro stresses high-res professional UIs. ([OSWorld-G](https://www.emergentmind.com/topics/osworld-g), [ScreenSpot-Pro](https://arxiv.org/html/2504.07981v1))

**Grounding models are the workhorses.**
- **UGround** (OSU-NLP, ICLR'25 Oral) — universal *visual* grounding (screenshot → pixel coords), Qwen2-VL based, **2B / 7B / 72B**, trained on 10M elements / 1.3M screenshots; SOTA on ScreenSpot-Pro. ([UGround](https://osu-nlp-group.github.io/UGround/), [UGround-V1-7B](https://huggingface.co/osunlp/UGround-V1-7B))
- **OS-Atlas** — open foundation *action* model, 2.3M screenshots / 13M elements, good out-of-distribution transfer. ([OS-Atlas](https://arxiv.org/pdf/2410.23218))
- **Small models are viable**: **ZonUI-3B** (3B) matches 7B baselines; **ShowUI** (2B) competitive zero-shot. A 2–3B grounding model is a realistic local component. ([ZonUI-3B](https://arxiv.org/pdf/2506.23491))

**Set-of-Mark (SoM)** — overlay numbered marks on UI elements so the model picks "⑤" instead of guessing coordinates. Powerful with large proprietary models, **but the research is explicit that SoM transfers *poorly* to open-source VLMs, and accuracy drops sharply as element count rises / element size shrinks.** Implication for us below. ([Contrastive Region Guidance / SoM caveats](https://arxiv.org/html/2403.02325v1))

**Hybrid (accessibility tree + vision) is the consensus winner.**
- a11y tree = compact semantic view (roles, labels, focus, validation) → reliable element IDs; vision = sees canvas/video/charts and confirms spatial state.
- "Pure-vision agents hallucinate coordinates and miss off-screen state; pure-a11y agents miss everything in a canvas or video." Best practice: **a11y as primary enumerator, vision for disambiguation + verification, and a fresh a11y snapshot after every action** to keep the model synced. ([Browser-agent architecture/security](https://arxiv.org/pdf/2511.19477))

**Verification / self-reflection loops are now a named technique** — GUI-Reflection, ERL, GUI-R1: synthesize failure cases, learn to detect failure → reason about cause → emit a corrective action. This is the "verify after act" step, formalized. ([Building Browser Agents](https://arxiv.org/pdf/2511.19477), [OSWorld-Human](https://arxiv.org/pdf/2506.16042))

## 3. What this means for Zoe specifically

1. **Her browser handle registry already sidesteps the hardest problem.** `web.js` enumerates interactive elements as `L#/B#/I#` handles from the DOM and clicks/types *by handle* — i.e. she already has the a11y-primary, ID-based grounding that the field says is the robust path. She does **not** need pixel grounding for ordinary web UIs, which is exactly where even SOTA struggles. This is a big head start.
2. **Use vision for VERIFY + FALLBACK, not for raw pixel grounding.** Don't ask the 24B or gemma4 for "click at (x,y)" — the research says open/non-specialist VLMs are weak at that and SoM doesn't rescue them. Instead: act by handle → `web-see` to confirm it worked / recover; use vision to read canvas/charts/image-only UIs the DOM can't expose.
3. **Desktop (`os_*`) is the genuinely hard, gated frontier.** No DOM handles there. Options: a11y via Echo's `os_find_element`/`os_describe_focused_ui` (primary), and/or a small local grounding model (UGround-2B/ZonUI-3B) for pixel targets — with the VRAM-contention caveat (it competes with the 24B; a 2–3B model is small enough to consider).
4. **Set expectations honestly.** SOTA is ~27% on hard open-ended tasks. This is **assistive, supervised** computer-use — a capable helper that verifies its own work and asks when unsure — not autonomous operation. Latency is seconds per step (screenshot + cloud vision + a generation, serialized on one GPU), so design tasks as a few deliberate steps.

## 4. Access & safety model (decided 2026-06-28)

The grounding principle: **let her run free where she can't do real-world harm; gate everything else.**

- **Her OWN browser — FULL access from the start.** It's a true sandbox: a separate Playwright/Chromium profile that never touches Lucas's tabs or the desktop. She can perceive → act → verify freely here so we can **study her full behavior safely** — what she reaches for, where grounding fails, how she recovers. This is the lab.
- **Shared browser (Lucas's tabs) — AUTH-GATED.** Real consequences (his sessions, logins). Behind the approval gate.
- **Desktop `os_*` layer — AUTH-GATED.** Highest stakes (irreversible clicks on the real machine). Echo already parks this at READ+propose with an approval queue (`os_set_policy`, `os_approvals_pending`, `os_approval_resolve`) — keep it there; acting requires explicit approval.
- **Invariants (all surfaces):** never defeat CAPTCHAs / sign-ins / paywalls (ask Lucas); confirm before destructive or outward-facing actions; every action logged.

## 5. Proposed phased build (own-browser first)

- **Phase 1 — Verification loop (her own browser, full access).** After `web-click`/`web-type`, auto-`web-see` and let her confirm it landed or recover. Lowest risk, highest reliability gain, and the foundational perceive→act→**verify** pattern everything reuses. *This is the recommended first slice.*
- **Phase 2 — Visual disambiguation / canvas fallback (own browser).** When handles are ambiguous or the page is image/canvas-based, use `web-see` (optionally with a numbered overlay drawn from the handle list — our own SoM, grounded in the DOM so it sidesteps the open-VLM SoM weakness) to choose/act.
- **Phase 3 — Shared browser see+act (GATED).** Same loop on Lucas's tabs, behind approval.
- **Phase 4 — Desktop computer-use (GATED).** `screen-see` → ground via `os_find_element` (a11y) and/or a small local grounding model → `os_click`/`os_send_keys` → `screen-see` verify. Full approval gating; start read-only, add acting incrementally.
- **Optional infra** — evaluate hosting a 2–3B grounding model (UGround-V1-2B / ZonUI-3B) locally for desktop pixel targets; weigh against VRAM contention with the 24B.

## 6. References
- OSWorld — https://www.emergentmind.com/topics/osworld · OSWorld-Human — https://arxiv.org/html/2506.16042v1
- OSWorld-G — https://www.emergentmind.com/topics/osworld-g · grounding scaling — https://osworld-grounding.github.io/
- ScreenSpot-Pro — https://arxiv.org/html/2504.07981v1
- UGround — https://osu-nlp-group.github.io/UGround/ · model — https://huggingface.co/osunlp/UGround-V1-7B · paper — https://arxiv.org/pdf/2410.05243
- OS-Atlas — https://arxiv.org/pdf/2410.23218
- ZonUI-3B (small grounding) — https://arxiv.org/pdf/2506.23491
- SoM caveats / region guidance — https://arxiv.org/html/2403.02325v1
- Browser-agent architecture, security, hybrid a11y+vision, verification — https://arxiv.org/pdf/2511.19477
- UI-Vision (desktop perception benchmark) — https://arxiv.org/pdf/2503.15661
