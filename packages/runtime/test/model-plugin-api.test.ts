import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { defaultConfig } from "@keystone/models";
import { startServer } from "../src/server.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

test("plugin status is read-only and every process probe requires explicit local consent", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths, token: "plugin-api-test" });
  try {
    const headers = { authorization: "Bearer plugin-api-test", "content-type": "application/json" };
    const status = await fetch(`${server.url}v1/model-plugins/trae-cli`, { headers });
    assert.equal(status.status, 200);
    const projection = await status.json() as any;
    assert.equal(projection.kind, "model");
    assert.equal(projection.enabled, false);
    assert.equal(projection.dataEgress.local, false);
    for (const operation of ["discover", "probe", "enable"]) {
      const response = await fetch(`${server.url}v1/model-plugins/trae-cli/${operation}`, {
        method: "POST", headers, body: JSON.stringify({ cliPath: "/bin/not-invoked", endpointHost: "api.example.com", egressHosts: ["api.example.com"] }),
      });
      assert.equal(response.status, 400);
    }
    const privateHost = await fetch(`${server.url}v1/model-plugins/trae-cli/discover`, {
      method: "POST", headers,
      body: JSON.stringify({ confirmed: true, cliPath: "/bin/not-invoked", endpointHost: "127.0.0.1", egressHosts: ["127.0.0.1"] }),
    });
    assert.equal(privateHost.status, 400);
  } finally { await server.close(); await removeFixture(fixture); }
});

test("legacy plugin status cannot claim usable activation or rewrite missing approval pins", async () => {
  const fixture = await makeFixture();
  await writeFile(fixture.paths.configFile, JSON.stringify({
    ...defaultConfig(), schemaVersion: "keystone.config@2.2.0",
    models: [{
      id: "legacy-trae", kind: "cloud", provider: "trae-cli", protocol: "trae-cli-exec",
      modelName: "synthetic", cliPath: "/bin/not-invoked", endpointHost: "api.example.com",
      egressHosts: ["api.example.com"], extensionName: "keystone-trae-cli",
      extensionReviewHash: "a".repeat(64), enabled: true,
    }],
  }));
  const before = await readFile(fixture.paths.configFile, "utf8");
  const server = await startServer({ paths: fixture.paths, token: "legacy-plugin-test" });
  try {
    const response = await fetch(`${server.url}v1/model-plugins/trae-cli`, {
      headers: { authorization: "Bearer legacy-plugin-test" },
    });
    assert.equal(response.status, 200);
    const status = await response.json() as { enabled: boolean; cliPath: string };
    assert.equal(status.enabled, false);
    assert.equal(status.cliPath, "/bin/not-invoked");
    assert.equal(await readFile(fixture.paths.configFile, "utf8"), before);
  } finally { await server.close(); await removeFixture(fixture); }
});
