import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  branchSummarySchema,
  checkpointSchema,
  evidenceRecordSchema,
  newId,
  outcomeContractSchema,
  taskStateSchema,
  type BranchSummary,
  type Checkpoint,
  type CheckpointId,
  type EvidenceRecord,
  type OutcomeContract,
  type TaskId,
  type TaskState,
} from "@keystone/schemas";

import {
  CheckpointIntegrityError,
  createCheckpoint,
  latestCheckpoint,
  listCheckpoints,
  loadCheckpoint,
} from "../src/run/checkpoints.ts";
import {
  compareBranches,
  createBranch,
  listBranches,
  loadBranch,
  setBranchStatus,
  summarizeBranch,
} from "../src/run/branches.ts";
import { assessRecovery, canResume, describeRecovery } from "../src/run/recovery.ts";
import { resolveKeystonePaths } from "../src/storage/paths.ts";

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keystone-run-"));
  return dir;
}

const FP = "a".repeat(64);
const OTHER_FP = "b".repeat(64);

function stateFor(options: {
  readonly taskId: string;
  readonly branchId: string;
  readonly projectId: string;
  readonly status?: TaskState["status"];
  readonly tokens?: number;
}): TaskState {
  const at = new Date().toISOString();
  return taskStateSchema.parse({
    taskId: options.taskId,
    projectId: options.projectId,
    branchId: options.branchId,
    status: options.status ?? "executing",
    stage: "modifying",
    seq: 3,
    createdAt: at,
    updatedAt: at,
    budgetUsed: {
      tokens: options.tokens ?? 0,
      retries: 0,
      wallClockMs: 0,
      costUsd: 0,
    },
    pendingInterventions: [],
    outstandingEvidence: [],
    activeLeaseIds: [],
  }) as TaskState;
}

function checkpointFixture(options: {
  readonly taskId: string;
  readonly branchId: string;
  readonly projectId: string;
  readonly seq?: number;
  readonly status?: TaskState["status"];
  readonly workspaceFingerprint?: string;
  readonly toolFingerprint?: string;
  readonly dependencyFingerprint?: string;
  readonly workspaceSnapshotId?: string;
}): Checkpoint {
  return checkpointSchema.parse({
    checkpointId: newId("ckpt"),
    taskId: options.taskId,
    branchId: options.branchId,
    seq: options.seq ?? 3,
    createdAt: new Date().toISOString(),
    reason: "pre_verification",
    state: stateFor({
      taskId: options.taskId,
      branchId: options.branchId,
      projectId: options.projectId,
      ...(options.status === undefined ? {} : { status: options.status }),
    }),
    verification: {
      ...(options.workspaceFingerprint === undefined
        ? {}
        : { workspaceFingerprint: options.workspaceFingerprint }),
      ...(options.toolFingerprint === undefined ? {} : { toolFingerprint: options.toolFingerprint }),
      ...(options.dependencyFingerprint === undefined
        ? {}
        : { dependencyFingerprint: options.dependencyFingerprint }),
    },
    ...(options.workspaceSnapshotId === undefined
      ? {}
      : { workspaceSnapshotId: options.workspaceSnapshotId }),
    pendingStepIds: [],
    evidenceIds: [],
    artifactRefs: [],
    activeLeaseIds: [],
    extensions: [],
    integrity: "f".repeat(64),
  }) as Checkpoint;
}

function evidenceFor(options: {
  readonly taskId: string;
  readonly branchId: string;
  readonly workspaceSnapshotId: string;
  readonly producerKind?: "tool" | "verifier";
  readonly level?: EvidenceRecord["level"];
  readonly contractVersion?: number;
}): EvidenceRecord {
  return evidenceRecordSchema.parse({
    evidenceId: newId("evd"),
    taskId: options.taskId,
    branchId: options.branchId,
    conditionIds: ["cond.unit"],
    level: options.level ?? "E2",
    producer: {
      kind: options.producerKind ?? "verifier",
      id: "verifier.test",
      version: "1.0.0",
    },
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    provenance: {
      provenanceId: newId("prov"),
      sourceKind: "verifier",
      trustLevel: "verified",
      locator: "pnpm test",
      derivedFrom: [],
      invalidatedBy: [],
      observedAt: new Date().toISOString(),
    },
    workspaceSnapshotId: options.workspaceSnapshotId,
    contractId: "contract_x",
    contractVersion: options.contractVersion ?? 1,
    observation: { summary: "12 tests passed", exitCode: 0, truncated: false },
    createdAt: new Date().toISOString(),
    contentHash: "c".repeat(64),
    status: "valid",
    invalidatedBy: [],
  }) as EvidenceRecord;
}

