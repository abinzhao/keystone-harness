/**
 * Context Plan and Context Capsule.
 *
 * Each step loads only what that step needs, and records why. Two things are
 * load-bearing beyond the field list:
 *
 *  - **Exclusions are part of the record.** "We did not send this file" is
 *    information the user is entitled to (PRD CX-01).
 *  - **Token cost is measured, not estimated.** A cache hit that did not
 *    actually avoid an input is not a saving (PRD CX-02, CX-03, NFR-PERF-06).
 */

import {
  evidenceIdValidator,
  experienceIdValidator,
  factIdValidator,
  localIdValidator,
  snapshotIdValidator,
  taskIdValidator,
  artifactIdValidator,
  branchIdValidator,
  isoTimestampValidator,
} from "./ids.ts";
import { provenanceRefSchema } from "./provenance.ts";
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

export const CONTEXT_ITEM_KINDS = [
  "file",
  "symbol",
  "fact",
  "experience",
  "contract",
  "test",
  "diff",
  "history",
  "instruction",
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

export const contextItemSchema = defineSchema(
  "keystone.context.item",
  "1.0.0",
  objectOf({
    itemId: localIdValidator,
    kind: enumOf(CONTEXT_ITEM_KINDS),
    /** Path, symbol name, fact id, experience id, ... — depends on `kind`. */
    ref: nonEmptyStr(),
    source: provenanceRefSchema.validator,
    applicableSnapshot: optional(snapshotIdValidator),
    /** Actual measured token count for this item, not an estimate. */
    tokens: int({ min: 0 }),
    /** Why this item is in the capsule. Shown to the user on request. */
    reason: str({ maxLength: 1000 }),
    /** Conditions that would invalidate the inclusion of this item. */
    invalidatedBy: arrayOf(nonEmptyStr(), { maxItems: 16 }),
    /** True when the item came from a cache rather than a fresh read. */
    fromCache: bool(),
  }),
);

export const contextExclusionSchema = defineSchema(
  "keystone.context.exclusion",
  "1.0.0",
  objectOf({
    ref: nonEmptyStr(),
    reason: nonEmptyStr(),
    /** How relevant it looked before exclusion — high relevance must be justified. */
    apparentRelevance: enumOf(["high", "medium", "low"] as const),
  }),
);

/**
 * A recorded cache hit. `savedTokens` is only set when a read or model input was
 * genuinely avoided; a hit that still had to re-read is recorded with zero.
 */
export const cacheHitSchema = defineSchema(
  "keystone.context.cacheHit",
  "1.0.0",
  objectOf({
    ref: nonEmptyStr(),
    /** Why the cached entry still matched the current workspace state. */
    matchBasis: nonEmptyStr(),
    savedTokens: int({ min: 0 }),
    /** Entry that would be invalidated by these conditions. */
    invalidatedBy: arrayOf(nonEmptyStr(), { maxItems: 16 }),
  }),
);

export const contextPlanSchema = defineSchema(
  "keystone.context.plan",
  "1.0.0",
  objectOf({
    planId: localIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    /** Step the plan was built for, e.g. `step.localize`. */
    stepId: localIdValidator,
    createdAt: isoTimestampValidator,

    items: arrayOf(contextItemSchema.validator, { maxItems: 4096 }),
    exclusions: arrayOf(contextExclusionSchema.validator, { maxItems: 4096 }),
    cacheHits: arrayOf(cacheHitSchema.validator, { maxItems: 1024 }),

    tokenBudget: int({ min: 0 }),
    tokensUsed: int({ min: 0 }),
    /** Token cost per item kind, for the budget breakdown in the workbench. */
    tokensBySource: arrayOf(
      objectOf({ sourceKind: nonEmptyStr(), tokens: int({ min: 0 }) }),
      { maxItems: 16 },
    ),

    factsUsed: arrayOf(factIdValidator, { maxItems: 512 }),
    experiencesUsed: arrayOf(experienceIdValidator, { maxItems: 256 }),
    evidenceReferenced: arrayOf(evidenceIdValidator, { maxItems: 512 }),

    /** Model the capsule was assembled for; a provider change invalidates caches. */
    modelTarget: nonEmptyStr(),
    /** Rebuild triggers: the plan is discarded when one of these becomes true. */
    rebuildWhen: arrayOf(nonEmptyStr(), { maxItems: 32 }),
  }),
);

export type ContextPlan = InferSchema<typeof contextPlanSchema>;
export type ContextItem = InferSchema<typeof contextItemSchema>;
export type ContextExclusion = InferSchema<typeof contextExclusionSchema>;
export type CacheHit = InferSchema<typeof cacheHitSchema>;

/**
 * The material actually handed to a model. Content is stored as a
 * content-addressed artifact so the capsule can be audited without the plan
 * carrying repository text around (PRD 11.4).
 */
export const contextCapsuleSchema = defineSchema(
  "keystone.context.capsule",
  "1.0.0",
  objectOf({
    capsuleId: localIdValidator,
    planId: localIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    createdAt: isoTimestampValidator,
    renderedArtifactId: artifactIdValidator,
    tokens: int({ min: 0 }),
    /** Item ids included, in the order they appear in the rendered capsule. */
    itemOrder: arrayOf(localIdValidator, { maxItems: 4096 }),
    /** Everything in the capsule inherited at most this trust level. */
    lowestTrustLevel: nonEmptyStr(),
    truncated: bool(),
  }),
);

export type ContextCapsule = InferSchema<typeof contextCapsuleSchema>;
