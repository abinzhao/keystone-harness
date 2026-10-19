/**
 * Run branches — independent runs that fork from a checkpoint.
 *
 * A branch forks from a checkpoint and keeps its own plan, budget, workspace
 * changes and evidence; it never overwrites the source branch (PRD EX-04).
 *
 * Hash-chain trade-off: a branch's ledger starts at seq=1 with prevHash=null, so
 * the chains of two branches are *not* contiguous. That is deliberate — a branch
 * must be independently replayable and comparable, and stitching its first event
 * onto the parent's chain tip would make every branch depend on the exact byte
 * history of its parent. The cross-branch "same origin" guarantee therefore comes
 * from `parentCheckpointId` (a reference to a content-addressed checkpoint) plus
 * the checkpoint's own integrity digest, not from a continuous hash link.
 */

import { open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  branchComparisonSchema,
  branchSummarySchema,
  canonicalJson,
  isIndependentOf,
  levelSatisfies,
  newId,
  nowIso,
  runBranchSchema,
  type BranchComparison,
  type BranchId,
  type BranchStatus,
  type BranchSummary,
  type EvidenceRecord,
  type OutcomeContract,
  type RunBranch,
  type TaskId,
  type TaskState,
  type TaskStatus,
} from "@keystone/schemas";

import { ensureDir, isNotFound, readTextFile, writeFileAtomic } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";

export interface CreateBranchInput {
  readonly taskId: string;
  readonly label: string;
  readonly reason: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly parentCheckpointId?: string;
  readonly forkedFromBranchId?: string;
  /** Set when the branch needs an isolated worktree (PRD 9.6). */
  readonly workspacePath?: string;
}

/**
 * Branch records live beside their ledgers: `branches/<branchId>.json`.
 *
 * The public API takes plain `string` ids while the storage layout is typed with
 * branded ids, so this is where that boundary is crossed.
 */
function branchFile(paths: KeystonePaths, taskId: string, branchId: string): string {
  return join(paths.taskDir(taskId as TaskId), "branches", `${branchId}.json`);
}

/** Creates the branch record and initialises its empty ledger file. */
export async function createBranch(
  paths: KeystonePaths,
  input: CreateBranchInput,
): Promise<RunBranch> {
  const branchId = newId("branch");
  const branch = runBranchSchema.parse({
    branchId,
    taskId: input.taskId,
    label: input.label,
    ...(input.parentCheckpointId === undefined
      ? {}
      : { parentCheckpointId: input.parentCheckpointId }),
    ...(input.forkedFromBranchId === undefined
      ? {}
      : { forkedFromBranchId: input.forkedFromBranchId }),
    forkedAt: nowIso(),
    reason: input.reason,
    status: "active",
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
  }) as RunBranch;

  await writeFileAtomic(branchFile(paths, input.taskId, branchId), canonicalJson(branch));

  // Touch the ledger so a resume/append finds a real file. Open in append mode so
  // an existing (unexpected) ledger is never truncated.
  const ledgerPath = paths.branchLedgerFile(input.taskId as TaskId, branchId as BranchId);
  await ensureDir(dirname(ledgerPath));
  const handle = await open(ledgerPath, "a", 0o600);
  await handle.close();

  return branch;
}

export async function loadBranch(
  paths: KeystonePaths,
  taskId: string,
  branchId: string,
): Promise<RunBranch | undefined> {
  const text = await readTextFile(branchFile(paths, taskId, branchId));
  if (text === undefined) return undefined;
  return runBranchSchema.parse(JSON.parse(text)) as RunBranch;
}

export async function listBranches(
  paths: KeystonePaths,
  taskId: string,
): Promise<readonly RunBranch[]> {
  const dir = join(paths.taskDir(taskId as TaskId), "branches");
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const branches: RunBranch[] = [];
  for (const name of names) {
    // `.jsonl` ledger files do not end in `.json`, so they cannot be mistaken for
    // a branch record.
    if (!name.endsWith(".json")) continue;
    const text = await readTextFile(join(dir, name));
    if (text === undefined) continue;
    try {
      branches.push(runBranchSchema.parse(JSON.parse(text)) as RunBranch);
    } catch {
      // A branch record that cannot be parsed is not a branch; skip it rather
      // than failing the whole listing.
    }
  }
  return branches.sort((a, b) => (a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0));
}

export async function setBranchStatus(
  paths: KeystonePaths,
  taskId: string,
  branchId: string,
  status: BranchStatus,
): Promise<RunBranch> {
  const existing = await loadBranch(paths, taskId, branchId);
  if (existing === undefined) {
    throw new Error(`branch ${branchId} does not exist for task ${taskId}`);
  }
  const updated = runBranchSchema.parse({ ...existing, status }) as RunBranch;
  await writeFileAtomic(branchFile(paths, taskId, branchId), canonicalJson(updated));
  return updated;
}

export interface SummarizeBranchInput {
  readonly branch: RunBranch;
  readonly state: TaskState;
  readonly changedPaths: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
  /** When supplied, verification status is judged against its conditions. */
  readonly contract?: OutcomeContract;
}

/** Map a folded status onto the summary's outcome vocabulary. */
function outcomeFor(status: TaskStatus): BranchSummary["outcome"] {
  switch (status) {
    case "proven":
      return "proven";
    case "exited_gracefully":
      return "exited_gracefully";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "executing":
    case "verifying":
    case "auto_repairing":
    case "paused":
    case "resuming":
      return "running";
    default:
      return "unknown";
  }
}

interface VerificationVerdict {
  readonly status: BranchSummary["verificationStatus"];
  readonly residualRiskCount: number;
}

