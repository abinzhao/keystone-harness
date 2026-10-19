/**
 * Event payload schemas, keyed by event type.
 *
 * The event envelope is generic; this table is what makes each event meaningful.
 * The kernel validates a payload against its schema *before* appending, so a
 * malformed event can never enter the ledger and later poison a replay.
 *
 * Keeping the table here (rather than inside the kernel) means the CLI, a
 * desktop shell and CI all agree on what an event means, which is the point of
 * publishing the protocol (PRD 8.10 ST-03, 18.1).
 */

import {
  branchIdValidator,
  checkpointIdValidator,
  contractIdValidator,
  experienceIdValidator,
  extensionIdValidator,
  factIdValidator,
  interventionIdValidator,
  leaseIdValidator,
  localIdValidator,
  proposalIdValidator,
  taskIdValidator,
  isoTimestampValidator,
  sha256Validator,
} from "./ids.ts";
import { actionProposalSchema, interventionRequestSchema, userDecisionSchema } from "./agent.ts";
import { autonomyEnvelopeSchema, outcomeContractSchema } from "./contract.ts";
import { capabilityLeaseSchema } from "./capability.ts";
import { contextPlanSchema } from "./context.ts";
import { evidenceRecordSchema } from "./evidence.ts";
import { experienceCandidateSchema, experienceEntrySchema, experienceEvaluationSchema } from "./experience.ts";
import { extensionRegistrationSchema } from "./extension.ts";
import { projectFactSchema } from "./project.ts";
import {
  budgetUsageSchema,
  checkpointSchema,
  errorDetailSchema,
  runBranchSchema,
  type EventType,
} from "./task.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  type Schema,
} from "../validate.ts";

export const taskCreatedPayloadSchema = defineSchema(
  "keystone.event.taskCreated",
  "1.0.0",
  objectOf({
    projectId: nonEmptyStr(),
    /** The user's original phrasing, kept verbatim for contract re-derivation. */
    request: str({ maxLength: 8000 }),
    requestedBy: enumOf(["user", "cli", "ci"] as const),
    /** References the user attached: files, directories, issues, logs. */
    references: arrayOf(
      objectOf({
        kind: enumOf(["file", "directory", "issue", "log", "url", "text"] as const),
        value: nonEmptyStr(),
      }),
      { maxItems: 64 },
    ),
  }),
);

export const taskStatusChangedPayloadSchema = defineSchema(
  "keystone.event.taskStatusChanged",
  "1.0.0",
  objectOf({
    from: nonEmptyStr(),
    to: nonEmptyStr(),
    event: nonEmptyStr(),
    note: optional(str({ maxLength: 2000 })),
  }),
);

const taskStartedPayloadSchema = defineSchema(
  "keystone.event.taskStarted",
  "1.0.0",
  objectOf({
    contractId: contractIdValidator,
    contractVersion: int({ min: 1 }),
    /** Why the task was allowed to start without asking. */
    authorization: enumOf(["policy_default", "user_approved_contract", "autonomy_credit"] as const),
  }),
);

const taskPausedPayloadSchema = defineSchema(
  "keystone.event.taskPaused",
  "1.0.0",
  objectOf({ reason: str({ maxLength: 2000 }), byUser: bool() }),
);

const taskResumeRequestedPayloadSchema = defineSchema(
  "keystone.event.taskResumeRequested",
  "1.0.0",
  objectOf({ checkpointId: checkpointIdValidator, byUser: bool() }),
);

const taskStoppedPayloadSchema = defineSchema(
  "keystone.event.taskStopped",
  "1.0.0",
  objectOf({
    reason: str({ maxLength: 2000 }),
    byUser: bool(),
    /** Work already produced is kept; this records what was left unfinished. */
    outstanding: arrayOf(nonEmptyStr(), { maxItems: 128 }),
  }),
);

