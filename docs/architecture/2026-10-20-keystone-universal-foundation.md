# Keystone Architecture: The Universal Foundation

- **Version**: v1.0
- **Date**: 2026-10-20
- **Status**: Direction-defining. This reframes the 2026-10-19 next-generation harness architecture as a *universal* foundation; it does not invent new implementation beyond what is already shipped or explicitly listed as a gap. **Delivery posture: developer-preview, CLI-first** — the kernel, runtime, headless CLI, and loopback workbench are the shipped surface; the ordinary-user desktop shell is not implemented.
- **Supersedes in emphasis**: [2026-10-19 next-generation harness architecture](./2026-10-19-keystone-next-generation-harness-architecture.md)
- **Related decisions**: [ADR-0001](../../docs/adr/0001-evidence-native-dual-loop.md), [ADR-0002](../../docs/adr/0002-kernel-is-sole-state-authority.md), [ADR-0003](../../docs/adr/0003-event-sourced-task-ledger.md), [ADR-0004](../../docs/adr/0004-typescript-zero-runtime-dependencies.md), [ADR-0005](../../docs/adr/0005-local-first-storage-layout.md)
- **External evidence**: [future agent foundation evidence (2026-10-20)](../research/2026-10-20-future-agent-foundation-evidence.md)

## 1. The one-paragraph thesis

Keystone is a **minimal trusted kernel plus on-demand cognitive extensions**. The kernel fixes the semantics of *what is true* and *what is allowed* — contracts, leases, provenance, evidence, proof, and the state machine. Everything that supplies cognition — models, tools, verifiers, analyzers, skills, clients, and protocol adapters — is a governed extension that can be added, swapped, or removed without changing the kernel. **Engineering is the first reference vertical**: the vertical used to stress-test the foundation, not a semantically baked-in assumption.

```
┌──────────────────── Clients (replaceable) ────────────────────┐
│  CLI (now)   Desktop workbench (thin shell, later)   IDE / CI │
└──────────────────────────────┬────────────────────────────────┘
                               │ Keystone Run Protocol (versioned)
┌──────────────────────────────▼────────────────────────────────┐
│  Runtime (composition root): Builder loop · Assurance loop      │
│  context planning · autonomy & intervention · degraded modes  │
└───────┬───────────────────────────────────────┬───────────────┘
        │ proposes action/observation only       │ reads projections
┌───────▼───────────────────────────────────────▼───────────────┐
│                    Kernel (trusted, minimal)                   │
│  Ledger · State machine · Contract · Lease · Run graph        │
│  Checkpoint/branch · Provenance · Evidence · Proof · Experience│
└───────┬───────────────────────────────────────────────────────┘
        │ governed extension points (Manifest + conformance)
┌───────▼───────────────────────────────────────────────────────┐
│  Model adapters · Tools · Verifiers · Analyzers · Workspaces │
│  Protocol adapters (MCP / ACP / A2A / Skills) · Scenarios    │
└───────────────────────────────────────────────────────────────┘
```

The kernel contains **no engineering-only semantics**. "Project", "build", and "test" are adapter/extension concepts, not kernel concepts. The kernel knows *outcomes*, *scopes*, *leases*, *observations*, *evidence levels*, and *proofs* — the engineering vertical supplies what those mean in practice.

## 2. Architecture invariants (what may never be broken)

These are the non-negotiable core. An extension, a new model, a new protocol, or a new client that would violate any of them is rejected or explicitly degraded — never silently absorbed.

| # | Invariant | What it guarantees | Why it is invariant |
|---|---|---|---|
| I1 | **Kernel is the sole state authority.** | Only the ledger and the state machine can transition authoritative task state; models and extensions only propose. | If cognition could write state, completion and proof become untrusted. |
| I2 | **Completion is a deterministic query.** | A task reaches `proven` only when every required condition has valid, non-invalidated evidence at the prescribed level, scope is not exceeded, and the proof graph is consistent. | "Done" must be reproducible by replay, not by reading a model's prose. |
| I3 | **Every side effect needs a scoped, short-lived lease.** | Files, commands, git, and network actions execute only inside an issued Capability Lease; out-of-scope writes pause. | Autonomy is bounded; the model cannot widen its own permissions. |
| I4 | **Evidence carries provenance and invalidation.** | Every observation/evidence record keeps its source, applicable snapshot, trust level, and invalidation rule. | A stale fact must not silently still count as proof. |
| I5 | **The ledger is append-only and replayable.** | Replaying the event graph reproduces the authoritative state; no in-place mutation of history. | Audit, recovery, and branch comparison all rest on this. |
| I6 | **Long-term experience passes a firewall.** | Candidate experience is quarantined, evaluated, promoted only on evidence, and demoted when it stops helping. | Bad lessons must not accumulate into context. |
| I7 | **The kernel stays minimal and dependency-free.** | The kernel package calls no model, opens no network, has zero runtime dependencies, and runs from TypeScript sources. | It must be replayable standalone and cheap to trust. |
| I8 | **Degradation is loud.** | When a mode or extension is unavailable, the capability loss and its evidence impact are stated; the system never silently keeps claiming the same proof level. | Silent degradation is how a "proven" result stops meaning anything. |

