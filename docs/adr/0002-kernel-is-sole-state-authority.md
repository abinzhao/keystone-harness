# ADR-0002: The Kernel Is the Sole Author of Authoritative State

- **Status**: Accepted
- **Date**: 2026-10-19
- **Decision basis**: `需求文档.md` Sections 1.3, 7.2, 9.1, 9.7, 12.6

## Context

The desktop interface, CLI, IDE and CI share the same Runtime. If any client can write task state, or if extensions can change state via Hooks / Skills / project configuration, then "the same task displays different states in different clients" will occur, and recovery and replay will also lose their meaning.

## Decision

The kernel (`@keystone/kernel`) is the sole author of authoritative state. Specific constraints:

- All state changes are expressed as **kernel events** and appended to the task ledger; task state is the pure-function folding result of the event sequence.
- Clients (CLI / future desktop shell / IDE / CI) may only: read derived views, submit **user intent** (create task, approve, reject, add constraints, pause, stop) and **external observations** (tool results, model proposals).
- User intent and external observations themselves also enter the ledger, but a state transition must only occur after the kernel validates them against the current state and contract.
- Extensions may provide tools, verifiers, analyzers, model adapters and protocol adapters, but **must not**: replace the state machine, issue permissions, modify evidence integrity, adjudicate completion, or rewrite historical events.
- Derived data (indexes, caches, Proof views, Context Plan projections) can be rebuilt arbitrarily; when corrupted, they are rebuilt from the ledger, snapshots and artifacts (NFR-REL-06).

State transitions must go through an explicit transition table (`需求文档.md` 7.3); illegal transitions are always rejected and the rejection reason recorded, and "nearest-match correction" is not allowed.

## Consequences

- All client logic is simplified to "read projections + submit intent", and cross-client semantics are naturally consistent.
- Crashes cannot directly change business state; after a restart, replaying the ledger recovers it (NFR-REL-01 / NFR-REL-02).
- Writes must be atomic: use "temp file + fsync + rename" to ensure a half checkpoint is never visible (NFR-REL-08).
- The kernel API must be narrow; new capabilities go through extension points rather than stuffing branches into the kernel.

## Rejected Alternatives

- **Each client holding its own state**: inconsistent across clients, and recovery cannot be explained.
- **Allowing extensions to write state directly**: violates PRD 9.7; a single unexplainable extension event will make the task unrecoverable.
