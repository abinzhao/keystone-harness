import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { KernelSession } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { autonomyFor, envelopeFor, FIXED_SESSION, FINISH_ACTION, makeFixture, removeFixture, writeAction } from "./fixture.ts";

test("resume re-enters the builder with the same task and preserves applied writes", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }), responses: [envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)])] }),
    ] });
    const paused = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }],
      autonomy: autonomyFor(["src/auth/**"]), acceptContractAutomatically: true,
      control: async () => (await readFile(join(fixture.root, "src/auth/session.js"), "utf8")) === FIXED_SESSION
        ? { kind: "pause", reason: "restart fixture" } : undefined });
    assert.equal(paused.status, "paused");
    const resumedRuntime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }), responses: [envelopeFor([FINISH_ACTION])] }),
    ] });
    const resumed = await resumedRuntime.resumeTask(paused.taskId);
    assert.equal(resumed.taskId, paused.taskId);
    assert.equal(resumed.status, "proven");
    assert.deepEqual(resumed.changedPaths, ["src/auth/session.js"]);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    assert.equal(session.events().filter((event) => event.type === "action.executed" &&
      (event.payload["changedPaths"] as string[]).includes("src/auth/session.js")).length, 1);
    assert.ok(session.events().some((event) => event.type === "recovery.verified"));
  } finally { await removeFixture(fixture); }
});

test("resume rejects changed workspace before authorizing any continuation", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }), responses: [envelopeFor([FINISH_ACTION])] }),
    ] });
    const paused = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }],
      autonomy: autonomyFor(["src/auth/**"]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "check fingerprint" }) });
    await writeFile(join(fixture.root, "src/auth/session.js"), "external edit");
    await assert.rejects(runtime.resumeTask(paused.taskId), /workspace.*changed/);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    assert.equal(session.state().status, "paused");
  } finally { await removeFixture(fixture); }
});
