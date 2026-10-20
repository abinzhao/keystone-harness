/**
 * The generic action→capability/resource resolution seam (ADR-0006, M1).
 *
 * The kernel owns the *decision* to authorise: it requires a contract, checks
 * scope and the Autonomy Envelope, issues or refuses a Capability Lease, and
 * records the outcome as a `lease.issued` / `action.rejected` event. It
 * deliberately does **not** hard-code which model `intent` maps to which
 * Capability, nor which tool id maps to which resource values. That mapping is
 * scenario/composition policy — e.g. engineering maps `read`→`fs.read` and the
 * `fs.write_file` tool to its `path` parameter — and lives in a scenario pack
 * (`@keystone/pack-engineering` for the software-engineering vertical), which
 * the composition root (`@keystone/runtime`) wires into a `KernelSession`.
 *
 * The kernel never imports a pack: the dependency points pack → kernel →
 * schemas, so the kernel stays replayable standalone (I7) and cannot be made to
 * invent capabilities. Two failure modes are deliberately distinct:
 *
 *  - **No resolver wired at all** — the composition forgot to supply scenario
 *    policy. Authorising then raises a loud `KernelError` rather than guessing.
 *    This mirrors compiling a contract without a `ContractProposer`.
 *  - **A wired resolver declares a proposal un-leasable** (`capability ===
 *    undefined`) — a normal default-denial: the kernel records
 *    `action.rejected` and returns the refusal, exactly as before.
 *
 * Resumed/replay sessions are unaffected: the resolver is runtime-side policy,
 * is never written to the ledger, and `foldTaskState` / `replay()` consult it
 * never — they fold events only.
 */

import type { ActionProposal, Capability } from "@keystone/schemas";

/**
 * What a scenario policy decides a proposed action needs in order to be leased.
 */
export interface ActionResolution {
  /**
   * The Capability the proposal exercises. `undefined` means the intent is not
   * a leasable capability for this scenario — the kernel default-denies it.
   */
  readonly capability: Capability | undefined;
  /** The resources the proposal touches, in the lease's vocabulary. */
  readonly resourceValues: readonly string[];
}

/**
 * A scenario pack resolves — but never authorises — a proposal. The kernel
 * decides scope/envelope and folds the lease or refusal into authoritative
 * state; the resolver itself has no side effects.
 */
export type ActionCapabilityResolver = (proposal: ActionProposal) => ActionResolution;
