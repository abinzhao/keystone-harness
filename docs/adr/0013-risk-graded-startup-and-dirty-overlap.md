# ADR-0013: Risk-Graded Startup — Low-Risk Auto-Start, Confirmation Reasons, and Dirty-Worktree Refusal

- **Status**: Accepted (2026-10-20)
- **Date**: 2026-10-20
- **Decision basis**: `需求文档.md` 9.1 / 9.4 (trust, extension rules), HI-03/HI-04 (user decisions, envelope widening), OT-02/OT-03 (Outcome Contract), ST-03 (single Run Protocol boundary), PI-01 (no guessed scope); ADR-0002 (kernel is sole state authority), ADR-0003 (event ledger), ADR-0007 (scoped commit lifecycle, B1 baseline-dirty rule), ADR-0008 (Decision E read-only preview, Decision F binary write gate); AGENTS.md §2 invariants 1, 3, 5.

## Context

ADR-0008 Decision F drew one binary line: a **read-only** task starts immediately, a **write** task always shows the compiled contract and waits for an explicit confirmation. That is safe but blunt. An ordinary user who types *"add a unit test for `src/lease/resolve.ts`"* — a narrow, reversible, in-scope write with no open question — is shown a modal and asked to confirm a scope they already typed. The friction is pure theatre exactly where the blast radius is smallest.

We want low-risk write tasks to start **after** the preview, without an extra confirmation click, while keeping a human in the loop for anything that is genuinely uncertain or dangerous. The hard constraint (AGENTS.md §2; ADR-0008) is unchanged: **the model cannot propose this decision, the client cannot attest it, and an envelope can never be widened by it.** The grader must be a pure function of already-recorded inputs, owned by the runtime, and re-applied authoritatively when the task actually starts.

A second, separate hazard surfaced while integrating v1 on top of a **dirty** working tree. If a task's write scope overlaps files the user already has uncommitted changes in, letting the agent edit those files mixes two lines of work into one diff: the user's in-progress edit and the agent's change become unrecoverable as separate artefacts, and ADR-0007 B1 only protects the *commit* step (it refuses to sweep baseline-dirty paths into the agent commit). It does not stop the agent from clobbering the user's edits mid-flight. Admission must therefore refuse to start on overlapping dirty paths and tell the user exactly how to recover.

## Decisions

### Decision A — Startup risk is a pure, server-authoritative grade, not a model or client choice

A new zero-dependency module `packages/runtime/src/start-risk.ts` exports `gradeStartRisk(input)`. It is **deterministic**: given the same inputs it returns the same result, and it reads neither the model nor the network. Its inputs and result are structured so they can be audited:

- **Inputs**: the compiled `OutcomeContract`, the `AutonomyEnvelope` that would be used, the compiler's open `questions`, the write paths the user actually named, the dirty worktree paths that overlap that scope, and the effective `StartPolicy`.
- **Result**: one of three decisions (`auto_start`, `require_confirmation`, `refuse`), the list of `reasons` that drove it, and the exact envelope/question counts it saw. The result is returned by `POST /v1/contract/preview` and **re-derived by the server inside `POST /v1/tasks`** from the same data — the client's `startMode` is a *request*, never a grant. A page cannot flip a `require_confirmation` task to `auto_start`, and the model never sees a "can I start?" prompt.

This preserves invariant 1 (the model proposes actions only) and invariant 5 (no self-issued permission): the grader narrows, never widens, and its output is recorded on the start path, not negotiated.

### Decision B — Three outcomes, ordered by safety

1. `auto_start` — preview is still shown, then the run begins without a confirmation click. The UI labels this visibly (Decision E).
2. `require_confirmation` — preview is shown **with the reason(s)**, and the run begins only after the user clicks start.
3. `refuse` — the run does not start at all. Today this is exclusively the dirty-overlap case (Decision F); it carries a recovery instruction.

`refuse` outranks everything else. A task that would clobber uncommitted user work is not made safe by confirmation — it must not run against that working copy at all.

### Decision C — The six confirmation reasons

`require_confirmation` fires when **any** of these is present on top of the preview. Each is a named, auditable reason, not a vibe:

| Reason | Signal (server-derived) |
|---|---|
| `ambiguity` | The compiler returned open questions, the contract is `awaiting_approval`, or it carries unresolved open uncertainties. The system could not pin down what "done" means. |
| `scope_expansion` | `contract.scope.unknown` is non-empty, or the compiler inferred a write scope beyond the paths the user named. Blast radius is not what the user signed up for. |
| `irreversible` | The envelope `maxReversibility` has been widened to `compensable` (i.e. it permits actions that are not exactly reversible). The default envelope stays `reversible`, which still gates non-reversible actions in-flight. |
| `external_action` | `externalSystems !== "none"`, `allowedHosts` is non-empty, or untrusted-content egress is `allowlisted_only`. Side effects can leave the machine. |
| `high_risk` | `allowedCommands` matches a destructive pattern (force-push, hard reset, recursive delete, package unpublish, …) **or** the write scope covers the repository root (`**` / `.`) with no narrower user path. |
| `policy_required` | The effective policy demands confirmation for this write (Decision D). |