function summaryFor(
  overrides: { readonly branchId: string } & Partial<Omit<BranchSummary, "branchId">>,
): BranchSummary {
  return branchSummarySchema.parse({
    label: `branch ${overrides.branchId.slice(-4)}`,
    outcome: "running",
    tokensUsed: 0,
    retriesUsed: 0,
    wallClockMs: 0,
    changedFileCount: 0,
    changedPaths: [],
    verificationStatus: "unknown",
    residualRiskCount: 0,
    evidenceIds: [],
    ...overrides,
  }) as BranchSummary;
}

function contractFor(taskId: string, projectId: string): OutcomeContract {
  return outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId,
    projectId,
    createdAt: new Date().toISOString(),
    createdBy: "kernel",
    goal: "Fix duplicate session refresh after expiry",
    scope: {
      include: [{ kind: "glob", pattern: "src/auth/**", intent: "write" }],
      exclude: [],
      unknown: [],
    },
    invariants: [],
    completionConditions: [
      {
        conditionId: "cond.unit",
        description: "auth unit tests pass",
        verifier: { kind: "test", id: "verifier.test", version: "1.0.0" },
        minEvidenceLevel: "E2",
        requiresIndependence: false,
        required: true,
      },
    ],
    budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
    autonomy: {
      projectId,
      readPaths: ["**"],
      writePaths: ["src/auth/**"],
      allowedCommands: ["pnpm"],
      allowedHosts: [],
      allowedCredentials: [],
      externalSystems: "none",
      maxReversibility: "reversible",
      untrustedContentEgress: "deny_all",
      budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
      updatedAt: new Date().toISOString(),
      updatedBy: "user",
      widenedBy: [],
    },
    uncertainties: [],
    interventionTriggers: ["ambiguity"],
    exitConditions: [
      { exitId: "exit.budget", kind: "budget_exhausted", description: "token budget exhausted" },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
}

test("checkpoint round-trips through disk and detects tampering", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const taskId = newId("task");
    const branchId = newId("branch");
    const projectId = newId("proj");

    const created = await createCheckpoint(paths, taskId, {
      state: stateFor({ taskId, branchId, projectId }),
      reason: "pre_verification",
      seq: 3,
    });

    const loaded = await loadCheckpoint(paths, taskId, created.checkpointId);
    assert.deepEqual(loaded, created);
    assert.equal(created.integrity.length, 64);

    // Tamper a single field; the digest no longer recomputes.
    const file = paths.checkpointFile(taskId as TaskId, created.checkpointId);
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    parsed["seq"] = 99;
    await writeFile(file, JSON.stringify(parsed));
    await assert.rejects(() => loadCheckpoint(paths, taskId, created.checkpointId), CheckpointIntegrityError);

    // Tamper the digest itself; still refused.
    parsed["seq"] = 3;
    parsed["integrity"] = "0".repeat(64);
    await writeFile(file, JSON.stringify(parsed));
    await assert.rejects(() => loadCheckpoint(paths, taskId, created.checkpointId), CheckpointIntegrityError);

    // A missing checkpoint is undefined, not an error.
    assert.equal(await loadCheckpoint(paths, taskId, newId("ckpt")), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent checkpoint writes are atomic and both remain readable", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const taskId = newId("task");
    const branchId = newId("branch");
    const projectId = newId("proj");
    const state = stateFor({ taskId, branchId, projectId });

    const [first, second] = await Promise.all([
      createCheckpoint(paths, taskId, { state, reason: "periodic", seq: 1 }),
      createCheckpoint(paths, taskId, { state, reason: "pre_branch", seq: 2 }),
    ]);

    const reloadedFirst = await loadCheckpoint(paths, taskId, first.checkpointId);
    const reloadedSecond = await loadCheckpoint(paths, taskId, second.checkpointId);
    assert.ok(reloadedFirst !== undefined);
    assert.ok(reloadedSecond !== undefined);
    assert.notEqual(first.checkpointId, second.checkpointId);

    const all = await listCheckpoints(paths, taskId);
    assert.equal(all.length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("latestCheckpoint picks the highest seq and honours the branch filter", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const taskId = newId("task");
    const projectId = newId("proj");
    const branchA = newId("branch");
    const branchB = newId("branch");

    const a1 = await createCheckpoint(paths, taskId, {
      state: stateFor({ taskId, branchId: branchA, projectId }),
      reason: "periodic",
      seq: 1,
    });
    const a5 = await createCheckpoint(paths, taskId, {
      state: stateFor({ taskId, branchId: branchA, projectId }),
      reason: "stage_boundary",
      seq: 5,
    });
    const b3 = await createCheckpoint(paths, taskId, {
      state: stateFor({ taskId, branchId: branchB, projectId }),
      reason: "pre_verification",
      seq: 3,
    });

    const latest = await latestCheckpoint(paths, taskId);
    assert.equal(latest?.checkpointId, a5.checkpointId);

    const latestB = await latestCheckpoint(paths, taskId, { branchId: branchB });
    assert.equal(latestB?.checkpointId, b3.checkpointId);
    assert.equal(a1.seq, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listCheckpoints reports corrupt files instead of swallowing them", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const taskId = newId("task");
    const projectId = newId("proj");
    const branchId = newId("branch");
    const good = await createCheckpoint(paths, taskId, {
      state: stateFor({ taskId, branchId, projectId }),
      reason: "periodic",
      seq: 1,
    });
    await writeFile(paths.checkpointFile(taskId as TaskId, newId("ckpt") as CheckpointId), "{not json");

    const corrupt: string[] = [];
    const list = await listCheckpoints(paths, taskId, (file) => corrupt.push(file));
    assert.equal(list.length, 1);
    assert.equal(list[0]?.checkpointId, good.checkpointId);
    assert.equal(corrupt.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("branches are created, listed and re-statused", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const taskId = newId("task");
    const contractId = newId("contract");

    const branch = await createBranch(paths, {
      taskId,
      label: "alternative fix",
      reason: "compare two repair paths",
      contractId,
      contractVersion: 1,
      parentCheckpointId: newId("ckpt"),
      forkedFromBranchId: newId("branch"),
    });

    const loaded = await loadBranch(paths, taskId, branch.branchId);
    assert.deepEqual(loaded, branch);
    assert.equal(branch.status, "active");

    // The ledger was touched and is empty, and must not collide with the record.
    const ledgerText = await readFile(paths.branchLedgerFile(taskId as TaskId, branch.branchId), "utf8");
    assert.equal(ledgerText, "");

    const listed = await listBranches(paths, taskId);
    assert.equal(listed.length, 1);

    const merged = await setBranchStatus(paths, taskId, branch.branchId, "merged");
    assert.equal(merged.status, "merged");
    assert.equal((await loadBranch(paths, taskId, branch.branchId))?.status, "merged");

    assert.equal(await loadBranch(paths, taskId, newId("branch")), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("compareBranches prefers proven over a cheaper unsatisfied branch", () => {
  const taskId = newId("task");
  const proven = summaryFor({
    branchId: newId("branch"),
    outcome: "proven",
    verificationStatus: "satisfied",
    tokensUsed: 5000,
    changedFileCount: 3,
  });
  const cheap = summaryFor({
    branchId: newId("branch"),
    outcome: "running",
    verificationStatus: "unsatisfied",
    tokensUsed: 100,
    changedFileCount: 1,
    residualRiskCount: 2,
  });

  const comparison = compareBranches([cheap, proven], { taskId });
  assert.equal(comparison.recommendation?.branchId, proven.branchId);
  // Entries are ordered best-first.
  assert.equal(comparison.entries[0]?.branchId, proven.branchId);

  assert.throws(() => compareBranches([proven]));
  assert.throws(() => compareBranches([cheap, proven]));
});

test("compareBranches ties break on changed files then branch id, deterministically", () => {
  const taskId = newId("task");
  const idA = newId("branch");
  const idB = newId("branch");
  assert.ok(idA < idB, "monotonic ULIDs keep creation order");

  const fewerFilesWins = compareBranches(
    [
      summaryFor({ branchId: idA, changedFileCount: 5, tokensUsed: 10 }),
      summaryFor({ branchId: idB, changedFileCount: 2, tokensUsed: 99 }),
    ],
    { taskId },
  );
  assert.equal(fewerFilesWins.recommendation?.branchId, idB);

  // Full tie on the first five criteria: the lexicographically smaller id wins.
  const inputs = [
    summaryFor({ branchId: idB, changedFileCount: 2, tokensUsed: 10 }),
    summaryFor({ branchId: idA, changedFileCount: 2, tokensUsed: 10 }),
  ];
  const first = compareBranches(inputs, { taskId });
  const second = compareBranches(inputs, { taskId });
  assert.equal(first.recommendation?.branchId, idA);
  assert.deepEqual(first.entries.map((entry) => entry.branchId), second.entries.map((entry) => entry.branchId));
});

test("summarizeBranch judges verification against the contract", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const taskId = newId("task");
    const projectId = newId("proj");
    const branch = await createBranch(paths, {
      taskId,
      label: "main",
      reason: "initial",
      contractId: newId("contract"),
      contractVersion: 1,
    });
    const state = stateFor({ taskId, branchId: branch.branchId, projectId, tokens: 4321 });
    const evidence = [
      evidenceFor({
        taskId,
        branchId: branch.branchId,
        workspaceSnapshotId: newId("snap"),
      }),
    ];

    const summary = summarizeBranch({
      branch,
      state,
      changedPaths: ["src/auth/session.ts"],
      evidence,
      contract: contractFor(taskId, projectId),
    });

    assert.equal(summary.verificationStatus, "satisfied");
    assert.equal(summary.residualRiskCount, 0);
    assert.equal(summary.changedFileCount, 1);
    assert.equal(summary.tokensUsed, 4321);
    assert.equal(summary.outcome, "running");
    assert.deepEqual(summary.evidenceIds, evidence.map((record) => record.evidenceId));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("assessRecovery continues when the workspace matches the checkpoint", () => {
  const taskId = newId("task");
  const branchId = newId("branch");
  const projectId = newId("proj");
  const checkpoint = checkpointFixture({
    taskId,
    branchId,
    projectId,
    workspaceFingerprint: FP,
  });

  const assessment = assessRecovery({ checkpoint, workspaceFingerprint: FP });
  assert.equal(assessment.consistent, true);
  assert.equal(canResume(assessment), true);
  assert.equal(assessment.resumedStatus, checkpoint.state.status);
  assert.equal(assessment.recomputedPlanRequired, false);
  assert.match(describeRecovery(assessment), /can continue/);
});

test("assessRecovery refuses to continue when the workspace changed", () => {
  const taskId = newId("task");
  const branchId = newId("branch");
  const projectId = newId("proj");
  const checkpoint = checkpointFixture({
    taskId,
    branchId,
    projectId,
    workspaceFingerprint: FP,
  });

  const assessment = assessRecovery({
    checkpoint,
    workspaceFingerprint: OTHER_FP,
    changedPaths: ["src/auth/session.ts"],
  });
  assert.equal(assessment.consistent, false);
  assert.equal(canResume(assessment), false);
  assert.equal(assessment.externallyModified, true);
  assert.equal(assessment.resumedStatus, "needs_attention");
  assert.equal(assessment.recomputedPlanRequired, true);
  assert.deepEqual(assessment.changedPaths, ["src/auth/session.ts"]);
  assert.match(describeRecovery(assessment), /Do not resume/);
});

test("a tool fingerprint change invalidates environment-derived evidence", () => {
  const taskId = newId("task");
  const branchId = newId("branch");
  const projectId = newId("proj");
  const snapId = newId("snap");
  const checkpoint = checkpointFixture({
    taskId,
    branchId,
    projectId,
    workspaceFingerprint: FP,
    toolFingerprint: "1".repeat(64),
    dependencyFingerprint: "2".repeat(64),
    workspaceSnapshotId: snapId,
  });
  const evidence = [
    evidenceFor({ taskId, branchId, workspaceSnapshotId: snapId, producerKind: "verifier" }),
    evidenceFor({ taskId, branchId, workspaceSnapshotId: snapId, producerKind: "tool" }),
  ];

  const assessment = assessRecovery({
    checkpoint,
    workspaceFingerprint: FP,
    currentToolFingerprint: "9".repeat(64),
    evidence,
  });

  // The workspace still matches, but the environment moved.
  assert.equal(assessment.consistent, true);
  assert.equal(assessment.recomputedPlanRequired, true);
  for (const record of evidence) {
    assert.ok(assessment.invalidatedEvidenceIds.includes(record.evidenceId));
  }
});

test("assessRecovery refuses a checkpoint whose integrity digest is unusable", () => {
  const taskId = newId("task");
  const branchId = newId("branch");
  const projectId = newId("proj");
  const broken = {
    ...checkpointFixture({ taskId, branchId, projectId, workspaceFingerprint: FP }),
    integrity: "",
  } as unknown as Checkpoint;

  const assessment = assessRecovery({ checkpoint: broken, workspaceFingerprint: FP });
  assert.equal(assessment.consistent, false);
  assert.equal(assessment.resumedStatus, "needs_attention");
  assert.match(assessment.explanation, /integrity digest/);
});
