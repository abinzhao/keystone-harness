import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpSession } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-boundaries.js", import.meta.url));
function session(mode: string, options: Record<string, number> = {}) {
  return new McpSession({ command: process.execPath, args: [fixture, mode],
    cwd: join(fixture, ".."), handshakeTimeoutMs: 1000, callTimeoutMs: 300, maxRestarts: 1, ...options });
}

test("MCP refuses negotiated protocol drift and newline-terminated oversized frames", async () => {
  for (const mode of ["version", "frame"]) {
    const client = session(mode, { maxFrameBytes: 1024 });
    try { await assert.rejects(client.start(), /incompatible|oversized|handshake/i); }
    finally { await client.stop(); }
  }
});

test("MCP never retries calls with unknown effects and abort stops the session", async () => {
  const client = session("call-error");
  try {
    await client.start();
    await assert.rejects(client.callTool("count", {}), /call/i);
    const result = await client.callTool("count", {});
    assert.equal(result.content?.[0]?.text, "2", "a rejected call was executed once, not replayed");
  } finally { await client.stop(); }
  const hanging = session("hang");
  try {
    await hanging.start();
    const controller = new AbortController();
    const call = hanging.callTool("count", {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(call, /abort/i);
    assert.equal(hanging.state, "stopped");
  } finally { await hanging.stop(); }
});
