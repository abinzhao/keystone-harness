# Roadmap (ROADMAP)

This roadmap aligns with the three tiers P0/P1/P2 in Section 4 (version scope) of the [product requirements](./需求文档.md). P0 is broken down into verifiable milestones M0–M4; each milestone gives its **goal / deliverables / acceptance criteria**, and the acceptance criteria aim to be observable and reproducible.

> Current status (against this file's acceptance criteria):
>
> - **M0 complete**: governance documents, ADR-0001..0005, the architecture description, the TypeScript monorepo, and the type-check and test scripts are all in place, and the root commands are runnable.
> - **M1 complete**: the kernel closed loop (project onboarding and snapshots, Contract compilation/revision/import-export, Run Graph with checkpoints/branching/recovery/replay, evidence levels and Proof Graph, evidence invalidation, bounded automatic repair, Experience Firewall, machine-readable formats) is implemented and test-covered.
> - **M2 complete**: Context Plan, Capability Lease and the unified execution boundary, Autonomy Envelope and human intervention, verifiers and budgets, proof export, cloud/local model interfaces and switching, the four run modes (minimal/standard/isolated/replay) with degradation recording, and Git and workspace operations (isolated mode based on `git worktree`). **Known gap**: Git write operations (commit/rollback) are not implemented; only read-only Git tools + worktree isolation.
> - **M3 complete**: Manifest validation and integrity, installation review, the conformance suite, the registry, activation gating and isolation, and the runnable reference extension `@keystone/extension-no-debug-statements` (with end-to-end registration/activation/isolation tests).
> - **M4 partially complete**: the local Run Protocol service (loopback + token authentication) and the four-zone workbench single page (task list / goal and completion criteria / proof and evidence / human intervention) have been delivered, and rendering and data were verified in a real browser. **Not complete**: Tauri packaging, signing and notarization, native windows and system integration (menus, tray, deep links).
> - **Performance**: measurement scripts and a first baseline have been established (`docs/performance/baseline-2026-10-19.md`). The local data layer is in the millisecond p95 range; **workspace scanning is not included in the measurements**, so NFR-PERF-01 does not yet constitute complete verification.
>
> The P1/P2 scope is listed as in PRD 4.2/4.3, without further breakdown.

## P0: Evidence-native single-project closed loop

### M0 — Engineering foundation and documentation baseline

| Item | Content |
|---|---|
| Goal | Establish a contributable engineering and documentation baseline so that kernel invariants, contracts, and the security model are fixed ahead of the implementation |
| Deliverables | Governance documents (`AGENTS.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, `SUPPORT.md`, `ROADMAP.md`, `CHANGELOG.md`); `docs/adr/` and the first ADRs; `docs/research/` competitive analysis; the TypeScript monorepo skeleton (`packages/` boundaries, Node native type stripping + `node:test`, type-check and test scripts) |
| Acceptance criteria | The root commands `pnpm install`, type checking, and tests are executable; each `packages/` boundary conforms to `AGENTS.md` §3; at least 1 ADR is `Accepted`; kernel invariants can be traced item by item in the documentation |

### M1 — Kernel closed loop without UI

| Item | Content |
|---|---|
| Goal | Without a desktop shell, use the kernel + CLI to run the minimal closed loop of "onboard project → define outcome → execute → verify → prove → isolate experience" |
| Deliverables | Local Git project onboarding, workspace snapshots, and a basic Project World Model (with provenance, applicable snapshot, trust level, and invalidation conditions); Outcome Contract compilation, revision, conflict surfacing, and versioning; a branchable Run Graph, checkpoints, pause, recovery, derivation, and state replay; Verifiers and evidence levels (E0–E4), Proof Graph, outcome proof and evidence invalidation, bounded automatic repair; Experience Firewall, candidate experience isolation, and user corrections; machine-readable Contract / event / Evidence / Proof formats |
| Acceptance criteria | Replaying state over the same event graph yields a consistent authoritative state (NFR-REL-05); a task enters "proven" only when all required completion criteria have evidence at the prescribed level that has not been invalidated, and model text cannot trigger it; after workspace changes, affected evidence is precisely marked as invalidated along the Proof Graph; candidate experience does not enter context by default, and unpromoted experience does not appear in the execution context |

### M2 — Runtime and CLI closed loop

| Item | Content |
|---|---|
| Goal | Complete the runtime's governance capabilities so that tasks can execute continuously, explainably, and interruptibly within the user's hard boundaries |
| Deliverables | Context Plan (provenance, budget, exclusions, invalidation conditions); Capability Lease and the unified execution boundary (files, code search, editing, standalone commands, Git and workspace operations); user hard boundaries and Autonomy Envelope, scope checking, non-modal human intervention; test/typecheck/lint/build/scope/diff/project-rule verification; cost and budget display; machine-readable proof export; compatible cloud and local model interfaces and model switching |
| Acceptance criteria | All operations with side effects execute through a Capability Lease, and out-of-scope writes pause and can be rejected (PRD 8.4 EX-03); scope expansion must produce a reviewable user decision, and the Autonomy Envelope is not automatically expanded by the model/extension/past successes; model switching does not change a task's business state or completion criteria (NFR-REL-04); after the application exits, it can recover from a checkpoint (PRD 3.4); the CLI can perform state replay for the same task or export a machine-readable proof (PRD 14.12) |

### M3 — Extension SDK and conformance testing

| Item | Content |
|---|---|
| Goal | Open up governed extension points so that contributors can plug in capabilities without touching the kernel |
| Deliverables | Extension Manifest (name, version, publisher, integrity, capabilities, IO Schema, data egress, producible Observation/Evidence, replayability, idempotency, uninstall behavior); minimal Model/Tool/Verifier SDK; conformance tests (Conformance Kit) and a reference extension; extension activation/isolation/degradation flows |
| Acceptance criteria | Extension installation/upgrade goes through integrity checking, dependency resolution, conformance testing, risk disclosure, and user confirmation; extensions cannot authorize themselves, replace kernel completion rules, or disable safe mode (PRD 8.11, 11.7); when an extension crashes/times out/violates its Manifest it is isolated and checkpoints are retained; installing a reference extension reveals its capabilities, permissions, data egress, and conformance test results (PRD 14.13) |

### M4 — Desktop workbench

| Item | Content |
|---|---|
| Goal | Provide ordinary users' primary working surface through a thin Tauri shell, without changing kernel semantics |
| Deliverables | Four-zone workbench (title bar / left / center / right / bottom, with fixed responsibilities); task list and isolation switching; execution trace; outcome proof panel; input area; settings and local data management (BYOK, local data viewing and cleanup, protocol and runtime compatibility) |
| Acceptance criteria | Fully walk through all the closed loops of first-release acceptance 1–13 in PRD Section 14; zone responsibilities and information priority are not changed by visual adjustments (PRD 8.9 UI-01); when switching tasks, the goal, workspace, project understanding, and evidence remain isolated; the p95 target from cold start to being able to view persisted tasks is ≤ 1.5 seconds (NFR-PERF-01, requiring baseline hardware and dataset in a public performance specification) |

> First-release acceptance (PRD §14) is M4's overall exit criterion; the acceptance criteria of M1–M3 are its observable subsets under no UI / partial capability.

## P1: Cross-surface, isolated parallelism, and ecosystem

Aligned with PRD 4.2:

- ACP-compatible IDE integration and non-interactive CI runs.
- Unified management of multiple local projects.
- Parallel write tasks isolated by worktree or separate workspace.
- Sub-agents enabled by benefit and isolated in context and permissions.
- Project Analyzer, Workspace Runtime, and Protocol Adapter SDK.
- MCP and Agent Skills integration and Harness Lab.
- Second batch of programming language and engineering framework adaptations.
- Differential verification, isolated replay, mutation checking, and richer semantic verification.
- Positive transfer, negative transfer, and forgetting evaluation for experience.

## P2: Remote collaboration and open ecosystem

Aligned with PRD 4.3:

- A2A-compatible remote agent delegation.
- Remote and clustered Workspace Runtime.
- Team-shared project rules, experience, and proofs.
- Signed proofs, external trusted verification, and cross-machine replay.
- An ecosystem of verifiers, rules, Workspace, and experience templates.
- Multi-agent branch comparison, controlled merging, and task-graph collaboration.

## Currently out of scope (PRD 4.4)

General-purpose everyday office agents; multi-agent software factories that make agent count the goal and are enabled by default; centralized enterprise web admin backends; mobile clients and remote signing; automatic payments, email sending, and production deployment; plugin or Skill marketplaces without isolation, conformance testing, and permission declarations; automatically escalating a single failure into a long-term project rule; allowing extensions to replace the state machine, permission issuance, evidence integrity, or completion determination; using a model's chain of thought as proof, an audit record, or a user deliverable.

## Leadership gate (PRD 13.1)

Keystone does not claim leadership by feature count. A stable release must satisfy the cross-stage leadership gate under the same model, same task, same permissions, same time, and same token budget; the specific numeric thresholds are determined by public baseline evaluations and are not presupposed without data. Any statement of "leadership" must cite the current scorecard and a reproducible experiment (PRD 18.6).
