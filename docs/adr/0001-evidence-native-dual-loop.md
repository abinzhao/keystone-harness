# ADR-0001: Evidence-Native Dual-Loop Runtime

- **Status**: Accepted
- **Date**: 2026-10-19
- **Decision basis**: the trust and completion invariants now summarized in the [architecture overview](../architecture/overview.md)

## Context

Mainstream engineering agents already commonly provide sandboxes, session recovery, Skills, plugins, Hooks, sub-agents and parallel workspaces. These capabilities no longer constitute differentiation in themselves, so Keystone cannot define itself by "feature count"; it must choose a set of non-negotiable structural constraints.

Existing tools of the same kind treat "the model declaring completion" as completion, treat "chat history" as the boundary of project memory, and treat "historical success" directly as reusable knowledge. These three things respectively lead to: fake completion, repeated understanding across sessions, and cache pollution with negative transfer.

## Decision

Keystone adopts an **evidence-native dual-loop runtime**. A session is a mode of interaction, not the boundary of project memory.

- **Builder Loop**: understand, plan, execute, modify. In this loop the model can only produce `ActionProposal` and candidate experiences.
- **Assurance Loop**: independently controls goals, context, capabilities, verification, completion, learning and autonomy.

Both write into a derivable Run Graph, rather than a linear chat history.

From this, five invariants are established:

1. The model cannot modify the goal outcome, permission boundary, verification results, completion status or long-term project cognition.
2. Authoritative task state can only be changed by kernel events; interfaces and extensions cannot directly rewrite state.
3. Every side-effecting action must hold a valid Capability Lease.
4. All context, tool results, memory and proofs must carry provenance and trust level; transformations may only add restrictions, and must not silently elevate trust.
5. "Proven" is the deterministic query result of the Proof Graph against the current Contract and Workspace Snapshot, and cannot be triggered by model text.

## Consequences

- Requires an event-sourced ledger, deterministic state folding, and a provenance propagation mechanism; the implementation cost is higher than "directly calling the model to modify files".
- Recovery, replay, branch comparison and evidence invalidation can be implemented precisely, rather than approximated.
- Extensions can only add restrictions or request confirmation, and cannot grant permissions or replace completion rules; the kernel can therefore remain stable.
- The model is replaceable: changing the model does not change goals, permissions, state or completion conditions.

## Rejected Alternatives

- **Using the chat session as the memory boundary**: cannot express cross-task project cognition, nor perform precise invalidation.
- **Using the model's self-report or chain-of-thought as proof**: not replayable and not independently verifiable.
- **Everything is a Plugin**: would let extensions replace the state machine, permission issuance, evidence integrity and completion adjudication, causing the kernel to lose control.
