import assert from "node:assert/strict";
import test from "node:test";

import { KernelSession, projectIdForWorkspace } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { createLocalCollaboration, previewBundle } from "../src/collaboration/index.ts";
import { rejectRunEventSecrets } from "../src/collaboration/signatures.ts";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import {
  FIXED_SESSION,
  FINISH_ACTION,
  autonomyFor,
  envelopeFor,
  makeFixture,
  removeFixture,
  writeAction,
} from "./fixture.ts";

test("a real runtime task exports recovery sources only after explicit opt-in and imports as a fresh draft", async () => {
  const fixture = await makeFixture();
  const projectId = await projectIdForWorkspace(fixture.root);
  const runtime = await KeystoneRuntime.create({
    paths: fixture.paths,
    models: [createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "portable-source" }),
      responses: [
        envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
        envelopeFor([FINISH_ACTION]),
      ],
    })],
  });
  const source = await runtime.runTask({
    workspacePath: fixture.root,
    request: "fix src/auth/session.js",
    references: [{ kind: "file", value: "src/auth/session.js" }],
    autonomy: autonomyFor(["src/auth/**"]),
    acceptContractAutomatically: true,
    maxSteps: 2,
  });
  const projects = [{
    projectId,
    workspaceId: projectId,
    rootPath: fixture.root,
    name: "Fixture",
    status: "available",
    tasks: [source.taskId],
  }];
  const local = createLocalCollaboration({
    paths: () => fixture.paths,
    projects: async () => projects,
  });
  const call = (path: string, body?: unknown) =>
    local.service.handle(body === undefined ? "GET" : "POST", `/v1/collaboration${path}`, body, {
      authenticated: true,
      source: "local_ui",
    });
  try {
    const sourceSession = await KernelSession.open({ paths: fixture.paths, taskId: source.taskId });
    for (const event of sourceSession.events()) {
      assert.doesNotThrow(() => rejectRunEventSecrets(event),
        `ordinary ${event.type} event must remain portable`);
    }
    const refused = await call("/export", {
      projectId,
      taskId: source.taskId,
      confirmed: true,
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.reason, /capsule|recovery/i);

    const exported = await call("/export", {
      projectId,
      taskId: source.taskId,
      includeRecoveryWorkspace: true,
      confirmed: true,
    });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.includesRecoveryWorkspace, true);
    const preview = await previewBundle(exported.body.root);
    assert.equal(preview.taskId, source.taskId);
    assert.ok(preview.artifacts.length > 0);

    const imported = await call("/import", {
      projectId,
      root: exported.body.root,
      digest: preview.digest,
      confirmed: true,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const adopted = await call("/adopt-task", {
      projectId,
      importId: imported.body.importId,
      digest: preview.digest,
      request: "independently review imported runtime work",
      confirmed: true,
    });
    assert.equal(adopted.status, 200);
    assert.notEqual(adopted.body.taskId, source.taskId);
    const draft = await KernelSession.open({ paths: fixture.paths, taskId: adopted.body.taskId });
    assert.equal(draft.state().status, "draft");
    assert.equal(draft.events().some((event) => event.type === "evidence.recorded" || event.type.startsWith("proof.")), false);
  } finally {
    await local.dispose();
    await removeFixture(fixture);
  }
});
