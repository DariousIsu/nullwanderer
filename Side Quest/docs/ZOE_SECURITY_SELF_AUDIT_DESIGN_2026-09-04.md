# ZOE Security Self-Audit — design (2026-09-04)

## 1. The goal

Lucas: ZOE needs the capability to white-hat her own systems — to find and fix the weaknesses in her own stack herself, under the constraint of not hurting anyone. This is self-directed, authorized security testing of assets Lucas owns and controls. It is defensive work: the output is a hardened system, and the point of the capability is that ZOE runs it herself rather than waiting for a human to audit her.

The design keeps five properties separate so each can be set to its right level:

| Property | Setting | Why |
|---|---|---|
| Capability (the toolkit) | Full | She needs real offensive tooling to find real weaknesses. |
| Target (what she may test) | Owned assets only, from an allowlist | This is what makes it white-hat, and it is the injection defense. |
| Discovery and analysis | Unasked | Reading her own attack surface is the safe lane she should own with zero friction. |
| Changes to a system | Gated | A finding becomes a fix she proposes through the pen, never an action she takes unsupervised. |
| Every action | Logged | White-hat work wants to be observed; the run ledger and the monitor record it all. |

The one-line contract: **capability full · target yours only · discovery unasked · changes gated · everything logged.**

## 2. The scope allowlist — the authorization boundary

The allowlist is the heart of the design. It is the record of what Lucas authorizes ZOE to test, and it is the boundary that keeps a capable, internet-reading agent from ever pointing its offensive tooling at anything but Lucas's own systems.