const exitConditionsMetPayloadSchema = defineSchema(
  "keystone.event.exitConditionsMet",
  "1.0.0",
  objectOf({
    exitId: localIdValidator,
    description: nonEmptyStr(),
    /** Conditions still unsatisfied at exit — required for an honest exit. */
    unsatisfiedConditionIds: arrayOf(localIdValidator, { maxItems: 128 }),
  }),
);

const attentionRequiredPayloadSchema = defineSchema(
  "keystone.event.attentionRequired",
  "1.0.0",
  objectOf({
    interventionId: interventionIdValidator,
    trigger: nonEmptyStr(),
  }),
);

const recoveryVerifiedPayloadSchema = defineSchema(
  "keystone.event.recoveryVerified",
  "1.0.0",
  objectOf({
    checkpointId: checkpointIdValidator,
    workspaceMatchesCheckpoint: bool(),
    /** What changed while the task was not running. */
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    /** Ledger, fact or evidence items that no longer apply. */
    invalidated: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    /** Present when consistency held and the original status was re-entered. */
    resumedStatus: optional(nonEmptyStr()),
  }),
);

const contractRevisedPayloadSchema = defineSchema(
  "keystone.event.contractRevised",
  "1.0.0",
  objectOf({
    contract: outcomeContractSchema.validator,
    previousContractId: optional(contractIdValidator),
    previousVersion: optional(int({ min: 1 })),
    /** Names of the top-level fields the user changed. */
    changedFields: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    /** Things the revision invalidated, so the UI can explain the consequence. */
    invalidated: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
  }),
);

const budgetConsumedPayloadSchema = defineSchema(
  "keystone.event.budgetConsumed",
  "1.0.0",
  objectOf({
    delta: budgetUsageSchema.validator,
    /** What the spend was for, e.g. `step.localize.model_call`. */
    reason: nonEmptyStr(),
    modelId: optional(nonEmptyStr()),
    /** Measured, not estimated (PRD NFR-PERF-06). */
    measured: bool(),
  }),
);

const degradationAppliedPayloadSchema = defineSchema(
  "keystone.event.degradationApplied",
  "1.0.0",
  objectOf({
    mode: enumOf(["minimal", "standard", "isolated", "replay"] as const),
    reason: nonEmptyStr(),
    capabilitiesLost: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    /** How the loss affects the evidence the task can still produce. */
    evidenceImpact: nonEmptyStr(),
  }),
);

const actionAuthorizedPayloadSchema = defineSchema(
  "keystone.event.actionAuthorized",
  "1.0.0",
  objectOf({
    proposalId: proposalIdValidator,
    leaseId: leaseIdValidator,
  }),
);

const actionRejectedPayloadSchema = defineSchema(
  "keystone.event.actionRejected",
  "1.0.0",
  objectOf({
    proposalId: proposalIdValidator,
    code: enumOf([
      "out_of_scope",
      "capability_not_leased",
      "envelope_exceeded",
      "irreversible_requires_confirmation",
      "untrusted_content_cannot_authorize",
      "tool_unavailable",
      "policy_denied",
    ] as const),
    detail: str({ maxLength: 2000 }),
    /** Alternative the system will try instead, when one exists. */
    fallback: optional(str({ maxLength: 1000 })),
  }),
);

const actionExecutedPayloadSchema = defineSchema(
  "keystone.event.actionExecuted",
  "1.0.0",
  objectOf({
    proposalId: proposalIdValidator,
    leaseId: optional(leaseIdValidator),
    status: enumOf(["succeeded", "failed", "timeout", "cancelled"] as const),
    exitCode: optional(int()),
    durationMs: int({ min: 0 }),
    /** Large output lives in artifacts; the hash keeps it verifiable. */
    outputArtifactId: optional(nonEmptyStr()),
    outputHash: optional(sha256Validator),
    outputBytes: optional(int({ min: 0 })),
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    /** Workspace snapshot taken after the effect, when one was taken. */
    workspaceSnapshotId: optional(nonEmptyStr()),
    errorCode: optional(nonEmptyStr()),
  }),
);

