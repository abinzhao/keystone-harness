import assert from "node:assert/strict";
import { chmod, lstat, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { getArtifactBytes, KernelSession, loadCheckpoint, putJsonArtifact } from "@keystone/kernel";
import { contentHash, newId, runBindingSchema } from "@keystone/schemas";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { captureRecoveryWorkspace, compareContinuousBranches, continuousBranchViews, forkContinuousBranch } from "../src/continuous-branches.ts";
import { autonomyFor, envelopeFor, FIXED_SESSION, FINISH_ACTION, makeFixture, removeFixture, run, writeAction, BUGGY_SESSION,
  type Fixture } from "./fixture.ts";
import { maintenanceSession } from "../src/collaboration/local-session.ts";
import { removeIsolatedWorkspace } from "../src/isolation.ts";
import { observeWorkspace } from "../src/workspace-observation.ts";

async function removeForkWorkspaces(fixture: Fixture) {
  const worktrees = (await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout;
  for (const line of worktrees.split("\n").filter((line) => line.startsWith("worktree ")).slice(1)) {
    await removeIsolatedWorkspace(fixture.root, line.slice("worktree ".length));
  }
}

async function checkpointFixture(fixture: Fixture, transform?: (capsule: {
  trackedModes?: { path: string; mode: number }[]; changedPaths: string[];
}) => void) {
  const projectId = newId("proj");
  const session = await maintenanceSession(fixture.paths, {
    projectId, workspaceId: projectId, rootPath: fixture.root, name: "Checkpoint modes", status: "available",
  }, { goal: "Restore admitted checkpoint paths", resources: ["src/auth/**"] });
  const observation = await observeWorkspace(fixture.root);
  const captured = await captureRecoveryWorkspace(fixture.paths, fixture.root);
  assert.ok(captured);
  const bytes = await getArtifactBytes(fixture.paths, captured);
  assert.ok(bytes);
  const capsule = JSON.parse(new TextDecoder().decode(bytes));
  transform?.(capsule);
  const artifact = await putJsonArtifact(fixture.paths, capsule);
  const binding = await putJsonArtifact(fixture.paths, runBindingSchema.parse({
    schemaVersion: "keystone.runtime.runBinding@1.0.0", workspacePath: fixture.root, workPath: fixture.root,
    mode: "standard", request: "Restore admitted checkpoint paths", baselineFingerprint: observation.fingerprint,
    baselineFiles: [...observation.files].map(([path, hash]) => ({ path, hash })),
    baselineDirtyPaths: capsule.changedPaths, maxSteps: 1, executionFingerprint: contentHash({ fixture: "modes" }),
  }));
  const checkpoint = await session.checkpoint("pre_branch", {
    artifactRefs: [artifact.artifactId, binding.artifactId],
    verification: { workspaceFingerprint: observation.fingerprint as never },
  });
  return { session, checkpoint, capsule, observation };
}

test("modified tracked 0600 source restores exact checkpoint content, index and mode", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await makeFixture();
  try {
    await chmod(join(fixture.root, "src/auth/session.js"), 0o644);
    const descriptor = scriptedModelDescriptor({ id: "mode-builder" });
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor, responses: [
        envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]), envelopeFor([FINISH_ACTION]),
      ] }),
    ] });
    const result = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }], autonomy: autonomyFor(["src/auth/**"]),
      acceptContractAutomatically: true, maxSteps: 2 });
    assert.equal(result.status, "proven");
    const source = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const action = source.events().find((event) => event.type === "action.executed");
    assert.ok(action);
    const event = source.events().find((event) => event.type === "checkpoint.created" && event.seq > action.seq);
    assert.ok(event, "select the executable checkpoint after the real atomic tool write");
    const checkpoint = await loadCheckpoint(fixture.paths, result.taskId, String(event.payload.checkpointId));
    assert.ok(checkpoint);
    const values = await Promise.all(checkpoint.artifactRefs.map(async (ref) => {
      const bytes = await getArtifactBytes(fixture.paths, ref);
      assert.ok(bytes);
      return JSON.parse(new TextDecoder().decode(bytes));
    }));
    const capsule = values.find((value) => value.version === "keystone.workspace-recovery/1");
    assert.ok(capsule);
    assert.deepEqual(capsule.changedPaths, ["src/auth/session.js"]);
    assert.deepEqual(capsule.trackedModes, [{ path: "src/auth/session.js", mode: 0o600 }]);
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), FIXED_SESSION);
    assert.equal((await lstat(join(fixture.root, "src/auth/session.js"))).mode & 0o777, 0o600);
    const before = await observeWorkspace(fixture.root);
    const ledger = await readFile(fixture.paths.ledgerFile(result.taskId));
    const index = (await run("git", ["ls-files", "-s", "-z"], { cwd: fixture.root })).stdout;
    const branch = await forkContinuousBranch(fixture.paths, result.taskId, {
      checkpointId: checkpoint.checkpointId, label: "exact tracked modes",
    });
    const workspace = branch.workspacePath;
    assert.ok(workspace);
    assert.equal(await readFile(join(workspace, "src/auth/session.js"), "utf8"), FIXED_SESSION);
    assert.equal((await lstat(join(workspace, "src/auth/session.js"))).mode & 0o777, 0o600);
    assert.equal((await run("git", ["ls-files", "-s", "-z"], { cwd: workspace })).stdout, index);
    const restored = await observeWorkspace(workspace);
    assert.deepEqual([...restored.files], capsule.observedFiles);
    assert.equal(restored.fingerprint, contentHash({ files: capsule.observedFiles, head: capsule.head, branch: "" }));
    const fork = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId, branchId: branch.branchId });
    assert.equal((await fork.latestCheckpoint())?.verification.workspaceFingerprint, restored.fingerprint);
    assert.equal(fork.replay().consistent, true);
    assert.equal(fork.state().activeLeaseIds.length, 0);
    const lease = fork.events().find((event) => event.type === "lease.issued" && event.seq > checkpoint.seq &&
      event.payload.capability === "fs.write");
    assert.ok(lease);
    assert.deepEqual(lease.payload.resource, { kind: "paths", mode: "write", values: ["src/auth/session.js"] });
    assert.equal((lease.payload.constraints as { parametersHash: string }).parametersHash, contentHash({
      checkpointId: checkpoint.checkpointId, capsuleHash: contentHash(capsule), label: "exact tracked modes",
    }));
    assert.ok(fork.events().some((event) => event.type === "lease.consumed" &&
      event.payload.leaseId === lease.payload.leaseId));
    assert.deepEqual(await readFile(fixture.paths.ledgerFile(result.taskId)), ledger);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
  } finally {
    await removeForkWorkspaces(fixture);
    await removeFixture(fixture);
  }
});

