import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../src/server.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

test("settings save is optimistic, validated and exposes no secret fields", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  try {
    const initial = await fetch(`${base}/v1/settings`, { headers });
    assert.equal(initial.status, 200);
    const body = await initial.json() as { revision: string; config: Record<string, unknown> };
    const save = await fetch(`${base}/v1/settings`, { method: "POST", headers, body: JSON.stringify({ revision: body.revision, presentation: { theme: "dark", density: "compact" } }) });
    assert.equal(save.status, 200, await save.clone().text());
    const next = await save.json() as { revision: string; presentation: { theme: string } };
    assert.notEqual(next.revision, body.revision);
    assert.equal(next.presentation.theme, "dark");
    const stale = await fetch(`${base}/v1/settings`, { method: "POST", headers, body: JSON.stringify({ revision: body.revision, presentation: { theme: "light" } }) });
    assert.equal(stale.status, 409);
    const invalid = await fetch(`${base}/v1/settings`, { method: "POST", headers, body: JSON.stringify({ revision: next.revision, config: { ...body.config, apiKey: "example-only" } }) });
    assert.equal(invalid.status, 400, "write-only credentials use a distinct broker endpoint");
    const language = await fetch(`${base}/v1/settings`, { method: "POST", headers, body: JSON.stringify({
      revision: next.revision, config: { ...body.config, language: "en", defaults: { maxTokens: 1234, maxWallClockMs: 100_000, maxRetries: 1 } },
    }) });
    assert.equal(language.status, 200);
    const page = await fetch(base);
    assert.match(await page.text(), /window.KEYSTONE_LANG="en"/);
    const catalog = await fetch(`${base}/v1/settings/catalog?language=zh-CN`, { headers });
    assert.equal(catalog.status, 200);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