const scopeViolationPayloadSchema = defineSchema(
  "keystone.event.scopeViolationDetected",
  "1.0.0",
  objectOf({
    proposalId: optional(proposalIdValidator),
    capability: nonEmptyStr(),
    attemptedPaths: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    allowedPatterns: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    /** True when a write already happened before the check fired. */
    effectApplied: bool(),
  }),
);

const leaseConsumedPayloadSchema = defineSchema(
  "keystone.event.leaseConsumed",
  "1.0.0",
  objectOf({
    leaseId: leaseIdValidator,
    proposalId: optional(proposalIdValidator),
    calls: int({ min: 1 }),
  }),
);

const leaseRevokedPayloadSchema = defineSchema(
  "keystone.event.leaseRevoked",
  "1.0.0",
  objectOf({ leaseId: leaseIdValidator, reason: nonEmptyStr() }),
);

const workspaceSnapshotPayloadSchema = defineSchema(
  "keystone.event.workspaceSnapshotCreated",
  "1.0.0",
  objectOf({
    snapshotId: nonEmptyStr(),
    fingerprint: sha256Validator,
    entryCount: int({ min: 0 }),
    dirty: bool(),
    untrackedCount: int({ min: 0 }),
    headCommit: optional(nonEmptyStr()),
    /** Full entry list is stored as an artifact on large repositories. */
    artifactId: optional(nonEmptyStr()),
    excluded: arrayOf(nonEmptyStr(), { maxItems: 128 }),
  }),
);

const workspaceConflictPayloadSchema = defineSchema(
  "keystone.event.workspaceConflictDetected",
  "1.0.0",
  objectOf({
    expectedFingerprint: optional(sha256Validator),
    actualFingerprint: sha256Validator,
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    /** Files a human edited outside Keystone while the task was running. */
    externallyModified: bool(),
  }),
);

const verificationStartedPayloadSchema = defineSchema(
  "keystone.event.verificationStarted",
  "1.0.0",
  objectOf({
    stepId: localIdValidator,
    conditionIds: arrayOf(localIdValidator, { minItems: 1, maxItems: 128 }),
    workspaceSnapshotId: optional(nonEmptyStr()),
    /** Only conditions affected by the last change are re-run. */
    incremental: bool(),
  }),
);

const verificationFailedPayloadSchema = defineSchema(
  "keystone.event.verificationFailed",
  "1.0.0",
  objectOf({
    stepId: localIdValidator,
    failedConditionIds: arrayOf(localIdValidator, { minItems: 1, maxItems: 128 }),
    evidenceIds: arrayOf(nonEmptyStr(), { maxItems: 512 }),
    /** Whether a repair attempt is still affordable. */
    repairBudgetRemaining: int({ min: 0 }),
    noProgressStreak: int({ min: 0 }),
  }),
);

const evidenceInvalidatedPayloadSchema = defineSchema(
  "keystone.event.evidenceInvalidated",
  "1.0.0",
  objectOf({
    evidenceIds: arrayOf(nonEmptyStr(), { minItems: 1, maxItems: 4096 }),
    reason: nonEmptyStr(),
    /** What changed: workspace, dependency, tool, verifier, contract or fact. */
    trigger: enumOf([
      "workspace_changed",
      "dependency_changed",
      "tool_changed",
      "verifier_changed",
      "contract_revised",
      "fact_invalidated",
      "source_untrusted",
    ] as const),
    /** Proof graphs that must be re-queried as a result. */
    affectedProofHashes: arrayOf(sha256Validator, { maxItems: 64 }),
  }),
);

const repairProducedChangePayloadSchema = defineSchema(
  "keystone.event.repairProducedChange",
  "1.0.0",
  objectOf({
    attempt: int({ min: 1 }),
    rootCause: str({ maxLength: 2000 }),
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    /** False when the attempt changed nothing — drives the no-progress rule. */
    madeProgress: bool(),
  }),
);

