import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { startServer } from "../src/server.ts";
import { envelopeFor, FINISH_ACTION, FIXED_SESSION, makeFixture, removeFixture, writeAction } from "./fixture.ts";

test("human file edits reject conflicts, record origin and invalidate existing task proof", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths, models: [createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "builder" }),
      responses: [envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]), envelopeFor([FINISH_ACTION])],
    })],
    interventionTimeoutMs: 100,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  try {
    const started = await fetch(`${base}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({
      workspacePath: fixture.root, request: "Fix duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }], writePaths: ["src/**"], allowedCommands: ["npm", "node"], acceptContract: true,
    }) });
    assert.equal(started.status, 202, await started.clone().text());
    const { taskId } = await started.json() as { taskId: string };
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await (await fetch(`${base}/v1/tasks/${taskId}/run`, { headers })).json() as { status: string };
      if (run.status !== "running") break;
      if (Date.now() > deadline) throw new Error("run timeout");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const proof = await (await fetch(`${base}/v1/tasks/${taskId}/proof`, { headers })).json() as { outcome: string };
    assert.equal(proof.outcome, "proven");
    const list = await (await fetch(`${base}/v1/projects`, { headers })).json() as { projects: { projectId: string }[] };
    const projectId = list.projects[0]!.projectId;
    const file = await (await fetch(`${base}/v1/projects/${projectId}/file?path=src/auth/session.js`, { headers })).json() as { hash: string };
    const changed = await fetch(`${base}/v1/projects/${projectId}/files`, { method: "POST", headers, body: JSON.stringify({
      operation: "write", path: "src/auth/session.js", expectedHash: file.hash, content: `${FIXED_SESSION}// human feedback\n`,
    }) });
    assert.equal(changed.status, 200, await changed.clone().text());
    const mutation = await changed.json() as { mutationId: string; hash: string };
    const stale = await fetch(`${base}/v1/projects/${projectId}/files`, { method: "POST", headers, body: JSON.stringify({
      operation: "write", path: "src/auth/session.js", expectedHash: file.hash, content: "stale overwrite",
    }) });
    assert.equal(stale.status, 409);
    assert.match(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), /human feedback/);
    const after = await (await fetch(`${base}/v1/tasks/${taskId}/proof`, { headers })).json() as { outcome: string };
    assert.equal(after.outcome, "not_proven");
    const undo = await fetch(`${base}/v1/projects/${projectId}/files`, { method: "POST", headers, body: JSON.stringify({
      operation: "undo", path: "src/auth/session.js", mutationId: mutation.mutationId, expectedHash: mutation.hash,
    }) });
    assert.equal(undo.status, 200, await undo.clone().text());
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), FIXED_SESSION);
    const tasks = await (await fetch(`${base}/v1/tasks`, { headers })).json() as { tasks: { taskId: string }[] };
    let origins = 0;
    for (const task of tasks.tasks) {
      const events = await (await fetch(`${base}/v1/tasks/${task.taskId}/events`, { headers })).json() as { events: { type: string; payload: { origin?: string } }[] };
      origins += events.events.filter((event) => event.type === "action.executed" && event.payload.origin === "human").length;
    }
    assert.equal(origins, 2);
  } finally {
    await server.close(); await removeFixture(fixture);
  }
});
