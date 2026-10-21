import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../src/server.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

test("authenticated HTTP text conversion returns a review-only local attachment", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths, token: "processor-http-token" });
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
    const status = await fetch(`${base}/v1/input-processors?${new URLSearchParams({
      projectId: project.project.projectId,
    })}`, { headers });
    assert.equal(status.status, 200);
    assert.ok(((await status.json()) as { processors: readonly { name: string }[] })
      .processors.some((entry) => entry.name === "text-document"));

    const processed = await fetch(`${base}/v1/input-processors/process`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: project.project.projectId,
        processorName: "text-document",
        confirmed: true,
        raw: {
          name: "requirements.md",
          mimeType: "text/markdown",
          data: Buffer.from("# Local review\nNo automatic submission.").toString("base64"),
        },
      }),
    });
    assert.equal(processed.status, 200, await processed.clone().text());
    const result = (await processed.json()) as {
      text: string;
      requiresReview: boolean;
      autoSubmit: boolean;
      attachment: { attachmentId: string; projectId: string };
    };
    assert.match(result.text, /No automatic submission/);
    assert.equal(result.requiresReview, true);
    assert.equal(result.autoSubmit, false);
    assert.equal(result.attachment.projectId, project.project.projectId);

    const attachments = (await (await fetch(`${base}/v1/attachments?${new URLSearchParams({
      projectId: project.project.projectId,
    })}`, { headers })).json()) as { attachments: readonly { attachmentId: string }[] };
    assert.ok(attachments.attachments.some((entry) => entry.attachmentId === result.attachment.attachmentId));
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
