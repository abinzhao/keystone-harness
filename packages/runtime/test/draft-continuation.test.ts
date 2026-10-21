import assert from "node:assert/strict";
import test from "node:test";

import { KernelSession, projectIdForWorkspace } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { newId, nowIso, userDecisionSchema } from "@keystone/schemas";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { startServer } from "../src/server.ts";
import {
  FIXED_SESSION,
  FINISH_ACTION,
  autonomyFor,
  envelopeFor,
  makeFixture,
  removeFixture,
  writeAction,
} from "./fixture.ts";

test("an imported local draft continues as the same task with fresh local policy and evidence", async () => {
  const fixture = await makeFixture();
  try {
    const projectId = await projectIdForWorkspace(fixture.root);
    const draft = await KernelSession.create({
      paths: fixture.paths,
      projectId,
      requestedBy: "user",
      actorId: "workbench.collaboration",
      request: "independently fix src/auth/session.js",
      references: [{
        kind: "text",
        value: JSON.stringify({
          authority: "imported_candidate",
          trustLevel: "untrusted",
          sourceDigest: "fixture-digest",
        }),
      }],
    });
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "draft-builder" }),
        responses: [
          envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
          envelopeFor([FINISH_ACTION]),
        ],
      })],
    });
    let announced = "";
    const result = await runtime.runDraftTask(draft.taskId, {
      workspacePath: fixture.root,
      autonomy: autonomyFor(["src/auth/**"]),
      acceptContractAutomatically: true,
      maxSteps: 2,
      onTaskCreated: (taskId) => { announced = taskId; },
    });

    assert.equal(result.taskId, draft.taskId);
    assert.equal(announced, draft.taskId);
    assert.equal(result.status, "proven");
    const reopened = await KernelSession.open({ paths: fixture.paths, taskId: draft.taskId });
    assert.equal(reopened.state().status, "proven");
    assert.equal(reopened.events().filter((event) => event.type === "task.created").length, 1);
    assert.match(JSON.stringify(reopened.events()[0]?.payload["references"]), /imported_candidate/);
    assert.ok((await reopened.evidence()).length > 0);
  } finally {
    await removeFixture(fixture);
  }
});

test("the authenticated workbench starts a fresh imported draft without creating another task", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    token: "draft-continuation-token",
    models: [createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "draft-http-builder" }),
      responses: [
        envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
        envelopeFor([FINISH_ACTION]),
      ],
    })],
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };
  try {
    const registered = await fetch(`${base}/v1/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rootPath: fixture.root }),
    });
    const project = (await registered.json()) as { project: { projectId: string } };
    const draft = await KernelSession.create({
      paths: fixture.paths,
      projectId: project.project.projectId as never,
      requestedBy: "user",
      request: "independently fix src/auth/session.js",
      references: [{ kind: "text", value: "untrusted imported candidate fixture" }],
    });
    await draft.recordUserDecision(userDecisionSchema.parse({
      decisionId: newId("dec"), taskId: draft.taskId, branchId: draft.branchId, at: nowIso(),
      decision: "allow", rationale: "adopt only a fresh local draft", recordedBy: "user",
      appliesTo: { capability: "fs.write", resources: ["src/auth/**"] },
    }));

    const started = await fetch(`${base}/v1/tasks/${draft.taskId}/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        writePaths: ["src/auth/**"],
        allowedCommands: ["node", "npm"],
        startMode: "confirmed",
      }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    assert.equal(((await started.json()) as { taskId: string }).taskId, draft.taskId);

    const deadline = Date.now() + 30_000;
    for (;;) {
      const response = await fetch(`${base}/v1/tasks/${draft.taskId}/run`, { headers });
      const body = (await response.json()) as { status: string; taskStatus?: string };
      if (body.status !== "running") {
        assert.equal(body.taskStatus, "proven", JSON.stringify(body));
        break;
      }
      if (Date.now() > deadline) assert.fail("draft continuation did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const tasks = (await (await fetch(`${base}/v1/tasks`, { headers })).json()) as {
      tasks: readonly { taskId: string }[];
    };
    assert.equal(tasks.tasks.filter((entry) => entry.taskId === draft.taskId).length, 1);
    const proof = await fetch(`${base}/v1/tasks/${draft.taskId}/proof`, { headers });
    assert.equal(proof.status, 200, await proof.clone().text());
    const exported = await proof.json() as { outcome: string; interventions: unknown[] };
    assert.equal(exported.outcome, "proven");
    assert.deepEqual(exported.interventions, []);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
