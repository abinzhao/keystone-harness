import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KernelSession } from "@keystone/kernel";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { compareContinuousBranches, continuousBranchViews, forkContinuousBranch } from "../src/continuous-branches.ts";
import { autonomyFor, envelopeFor, FIXED_SESSION, FINISH_ACTION, makeFixture, removeFixture, writeAction, BUGGY_SESSION } from "./fixture.ts";
import { removeIsolatedWorkspace } from "../src/isolation.ts";

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
