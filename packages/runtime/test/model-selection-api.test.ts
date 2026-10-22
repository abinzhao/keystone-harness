import assert from "node:assert/strict";
import test from "node:test";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KernelSession } from "@keystone/kernel";
import { contentHash } from "@keystone/schemas";
import { startServer } from "../src/server.ts";
import { FINISH_ACTION, makeFixture, removeFixture } from "./fixture.ts";

test("selected model and analysis intent are bound before a task starts", async () => {
  const fixture = await makeFixture();
  const models = ["first", "second"].map(id => createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id }),
    responses: [JSON.stringify({ summary: `Answer from ${id}`, answer: `Selected ${id}`, actions: [FINISH_ACTION] })],
  }));
  const server = await startServer({ paths: fixture.paths, models, token: "model-selection-test" });
  const request = async (path: string, body?: unknown) => fetch(`${server.url}${path}`, {
    headers: { authorization: "Bearer model-selection-test", "content-type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  try {
    const started = await request("v1/tasks", {
      workspacePath: fixture.root, request: "Explain the code", taskIntent: "analysis", modelId: "second",
    });
    assert.equal(started.status, 202);
    const { taskId } = await started.json() as { taskId: string };
    let detail: any;
    for (let i = 0; i < 100; i++) {
      detail = await (await request(`v1/tasks/${taskId}`)).json();
      if (["exited_gracefully", "failed", "needs_attention"].includes(detail.status)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(detail.taskIntent, "analysis");
    assert.equal(detail.status, "exited_gracefully");
    assert.equal(detail.configurationSnapshot.builderModelId, "second");
    assert.equal(detail.messages.at(-1).text, "Selected second");
    assert.equal(detail.messages.at(-1).modelId, "second");
    assert.equal(detail.messages.at(-1).trustLevel, "untrusted");
    const unknown = await request("v1/tasks", {
      workspacePath: fixture.root, request: "Explain the code", taskIntent: "analysis", modelId: "missing",
    });
    assert.equal(unknown.status, 400);
  } finally { await server.close(); await removeFixture(fixture); }
});

test("analysis cannot smuggle a writable scope through task creation", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths, token: "analysis-scope-test" });
  try {
    const response = await fetch(`${server.url}v1/tasks`, {
      method: "POST", headers: { authorization: "Bearer analysis-scope-test", "content-type": "application/json" },
      body: JSON.stringify({ workspacePath: fixture.root, request: "Read", taskIntent: "analysis", writePaths: ["src/**"] }),
    });
    assert.equal(response.status, 400);
  } finally { await server.close(); await removeFixture(fixture); }
});

test("selected CLI transport outside the default route retains its task permission", async () => {
  const fixture = await makeFixture();
  const permission = { subjectId: "fixture.selected-cli", executable: "fixture-cli", argvPrefix: ["-p"] };
  const originalPermission = structuredClone(permission);
  const defaultModel = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "default" }), responses: ["unused default response"],
  });
  const selected = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "selected-cli" }),
    responses: [JSON.stringify({ summary: "Transport admitted", answer: "Selected CLI", actions: [FINISH_ACTION] })],
  });
  let admitted = 0;
  const server = await startServer({
    paths: fixture.paths, token: "selected-transport-test", interventionTimeoutMs: 100,
    routes: { builder: ["default"], planner: ["default"], summarizer: ["default"] },
    models: [defaultModel, {
      descriptor: { ...selected.descriptor, protocol: "trae-cli-exec" },
      transportPermission: permission,
      async complete(request) {
        // A later registration mutation must not rewrite the admitted contract.
        permission.executable = "replacement-cli";
        permission.argvPrefix.push("--changed");
        assert.ok(request.authorizeTransport);
        const parameters = {
          command: originalPermission.executable, args: ["-p", "fixture prompt"], cwd: fixture.home,
          timeoutMs: 1000, maxOutputBytes: 1024,
        };
        const lease = await request.authorizeTransport({
          subject: { kind: "extension", id: originalPermission.subjectId }, capability: "cmd.exec",
          resource: { kind: "command", values: [originalPermission.executable], mode: "execute" },
          parameters, parametersHash: contentHash(parameters),
        });
        assert.equal(lease.subject.id, originalPermission.subjectId);
        assert.deepEqual(lease.resource.values, [originalPermission.executable]);
        admitted++;
        return selected.complete(request);
      },
    }],
  });
  const headers = { authorization: "Bearer selected-transport-test", "content-type": "application/json" };
  try {
    const started = await fetch(`${server.url}v1/tasks`, {
      method: "POST", headers,
      body: JSON.stringify({
        workspacePath: fixture.root, request: "Explain the code", taskIntent: "analysis", modelId: "selected-cli",
      }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    const { taskId } = await started.json() as { taskId: string };
    for (let i = 0; i < 200; i++) {
      const run = await (await fetch(`${server.url}v1/tasks/${taskId}/run`, { headers })).json() as { status: string };
      if (run.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const session = await KernelSession.open({ paths: fixture.paths, taskId: taskId as never });
    assert.deepEqual(session.contract()?.autonomy.modelTransports, [originalPermission],
      "selection must grant the registered transport even when the default route omits it");
    assert.equal(session.state().status, "exited_gracefully");
    assert.equal(admitted, 1);
    assert.equal(defaultModel.callCount(), 0);
    assert.ok(session.events().some(event => event.type === "lease.issued" &&
      (event.payload["subject"] as { id: string } | undefined)?.id === originalPermission.subjectId));
  } finally { await server.close(); await removeFixture(fixture); }
});
