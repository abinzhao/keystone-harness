# Roadmap

This roadmap is organised into three tiers — **Current**, **Next**, **Explore** — and deliberately uses **no calendar dates**. Every committed item carries an **entry gate** (what must be true before we commit to it) and an **exit gate** (what observable, reproducible result proves it is done). "Explore" items are research only: we name what would make us commit, but we do not promise a delivery.

> Reading status: a tier is not a release promise. It records where we have chosen to focus *now*, what we have queued *next*, and what we are deliberately *not* committing to. If an entry/exit gate is not met, the item is simply not done — no milestone date is missed.

**Product surface today vs. the end state.** Today is a developer-preview, CLI-first surface: the audience is the SDK, the Run Protocol, debug traces, and the evaluation harness. The ordinary-user end state is **zero-config progressive disclosure** — the workbench hides mechanics by default, shows a *preview* before any irreversible action, leaves a *receipt* after completion, pauses at *exceptions*, and supports *replay* of the whole run on demand. We build toward that end state on the same runtime; none of it is claimed shipped today.

## Current — committed, shipped or in flight

> **Delivery posture:** this is a developer-preview RC. The shipped surface is the kernel, runtime, headless CLI, loopback workbench, and an experimental macOS Swift/WKWebView window over the supervised same-origin desktop shell (BYOK wizard, simple/advanced modes, risk-graded Contract preview). What is **not** shipped is a distributable universal `.app`: no Intel/universal build, signing, notarization, installer, or public package.

| Item | Status | Entry gate | Exit gate |
|---|---|---|---|
| P0 evidence-native single-project loop (kernel closed loop, runtime + CLI, extension SDK) | Shipped | Engineering baseline (`pnpm install` / typecheck / test runnable; ADR-0001..0005 accepted) | Replaying the event graph yields a consistent authoritative state; a task reaches `proven` only when every required condition has valid, non-invalidated evidence and model text cannot trigger it; out-of-scope writes pause and await a user decision. |
| Local Run Protocol server + four-zone workbench | Shipped (locally verified in a real browser) | CLI/runtime loop exists; protocol objects export the same JSON Schema used for validation | Loopback server with bearer token; workbench renders task list, goal/completion conditions, proof & evidence, and intervention replies in a real browser; `minimal` / `standard` / `isolated` / `replay` modes selectable per run. |
| Universal-foundation layering | Shipped | Kernel already does not call models or touch the network; extensions already go through manifest + conformance; engineering detection + contract proposal extracted to `@keystone/pack-engineering` behind an injected `ContractProposer` (ADR-0006, no schema bump) | Kernel package contains no engineering-only decision semantics: Git/workspace scanning and the engineering contract/action policies live in `@keystone/pack-engineering`; generic Windows process-launch compatibility lives in the neutral `@keystone/spawn` leaf. **Proven by a second reference pack:** a non-engineering localization placeholder-parity vertical is expressed entirely as an injected `ContractProposer` plus an extension-owned E2 verifier (a separate child-process parity check) that the runtime dispatches by explicit verifier id — with zero kernel/schema change and an e2e proof that rests on that extension verifier, not on the engineering `test` verifier. Scenario-agnostic genericization of the still-engineering-typed seams remains deferred. |
| Git write operations | Shipped (locally verified; ADR-0007) | Read-only git tools + `git worktree` isolation exist | `git.commit` / `git.rollback` run only inside a scoped, short-lived `git.write` Capability Lease; out-of-scope git writes are refused before any ref moves; operations are replayed deterministically. |
| Native provider wire adapters + capability routing | Shipped (locally mock-tested; ADR-0010) | A single OpenAI-compatible Chat Completions adapter existed | Request/response/tool-call mappings for OpenAI Responses, Anthropic Messages, and Gemini GenerateContent, plus a capability router that selects only adapters declaring native tools; every adapter is exercised by an in-process mock-`fetch` test. **Not yet verified against a live provider**, and the Builder Loop still drives the validated text envelope (`tools: []`) in v1. |
| Governed local stdio MCP tools + on-disk Agent Skills | Shipped (locally verified; ADR-0009) | The in-process extension surface (manifest, integrity, conformance, registry) exists | A `stdio` MCP server and project/user Skills install through the existing local-path extension flow, are treated as untrusted input, gain no capability by mere presence, and have no remote transport or marketplace; they pass integrity + conformance + risk disclosure before activation. |
| Cross-platform hardening (Windows) | Preview | macOS verified on real hardware; resolution layer implemented and unit-tested | The end-to-end suite runs green on a Windows machine; process-group kill semantics and `.cmd` shim escaping are covered by e2e, not only unit, tests. |
| macOS native desktop thin window | Shipped as source-tree RC; locally exercised (ADR-0008) | Supervised same-origin browser shell and stable workbench seam exist | A Swift/WKWebView host loads the shell origin, exposes normal editing/zoom shortcuts and narrow-window layout, protects shell-private routes with a nonce, and closing the window tears down the proxy/runtime. This row does **not** claim a packaged/signed/notarized universal `.app`. |
| Risk-graded Contract startup + dirty-overlap refusal | Shipped (locally API/static verified; ADR-0013) | Read-only Contract preview and binary write confirmation existed | Low-risk, unambiguous, scoped, reversible, local writes auto-start after preview only when policy permits; ambiguity, scope expansion, irreversible/external/high-risk actions and policy overrides still confirm; overlapping pre-existing dirty paths refuse with commit/stash/isolated recovery guidance. |
| Release/CI foundations | Shipped (locally verified; CI not yet exercised on a hosted runner; workspace at `1.0.0-rc.1` per ADR-0012) | Engineering baseline (`pnpm install`/typecheck/test) runs; release tooling added under `scripts/release/` with zero runtime deps | macOS + Linux CI is green on install/typecheck/test and uploads offline SBOM + build-info; the SBOM is byte-deterministic and the build-info fingerprint is stable across runs (only `generatedAt` excluded); an authoritative `release:bump` script moves every workspace package in lockstep, and the version/release-readiness checker runs two channels — a prerelease such as `1.0.0-rc.1` passes as a local RC artifact build, while a plain `1.0.0` still blocks unless explicitly blessed with `--allow-1.0` after the acceptance gates below close. No signing/notarization/publishing. The Windows verification job stays non-blocking and unproven until the Windows hardening row above closes. |

