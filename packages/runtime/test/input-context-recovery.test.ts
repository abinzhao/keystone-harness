import assert from "node:assert/strict";
import test from "node:test";
import { KernelSession } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { AttachmentStore } from "../src/attachments.ts";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { autonomyFor, envelopeFor, FINISH_ACTION, makeFixture, removeFixture } from "./fixture.ts";

test("recorded text attachments are restored and budgeted in resumed Context Plans", async () => {
  const fixture = await makeFixture();
  try {
    const model = () => createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }),
      responses: [envelopeFor([FINISH_ACTION])] });
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [model()] });
    const project = await runtime.attachProject(fixture.root);
    const store = new AttachmentStore(fixture.paths);
    const attachment = await store.import({ projectId: project.projectId, name: "context.md",
      mimeType: "text/markdown", data: Buffer.from("Explicit task input fixture").toString("base64") });
    const paused = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }], autonomy: autonomyFor(["src/auth/**"]),
      attachments: [attachment], attachmentParts: await store.parts([attachment]),
      acceptContractAutomatically: true, control: async () => ({ kind: "pause", reason: "input recovery" }) });
    assert.equal(paused.status, "paused");
    // Removal affects future selection, not the immutable inputs to a recorded task.
    await store.remove(attachment.attachmentId);
    const resumed = await KeystoneRuntime.create({ paths: fixture.paths, models: [model()] });
    await resumed.resumeTask(paused.taskId);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    const plan = session.events().find((event) => event.type === "context.plan_created")?.payload;
    assert.ok(plan);
    assert.ok((plan.items as { ref: string; source: { trustLevel: string } }[])
      .some((item) => item.ref === "task-input:0" && item.source.trustLevel === "untrusted"));
    assert.ok(Number(plan.tokensUsed) <= Number(plan.tokenBudget));
  } finally { await removeFixture(fixture); }
});

test("oversized explicit task input pauses before a model invocation", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }), responses: [envelopeFor([FINISH_ACTION])] }),
    ] });
    const result = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }], autonomy: autonomyFor(["src/auth/**"]),
      attachmentParts: [{ type: "text", text: "x".repeat(200_000) }], tokenBudgetPerStep: 5000,
      acceptContractAutomatically: true });
    assert.equal(result.status, "paused");
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    assert.equal(session.events().filter((event) => event.type === "lease.issued" && event.payload.capability === "model.invoke").length, 0);
  } finally { await removeFixture(fixture); }
});
