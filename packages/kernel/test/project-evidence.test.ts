import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { NotAGitRepositoryError, detectProjectProfile, scanWorkspace } from "../src/project/scan.ts";
import { ProjectFactStore, resolveConflict } from "../src/project/model.ts";
import { createProvenance, deriveProvenance } from "../src/provenance/registry.ts";
import { recordEvidence, listEvidence, getEvidence, type RecordEvidenceInput } from "../src/evidence/store.ts";
import { computeWorkspaceInvalidation, invalidateByTrigger } from "../src/evidence/invalidate.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Keystone Test"]);
}

// ---------------------------------------------------------------------------
// scanWorkspace
// ---------------------------------------------------------------------------

test("scanWorkspace fingerprints a real git work tree and detects changes", async () => {
  const dir = await tempDir("keystone-scan-");
  try {
    await initRepo(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "init"]);

    const clean = await scanWorkspace(dir);
    assert.equal(clean.dirty, false);
    assert.equal(clean.untrackedCount, 0);
    assert.equal(clean.entryCount, 2);
    assert.equal(clean.entriesTruncated, false);
    assert.equal(clean.fingerprint.length, 64);
    assert.notEqual(clean.headCommit, undefined);
    assert.deepEqual(clean.excluded, []);

    await writeFile(join(dir, "src", "index.ts"), "export const x = 2;\n");
    const modified = await scanWorkspace(dir);
    assert.equal(modified.dirty, true);
    assert.notEqual(modified.fingerprint, clean.fingerprint);

    await writeFile(join(dir, "untracked.txt"), "hello\n");
    const withUntracked = await scanWorkspace(dir);
    assert.equal(withUntracked.untrackedCount, 1);
    assert.equal(withUntracked.entryCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanWorkspace refuses a directory that is not a Git repository", async () => {
  const dir = await tempDir("keystone-nogit-");
  try {
    await assert.rejects(() => scanWorkspace(dir), NotAGitRepositoryError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// detectProjectProfile
// ---------------------------------------------------------------------------

test("detectProjectProfile recognises a supported pnpm TypeScript project", async () => {
  const dir = await tempDir("keystone-profile-");
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const profile = await detectProjectProfile(dir, newId("proj") as ProjectId);
    assert.equal(profile.support.status, "supported");
    assert.equal(profile.packageManager, "pnpm");
    assert.ok(profile.languages.includes("typescript"));

    const testCommand = profile.commands.find((command) => command.kind === "test");
    assert.equal(testCommand?.status, "identified");
    assert.equal(testCommand?.command, "pnpm test");
    assert.equal(testCommand?.source, "package.json#scripts.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectProjectProfile marks an absent command as unrecognized without guessing", async () => {
  const dir = await tempDir("keystone-profile-");
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node ." } }));
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const profile = await detectProjectProfile(dir, newId("proj") as ProjectId);
    const testCommand = profile.commands.find((command) => command.kind === "test");
    assert.equal(testCommand?.status, "unrecognized");
    assert.equal(testCommand?.command, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
