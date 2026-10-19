/**
 * Evidence persistence (PRD VF-01, VF-02, 12.4).
 *
 * Every record states how it was produced, how independent that production was,
 * and which workspace state it describes — otherwise a passing test from three
 * edits ago could be used to prove today's code. Records are appended to
 * `tasks/<taskId>/evidence.jsonl`; `contentHash` is a function of the *meaning*
 * of the observation, so re-recording the same observation is detectable and a
 * replay yields the same hash (NFR-REL-05).
 *
 * E0 cannot stand alone, but that refusal belongs to the proof layer, which
 * knows each condition's required level — recording itself stays dumb.
 */

import { join } from "node:path";

import {
  canonicalJson,
  contentHash,
  evidenceRecordSchema,
  levelSatisfies,
  newId,
  nowIso,
  type BranchId,
  type EvidenceIndependence,
  type EvidenceLevel,
  type EvidenceStatus,
  type EvidenceObservation,
  type EvidenceProducer,
  type EvidenceRecord,
  type ProvenanceRef,
  type TaskId,
} from "@keystone/schemas";

import { appendLineDurable, readJsonLines } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";

export interface RecordEvidenceInput {
  readonly taskId: TaskId;
  readonly branchId: BranchId;
  readonly conditionIds: readonly string[];
  readonly level: EvidenceLevel;
  readonly producer: EvidenceProducer;
  readonly independence: EvidenceIndependence;
  readonly provenance: ProvenanceRef;
  readonly workspaceSnapshotId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly observation: EvidenceObservation;
  /**
   * Current usability of the record. A check that *ran and failed* is recorded
   * with `invalid`: it is real output worth reviewing, but it cannot support the
   * condition it was aimed at. Recording a failure as `valid` would let a failing
   * test prove its own condition.
   */
  readonly status?: EvidenceStatus;
  /** Machine-readable reasons the record is not usable as support. */
  readonly invalidatedBy?: readonly string[];
}

function evidenceFile(paths: KeystonePaths, taskId: string): string {
  return join(paths.taskDir(taskId as TaskId), "evidence.jsonl");
}

export async function recordEvidence(
  paths: KeystonePaths,
  input: RecordEvidenceInput,
): Promise<EvidenceRecord> {
  // Sorted conditions keep the hash stable regardless of caller ordering.
  const conditionIds = [...input.conditionIds].sort();

  const record = evidenceRecordSchema.parse({
    evidenceId: newId("evd"),
    taskId: input.taskId,
    branchId: input.branchId,
    conditionIds,
    level: input.level,
    producer: input.producer,
    independence: input.independence,
    provenance: input.provenance,
    workspaceSnapshotId: input.workspaceSnapshotId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    observation: input.observation,
    createdAt: nowIso(),
    contentHash: contentHash(
      canonicalJson({
        taskId: input.taskId,
        branchId: input.branchId,
        conditionIds,
        level: input.level,
        producer: input.producer,
        independence: input.independence,
        workspaceSnapshotId: input.workspaceSnapshotId,
        contractId: input.contractId,
        contractVersion: input.contractVersion,
        observation: input.observation,
      }),
    ),
    status: input.status ?? "valid",
    invalidatedBy: [...(input.invalidatedBy ?? [])],
    ...(input.status === undefined || input.status === "valid"
      ? {}
      : { invalidatedAt: nowIso() }),
  }) as EvidenceRecord;

  // ensureDir is handled by appendLineDurable, so the task directory does not
  // need to exist beforehand.
  await appendLineDurable(evidenceFile(paths, input.taskId), canonicalJson(record));
  return record;
}

/**
 * Evidence records, oldest first, with only the newest revision of each id.
 *
 * The file is append-only so an invalidation is a new revision rather than an
 * in-place edit — a verdict that was once offered must remain auditable. Callers
 * therefore see the *current* view; `evidenceHistory` is available when the
 * original record matters.
 */
export async function listEvidence(
  paths: KeystonePaths,
  taskId: string,
): Promise<readonly EvidenceRecord[]> {
  const { items } = await readJsonLines<EvidenceRecord>(evidenceFile(paths, taskId));
  const latest = new Map<string, EvidenceRecord>();
  for (const item of items) {
    const record = evidenceRecordSchema.parse(item) as EvidenceRecord;
    latest.set(record.evidenceId, record);
  }
  return [...latest.values()];
}

/** Every revision of every record, for audit rather than for evaluation. */
export async function evidenceHistory(
  paths: KeystonePaths,
  taskId: string,
): Promise<readonly EvidenceRecord[]> {
  const { items } = await readJsonLines<EvidenceRecord>(evidenceFile(paths, taskId));
  return items.map((item) => evidenceRecordSchema.parse(item) as EvidenceRecord);
}

/**
 * Persist a changed view of an existing record. Appends rather than rewrites, so
 * "this evidence used to be valid" stays readable later (PRD DP-02, VF-06).
 */
export async function updateEvidence(
  paths: KeystonePaths,
  taskId: string,
  record: EvidenceRecord,
): Promise<EvidenceRecord> {
  const validated = evidenceRecordSchema.parse(record) as EvidenceRecord;
  await appendLineDurable(evidenceFile(paths, taskId), canonicalJson(validated));
  return validated;
}

export async function getEvidence(
  paths: KeystonePaths,
  taskId: string,
  evidenceId: string,
): Promise<EvidenceRecord | undefined> {
  const records = await listEvidence(paths, taskId);
  return records.find((record) => record.evidenceId === evidenceId);
}

export interface LatestEvidenceOptions {
  readonly level?: EvidenceLevel;
}

/**
 * Valid evidence for a condition, newest first. Only records that still stand
 * and meet the requested level are returned, so callers cannot accidentally use
 * invalidated or too-weak evidence to prove a condition.
 */
export async function latestEvidenceFor(
  paths: KeystonePaths,
  taskId: string,
  conditionId: string,
  options: LatestEvidenceOptions = {},
): Promise<readonly EvidenceRecord[]> {
  const records = await listEvidence(paths, taskId);
  const required = options.level;
  return records
    .filter((record) => record.status === "valid")
    .filter((record) => record.conditionIds.includes(conditionId))
    .filter((record) => required === undefined || levelSatisfies(record.level, required))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
