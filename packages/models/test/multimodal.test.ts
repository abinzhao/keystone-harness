import assert from "node:assert/strict";
import test from "node:test";
import * as models from "../src/index.ts";

const factories = [
  models.createOpenAiCompatibleAdapter,
  models.createOpenAiResponsesAdapter,
  models.createAnthropicMessagesAdapter,
  models.createGeminiGenerateAdapter,
];
const protocols = models.MODEL_PROTOCOLS;
const reply = {
  choices: [{ message: { content: "ok" } }],
  output_text: "ok",
  content: [{ type: "text", text: "ok" }],
  candidates: [{ content: { parts: [{ text: "ok" }] } }],
};
const parts = [
  { type: "text", text: "inspect" },
  ...(["image/png", "image/jpeg", "image/webp"] as const).map((mimeType) => ({
    type: "image" as const, mimeType, data: "aGVsbG8=", artifactId: "artifact-1", sourceId: "source-1",
  })),
] as const;
const request = { messages: [{ role: "user", content: parts }], tools: [], jsonMode: false } as const;

for (const [index, factory] of factories.entries()) {
  const protocol = protocols[index]!;
  test(`${protocol} refuses images before credentials or transport unless explicitly enabled`, async () => {
    let calls = 0;
    const adapter = factory({
      descriptor: { ...models.scriptedModelDescriptor(), credentialHandle: "main" },
      baseUrl: "https://example.test/v1",
      credentials: { async resolve() { calls++; return "test-secret"; } },
      fetchImpl: async () => { calls++; return Response.json(reply); },
    });
    await assert.rejects(() => adapter.complete(request), { name: "ModelContentUnsupportedError" });
    assert.equal(calls, 0);
  });

  test(`${protocol} maps ordered text and all image MIME types without exporting provenance`, async () => {
    let body: {
      messages?: readonly { content: unknown }[];
      input?: readonly { content: unknown }[];
      contents?: readonly { parts: unknown }[];
    } = {};
    const descriptor = models.scriptedModelDescriptor();
    const adapter = factory({
      descriptor: { ...descriptor, credentialHandle: "main",
        capabilities: { ...descriptor.capabilities, multimodal: true } },
      baseUrl: "https://example.test/v1",
      credentials: { async resolve() { return "test-secret"; } },
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init.body));
        return Response.json(reply);
      },
    });
    await adapter.complete(request);
    const mapped = protocol === "openai-chat" ? body.messages?.[0]?.content
      : protocol === "openai-responses" ? body.input?.[0]?.content
      : protocol === "anthropic-messages" ? body.messages?.[0]?.content
      : body.contents?.[0]?.parts;
    const expected = parts.map((part) => {
      if (part.type === "text") {
        return protocol === "gemini-generate" ? { text: part.text }
          : { type: protocol === "openai-responses" ? "input_text" : "text", text: part.text };
      }
      const dataUrl = `data:${part.mimeType};base64,${part.data}`;
      return protocol === "openai-chat" ? { type: "image_url", image_url: { url: dataUrl } }
        : protocol === "openai-responses" ? { type: "input_image", image_url: dataUrl }
        : protocol === "anthropic-messages" ? {
          type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data },
        } : { inlineData: { mimeType: part.mimeType, data: part.data } };
    });
    assert.deepEqual(mapped, expected);
    assert.equal(JSON.stringify(body).includes("artifact-1"), false);
    assert.deepEqual(request.messages[0].content, parts);
  });
}

test("invalid typed content is refused before transport, including images in system messages", async () => {
  let calls = 0;
  const descriptor = models.scriptedModelDescriptor();
  const adapter = models.createGeminiGenerateAdapter({
    descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, multimodal: true } },
    baseUrl: "https://example.test",
    credentials: { async resolve() { calls++; return ""; } },
    fetchImpl: async () => { calls++; return Response.json(reply); },
  });
  for (const part of [
    { type: "image", mimeType: "image/gif", data: "aGVsbG8=" },
    { type: "image", mimeType: "image/png", data: "/tmp/image.png" },
    { type: "image", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
    { type: "text", text: 3 },
  ]) {
    await assert.rejects(() => adapter.complete({
      ...request, messages: [{ role: "user", content: [part] as never }],
    }), { name: "ModelContentInvalidError" });
  }
  await assert.rejects(() => adapter.complete({
    ...request, messages: [{ role: "system", content: parts }],
  }), { name: "ModelContentUnsupportedError" });
  assert.equal(calls, 0);
});

test("config multimodal is opt-in and buildAdapter preserves the explicit declaration", () => {
  const base = {
    id: "vision", kind: "local", provider: "test", modelName: "test",
    baseUrl: "http://127.0.0.1/v1", endpointHost: "127.0.0.1", enabled: true,
  };
  const credentials = { async resolve() { return ""; } };
  assert.equal(models.buildAdapter(models.modelConfigEntrySchema.parse(base), credentials)
    .descriptor.capabilities.multimodal, false);
  assert.equal(models.buildAdapter(models.modelConfigEntrySchema.parse({ ...base, multimodal: true }), credentials)
    .descriptor.capabilities.multimodal, true);
});

test("router never widens local image input to cloud or calls an incompatible adapter", async () => {
  const router = new models.ModelRouter();
  let calls = 0;
  for (const [id, local, multimodal] of [
    ["text", true, false], ["cloud", false, true],
  ] as const) {
    const descriptor = models.scriptedModelDescriptor({ id });
    router.register({
      descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, multimodal },
        dataEgress: { local, classes: local ? [] : ["internal"] } },
      async complete() { calls++; throw new models.ModelUnavailableError(id, "down"); },
    });
  }
  await assert.rejects(() => router.complete("builder", request), models.ModelCapabilityUnsatisfiedError);
  assert.equal(calls, 0);
});

test("router keeps compatible local fallback but stops at permanent content errors", async () => {
  const router = new models.ModelRouter();
  const descriptor = models.scriptedModelDescriptor();
  let backupCalls = 0;
  for (const id of ["first", "backup"]) {
    router.register({
      descriptor: { ...descriptor, id, capabilities: { ...descriptor.capabilities, multimodal: true } },
      async complete() {
        if (id === "first") {
          throw new models.ModelContentUnsupportedError(id, "image");
        }
        backupCalls++;
        return { text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 },
          modelName: id, finishReason: "stop" };
      },
    });
  }
  await assert.rejects(() => router.complete("builder", request), { name: "ModelContentUnsupportedError" });
  assert.equal(backupCalls, 0);
});
