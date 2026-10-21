import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { startServer } from "../src/server.ts";
import { envelopeFor, FINISH_ACTION, FIXED_SESSION, makeFixture, removeFixture, writeAction } from "./fixture.ts";

async function finished(base: string, headers: Record<string, string>, taskId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(`${base}/v1/tasks/${taskId}/run`, { headers });
    const body = await response.json() as { status: string };
    if (body.status !== "running") { assert.equal(body.status, "finished", JSON.stringify(body)); return; }
    if (Date.now() > deadline) throw new Error("run deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("settings save preserves an active adapter and new typed input uses the new provider snapshot", async () => {
  const fixture = await makeFixture();
  const received: Record<string, unknown>[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: envelopeFor([FINISH_ACTION]) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(provider.address() as { port: number }).port}`;
  let release: () => void = () => {};
  let announce: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { announce = resolve; });
  const old = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "old" }),
    responses: [envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]), envelopeFor([FINISH_ACTION])],
  });
  const server = await startServer({
    paths: fixture.paths,
    credentials: { resolve: async () => "fixture-only-placeholder" },
    models: [{ descriptor: old.descriptor, async complete(request) { announce(); await gate; return old.complete(request); } }],
    interventionTimeoutMs: 100,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const first = await post("/v1/tasks", {
      workspacePath: fixture.root, request: "Fix duplicate refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }], writePaths: ["src/**"], allowedCommands: ["npm", "node"], acceptContract: true,
    });
    assert.equal(first.status, 202, await first.clone().text());
    const { taskId } = await first.json() as { taskId: string };
    await entered;
    const settings = await (await fetch(`${base}/v1/settings`, { headers })).json() as { revision: string; config: object };
    const save = await post("/v1/settings", {
      revision: settings.revision,
      config: { ...settings.config, models: [{ id: "new", enabled: true, kind: "cloud", provider: "fixture",
        modelName: "fixture-image", protocol: "openai-chat", baseUrl: `http://${host}/v1`, endpointHost: host, multimodal: true, credentialHandle: "fixture-handle" }],
        routes: { builder: ["new"] }, defaults: { maxTokens: 1234, maxWallClockMs: 100_000, maxRetries: 1 } },
    });
    assert.equal(save.status, 200, await save.clone().text());
    release();
    await finished(base, headers, taskId);
    assert.equal(old.callCount(), 2);
    assert.equal(received.length, 0, "saving never performs generation or restarts the old task");
    const projects = await (await fetch(`${base}/v1/projects`, { headers })).json() as { projects: { projectId: string; tasks: string[]; scanStatus: string }[] };
    assert.ok(projects.projects[0]!.tasks.includes(taskId));
    assert.equal(projects.projects[0]!.scanStatus, "scanned");
    const projectId = projects.projects[0]!.projectId;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0t8AAAAASUVORK5CYII=";
    const imported = await post("/v1/attachments", { projectId, name: "screen.png", mimeType: "image/png", data: png });
    const { attachment } = await imported.json() as { attachment: { attachmentId: string } };
    const secondInput = { workspacePath: fixture.root, request: "Inspect src/auth/session.js and the screen.",
      references: [{ kind: "directory", value: "src" }], attachmentIds: [attachment.attachmentId], acceptContract: true, allowedCommands: ["npm", "node"] };
    assert.equal((await post("/v1/tasks", secondInput)).status, 409, "cloud egress requires separate attachment consent");
    assert.equal(received.length, 0);
    const second = await post("/v1/tasks", { ...secondInput, allowAttachmentEgress: true });
    assert.equal(second.status, 202, await second.clone().text());
    const secondId = (await second.json() as { taskId: string }).taskId;
    await finished(base, headers, secondId);
    assert.ok(received.length > 0);
    const messages = received[0]!["messages"] as { content: { type: string; image_url?: { url: string } }[] }[];
    assert.ok(messages[0]!.content.some((part) => part.type === "image_url" && part.image_url?.url === `data:image/png;base64,${png}`));
    const detail = await (await fetch(`${base}/v1/tasks/${secondId}`, { headers })).json() as { configurationSnapshot: { builderModelId: string }; attachments: { attachmentId: string }[]; budgetUsed: { tokens: number }; contract: { budget: { maxTokens: number } } };
    assert.equal(detail.configurationSnapshot.builderModelId, "new");
    assert.equal(detail.attachments[0]!.attachmentId, attachment.attachmentId);
    assert.ok(detail.budgetUsed.tokens >= 13);
    assert.equal(detail.contract.budget.maxTokens, 1234);
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), FIXED_SESSION);
  } finally {
    release(); await server.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await removeFixture(fixture);
  }
});

test("data migration switches every server projection to the verified copy and preserves source", async () => {
  const fixture = await makeFixture();
  const parent = await mkdtemp(join(tmpdir(), "keystone-data-api-"));
  const destination = join(await realpath(parent), "new-home");
  const server = await startServer({ paths: fixture.paths });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const registration = await post("/v1/projects", { rootPath: fixture.root });
    assert.equal(registration.status, 201);
    const before = await (await fetch(`${base}/v1/settings`, { headers })).json() as { revision: string };
    const preview = await post("/v1/data/migrate", { destination, preview: true });
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal((await preview.json() as { verified: boolean }).verified, false);
    const copied = await post("/v1/data/migrate", { destination, preview: false });
    assert.equal(copied.status, 200, await copied.clone().text());
    assert.equal((await copied.json() as { verified: boolean }).verified, true);
    const inventory = await (await fetch(`${base}/v1/data`, { headers })).json() as { home: string };
    assert.equal(inventory.home, destination);
    const settings = await (await fetch(`${base}/v1/settings`, { headers })).json() as { revision: string; source: string };
    assert.equal(settings.revision, before.revision);
    assert.equal(settings.source, join(destination, "config.json"));
    const saved = await post("/v1/settings", { revision: settings.revision, presentation: { theme: "dark" } });
    assert.equal(saved.status, 200);
    assert.match(await readFile(join(destination, "presentation.json"), "utf8"), /dark/);
    assert.ok(await readFile(join(fixture.home, "projects/registry.json"), "utf8"), "source registry remains available");
    assert.equal((await post("/v1/data/cleanup", { category: "cache", preview: true })).status, 200);
  } finally { await server.close(); await removeFixture(fixture); await rm(parent, { recursive: true, force: true }); }
});
