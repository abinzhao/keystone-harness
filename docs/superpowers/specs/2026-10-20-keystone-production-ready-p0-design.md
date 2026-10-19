# Keystone Production-Ready P0 Design

**Status**: Approved for planning
**Date**: 2026-10-20
**Scope**: Production-ready P0 release
**Authoritative product baseline**: `需求文档.md`
**Architecture constraints**: `AGENTS.md`, ADR-0001 through ADR-0005

## 1. Objective

Deliver a production-ready Keystone P0 that can safely perform real TypeScript
and JavaScript engineering tasks in a local Git repository through the same
runtime from the CLI, local Run Protocol, web workbench, and macOS desktop shell.

Production-ready means all of the following are true:

1. Every authoritative state change is caused by a valid kernel event.
2. Every side effect, including model access, verifier execution, workspace
   creation, and extension execution, is covered by a valid Capability Lease.
3. Evidence is accepted only from registered producers and is bound to the exact
   task, branch, Contract revision, workspace snapshot, producer version, and
   execution environment it describes.
4. A task is `proven` only when the current Proof Graph supports every required
   condition and the current workspace still matches the verified snapshot.
5. Tool and verifier observations return to the Builder Loop as provenance-aware
   context, so execution is a real observe-act-verify loop.
6. Pause, stop, crash recovery, branch execution, and replay preserve the task's
   state and never silently continue against a changed workspace.
7. Project cognition, context caching, experience reuse, and invalidation are
   explainable and do not change completion or permission semantics.
8. The workbench exposes the full first-release journey without requiring the
   user to understand event logs, hashes, or protocol objects.
9. Release artifacts pass automated correctness, security, recovery,
   compatibility, performance, accessibility, and packaging gates.

The design converts subjective goals such as "perfect UX" into observable
release criteria. It does not claim that a product is defect-free.

## 2. Scope Decision

### 2.1 Adopted approach

Use a staged production-ready P0 program:

1. Close authority and proof invariants.
2. Build one governed execution path for every side effect.
3. Make tasks resumable and branches executable.
4. Complete project cognition, context planning, and experience handling.
5. Connect the extension host to the runtime.
6. Complete the workbench and desktop shell.
7. Establish release evidence and operational readiness.

Each stage must produce independently testable software and may not rely on a
later stage to repair a violated kernel invariant.

### 2.2 Rejected approaches

**Big-bang P0/P1/P2 implementation** is rejected. ACP, MCP, Agent Skills, A2A,
remote Workspace, team sharing, and multi-agent collaboration are independent
product programs. Implementing them before P0 is trustworthy would multiply the
permission, compatibility, and recovery surface without improving the first
release's core task success.

**Kernel-only hardening** is rejected. It would improve internal correctness but
would not provide a usable task journey, a real recovery path, an integrated
extension, or a releaseable desktop product.

### 2.3 P0 release boundary

P0 includes:

- Local TypeScript and JavaScript Git repositories.
- pnpm, npm, and Yarn projects whose commands are explicitly identified.
- One active writer per workspace; isolated branches use dedicated worktrees.
- OpenAI-compatible cloud and local model adapters.
- Built-in filesystem, search, command, Git-read, verification, and workspace
  capabilities.
- Governed Model, Tool, and Verifier extensions.
- CLI, loopback Run Protocol, web workbench, and a thin macOS desktop shell.
- Local storage, migration, export, cleanup preview, and recovery.

P0 does not include:

- ACP, MCP, Agent Skills, A2A, or remote agent delegation.
- Remote or clustered workspaces.
- Team-shared rules, experience, or proofs.
- Parallel writers in one non-isolated workspace.
- Production deployment, payment, email sending, or other external high-risk
  writes.
- E4 external trust roots or signed third-party proofs.

These capabilities remain versioned P1/P2 roadmap items with explicit acceptance
criteria in the revised PRD.

## 3. Launch Impact

