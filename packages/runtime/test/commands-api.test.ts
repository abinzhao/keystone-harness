import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../src/server.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

test("independent human commands require confirmation, lease parameters and keep readable output", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const before = await readFile(join(fixture.root, "src/auth/session.js"), "utf8");
    const { project } = await (await post("/v1/projects", { rootPath: fixture.root })).json() as { project: { projectId: string } };
    const route = `/v1/projects/${project.projectId}/commands`;
    assert.equal((await post(route, { command: "node", args: ["--version"] })).status, 400);
    assert.equal((await post(route, { command: "../node", confirmed: true })).status, 400);
    const result = await post(route, { command: "node", args: ["-e", "console.log('receipt')"], confirmed: true });
    assert.equal(result.status, 200, await result.clone().text());
    const receipt = await result.json() as { taskId: string; stdout: string; status: string; artifactId: string; lease: { constraints: { parametersHash: string } }; changedPaths: string[] };
    assert.equal(receipt.status, "succeeded"); assert.match(receipt.stdout, /receipt/);
    assert.match(receipt.lease.constraints.parametersHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(receipt.changedPaths, []);
    const output = await fetch(`${base}/v1/tasks/${receipt.taskId}/artifacts/${receipt.artifactId}`, { headers });
    assert.equal(output.status, 200);
    assert.match((await output.json() as { content: string }).content, /receipt/);
    const detail = await (await fetch(`${base}/v1/tasks/${receipt.taskId}`, { headers })).json() as { status: string };
    assert.equal(detail.status, "stopped", "human output cannot complete an engineering task");
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), before);
    const violation = await post(route, { command: "node", args: ["-e", "require('fs').writeFileSync('outside.txt','x')"], confirmed: true });
    assert.equal(violation.status, 200, await violation.clone().text());
    const effects = await violation.json() as { scopeViolated: boolean; changedPaths: string[] };
    assert.equal(effects.scopeViolated, true); assert.deepEqual(effects.changedPaths, ["outside.txt"]);
  } finally { await server.close(); await removeFixture(fixture); }
});
