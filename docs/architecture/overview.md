# Architecture Overview

Keystone is a local-first runtime for engineering agents. The architecture separates cognition from authority: models and extensions propose work, while the kernel owns state transitions, authorization, evidence, and completion.

This document describes the `1.0.0-rc.1` source tree. Decisions that change these boundaries belong in an Architecture Decision Record (ADR).

## Core Invariants

1. **The model cannot change authoritative state.** Model output is an untrusted proposal. It cannot issue permissions, alter completion conditions, or mark a task complete.
2. **Kernel events are the only write path for task state.** Replaying the event ledger must reproduce the authoritative state.
3. **Every side effect requires a Capability Lease.** A lease binds the subject, capability, resource, parameters, budget, and validity period for one operation.
4. **Provenance and trust propagate.** Context, summaries, tool output, evidence, and experience retain their source and derivation. A transformation may lower trust but cannot silently raise it.
5. **Extensions cannot grant themselves authority.** Extensions may add checks or request confirmation; they cannot relax kernel policy or replace completion logic.

## Package Boundaries

| Package | Owns | Must not |
|---|---|---|
| `@keystone/schemas` | Versioned validators, inferred TypeScript types, JSON Schema, canonical encoding, content addressing | Access files, networks, models, or upper layers |
| `@keystone/kernel` | Event ledger, state folding, contracts, leases, run graph, provenance, evidence, proof, experience, autonomy | Execute tools, call models, or access the network |
| `@keystone/spawn` | Cross-platform child-process target resolution and Windows argument escaping | Carry task or scenario policy |
| `@keystone/models` | BYOK model transports, routing, and deterministic offline models | Modify task state or store plaintext credentials |
| `@keystone/tools` | Lease-checked filesystem, search, command, and Git operations | Execute a side effect without a valid lease |
| `@keystone/verifiers` | Test, typecheck, lint, build, scope, and project-rule checks | Write evidence directly or relax a completion condition |
| `@keystone/extensions` | Manifest validation, integrity, installation review, conformance, registry, isolation | Grant permissions or replace kernel decisions |
| `@keystone/pack-engineering` | Workspace analysis, engineering contract proposals, action-to-capability mapping | Become a kernel dependency or write authoritative state |
| `@keystone/i18n` | Human-readable Chinese and English presentation text | Carry protocol fields or proof content |
| `@keystone/runtime` | Composition root, Builder/Assurance loops, context planning, budgets, intervention, local service | Bypass `KernelSession` for state changes |
| `@keystone/cli` | Project, task, proof, replay, model, extension, and service commands | Maintain state semantics separate from the kernel |
| `@keystone/desktop` | Supervised local proxy and macOS WKWebView host | Create a second runtime or expose the bearer token to the webview |

Dependencies point toward lower layers:

```text
cli -> runtime -> kernel -> schemas
               -> models -> schemas
               -> tools -> kernel, schemas, spawn
               -> verifiers -> kernel, schemas, spawn
               -> extensions -> kernel, schemas, tools, spawn
               -> pack-engineering -> kernel, schemas

i18n and spawn are dependency-light leaves.
desktop supervises the CLI/runtime process through the local protocol.
```

The kernel does not import the engineering scenario pack. The runtime injects two policy seams:

- `ContractProposer` turns a scenario-specific request into a proposed Outcome Contract.
- `ActionCapabilityResolver` maps an action proposal to the capability and resource values the kernel must authorize.

If either policy is required but not wired, the session fails instead of guessing.

## Authoritative Task Flow

1. **Inspect the project.** The engineering pack derives project facts and records their provenance.
2. **Compile a contract.** The proposed Outcome Contract defines the goal, scope, invariants, completion conditions, evidence requirements, budget, and intervention rules.
3. **Plan context.** The runtime selects context with source, trust, budget, and invalidation metadata.
4. **Propose an action.** A model or deterministic adapter returns an Action Proposal.
5. **Authorize the action.** The kernel resolves the required capability, checks scope and policy, and issues a short-lived Capability Lease.
6. **Execute through a boundary.** A tool validates the lease before performing the side effect and returns an observation.
7. **Verify independently.** Verifiers evaluate the contract conditions and return graded results. The kernel records accepted evidence.
8. **Determine completion.** The proof graph reaches `proven` only when all required conditions have valid, current, sufficiently independent evidence.
9. **Learn cautiously.** Verified runs may create candidate experience. Promotion and later demotion remain kernel decisions.

The model participates in steps 4 and, depending on configuration, context planning. It does not own steps 5, 8, or 9.

## State and Storage

Runtime state lives under `~/.keystone/` by default; `KEYSTONE_HOME` can override the location.

- Task ledgers are append-only JSON Lines files.
- Large artifacts are stored by content hash.
- Checkpoints and branches refer back to ledger state.
- Indexes, caches, and rendered proofs are derived data and may be rebuilt.
- Credentials live in a separate owner-readable credential store and must not enter logs, evidence, or proof exports.

Workspace, dependency, contract, verifier, or project-fact changes invalidate only the evidence that depends on the changed input.

## Execution Boundary

Commands are represented as an executable plus an argument array. POSIX execution does not use a shell. On Windows, known `.cmd` and `.bat` launchers require `cmd.exe`; `@keystone/spawn` escapes their arguments before execution.

Git reads and writes are separate capabilities. `git.commit` and `git.rollback` require a scoped `git.write` lease. If requested writes overlap changes that existed before the task, startup is refused with recovery guidance.

Network access is denied unless the active capability and model configuration allow the target host.

## Evidence and Proof

Evidence records include the producer, level, independence, subject, contract revision, workspace snapshot, and invalidation conditions. A model statement is an observation, not proof.

The proof graph is evaluated deterministically. A required condition remains unsatisfied when evidence is missing, stale, below the required level, circular, or produced without the required independence.

Proof packages are language-neutral machine data. Localisation affects presentation only; it must not change protocol field names, schema validation paths, event types, or content-addressed proof bytes.

## Extension Boundary

An extension declares its identity, version, integrity, capabilities, schemas, data handling, evidence types, replay properties, dependencies, and uninstall behavior. Installation validates the manifest and entry bytes, runs conformance checks, and presents risk before activation.

Local `stdio` MCP servers and on-disk Agent Skills use this extension path. They are treated as untrusted input and gain no capability from their location or publisher name.

Protocol adapters must preserve Contract, Lease, Provenance, Evidence, and Proof semantics. If another protocol cannot express one of these objects, the adapter must reject or explicitly degrade the operation. Silent loss is not allowed.

## Compatibility Rules

- Runtime validators are the single source for TypeScript types and generated JSON Schema.
- Relative TypeScript imports include the `.ts` extension.
- Code must use syntax supported by Node native type stripping; `enum`, `namespace`, decorators, and constructor parameter properties are not used.
- Breaking changes to kernel, schema, protocol, or extension semantics require an ADR, a major version, and migration guidance.
- Stable data support must retain read or export capability for the current and previous major formats.

See the [ADR index](../README.md#architecture-decision-records) for the decisions behind these rules.
