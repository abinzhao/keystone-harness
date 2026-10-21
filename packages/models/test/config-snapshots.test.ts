import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as models from "../src/index.ts";

test("saving validates before touching an existing file", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-config-"));
  try {
    const location = { configFile: join(home, "config.json") };
    await models.saveConfig(location, models.defaultConfig());
    const before = await readFile(location.configFile);
    await assert.rejects(() => models.saveConfig(location, { ...models.defaultConfig(),
      models: [{ id: "invalid", protocol: "not-a-protocol" }] } as never));
    assert.deepEqual(await readFile(location.configFile), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("revisioned saves conflict across writers and preserve immutable caller snapshots", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-config-"));
  try {
    const location = { configFile: join(home, "config.json") };
    const initial = await models.loadConfigSnapshot(location);
    const results = await Promise.allSettled(["en", "zh-CN"].map((language) =>
      models.saveConfigSnapshot(location, { revision: initial.revision,
        config: { ...initial.config, language } })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.name, "ConfigConflictError");
    const saved = await models.loadConfigSnapshot(location);
    assert.notEqual(saved.revision, initial.revision);
    assert.equal(initial.config.language, undefined);
    assert.equal((await stat(location.configFile)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(location.configFile, "utf8")), saved.config);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("stable model identity uses canonical endpoint, protocol and exact model name", () => {
  const id = (baseUrl: string, protocol = "openai-chat", modelName = "same") =>
    models.stableModelId({ baseUrl, protocol, modelName });
  assert.equal(id("https://EXAMPLE.test:443/v1/"), id("https://example.test/v1"));
  assert.notEqual(id("https://a.test/v1"), id("https://b.test/v1"));
  assert.notEqual(id("https://a.test/v1"), id("https://a.test/v1", "openai-responses"));
  assert.notEqual(id("https://a.test/v1"), id("https://a.test/v1", "openai-chat", "Same"));
  assert.throws(() => id("https://user:password@a.test/v1"));
  assert.throws(() => id("https://a.test/v1?key=secret"));
});

test("configuration updates reject duplicate IDs, unknown routes and future versions", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-config-"));
  try {
    const location = { configFile: join(home, "config.json") };
    const entry: models.ModelConfigEntry = { id: "same", modelName: "same", provider: "test", kind: "local",
      baseUrl: "http://127.0.0.1/v1", endpointHost: "127.0.0.1", enabled: true };
    for (const config of [
      { ...models.defaultConfig(), models: [entry, entry] },
      { ...models.defaultConfig(), routes: { builder: ["missing"] } },
      { ...models.defaultConfig(), schemaVersion: "keystone.config@99.0.0" },
      { ...models.defaultConfig(), models: [{ ...entry, baseUrl: "https://cloud.example/v1", endpointHost: "cloud.example" }] },
    ]) {
      await assert.rejects(() => models.saveConfigSnapshot(location, { revision: "missing", config }));
    }
    assert.equal((await models.loadConfigSnapshot(location)).revision, "missing");
  } finally { await rm(home, { recursive: true, force: true }); }
});
