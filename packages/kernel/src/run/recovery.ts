/**
 * Recovery assessment — is this checkpoint still a truthful place to resume from?
 *
 * The kernel must never "resume and hope" (PRD NFR-REL-02, PRD 10). Before a task
 * is allowed to continue, the checkpoint's recorded workspace fingerprint is
 * compared against a fresh scan, the contract revision is compared against the
 * checkpoint's, and the evidence and project facts that the change invalidates
 * are named. Anything that cannot be compared is treated as *not* consistent.
 *
 * Two rules shape the output:
 *
 *  - `consistent` is true only when the workspace can be verified *and* matches.
 *  - `recomputedPlanRequired` is true for any change that makes the old plan
 *    untrustworthy — a moved workspace, a revised contract, changed tool or
 *    dependency fingerprints, or invalidated facts/evidence.
 */

import type { Checkpoint, EvidenceRecord, TaskStatus } from "@keystone/schemas";

const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface RecoveryAssessment {
  readonly consistent: boolean;
  readonly changedPaths: readonly string[];
  readonly externallyModified: boolean;
  readonly invalidatedEvidenceIds: readonly string[];
  readonly invalidatedFactIds: readonly string[];
  readonly resumedStatus?: TaskStatus;
  readonly explanation: string;
  readonly recomputedPlanRequired: boolean;
}

export interface AssessRecoveryInput {
  readonly checkpoint: Checkpoint;
  /** Current workspace fingerprint, from a fresh scan. */
  readonly workspaceFingerprint: string;
  readonly currentHeadCommit?: string;
  readonly currentToolFingerprint?: string;
  readonly currentDependencyFingerprint?: string;
  readonly contractId?: string;
  readonly contractVersion?: number;
  readonly evidence?: readonly EvidenceRecord[];
  readonly facts?: readonly {
    readonly factId: string;
    readonly applicableSnapshot?: string;
    readonly invalidatedBy: readonly string[];
  }[];
  /** Paths known to have changed outside Keystone, when the caller has them. */
  readonly changedPaths?: readonly string[];
}

function unusableIntegrity(checkpoint: Checkpoint, changedPaths: readonly string[]): RecoveryAssessment {
  return {
    consistent: false,
    changedPaths,
    externallyModified: false,
    invalidatedEvidenceIds: [],
    invalidatedFactIds: [],
    resumedStatus: "needs_attention",
    explanation:
      "the checkpoint integrity digest is missing or not a sha-256 hex value, so the " +
      "checkpoint cannot be trusted and the run must not continue from it",
    recomputedPlanRequired: true,
  };
}

export function assessRecovery(input: AssessRecoveryInput): RecoveryAssessment {
  const checkpoint = input.checkpoint;
  const changedPaths = [...(input.changedPaths ?? [])];

  // A checkpoint without a usable digest is not a checkpoint; refuse it rather
  // than reason about possibly-tampered fields (NFR-REL-08).
  if (typeof checkpoint.integrity !== "string" || !DIGEST_RE.test(checkpoint.integrity)) {
    return unusableIntegrity(checkpoint, changedPaths);
  }

  const recorded = checkpoint.verification.workspaceFingerprint;
  const workspaceVerifiable = recorded !== undefined;
  const workspaceChanged = !workspaceVerifiable || recorded !== input.workspaceFingerprint;

  const contractChanged =
    (input.contractId !== undefined && input.contractId !== checkpoint.contractId) ||
    (input.contractVersion !== undefined && input.contractVersion !== checkpoint.contractVersion);

  const toolChanged =
    input.currentToolFingerprint !== undefined &&
    input.currentToolFingerprint !== checkpoint.verification.toolFingerprint;
  const dependencyChanged =
    input.currentDependencyFingerprint !== undefined &&
    input.currentDependencyFingerprint !== checkpoint.verification.dependencyFingerprint;

  // Evidence invalidation: environment-derived evidence (E2/E3, produced by a
  // tool or verifier) is suspect when the tool or dependency fingerprint moved;
  // anything captured against a different workspace snapshot is suspect when the
  // workspace moved; anything produced under a different contract revision is
  // suspect when the contract was revised (PRD VF-06).
  const invalidatedEvidence = new Set<string>();
  for (const record of input.evidence ?? []) {
    const environmentDerived = record.producer.kind === "tool" || record.producer.kind === "verifier";
    if ((toolChanged || dependencyChanged) && environmentDerived) {
      invalidatedEvidence.add(record.evidenceId);
    }
    if (
      workspaceChanged &&
      checkpoint.workspaceSnapshotId !== undefined &&
      record.workspaceSnapshotId !== checkpoint.workspaceSnapshotId
    ) {
      invalidatedEvidence.add(record.evidenceId);
    }
    if (
      contractChanged &&
      input.contractVersion !== undefined &&
      record.contractVersion !== input.contractVersion
    ) {
      invalidatedEvidence.add(record.evidenceId);
    }
  }

  // Facts observed against a snapshot other than the checkpoint's are stale for
  // this resume point.
  const invalidatedFacts: string[] = [];
  const currentSnapshot = checkpoint.workspaceSnapshotId;
  for (const fact of input.facts ?? []) {
    if (
      currentSnapshot !== undefined &&
      fact.applicableSnapshot !== undefined &&
      fact.applicableSnapshot !== currentSnapshot
    ) {
      invalidatedFacts.push(fact.factId);
    }
  }

  const consistent = workspaceVerifiable && !workspaceChanged;
  const externallyModified = workspaceVerifiable && workspaceChanged;
  const recomputedPlanRequired =
    !consistent ||
    contractChanged ||
    toolChanged ||
    dependencyChanged ||
    invalidatedEvidence.size > 0 ||
    invalidatedFacts.length > 0;

  const resumedStatus: TaskStatus = consistent ? checkpoint.state.status : "needs_attention";

  return {
    consistent,
    changedPaths,
    externallyModified,
    invalidatedEvidenceIds: [...invalidatedEvidence],
    invalidatedFactIds: invalidatedFacts,
    resumedStatus,
    explanation: explain({
      consistent,
      workspaceVerifiable,
      workspaceChanged,
      contractChanged,
      toolChanged,
      dependencyChanged,
      headCommit: input.currentHeadCommit,
      invalidatedEvidenceCount: invalidatedEvidence.size,
      invalidatedFactCount: invalidatedFacts.length,
      status: checkpoint.state.status,
    }),
    recomputedPlanRequired,
  };
}