| Dimension | Applies | P0 posture |
| --- | --- | --- |
| External commitment | Yes | Public source, CLI, desktop artifact, and protocol compatibility are release commitments. |
| Customer criticality | Yes | Incorrect edits or false completion can damage a user's codebase. |
| Data sensitivity | Yes | Source code, logs, issue text, credentials, and model context may be sensitive. |
| State durability | Yes | Task ledgers, checkpoints, evidence, facts, and experience must survive crashes. |
| Blast radius | High but local | Default scope is one local workspace; command, model, or extension escape can widen it. |

The release remains blocked until all Gate G7 criteria in Section 13 pass. There
is no risk exception for false `proven`, unauthorized side effects, lost task
state, credential disclosure, or unrecoverable workspace damage.

## 4. Target Architecture

### 4.1 Stable package direction

The existing dependency direction remains:

`cli -> runtime -> {kernel, tools, verifiers, models, extensions} -> schemas`

`i18n` remains a dependency-free presentation leaf. The desktop shell consumes
the Run Protocol and does not acquire independent task semantics.

### 4.2 Deep modules

#### Evidence Authority

Location: `packages/kernel`.

Responsibilities:

- Register trusted Evidence producers and their evidence ceiling.
- Accept Evidence only through `KernelSession`.
- Bind Evidence to task, branch, Contract id and version, workspace snapshot,
  producer id and version, and environment fingerprint.
- Reject Evidence whose producer, condition, lease, or execution receipt cannot
  be traced.
- Invalidate Evidence and current Proof usability from kernel events.
- Preserve historical verdicts without presenting them as currently valid.

The Proof evaluator filters by all binding fields before checking evidence level
or independence. Direct low-level Evidence persistence is internal to the
kernel package and is not an extension interface.

#### Governed Action Runtime

Location: `packages/runtime`.

Responsibilities:

- Execute model calls, tools, verifiers, workspace operations, and extensions
  through one governed action interface.
- Request a Capability Lease before the side effect.
- Validate action parameters against the producer's input Schema.
- Capture actual parameters, environment fingerprint, model route, usage,
  stdout, stderr, artifacts, changed paths, and duration.
- Consume or revoke the Lease after the action.
- Rescan the workspace after any action capable of modifying files.
- Return an Observation to the next Builder or Assurance step.
- Stop issuing new leases after pause, stop, or budget exhaustion.

The runtime no longer calls model adapters, verifier processes, or worktree
operations directly.

#### Task Continuation Engine

Location: `packages/runtime`.

Responsibilities:

- Start a new task, continue an existing task, resume a checkpoint, execute a
  branch, or perform read-only replay through one interface.
- Acquire a workspace writer lease before modifying a workspace.
- Restore the exact branch, Contract, budget, context state, and pending steps.
- Compare the recorded and current workspace before continuation.
- Recompute affected plans and verification after explainable external changes.
- Refuse recovery when the ledger, checkpoint, producer set, or workspace cannot
  be trusted.

Replay never executes a non-replayable side effect. Branch execution always uses
an isolated worktree and has branch-local budget, context, Evidence, and change
tracking.

#### Project Cognition

Location: `packages/kernel` for authoritative facts and
`packages/runtime` for analyzers and retrieval.

Responsibilities:

- Persist workspace snapshots and incremental scan metadata.
- Identify packages, modules, entry points, command sources, instruction-file
  scope, and test-to-implementation mappings.
- Track source provenance, validity interval, observation time, applicable
  snapshot, trust, and invalidation dependencies.
- Parse hierarchical `AGENTS.md` and supported instruction files without
  treating them as authorization.
- Maintain a content-addressed retrieval cache whose deletion changes
  performance only.
- Build Context Plans from current facts, files, Evidence, promoted experience,
  user decisions, and prior Observations.
- Record actual model input and output token usage separately from planning
  estimates.

The initial analyzer remains deliberately language-limited to TypeScript and
JavaScript. Unsupported semantics are reported, not guessed.

#### Extension Host

Location: `packages/extensions` and `packages/runtime`.

Responsibilities:

- Install from a local package path after integrity and Manifest validation.
- Resolve declared dependencies and conflicts.
- Run the Conformance Kit before activation.
- Require a reviewable user decision for installation or upgrade.
- Load an extension in an isolated worker or child process.
- Clamp extension capabilities to the task and project envelope.
- Supervise timeout, crash, protocol violation, and undeclared output.
- Isolate or disable the extension without losing task state.
- Register extension tools and verifiers with the Governed Action Runtime.

