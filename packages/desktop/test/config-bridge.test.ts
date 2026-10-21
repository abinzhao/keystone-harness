/**
 * First-run onboarding bridge: it writes a credential *reference* to config and
 * the secret to the 0600 store, and must never project the secret back to a page.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveKeystonePaths } from "@keystone/kernel";
import { FileCredentialStore } from "@keystone/models";

import { DesktopConfigBridge } from "../src/index.ts";

async function boot(): Promise<{ home: string; bridge: DesktopConfigBridge }> {
  const home = await mkdtemp(join(tmpdir(), "keystone-bridge-"));
  const paths = resolveKeystonePaths(home);
  return { home, bridge: new DesktopConfigBridge({
    paths, credentials: new FileCredentialStore({ credentialsDir: paths.credentialsDir }),
  }) };
}

test("bootstrap reports no model on a fresh home", async () => {
  const { home, bridge } = await boot();
  try {
    const bootInfo = await bridge.bootstrap();
    assert.equal(bootInfo.hasModel, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveModel registers a model but never projects the secret", async () => {
  const { home, bridge } = await boot();
  try {
    const result = await bridge.saveModel({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-secret-do-not-leak",
      modelName: "qwen2.5-coder",
    });
    assert.equal(result.ok, true);
    assert.ok(result.modelId.length > 0);

    const bootInfo = await bridge.bootstrap();
    assert.equal(bootInfo.hasModel, true);

    const { models } = await bridge.listModels();
    assert.equal(models.length, 1);
    const one = models[0];
    assert.ok(one, "a model should have been saved");
    assert.equal(one.modelName, "qwen2.5-coder");
    assert.equal(one.kind, "local");
    // The projected record references the handle, and the secret is absent.
    assert.ok(one.credentialHandle?.startsWith("byok-"));
    assert.ok(!JSON.stringify(models).includes("sk-secret-do-not-leak"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("testConnection reports an unreachable host honestly", async () => {
  const { home, bridge } = await boot();
  try {
    const result = await bridge.testConnection({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "" });
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
