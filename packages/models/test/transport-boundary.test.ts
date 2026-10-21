import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { postJsonBody } from "../src/http.ts";

test("provider transport refuses redirects that would widen the leased destination", async () => {
  let destinationCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(307, { location: "/unexpected" }); res.end(); }
    else { destinationCalls++; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(postJsonBody({
      modelId: "fixture", url: `http://127.0.0.1:${(server.address() as { port: number }).port}/redirect`,
      timeoutMs: 1000, headers: {}, body: {},
    }));
    assert.equal(destinationCalls, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a pre-aborted signal reaches the transport as aborted", async () => {
  let observed = false;
  await assert.rejects(postJsonBody({
    modelId: "fixture", url: "http://127.0.0.1/v1", timeoutMs: 1000,
    signal: AbortSignal.abort(), headers: {}, body: {},
    fetchImpl: async (_url, init) => {
      observed = init.signal?.aborted === true;
      throw new DOMException("aborted", "AbortError");
    },
  }));
  assert.equal(observed, true);
});
