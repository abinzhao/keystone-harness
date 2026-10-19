# AGENTS.md

This document is intended for AI agents and human contributors working in this repository, and explains the engineering constraints and kernel invariants that must be followed. This document is a process constraint, not a product requirement; the authoritative basis for product capabilities is [`需求文档.md`](./需求文档.md) (PRD v1.0).

## 1. Repository Positioning

Keystone is an **evidence-native, local-first engineering Agent Harness**: it continuously understands a project, autonomously completes complex engineering tasks within the hard boundaries set by the user, and proves that results meet delivery conditions using independent evidence that is replayable and falsifiable.

The engineering stance in one sentence: **the model proposes actions, the kernel constrains the boundaries, evidence determines completion, and experience only changes the future after it has been verified.**

## 2. Kernel Invariants

The following invariants are the kernel's stable contract. Any change must ensure they hold, and they must not be bypassed by extensions, plugins, models, or clients.

1. **The model cannot change authoritative state, permissions, or completion decisions.** The model can only propose Action Proposals and candidate experience; it cannot modify the target result, permissions, verification results, completion status, or long-term project knowledge on its own.
2. **Only kernel events can change authoritative state.** State changes for execution, verification, recovery, and experience promotion must be triggered by kernel events; interfaces, extensions, protocol adapters, and model text must not directly rewrite state. The target state is derived deterministically by replaying state over the event graph.
3. **Side effects must pass through a Capability Lease.** All operations with side effects must pass through the unified execution boundary and be bound to a subject, capability, resource, parameters, budget, and validity period; unauthorized capabilities, out-of-scope resources, and disallowed network access are denied by default.
4. **Provenance and trust levels must propagate.** Context, summaries, caches, sub-agent returns, Skill outputs, memories, Evidence, and Proof must all preserve their provenance, trust level, and derivation relationships. Transformations may add restrictions but must not silently elevate trust.
5. **Extensions cannot escalate privileges on their own.** Extensions may add restrictions or request confirmation, but must not grant permissions on their own or replace the kernel's completion rules, state machine, permission issuance, evidence integrity, or completion decisions.

These invariants correspond to the PRD's trust commitments, completion rules, provenance propagation rules, and extension rules (PRD 2, 9.1, 9.4, 9.7, 11).

## 3. Directory and Package Boundaries

This repository is a TypeScript monorepo, with code located under `packages/`. The responsibility boundaries of each package are as follows; dependencies may only point in one direction toward lower layers, and cycles are forbidden:

| Package | Responsibility | What it must not do |
|---|---|---|
| `packages/schemas` | Authoritative Schema and runtime validators: Contract, Run Event, Capability Lease, Evidence, Proof, Context Plan, Project Fact, Experience, Extension Manifest; canonical encoding and content addressing | Depend on any business logic; reverse-depend on upper-layer packages; access the filesystem, network, or models |
| `packages/kernel` | Authoritative state: event ledger and state folding, state machine, Contract compilation/revision, Capability Lease issuance, Run Graph and checkpoints, provenance propagation, Evidence, Proof decisions, Experience Firewall, Autonomy Envelope; `KernelSession` is the only write entry point | Execute side effects, call models, access the network; depend on upper-layer business logic |
| `packages/models` | Model adapters and routing (BYOK OpenAI-compatible + local offline scripted) | Modify task state; hold long-term credentials in plaintext |
| `packages/tools` | Built-in tools (fs / search / standalone commands / git) and the unified execution boundary | Bypass the Capability Lease to produce side effects directly |
| `packages/verifiers` | Built-in verifiers (test / typecheck / lint / build / diff_scope / project_rule), producing results and truthfully declaring their evidence level and independence | Write Evidence directly (it is written by the kernel); relax completion conditions; guess unrecognized commands |
| `packages/runtime` | Composition root: assembles the kernel and extensions; implements the Builder Loop and Assurance Loop, Context Plan, budget and autonomy, human intervention, and degraded mode | Bypass `KernelSession` to modify state directly |
| `packages/extensions` | Extension Manifest validation, integrity, installation review, conformance suite, registry, activation gating, and isolation | Grant permissions; replace kernel invariants |
| `packages/i18n` | Presentation-layer localisation: language resolution and the zh-CN/en message catalogs. A dependency-free leaf; only human-readable text travels through it | Depend on any other package; carry protocol field names, event types, schema paths, or proof text — those are machine formats and stay English |
| `packages/cli` | Headless client: project onboarding, task execution, recovery, branch comparison, proof export, replay, protocol export, model configuration | Maintain semantics inconsistent with the kernel; hold independent state |

