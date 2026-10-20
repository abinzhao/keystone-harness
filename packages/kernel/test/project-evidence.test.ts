import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  newId,
  nowIso,
  projectFactSchema,
  type BranchId,
  type EvidenceRecord,
  type ProjectFact,
  type ProjectId,
  type Sha256Hex,
  type SourceKind,
  type TaskId,
  type TrustLevel,
} from "@keystone/schemas";

import { resolveKeystonePaths } from "../src/storage/paths.ts";
import { ProjectFactStore, resolveConflict } from "../src/project/model.ts";
import { createProvenance, deriveProvenance } from "../src/provenance/registry.ts";
import { recordEvidence, listEvidence, getEvidence, type RecordEvidenceInput } from "../src/evidence/store.ts";
import { computeWorkspaceInvalidation, invalidateByTrigger } from "../src/evidence/invalidate.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// ProjectFactStore
// ---------------------------------------------------------------------------

interface FactInput {
  readonly projectId: ProjectId;
  readonly factId: string;
  readonly statement: string;
  readonly subjects: readonly string[];
  readonly sourceKind: SourceKind;
  readonly trustLevel: TrustLevel;
  readonly derivedFrom?: readonly string[];
}

function buildFact(input: FactInput): ProjectFact {
  return projectFactSchema.parse({
    factId: input.factId,
    projectId: input.projectId,
    kind: "rule",
    statement: input.statement,
    source: {
      provenanceId: newId("prov"),
      sourceKind: input.sourceKind,
      trustLevel: input.trustLevel,
      locator: "test fixture",
      derivedFrom: [],
      invalidatedBy: [],
      observedAt: nowIso(),
    },
    derivedFrom: input.derivedFrom ?? [],
    invalidatedBy: [],
    status: "active",
    observedAt: nowIso(),
    updatedAt: nowIso(),
    subjects: input.subjects,
  }) as ProjectFact;
}

