/**
 * Checkpoints — restorable snapshots of a run.
 *
 * A checkpoint is a *complete* state, not a delta: the folded task state plus the
 * references (evidence, leases, artifacts, workspace fingerprint) needed to
 * resume without replaying (ADR-0003). That is why recovery is "load the
 * snapshot and compare the workspace" rather than "replay and hope".
 *
 * Two properties are load-bearing here:
 *
 *  - A checkpoint is written atomically, so a reader never sees half of one
 *    (NFR-REL-08). The atomic primitive supplies that; this module does not
 *    invent its own.
 *  - A checkpoint carries a self-digest over every other field. If the bytes on
 *    disk change at all — a truncated write, an edited file, a newer runtime
 *    adding a field — the digest no longer recomputes and the checkpoint is
 *    refused instead of being used to justify a resume (NFR-REL-02, EX-04).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  checkpointSchema,
  contentHash,
  newId,
  nowIso,
  type Checkpoint,
  type CheckpointId,
  type CheckpointReason,
  type Sha256Hex,
  type TaskId,
  type TaskState,
} from "@keystone/schemas";

import { isNotFound, readTextFile, writeFileAtomic } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";

export interface CreateCheckpointInput {
  /** Folded state at this point; the checkpoint restores it verbatim. */
  readonly state: TaskState;
  readonly reason: CheckpointReason;
  /** Ledger seq this checkpoint covers, so resume can name the covered prefix. */
  readonly seq: number;
  readonly contractDigest?: Sha256Hex;
  readonly workspaceSnapshotId?: string;
  readonly verification?: {
    readonly workspaceFingerprint?: Sha256Hex;
    readonly dependencyFingerprint?: Sha256Hex;
    readonly toolFingerprint?: Sha256Hex;
  };
  readonly pendingStepIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly activeLeaseIds?: readonly string[];
  readonly extensions?: readonly { readonly id: string; readonly version: string }[];
  readonly parentCheckpointId?: string;
}

/**
 * Raised when a checkpoint on disk does not match its own integrity digest.
 * Callers must treat this as "no checkpoint", never as "a checkpoint with a
 * slightly wrong field" (NFR-REL-08).
 */
export class CheckpointIntegrityError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(`checkpoint ${filePath} failed integrity verification: ${detail}`);
    this.name = "CheckpointIntegrityError";
    this.filePath = filePath;
  }
}

/**
 * Placeholder digest used to bring the record through the schema before the real
 * digest exists. It is never written: the second parse replaces it.
 */
const INTEGRITY_PLACEHOLDER = "0".repeat(64);

/**
 * Digest over every field except `integrity` itself. Canonical JSON is used so
 * the digest is reproducible across machines (NFR-REL-05); the field order in a
 * JSON file therefore cannot affect the verdict.
 */
function digestOf(record: Checkpoint): Sha256Hex {
  const rest: Record<string, unknown> = { ...record };
  delete rest["integrity"];
  return contentHash(rest);
}

/**
 * The public API takes plain `string` ids (callers hold them as strings from the
 * CLI or config), but the storage layout is typed with branded ids. This helper
 * is the single place where that boundary is crossed.
 */
function checkpointPath(paths: KeystonePaths, taskId: string, checkpointId: string): string {
  return paths.checkpointFile(taskId as TaskId, checkpointId as CheckpointId);
}