## 3. Protocols

Keystone speaks its own protocol at the seam it controls, and adopts existing standards at their intended boundaries — it does not let them reshape kernel semantics.

| Protocol | Role in Keystone | Boundary rule |
|---|---|---|
| **Keystone Run Protocol** | The authoritative wire format: Outcome Contract, Capability Lease, Provenance, Evidence, Proof, Checkpoint, Intervention. Versioned; exported as JSON Schema from the same source used for validation. | Adapters may not change these objects' semantics. If an external protocol cannot express something, it is explicitly degraded or rejected — never dropped silently. |
| **OpenAI-compatible chat shape** | Model-provider wire (BYOK): `POST {baseUrl}/chat/completions`; no vendor SDK. | It is a transport, not a semantic authority. Provider quirks live in adapters. |
| **MCP** | Tools and external resources (governed extension). | An MCP server is treated as untrusted capability input; its capabilities, IO schema, and data egress are declared in a manifest before activation. |
| **ACP** | IDE / client integration (queued, see ROADMAP). | An ACP host drives the runtime; it cannot bypass leases, rewrite the contract, or mark completion. |
| **Agent Skills** | Reusable on-demand capability packages (governed extension). | A Skill is untrusted until it passes integrity + conformance + risk disclosure; it cannot self-authorise. |
| **A2A** | Future remote agent hand-off (explore only). | Cross-boundary work must carry provenance, lease scope, and proof; the remote peer is never granted kernel authority. |

## 4. Model compatibility

The kernel does not care *which* model answers; it cares that the answer is treated as an untrusted proposal.

**What the kernel requires of a model adapter:**
- Speak the OpenAI-compatible chat completions wire (cloud `--kind cloud`, local `--kind local`). This already admits OpenAI, Azure-compatible gateways, OpenRouter, and local runtimes (Ollama, LM Studio, vLLM, llama.cpp, LocalAI).
- Produce **Action Proposals and Observations only** — never state transitions.
- Declare capabilities and cost; credentials are read from stdin and stored owner-only under `~/.keystone/credentials`, never in config.
- Include a **deterministic offline adapter** (`--scripted-fixture`) for tests, evaluation, and safe degradation — it honestly reports zero token usage.

**Today's supported boundary (2026-10-20):** only **text completion over an OpenAI-compatible Chat Completions interface**. The native Responses API, a native function/tool-calling protocol, Anthropic Messages, and Gemini native endpoints are **planned adapters, not current capability**. We adopt a richer wire only when it lowers lock-in without weakening the invariants; until then the model adapter surface stays a thin text wrapper.

**What a model may never do (regardless of provider):**
- Mark a task `proven`, issue a lease, widen scope, or promote experience.
- Satisfy a completion condition with its own self-report (an E0 claim cannot by itself clear a required condition).
- Change a task's business state or completion criteria when swapped. **Model switching is semantics-neutral**: the Outcome Contract, completion conditions, and task state are preserved across a swap — it does *not* promise equal task outcomes or quality, which depend on the model.

## 5. Scenario abstraction

A *scenario pack* stands the foundation up for a domain. **Today only the engineering pack is implemented.** The foundation is designed so that personal, research, creation, enterprise, and physical-device/robotics packs can be added as adapters + extensions with **zero kernel change**; none of them is claimed implemented yet.

The six shared primitives are the same across every vertical. A pack supplies the *concrete* meaning of each; the kernel enforces the *shape* of each.

