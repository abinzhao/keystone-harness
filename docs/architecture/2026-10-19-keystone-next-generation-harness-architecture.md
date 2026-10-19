# Keystone Architecture: A Next-Generation Engineering Agent Harness

- **Version**: v1.0
- **Date**: 2026-10-19
- **Source of truth**: `需求文档.md` (PRD v1.0)
- **Related decisions**: [ADR-0001](../adr/0001-evidence-native-dual-loop.md), [ADR-0002](../adr/0002-kernel-is-sole-state-authority.md), [ADR-0003](../adr/0003-event-sourced-task-ledger.md), [ADR-0004](../adr/0004-typescript-zero-runtime-dependencies.md), [ADR-0005](../adr/0005-local-first-storage-layout.md)

## 1. Overall Shape

Keystone is a **modular monolith kernel + local execution host + thin client**.

```
┌──────────────────────────────────── Client (replaceable) ────────────────────────────────────┐
│  CLI (this phase)   Desktop Workbench (Tauri, later)  IDE / CI                               │
└──────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                               │  Keystone Run Protocol (versioned, capability negotiation)
┌──────────────────────────────────────────────▼───────────────────────────────────────────────┐
│                                  Runtime (composition root)                                  │
│  Builder Loop                              Assurance Loop                                    │
│  Understand/Plan/Execute/Modify  Contract/Context/Capability/Verify/Complete/Learn/Autonomy  │
└──────┬───────────────────────────────────────────┬───────────────────────────────────────────┘
       │ can only submit intent/observation         │ can only read projections
┌──────▼───────────────────────────────────────────▼───────────────────────────────────────────┐
│                                     Kernel (stable core)                                     │
│  Event Ledger · State Machine · Contract · Lease · Run Graph                                 │
│  Checkpoint/Branch · Provenance · Evidence · Proof · Experience                              │
└──────┬───────────────────────────────────────────────────────────────────────────────────────┘
       │ governed extension points (Manifest + conformance tests)
┌──────▼───────────────────────────────────────────────────────────────────────────────────────┐
│  Model Adapter · Tools · Verifiers · Analyzers · Workspace                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key stance: **the kernel fixes the semantics; all capabilities are pluggable.** The model, tools, verifiers, analyzers, Workspace, protocol adapters, and Skills are all governed extensions; they cannot replace the state machine, authority issuance, evidence integrity, or completion determination (PRD 12.6).

## 2. Package Boundaries

| Package | Responsibility | What it must not do |
|---|---|---|
| `@keystone/schemas` | The **authoritative definition** of versioned Schemas: TS types + runtime validators + an exportable JSON representation | Contains no business logic; does not depend on any other Keystone package |
| `@keystone/kernel` | Authoritative state: event ledger, folding, state machine, Contract compilation and versioning, Lease issuance, Run Graph, checkpoint/branch, Provenance, Evidence records, Proof Graph determination, Experience Firewall | Does not execute side effects, does not call models, does not access the network |
| `@keystone/tools` | Built-in tool implementations (fs read/write and search, standalone command execution, git operations); each tool declares its capability requirements and idempotency | Does not make permission decisions; whether to allow is decided by the kernel Lease |
| `@keystone/verifiers` | Verifier implementations (test, typecheck, lint, build, scope check, project rule) that produce graded Evidence | Does not modify code, does not modify completion conditions |
| `@keystone/models` | Model adapters: OpenAI-compatible cloud models (BYOK) + local offline models + model routing and capability declarations | Does not touch task state; only produces Action Proposals |
| `@keystone/runtime` | Composition root: wires the kernel and extensions; implements the two Loops, Context Plan, autonomy and intervention, and degraded modes | Does not bypass the kernel to modify state directly |
| `@keystone/extensions` | Extension Manifest parsing and validation, registry, Conformance Kit | Does not grant permissions |
| `@keystone/cli` | Headless client: project onboarding, task run, resume, branch, proof export, replay, extension management | Does not hold independent state |

The dependency direction is one-way: `cli → runtime → {kernel, tools, verifiers, models, extensions} → schemas`. `kernel` depends on no execution layer, which guarantees it can be replayed standalone.

## 3. Data Flow: The Complete Loop of a Single Task

1. **Onboarding**: `runtime` snapshots and probes the workspace (language, package manager, build/test entry points), produces a `ProjectFact`, and writes it to `projects/<id>/facts/`. Entry points that cannot be recognized are marked as "unrecognized" and are not replaced with guessed values.
2. **Create task**: user intent enters the kernel → `task.created` event, state `draft`.
3. **Compile contract**: `kernel` compiles the Outcome Contract, producing the target outcome, scope, invariants, completion conditions, evidence requirements, budget, autonomy boundary, uncertainties, intervention conditions, and exit conditions. With no material ambiguity and a clear scope → `ready`; otherwise `awaiting_approval`.
4. **Execute**: for each step, `runtime` first generates a Context Plan (adopted/excluded items, sources, budget, invalidation conditions); the model produces an `ActionProposal`; the kernel validates the scope and issues a Capability Lease; the tool executes within the Lease, producing Observations + workspace changes.
5. **Verify**: verifiers execute item by item against the completion conditions, producing Evidence with level and independence information. An E0 model claim cannot by itself satisfy a completion condition.
6. **Determine**: a Proof Graph query. Only when all required conditions have valid evidence at the specified level, the scope is not exceeded, the evidence chain is complete, the workspace matches at verification time, independence is satisfied, and there are no conflicts or circular dependencies does it enter `proven`.
7. **Repair**: failed verification enters `auto_repairing`; within budget only the affected checks are re-run, and the specified final verification must still be executed before completion. Consecutive lack of progress leads to `needs_attention` or `exited_gracefully`.
8. **Learn**: a successful trajectory can only produce candidate experience, which enters quarantine; it is promoted only after passing provenance, applicability, and negative-transfer checks.
9. **Invalidate**: when the workspace, dependencies, tools, verifiers, Contract, or a key Project Fact changes, precisely mark the affected evidence along the Proof Graph.

## 4. Kernel Modules

| Module | Core exports | Corresponding PRD |
|---|---|---|
| `ledger` | Event append, hash-chain verification, read, read-by-branch, atomic write | 7.2, NFR-REL-01/05/08 |
| `state` | `foldTaskState(events)`, state transition table validation | 7.1, 7.3 |
| `contract` | Compile, validate, revise (new version), import/export and compatibility check | OT-02/03/04 |
| `scope` | Path matching, scope checking, scope-expansion detection | EX-03 |
| `lease` | Issue, validate, consume, expire, revoke | HI-03, HI-04, 9.5 |
| `runGraph` | Nodes/edges, checkpoints, branch derivation, branch comparison | EX-04 |
| `provenance` | Source type, trust level, derivation relations, contamination propagation | 9.4, 11.2 |
| `evidence` | Recording, level determination, independence determination, invalidation propagation | VF-01..VF-06 |
| `proof` | Proof Graph construction and completion-determination query | VF-04, 9.1 |
| `experience` | Candidate quarantine, promotion gate, demotion, evaluation records | LE-01..LE-04 |
| `autonomy` | Autonomy Envelope hard boundary, confirmation policy, rationale for autonomy increase/decrease | HI-04, HI-05 |

## 5. Modes and Degradation

| Mode | Capability | Purpose |
|---|---|---|
| Minimal | Only basic files, standalone commands, and deterministic verification | Evaluation, recovery, fault isolation; still usable when all third-party extensions are unavailable |
| Standard | Project understanding, Context Plan, tools, verification, experience | Default |
| Isolated | Execute in an isolated Workspace | High-risk tasks or tasks that require reproduction |
| Replay | Execute only state, verification, or execution replay | Consistency checks and auditing |

Degradation must state the capability loss and the evidence impact; **it must not silently degrade and then continue to claim the same level of proof** (EX-05).

## 6. Protocol and Interoperability Direction

- **Keystone Run Protocol** (defined and versioned in this phase): Outcome Contract, Capability Lease, Provenance, Evidence, Proof, Checkpoint, Intervention.
- **Open Responses**: model provider interoperability.
- **MCP**: tools and external resources.
- **ACP**: IDE and client onboarding (P1).
- **Agent Skills**: reusable capability packages (treated as untrusted capability input).
- **A2A**: remote Agent collaboration (P2).

Protocol adapters cannot change the Contract, Lease, Provenance, Evidence, or completion semantics; semantics that cannot be expressed must be explicitly degraded or rejected, and must not be silently dropped (ST-03).

## 7. Current Implementation Order

Per `ROADMAP.md`: M0 engineering foundations and documentation baseline → M1 UI-less kernel loop → M2 runtime and CLI loop → M3 extension SDK and conformance tests → M4 desktop workbench (Tauri thin shell). This phase covers the kernel and CLI portions of M0–M3; the desktop shell only sets the tone and is not implemented.