**In scope (the initial allowlist, Lucas's confirmed base):**

| Asset | Address |
|---|---|
| Side Quest (the app) | `C:\Users\azrae\Desktop\Side Quest` |
| NX ECHO (the engine) | `C:\Users\azrae\Desktop\NX ECHO\nx-echo` |
| Her own host — loopback services | `127.0.0.1` / `localhost`: the control port `8767`, the MCP servers, the dev servers |
| Owned domains / accounts | *(to be named by Lucas — none assumed)* |

**Out of scope (hard deny):** everything not on the list. Any third-party host, any account Lucas does not own, any machine on the public internet, any shared or hosted service not explicitly added. Off-scope is not a warning — it is a deterministic refusal, logged.

**Enforcement.** One module, `lib/security_scope`, owns the allowlist and answers a single question for every audit action: is this target in scope? A path is in scope only if it is inside an allowlisted root; a host is in scope only if it matches an allowlisted address. Any tool that takes a target consults it first and refuses off-scope before doing anything. The allowlist is configuration — version-controlled data, not code — so a change to it is visible in a diff and is itself a boundary-category change (section 5).

**Why the boundary protects Lucas, not just third parties.** ZOE reads web content all day for research. Without a pinned scope, a malicious page could try to redirect her "security testing" at someone else's system — a prompt-injection turning her own tool against a stranger, with Lucas's name on the packets. The allowlist means her offensive capability can only ever resolve to Lucas's assets, even when the instruction to point it elsewhere arrives inside content she ingests. Scope is the difference between a self-hardening system and a liability.

## 3. The toolkit — capability, unbounded within scope

Full testing capability, pointed inward. Every tool is scope-gated (section 2) and non-destructive by default (section 4).

| Class | What it does | Targets |
|---|---|---|
| Code and secrets | Static analysis over the SQ + Echo source; secret and key scanning; unsafe-pattern detection (shell injection, path traversal, eval sinks, deserialization) | The repo roots |
| Dependencies | CVE and advisory checks on npm and Python dependencies; lockfile and version drift | The repo manifests |
| Config and auth | Config review (exposed ports, weak defaults, permissive CORS), auth and session review (the control-port token, MCP auth, the keystore's key handling) | The repos + local config |
| Runtime and network | Local service and port enumeration on her own host; endpoint probing and rate-limited fuzzing of her own endpoints; TLS and security-header checks on her own services | `127.0.0.1` / allowlisted local ports |

The first three classes read and analyze; they are the safe, unasked discovery lane. The fourth class touches live services and is the most sensitive — it lands last, behind its own switch (section 6), and even in scope it is rate-limited and non-destructive.

## 4. "Don't hurt anyone" — operationalized

Lucas's constraint, turned into enforced rules:

- **Scope-confined.** No third-party system, ever (section 2). This is the primary harm boundary.
- **Non-destructive.** No test that deletes, corrupts, or denies service. Fuzzing is rate-limited, owned-endpoint-only, and carries a kill switch. No destructive payloads, no persistence, no lateral movement.
- **No exfiltration.** Findings stay local. A discovered secret is reported by its location and a masked fingerprint (last four, never the value) — this inherits the existing "never repeat a key in chat" law. Evidence is a reference, not a dump.
- **Reversible.** Any change to a system rides the pen's rehearsal-and-gate path, which already carries rollback. A finding never mutates a system directly.
- **Shared-infra safe.** Even for an in-scope domain, a test that could affect infrastructure other people rely on (a hosted service, a shared endpoint) is flagged for Lucas's explicit go rather than run autonomously.

## 5. Operation — the security-audit organ

The lane is an organ in the same family as the integrity auditor, self_watch, and leg B's trajectory miner — a scheduled, idle-gated pass that produces findings, never unsupervised changes.

1. **Discover.** On its cadence (idle-gated, cheap where possible), the organ runs the read-and-analyze toolkit over the in-scope assets. This is unasked.
2. **Record a finding.** Each weakness becomes a typed finding: asset, class, severity, evidence reference, and a proposed remediation. Findings land in a findings store and in the run ledger, so the surface is accounted, not just scanned.
3. **Propose the fix.** A remediation that changes code becomes a pen proposal — rehearsal, gate, Lucas's decision — exactly the pen's existing shape, so it folds into leg D. A finding that needs an operator action (rotate a key, close a port) becomes a capability_need proposal card. Nothing in a boundary category is auto-applied.
4. **Surface it.** Findings reach Lucas through the channels that already exist: the needs cards, obs_bus, and the unprompted channel as a discovered-connection note — substance, not noise.

This mirrors the organ family already in place: leg B mines run failures, self_watch mines log anomalies, the integrity auditor mines graph errors, and this mines security weaknesses — all with the same proposal-card discipline that ends every autonomous producer in something Lucas decides on.

## 6. The monitor tie-in (3A)

The independent monitor Lucas approved is the backstop, and here it complements the lane rather than fighting it — white-hat work is meant to be watched. Every audit action is recorded to the run ledger; the monitor reads that stream and raises an alarm on two shapes: any target that resolved off the allowlist (which the scope module should already have refused — the monitor is the second line), and any toolkit action that reached beyond read-and-analyze without the corresponding gate. There is no "don't get caught" pressure to design around, so the scope boundary and the monitor pull the same direction.

## 7. Invariants (the laws)

1. A target is tested only if it is on the allowlist; off-scope is a deterministic, logged refusal.
2. Discovery and analysis are unasked; any change to a system is gated through the pen or a proposal card.
3. Non-destructive always: no data loss, no denial of service, no exfiltration; secrets are reported masked, never echoed.
4. The allowlist and the scope-enforcement module are constitutional files — the pen cannot edit them without out-of-band approval (the 2b guardrail). A boundary the agent can quietly widen is not a boundary.
5. Every action is logged to the run ledger; the monitor is the backstop.

## 8. Build increments

Each increment gates on both sides, logs to the ledger, and lands under the monitor. Small, in order, provable.

1. **The scope module + the findings store.** `lib/security_scope` (the allowlist + the in-scope test) and the findings table, with a smoke that pins in-scope passes and off-scope refuses. Nothing tests anything yet; the boundary exists first. — ✅ LIVE (`5be192e`, p292).
2. **The read-only toolkit.** Static analysis, secret scanning, dependency and config review over the repos — scope-gated, non-destructive, findings recorded. This is most of the value at the least risk. — ✅ LIVE: secrets `93a94ee`; config reviewer + dependency (OSV) scanner `ad0c5de` (increment 3c).
3. **The organ + the remediation wiring.** The scheduled discovery pass, idle-gated, with findings flowing to pen proposals and needs cards. — ✅ organ + the universal on-demand surface LIVE (`35c1d7c`/`b08abbc`): the off-thread nightly scan organ, `POST /security/scan`, `GET /security`, the Echo `security_*` MCP tools. The remediation half (findings → pen proposals / needs cards) folds with leg D.
4. **Runtime and network probes.** The own-host enumeration and rate-limited endpoint checks, behind their own switch, landing last because they touch live services. — ✅ LANDED (increment 4): `lib/security_probe` — enumerate this host's listeners (a local read), scope FINDINGS to her own process tree (a host/OS bind is posture she reports, never a fix she owns), one benign loopback GET per owned http service (capped, rate-limited, no payload) catching a LAN-reachable bind or a live DevTools/CDP endpoint. Switch `ZOE_SECURITY_PROBES=0`; `POST /security/probe`; Echo `security_probe`. Dry run over the live host: 0 exposures in her stack (loopback-only by design), the 16 host/OS binds reported as posture, not flagged.

The remediation half is leg D's correction door and pen; the audit lane is its security-flavored producer, so the two build together. **The read-and-analyze + runtime toolkit (increments 1–4) is complete; what remains is remediation (findings → pen proposals / needs cards) and the constitutional-file pen enforcement (§7.4) — both are the pen's job and land with leg D / the stage-5 pen unification.**

**Lucas's call (09-04): the own-host runtime probes ride the first deliverable, not a later one.** The explicit goal is to push the sandbox's own boundaries and report where they give. Build order still starts with the scope module — the boundary before any tool — but increment 4 is in scope for the first cut, not deferred. The line that keeps it white-hat: the probes *discover and report* how far confinement holds; they never exploit a weakness to actually break out or persist. A found escape path is a finding and a proposed fix, not an action taken.

## 9. Scope, resolved (Lucas, 2026-09-04)

- **Domains and accounts.** The base is enough — the SQ repo, the Echo repo, and her own host's loopback services. No external domains or accounts added.
- **Runtime testing.** Included from the first cut (increment 4 rides the first deliverable): own-host enumeration and rate-limited, non-destructive endpoint probing, to push the sandbox's boundaries and report where they give.
- **The constitutional line.** Changes to the allowlist, the scope module, the monitor, and the pen's own guard go through the standard proposal card — Lucas's yes/no — like any boundary-category change. She may propose a change to her own boundary; she may never apply one unsupervised.
