import assert from "node:assert/strict";
import test from "node:test";
const { createApi } = await import(new URL("../web/client/api.js", import.meta.url).href);

test("a stalled mutation times out once and reports an unknown server result", async () => {
  let calls = 0;
  const api = createApi({ timeoutMs: 25, fetch: async (_path: string, init: any) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error("missing bounded timeout")), 250);
      init.signal?.addEventListener("abort", () => { clearTimeout(fallback); reject(init.signal.reason); }, { once: true });
    });
  } });
  await assert.rejects(api("/v1/tasks", { method: "POST", body: "{}" }),
    (error: any) => error.body?.code === "request_timeout" && /unknown|reconnect/i.test(error.message));
  assert.equal(calls, 1);
});

test("caller cancellation remains distinct from timeout and successful calls dispose the timeout", async () => {
  const controller = new AbortController();
  const api = createApi({ timeoutMs: 100, fetch: async (_path: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) });
  const pending = api("/v1/tasks", { signal: controller.signal });
  controller.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
  let signal: AbortSignal;
  const quick = createApi({ timeoutMs: 15, fetch: async (_path: string, init: any) => {
    signal = init.signal; assert.equal("timeoutMs" in init, false);
    return new Response('{"ok":true}');
  } });
  assert.deepEqual(await quick("/v1/tasks", { timeoutMs: 50 }), { ok: true });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(signal!.aborted, false);
});

test("a late response from a transport that ignores abort cannot acknowledge a timed-out mutation", async () => {
  const api = createApi({ timeoutMs: 10, fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return new Response('{"acknowledged":true}');
  } });
  await assert.rejects(api("/v1/tasks", { method: "POST", body: "{}" }),
    (error: any) => error.body?.code === "request_timeout");
});
