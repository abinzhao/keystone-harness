/**
 * Proof Graph and completion decision.
 *
 * "Proven" is a deterministic query, not a message. The graph records which
 * condition each piece of evidence supports, which snapshot it was observed in,
 * and which validator produced it, so that a claim can be walked backwards to
 * the raw observation (PRD VF-04, 9.1).
 *
 * The `Proof Package` is the user-facing projection: the same facts, ordered
 * for a reviewer rather than for a query engine (PRD DP-01).
 */

import {
  artifactIdValidator,
  branchIdValidator,
  contractIdValidator,
  evidenceIdValidator,
  factIdValidator,
  interventionIdValidator,
  leaseIdValidator,
  localIdValidator,
  taskIdValidator,
  decisionIdValidator,
  isoTimestampValidator,
  sha256Validator,
} from "./ids.ts";
import { EVIDENCE_LEVELS } from "./evidence.ts";
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
  type InferSchema,
} from "../validate.ts";

export const PROOF_NODE_KINDS = [
  "condition",
  "evidence",
  "validator",
  "snapshot",
  "observation",
] as const;
export type ProofNodeKind = (typeof PROOF_NODE_KINDS)[number];

export const PROOF_NODE_STATUSES = [
  "supported",
  "unsupported",
  "invalid",
  "blocked",
  "pending",
] as const;
export type ProofNodeStatus = (typeof PROOF_NODE_STATUSES)[number];

export const proofNodeSchema = defineSchema(
  "keystone.proof.node",
  "1.0.0",
  objectOf({
    nodeId: localIdValidator,
    kind: enumOf(PROOF_NODE_KINDS),
    /** Identifier of the underlying object (condition id, evidence id, ...). */
    refId: nonEmptyStr(),
    label: nonEmptyStr(),
    status: enumOf(PROOF_NODE_STATUSES),
    /** Populated when status is not `supported`. */
    reason: optional(str({ maxLength: 2000 })),
  }),
);

export const PROOF_EDGE_RELATIONS = [
  "supports",
  "derived_from",
  "validated_by",
  "observed_in",
] as const;
export type ProofEdgeRelation = (typeof PROOF_EDGE_RELATIONS)[number];

export const proofEdgeSchema = defineSchema(
  "keystone.proof.edge",
  "1.0.0",
  objectOf({
    from: localIdValidator,
    to: localIdValidator,
    relation: enumOf(PROOF_EDGE_RELATIONS),
  }),
);

/**
 * Why a condition is or is not satisfied. Codes are stable so the CLI, the
 * desktop shell and CI can render the same verdict differently without
 * re-deriving it.
 */
export const CONDITION_REASON_CODES = [
  "satisfied",
  "no_evidence",
  "insufficient_level",
  "evidence_invalid",
  "not_independent",
  "scope_exceeded",
  "workspace_changed",
  "dependency_unsatisfied",
  "verifier_failed",
  "pending",
  "condition_removed",
] as const;
export type ConditionReasonCode = (typeof CONDITION_REASON_CODES)[number];

export const conditionResultSchema = defineSchema(
  "keystone.proof.conditionResult",
  "1.0.0",
  objectOf({
    conditionId: localIdValidator,
    description: nonEmptyStr(),
    required: bool(),
    satisfied: bool(),
    reasonCode: enumOf(CONDITION_REASON_CODES),
    reason: str({ maxLength: 2000 }),
    requiredLevel: enumOf(EVIDENCE_LEVELS),
    /** Highest level among the evidence that is still valid, when any. */
    achievedLevel: optional(enumOf(EVIDENCE_LEVELS)),
    requiresIndependence: bool(),
    independenceSatisfied: bool(),
    evidenceIds: arrayOf(evidenceIdValidator, { maxItems: 128 }),
  }),
);

export type ConditionResult = InferSchema<typeof conditionResultSchema>;

export const PROOF_OUTCOMES = ["proven", "not_proven"] as const;
export type ProofOutcome = (typeof PROOF_OUTCOMES)[number];

export const completionDecisionSchema = defineSchema(
  "keystone.proof.completionDecision",
  "1.0.0",
  objectOf({
    taskId: taskIdValidator,
    contractId: contractIdValidator,
    contractVersion: int({ min: 1 }),
    branchId: branchIdValidator,
    at: isoTimestampValidator,
    outcome: enumOf(PROOF_OUTCOMES),
    /** Top-level blocking reasons, most significant first. */
    reasons: arrayOf(
      objectOf({
        code: enumOf(CONDITION_REASON_CODES),
        detail: nonEmptyStr(),
      }),
      { maxItems: 64 },
    ),
    conditionResults: arrayOf(conditionResultSchema.validator, { maxItems: 256 }),
    /** Raw change set the decision was made about, for scope re-checks. */
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    workspaceFingerprint: optional(sha256Validator),
  }),
);

export type CompletionDecision = InferSchema<typeof completionDecisionSchema>;

export function unmetRequiredConditions(
  decision: CompletionDecision,
): readonly ConditionResult[] {
  return decision.conditionResults.filter((result) => result.required && !result.satisfied);
}