The reference no-debug-statements extension must be installable, inspectable,
activatable, usable by a real task, and isolatable through CLI and workbench
flows.

#### Run Protocol And Clients

Location: `packages/runtime`, `packages/cli`, `packages/runtime/web`, and
`apps/desktop`.

Responsibilities:

- Perform protocol version and capability negotiation.
- Expose project, cognition, Contract, task, branch, checkpoint, context,
  Evidence, Proof, model, extension, and data-management operations.
- Support idempotency keys on mutating requests.
- Stream task events and progress without polling-only semantics.
- Preserve one semantic implementation in the runtime; clients render
  projections and submit user intent.

The CLI uses the same client interface as the workbench for task operations.
Kernel diagnostics may retain a local maintenance command that is explicitly
read-only.

## 5. Authoritative Data And Transactions

### 5.1 Ledger ownership

`KernelSession` is the only public authoritative write interface. Low-level
event construction, ledger append, Evidence persistence, Fact mutation,
Experience promotion, branch creation, and checkpoint mutation become
package-internal implementation details or require a validated kernel command.

### 5.2 Single-writer correctness

Every append transaction:

1. Acquires the task or branch lock.
2. Reloads and verifies the current ledger under the lock.
3. Verifies the caller's expected chain tip.
4. Builds and appends the next event.
5. Folds the complete verified ledger.
6. Releases the lock.

A workspace lock independently enforces one active writer per real workspace.
Read tasks bind to a snapshot and become stale when a writer changes a covered
path.

### 5.3 Multi-file durability

Operations spanning a ledger and a derived store use this order:

1. Persist content-addressed immutable artifacts.
2. Append the authoritative event referencing those artifacts.
3. Update rebuildable projections.

If projection update fails, the event remains authoritative and the projection
is rebuilt. No authoritative decision depends on a projection-only write.

### 5.4 Schema compatibility

Contract, Run Event, Capability Lease, Context Plan, Project Fact, Evidence,
Proof, Experience, Extension Manifest, and Run Protocol envelopes carry
independent Schema versions.

The Runtime reads the current and previous major persisted formats. Migration is
previewed, atomic, backed up, and reversible. Unsupported newer data opens in
read-only diagnostic and export mode.

## 6. End-To-End Data Flow

### 6.1 Project onboarding

1. The user chooses a Git workspace.
2. Keystone verifies path access and Git status.
3. The runtime acquires a read snapshot and persists its metadata.
4. The analyzer detects project support, commands, package boundaries,
   instructions, and test mappings.
5. The kernel accepts verified Project Facts with provenance.
6. The workbench shows coverage, unknowns, freshness, dirty files, and the
   support matrix before task creation.

### 6.2 Task intake and Contract approval

1. The user describes a task and optionally references files, directories,
   issue text, or logs.
2. The compiler proposes a goal, scope, invariants, completion conditions,
   evidence requirements, budget, autonomy envelope, uncertainties, intervention
   triggers, and exit conditions.
3. The workbench presents a compact Contract review.
4. A ready low-risk Contract may start under the user's saved policy.
5. An unresolved, high-risk, or scope-expanding Contract requires a decision
   bound to the exact Contract version.
6. `awaiting_approval` cannot transition to execution without a live decision.

### 6.3 Observe-act-verify loop

1. The Context Planner selects the minimum current context and explains
   exclusions.
2. A leased model action produces a validated Action Proposal and measured usage.
3. The kernel authorizes the proposed capability and resources.
4. The Governed Action Runtime executes one action and records the receipt.
5. Its Observation is available to the next Context Plan.
6. File-capable actions trigger a workspace rescan and precise invalidation.
7. The Assurance Loop runs affected checks during repair and the full required
   set before completion.
8. The Proof Graph decides whether work is proven, repairable, waiting, or must
   exit.

### 6.4 Human intervention

A decision is not a status toggle. Applying it produces one of:

- A Contract revision.
- An Autonomy Envelope revision.
- A one-action authorization inside an already approved boundary.
- A budget revision.
- A structured answer added to the next Context Plan.
- A denial that records the reason and searches for an in-scope alternative.

