import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { KernelSession } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { compileContract, detectProjectProfile } from "@keystone/pack-engineering";
import { newId } from "@keystone/schemas";
import { autonomyFor, FINISH_ACTION, makeFixture, removeFixture } from "./fixture.ts";

test("explicit analysis compiles read scope without inventing modification tests", async () => {
  const fixture = await makeFixture();
  try {
    const profile = await detectProjectProfile(fixture.root, newId("proj") as never);
    const result = compileContract({
      taskId: newId("task"), projectId: profile.projectId, request: "Explain the refresh bug",
      taskIntent: "analysis", profile, autonomy: autonomyFor([]),
      references: [{ kind: "file", value: "src/auth/session.js" }],
    } as Parameters<typeof compileContract>[0]);
    assert.equal(result.contract.status, "ready");
    assert.ok(result.contract.scope.include.every(s => s.intent === "read"));
    assert.equal(result.contract.completionConditions.some(c => c.verifier.kind === "test"), false);
    assert.equal(result.questions.length, 0);
  } finally { await removeFixture(fixture); }
});

test("public analysis answer is durable but can never declare engineering proof", async () => {
  const fixture = await makeFixture();
  try {
    const answer = "Two increments in `src/auth/session.js:4-5` cause duplicate refreshes.";
    const adapter = createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "analysis-fixture" }),
      responses: [JSON.stringify({ summary: "Analysis", answer, actions: [FINISH_ACTION] })],
    });
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [adapter], mode: "standard" });
    const original = await readFile(`${fixture.root}/src/auth/session.js`, "utf8");
    const result = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain this code", taskIntent: "analysis",
      autonomy: autonomyFor([]), maxSteps: 2,
    } as Parameters<typeof runtime.runTask>[0]);
    assert.equal(result.status, "exited_gracefully");
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId as never });
    const response = session.events().find(e => e.type === ("model.response_recorded" as never));
    assert.equal(response?.payload["text"], answer);
    assert.equal(response?.payload["trustLevel"], "untrusted");
    assert.equal(session.events().some(e => e.type === "proof.satisfied"), false);
    assert.match(session.state().exitReason ?? "", /analysis|unverified/i);
    const evidence = await session.evidence();
    assert.equal(evidence.find(record => record.conditionIds.includes("cond.scope_check"))?.status, "valid");
    assert.equal(await readFile(`${fixture.root}/src/auth/session.js`, "utf8"), original);
  } finally { await removeFixture(fixture); }
});
