# ADR-0007: Scoped Git Commit Lifecycle — Lease Boundary and Explicit Rollback

- **Status**: Accepted (2026-10-20; was Proposed/Blocked)
- **Date**: 2026-10-20
- **Decision basis**: `需求文档.md` PI-01 (line 312), EX-02/EX-03 (lines 480–489), EX-04 (lines 491–504), §9.1 default-deny, §11.3 short-lived leases; `ROADMAP.md` "Git write operations" exit gate; ADR-0002, ADR-0003; existing code `packages/kernel/src/run/recovery.ts`, `packages/tools/src/git.ts`, `packages/pack-engineering/src/lease/resolve.ts`.

## Context

`ROADMAP.md` lists **Git write operations** as a known gap whose exit gate is:

> Commit / rollback run only inside a scoped, short-lived Capability Lease; out-of-scope git writes pause; operations are replayed deterministically.

Today only read-only git tools exist (`git.status` / `git.diff` / `git.show_head`, all `git.read`, resource `.`). A side-effecting `git.commit` has never been built. Before touching `packages/tools`, the engineering resolver, the runtime, or the CLI, we must fix what the docs uniquely determine and stop where they do not.

## What IS uniquely determined (safe boundary — implementable once unblocked)

These are pinned by the PRD + ROADMAP and the existing invariants; no product choice is needed:

1. **A commit is a side effect under a `git.write` lease.** Every side effect passes the unified execution boundary bound to subject / capability / resource / budget / expiry (kernel invariant 3; PRD 11.1 default-deny; `capability.ts`). A `git.commit` tool declares `capabilities: ["git.write"]`, `sideEffects: ["write"]`, and re-validates the lease itself via `assertLeaseCovers` (defense in depth, as `git.ts` already does).
2. **Out-of-scope writes are refused, never performed.** EX-03 / ROADMAP. The lease resource scopes the commit; staging or committing a path outside the lease's resource set throws `ToolRefusedError` and is recorded as a refusal event. Pause-awaiting-user for scope *expansion* is a kernel/runtime concern; the tool itself refuses before any ref moves.
3. **Pre-existing dirty/untracked user changes are invariant-protected.** PRD PI-01 line 312: changes present at onboarding "must be shown and included in the snapshot; must not be overwritten or mistaken for Agent changes." Consequences that ARE determined:
   - The commit must **never** sweep whole-worktree state in (no `git commit -a`, no staging every dirty path).
   - Rollback must **never** `git reset --hard` / `git checkout --` over the working tree (that would overwrite user changes). This rules out hard resets on principle.
4. **Every side effect is recorded as evidence.** PRD line 482: action proposal, lease, actual params, output, exit status, and workspace changes. The tool returns `changedPaths` and the kernel records an executed-action event carrying the lease + resulting `headCommit`/`preHead` for replay.
5. **Recovery does not auto-mutate the tree.** `recovery.ts` already compares a recorded workspace fingerprint against a fresh scan; on mismatch it returns `consistent:false` → `needs_attention` and names invalidated evidence; it never resets files. `currentHeadCommit` is explanatory text only. Any commit-time compensation must be justified against this "never resume-and-hope / never silently rewrite the tree" stance.

## Resolved decisions (chosen)

### Decision A — Rollback target and trigger: **A3**

There is **no automatic ref movement** after a later failure or crash. A failed
`git.commit` leaves the repository exactly as git left it; the harness never
moves HEAD itself on failure. **Rollback is a separate, explicit, user-approved,
lease-gated action** (`git.rollback`):

- It requires a `git.write` lease (resource `.`), bound to a user decision
  (`decisionRef`). It is never triggered automatically.
- It restores the branch pointer with `git reset --soft <target>`: HEAD moves to
  the recorded prior commit, while the index **and working tree are untouched**.
  No file bytes are overwritten, so pre-existing user dirty/untracked changes
  survive (L312).
- On a crash between commit-start and commit-success, recovery does **not**
  auto-rollback: the existing fingerprint reconciliation (`assessRecovery`)
  sees the workspace moved and returns `consistent:false` → `needs_attention`,
  preserving current state and requiring human review (EX-04, design §11).

### Decision B — Dirty-overlap handling: **B1**

A `git.commit` stages and commits **only the paths it is given**, after
lease-scoping them. If **any to-be-committed path was already dirty at
onboarding** (per-path non-empty `gitStatus` in the onboarding `WorkspaceSnapshot`),
the tool refuses with `preexisting_dirty_overlap` before staging anything.
The user must resolve the overlap or run the task in an isolated workspace.
**No hunk-splitting in v1.**

`git commit -- <paths>` is used so the commit records exactly those paths'
working-tree content; other staged/unstaged changes (including the user's) are
never swept in.

## Consequences of this ADR

- **Shipped slice:** a `git.commit` tool and an explicit `git.rollback` tool in
  `packages/tools/src/git.ts`, both gated by `git.write`; the engineering
  resolver maps their resource values (`paths` for commit, `.` for rollback);
  the runtime threads the onboarding dirty set into the tool context. Every
  invocation is recorded as an executed-action event (proposal, lease, params,
  changed paths), and a post-commit resume reconciles via the existing
  fingerprint check → `needs_attention`, never an auto-reset.
- Tests cover: out-of-scope refusal, successful scoped commit, dirty-overlap
  refusal, explicit soft rollback that preserves the working tree, and the
  resolver mappings. Recovery's "preserve state / needs_attention" is the
  existing kernel behaviour, not new code.
- No new event types, no schema bump, no kernel change: the new tools use the
  existing `git.write` capability, the existing tool descriptor, and the
  existing execution-event record (NFR-COMP-05).
- Future hardening (out of v1): hunk-level delta staging (B2), automatic
  compensation (A1/A2), and isolated-worktree baseline threading are deliberate
  non-choices recorded here.

## Rejected Alternatives

- **Implement a reasonable default now and revise later.** The two choices change observable git history (staged vs unstaged after failure; whole-file vs delta-on-overlap). Building one and migrating later would itself violate "don't mistake user changes for agent changes," which is exactly the invariant at stake.
- **Whole-tree commit / `reset --hard` rollback.** Excluded by PRD PI-01 line 312.
