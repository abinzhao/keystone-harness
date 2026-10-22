/**
 * Outcome Contract and the Autonomy Envelope.
 *
 * The contract is the user-readable *and* machine-readable statement of what
 * "done" means. Two properties matter more than the field list:
 *
 *  1. Contract → conditions → evidence requirements is the only path to
 *     completion. Anything not in the contract cannot make a task "proven"
 *     (PRD 9.1).
 *  2. Revisions create a new version and never delete history. Evidence
 *     produced under an earlier version survives but only counts if it still
 *     satisfies the current version (PRD OT-03).
 */

import {
  contractIdValidator,
  decisionIdValidator,
  localIdValidator,
  projectIdValidator,
  taskIdValidator,
  isoTimestampValidator,
} from "./ids.ts";
import { EVIDENCE_LEVELS } from "./evidence.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  lit,
  looseObject,
  nonEmptyStr,
  num,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

/**
 * What may be read, changed, or invoked. `unknown` exists so that "we do not
 * know yet" is representable — an empty scope must not be read as "no
 * restrictions" (PRD OT-02).
 */
export const scopeEntrySchema = defineSchema(
  "keystone.contract.scopeEntry",
  "1.0.0",
  objectOf({
    kind: enumOf(["path", "directory", "glob"] as const),
    pattern: nonEmptyStr(),
    intent: enumOf(["read", "write"] as const),
  }),
);

export const scopeSchema = defineSchema(
  "keystone.contract.scope",
  "1.0.0",
  objectOf({
    include: arrayOf(scopeEntrySchema.validator, { maxItems: 256 }),
    exclude: arrayOf(scopeEntrySchema.validator, { maxItems: 256 }),
    /** Areas the system could not resolve; surfaced for user confirmation. */
    unknown: arrayOf(nonEmptyStr(), { maxItems: 64 }),
  }),
);

/** Behaviour that must not break. Invariants are checked before completion. */
export const invariantSchema = defineSchema(
  "keystone.contract.invariant",
  "1.0.0",
  objectOf({
    invariantId: localIdValidator,
    description: nonEmptyStr(),
    /** Condition ids that operationalise this invariant, when it has any. */
    checkedBy: optional(arrayOf(localIdValidator, { maxItems: 16 })),
  }),
);

export const VERIFIER_KINDS = [
  "test",
  "regression_test",
  "typecheck",
  "lint",
  "build",
  "diff_scope",
  "project_rule",
  "comparison",
  "replay",
  "external_ci",
  "custom",
] as const;
export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export const verifierRefSchema = defineSchema(
  "keystone.contract.verifierRef",
  "1.0.0",
  objectOf({
    kind: enumOf(VERIFIER_KINDS),
    id: nonEmptyStr(),
    version: nonEmptyStr(),
    params: optional(looseObject()),
  }),
);

/**
 * One checkable statement. `required: false` marks an auxiliary check that may
 * be satisfied by E1 evidence; required checks may not (PRD VF-02).
 */
export const completionConditionSchema = defineSchema(
  "keystone.contract.completionCondition",
  "1.0.0",
  objectOf({
    conditionId: localIdValidator,
    description: nonEmptyStr(),
    verifier: verifierRefSchema.validator,
    /** Lowest evidence level that may satisfy this condition. */
    minEvidenceLevel: enumOf(EVIDENCE_LEVELS),
    /**
     * When true, the verifier must be independent of the Builder Loop's model,
     * process, workspace or data source (guarantees at least E3).
     */
    requiresIndependence: bool(),
    required: bool(),
    /** Budget for a single verification run. */
    timeoutMs: optional(int({ min: 1 })),
    /** Condition ids that must be evaluated first, if any. */
    dependsOn: optional(arrayOf(localIdValidator, { maxItems: 16 })),
  }),
);

export const budgetSchema = defineSchema(
  "keystone.contract.budget",
  "1.0.0",
  objectOf({
    maxTokens: int({ min: 0 }),
    maxWallClockMs: int({ min: 0 }),
    maxRetries: int({ min: 0 }),
    maxCostUsd: optional(num({ min: 0 })),
  }),
);

export const uncertaintySchema = defineSchema(
  "keystone.contract.uncertainty",
  "1.0.0",
  objectOf({
    uncertaintyId: localIdValidator,
    question: nonEmptyStr(),
    affects: enumOf(["implementation", "scope", "verification"] as const),
    resolution: enumOf(["open", "resolved_by_user", "resolved_from_project"] as const),
  }),
);

export const INTERVENTION_TRIGGERS = [
  "ambiguity",
  "scope_expansion",
  "irreversible_action",
  "budget_exhausted",
  "undecidable",
  "conflicting_constraints",
] as const;
export type InterventionTrigger = (typeof INTERVENTION_TRIGGERS)[number];

