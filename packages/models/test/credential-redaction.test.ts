import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as models from "../src/index.ts";

test("all four adapters redact short keys from transport failures", async () => {
  for (const factory of [
    models.createOpenAiCompatibleAdapter, models.createOpenAiResponsesAdapter,
    models.createAnthropicMessagesAdapter, models.createGeminiGenerateAdapter,
  ]) {
    const adapter = factory({
      descriptor: { ...models.scriptedModelDescriptor(), credentialHandle: "main" },
      credentials: { async resolve() { return "tiny"; } },
      baseUrl: "https://example.test",
      fetchImpl: async () => { throw new Error("rejected tiny credential"); },
    });
    await assert.rejects(() => adapter.complete({
      messages: [{ role: "user", content: "test" }], tools: [], jsonMode: false,
    }), (error: Error) => !error.message.includes("tiny"));
  }
});

test("corrupt legacy credential errors never echo source bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-corrupt-credential-"));
  try {
    await writeFile(join(dir, "main.json"), "tiny");
    await assert.rejects(() => new models.FileCredentialStore({ credentialsDir: dir }).resolve("main"),
      (error: Error) => !error.message.includes("tiny"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