test("ProjectFactStore indexes by subject and cascades invalidation to derived facts", async () => {
  const dir = await tempDir("keystone-facts-");
  try {
    const paths = resolveKeystonePaths(dir);
    const projectId = newId("proj") as ProjectId;
    const store = new ProjectFactStore(paths, projectId);

    const base = buildFact({
      projectId,
      factId: newId("fact"),
      statement: "auth lives under src/auth",
      subjects: ["src/auth"],
      sourceKind: "repository",
      trustLevel: "observed",
    });
    const derived = buildFact({
      projectId,
      factId: newId("fact"),
      statement: "session refresh is in src/auth/session.ts",
      subjects: ["src/auth/session.ts"],
      sourceKind: "tool",
      trustLevel: "observed",
      derivedFrom: [base.factId],
    });
    await store.upsert(base);
    await store.upsert(derived);

    assert.equal(store.bySubject("src/auth/session.ts").length, 2);
    assert.equal(store.byId(base.factId)?.statement, base.statement);

    const result = await store.invalidate([base.factId], "source_changed");
    assert.deepEqual(result.invalidated, [base.factId]);
    assert.deepEqual(result.cascaded, [derived.factId]);
    assert.equal(store.byId(base.factId)?.status, "invalidated");
    assert.equal(store.byId(derived.factId)?.status, "invalidated");
    assert.ok(store.byId(derived.factId)?.invalidatedBy.includes("source_changed"));

    const reloaded = new ProjectFactStore(paths, projectId);
    await reloaded.load();
    assert.equal(reloaded.byId(derived.factId)?.status, "invalidated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a frozen user rule wins a conflict, and equal-rank conflicts need the user", async () => {
  const dir = await tempDir("keystone-facts-");
  try {
    const paths = resolveKeystonePaths(dir);
    const projectId = newId("proj") as ProjectId;
    const store = new ProjectFactStore(paths, projectId);

    const rule = buildFact({
      projectId,
      factId: newId("fact"),
      statement: "this project uses pnpm",
      subjects: ["package.json"],
      sourceKind: "repository",
      trustLevel: "user_confirmed",
    });
    const observed = buildFact({
      projectId,
      factId: newId("fact"),
      statement: "an npm lockfile is present",
      subjects: ["package.json"],
      sourceKind: "tool",
      trustLevel: "verified",
    });
    await store.upsert(rule);
    await store.upsert(observed);

    // Unfrozen, the repository-sourced rule ranks below the deterministic tool.
    const before = resolveConflict(store.byId(rule.factId)!, store.byId(observed.factId)!);
    assert.equal(before.winner.factId, observed.factId);
    assert.equal(before.requiresUser, false);

    await store.freeze(rule.factId, newId("dec"));
    const after = resolveConflict(store.byId(rule.factId)!, store.byId(observed.factId)!);
    assert.equal(after.winner.factId, rule.factId);
    assert.equal(after.requiresUser, false);

    const toolA = buildFact({
      projectId,
      factId: newId("fact"),
      statement: "tests live in test/a",
      subjects: ["src"],
      sourceKind: "tool",
      trustLevel: "observed",
    });
    const toolB = buildFact({
      projectId,
      factId: newId("fact"),
      statement: "tests live in test/b",
      subjects: ["src"],
      sourceKind: "tool",
      trustLevel: "observed",
    });
    const conflict = resolveConflict(toolA, toolB);
    assert.equal(conflict.requiresUser, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Provenance trust propagation
// ---------------------------------------------------------------------------

test("deriveProvenance never raises trust above its parents", () => {
  const web = createProvenance({
    sourceKind: "web",
    trustLevel: "untrusted",
    locator: "https://example.com/page",
    observedAt: nowIso(),
  });
  const summary = deriveProvenance([web], {
    sourceKind: "model",
    locator: "summary",
    transformation: "summarise",
    trustLevel: "verified",
  });
  assert.equal(summary.trustLevel, "untrusted");
  assert.ok(summary.derivedFrom.includes(web.provenanceId));

  const tool = createProvenance({
    sourceKind: "tool",
    trustLevel: "verified",
    locator: "pnpm test",
    observedAt: nowIso(),
  });
  const capped = deriveProvenance([tool], {
    sourceKind: "model",
    locator: "summary",
    transformation: "summarise",
  });
  assert.equal(capped.trustLevel, "verified");

  const downgraded = deriveProvenance([tool], {
    sourceKind: "model",
    locator: "summary",
    transformation: "summarise",
    trustLevel: "observed",
  });
  assert.equal(downgraded.trustLevel, "observed");
});

// ---------------------------------------------------------------------------
// Evidence recording
// ---------------------------------------------------------------------------

function evidenceInput(
  taskId: TaskId,
  branchId: BranchId,
  producerKind: "tool" | "verifier",
): RecordEvidenceInput {
  return {
    taskId,
    branchId,
    conditionIds: ["cond.tests_pass"],
    level: "E2",
    producer: { kind: producerKind, id: `tool.${producerKind}`, version: "1.0.0" },
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    provenance: createProvenance({
      sourceKind: producerKind,
      trustLevel: "verified",
      locator: "pnpm test",
      observedAt: nowIso(),
    }),
    workspaceSnapshotId: newId("snap"),
    contractId: "contract_x",
    contractVersion: 1,
    observation: { summary: "12 tests passed", command: "pnpm test", exitCode: 0, truncated: false },
  };
}

test("recordEvidence persists records and yields a stable content hash", async () => {
  const dir = await tempDir("keystone-evidence-");
  try {
    const paths = resolveKeystonePaths(dir);
    const taskId = newId("task") as TaskId;
    const branchId = newId("branch") as BranchId;
    const input = evidenceInput(taskId, branchId, "tool");

    const first = await recordEvidence(paths, input);
    const second = await recordEvidence(paths, input);
    assert.equal(first.contentHash, second.contentHash);
    assert.notEqual(first.evidenceId, second.evidenceId);
    assert.equal(first.status, "valid");

    const list = await listEvidence(paths, taskId);
    assert.equal(list.length, 2);

    const found = await getEvidence(paths, taskId, first.evidenceId);
    assert.equal(found?.contentHash, first.contentHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Evidence invalidation
// ---------------------------------------------------------------------------

test("computeWorkspaceInvalidation follows fingerprint and path changes", async () => {
  const dir = await tempDir("keystone-invalidation-");
  try {
    const paths = resolveKeystonePaths(dir);
    const taskId = newId("task") as TaskId;
    const branchId = newId("branch") as BranchId;
    const record = await recordEvidence(paths, evidenceInput(taskId, branchId, "verifier"));

    const same = "a".repeat(64) as Sha256Hex;
    const changed = "b".repeat(64) as Sha256Hex;

    assert.equal(
      computeWorkspaceInvalidation(record, {
        previousFingerprint: same,
        currentFingerprint: same,
        changedPaths: [],
      }),
      "valid",
    );
    assert.equal(
      computeWorkspaceInvalidation(record, {
        previousFingerprint: same,
        currentFingerprint: changed,
        changedPaths: ["src/index.ts"],
      }),
      "invalid",
    );
    assert.equal(
      computeWorkspaceInvalidation(record, {
        previousFingerprint: same,
        currentFingerprint: changed,
        changedPaths: [],
      }),
      "partially_invalid",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalidateByTrigger('verifier_changed') only affects verifier evidence", async () => {
  const dir = await tempDir("keystone-invalidation-");
  try {
    const paths = resolveKeystonePaths(dir);
    const taskId = newId("task") as TaskId;
    const branchId = newId("branch") as BranchId;
    await recordEvidence(paths, evidenceInput(taskId, branchId, "tool"));
    await recordEvidence(paths, evidenceInput(taskId, branchId, "verifier"));

    const records = await listEvidence(paths, taskId);
    const result = invalidateByTrigger(records, "verifier_changed", "verifier upgraded to 2.0.0");

    const verifierRecord = result.find((record) => record.producer.kind === "verifier");
    const toolRecord = result.find((record) => record.producer.kind === "tool");
    assert.equal(verifierRecord?.status, "invalid");
    assert.ok(verifierRecord?.invalidatedBy.includes("verifier_changed"));
    assert.equal(toolRecord?.status, "valid");

    // The caller's original records must not be mutated.
    const originalVerifier = records.find((record) => record.producer.kind === "verifier");
    assert.equal(originalVerifier?.status, "valid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
