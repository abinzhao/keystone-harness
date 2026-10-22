import assert from "node:assert/strict";
import test from "node:test";
import { getSchema, newId, nowIso, provenanceIdValidator, snapshotIdValidator } from "@keystone/schemas";
import { KernelSession } from "../src/kernel.ts";
import { compileContract, detectProjectProfile } from "../../pack-engineering/src/index.ts";
import { autonomyFor, makeFixture, removeFixture } from "../../runtime/test/fixture.ts";

test("model response observation has a fixed untrusted schema and cannot impersonate proof", () => {
  const schema = getSchema("keystone.event.modelResponse");
  assert.ok(schema, "a model response needs a registered observation schema");
  const response = {
    stepId: "step.1", modelId: "fixture", provider: "scripted", modelName: "fixture",
    text: "Public answer", trustLevel: "untrusted", artifactId: "fixture-artifact",
    contentHash: "a".repeat(64),
  };
  assert.doesNotThrow(() => schema.parse(response));
  assert.throws(() => schema.parse({ ...response, trustLevel: "verified" }));
});

test("kernel-recorded answer survives reopening without changing permissions or status", async () => {
  const fixture = await makeFixture();
  try {
    const session = await KernelSession.create({
      paths: fixture.paths, projectId: newId("proj") as never,
      request: "Explain the code", taskIntent: "analysis", proposeContract: compileContract,
    } as Parameters<typeof KernelSession.create>[0]);
    await session.submit();
    await session.compile({ profile: await detectProjectProfile(fixture.root, session.projectId), autonomy: autonomyFor([]) });
    await session.start();
    const before = session.state();
    assert.equal(typeof (session as any).recordModelResponse, "function");
    await (session as any).recordModelResponse({
      stepId: "step.1", modelId: "fixture", provider: "scripted", modelName: "fixture",
      text: "The observed code schedules two refreshes.",
    });
    const reopened = await KernelSession.open({ paths: fixture.paths, taskId: session.taskId });
    assert.equal((reopened as any).taskIntent(), "analysis");
    assert.equal(reopened.state().status, before.status);
    assert.deepEqual(reopened.state().activeLeaseIds, before.activeLeaseIds);
    assert.deepEqual(reopened.state().outstandingEvidence, before.outstandingEvidence);
    assert.equal(reopened.events().some(e => e.type === "proof.satisfied"), false);
    const event = reopened.events().find(e => e.type === ("model.response_recorded" as never));
    assert.equal(event?.payload["trustLevel"], "untrusted");
    assert.equal(event?.payload["text"], "The observed code schedules two refreshes.");
    assert.ok(event?.payload["artifactId"]);
    await reopened.stop("test complete");
    await assert.rejects((reopened as any).recordModelResponse({
      stepId: "step.2", modelId: "fixture", provider: "scripted", modelName: "fixture", text: "late answer",
    }));
  } finally { await removeFixture(fixture); }
});

test("passing independent workspace evidence cannot prove recorded analysis or its exported package", async () => {
  const fixture = await makeFixture();
  try {
    const session = await KernelSession.create({
      paths: fixture.paths, projectId: newId("proj") as never,
      request: "Explain the code", taskIntent: "analysis", proposeContract: compileContract,
    });
    await session.submit();
    await session.compile({ profile: await detectProjectProfile(fixture.root, session.projectId), autonomy: autonomyFor([]) });
    await session.start();
    const contract = session.contract()!;
    const snapshot = snapshotIdValidator.parse(newId("snap")), fingerprint = "b".repeat(64);
    for (const condition of contract.completionConditions) {
      await session.recordEvidence({
        conditionIds: [condition.conditionId], level: "E2",
        producer: { kind: "verifier", id: condition.verifier.id, version: condition.verifier.version },
        independence: { mode: "separate_process", independentOf: ["builder_loop_process"], environmentFingerprint: fingerprint },
        provenance: { provenanceId: provenanceIdValidator.parse(newId("prov")), sourceKind: "verifier", locator: condition.verifier.id, trustLevel: "verified",
          observedAt: nowIso(), applicableSnapshot: snapshot, derivedFrom: [], invalidatedBy: [] },
        workspaceSnapshotId: snapshot,
        observation: { summary: "Workspace unchanged", truncated: false },
      });
    }
    const options = { changedPaths: [], workspaceFingerprint: fingerprint };
    const exportedBefore = await session.exportProof(options);
    assert.equal(exportedBefore.outcome, "not_proven");
    assert.ok(exportedBefore.conditions.every(condition => condition.satisfied), "workspace conditions still truthfully pass");
    assert.ok(exportedBefore.unverified.some(reason => /analysis.*unverified/i.test(reason)));
    const result = await session.evaluateProof(options);
    assert.equal(result.decision.outcome, "not_proven");
    assert.equal(session.events().some(event => event.type === "proof.satisfied"), false);
    assert.notEqual(session.state().status, "proven");
    const reopened = await KernelSession.open({ paths: fixture.paths, taskId: session.taskId });
    assert.equal(reopened.replay().consistent, true);
    const exportedAfter = await reopened.exportProof(options);
    assert.equal(exportedAfter.outcome, "not_proven");
    assert.equal(exportedAfter.proofGraphHash, exportedBefore.proofGraphHash);
  } finally { await removeFixture(fixture); }
});
