import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveKeystonePaths } from "@keystone/kernel";
import { ConfigConflictError, FileCredentialStore, loadConfigSnapshot, MODEL_PROTOCOLS,
  saveConfigSnapshot, type FetchLike, type ModelConfigEntry } from "@keystone/models";
import { DesktopConfigBridge } from "../src/config-bridge.ts";

async function boot(fetchImpl?: FetchLike) {
  const home = await mkdtemp(join(tmpdir(), "keystone-settings-bridge-"));
  const paths = resolveKeystonePaths(home);
  const credentials = new FileCredentialStore({ credentialsDir: paths.credentialsDir });
  const bridge = new DesktopConfigBridge({ paths, credentials, fetchImpl });
  return { home, paths, credentials, bridge };
}

test("save preserves routes, stable identity and active credential handles across revisions", async () => {
  const { home, paths, credentials, bridge } = await boot();
  try {
    const input = { baseUrl: "http://127.0.0.1:11434/v1", modelName: "same",
      apiKey: "fixture-old-secret", protocol: "openai-chat" as const, multimodal: true };
    const initial = await bridge.listModels();
    assert.equal(initial.revision, "missing");
    const first = await bridge.saveModel({ ...input, revision: initial.revision });
    const saved = await loadConfigSnapshot(paths);
    const oldHandle = saved.config.models[0]!.credentialHandle!;
    await saveConfigSnapshot(paths, { ...saved, config: {
      ...saved.config, routes: { builder: [first.modelId], planner: [], summarizer: [first.modelId] },
    } });
    const revision = (await bridge.listModels()).revision;
    const second = await bridge.saveModel({ ...input, revision, apiKey: "fixture-new-secret", provider: "new-label" });
    assert.equal(second.modelId, first.modelId);
    assert.notEqual(second.revision, revision);
    const updated = await loadConfigSnapshot(paths);
    assert.deepEqual(updated.config.routes, { builder: [first.modelId], planner: [], summarizer: [first.modelId] });
    assert.equal(await credentials.resolve(oldHandle), "fixture-old-secret");
    assert.equal(await credentials.resolve(updated.config.models[0]!.credentialHandle!), "fixture-new-secret");
    assert.equal(updated.config.models[0]!.multimodal, true);
    const other = await bridge.saveModel({ ...input, baseUrl: "http://127.0.0.1:11435/v1" });
    assert.notEqual(other.modelId, first.modelId);
    assert.equal((await bridge.listModels()).models.length, 2);
    assert.equal(JSON.stringify(await bridge.listModels()).includes("fixture-new-secret"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("stale or invalid saves do not overwrite config or write orphan credentials", async () => {
  const { home, paths, credentials, bridge } = await boot();
  try {
    const input = { baseUrl: "https://example.test/v1", modelName: "test", apiKey: "fixture-secret" };
    await bridge.saveModel(input);
    const before = await readFile(paths.configFile);
    const handles = await credentials.listHandles();
    await assert.rejects(() => bridge.saveModel({ ...input, revision: "missing" }), ConfigConflictError);
    await assert.rejects(() => bridge.saveModel({ ...input, protocol: "wrong" as never }));
    assert.deepEqual(await readFile(paths.configFile), before);
    assert.deepEqual(await credentials.listHandles(), handles);
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const protocol of MODEL_PROTOCOLS) {
  test(`${protocol} discovery has correct authentication and never generates`, async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { home, bridge } = await boot(async (url, init) => {
      calls.push({ url, init });
      return Response.json(protocol === "gemini-generate"
        ? { models: [{ name: "models/vision" }] } : { data: [{ id: "vision" }] });
    });
    try {
      const result = await bridge.testConnection({ baseUrl: "https://example.test/v1",
        apiKey: "fixture-secret", protocol });
      assert.equal(result.ok, true);
      assert.deepEqual(result.models, ["vision"]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://example.test/v1/models");
      assert.equal(calls[0]!.init.method, "GET");
      const headers = new Headers(calls[0]!.init.headers);
      assert.equal(headers.get(protocol === "anthropic-messages" ? "x-api-key"
        : protocol === "gemini-generate" ? "x-goog-api-key" : "authorization"),
      protocol.startsWith("openai") ? "Bearer fixture-secret" : "fixture-secret");
      if (protocol === "anthropic-messages") assert.equal(headers.get("anthropic-version"), "2023-06-01");
      assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test(`${protocol} generation is a separate explicit action using the selected protocol`, async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { home, bridge } = await boot(async (url, init) => {
      calls.push({ url, init });
      return Response.json({ choices: [{ message: { content: "ok" } }], output_text: "ok",
        content: [{ type: "text", text: "ok" }],
        candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    });
    try {
      assert.equal(typeof bridge.testGeneration, "function");
      const result = await bridge.testGeneration({ baseUrl: "https://example.test/v1",
        apiKey: "fixture-secret", modelName: "vision", protocol });
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      const suffix = protocol === "openai-chat" ? "/chat/completions"
        : protocol === "openai-responses" ? "/responses"
        : protocol === "anthropic-messages" ? "/messages" : "/models/vision:generateContent";
      assert.equal(calls[0]!.url, `https://example.test/v1${suffix}`);
      assert.equal(calls[0]!.init.method, "POST");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("discovery failures are honest, sanitized and do not assume generation capability", async () => {
  const { home, bridge } = await boot(async () => { throw new Error("fixture-secret"); });
  try {
    const result = await bridge.testConnection({ baseUrl: "https://example.test/v1", apiKey: "fixture-secret" });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
  const malformed = await boot(async () => Response.json({ unexpected: true }));
  try {
    assert.equal((await malformed.bridge.testConnection({
      baseUrl: "https://example.test/v1", apiKey: "",
    })).ok, false);
  } finally { await rm(malformed.home, { recursive: true, force: true }); }
});

test("legacy IDs survive a same-identity edit and migration is explicitly confirmed", async () => {
  const { home, paths, bridge, credentials } = await boot();
  try {
    const snapshot = await loadConfigSnapshot(paths);
    const entry: ModelConfigEntry = { id: "legacy", kind: "local", provider: "old",
      modelName: "same", baseUrl: "http://127.0.0.1/v1", endpointHost: "127.0.0.1",
      credentialHandle: "legacy-handle", enabled: true };
    await credentials.set("legacy-handle", "fixture-secret");
    await saveConfigSnapshot(paths, { ...snapshot, config: { ...snapshot.config, models: [entry] } });
    assert.equal((await bridge.saveModel({ baseUrl: entry.baseUrl!, modelName: entry.modelName })).modelId, "legacy");
    assert.equal(typeof bridge.migrateCredential, "function");
    await assert.rejects(() => bridge.migrateCredential({ handle: "legacy-handle", confirmed: false }), /confirmation/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("discovery never projects a provider-echoed key", async () => {
  const { home, bridge } = await boot(async () =>
    Response.json({ data: [{ id: "echo-fixture-secret" }, { id: "safe" }] }));
  try {
    const discovered = await bridge.testConnection({ baseUrl: "https://example.test/v1", apiKey: "fixture-secret" });
    assert.deepEqual(discovered.models, ["safe"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("empty generation is not success", async () => {
  const { home, bridge } = await boot(async () => Response.json({}));
  try {
    for (const protocol of MODEL_PROTOCOLS) {
      assert.equal((await bridge.testGeneration({ baseUrl: "https://example.test/v1",
        modelName: "fixture", apiKey: "fixture-secret", protocol })).ok, false);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("file-backed bridge refuses migration back into the same default file store", async () => {
  const { home, bridge, credentials } = await boot();
  try {
    await credentials.set("main", "fixture-secret");
    await assert.rejects(() => bridge.migrateCredential({ handle: "main", confirmed: true, removeSource: true }));
    assert.equal(await credentials.resolve("main"), "fixture-secret");
  } finally { await rm(home, { recursive: true, force: true }); }
});