for (const mode of [0o644, 0o600]) {
  test(`legacy capsule without tracked modes ${mode === 0o644 ? "restores exact" : "refuses mismatched"} permissions`, {
    skip: process.platform === "win32",
  }, async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.root, "src/auth/session.js"), FIXED_SESSION);
      await chmod(join(fixture.root, "src/auth/session.js"), mode);
      const { session, checkpoint, observation } = await checkpointFixture(fixture, (capsule) => {
        delete capsule.trackedModes;
      });
      const fork = () => forkContinuousBranch(fixture.paths, session.taskId, {
        checkpointId: checkpoint.checkpointId, label: "legacy modes",
      });
      if (mode === 0o600) {
        await assert.rejects(fork, /restored checkpoint workspace does not match/);
      } else {
        const branch = await fork();
        assert.ok(branch.workspacePath);
        assert.deepEqual([...(await observeWorkspace(branch.workspacePath)).files], [...observation.files]);
      }
      assert.equal((await observeWorkspace(fixture.root)).fingerprint, observation.fingerprint);
    } finally {
      await removeForkWorkspaces(fixture);
      await removeFixture(fixture);
    }
  });
}

test("mode-only changes absent from admitted Git paths remain fail-closed", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await makeFixture();
  try {
    await chmod(join(fixture.root, "src/auth/session.js"), 0o600);
    const { session, checkpoint, capsule, observation } = await checkpointFixture(fixture);
    assert.deepEqual(capsule.changedPaths, []);
    assert.deepEqual(capsule.trackedModes, []);
    await assert.rejects(() => forkContinuousBranch(fixture.paths, session.taskId, {
      checkpointId: checkpoint.checkpointId, label: "clean-path mode mismatch",
    }), /restored checkpoint workspace does not match/);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, observation.fingerprint);
    assert.equal((await lstat(join(fixture.root, "src/auth/session.js"))).mode & 0o777, 0o600);
  } finally {
    await removeForkWorkspaces(fixture);
    await removeFixture(fixture);
  }
});

