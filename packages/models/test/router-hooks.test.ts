import assert from "node:assert/strict";
import test from "node:test";
import * as models from "../src/index.ts";

const request: models.ModelRequest = {
  messages: [{ role: "user", content: "hello" }], tools: [], jsonMode: false,
};
const response: models.ModelResponse = {
  text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
  modelName: "test", finishReason: "stop",
};

function adapter(id: string, run: () => Promise<models.ModelResponse>): models.ModelAdapter {
  return { descriptor: models.scriptedModelDescriptor({ id }), complete: run };
}

test("attempt hooks wrap each actual fallback and carry its result or failure", async () => {
  const router = new models.ModelRouter();
  const events: string[] = [];
  const unavailable = new models.ModelUnavailableError("first", "offline");
  router.register(adapter("first", async () => { events.push("call:first"); throw unavailable; }));
  router.register(adapter("backup", async () => { events.push("call:backup"); return response; }));
  const result = await router.complete("builder", request, {
    async beforeAttempt(descriptor) { events.push(`before:${descriptor.id}`); },
    async afterAttempt(descriptor, result, error) {
      events.push(`after:${descriptor.id}`);
      if (descriptor.id === "first") {
        assert.equal(result, undefined);
        assert.equal(error, unavailable);
      } else { assert.equal(result, response); assert.equal(error, undefined); }
    },
  });
  assert.equal(result.modelId, "backup");
  assert.deepEqual(events, ["before:first", "call:first", "after:first", "before:backup", "call:backup", "after:backup"]);
});

test("authorization and accounting refusals never authorize fallback", async () => {
  for (const phase of ["before", "after"] as const) {
    const router = new models.ModelRouter();
    let calls = 0;
    const refused = new Error("controller refused");
    router.register(adapter("first", async () => { calls++; return response; }));
    router.register(adapter("backup", async () => { calls++; return response; }));
    await assert.rejects(() => router.complete("builder", request, {
      async beforeAttempt() { if (phase === "before") throw refused; },
      async afterAttempt() { if (phase === "after") throw refused; },
    }), (error) => error === refused);
    assert.equal(calls, phase === "before" ? 0 : 1);
  }
});

test("unsupported content is refused before attempt hooks", async () => {
  const router = new models.ModelRouter();
  let calls = 0;
  const base = models.scriptedModelDescriptor();
  router.register({
    descriptor: { ...base, capabilities: { ...base.capabilities, multimodal: true } },
    async complete() { calls++; return response; },
  });
  await assert.rejects(() => router.complete("builder", {
    ...request, messages: [{ role: "user", content: [
      { type: "image", mimeType: "image/png", data: "/tmp/not-base64" },
    ] }],
  }, {
    async beforeAttempt() { calls++; },
    async afterAttempt() { calls++; },
  }), models.ModelContentInvalidError);
  assert.equal(calls, 0);
});

test("snapshot freezes role routing and registration independently", async () => {
  const router = new models.ModelRouter();
  router.register(adapter("first", async () => response));
  router.register(adapter("backup", async () => ({ ...response, text: "backup" })));
  router.setRoute("builder", ["first", "backup"]);
  assert.equal(typeof router.snapshot, "function");
  const active = router.snapshot();
  router.switchModel("builder", "backup");
  router.register(adapter("first", async () => ({ ...response, text: "replacement" })));
  assert.equal((await active.complete("builder", request)).response.text, "ok");
  assert.equal((await router.complete("builder", request)).response.text, "backup");
  active.switchModel("builder", "first");
  assert.equal(router.route("builder")[0]?.descriptor.id, "backup");
  assert.notEqual(active.listModels()[0], router.listModels()[0]);
});

test("adapter registration listing is independent of default routing and replacement", () => {
  const router = new models.ModelRouter();
  const first = adapter("first", async () => response);
  const selected = adapter("selected", async () => response);
  router.register(first);
  router.register(selected);
  router.setRoute("builder", ["first"]);
  assert.equal(typeof router.listAdapters, "function");
  assert.deepEqual(router.listAdapters(), [first, selected]);
  const replacement = adapter("first", async () => ({ ...response, text: "replacement" }));
  router.register(replacement);
  assert.deepEqual(router.listAdapters(), [replacement, selected]);
  assert.deepEqual(router.route("builder"), [replacement]);
});

test("task snapshots freeze the transport policy independently of registration mutations", () => {
  const router = new models.ModelRouter();
  const permission = { subjectId: "fixture.cli", executable: "fixture-cli", argvPrefix: ["-p"] };
  router.register({ ...adapter("selected", async () => response), transportPermission: permission });
  const snapshot = router.snapshot();
  const frozen = snapshot.route("builder")[0]!.transportPermission!;
  permission.executable = "changed-cli";
  permission.argvPrefix.push("--changed");
  assert.deepEqual(frozen, { subjectId: "fixture.cli", executable: "fixture-cli", argvPrefix: ["-p"] });
  assert.ok(Object.isFrozen(frozen), "a task's transport policy must be immutable");
  assert.ok(Object.isFrozen(frozen.argvPrefix));
});