The dependency direction is one-way: `cli → runtime → {kernel, tools, verifiers, models, extensions} → schemas`, with `i18n` as an additional dependency-free leaf that the presentation layers (`cli`, `runtime`) may use. `kernel` does not depend on any execution layer, so it can be replayed independently, and it stays free of `i18n` so the proof package remains language-neutral.

Conventions:

- Everything uses **TypeScript**, with **zero runtime dependencies** (dependency-free in production).
- Use **Node native type stripping + `node:test`** for running and testing, without introducing build-time transpilation dependencies.
- **There is only one effective source**: the validator combinators of `defineSchema`. TypeScript types are inferred from the validators via `InferSchema`, and JSON Schema is generated by the same set of combinators via `toJsonSchema()`; neither is maintained by hand redundantly, so they cannot diverge from runtime validation (PRD 12.5 NFR-COMP-05, 18.3).
- Packages reference each other via pnpm workspace **symlinks** (`workspace:*`). Node refuses to type-strip `.ts` files inside a real `node_modules` directory, but it allows it for symlinks, so dependencies must be symlinks rather than copies.

## 4. Code Conventions

- Use only syntax that can be erased by Node native type stripping. Non-erasable syntax such as `enum`, `namespace`, and constructor parameter properties is **forbidden**.
- Relative imports **must include the `.ts` extension** (required by Node native ESM + type stripping).
- Prefer following existing naming, directory, error-handling, and testing patterns; modify only the code necessary to accomplish the goal.
- Do not manually modify generated files, third-party code, build artifacts, or lockfiles; when a change is truly needed, modify the authoritative source file or rerun the generation tool.
- Comments explain reasons, boundaries, and counterintuitive behavior; they do not restate the code.

## 5. Commit and Testing Requirements

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for details).
- Each commit must be traceable to a specific requirement or completion criterion, and unrelated formatting changes must not be mixed in.
- Before modifying the kernel, Schema, or protocol, first complete or update the corresponding documentation and invariant descriptions (see Section 6).
- Changes must include minimal relevant tests; changes involving state, evidence, recovery, or permissions must cover the corresponding invariants.
- Before committing, at least pass type checking and tests locally (commands in [`CONTRIBUTING.md`](./CONTRIBUTING.md)).
- Commits include a DCO sign-off (`Signed-off-by`); see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for details.

## 6. Document Invariants First, Then Change the Kernel

Before modifying `packages/kernel`, `packages/schemas`, protocol semantics, or any behavior related to kernel invariants, you must first:

1. Explain in the PRD or an ADR (`docs/adr/NNNN-*.md`) the impact of the change on the Section 2 invariants, contracts, Leases, provenance propagation, and completion decisions;
2. If it is a breaking semantic change, follow ADR + major version + migration guide (PRD 18.3, NFR-COMP-02);
3. Update the version and compatibility notes of the corresponding Schema;
4. Add Conformance Kit cases proving that extensions or clients still satisfy the invariants.

**Changes that alter kernel behavior must not be merged without documented invariant support.**

## 7. Related Documents

- Product requirements: [`需求文档.md`](./需求文档.md)
- Contribution process: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Security and threat model: [`SECURITY.md`](./SECURITY.md)
- Governance and ADR process: [`GOVERNANCE.md`](./GOVERNANCE.md)
- Roadmap: [`ROADMAP.md`](./ROADMAP.md)
