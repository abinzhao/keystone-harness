/**
 * The Autonomy Envelope.
 *
 * This is the one object a model, extension, repository file or past success can
 * never widen. Widening requires a recorded user decision, and each widening
 * names the decision it came from so the boundary always has an explanation
 * (PRD HI-04, 9.5).
 *
 * Narrowing the envelope is a user action. What the system may do automatically
 * is tighten its *confirmation policy inside* the envelope — Autonomy Credit —
 * which changes how often it asks, never what it is allowed to do.
 */

import {
  nowIso,
  type AutonomyEnvelope,
  type Budget,
  type Capability,
  type DecisionId,
  type ProjectId,
  type UserDecision,
} from "@keystone/schemas";

export class EnvelopeWideningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeWideningError";
  }
}

/**
 * The starting envelope for a project. Deliberately inert: nothing writable,
 * nothing executable, no network, no credentials. A user (or a project profile
 * they approve) has to open it up.
 */
export function defaultEnvelope(projectId: ProjectId, budget: Budget): AutonomyEnvelope {
  return {
    projectId,
    readPaths: ["**"],
    writePaths: [],
    allowedCommands: [],
    allowedHosts: [],
    allowedCredentials: [],
    externalSystems: "none",
    maxReversibility: "reversible",
    untrustedContentEgress: "deny_all",
    budget,
    updatedAt: nowIso(),
    updatedBy: "system_default",
    widenedBy: [],
  } as AutonomyEnvelope;
}

export interface EnvelopePatch {
  readonly writePaths?: readonly string[];
  readonly allowedCommands?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly allowedCredentials?: readonly string[];
  readonly externalSystems?: AutonomyEnvelope["externalSystems"];
  readonly maxReversibility?: AutonomyEnvelope["maxReversibility"];
  readonly untrustedContentEgress?: AutonomyEnvelope["untrustedContentEgress"];
  readonly budget?: Budget;
}

/** Every field a patch would change, so the UI can show what "allow" means. */
export function describeWidening(
  current: AutonomyEnvelope,
  patch: EnvelopePatch,
): readonly string[] {
  const changes: string[] = [];
  const listDelta = (label: string, before: readonly string[], after?: readonly string[]): void => {
    if (after === undefined) return;
    const added = after.filter((value) => !before.includes(value));
    if (added.length > 0) changes.push(`${label}: +${added.join(", ")}`);
  };

  listDelta("write paths", current.writePaths, patch.writePaths);
  listDelta("commands", current.allowedCommands, patch.allowedCommands);
  listDelta("hosts", current.allowedHosts, patch.allowedHosts);
  listDelta("credentials", current.allowedCredentials, patch.allowedCredentials);

  if (patch.externalSystems !== undefined && patch.externalSystems !== current.externalSystems) {
    changes.push(`external systems: ${current.externalSystems} -> ${patch.externalSystems}`);
  }
  if (patch.maxReversibility !== undefined && patch.maxReversibility !== current.maxReversibility) {
    changes.push(`max reversibility: ${current.maxReversibility} -> ${patch.maxReversibility}`);
  }
  if (
    patch.untrustedContentEgress !== undefined &&
    patch.untrustedContentEgress !== current.untrustedContentEgress
  ) {
    changes.push(
      `untrusted content egress: ${current.untrustedContentEgress} -> ${patch.untrustedContentEgress}`,
    );
  }
  return changes;
}

/**
 * Widen the envelope. The decision must be a live `allow`/`modify` for this
 * project, and it becomes part of the envelope's permanent record.
 */
export function widenEnvelope(
  current: AutonomyEnvelope,
  patch: EnvelopePatch,
  decision: UserDecision,
): AutonomyEnvelope {
  if (decision.decision !== "allow" && decision.decision !== "modify") {
    throw new EnvelopeWideningError(
      `decision ${decision.decisionId} is "${decision.decision}", which cannot widen the envelope`,
    );
  }
  const expiresAt = decision.appliesTo.expiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
    throw new EnvelopeWideningError(`decision ${decision.decisionId} has expired`);
  }
  const changes = describeWidening(current, patch);
  if (changes.length === 0) return current;

  return {
    ...current,
    writePaths: patch.writePaths === undefined ? current.writePaths : [...patch.writePaths],
    allowedCommands:
      patch.allowedCommands === undefined ? current.allowedCommands : [...patch.allowedCommands],
    allowedHosts: patch.allowedHosts === undefined ? current.allowedHosts : [...patch.allowedHosts],
    allowedCredentials:
      patch.allowedCredentials === undefined
        ? current.allowedCredentials
        : [...patch.allowedCredentials],
    externalSystems: patch.externalSystems ?? current.externalSystems,
    maxReversibility: patch.maxReversibility ?? current.maxReversibility,
    untrustedContentEgress: patch.untrustedContentEgress ?? current.untrustedContentEgress,
    budget: patch.budget ?? current.budget,
    updatedAt: nowIso(),
    updatedBy: "user",
    widenedBy: [...current.widenedBy, decision.decisionId as DecisionId],
  } as AutonomyEnvelope;
}

/** Narrowing is always allowed and never requires a decision. */
export function narrowEnvelope(
  current: AutonomyEnvelope,
  patch: EnvelopePatch,
): AutonomyEnvelope {
  const intersect = (before: readonly string[], after?: readonly string[]): readonly string[] =>
    after === undefined ? before : before.filter((value) => after.includes(value));

  return {
    ...current,
    writePaths: intersect(current.writePaths, patch.writePaths),
    allowedCommands: intersect(current.allowedCommands, patch.allowedCommands),
    allowedHosts: intersect(current.allowedHosts, patch.allowedHosts),
    allowedCredentials: intersect(current.allowedCredentials, patch.allowedCredentials),
    externalSystems:
      patch.externalSystems === undefined ? current.externalSystems : "none",
    maxReversibility:
      patch.maxReversibility === undefined ? current.maxReversibility : "reversible",
    untrustedContentEgress:
      patch.untrustedContentEgress === undefined
        ? current.untrustedContentEgress
        : "deny_all",
    budget: patch.budget ?? current.budget,
    updatedAt: nowIso(),
    updatedBy: "user",
  } as AutonomyEnvelope;
}

/**
 * Autonomy Credit: how much the system may stop asking *inside* the envelope.
 * Credit is per capability, never global, and carries its own expiry so a
 * capability that has not been exercised recently is asked about again.
 */
export interface AutonomyCredit {
  readonly capability: Capability;
  readonly delta: number;
  readonly rationale: string;
  readonly expiresAt?: string;
}

export const CREDIT_MIN = -10;
export const CREDIT_MAX = 3;

export type CreditOutcome = "succeeded" | "failed" | "rolled_back" | "negative_experience";

/**
 * Successful, reversible actions raise credit slowly; a failure or rollback
 * drops it immediately. The asymmetry is intentional: the cost of asking once
 * too often is small, the cost of acting wrongly without asking is not.
 */
export function nextCreditDelta(outcome: CreditOutcome): number {
  switch (outcome) {
    case "succeeded":
      return 1;
    case "failed":
      return -3;
    case "rolled_back":
      return -5;
    case "negative_experience":
      return -10;
  }
}

export function clampCredit(value: number): number {
  return Math.max(CREDIT_MIN, Math.min(CREDIT_MAX, value));
}

/** Whether credit currently permits skipping a confirmation for a capability. */
export function creditPermitsAutoApproval(credit: AutonomyCredit | undefined): boolean {
  if (credit === undefined) return false;
  if (credit.expiresAt !== undefined && Date.parse(credit.expiresAt) <= Date.now()) return false;
  return credit.delta > 0;
}