test("mode metadata cannot admit clean paths or bypass task write scope", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, "src/auth/session.js"), FIXED_SESSION);
    await chmod(join(fixture.root, "src/auth/session.js"), 0o600);
    const clean = await checkpointFixture(fixture, (capsule) => {
      capsule.trackedModes!.push({ path: "test/session.test.js", mode: 0o600 });
    });
    await assert.rejects(() => forkContinuousBranch(fixture.paths, clean.session.taskId, {
      checkpointId: clean.checkpoint.checkpointId, label: "unadmitted mode",
    }), /unadmitted capsule tracked mode/);
    await writeFile(join(fixture.root, "test/session.test.js"), "// unrelated dirty test\n");
    await chmod(join(fixture.root, "test/session.test.js"), 0o600);
    const outside = await checkpointFixture(fixture);
    await assert.rejects(() => forkContinuousBranch(fixture.paths, outside.session.taskId, {
      checkpointId: outside.checkpoint.checkpointId, label: "outside mode",
    }), /outside the project's write boundary/);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, outside.observation.fingerprint);
    assert.equal((await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout
      .split("\n").filter((line) => line.startsWith("worktree ")).length, 1, "refuse before workspace creation");
  } finally {
    await removeForkWorkspaces(fixture);
    await removeFixture(fixture);
  }
});

test("tracked mode capture excludes deleted files and symlinks while their patch restores exactly", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, "src/auth/obsolete.js"), "// obsolete\n");
    await symlink("session.js", join(fixture.root, "src/auth/link.js"));
    await run("git", ["add", "."], { cwd: fixture.root });
    await run("git", ["commit", "-q", "-m", "mode edge fixture"], { cwd: fixture.root });
    await rm(join(fixture.root, "src/auth/obsolete.js"));
    await rm(join(fixture.root, "src/auth/link.js"));
    await symlink("../../package.json", join(fixture.root, "src/auth/link.js"));
    await writeFile(join(fixture.root, "src/auth/session.js"), FIXED_SESSION);
    await chmod(join(fixture.root, "src/auth/session.js"), 0o600);
    const { session, checkpoint, capsule, observation } = await checkpointFixture(fixture);
    assert.deepEqual(capsule.trackedModes, [{ path: "src/auth/session.js", mode: 0o600 }]);
    const branch = await forkContinuousBranch(fixture.paths, session.taskId, {
      checkpointId: checkpoint.checkpointId, label: "deleted and symlink paths",
    });
    assert.ok(branch.workspacePath);
    await assert.rejects(lstat(join(branch.workspacePath, "src/auth/obsolete.js")), { code: "ENOENT" });
    assert.equal(await readlink(join(branch.workspacePath, "src/auth/link.js")), "../../package.json");
    assert.deepEqual([...(await observeWorkspace(branch.workspacePath)).files], [...observation.files]);
    assert.equal((await run("git", ["ls-files", "-s", "-z"], { cwd: branch.workspacePath })).stdout,
      (await run("git", ["ls-files", "-s", "-z"], { cwd: fixture.root })).stdout);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, observation.fingerprint);
  } finally {
    await removeForkWorkspaces(fixture);
    await removeFixture(fixture);
  }
});