The native macOS host is implemented as a thin Swift/WKWebView view over the existing supervised same-origin proxy (ADR-0008). It introduces no runtime dependency into the kernel and no second state authority. Remaining desktop release work is distribution engineering: rebuild per target architecture, create a universal `.app`/installer, then sign and notarize it. Until those gates close, the source-tree window is an RC capability rather than a public macOS release artifact.

## Next — committed after the Current exit gates

These are queued, but their entry gates depend on items still in flight; we will not start an item whose entry gate is unmet.

| Item | Entry gate (what unlocks it) | Exit gate (what proves it) |
|---|---|---|
| IDE integration (ACP-compatible) + non-interactive CI runs | Workbench/RPC seam stable; a headless run mode that needs no human UI; **an ACP adapter is currently BLOCKED per ADR-0011** (Contract/Lease/Evidence/Proof cannot cross ACP v1 without silent loss; no adapter ships) | A non-interactive CI run produces a machine-readable proof package with no human in the loop; an external ACP host can drive the same runtime **only after** the silent-loss points in ADR-0011 are resolved. |
| Multi-project local management + worktree-isolated parallel write tasks | Single-project loop exit gate holds; isolation proven per task | Several projects share one runtime; parallel write tasks touch separate worktrees and never mutate each other's working copy or evidence. |
| Second batch of language / framework adapters | Onboarding marks unrecognised entry points instead of guessing | A second language's build/test/entry points are discovered, versioned, and invalidated precisely on change. |
| **Reproducible efficacy scorecard / Harness gain** | A stable task set with hidden or independent acceptance scripts exists; each run records model, harness version, plugins, permissions, and environment | On a fixed task set, Standard vs Minimal mode isolates harness gain from model capability; the published scorecard reports variance, failure types, and the leadership-gate metrics (verification completion rate, intervention rate, context cost) as reproducible numbers — not only surface features. |

## Explore — research only, not committed

No exit gate is promised here. We record the **entry condition** that would move an item into Next; until then it is investigation, not a commitment.

- **Remote agent delegation (A2A-shaped).** *Entry condition:* a concrete user need for cross-machine hand-off, plus a demonstrated way to carry provenance, leases, and proof across the boundary without weakening kernel invariants.
- **Team-shared project rules, experience, and proofs.** *Entry condition:* local-first multi-device sync is proven, and a signed, replayable proof format exists that does not depend on a central server.
- **Reference vertical packs beyond engineering** — personal, research, creation, enterprise, and physical-device/robotics. *Entry condition:* each pack is expressed as adapters + extensions with **zero kernel change**, and its completion judge remains a deterministic query over evidence. *Robotics adds a hard gate:* real-time safety is enforced by a layer outside the model/LLM, backed by device capability adapters — the model proposes, the safety layer decides. Until a pack clears its gate it is research, not a delivered vertical.
- **Provider wire convergence (Responses / OpenAI-compatible shape).** *Entry condition:* the kernel-required adapter surface stays a thin wrapper; we track it in the [evidence note](./docs/research/2026-10-20-future-agent-foundation-evidence.md) and adopt it only when it lowers lock-in without changing semantics.

## Scope ambition vs. what is built

The foundation's ambition is to support **personal, research, creation, enterprise, and physical-device/robotics scenario packs** on top of the same kernel. **Today only the engineering pack is built.** The others are in scope as an architecture goal (zero kernel change, deterministic-evidence completion) and sit in Explore; none is delivered or claimed working.

## Explicitly out of scope / forbidden

Multi-agent "software factories" that treat agent count as the goal and are on by default; a centralised hosted cloud admin back-end; mobile clients and remote signing as a launch target; automatic payments, email sending, and production deployment without an explicit lease; plugin or Skill marketplaces without isolation, conformance, and permission declarations; automatically promoting a single failure into a long-term project rule; allowing extensions to replace the state machine, authority issuance, evidence integrity, or completion determination; using a model's chain of thought as proof, an audit record, or a user deliverable.

## How we judge "done"

Keystone does not claim leadership by feature count. A stable release must satisfy the cross-stage leadership gate under the same model, same task, same permissions, same time, and same token budget:

1. measurably better on at least one core dimension (verification completion rate, human-intervention rate, or context cost) than the best current reproducible baseline;
2. with no regression on escape rate, out-of-scope change rate, or lifecycle safety;
3. with deterministic evidence for recovery, replay, and branch comparison;
4. with observable positive transfer from long-term experience and no negative transfer or forgetting beyond the release gate;
5. where new models, extensions, protocols, or policies cannot break the Contract / Lease / Provenance / Evidence / Proof invariants.

Numeric thresholds are set by public, reproducible baselines and are not preset without data. Any "leadership" statement must cite the current scorecard and a reproducible experiment.