export const proofGraphSchema = defineSchema(
  "keystone.proof.graph",
  "1.0.0",
  objectOf({
    taskId: taskIdValidator,
    contractId: contractIdValidator,
    contractVersion: int({ min: 1 }),
    branchId: branchIdValidator,
    createdAt: isoTimestampValidator,
    nodes: arrayOf(proofNodeSchema.validator, { maxItems: 20_000 }),
    edges: arrayOf(proofEdgeSchema.validator, { maxItems: 60_000 }),
    /** Condition node ids the query starts from. */
    rootNodeIds: arrayOf(localIdValidator, { maxItems: 256 }),
    decision: completionDecisionSchema.validator,
    contentHash: sha256Validator,
  }),
);

export type ProofGraph = InferSchema<typeof proofGraphSchema>;

/** THE change set: what actually changed versus what was allowed to change. */
export const proofChangesSchema = defineSchema(
  "keystone.proof.changes",
  "1.0.0",
  objectOf({
    changedFileCount: int({ min: 0 }),
    changedPaths: arrayOf(nonEmptyStr(), { maxItems: 4096 }),
    diffArtifactId: optional(artifactIdValidator),
    withinScope: bool(),
    scopeViolations: arrayOf(nonEmptyStr(), { maxItems: 256 }),
  }),
);

export const REDACTION_MODES = ["none", "metadata_only"] as const;
export type RedactionMode = (typeof REDACTION_MODES)[number];

/**
 * The deliverable handed to a reviewer. Everything here is derived from the
 * ledger and the proof graph — nothing is written by a model (PRD DP-01, DP-03).
 */
export const proofPackageSchema = defineSchema(
  "keystone.proof.package",
  "1.0.0",
  objectOf({
    packageId: localIdValidator,
    taskId: taskIdValidator,
    contractId: contractIdValidator,
    contractVersion: int({ min: 1 }),
    branchId: branchIdValidator,
    generatedAt: isoTimestampValidator,

    /** Developer-readable statement of what was done and whether it holds. */
    summary: str({ maxLength: 8000 }),
    goal: nonEmptyStr(),
    outcome: enumOf(PROOF_OUTCOMES),

    changes: proofChangesSchema.validator,
    conditions: arrayOf(conditionResultSchema.validator, { maxItems: 256 }),
    evidenceIndex: arrayOf(
      objectOf({
        evidenceId: evidenceIdValidator,
        level: enumOf(EVIDENCE_LEVELS),
        producerId: nonEmptyStr(),
        producerVersion: nonEmptyStr(),
        conditionIds: arrayOf(localIdValidator, { maxItems: 32 }),
        createdAt: isoTimestampValidator,
        status: enumOf(["valid", "partially_invalid", "invalid"] as const),
        independenceMode: nonEmptyStr(),
      }),
      { maxItems: 4096 },
    ),

    /** Project rules and facts the task relied on. */
    projectRules: arrayOf(
      objectOf({ factId: factIdValidator, statement: nonEmptyStr() }),
      { maxItems: 256 },
    ),
    /** Which Context Plans and model routes were used, and why. */
    contextDecisions: arrayOf(
      objectOf({
        planId: localIdValidator,
        stepId: nonEmptyStr(),
        tokensUsed: int({ min: 0 }),
        cacheHits: int({ min: 0 }),
        note: str({ maxLength: 1000 }),
      }),
      { maxItems: 512 },
    ),
    modelRoutes: arrayOf(
      objectOf({ role: nonEmptyStr(), modelId: nonEmptyStr(), provider: nonEmptyStr() }),
      { maxItems: 32 },
    ),

    branchRationale: str({ maxLength: 2000 }),
    leases: arrayOf(
      objectOf({
        leaseId: leaseIdValidator,
        capability: nonEmptyStr(),
        resourceKind: nonEmptyStr(),
        resourceValues: arrayOf(nonEmptyStr(), { maxItems: 64 }),
        decisionRef: optional(decisionIdValidator),
      }),
      { maxItems: 512 },
    ),
    interventions: arrayOf(
      objectOf({
        interventionId: interventionIdValidator,
        trigger: nonEmptyStr(),
        decision: nonEmptyStr(),
        rationale: str({ maxLength: 2000 }),
      }),
      { maxItems: 128 },
    ),

    /** Explicitly not verified. Must never be empty-silent when work is partial. */
    unverified: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    residualRisks: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    /** Commands a reviewer can run to reproduce the key evidence. */
    reproduceCommands: arrayOf(nonEmptyStr(), { maxItems: 64 }),

    redaction: enumOf(REDACTION_MODES),
    /** Hash of the Proof Graph this package was rendered from. */
    proofGraphHash: sha256Validator,
    /** Environment and snapshot references needed for reproducibility. */
    environment: objectOf({
      nodeVersion: optional(nonEmptyStr()),
      platform: optional(nonEmptyStr()),
      workspaceSnapshotId: optional(nonEmptyStr()),
      workspaceFingerprint: optional(sha256Validator),
    }),
  }),
);

export type ProofPackage = InferSchema<typeof proofPackageSchema>;