for (const parent of [false, true]) {
  test(`tracked mode restore refuses a symlink ${parent ? "parent" : "target"} without changing its referent`, {
    skip: process.platform === "win32",
  }, async () => {
    const fixture = await makeFixture();
    try {
      await chmod(join(fixture.root, "package.json"), 0o644);
      await symlink(parent ? "../.." : "../../package.json", join(fixture.root, "src/auth/link"));
      await run("git", ["add", "."], { cwd: fixture.root });
      await run("git", ["commit", "-q", "-m", "symlink mode refusal fixture"], { cwd: fixture.root });
      const path = `src/auth/link${parent ? "/package.json" : ""}`;
      const { session, checkpoint, observation } = await checkpointFixture(fixture, (capsule) => {
        capsule.changedPaths.push(path);
        capsule.trackedModes!.push({ path, mode: 0o600 });
      });
      await assert.rejects(() => forkContinuousBranch(fixture.paths, session.taskId, {
        checkpointId: checkpoint.checkpointId, label: "symlink mode refused",
      }), parent ? /cannot traverse a non-directory/ : /requires a regular file/);
      assert.equal((await lstat(join(fixture.root, "package.json"))).mode & 0o777, 0o644);
      const worktrees = (await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout;
      const workspace = worktrees.split("\n").filter((line) => line.startsWith("worktree "))[1]!.slice("worktree ".length);
      assert.equal((await lstat(join(workspace, "package.json"))).mode & 0o777, 0o644);
      assert.equal((await observeWorkspace(fixture.root)).fingerprint, observation.fingerprint);
    } finally {
      await removeForkWorkspaces(fixture);
      await removeFixture(fixture);
    }
  });
}

test("historical workspace forks independently and earns fresh branch proof", async () => {
  const fixture = await makeFixture();
  let workspace: string | undefined;
  try {
    const descriptor = scriptedModelDescriptor({ id: "builder" });
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor, responses: [envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]), envelopeFor([FINISH_ACTION])] }),
    ] });
    const result = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }], autonomy: autonomyFor(["src/auth/**"]),
      acceptContractAutomatically: true });
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const checkpoint = session.events().find((event) => event.type === "checkpoint.created");
    assert.ok(checkpoint);
    const branch = await forkContinuousBranch(fixture.paths, result.taskId, {
      checkpointId: String(checkpoint.payload.checkpointId), label: "historical" });
    workspace = branch.workspacePath;
    assert.ok(workspace);
    assert.equal(await readFile(join(workspace, "src/auth/session.js"), "utf8"), BUGGY_SESSION);
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), FIXED_SESSION);
    const branchRuntime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor, responses: [envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]), envelopeFor([FINISH_ACTION])] }),
    ] });
    const resumed = await branchRuntime.resumeTask(result.taskId, {}, branch.branchId);
    assert.equal(resumed.status, "proven");
    const fork = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId, branchId: branch.branchId });
    assert.ok((await fork.evidence()).length > 0);
    assert.ok((await fork.evidence()).every((record) => record.branchId === branch.branchId));
    const comparison = await compareContinuousBranches(fixture.paths, result.taskId, session.branchId, branch.branchId);
    assert.equal(comparison.entries.length, 2);
    const view = (await continuousBranchViews(fixture.paths, result.taskId)).find((row) => row.branchId === branch.branchId) as any;
    assert.equal(view.contract.contractId, fork.contract()?.contractId);
    assert.equal(view.proof.branchId, branch.branchId);
    assert.equal(view.proof.outcome, "proven");
    await writeFile(join(workspace, "src/auth/session.js"), `${FIXED_SESSION}\n// changed after verification\n`);
    const changed = (await continuousBranchViews(fixture.paths, result.taskId)).find((row) => row.branchId === branch.branchId)!;
    assert.equal(changed.status, "proven", "historical completion remains in the ledger");
    assert.equal(changed.proof.outcome, "not_proven");
    assert.notEqual(changed.summary.outcome, "proven", "current ranking must reject stale completion");
    assert.notEqual(changed.summary.verificationStatus, "satisfied");
    assert.ok(changed.summary.residualRiskCount > 0);
    const current = await compareContinuousBranches(fixture.paths, result.taskId, session.branchId, branch.branchId);
    assert.ok(current.recommendation);
    assert.equal(current.recommendation.branchId, session.branchId);
    assert.equal(current.proof.find((row) => row.branchId === branch.branchId)?.outcome, "not_proven");
    await removeIsolatedWorkspace(fixture.root, workspace); workspace = undefined;
    const unavailable = await compareContinuousBranches(fixture.paths, result.taskId, session.branchId, branch.branchId);
    assert.ok(unavailable.recommendation);
    assert.equal(unavailable.recommendation.branchId, session.branchId);
    assert.equal(unavailable.proof.find((row) => row.branchId === branch.branchId)?.outcome, "not_proven");
  } finally {
    if (workspace) await removeIsolatedWorkspace(fixture.root, workspace);
    await removeFixture(fixture);
  }
});
