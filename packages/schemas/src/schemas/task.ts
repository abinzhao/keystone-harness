/**
 * Task lifecycle: statuses, transitions, the append-only event envelope,
 * folded task state, checkpoints and run branches.
 *
 * The event envelope is deliberately generic (`payload` is an open object) and
 * the *payload schema is chosen by `type`* — see `events.ts`. That keeps the
 * envelope stable while individual events evolve on their own version.
 *
 * Task status is never written directly. It is the result of folding the ledger
 * (ADR-0002, ADR-0003), which is what makes NFR-REL-05 (replay consistency)
 * true by construction rather than by discipline.
 */

import {
  artifactIdValidator,
  branchIdValidator,
  checkpointIdValidator,
  contractIdValidator,
  evidenceIdValidator,
  eventIdValidator,
  interventionIdValidator,
  leaseIdValidator,
  localIdValidator,
  projectIdValidator,
  taskIdValidator,
  isoTimestampValidator,
  sha256Validator,
} from "./ids.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  jsonValue,
  lit,
  looseObject,
  nonEmptyStr,
  nullable,
  num,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

/** User-visible statuses (PRD 7.1). */
export const TASK_STATUSES = [
  "draft",
  "defining",
  "ready",
  "awaiting_approval",
  "executing",
  "verifying",
  "auto_repairing",
  "needs_attention",
  "paused",
  "resuming",
  "proven",
  "exited_gracefully",
  "failed",
  "stopped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses in which the task is doing work without asking for input. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["executing", "verifying", "auto_repairing"];

/** Statuses from which the task has ended. History keeps its verdict. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "proven",
  "exited_gracefully",
  "failed",
  "stopped",
];

export function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Execution stages. The trace is organised by these (PRD EX-01, UI-03). */
export const EXECUTION_STAGES = [
  "understanding",
  "planning",
  "authorizing",
  "modifying",
  "verifying",
  "delivering",
] as const;
export type ExecutionStage = (typeof EXECUTION_STAGES)[number];

/**
 * Allowed transitions (PRD 7.3). An event that is not in this table is rejected
 * by the kernel and the rejection is recorded — "nearest sensible state" is not
 * an option, because a wrong status is indistinguishable from a wrong proof.
 */
export interface TaskTransition {
  readonly from: readonly TaskStatus[];
  readonly event: string;
  readonly to: readonly TaskStatus[];
  /** Precondition in user terms; enforced by the kernel, not by this table. */
  readonly requires: string;
  /** What happens when the precondition fails. */
  readonly onFailure: string;
}

export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  {
    from: ["draft"],
    event: "task.submitted",
    to: ["defining"],
    requires: "project is readable",
    onFailure: "stay in draft and show the reason",
  },
  {
    from: ["defining"],
    event: "contract.compiled",
    to: ["ready", "awaiting_approval"],
    requires: "required contract fields complete",
    onFailure: "awaiting_approval when the system cannot decide",
  },
  {
    from: ["ready", "awaiting_approval"],
    event: "task.started",
    to: ["executing"],
    requires: "scope is clear and policy allows automatic start",
    onFailure: "needs_attention",
  },
  {
    from: ["executing", "auto_repairing"],
    event: "verification.started",
    to: ["verifying"],
    requires: "an executable verification plan exists",
    onFailure: "needs_attention for blocking items",
  },
  {
    from: ["verifying"],
    event: "verification.failed",
    to: ["auto_repairing", "exited_gracefully"],
    requires: "repair budget remains and a viable path exists",
    onFailure: "exited_gracefully when no path remains",
  },
  {
    from: ["auto_repairing"],
    event: "repair.produced_change",
    to: ["executing"],
    requires: "contract revision unchanged",
    onFailure: "needs_attention when no progress is being made",
  },
  {
    from: ["executing", "verifying", "auto_repairing"],
    event: "task.paused",
    to: ["paused"],
    requires: "current action can stop safely",
    onFailure: "wait for the uninterruptible action to finish",
  },
  {
    from: ["paused", "executing", "verifying", "auto_repairing", "resuming"],
    event: "task.resume_requested",
    to: ["resuming"],
    requires: "a complete checkpoint exists",
    onFailure: "failed when no complete checkpoint exists",
  },
  {
    from: ["resuming"],
    event: "recovery.verified",
    to: ["executing", "verifying", "auto_repairing", "needs_attention", "ready"],
    requires: "workspace and ledger are explainable",
    onFailure: "needs_attention when the change can be recomputed",
  },
  {
    from: ["verifying"],
    event: "proof.satisfied",
    to: ["proven"],
    requires: "every required condition has valid evidence at the required level",
    onFailure: "must not complete while any evidence is invalid",
  },
  {
    from: [
      "draft",
      "defining",
      "ready",
      "awaiting_approval",
      "executing",
      "verifying",
      "auto_repairing",
      "needs_attention",
      "paused",
      "resuming",
    ],
    event: "task.stopped",
    to: ["stopped"],
    requires: "none — the user may always stop",
    onFailure: "not applicable",
  },
  {
    from: ["defining", "ready", "awaiting_approval"],
    event: "task.cancelled",
    to: ["stopped"],
    requires: "no side effect has been applied",
    onFailure: "needs_attention when an effect already exists",
  },
  {
    from: ["executing", "verifying", "auto_repairing", "resuming", "needs_attention"],
    event: "task.failed",
    to: ["failed"],
    requires: "an unrecoverable error occurred",
    onFailure: "not applicable",
  },
  {
    from: ["executing", "verifying", "auto_repairing", "needs_attention"],
    event: "exit.conditions_met",
    to: ["exited_gracefully"],
    requires: "an exit condition from the contract is met",
    onFailure: "needs_attention",
  },
  {
    from: ["executing", "verifying", "auto_repairing"],
    event: "attention.required",
    to: ["needs_attention"],
    requires: "a trigger from the contract applies",
    onFailure: "not applicable",
  },
  {
    /**
     * Resolving an intervention returns the task to work. Without this
     * transition, a task could be blocked forever by the very mechanism meant to
     * unblock it.
     */
    from: ["needs_attention"],
    event: "intervention.decided",
    to: ["executing", "verifying", "auto_repairing", "stopped"],
    requires: "the decision still applies to the current contract version",
    onFailure: "re-confirm when the decision has expired",
  },
  {
    /**
     * A revision made while work is in flight. Narrowing is applied silently;
     * widening lands in awaiting_approval because it changes what the user
     * agreed to (PRD OT-03).
     */
    from: ["ready", "executing", "verifying", "auto_repairing"],
    event: "contract.revised",
    to: ["executing", "awaiting_approval"],
    requires: "the revised contract is valid and version-bumped",
    onFailure: "needs_attention",
  },
];