| Shared primitive | What the kernel enforces |
|---|---|
| **Goal / Contract** | An outcome with explicit scope, completion conditions, budget, and autonomy boundary. |
| **Context / Memory** | Facts tagged with source, applicable snapshot, trust level, and invalidation rule. |
| **Capability** | A tool/action that declares scope, idempotency, and data egress. |
| **Policy / Lease** | A scoped, short-lived authorisation; out-of-scope action pauses for a human. |
| **Evidence / Receipt** | A graded, independently produced artifact the Proof Graph can weigh. |
| **Exception / Human decision** | A defined escalation point: ambiguity, irreversibility, or boundary breach.

| Scenario pack | Goal / Contract | Context / Memory | Capability | Policy / Lease | Evidence / Receipt | Exception / Human decision |
|---|---|---|---|---|---|---|
| **Personal** (life admin) | "Settle this task" with explicit scope | User prefs, calendar, contacts, tagged for provenance | Calendar / mail / map / browser adapters | Read-only by default; send / pay / delete needs an explicit lease | Hashed confirmation numbers, receipts, screenshots | Anything irreversible |
| **Software engineering** *(shipped reference)* | Outcome Contract: fix/feature + completion conditions | Project World Model with provenance + invalidation | fs / search / command / git behind a lease | Scoped write leases; `git worktree` isolation | test / typecheck / lint / build proof graph | Out-of-scope writes, ambiguous scope |
| **Research** | A question + acceptance criteria for "what counts as an answer" | Versioned sources, citations, literature notes | Search / fetch / extraction adapters | Read network by default; writes only to the research workspace | Reproducible extraction + citation, not model assertion | Conflicts, unverifiable claims, data egress |
| **Creation** | A brief + deliverable definition and acceptance criteria | Style guide, prior assets, drafts | File / image / media tools, generation adapters | Drafts isolated; publish / export requires a lease | Render checks, diff against brief, preview artifacts | Publishing, licensing, final sign-off |
| **Enterprise** | SOP / compliance task with required controls | Org docs, permissions, records (retention-tagged) | Governed internal-system adapters | Least-privilege scoped leases; mandatory audit trail | Immutable audit receipt aligned to a control | Approval gates, boundary breach, PII handling |
| **Physical device / robotics** | A task + a hard safety envelope (geometric / speed / power bounds) | Device state, sensor history, environment map | Device capability adapters (sensors / actuators) | Motion authority scoped to a hard safety layer **outside the model** | Sensor / telemetry log + invariant checkpoints | Safety-boundary violation, loss of comms |