export const exitConditionSchema = defineSchema(
  "keystone.contract.exitCondition",
  "1.0.0",
  objectOf({
    exitId: localIdValidator,
    kind: enumOf([
      "budget_exhausted",
      "no_progress",
      "unrecoverable_error",
      "policy_denied",
      "user_stopped",
      "external_dependency",
    ] as const),
    description: nonEmptyStr(),
  }),
);

/**
 * Hard boundary on what may happen without asking. This is the one object in
 * the system that a model, extension, past success, or repository content can
 * *never* widen — only a recorded user decision can, and each widening names
 * the decision it came from (PRD HI-04, 9.5).
 */
export const modelTransportPermissionSchema = defineSchema(
  "keystone.contract.modelTransportPermission",
  "1.0.0",
  objectOf({
    subjectId: nonEmptyStr(),
    executable: nonEmptyStr(),
    argvPrefix: arrayOf(str(), { minItems: 1, maxItems: 128 }),
  }),
);

export const autonomyEnvelopeSchema = defineSchema(
  "keystone.contract.autonomyEnvelope",
  "1.1.0",
  objectOf({
    projectId: projectIdValidator,
    readPaths: arrayOf(nonEmptyStr(), { maxItems: 512 }),
    writePaths: arrayOf(nonEmptyStr(), { maxItems: 512 }),
    allowedCommands: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    /** Exact extension transport ceilings; never available to Builder cmd tools. */
    modelTransports: optional(arrayOf(modelTransportPermissionSchema.validator, { maxItems: 16 })),
    allowedHosts: arrayOf(nonEmptyStr(), { maxItems: 128 }),
    allowedCredentials: arrayOf(nonEmptyStr(), { maxItems: 64 }),
    externalSystems: enumOf(["none", "read_only_source", "reversible_write"] as const),
    /** Actions less reversible than this always require confirmation. */
    maxReversibility: enumOf(["reversible", "compensable"] as const),
    /** Network egress policy for content that arrived from untrusted sources. */
    untrustedContentEgress: enumOf(["deny_all", "allowlisted_only"] as const),
    budget: budgetSchema.validator,
    updatedAt: isoTimestampValidator,
    updatedBy: enumOf(["user", "system_default"] as const),
    /** Decisions that widened this envelope. Never cleared automatically. */
    widenedBy: arrayOf(decisionIdValidator, { maxItems: 256 }),
  }),
);

export type AutonomyEnvelope = InferSchema<typeof autonomyEnvelopeSchema>;
export type Budget = InferSchema<typeof budgetSchema>;
export type Scope = InferSchema<typeof scopeSchema>;
export type ScopeEntry = InferSchema<typeof scopeEntrySchema>;
export type Invariant = InferSchema<typeof invariantSchema>;
export type CompletionCondition = InferSchema<typeof completionConditionSchema>;
export type VerifierRef = InferSchema<typeof verifierRefSchema>;
export type Uncertainty = InferSchema<typeof uncertaintySchema>;
export type ExitCondition = InferSchema<typeof exitConditionSchema>;

export const CONTRACT_STATUSES = ["draft", "ready", "awaiting_approval"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const outcomeContractSchema = defineSchema(
  "keystone.contract.outcome",
  "1.0.0",
  objectOf({
    contractId: contractIdValidator,
    /** Monotonic revision. Every edit produces a new value, never an in-place edit. */
    version: int({ min: 1 }),
    taskId: taskIdValidator,
    projectId: projectIdValidator,
    createdAt: isoTimestampValidator,
    createdBy: enumOf(["user", "kernel"] as const),

    /** One sentence describing the result that must hold when the task ends. */
    goal: nonEmptyStr(),
    scope: scopeSchema.validator,
    invariants: arrayOf(invariantSchema.validator, { maxItems: 128 }),
    completionConditions: arrayOf(completionConditionSchema.validator, { minItems: 1, maxItems: 128 }),

    budget: budgetSchema.validator,
    /** The envelope in force; the lease issuer reads this and nothing else. */
    autonomy: autonomyEnvelopeSchema.validator,

    uncertainties: arrayOf(uncertaintySchema.validator, { maxItems: 64 }),
    interventionTriggers: arrayOf(enumOf(INTERVENTION_TRIGGERS), { maxItems: 8 }),
    exitConditions: arrayOf(exitConditionSchema.validator, { minItems: 1, maxItems: 32 }),

    status: enumOf(CONTRACT_STATUSES),

    /** Revision lineage. Absent on the first version. */
    parentContractId: optional(contractIdValidator),
    revisionReason: optional(str({ maxLength: 2000 })),
    revisionSource: optional(enumOf(["user", "kernel"] as const)),

    /** Kernel-owned schema version for cross-client compatibility. */
    schemaVersion: lit("keystone.contract.outcome@1.0.0"),
  }),
);

export type OutcomeContract = InferSchema<typeof outcomeContractSchema>;

/** Condition ids that a completion decision must evaluate. */
export function requiredConditionIds(contract: OutcomeContract): readonly string[] {
  return contract.completionConditions
    .filter((condition) => condition.required)
    .map((condition) => condition.conditionId);
}
