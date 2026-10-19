# ADR-0005: Local-First Storage Layout and Data Sovereignty

- **Status**: Accepted
- **Date**: 2026-10-19
- **Decision basis**: `需求文档.md` Sections 1.4, 8.10 (ST-02), 9.6, 11.3, 11.4, 12.4

## Context

The PRD requires that project cognition, task state, run graphs, caches and evidence be stored locally by default; that when a cloud model is used only the content listed in the current Context Plan be sent; that a fully local offline mode be supported; and that before cleaning data the scope of impact be displayed and the contents of the code repository not be deleted.

Therefore the storage location and directory semantics are part of the security boundary, and must be determined before the code.

## Decision

**Separation inside and outside the repository**: runtime data is never written into the workspace of a managed code repository. The default root directory is `~/.keystone/` (overridable via `KEYSTONE_HOME`).

```
~/.keystone/
  config.json                  # BYOK model configuration, model routing; contains no plaintext credentials
  credentials/                 # short-term/long-term credential handles (0600), not entering model context
  projects/
    <project-id>/              # project-id is a hash of the normalized workspace path
      project.json             # workspace path, support-matrix determination, onboarding time
      facts/                   # Project Fact (including provenance / applicable snapshot / invalidation conditions)
      experience/
        candidates/            # quarantine area: by default participates in no task
        entries/               # promoted experiences, which can be frozen/corrected/deleted
        evaluations/           # independent effectiveness evaluation records (positive/negative transfer, forgetting)
  tasks/
    <task-id>/
      ledger.jsonl             # authoritative event ledger (append-only, hash chain)
      checkpoints/<id>.json    # checkpoints (folded state + references, atomic writes)
      branches/<branch-id>/    # branch ledgers derived from checkpoints
  artifacts/<xx>/<sha256>      # content-addressed artifacts (stdout, diff, snapshots, reports)
  index/                       # derived indexes (can be deleted and rebuilt at any time)
  cache/                       # context cache (can be deleted at any time)
  proofs/<task-id>/<proof-id>.json
```

Rules:

- **The ledger is the sole source of truth**; `index/`, `cache/` and `proofs/` are all rebuildable (NFR-REL-06).
- **Credentials are isolated from model context**: the contents of `credentials/` must not appear in event payloads, artifacts, Proofs or logs (PRD 11.3). What the kernel provides is a short-term handle, not the key itself.
- **Atomic writes**: all persisted writes go through `writeFileAtomic` (temp file + fsync + rename), guaranteeing "either fully visible or completely invisible" (NFR-REL-08).
- **Workspace snapshots** store only hashes and metadata in `artifacts/`, and do not copy the user's source code.
- Deleting `~/.keystone/projects/*` or `cache/` does not affect the code repository (ST-02).
- Read-only tasks can run in parallel, but must be bound to a read snapshot; by default only one write task is allowed per workspace (PRD 9.6).

## Consequences

- The data sovereignty boundary is clear, and users can delete or migrate `~/.keystone` as a whole.
- Multiple projects and multiple tasks are isolated by ID under the same root directory, and switching tasks does not cross-contaminate (UI-02).
- File locks need to be implemented to avoid concurrent write tasks in the same workspace.
- A future remote Workspace mode needs to clearly distinguish "local data" from "outbound data", and must not use "local-first" to mask actual outbound behavior (11.4).

## Rejected Alternatives

- **Placing `.keystone/` inside the managed repository**: would pollute the user's workspace, enter git status, and break the premise that "a workspace snapshot does not contain the Agent's own data".
- **Using SQLite as authoritative storage**: requires a native dependency (violating ADR-0004), and would mask the ordering semantics of event sourcing. SQLite can serve as an optional acceleration implementation for a future `index/`.
