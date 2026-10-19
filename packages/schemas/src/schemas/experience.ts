/**
 * Experience learning (the Experience Firewall).
 *
 * A success path is not knowledge. It becomes knowledge only after passing
 * source, applicability and negative-transfer checks, and it leaves again when
 * it stops helping (PRD LE-01..LE-04).
 *
 * The critical asymmetry: candidates are produced by the Builder Loop, but
 * *evaluations* are produced by the Assurance Loop. A model never grades its own
 * experience.
 */

import {
  evaluationIdValidator,
  evidenceIdValidator,
  experienceIdValidator,
  projectIdValidator,
  taskIdValidator,
  isoTimestampValidator,
} from "./ids.ts";
import { provenanceRefSchema } from "./provenance.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  lit,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

export const EXPERIENCE_CATEGORIES = [
  "localization_path",
  "patch_pattern",
  "test_mapping",
  "failure_cause",
  "dead_end",
] as const;
export type ExperienceCategory = (typeof EXPERIENCE_CATEGORIES)[number];

/**
 * Where an experience may legitimately apply. Selectivity depends on this being
 * honest: a pattern that only holds for `src/auth/*` must not be offered for
 * `src/billing/*` (PRD LE-03).
 */
export const applicabilitySchema = defineSchema(
  "keystone.experience.applicability",
  "1.0.0",
  objectOf({
    paths: arrayOf(nonEmptyStr(), { maxItems: 128 }),
    symbols: arrayOf(nonEmptyStr(), { maxItems: 256 }),
    languages: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    packageManagers: arrayOf(nonEmptyStr(), { maxItems: 16 }),
    /** Tool or verifier versions the experience was validated against. */
    toolVersions: arrayOf(
      objectOf({ id: nonEmptyStr(), version: nonEmptyStr() }),
      { maxItems: 64 },
    ),
    /** Task shapes it was observed on, e.g. `bugfix`, `feature`, `refactor`. */
    taskShapes: arrayOf(nonEmptyStr(), { maxItems: 16 }),
  }),
);

export const CANDIDATE_STATUSES = [
  "quarantined",
  "rejected",
  "promoted",
  "expired",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * A quarantined candidate. It is never fed into a Context Plan: reaching a task
 * requires promotion first (PRD LE-01, CX-02).
 */
export const experienceCandidateSchema = defineSchema(
  "keystone.experience.candidate",
  "1.0.0",
  objectOf({
    candidateId: experienceIdValidator,
    projectId: projectIdValidator,
    /** Tasks that produced it. More than one is what "independently verified" means. */
    sourceTaskIds: arrayOf(taskIdValidator, { minItems: 1, maxItems: 64 }),
    category: enumOf(EXPERIENCE_CATEGORIES),
    statement: str({ maxLength: 4000 }),
    applicability: applicabilitySchema.validator,
    provenance: provenanceRefSchema.validator,
    /** Evidence that made this candidate worth keeping. */
    supportingEvidenceIds: arrayOf(evidenceIdValidator, { maxItems: 128 }),
    createdAt: isoTimestampValidator,
    status: enumOf(CANDIDATE_STATUSES),
    /** Why it is still quarantined, or why it was rejected/expired. */
    note: str({ maxLength: 2000 }),
  }),
);

export type ExperienceCandidate = InferSchema<typeof experienceCandidateSchema>;

/** The three admissible promotion grounds (PRD LE-02). */
export const PROMOTION_BASES = [
  "independent_verification",
  "user_confirmation",
  "deterministic_derivation",
] as const;
export type PromotionBasis = (typeof PROMOTION_BASES)[number];

export const ENTRY_STATUSES = ["active", "demoted", "frozen", "deleted"] as const;
export type ExperienceEntryStatus = (typeof ENTRY_STATUSES)[number];

export const experienceEntrySchema = defineSchema(
  "keystone.experience.entry",
  "1.0.0",
  objectOf({
    entryId: experienceIdValidator,
    projectId: projectIdValidator,
    candidateId: optional(experienceIdValidator),
    category: enumOf(EXPERIENCE_CATEGORIES),
    statement: str({ maxLength: 4000 }),
    applicability: applicabilitySchema.validator,
    provenance: provenanceRefSchema.validator,
    promotedAt: isoTimestampValidator,
    promotedBy: enumOf(PROMOTION_BASES),
    supportingTaskIds: arrayOf(taskIdValidator, { maxItems: 64 }),
    supportingEvidenceIds: arrayOf(evidenceIdValidator, { maxItems: 128 }),
    /** Machine-readable invalidation conditions (PRD LE-02, LE-04). */
    invalidatedBy: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    /** Frozen entries resist automatic demotion but stay user-revocable. */
    frozen: bool(),
    status: enumOf(ENTRY_STATUSES),
    note: str({ maxLength: 2000 }),
  }),
);

export type ExperienceEntry = InferSchema<typeof experienceEntrySchema>;

/**
 * How a promoted experience behaved when it was actually used. This is the
 * signal that drives demotion; without it, "keeps getting better" is unprovable
 * (PRD LE-03, 13).
 */
export const TRANSFER_OUTCOMES = [
  "positive_transfer",
  "negative_transfer",
  "neutral",
  "forgotten",
  "not_evaluable",
] as const;
export type TransferOutcome = (typeof TRANSFER_OUTCOMES)[number];

export const experienceEvaluationSchema = defineSchema(
  "keystone.experience.evaluation",
  "1.0.0",
  objectOf({
    evaluationId: evaluationIdValidator,
    entryId: experienceIdValidator,
    /** The later task the experience was reused on. */
    taskId: taskIdValidator,
    used: bool(),
    /** When `used` is false, why the firewall excluded it. */
    exclusionReason: optional(str({ maxLength: 2000 })),
    outcome: enumOf(TRANSFER_OUTCOMES),
    /** Evidence from the later task that judges the outcome. */
    judgeEvidenceIds: arrayOf(evidenceIdValidator, { maxItems: 128 }),
    /** Deliberately not the model that produced the entry (PRD LE-03). */
    evaluatedBy: lit("assurance_loop"),
    evaluatedAt: isoTimestampValidator,
    detail: str({ maxLength: 2000 }),
  }),
);

export type ExperienceEvaluation = InferSchema<typeof experienceEvaluationSchema>;

/**
 * Demotion triggers (PRD LE-04). Any one of these moves an entry out of the
 * reusable set and forces affected running tasks to rebuild their Context Plan.
 */
export const DEMOTION_REASONS = [
  "caused_verification_failure",
  "caused_out_of_scope_change",
  "contradicted_by_fact",
  "contradicted_by_user_rule",
  "source_marked_untrusted",
  "incompatible_version_change",
  "negative_transfer_threshold",
  "forgetting_threshold",
  "user_requested",
] as const;
export type DemotionReason = (typeof DEMOTION_REASONS)[number];

export function demotionRequiresRebuild(reason: DemotionReason): boolean {
  // Every demotion changes what a running task may be told, so all of them
  // require a rebuild — listed explicitly so a future addition cannot silently
  // default to "no rebuild needed".
  switch (reason) {
    case "caused_verification_failure":
    case "caused_out_of_scope_change":
    case "contradicted_by_fact":
    case "contradicted_by_user_rule":
    case "source_marked_untrusted":
    case "incompatible_version_change":
    case "negative_transfer_threshold":
    case "forgetting_threshold":
    case "user_requested":
      return true;
  }
}