interface ExplanationInput {
  readonly consistent: boolean;
  readonly workspaceVerifiable: boolean;
  readonly workspaceChanged: boolean;
  readonly contractChanged: boolean;
  readonly toolChanged: boolean;
  readonly dependencyChanged: boolean;
  readonly headCommit?: string;
  readonly invalidatedEvidenceCount: number;
  readonly invalidatedFactCount: number;
  readonly status: TaskStatus;
}

function explain(input: ExplanationInput): string {
  if (!input.workspaceVerifiable) {
    return (
      "the checkpoint does not record a workspace fingerprint, so the workspace " +
      "cannot be compared and a safe automatic resume is not possible"
    );
  }

  if (input.consistent) {
    const notes: string[] = [];
    if (input.contractChanged) notes.push("the contract was revised, so the plan must be recomputed");
    if (input.toolChanged || input.dependencyChanged) {
      notes.push("tool or dependency fingerprints changed, so affected evidence is invalidated");
    }
    if (input.invalidatedEvidenceCount > 0) {
      notes.push(`${input.invalidatedEvidenceCount} evidence record(s) no longer apply`);
    }
    if (input.invalidatedFactCount > 0) {
      notes.push(`${input.invalidatedFactCount} project fact(s) no longer apply`);
    }
    const base = `the ledger and the workspace agree, so the task can continue from status "${input.status}"`;
    return notes.length === 0 ? `${base}.` : `${base}; note that ${notes.join("; ")}.`;
  }

  const head = input.headCommit === undefined ? "" : ` (current HEAD ${input.headCommit})`;
  const parts: string[] = [
    `the workspace fingerprint changed since the checkpoint${head}, which means files were modified outside Keystone`,
  ];
  if (input.invalidatedEvidenceCount > 0) {
    parts.push(`${input.invalidatedEvidenceCount} evidence record(s) are invalidated`);
  }
  if (input.invalidatedFactCount > 0) {
    parts.push(`${input.invalidatedFactCount} project fact(s) are invalidated`);
  }
  if (input.contractChanged) parts.push("the contract was revised");
  parts.push("the plan and verification scope must be recomputed before resuming");
  return `${parts.join("; ")}.`;
}

/** Only a consistent checkpoint may be resumed directly. */
export function canResume(assessment: RecoveryAssessment): boolean {
  return assessment.consistent;
}

/** User-readable summary with a concrete next step. */
export function describeRecovery(assessment: RecoveryAssessment): string {
  const next = assessment.consistent
    ? assessment.recomputedPlanRequired
      ? `Resume from status "${assessment.resumedStatus ?? "unknown"}", then recompute the affected plan and verification scope.`
      : `Resume from status "${assessment.resumedStatus ?? "unknown"}" and continue.`
    : "Do not resume automatically: review the changed files, restore consistency, and rebuild the affected plan and evidence before continuing.";
  return `${assessment.explanation} Next: ${next}`;
}
