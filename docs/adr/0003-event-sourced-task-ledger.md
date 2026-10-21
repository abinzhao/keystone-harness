# ADR-0003: The Task Ledger Uses Event Sourcing + Content-Addressed Artifacts

- **Status**: Accepted
- **Date**: 2026-10-19
- **Decision basis**: deterministic replay, integrity-checked recovery, branchable runs, precise evidence invalidation, and bounded storage

## Context

Keystone requires consistent state replay, workspace and evidence integrity checks before recovery, run branches derived from checkpoints, precise evidence invalidation, and content-addressed retention for large tool outputs. These requirements cannot be satisfied simultaneously by "a mutable row-oriented database table + overwrite writes".

## Decision

1. **Event ledger (append-only)**: each task has one JSONL event stream; events carry a monotonic `seq` number and a `prevHash`/`hash` hash chain. The hash chain is used to detect tampering and replay inconsistency.
2. **State is a folding result**: `foldTaskState(events)` is a pure function. Any derived view is projected again from the folding result.
3. **Content-addressed artifact storage**: large outputs (stdout, diff, reports) are stored by content hash at `artifacts/<first two digits of sha256>/<sha256>`; events record only the hash and length, and do not inline large text.
4. **A checkpoint = folded state + artifact references + workspace snapshot references**, and is a complete snapshot that can be restored directly, rather than an incremental diff.
5. **A branch = a new event sequence starting from some checkpoint**: a branch records `parentCheckpointId` and does not overwrite the original branch.
6. **Hash baseline**: a workspace snapshot records the set of content hashes of key files, used for consistency verification during recovery and evidence invalidation adjudication.

## Consequences

- Recovery, replay, branch comparison and evidence invalidation are all derived from the ledger, with no need for an additional subsystem.
- Disk cost grows with the task; content-addressed deduplication and retention policy limit that growth.
- The event Schema must be versioned. A new Runtime must be able to read old data and provide a read-only export when migration is not possible.
- In-place modification of historical events is not allowed; a revision produces new events and a new Contract version.

## Rejected Alternatives

- **Mutable state + audit log**: the audit log and the real state may diverge, and replay is untrustworthy.
- **Storing only incremental snapshots**: the recovery path is complex, and branch comparison is difficult.
