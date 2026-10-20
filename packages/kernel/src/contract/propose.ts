/**
 * The generic contract-proposal seam (ADR-0006).
 *
 * The kernel owns the *state* of an Outcome Contract — it requires the
 * `defining` status, folds the result into a `contract.compiled` event, and
 * transitions on the produced status. It deliberately does **not** contain the
 * engineering heuristics that draft a proposal (node_modules exclusions,
 * package.json script discovery, Windows shims, preserve-behaviour keywords).
 *
 * Those heuristics live in a scenario pack (`@keystone/pack-engineering` for the
 * software-engineering vertical), which supplies a `ContractProposer` that the
 * composition root wires into a `KernelSession`. The kernel never imports a pack:
 * the dependency points pack → kernel → schemas, so the kernel stays replayable
 * standalone (I7) and cannot be made to invent engineering content.
 *
 * Deferred genericization: until a second real vertical exists, the input/output
 * types remain today's engineering schemas (`ProjectProfile`, `ProjectFact`, the
 * engineering verifier kinds). Renaming these into scenario-agnostic primitives
 * is a later, evidence-driven change — not this one.
 */

import type {
  AutonomyEnvelope,
  Budget,
  OutcomeContract,
  ProjectFact,
  ProjectProfile,
} from "@keystone/schemas";

/**
 * A question the proposer could not resolve from the request + context, so a
 * human must decide before the task proceeds. `questionId` matches
 * `localIdValidator` so it round-trips as an uncertainty id.
 */
export interface ContractQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly affects: "implementation" | "scope" | "verification";
  readonly suggestedAnswer: string;
}

/** Everything a scenario pack needs to draft a contract proposal. */
export interface ContractProposalInput {
  readonly taskId: string;
  readonly projectId: string;
  /** The user's request, verbatim. */
  readonly request: string;
  readonly references?: readonly {
    readonly kind: "file" | "directory" | "issue" | "log" | "url" | "text";
    readonly value: string;
  }[];
  readonly profile: ProjectProfile;
  readonly facts?: readonly ProjectFact[];
  /** Defaults the user or the project provides (e.g. the project's Autonomy Envelope). */
  readonly autonomy: AutonomyEnvelope;
  readonly budget?: Budget;
}

/** A schema-valid drafted contract plus the open questions it raised. */
export interface ContractProposal {
  readonly contract: OutcomeContract;
  readonly questions: readonly ContractQuestion[];
}

/**
 * A scenario pack drafts — but never writes — the Outcome Contract. The kernel
 * folds the returned contract into authoritative state; the proposer's own
 * side effects (if any) stay outside the kernel.
 */
export type ContractProposer = (input: ContractProposalInput) => ContractProposal;