These map onto the kernel's existing `INTERVENTION_TRIGGERS` (`ambiguity`, `scope_expansion`, `irreversible_action`) so the startup gate and the in-flight intervention system agree on vocabulary; `external_action`, `high_risk` and `policy_required` are startup-only because nothing in-flight can un-write a pushed commit.

### Decision D — Policy layering: default auto-start, user and project overrides tighten, never loosen

`StartPolicy` is resolved per submission:

- **Default (shipped)**: `allowAutoStartForLowRisk = true`, `confirmAllWrites = false`. A clean, narrow, reversible, in-scope, question-free write auto-starts after preview.
- **User toggle**: "Confirm every write task" (`confirmAllWrites`). This is a presentation preference the workbench holds in `localStorage` and sends on each request. It only ever pushes a task toward `confirm`; omitting it cannot downgrade a safety reason. It is a convenience, not a security boundary.
- **Project policy**: an optional `<workspace>/.keystone/policy.json` read by the server. It may set `"confirmAllWrites": true` (force confirmation) and/or `"allowAutoStartForLowRisk": false` (never auto-start in this workspace). Because this file lives in the workspace and is read server-side, it is authoritative for that project; a shell cannot waive it.

Effective policy = the **union** of user and project tightening. Any `confirmAllWrites` (user or project) yields `policy_required`; `allowAutoStartForLowRisk: false` makes an otherwise-clean task `require_confirmation`. Nothing in policy can promote a task from `require_confirmation` to `auto_start`.

### Decision E — Preview always renders; auto-start shows visible, undoable feedback

Even an `auto_start` task first drafts and **renders the readable contract** (goal, write scope, completion conditions, budget, open questions). Auto-start removes the *confirmation click*, not the *preview*. The workbench then shows an explicit, dismissible banner — *"Started automatically: graded low-risk (no open questions, scoped writes, no external or irreversible actions). You can pause or stop it any time."* — so the user is never surprised that a task began. Pause/stop remain unconditional user rights (existing control endpoints). This satisfies async-ui's "make the start state legible and the qualification re-checkable": the banner is the visible feedback, and a refresh re-derives the task state from the server.

### Decision F — Dirty worktree overlap refuses admission, with a concrete recovery path

At admission the server lists the worktree's dirty/untracked paths (`git status --porcelain`) and keeps those that overlap the task's write scope (path / directory / glob match, reusing the kernel matcher). If the overlap set is non-empty, the grade is `refuse` and the run is **not** created. The refusal names the overlapping files and gives the recovery options:

> *"This task would write to files you already have uncommitted changes in: `<paths>`. Keystone will not start here, or it would mix your in-progress work with this task. Commit or stash those changes first, or start this task in **isolated mode** (it works on a throwaway worktree and leaves yours untouched)."*

This extends ADR-0007 B1 from "do not sweep baseline-dirty paths into the agent commit" to "do not *begin* against overlapping dirty paths". Isolated mode remains the escape hatch because it never touches the user's files (ADR-0008 / `workspace-lock.ts`); a standard run on a clean tree is unaffected.

### Decision G — The protocol bump is additive and minor

`keystone.run.protocol@1.1.0 → 1.2.0`:

- `POST /v1/contract/preview` adds a `risk` object to its response (decision, reasons, inputs). A 1.1.0 client ignores it.
- `POST /v1/tasks` accepts an additive `startMode: "auto" | "confirmed"` (defaulting to confirmed-compatible behaviour so existing callers keep working) and re-derives the grade server-side. A task the grade calls `refuse` answers 409 with the recovery hint; a task the grade calls `require_confirmation` answers 409 unless `startMode: "confirmed"` (or the legacy `acceptContract: true`) was supplied.

No existing route changes meaning; 1.1.0 clients keep working, they just lose the auto-start optimisation.

## Invariants check

- **Model cannot raise permissions (inv. 1, 5).** `gradeStartRisk` is a pure function of contract + envelope + questions + policy; it is not a model call and cannot be edited by an extension. Its output is enforced server-side, so a client cannot attest a safer grade.
- **Only kernel events change state (inv. 2).** Grading and the dirty check are read-only admission decisions; they create no `KernelSession`, no task, no ledger event. The refusal is an HTTP answer, not a state mutation.
- **Side effects pass the Capability Lease (inv. 3).** The startup gate does not grant any lease; in-flight authorisation and the lease issuer are unchanged. `irreversible` / `external_action` reasons reflect the *envelope*, which is still issued and widened only by recorded user decisions.
- **Provenance/trust not silently elevated (inv. 4).** A `refuse` / `require_confirmation` decision is downgrade-only; auto-start never propagates trust to a widened envelope.
- **Extensions cannot self-approve (inv. 5).** The project policy file is read by the runtime composition root; an extension cannot register itself as "low risk".

## Out of scope for this slice

- Packaging the native macOS window as a signed/notarized `.app`; the Swift/WKWebView host exists, but distributable packaging remains outside this slice.
- Auto-answering open questions: an `ambiguity` task still stops for a human; we do not guess scope.
- Per-reason tuning surfaces (weights, thresholds) — the reasons are fixed and named; a future slice may expose policy overrides beyond the booleans above.
- Changing the in-flight `awaiting_approval` / intervention system.
