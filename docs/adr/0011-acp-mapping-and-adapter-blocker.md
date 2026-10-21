# ADR-0011: ACP (Agent Client Protocol) Mapping and the Stdio-Adapter Blocker

- **Status**: Proposed — **BLOCKED, no adapter ships** (2026-10-20)
- **Decision basis**: ACP v1 public schema (agentclientprotocol.com/protocol/schema, fetched 2026-10-20); kernel invariants 1–2 (AGENTS.md §2); PRD trust commitments, completion rules, provenance rules; ADR-0002 (kernel is sole state authority); `packages/schemas` Contract/Lease/Evidence/Proof; `keystone protocol export`.
- **Scope of this ADR**: a mapping table of Keystone concepts onto current public ACP, the precise silent-loss points, and the conditions under which an adapter may ever be built. **No ACP transport code is added.**

## Context

A natural ask is to expose Keystone as an [Agent Client Protocol](https://agentclientprotocol.com) agent so an IDE (Zed / JetBrains / a generic ACP host) can drive it over JSON-RPC on stdio. Before writing any adapter we must decide whether Keystone's four load-bearing semantics — **Outcome Contract, Capability Lease, Evidence, Proof** — can cross that boundary without *silent loss*. They cannot today, for the reasons below.

## What ACP v1 actually is (grounded, not assumed)

ACP v1 is newline-delimited JSON-RPC over stdio. The lifecycle is `initialize → session/new → session/prompt (loop) → session/close`, with `session/load`/`session/resume`.

- **Client drives, agent streams.** The client sends `session/prompt` (a user message + context). The agent sends one-way `session/update` notifications: `agent_message_chunk`, `tool_call` / `tool_call_update`, `plan`, etc.
- **Permissions are a per-call client decision.** The agent calls `session/request_permission` before a sensitive tool call; the **client** renders the prompt and returns allow/deny. A tool call sits at `ToolCallStatus::pending` "awaiting approval".
- **Completion is a free-form stop.** `session/prompt` ends with a `StopReason` (`end_turn`, `cancelled`, …). There is no completion *verdict*.
- **Extensibility is non-authoritative.** `_meta` is reserved; the spec says implementations **"MUST NOT make assumptions about values at these keys."** Custom fields are therefore display-only and invisible to a standards-compliant client.

## Concept mapping

| Keystone concept | Closest ACP surface | Is it lossless? |
|---|---|---|
| **Outcome Contract** (goal, scope, invariants, completion conditions w/ required evidence level, budget, autonomy envelope; `awaiting_approval` gates execution) | `plan` (a `PlanEntry[]` the client replaces wholesale) + `session/set_mode` | **No.** ACP `plan` is a UI to-do list; it does not gate execution and is not authoritative. A binding, re-provable contract would be downgraded to a display artifact. |
| **Capability Lease** (subject/capability/resource/budget/expiry, default-deny, short-lived, tool re-validates, recorded as an event) | `session/request_permission` + `tool_call` `pending` | **No.** ACP approval is a one-shot human yes/no of a single call, issued by the **client**, with no resource-path scoping, budget, expiry, or default-deny envelope. |
| **Evidence** (E0–E4, required level per condition, independence; model claims E0 never count as proof) | `tool_call` `rawOutput` / `completed` | **No.** ACP has no evidence concept. Independent verification at a required level would be read by standard clients as ordinary tool output, not as a gating verdict. |
| **Proof** (ProofPackage: conditions satisfied/not, evidence index, proof-graph hash, redaction; `proven` vs `failed`/`needs_attention`) | final `agent_message_chunk` + `StopReason` | **No.** There is no terminal verdict and no hash-addressed, redacted artifact. "Proven" would collapse into free prose. |

## The blocker (two independent reasons)

1. **Authority inversion (kernel invariants 1–2).** Keystone's kernel is the *only* write authority: `KernelSession` is the sole write entry point, and only kernel events change state, permissions, and completion. In ACP, the **host client** issues tool approvals and ends the turn. Making Keystone an ACP agent hands permission-issuance and turn-completion to the IDE — the exact inversion AGENTS.md §2 forbids. An adapter today would have to either route approvals out to the client (breaking invariant) or ignore ACP's permission flow (and then it is not really interoperable).

2. **No first-class slots ⇒ silent loss.** ACP has no place for contract-gated completion, lease scoping, evidence-level gating, or a proof verdict. The only escape hatch is `_meta`, which the spec declares non-authoritative. Stuffing Contract/Lease/Evidence/Proof there means a standard client silently drops all of it — a run that stopped at `needs_attention` or `failed` would look like a normal chat turn. That is precisely the "silent loss" this ADR forbids.

## Decision

**Do not ship an ACP stdio adapter now.** No transport, no session bridge, no permission forwarding. The authoritative machine interfaces remain the ones already built and lossless:

- `keystone protocol export` — the versioned JSON Schemas a foreign client can negotiate against (cannot drift from the kernel, PRD NFR-COMP-05);
- `keystone ci` — the stable JSON result + exit-code contract (docs/architecture/cli-automation-surface.md), where the verdict *is* the machine-readable payload and the redacted proof artifact is a real file.

These expose Keystone's semantics *authoritatively*; an ACP layer, if ever built, must be a **read-only projection plus a request forwarder** over that surface — never a permission issuer and never a completion authority.

## Preconditions before any adapter may be built (docs-first)

An adapter becomes permissible only when **both** hold:

1. **Explicit, negotiated capability.** Keystone advertises a versioned Keystone capability namespace in `initialize`, and the client must explicitly opt into it. Standard ACP clients that do not opt in get only the lossy view — and the adapter must refuse to claim "proven" completion for them.
2. **Kernel stays the sole authority.** The ACP adapter forwards proposed actions *into* the kernel; leases, refusals, recovery, and the proven/not-proven verdict are still decided by `KernelSession`. `session/request_permission` is rendered from the kernel's `InterventionRequest`, not the client's preference, and a client "allow" cannot widen the Autonomy Envelope.

Until ACP itself gains (or a negotiated extension defines) first-class slots for contract-gated completion, scoped leases, evidence levels, and a proof verdict, the mapping table above stands as the blocker.

## Rejected alternatives

- **Ship a minimal adapter that maps Keystone onto `plan` + `request_permission` + a final message.** Silently loses Contract/Lease/Evidence/Proof and inverts the permission authority — rejected by invariant.
- **Encode Keystone semantics in `_meta`.** The spec says clients must not interpret it; it would be dropped in practice, which is silent loss.
- **Treat ACP as the new authority and relax the kernel to accept client approvals.** Directly violates ADR-0002 and AGENTS.md §2; not negotiable.
