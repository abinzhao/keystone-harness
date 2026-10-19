/**
 * Evidence records.
 *
 * Completion is decided by evidence, not by model text. Every record states
 * *how* it was produced (`producer`), *how independent* that production was
 * from the Builder Loop (`independence`), and *which workspace state* it
 * describes — otherwise a passing test from three edits ago could be used to
 * prove today's code (PRD VF-01, VF-02, VF-04).
 */

import {
  artifactIdValidator,
  branchIdValidator,
  evidenceIdValidator,
  localIdValidator,
  snapshotIdValidator,
  taskIdValidator,
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

/**
 * Evidence levels (PRD VF-02).
 *
 * | Level | Meaning                            | Stands alone for completion |
 * |-------|------------------------------------|-----------------------------|
 * | E0    | model claim                        | never                       |
 * | E1    | tool record (command output, diff)  | low-risk auxiliary items    |
 * | E2    | controlled execution result         | when the condition allows   |
 * | E3    | independent controlled re-check     | when the condition allows   |
 * | E4    | externally trusted proof            | high-risk conditions        |
 */
export const EVIDENCE_LEVELS = ["E0", "E1", "E2", "E3", "E4"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

const LEVEL_RANK: Record<EvidenceLevel, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

export function evidenceRank(level: EvidenceLevel): number {
  return LEVEL_RANK[level];
}

/** E0 can never stand alone; E1 only for auxiliary low-risk checks (VF-02). */
export function levelCanStandAlone(level: EvidenceLevel): boolean {
  return evidenceRank(level) >= LEVEL_RANK.E2;
}

/**
 * True when a record at `level` meets a condition requiring `required`.
 * A higher level always satisfies a lower requirement.
 */
export function levelSatisfies(level: EvidenceLevel, required: EvidenceLevel): boolean {
  return evidenceRank(level) >= evidenceRank(required);
}

/** Who produced the record. The version matters: re-running after a verifier
 * upgrade does not silently inherit the earlier verdict (PRD 9.7). */
export const producerSchema = defineSchema(
  "keystone.evidence.producer",
  "1.0.0",
  objectOf({
    kind: enumOf(["tool", "verifier", "model", "external", "user"] as const),
    id: nonEmptyStr(),
    version: nonEmptyStr(),
  }),
);

/**
 * How far the producer was from the thing it checks. A verifier that shares the
 * Builder Loop's process, model, workspace or data sources is *not* independent
 * and cannot satisfy a condition that requires independence (PRD VF-01, VF-04).
 */
export const INDEPENDENCE_TARGETS = [
  "builder_loop_model",
  "builder_loop_process",
  "builder_loop_workspace",
  "builder_loop_datasource",
] as const;
export type IndependenceTarget = (typeof INDEPENDENCE_TARGETS)[number];

export const independenceSchema = defineSchema(
  "keystone.evidence.independence",
  "1.0.0",
  objectOf({
    mode: enumOf([
      "same_process",
      "separate_process",
      "isolated_workspace",
      "external_service",
    ] as const),
    /** What the producer is independent *of*. Empty means "of nothing". */
    independentOf: arrayOf(enumOf(INDEPENDENCE_TARGETS), { maxItems: 4 }),
    /** Environment fingerprint of the run, so "same environment" is checkable. */
    environmentFingerprint: optional(str({ pattern: /^[0-9a-f]{64}$/ })),
  }),
);

export function isIndependentOf(
  independence: InferSchema<typeof independenceSchema>,
  target: IndependenceTarget,
): boolean {
  return independence.independentOf.includes(target);
}

/**
 * Raw observation. Large payloads live in content-addressed artifacts; the
 * record keeps the hash so a reviewer can re-fetch and verify the exact bytes
 * (PRD 12.4, DP-02).
 */
export const observationSchema = defineSchema(
  "keystone.evidence.observation",
  "1.0.0",
  objectOf({
    summary: str({ maxLength: 2000 }),
    command: optional(str({ maxLength: 2000 })),
    exitCode: optional(int()),
    artifactId: optional(artifactIdValidator),
    stdoutHash: optional(str({ pattern: /^[0-9a-f]{64}$/ })),
    bytes: optional(int({ min: 0 })),
    truncated: bool(),
    /** Items the verifier could not evaluate. Surfaced as a residual risk. */
    incomplete: optional(arrayOf(nonEmptyStr(), { maxItems: 32 })),
  }),
);

export const EVIDENCE_STATUSES = ["valid", "partially_invalid", "invalid"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const evidenceRecordSchema = defineSchema(
  "keystone.evidence.record",
  "1.0.0",
  objectOf({
    evidenceId: evidenceIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    /** Conditions this record is offered as support for. */
    conditionIds: arrayOf(localIdValidator, { minItems: 1, maxItems: 32 }),
    level: enumOf(EVIDENCE_LEVELS),
    producer: producerSchema.validator,
    independence: independenceSchema.validator,
    provenance: provenanceRefSchema.validator,
    /** Workspace state at the moment of observation. */
    workspaceSnapshotId: snapshotIdValidator,
    /** Contract revision in force when this evidence was produced. */
    contractId: nonEmptyStr(),
    contractVersion: int({ min: 1 }),
    observation: observationSchema.validator,
    createdAt: isoTimestampValidator,
    contentHash: str({ pattern: /^[0-9a-f]{64}$/ }),
    status: enumOf(EVIDENCE_STATUSES),
    /** Machine-readable reasons the evidence no longer applies (PRD VF-06). */
    invalidatedBy: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    invalidatedAt: optional(isoTimestampValidator),
  }),
);

export type EvidenceRecord = InferSchema<typeof evidenceRecordSchema>;
export type EvidenceProducer = InferSchema<typeof producerSchema>;
export type EvidenceIndependence = InferSchema<typeof independenceSchema>;
export type EvidenceObservation = InferSchema<typeof observationSchema>;