const proofSatisfiedPayloadSchema = defineSchema(
  "keystone.event.proofSatisfied",
  "1.0.0",
  objectOf({
    proofGraphHash: sha256Validator,
    contractId: contractIdValidator,
    contractVersion: int({ min: 1 }),
    conditionCount: int({ min: 1 }),
  }),
);

const proofInvalidatedPayloadSchema = defineSchema(
  "keystone.event.proofInvalidated",
  "1.0.0",
  objectOf({
    proofGraphHash: sha256Validator,
    reason: nonEmptyStr(),
    /** Historical verdict is preserved; only current usability changes. */
    stillHistoricallyProven: bool(),
  }),
);

const autonomyUpdatedPayloadSchema = defineSchema(
  "keystone.event.autonomyUpdated",
  "1.0.0",
  objectOf({
    envelope: autonomyEnvelopeSchema.validator,
    reason: nonEmptyStr(),
    /** Envelope changes are hard boundaries: widening must cite a decision. */
    direction: enumOf(["widened", "narrowed", "policy_change"] as const),
    decisionRef: optional(nonEmptyStr()),
    /** Autonomy credit movement inside the envelope, if any. */
    creditDelta: optional(
      objectOf({
        capability: nonEmptyStr(),
        delta: int(),
        rationale: nonEmptyStr(),
        expiresAt: optional(isoTimestampValidator),
      }),
    ),
  }),
);

const experienceDemotedPayloadSchema = defineSchema(
  "keystone.event.experienceDemoted",
  "1.0.0",
  objectOf({
    entryId: experienceIdValidator,
    reason: nonEmptyStr(),
    detail: str({ maxLength: 2000 }),
    /** Running tasks that must rebuild their Context Plan as a result. */
    affectedTaskIds: arrayOf(taskIdValidator, { maxItems: 256 }),
  }),
);

const projectFactInvalidatedPayloadSchema = defineSchema(
  "keystone.event.projectFactInvalidated",
  "1.0.0",
  objectOf({
    factIds: arrayOf(factIdValidator, { minItems: 1, maxItems: 4096 }),
    reason: nonEmptyStr(),
    /** Facts derived from these, invalidated in the same operation. */
    cascadedFactIds: arrayOf(factIdValidator, { maxItems: 4096 }),
    affectedContextPlans: arrayOf(localIdValidator, { maxItems: 1024 }),
  }),
);

const extensionIsolatedPayloadSchema = defineSchema(
  "keystone.event.extensionIsolated",
  "1.0.0",
  objectOf({
    extensionId: extensionIdValidator,
    reason: enumOf([
      "crash",
      "timeout",
      "manifest_violation",
      "incompatible_event",
      "integrity_failure",
      "user_disabled",
    ] as const),
    detail: str({ maxLength: 2000 }),
    affectedSteps: arrayOf(localIdValidator, { maxItems: 512 }),
    recoveredToCheckpointId: optional(checkpointIdValidator),
  }),
);

/**
 * Payload schema per event type. `undefined` means the event carries an empty
 * payload (`task.submitted` is the only such event — it is a pure signal).
 */