/** Writes the checkpoint atomically and returns the validated record. */
export async function createCheckpoint(
  paths: KeystonePaths,
  taskId: string,
  input: CreateCheckpointInput,
): Promise<Checkpoint> {
  const state = input.state;
  const verification = {
    ...(input.verification?.workspaceFingerprint === undefined
      ? {}
      : { workspaceFingerprint: input.verification.workspaceFingerprint }),
    ...(input.verification?.dependencyFingerprint === undefined
      ? {}
      : { dependencyFingerprint: input.verification.dependencyFingerprint }),
    ...(input.verification?.toolFingerprint === undefined
      ? {}
      : { toolFingerprint: input.verification.toolFingerprint }),
  };

  const checkpointId = newId("ckpt");
  const fields = {
    checkpointId,
    taskId,
    branchId: state.branchId,
    seq: input.seq,
    createdAt: nowIso(),
    reason: input.reason,
    state,
    // Contract identity travels with the folded state; the checkpoint must name
    // the revision it was taken under so resume can detect a revision (OT-03).
    ...(state.contractId === undefined ? {} : { contractId: state.contractId }),
    ...(state.contractVersion === undefined ? {} : { contractVersion: state.contractVersion }),
    ...(input.contractDigest === undefined ? {} : { contractDigest: input.contractDigest }),
    ...(input.workspaceSnapshotId === undefined
      ? {}
      : { workspaceSnapshotId: input.workspaceSnapshotId }),
    verification,
    pendingStepIds: [...(input.pendingStepIds ?? [])],
    // Default the volatile lists to the folded state's own view so a checkpoint
    // taken without them still restores what the fold would reconstruct.
    evidenceIds: [...(input.evidenceIds ?? state.outstandingEvidence)],
    artifactRefs: [...(input.artifactRefs ?? [])],
    activeLeaseIds: [...(input.activeLeaseIds ?? state.activeLeaseIds)],
    extensions:
      input.extensions === undefined
        ? []
        : input.extensions.map((extension) => ({ id: extension.id, version: extension.version })),
    ...(input.parentCheckpointId === undefined
      ? {}
      : { parentCheckpointId: input.parentCheckpointId }),
  };

  // Parse once to get a canonical, schema-shaped record, digest that, then parse
  // again with the digest in place. Digesting the *parsed* record (not the raw
  // literal) keeps the digest re-computable from a re-read file.
  const provisional = checkpointSchema.parse({
    ...fields,
    integrity: INTEGRITY_PLACEHOLDER,
  }) as Checkpoint;
  const integrity = digestOf(provisional);
  const record = checkpointSchema.parse({ ...provisional, integrity }) as Checkpoint;

  // The file is written with the same canonical encoder the digest uses, so a
  // re-read always reproduces the digest byte for byte.
  await writeFileAtomic(checkpointPath(paths, taskId, checkpointId), canonicalJson(record));
  return record;
}

export async function loadCheckpoint(
  paths: KeystonePaths,
  taskId: string,
  checkpointId: string,
): Promise<Checkpoint | undefined> {
  const filePath = checkpointPath(paths, taskId, checkpointId);
  const text = await readTextFile(filePath);
  if (text === undefined) return undefined;
  return verifyRead(filePath, text);
}

/** Most recent by seq (ties broken by createdAt, then id for determinism). */
export async function latestCheckpoint(
  paths: KeystonePaths,
  taskId: string,
  options: { readonly branchId?: string } = {},
): Promise<Checkpoint | undefined> {
  const all = await listCheckpoints(paths, taskId);
  const scoped =
    options.branchId === undefined ? all : all.filter((cp) => cp.branchId === options.branchId);
  let latest: Checkpoint | undefined;
  for (const candidate of scoped) {
    if (latest === undefined || compareCheckpoints(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

/**
 * Read every checkpoint for a task. Unreadable files are skipped rather than
 * allowed to abort the listing, but they are *reported* through `onCorrupt`: a
 * silently dropped checkpoint would make the remaining set look complete when it
 * is not (NFR-REL-01).
 */
export async function listCheckpoints(
  paths: KeystonePaths,
  taskId: string,
  onCorrupt?: (file: string, error: unknown) => void,
): Promise<readonly Checkpoint[]> {
  const dir = paths.checkpointsDir(taskId as TaskId);
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const checkpoints: Checkpoint[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(dir, name);
    try {
      const record = await loadCheckpointByFile(filePath);
      if (record !== undefined) checkpoints.push(record);
    } catch (error) {
      onCorrupt?.(filePath, error);
    }
  }
  return checkpoints;
}

async function loadCheckpointByFile(filePath: string): Promise<Checkpoint | undefined> {
  const text = await readTextFile(filePath);
  if (text === undefined) return undefined;
  return verifyRead(filePath, text);
}

/** Parse and recompute the digest; a mismatch is a refusal, not a warning. */
function verifyRead(filePath: string, text: string): Checkpoint {
  let record: Checkpoint;
  try {
    record = checkpointSchema.parse(JSON.parse(text)) as Checkpoint;
  } catch (error) {
    throw new CheckpointIntegrityError(
      filePath,
      `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expected = digestOf(record);
  if (expected !== record.integrity) {
    throw new CheckpointIntegrityError(
      filePath,
      `stored digest ${record.integrity} does not match recomputed ${expected}`,
    );
  }
  return record;
}

/** Ascending order over (seq, createdAt, checkpointId). */
function compareCheckpoints(a: Checkpoint, b: Checkpoint): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.checkpointId < b.checkpointId ? -1 : a.checkpointId > b.checkpointId ? 1 : 0;
}