function verdictFor(
  evidence: readonly EvidenceRecord[],
  contract: OutcomeContract | undefined,
): VerificationVerdict {
  const valid = evidence.filter((record) => record.status === "valid");

  if (contract !== undefined) {
    const required = contract.completionConditions.filter((condition) => condition.required);
    if (required.length === 0) {
      return {
        status: evidence.length === 0 ? "unknown" : "satisfied",
        residualRiskCount: 0,
      };
    }
    let satisfied = 0;
    for (const condition of required) {
      const supports = valid.some(
        (record) =>
          record.conditionIds.includes(condition.conditionId) &&
          levelSatisfies(record.level, condition.minEvidenceLevel) &&
          (!condition.requiresIndependence ||
            record.independence.mode !== "same_process" ||
            isIndependentOf(record.independence, "builder_loop_process")),
      );
      if (supports) satisfied += 1;
    }
    const status: BranchSummary["verificationStatus"] =
      satisfied === required.length
        ? "satisfied"
        : satisfied === 0
          ? "unsatisfied"
          : "partially_satisfied";
    return { status, residualRiskCount: required.length - satisfied };
  }

  // Without a contract we can only report on evidence health, not on whether the
  // conditions are met — an honest "unknown" beats a confident wrong answer.
  if (evidence.length === 0) return { status: "unknown", residualRiskCount: 0 };
  const invalid = evidence.filter((record) => record.status !== "valid").length;
  const status: BranchSummary["verificationStatus"] =
    invalid === 0 ? "satisfied" : invalid === evidence.length ? "unsatisfied" : "partially_satisfied";
  return { status, residualRiskCount: invalid };
}

/** Build a comparable summary from a folded state and its evidence. */
export function summarizeBranch(input: SummarizeBranchInput): BranchSummary {
  const { branch, state, changedPaths, evidence } = input;
  const verdict = verdictFor(evidence, input.contract);

  return branchSummarySchema.parse({
    branchId: branch.branchId,
    label: branch.label,
    outcome: outcomeFor(state.status),
    tokensUsed: state.budgetUsed.tokens,
    retriesUsed: state.budgetUsed.retries,
    wallClockMs: state.budgetUsed.wallClockMs,
    changedFileCount: changedPaths.length,
    changedPaths: changedPaths.slice(0, 256),
    verificationStatus: verdict.status,
    residualRiskCount: verdict.residualRiskCount,
    evidenceIds: evidence.map((record) => record.evidenceId).slice(0, 512),
  }) as BranchSummary;
}

export interface CompareBranchesOptions {
  /**
   * The task the branches belong to. `BranchSummary` does not carry it, but the
   * protocol's `BranchComparison` requires it, so the caller supplies it.
   */
  readonly taskId?: string;
  readonly at?: string;
}

const OUTCOME_RANK: Record<BranchSummary["outcome"], number> = {
  proven: 0,
  exited_gracefully: 1,
  running: 2,
  stopped: 3,
  failed: 4,
  unknown: 5,
};

const VERIFICATION_RANK: Record<BranchSummary["verificationStatus"], number> = {
  satisfied: 0,
  partially_satisfied: 1,
  unsatisfied: 2,
  unknown: 3,
};

/**
 * Deterministic, explainable ordering. Priority is fixed so two callers with the
 * same inputs always pick the same branch:
 *   1. outcome (proven first)
 *   2. verification status (satisfied > partially_satisfied > unsatisfied > unknown)
 *   3. fewer residual risks
 *   4. fewer changed files
 *   5. fewer tokens
 *   6. lexicographic branch id
 */
function compareSummaries(a: BranchSummary, b: BranchSummary): number {
  const outcome = OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome];
  if (outcome !== 0) return outcome;

  const verification = VERIFICATION_RANK[a.verificationStatus] - VERIFICATION_RANK[b.verificationStatus];
  if (verification !== 0) return verification;

  if (a.residualRiskCount !== b.residualRiskCount) {
    return a.residualRiskCount - b.residualRiskCount;
  }
  if (a.changedFileCount !== b.changedFileCount) {
    return a.changedFileCount - b.changedFileCount;
  }
  if (a.tokensUsed !== b.tokensUsed) {
    return a.tokensUsed - b.tokensUsed;
  }
  return a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
}

function rationaleFor(best: BranchSummary): string {
  return (
    `recommended branch ${best.branchId}: outcome=${best.outcome}, ` +
    `verification=${best.verificationStatus}, residual risks=${best.residualRiskCount}, ` +
    `changed files=${best.changedFileCount}, tokens=${best.tokensUsed}. ` +
    "Selection order: outcome > verification status > fewer residual risks > fewer changed files > fewer tokens > branch id."
  );
}

export function compareBranches(
  summaries: readonly BranchSummary[],
  options: CompareBranchesOptions = {},
): BranchComparison {
  if (summaries.length < 2) {
    throw new Error(`compareBranches needs at least two branches, received ${summaries.length}`);
  }
  if (options.taskId === undefined) {
    // The comparison object is a protocol object keyed by task; without the task
    // id it cannot be produced honestly.
    throw new Error("compareBranches requires options.taskId to build a BranchComparison");
  }

  const entries = [...summaries].sort(compareSummaries);
  const best = entries[0];
  if (best === undefined) throw new Error("compareBranches: no entries after sorting");

  return branchComparisonSchema.parse({
    taskId: options.taskId,
    at: options.at ?? nowIso(),
    entries,
    recommendation: { branchId: best.branchId, rationale: rationaleFor(best) },
  }) as BranchComparison;
}