export const EVENT_PAYLOAD_SCHEMAS: Readonly<Record<EventType, Schema<unknown> | undefined>> = {
  "task.created": taskCreatedPayloadSchema,
  "task.submitted": undefined,
  "task.started": taskStartedPayloadSchema,
  "task.status_changed": taskStatusChangedPayloadSchema,
  "task.paused": taskPausedPayloadSchema,
  "task.resume_requested": taskResumeRequestedPayloadSchema,
  "task.stopped": taskStoppedPayloadSchema,
  "task.cancelled": taskStoppedPayloadSchema,
  "task.failed": errorDetailSchema,
  "exit.conditions_met": exitConditionsMetPayloadSchema,
  "attention.required": attentionRequiredPayloadSchema,
  "recovery.verified": recoveryVerifiedPayloadSchema,

  "contract.compiled": outcomeContractSchema,
  "contract.revised": contractRevisedPayloadSchema,

  "context.plan_created": contextPlanSchema,
  "budget.consumed": budgetConsumedPayloadSchema,
  "degradation.applied": degradationAppliedPayloadSchema,

  "action.proposed": actionProposalSchema,
  "action.authorized": actionAuthorizedPayloadSchema,
  "action.rejected": actionRejectedPayloadSchema,
  "action.executed": actionExecutedPayloadSchema,
  "scope.violation_detected": scopeViolationPayloadSchema,

  "lease.issued": capabilityLeaseSchema,
  "lease.consumed": leaseConsumedPayloadSchema,
  "lease.revoked": leaseRevokedPayloadSchema,

  "checkpoint.created": checkpointSchema,
  "branch.created": runBranchSchema,
  "workspace.snapshot_created": workspaceSnapshotPayloadSchema,
  "workspace.conflict_detected": workspaceConflictPayloadSchema,

  "verification.started": verificationStartedPayloadSchema,
  "verification.failed": verificationFailedPayloadSchema,
  "evidence.recorded": evidenceRecordSchema,
  "evidence.invalidated": evidenceInvalidatedPayloadSchema,
  "repair.produced_change": repairProducedChangePayloadSchema,
  "proof.satisfied": proofSatisfiedPayloadSchema,
  "proof.evaluated": proofInvalidatedPayloadSchema,
  "proof.invalidated": proofInvalidatedPayloadSchema,

  "intervention.requested": interventionRequestSchema,
  "intervention.decided": userDecisionSchema,
  "autonomy.updated": autonomyUpdatedPayloadSchema,

  "experience.candidate_created": experienceCandidateSchema,
  "experience.promoted": experienceEntrySchema,
  "experience.demoted": experienceDemotedPayloadSchema,
  "experience.evaluated": experienceEvaluationSchema,

  "project.fact_updated": projectFactSchema,
  "project.fact_invalidated": projectFactInvalidatedPayloadSchema,

  "extension.activated": extensionRegistrationSchema,
  "extension.isolated": extensionIsolatedPayloadSchema,

  "error.recorded": errorDetailSchema,
};

/**
 * Payload schemas that are only needed through `EVENT_PAYLOAD_SCHEMAS` are
 * declared above and re-exported here so that consumers (the kernel's fold, the
 * CLI's renderer) can name their types instead of re-describing the shape.
 */
export {
  actionAuthorizedPayloadSchema,
  actionExecutedPayloadSchema,
  actionRejectedPayloadSchema,
  attentionRequiredPayloadSchema,
  autonomyUpdatedPayloadSchema,
  budgetConsumedPayloadSchema,
  contractRevisedPayloadSchema,
  degradationAppliedPayloadSchema,
  evidenceInvalidatedPayloadSchema,
  exitConditionsMetPayloadSchema,
  experienceDemotedPayloadSchema,
  extensionIsolatedPayloadSchema,
  leaseConsumedPayloadSchema,
  leaseRevokedPayloadSchema,
  projectFactInvalidatedPayloadSchema,
  proofInvalidatedPayloadSchema,
  proofSatisfiedPayloadSchema,
  recoveryVerifiedPayloadSchema,
  repairProducedChangePayloadSchema,
  scopeViolationPayloadSchema,
  taskPausedPayloadSchema,
  taskResumeRequestedPayloadSchema,
  taskStartedPayloadSchema,
  taskStoppedPayloadSchema,
  verificationFailedPayloadSchema,
  verificationStartedPayloadSchema,
  workspaceConflictPayloadSchema,
  workspaceSnapshotPayloadSchema,
};