The original blocked proposal is retried only when the resulting Contract and
Envelope cover it. Decisions are checked for task, branch, Contract version,
capability, resources, expiry, and actor.

### 6.5 Completion and delivery

The delivered Proof Package includes:

- Contract and condition results.
- Task-local changed paths and diff artifact.
- Evidence and producer identities.
- Project rules and facts relied upon.
- Context Plan decisions and cache use.
- Actual model routes and usage.
- Capability Leases and user decisions.
- Branch rationale.
- Environment and workspace snapshot.
- Reproduction commands.
- Unverified items and residual risks.

The Proof package has a deterministic content identity. Presentation timestamps
are outside that identity or are derived from the latest included event.

## 7. Recovery, Branching, And Replay

### 7.1 Checkpoints

Each stage checkpoint includes:

- Folded task and branch state.
- Contract id, version, and digest.
- Workspace snapshot and fingerprint.
- Dependency, tool, model, verifier, and extension fingerprints.
- Budget usage and remaining limits.
- Completed, pending, and verification step ids.
- Evidence, artifact, and active Lease references.

### 7.2 Resume

Resume restores the checkpoint and re-enters the continuation engine. A matching
workspace continues from the prior active stage. An explainably changed
workspace creates a new branch after affected facts, context, and Evidence are
invalidated. An unexplainable change requires user handling.

### 7.3 Branches

Every executable branch has:

- A branch-specific event ledger whose events use the branch id.
- An isolated worktree.
- A branch-local plan, budget, Evidence view, and changed-path set.
- A parent checkpoint reference.
- A deterministic comparison summary.

Branch comparison never counts Evidence created on a sibling branch after the
fork. Merging is not part of P0; the user may inspect and manually retain the
chosen worktree.

### 7.4 Replay

State replay folds stored events and checks projections. Verification replay may
rerun declared replayable verifiers in a fresh workspace. Execution replay
reuses stored receipts and artifacts; it never reruns arbitrary commands,
network calls, or writes.

## 8. User Experience

### 8.1 Product surface

The first screen remains the task workbench, not a landing page. The four-zone
responsibilities in the PRD remain stable:

- Title: current project, workspace, branch, runtime health, and pending count.
- Left: project switcher, tasks grouped by attention state, cognition freshness,
  and experience health.
- Center: Contract, current stage, task trace, checkpoints, branches, and diff.
- Right: Proof status, Evidence, risks, autonomy, extensions, and decisions.
- Bottom: task or constraint input, workspace state, model route, and measured
  budget.

### 8.2 First-run journey

The user can:

1. Add or choose a project.
2. Review support, dirty files, and detected commands.
3. Enter a task.
4. Review or edit the proposed Contract.
5. Start the task.
6. Observe progress without reading raw logs.
7. Pause, stop, answer a decision, revise scope, or increase budget.
8. Resume after restart.
9. Fork a checkpoint and execute an alternative.
10. Compare outcomes and inspect the selected diff.
11. Review the current Proof and export it.
12. Inspect or clear local data after an impact preview.

### 8.3 Interaction requirements

- Destructive actions require a preview and explicit confirmation.
- Buttons use familiar icons with accessible names and tooltips.
- Status is communicated by text and icon, never by color alone.
- Every loading, empty, permission, offline, degraded, failure, and stale state
  has a specific next action.
- Long-running tasks do not block navigation, pause, or stop.
- Keyboard focus order, landmarks, labels, contrast, and reduced motion meet
  WCAG 2.2 AA expectations.
- Responsive layouts preserve the task, proof, and decision paths at 1280 px,
  1024 px, 768 px, and 390 px widths without overlapping text.

### 8.4 Settings

Settings include:

- Model providers, routes, connection test, data egress, and credential handles.
- Project Autonomy Envelope and command/network restrictions.
- Extension installation, activation, isolation, and conformance details.
- Storage inventory, retention policy, cleanup impact preview, migration, and
  export.
- Runtime, protocol, Schema, and desktop versions.
- Language, theme, reduced motion, and diagnostic bundle controls.

