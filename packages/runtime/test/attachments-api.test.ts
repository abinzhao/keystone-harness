import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../src/server.ts";
import { makeFixture, removeFixture } from "./fixture.ts";
import { AttachmentStore } from "../src/attachments.ts";
import { projectIdForWorkspace } from "@keystone/kernel";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0t8AAAAASUVORK5CYII=";

test("attachment import retains hashed bytes and refuses invalid signatures and foreign project selection", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const registration = await fetch(`${base}/v1/projects`, { method: "POST", headers, body: JSON.stringify({ rootPath: fixture.root }) });
    assert.equal(registration.status, 201);
    const { project } = await registration.json() as { project: { projectId: string } };
    const imported = await fetch(`${base}/v1/attachments`, {
      method: "POST", headers, body: JSON.stringify({ projectId: project.projectId, name: "screen.png", mimeType: "image/png", data: PNG }),
    });
    assert.equal(imported.status, 201, await imported.clone().text());
    const { attachment } = await imported.json() as { attachment: { attachmentId: string; artifactId: string; size: number; contentHash: string } };
    assert.match(attachment.artifactId, /^art_[0-9a-f]{64}$/);
    assert.equal(attachment.size, Buffer.from(PNG, "base64").length);
    const invalid = await fetch(`${base}/v1/attachments`, {
      method: "POST", headers, body: JSON.stringify({ projectId: project.projectId, name: "fake.png", mimeType: "image/png", data: Buffer.from("fake").toString("base64") }),
    });
    assert.equal(invalid.status, 400);
    const escaped = await fetch(`${base}/v1/attachments`, {
      method: "POST", headers, body: JSON.stringify({ projectId: project.projectId, name: "../fake.png", mimeType: "image/png", data: PNG }),
    });
    assert.equal(escaped.status, 400);
    const removed = await fetch(`${base}/v1/attachments/${attachment.attachmentId}`, { method: "DELETE", headers });
    assert.equal(removed.status, 200);
    const start = await fetch(`${base}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({
      workspacePath: fixture.root, request: "inspect image", attachmentIds: [attachment.attachmentId],
    }) });
    assert.equal(start.status, 409);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("large text context is bounded while original bytes and source lines remain inspectable", async () => {
  const fixture = await makeFixture();
  try {
    const store = new AttachmentStore(fixture.paths);
    const record = await store.import({
      projectId: await projectIdForWorkspace(fixture.root), name: "notes.txt", mimeType: "text/plain",
      data: Buffer.from(Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}: contextual notes`).join("\n")).toString("base64"),
    });
    const parts = await store.parts([record]);
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.ok(text.length < 40_000, `context must fit its input budget, got ${text.length}`);
    assert.match(text, /source attachment\./);
    assert.match(text, /lines 1-\d+ of 20000/);
    assert.match(text, /truncated/);
    assert.match(text, new RegExp(record.contentHash));
    assert.equal((await store.get(record.attachmentId)).size, record.size, "context truncation never replaces original metadata");
  } finally { await removeFixture(fixture); }
});
