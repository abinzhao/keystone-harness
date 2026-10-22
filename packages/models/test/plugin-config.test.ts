import assert from "node:assert/strict";
import test from "node:test";
import { buildAdapter, defaultConfig, keystoneConfigSchema, validateConfigUpdate } from "../src/config.ts";
import { modelDescriptorSchema } from "@keystone/schemas";

const entry = {
  id: "trae-model", kind: "cloud", provider: "trae-cli", modelName: "configured-model",
  protocol: "trae-cli-exec", cliPath: "/opt/trae-cli", endpointHost: "api.trae.cn",
  egressHosts: ["api.trae.cn"], extensionName: "keystone-trae-cli",
  extensionReviewHash: "a".repeat(64), enabled: true,
  canonicalCliPath: "/opt/trae-cli", approvedCliDigest: "b".repeat(64), approvedNativeAuthFile: null,
};

test("CLI configuration uses transport fields and requires reviewed cloud destinations", () => {
  const config = validateConfigUpdate({ ...defaultConfig(), schemaVersion: "keystone.config@2.2.0", models: [entry] });
  assert.equal(config.models[0]?.protocol, "trae-cli-exec");
  assert.equal((config.models[0] as any).cliPath, "/opt/trae-cli");
  for (const patch of [
    { kind: "local" }, { cliPath: undefined }, { egressHosts: [] },
    { extensionReviewHash: undefined }, { baseUrl: "http://localhost/v1" },
  ]) assert.throws(() => validateConfigUpdate({ ...config, models: [{ ...entry, ...patch }] }));
});

test("a plugin adapter can only be built through the runtime-injected factory", () => {
  let called = false;
  const config = validateConfigUpdate({ ...defaultConfig(), schemaVersion: "keystone.config@2.2.0", models: [entry] });
  assert.throws(() => buildAdapter(config.models[0]!, { resolve: async () => undefined }), /plugin|factory/i);
  const descriptor = modelDescriptorSchema.parse({
    id: entry.id, kind: "cloud", provider: "trae-cli", modelName: entry.modelName,
    endpointHost: entry.endpointHost, protocol: entry.protocol,
    capabilities: { nativeTools: false, structuredOutput: true, streaming: false, multimodal: false, contextTokens: 10000 },
    dataEgress: { local: false, classes: ["internal"] },
  });
  const adapter = buildAdapter(config.models[0]!, { resolve: async () => undefined }, {
    pluginFactory: () => {
      called = true;
      return { descriptor, complete: async () => { throw new Error("unused"); } };
    },
  } as any);
  assert.equal(called, true);
  assert.equal(adapter.descriptor.kind, "cloud");
});

test("CLI approval pins round-trip without credential contents", () => {
  for (const approvedNativeAuthFile of [null, "/home/native/.trae/cli/auth.json"]) {
    const config = validateConfigUpdate({ ...defaultConfig(), schemaVersion: "keystone.config@2.2.0",
      models: [{ ...entry, approvedNativeAuthFile }] });
    assert.equal((config.models[0] as any).canonicalCliPath, entry.canonicalCliPath);
    assert.equal((config.models[0] as any).approvedCliDigest, entry.approvedCliDigest);
    assert.equal((config.models[0] as any).approvedNativeAuthFile, approvedNativeAuthFile);
  }
});

test("enabled CLI entries require complete identity pins, while legacy entries remain readable", () => {
  const { canonicalCliPath: _path, approvedCliDigest: _digest, approvedNativeAuthFile: _auth, ...legacy } = entry;
  const config = { ...defaultConfig(), schemaVersion: "keystone.config@2.2.0", models: [legacy] };
  assert.doesNotThrow(() => keystoneConfigSchema.parse(config));
  assert.throws(() => validateConfigUpdate(config), /review|approv|pin/i);
  assert.doesNotThrow(() => validateConfigUpdate({ ...config, models: [{ ...legacy, enabled: false }] }));
  for (const patch of [
    { canonicalCliPath: undefined }, { canonicalCliPath: "relative" },
    { approvedCliDigest: undefined }, { approvedCliDigest: "bad" },
    { approvedNativeAuthFile: undefined }, { approvedNativeAuthFile: "relative/auth.json" },
  ]) assert.throws(() => validateConfigUpdate({ ...config, models: [{ ...entry, ...patch }] }));
});

test("HTTP configurations reject CLI approval pins", () => {
  const http = { id: "http-model", provider: "test", modelName: "test", kind: "cloud", enabled: true,
    baseUrl: "https://api.example.com/v1", endpointHost: "api.example.com" };
  for (const patch of [
    { canonicalCliPath: "/opt/trae-cli" }, { approvedCliDigest: "b".repeat(64) },
    { approvedNativeAuthFile: null }, { approvedNativeAuthFile: "/home/native/.trae/cli/auth.json" },
    { approvedNativeModelsFile: "/home/native/.trae/cli/models_cache.json" },
  ]) assert.throws(() => validateConfigUpdate({ ...defaultConfig(), models: [{ ...http, ...patch }] }), /CLI/i);
});

test("optional native model metadata pins round-trip as resource identities", () => {
  for (const approvedNativeModelsFile of [null, "/home/native/.trae/cli/models_cache.json"]) {
    const config = validateConfigUpdate({ ...defaultConfig(), models: [{ ...entry, approvedNativeModelsFile }] });
    assert.equal((config.models[0] as any).approvedNativeModelsFile, approvedNativeModelsFile);
  }
  assert.throws(() => validateConfigUpdate({ ...defaultConfig(), models: [{ ...entry, approvedNativeModelsFile: "relative" }] }));
});