## 9. Error Handling And Degraded Modes

Every failure maps to:

- A stable error code.
- A user-readable explanation.
- The affected task, branch, Contract, capability, or evidence.
- Whether a retry is safe.
- The exact next action.
- A diagnostic artifact that contains no credentials.

Rules:

- Model unavailability may route to another compatible model without changing
  the Contract. No compatible model means pause or orderly exit.
- Verifier failure is a failed condition; verifier unavailability is blocked,
  never passed.
- Extension failure isolates the extension and retains the checkpoint.
- Disk pressure stops new side effects before durability is endangered.
- Ledger or checkpoint integrity failure enters read-only diagnostics.
- Unsupported Schema versions enter read-only export mode.
- Workspace conflict stops writes and offers restore, branch, or exit choices.
- Minimal mode can always inspect, export, stop, and diagnose without third-party
  extensions.

## 10. Security And Privacy

P0 security controls include:

- Default-deny file, command, model, network, credential, extension, and
  workspace capabilities.
- Provenance-derived taint instead of caller-supplied trust booleans.
- Path containment for workspace scans as well as write tools.
- No shell command composition.
- Scrubbed process environments.
- Credential handles backed by the operating system keychain when available;
  a permission-restricted file store remains an explicit degraded fallback.
- Model egress preview bound to the exact Context Plan.
- Extension process isolation and capability clamping.
- Artifact and Proof redaction.
- A threat model and adversarial fixtures for prompt injection, malicious
  repositories, poisoned command output, symlink escape, extension
  under-declaration, and persisted memory contamination.

P0 does not expose a capability for external production writes.

## 11. Testing Strategy

### 11.1 Test layers

1. **Schema tests** prove single-source TypeScript, validator, and JSON Schema
   agreement.
2. **Kernel invariant tests** prove authority, binding, invalidation, state
   transitions, concurrency, and replay.
3. **Runtime integration tests** use real temporary Git repositories and child
   processes.
4. **Crash tests** terminate processes between artifact, event, checkpoint, and
   projection writes.
5. **Security tests** exercise path, command, provenance, credential, model
   egress, and extension attacks.
6. **Protocol contract tests** run the same task through CLI and Run Protocol and
   compare machine projections.
7. **Browser E2E tests** cover onboarding, Contract review, run control,
   intervention, resume, branch comparison, Proof, settings, and data cleanup.
8. **Accessibility tests** combine automated checks with keyboard and reduced
   motion journeys.
9. **Performance tests** cover real workspace scanning, task switching, Proof
   rendering, event streaming, and stop latency.
10. **Packaging tests** install, launch, upgrade, migrate, export, and uninstall
    the desktop artifact.

### 11.2 Required negative tests

- Evidence from another branch, task, Contract version, snapshot, or unregistered
  producer cannot satisfy a condition.
- Invalidating required Evidence changes current Proof usability immediately.
- Two concurrent Sessions cannot fork one ledger.
- Two writers cannot mutate one workspace.
- A stopped task receives no new Lease.
- A command that changes an unreported path is detected by the post-action scan.
- An approval that does not actually widen scope cannot resume the blocked action.
- A model or extension cannot create a user decision or kernel event.
- A corrupted cache cannot change task state or Proof.
- Restarting the server preserves actionable interventions and resumable tasks.

### 11.3 Release fixtures

The repository includes versioned fixture projects for:

- A single-package TypeScript project.
- A JavaScript project.
- pnpm, npm, and Yarn command detection.
- A dirty working tree.
- A monorepo with package-scoped instructions.
- A failing test repaired in one attempt.
- A repair requiring multiple observations.
- An external workspace edit.
- A crash and resume.
- A branch comparison.
- A malicious repository and extension.

Each fixture defines the initial snapshot, request, approved Contract, expected
event types, expected changed paths, expected condition results, and Proof
outcome.

## 12. Documentation And Product Contract

Before kernel implementation:

1. Revise `需求文档.md` to version 1.1.
2. Separate P0 release requirements from P1/P2 roadmap requirements.
3. Replace qualitative acceptance terms with thresholds or deterministic rules.
4. Add the versioned fixture-based release protocol.
5. Add explicit cleanup, migration, recovery, Evidence binding, and branch
   isolation semantics.