export const EVENT_TYPES = [
  // lifecycle
  "task.created",
  "task.submitted",
  "task.started",
  "task.status_changed",
  "task.paused",
  "task.resume_requested",
  "task.stopped",
  "task.cancelled",
  "task.failed",
  "exit.conditions_met",
  "attention.required",
  "recovery.verified",
  // contract
  "contract.compiled",
  "contract.revised",
  // context and budget
  "context.plan_created",
  "budget.consumed",
  "degradation.applied",
  // execution
  "action.proposed",
  "action.authorized",
  "action.rejected",
  "action.executed",
  "scope.violation_detected",
  // capability
  "lease.issued",
  "lease.consumed",
  "lease.revoked",
  // runs and checkpoints
  "checkpoint.created",
  "branch.created",
  "workspace.snapshot_created",
  "workspace.conflict_detected",
  // verification and proof
  "verification.started",
  "verification.failed",
  "evidence.recorded",
  "evidence.invalidated",
  "repair.produced_change",
  "proof.satisfied",
  "proof.evaluated",
  "proof.invalidated",
  // human and autonomy
  "intervention.requested",
  "intervention.decided",
  "autonomy.updated",
  // learning
  "experience.candidate_created",
  "experience.promoted",
  "experience.demoted",
  "experience.evaluated",
  // project cognition
  "project.fact_updated",
  "project.fact_invalidated",
  // extensions
  "extension.activated",
  "extension.isolated",
  // diagnostics
  "error.recorded",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_ACTOR_KINDS = [
  "user",
  "model",
  "tool",
  "verifier",
  "kernel",
  "extension",
] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

/**
 * The append-only event envelope. `hash` chains to `prevHash` so that dropping,
 * reordering or editing any event invalidates every downstream link (ADR-0003).
 */
export const runEventSchema = defineSchema(
  "keystone.run.event",
  "1.0.0",
  objectOf(
    {
      eventId: eventIdValidator,
      taskId: taskIdValidator,
      branchId: branchIdValidator,
      /** Monotonic within a branch, starting at 1. */
      seq: int({ min: 1 }),
      type: enumOf(EVENT_TYPES),
      at: isoTimestampValidator,
      actor: objectOf({
        kind: enumOf(EVENT_ACTOR_KINDS),
        id: nonEmptyStr(),
      }),
      /** Validated against the payload schema registered for `type`. */
      payload: looseObject(),
      schemaVersion: lit("keystone.run.event@1.0.0"),
      /** The event this one directly follows in a causal sense. */
      causationId: optional(eventIdValidator),
      prevHash: nullable(sha256Validator),
      hash: sha256Validator,
    },
    { unknownKeys: "allow" },
  ),
);

export type RunEvent = InferSchema<typeof runEventSchema>;

export const budgetUsageSchema = defineSchema(
  "keystone.run.budgetUsage",
  "1.0.0",
  objectOf({
    tokens: int({ min: 0 }),
    retries: int({ min: 0 }),
    wallClockMs: int({ min: 0 }),
    costUsd: num({ min: 0 }),
  }),
);

export type BudgetUsage = InferSchema<typeof budgetUsageSchema>;

/**
 * Folded task state. This is what `foldTaskState(events)` produces and what a
 * checkpoint stores verbatim, so recovery is "load the snapshot" rather than
 * "replay and hope".
 */
export const taskStateSchema = defineSchema(
  "keystone.run.taskState",
  "1.0.0",
  objectOf({
    taskId: taskIdValidator,
    projectId: projectIdValidator,
    branchId: branchIdValidator,
    status: enumOf(TASK_STATUSES),
    stage: enumOf(EXECUTION_STAGES),
    seq: int({ min: 0 }),
    createdAt: isoTimestampValidator,
    updatedAt: isoTimestampValidator,

    contractId: optional(contractIdValidator),
    contractVersion: optional(int({ min: 1 })),
    activeCheckpointId: optional(checkpointIdValidator),

    budgetUsed: budgetUsageSchema.validator,
    pendingInterventions: arrayOf(interventionIdValidator, { maxItems: 64 }),
    outstandingEvidence: arrayOf(evidenceIdValidator, { maxItems: 4096 }),
    activeLeaseIds: arrayOf(leaseIdValidator, { maxItems: 64 }),

    /** Hash of the proof that justified `proven`, when it was justified. */
    proofGraphHash: optional(sha256Validator),
    provenAt: optional(isoTimestampValidator),
    /**
     * Set when the workspace or a dependency changed after a proof was issued.
     * The historical verdict is preserved; current usability is not (PRD 7.2).
     */
    proofInvalidated: optional(objectOf({
      at: isoTimestampValidator,
      reason: nonEmptyStr(),
    })),

    /** Context Plan in force for the current step. */
    activeContextPlanId: optional(localIdValidator),
    degradation: optional(objectOf({
      mode: enumOf(["minimal", "standard", "isolated", "replay"] as const),
      reason: nonEmptyStr(),
      capabilitiesLost: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    })),

    stopReason: optional(str({ maxLength: 1000 })),
    exitReason: optional(str({ maxLength: 1000 })),
    errorSummary: optional(str({ maxLength: 2000 })),
  }),
);

export type TaskState = InferSchema<typeof taskStateSchema>;

export const CHECKPOINT_REASONS = [
  "stage_boundary",
  "before_side_effect",
  "pre_verification",
  "pre_branch",
  "periodic",
  "user_requested",
] as const;
export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

/**
 * A checkpoint is a complete, directly restorable state — not a delta. It also
 * records what the verification numbers were about, so that on resume Keystone
 * can tell "same workspace" from "workspace moved underneath us" without
 * re-deriving anything (PRD EX-04).
 */
export const checkpointSchema = defineSchema(
  "keystone.run.checkpoint",
  "1.0.0",
  objectOf({
    checkpointId: checkpointIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    seq: int({ min: 0 }),
    createdAt: isoTimestampValidator,
    reason: enumOf(CHECKPOINT_REASONS),

    state: taskStateSchema.validator,
    contractId: optional(contractIdValidator),
    contractVersion: optional(int({ min: 1 })),
    contractDigest: optional(sha256Validator),

    workspaceSnapshotId: optional(str({ maxLength: 64 })),
    verification: objectOf({
      workspaceFingerprint: optional(sha256Validator),
      dependencyFingerprint: optional(sha256Validator),
      toolFingerprint: optional(sha256Validator),
    }),

    pendingStepIds: arrayOf(localIdValidator, { maxItems: 512 }),
    evidenceIds: arrayOf(evidenceIdValidator, { maxItems: 4096 }),
    artifactRefs: arrayOf(artifactIdValidator, { maxItems: 4096 }),
    activeLeaseIds: arrayOf(leaseIdValidator, { maxItems: 64 }),
    extensions: arrayOf(
      objectOf({ id: nonEmptyStr(), version: nonEmptyStr() }),
      { maxItems: 64 },
    ),

    parentCheckpointId: optional(checkpointIdValidator),
    /** Integrity digest over the checkpoint payload. */
    integrity: sha256Validator,
  }),
);

export type Checkpoint = InferSchema<typeof checkpointSchema>;

export const BRANCH_STATUSES = ["active", "superseded", "abandoned", "merged"] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

/**
 * A run branch forks from a checkpoint and keeps its own plan, budget, workspace
 * changes and evidence. Forks never overwrite the source branch (PRD EX-04).
 */
export const runBranchSchema = defineSchema(
  "keystone.run.branch",
  "1.0.0",
  objectOf({
    branchId: branchIdValidator,
    taskId: taskIdValidator,
    label: nonEmptyStr(),
    parentCheckpointId: optional(checkpointIdValidator),
    forkedFromBranchId: optional(branchIdValidator),
    forkedAt: isoTimestampValidator,
    reason: nonEmptyStr(),
    status: enumOf(BRANCH_STATUSES),
    contractId: contractIdValidator,
    contractVersion: int({ min: 1 }),
    /** Working directory when the branch requires isolated execution. */
    workspacePath: optional(nonEmptyStr()),
  }),
);

export type RunBranch = InferSchema<typeof runBranchSchema>;

export const branchSummarySchema = defineSchema(
  "keystone.run.branchSummary",
  "1.0.0",
  objectOf({
    branchId: branchIdValidator,
    label: nonEmptyStr(),
    outcome: enumOf(["proven", "exited_gracefully", "failed", "stopped", "running", "unknown"] as const),
    tokensUsed: int({ min: 0 }),
    retriesUsed: int({ min: 0 }),
    wallClockMs: int({ min: 0 }),
    changedFileCount: int({ min: 0 }),
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    verificationStatus: enumOf(["satisfied", "partially_satisfied", "unsatisfied", "unknown"] as const),
    residualRiskCount: int({ min: 0 }),
    evidenceIds: arrayOf(evidenceIdValidator, { maxItems: 512 }),
  }),
);

export const branchComparisonSchema = defineSchema(
  "keystone.run.branchComparison",
  "1.0.0",
  objectOf({
    taskId: taskIdValidator,
    at: isoTimestampValidator,
    entries: arrayOf(branchSummarySchema.validator, { minItems: 2, maxItems: 16 }),
    /** Kernel's read on which branch to prefer, and why. */
    recommendation: optional(objectOf({
      branchId: branchIdValidator,
      rationale: nonEmptyStr(),
    })),
  }),
);

export type BranchSummary = InferSchema<typeof branchSummarySchema>;
export type BranchComparison = InferSchema<typeof branchComparisonSchema>;

/** Opaque diagnostics payload attached to `error.recorded`. */
export const errorDetailSchema = defineSchema(
  "keystone.run.errorDetail",
  "1.0.0",
  objectOf(
    {
      code: nonEmptyStr(),
      message: nonEmptyStr(),
      recoverable: bool(),
      detail: optional(jsonValue()),
    },
    { unknownKeys: "allow" },
  ),
);