**Scenario rule:** a new vertical is admissible only if it can be expressed entirely as adapters + extensions — with zero kernel change — and its completion judge is still a deterministic query over evidence. If it requires a new kernel invariant, it is rejected until the invariant itself is debated and accepted as an ADR. **Robotics adds a hard requirement:** real-time safety must be enforced by a layer outside the model (and outside the LLM's authority), backed by device capability adapters; the model proposes, the safety layer decides.

**Delivery status:** engineering = shipped reference vertical; personal / research / creation / enterprise / robotics = designed-for packs, not implemented (see ROADMAP Explore).

## 6. Trust boundary

```
TRUSTED (minimal, auditable)            UNTRUSTED (pluggable, governed)
─────────────────────────────          ──────────────────────────────────
kernel: ledger, state machine,         models, tools, verifiers, analyzers,
contract, lease, provenance,           MCP servers, Skills, protocol adapters,
evidence, proof, experience            clients, remote peers (A2A)
i18n catalogs (presentation only)
```

- **The trusted side is small on purpose.** It is the only thing a user has to audit; it has zero runtime dependencies, no network, and replays standalone.
- **Everything else is untrusted input.** Extensions are admitted through a manifest (name, version, publisher, integrity, capabilities, IO schema, data egress, producible evidence, replayability, idempotency, uninstall behaviour), integrity check, dependency resolution, conformance kit, risk disclosure, and explicit user confirmation.
- **Extensions may add restrictions or request confirmation; they may not add Allow rules, widen scope, disable safe mode, replace completion rules, or turn off degradation.**
- **Threat-model one-liner:** a compromised model or extension can waste budget or propose bad edits inside the lease boundary, but cannot silently declare victory, escape the scope, or rewrite the audit trail.

## 7. Extension boundary

| Extensions may | Extensions may not |
|---|---|
| Propose actions, observations, and candidate experience | Change authoritative task state directly |
| Add tools, verifiers, analyzers, and Skills within a declared manifest | Self-authorise, grant new permissions, or escalate privileges |
| Produce graded evidence that the Proof Graph can weigh | Mark completion on their own authority |
| Request confirmation before a wider action | Silence a degradation or keep claiming the same proof level after a failure |
| Be isolated on crash / timeout / manifest violation, with checkpoints retained | Disable safe mode or replace the state machine |

## 8. Non-goals and boundaries

- **Only the engineering pack is shipped today.** Personal, research, creation, enterprise, and device/robotics are designed-for scenario packs, not implemented; they are in scope as an architecture ambition, not as a claim of working software.
- We are not a hosted cloud product or a centralised enterprise web admin back-end.
- We are not baking engineering into the kernel; engineering is the reference vertical that ships first, not the semantic core.
- We are not adopting a protocol that changes Contract / Lease / Provenance / Evidence / Proof semantics.
- Multi-agent "software factories" that treat agent count as the goal and are on by default are out of scope.
- We are not claiming other verticals exist today; they are Explore items gated by §5 (zero kernel change + deterministic evidence; robotics additionally gated by external real-time safety).

## 9. Current implementation boundary (2026-10-20)

Concrete seam that makes §1 and §5 true in code, per [ADR-0006](../adr/0006-engineering-scenario-pack-extraction.md):

- **Engineering vocabulary lives in `@keystone/pack-engineering`, not the kernel.** Git/workspace scanning and profiling (`scanWorkspace`, `detectProjectProfile`) and the engineering Outcome-Contract proposal (`compileContract`) moved out of `@keystone/kernel`. The pack depends downward on `@keystone/kernel` + `@keystone/schemas`; the kernel never imports the pack, so it stays dependency-light and replayable (I7).
- **Two policies are injected, not imported.** The kernel owns the *state machine* but not the *heuristics* behind two decisions, each behind a generic seam it defines but does not implement, wired by the composition root (`@keystone/runtime`):
  - `ContractProposer` drafts the Outcome Contract (require `defining`, append `contract.compiled`, transition, return questions — all kernel).
  - `ActionCapabilityResolver` maps a proposed action to its `Capability` and lease resource values. The kernel still decides scope/envelope, issues or refuses the lease, and records `lease.issued` / `action.rejected`. Without a wired resolver, `authorize` fails loudly (`no_action_resolver`); a wired resolver that returns `capability === undefined` is an ordinary default-denial. The resolver never touches the ledger, so resumed/replayed sessions are unaffected.
- **Generic launch compatibility is a neutral package, not the engineering pack.** Windows `.cmd`/`.bat` shim resolution and `cmd.exe` argument escaping (`resolveSpawnTarget`) is process-launch compatibility, not engineering vocabulary. It lives in the zero-dependency `@keystone/spawn`, which the generic execution boundaries `@keystone/tools` and `@keystone/verifiers` depend on directly — neither depends on the engineering pack.
- **A second, non-engineering reference pack exercises both seams unchanged.** `@keystone/extension-localization-placeholders` proves a translated message catalog keeps every source placeholder. It contributes (a) a localization-specific `ContractProposer` (`compileLocalizationContract`) whose single required completion condition names the pack's own verifier **by explicit id**, and (b) an E2 verifier (`localizationParityE2Verifier`) that runs the deterministic parity checker in a **child process**. The composition root wires both through `RuntimeOptions.contractProposer` and `RuntimeOptions.verifiers`; verification planning resolves a condition to an injected verifier by id first, then falls back to the built-in kind lookup, and reports a condition `unsupported` rather than silently assigning it to a weaker check (a lower evidence level, a non-stand-alone verifier, or a same-process check under an independence requirement). The e2e proof rests on the extension verifier's E2 evidence — producer id, `E2`, `separate_process` — and contains no engineering `test` condition. No kernel or schema file changed for this.
- **Compatibility.** No `packages/schemas` file changed and no `schemaVersion` bumped; moved functions emit identical objects. Existing consumers (`runtime`, `cli`) repoint imports to the pack; `tools`/`verifiers` now repoint `resolveSpawnTarget` to `@keystone/spawn`; storage-layout primitives the kernel genuinely owns (`projectIdForWorkspace`, `readJsonFile`, `globToRegExp`) remain kernel exports the pack imports.
- **Deferred genericization.** Both injected seams are still typed to today's engineering schemas (`ProjectProfile`, `ProjectFact`, engineering verifier kinds, engineering intent/tool vocabulary). A second (localization) pack now exists and proves the seams admit a non-engineering vertical, but scenario-agnostic genericization of those type names is still deferred; this phase adds the localization reference pack without renaming schema types or bumping versions.
