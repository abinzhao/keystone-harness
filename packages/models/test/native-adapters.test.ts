/**
 * Native provider adapters — request/response/tool-call mapping, secret redaction,
 * retryability, capability routing, and config migration (ADR-0010).
 *
 * Every call goes through an in-process `fetchImpl`: no outbound network and no
 * live provider credential. A capability is only exercised here when the adapter
 * actually implements it.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileCredentialStore,
  ModelCapabilityUnsatisfiedError,
  ModelUnavailableError,
  buildAdapter,
  createAnthropicMessagesAdapter,
  createGeminiGenerateAdapter,
  createOpenAiResponsesAdapter,
  keystoneConfigSchema,
  loadConfig,
  modelConfigEntrySchema,
  presetFor,
  scriptedModelDescriptor,
  type CredentialResolver,
  type ModelAdapter,
  type ModelDescriptor,
  type ModelRequest,
  type ToolDescriptor,
} from "../src/index.ts";

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(captured: CapturedCall[], responder: (url: string) => Response) {
  return async (url: string | URL, init: RequestInit): Promise<Response> => {
    captured.push({ url: String(url), init });
    return responder(String(url));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function tempCredentials(secret = "sk-test-secret-value"): Promise<{
  store: FileCredentialStore;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "keystone-models-"));
  const store = new FileCredentialStore({ credentialsDir: join(dir, "credentials") });
  await store.set("main", secret);
  return { store, dir };
}

function cleanup(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

function tool(id: string): ToolDescriptor {
  return {
    id,
    version: "1.0.0",
    description: "a tool",
    capabilities: ["fs.read"],
    sideEffects: [],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: "test.tool",
    outputSchemaId: "test.toolResult",
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 4_096,
  };
}

const baseRequest: ModelRequest = {
  messages: [
    { role: "system", content: "You propose actions." },
    { role: "user", content: "read a.ts" },
  ],
  tools: [],
  jsonMode: true,
};

test("OpenAI Responses maps request, tools and function_call -> ModelToolCall", async () => {
  const { store, dir } = await tempCredentials();
  const captured: CapturedCall[] = [];
  const adapter = createOpenAiResponsesAdapter({
    descriptor: {
      ...scriptedModelDescriptor({ id: "oai-resp", endpointHost: "api.openai.com" }),
      protocol: "openai-responses",
      credentialHandle: "main",
    } as ModelDescriptor,
    credentials: store,
    baseUrl: "https://api.openai.com/v1",
    fetchImpl: mockFetch(captured, () =>
      jsonResponse({
        output_text: "",
        output: [
          { type: "message", content: [{ type: "output_text", text: "proposing a read" }] },
          {
            type: "function_call",
            name: "fs.read_file",
            arguments: '{"path":"a.ts"}',
            call_id: "call_1",
          },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
        status: "completed",
      }),
    ),
  });

  const response = await adapter.complete({
    ...baseRequest,
    tools: [tool("fs.read_file")],
  });

  assert.equal(captured[0]?.url, "https://api.openai.com/v1/responses");
  const headers = captured[0]?.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer sk-test-secret-value");
  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  // System + user are passed through as input items.
  assert.deepEqual((body["input"] as unknown[]).length, 2);
  // JSON output is constrained and tools are sent as function definitions.
  assert.deepEqual(body["text"], { format: { type: "json_object" } });
  assert.equal((body["tools"] as unknown[]).length, 1);
  const fn = (body["tools"] as Record<string, unknown>[])[0];
  assert.equal(fn?.["type"], "function");
  assert.equal(fn?.["name"], "fs.read_file");

  assert.equal(response.text, "proposing a read");
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, "fs.read_file");
  assert.deepEqual(response.toolCalls[0]?.args, { path: "a.ts" });
  assert.equal(response.toolCalls[0]?.id, "call_1");
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 7 });

  await cleanup(dir);
});

test("Anthropic Messages sends x-api-key, lifts system, maps tool_use", async () => {
  const { store, dir } = await tempCredentials();
  const captured: CapturedCall[] = [];
  const adapter = createAnthropicMessagesAdapter({
    descriptor: {
      ...scriptedModelDescriptor({ id: "anth", endpointHost: "api.anthropic.com" }),
      protocol: "anthropic-messages",
      credentialHandle: "main",
    } as ModelDescriptor,
    credentials: store,
    baseUrl: "https://api.anthropic.com/v1",
    fetchImpl: mockFetch(captured, () =>
      jsonResponse({
        content: [
          { type: "text", text: "doing a read" },
          { type: "tool_use", id: "toolu_1", name: "fs.read_file", input: { path: "b.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 9 },
      }),
    ),
  });

  const response = await adapter.complete({ ...baseRequest, tools: [tool("fs.read_file")] });

  assert.equal(captured[0]?.url, "https://api.anthropic.com/v1/messages");
  const headers = captured[0]?.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-test-secret-value");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  // System lifted out; only user/assistant remain in messages.
  assert.equal(body["system"], "You propose actions.");
  assert.equal((body["messages"] as unknown[]).length, 1);
  assert.equal((body["tools"] as unknown[]).length, 1);
  const t = (body["tools"] as Record<string, unknown>[])[0];
  assert.equal(t?.["name"], "fs.read_file");
  assert.ok("input_schema" in (t ?? {}));

  assert.equal(response.text, "doing a read");
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.id, "toolu_1");
  assert.deepEqual(response.toolCalls[0]?.args, { path: "b.ts" });
  assert.deepEqual(response.usage, { inputTokens: 20, outputTokens: 9 });

  await cleanup(dir);
});

test("Gemini GenerateContent targets /models/{model}:generateContent and maps functionCall", async () => {
  const { store, dir } = await tempCredentials();
  const captured: CapturedCall[] = [];
  const adapter = createGeminiGenerateAdapter({
    descriptor: {
      ...scriptedModelDescriptor({ id: "gem", modelName: "gemini-pro", endpointHost: "generativelanguage.googleapis.com" }),
      protocol: "gemini-generate",
      credentialHandle: "main",
    } as ModelDescriptor,
    credentials: store,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    fetchImpl: mockFetch(captured, () =>
      jsonResponse({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "calling read" },
                { functionCall: { name: "fs.read_file", args: { path: "c.ts" } } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 },
      }),
    ),
  });

  const response = await adapter.complete({ ...baseRequest, tools: [tool("fs.read_file")] });

  assert.equal(
    captured[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
  );
  const headers = captured[0]?.init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "sk-test-secret-value");
  const body = JSON.parse(String(captured[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body["systemInstruction"], { parts: [{ text: "You propose actions." }] });
  const contents = body["contents"] as { role: string; parts: { text: string }[] }[];
  assert.equal(contents[0]?.role, "user");
  assert.equal(contents[0]?.parts[0]?.text, "read a.ts");
  const gen = body["generationConfig"] as Record<string, unknown>;
  assert.equal(gen["responseMimeType"], "application/json");

  assert.equal(response.text, "calling read");
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, "fs.read_file");
  assert.deepEqual(response.toolCalls[0]?.args, { path: "c.ts" });
  assert.deepEqual(response.usage, { inputTokens: 30, outputTokens: 4 });

  await cleanup(dir);
});

test("a rejected credential never leaks the secret and is permanent", async () => {
  const { store, dir } = await tempCredentials("sk-super-secret-value");
  const adapter = createOpenAiResponsesAdapter({
    descriptor: {
      ...scriptedModelDescriptor({ id: "oai-resp" }),
      protocol: "openai-responses",
      credentialHandle: "main",
    } as ModelDescriptor,
    credentials: store,
    baseUrl: "https://api.openai.com/v1",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  });

  const error = await adapter
    .complete(baseRequest)
    .then(() => undefined)
    .catch((e: unknown) => e as ModelUnavailableError);
  assert.ok(error instanceof ModelUnavailableError);
  assert.equal(error.retriable, false);
  assert.ok(!error.message.includes("sk-super-secret-value"));
  await cleanup(dir);
});

test("a 429 from the provider is classified retriable", async () => {
  const { store, dir } = await tempCredentials();
  const adapter = createAnthropicMessagesAdapter({
    descriptor: {
      ...scriptedModelDescriptor({ id: "anth" }),
      protocol: "anthropic-messages",
      credentialHandle: "main",
    } as ModelDescriptor,
    credentials: store,
    baseUrl: "https://api.anthropic.com/v1",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });

  const error = await adapter
    .complete(baseRequest)
    .then(() => undefined)
    .catch((e: unknown) => e as ModelUnavailableError);
  assert.ok(error instanceof ModelUnavailableError);
  assert.equal(error.retriable, true);
  await cleanup(dir);
});

function countingAdapter(id: string, nativeTools: boolean): {
  adapter: ModelAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      descriptor: {
        ...scriptedModelDescriptor({ id }),
        capabilities: {
          ...scriptedModelDescriptor().capabilities,
          nativeTools,
        },
      } as ModelDescriptor,
      async complete() {
        calls += 1;
        return {
          text: "",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          modelName: id,
          finishReason: "stop",
        };
      },
    },
  };
}

test("the router only routes a tools request to native-tools adapters", async () => {
  const textOnly = countingAdapter("text-only", false);
  const native = countingAdapter("native", true);
  const { ModelRouter } = await import("../src/index.ts");
  const router = new ModelRouter();
  router.register(textOnly.adapter);
  router.register(native.adapter);
  router.setRoute("builder", ["text-only", "native"]);

  await router.complete("builder", { ...baseRequest, tools: [tool("fs.read_file")] });

  assert.equal(textOnly.calls(), 0, "text-envelope adapter must not be called with tools");
  assert.equal(native.calls(), 1);
});

test("a tools request with no native adapter on the route fails loudly, before any call", async () => {
  const textOnly = countingAdapter("text-only", false);
  const { ModelRouter } = await import("../src/index.ts");
  const router = new ModelRouter();
  router.register(textOnly.adapter);
  router.setRoute("builder", ["text-only"]);

  await assert.rejects(
    () => router.complete("builder", { ...baseRequest, tools: [tool("fs.read_file")] }),
    (error: unknown) => error instanceof ModelCapabilityUnsatisfiedError,
  );
  assert.equal(textOnly.calls(), 0, "no network call when the capability is unsatisfiable");
});

test("config migration: a 1.0.0 entry without protocol reads and defaults to openai-chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-models-"));
  try {
    // Written by the old schema: no `protocol` field.
    const legacy = modelConfigEntrySchema.parse({
      id: "cloud-main",
      kind: "cloud",
      provider: "openai-compatible",
      modelName: "gpt-x",
      baseUrl: "https://api.example.com/v1",
      endpointHost: "api.example.com",
      enabled: true,
    });
    assert.equal(legacy.protocol, undefined);

    const store = new FileCredentialStore({ credentialsDir: join(dir, "credentials") });
    const adapter = buildAdapter(legacy, store as CredentialResolver);
    // Defaults to the retained chat-completions wire surface, and the descriptor
    // honestly says that surface does not do native tools.
    assert.equal(adapter.descriptor.protocol, "openai-chat");
    assert.equal(adapter.descriptor.capabilities.nativeTools, false);
    assert.equal(adapter.descriptor.capabilities.structuredOutput, true);

    // An explicit native protocol dispatches to that surface's descriptor.
    const nativeEntry = modelConfigEntrySchema.parse({
      id: "anth",
      kind: "cloud",
      provider: "anthropic",
      modelName: "claude-x",
      baseUrl: "https://api.anthropic.com/v1",
      endpointHost: "api.anthropic.com",
      protocol: "anthropic-messages",
      enabled: true,
    });
    const nativeAdapter = buildAdapter(nativeEntry, store as CredentialResolver);
    assert.equal(nativeAdapter.descriptor.protocol, "anthropic-messages");
    assert.equal(nativeAdapter.descriptor.capabilities.nativeTools, true);
  } finally {
    await cleanup(dir);
  }
});

test("buildAdapter dispatches per protocol and exposes the preset capability matrix", () => {
  assert.equal(presetFor("anthropic-messages").capabilities.nativeTools, true);
  assert.equal(presetFor("anthropic-messages").capabilities.structuredOutput, false);
  assert.equal(presetFor("openai-chat").capabilities.nativeTools, false);
  assert.equal(presetFor("gemini-generate").capabilities.streaming, false);
  assert.equal(presetFor("gemini-generate").capabilities.multimodal, false);
});

test("loadConfig accepts a 1.0.0 file and round-trips a 2.0.0 default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-models-"));
  try {
    const file = join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: "keystone.config@1.0.0",
        models: [
          {
            id: "legacy",
            kind: "local",
            provider: "ollama",
            modelName: "llama",
            baseUrl: "http://127.0.0.1:11434/v1",
            endpointHost: "127.0.0.1",
            enabled: true,
          },
        ],
      }),
    );
    const loaded = await loadConfig({ configFile: file });
    assert.equal(loaded.models.length, 1);
    assert.equal(loaded.models[0]?.id, "legacy");

    const onDisk = await readFile(file, "utf8");
    assert.ok(!onDisk.includes("sk-"));

    // The current default is the new schema version.
    const fresh = keystoneConfigSchema.parse({
      schemaVersion: "keystone.config@2.0.0",
      models: [],
    });
    assert.equal(fresh.schemaVersion, "keystone.config@2.0.0");
  } finally {
    await cleanup(dir);
  }
});