6. Correct ROADMAP statuses from `complete` to evidence-backed states.
7. Add ADRs for Evidence authority, governed action execution, task
   continuation, Project Cognition, Extension Host, and client protocol.

Public documentation must distinguish implemented, experimental, unsupported,
and planned capability. No README or release note may call a gate complete
without linking its current evidence.

## 13. Delivery Gates

| Gate | Required outcome |
| --- | --- |
| G1 Authority | Evidence binding, kernel-only writes, Proof invalidation, Lease lifecycle, and concurrency tests pass. |
| G2 Execution | All side effects use the governed runtime; Observations and measured budgets close the Builder/Assurance loop. |
| G3 Continuation | Resume, branch execution, replay, workspace locks, and crash tests pass. |
| G4 Cognition | Incremental Project Facts, Context Plan, cache, instructions, experience, and precise invalidation pass fixture tests. |
| G5 Extensibility | Reference extension installs, activates, runs in a task, fails safely, and can be disabled. |
| G6 Product | Full workbench, settings, desktop shell, accessibility, responsive, and browser E2E journeys pass. |
| G7 Release | CI, compatibility, migration, security, performance, packaging, SBOM, signing configuration, and release documentation pass. |

No later gate can waive a failed earlier gate.

## 14. Production Readiness Matrix

| Domain | Current status | Release evidence required |
| --- | --- | --- |
| Architecture | Blocker | Accepted ADRs and package conformance tests. |
| State correctness | Blocker | Concurrent writer, replay, recovery, and event authority tests. |
| Proof integrity | Blocker | Evidence binding and current-workspace invalidation tests. |
| Permission safety | Blocker | Unified Lease and no-new-Lease-after-stop tests. |
| Runtime usefulness | Blocker | Multi-observation real-repository acceptance tasks. |
| Recovery | Blocker | Process-kill and workspace-change recovery matrix. |
| Project cognition | Blocker | Incremental analyzer and context fixture scorecard. |
| Extensions | Blocker | Product installation and runtime isolation journey. |
| UX/accessibility | Blocker | Browser E2E, keyboard, responsive, and accessibility results. |
| Performance | Blocker | Real workspace and rendered workbench p95 measurements. |
| Security/privacy | Blocker | Threat model, adversarial fixtures, secret and egress tests. |
| Compatibility | Blocker | Current and previous-major read/migration/export tests. |
| Release engineering | Blocker | Reproducible build, SBOM, artifact identity, signing workflow, and rollback instructions. |
| Ownership | Follow-up | A single-developer release names the maintainer as launch, rollback, and incident owner. |

## 15. Launch Blockers And Exceptions

| Blocker | Required artifact | Due |
| --- | --- | --- |
| False Proof is possible across bindings | G1 invariant tests and Evidence Authority implementation | Before G1 closes |
| Side effects bypass Lease | G2 governed execution receipts | Before G2 closes |
| Resume does not continue execution | G3 continuation acceptance test | Before G3 closes |
| Project cognition and cache are not operational | G4 fixture scorecard | Before G4 closes |
| Extensions are not connected to tasks | G5 reference-extension journey | Before G5 closes |
| Workbench cannot complete the first-run journey | G6 browser E2E report | Before G6 closes |
| No reproducible signed release evidence | G7 release evidence bundle | Before a public release |

No launch exception is accepted in this design. Signing and notarization may be
configured and tested up to the credential boundary; an actual public macOS
artifact remains blocked until the release owner provides a valid signing
identity and notarization credentials.

## 16. Implementation Program

This design is implemented as separate, sequential plans:

1. **Authority and Proof Integrity**
2. **Governed Action Runtime**
3. **Task Continuation and Workspace Isolation**
4. **Project Cognition, Context, and Experience**
5. **Extension Host Integration**
6. **Run Protocol, Workbench, and Desktop**
7. **Release Quality and Production Readiness**

Each plan begins with failing tests, updates its required PRD/ADR contract before
kernel semantics, and ends with the smallest affected test set plus the complete
repository verification command.
