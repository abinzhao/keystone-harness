/**
 * Governed stdio MCP adapter tests (ADR-0009).
 *
 * These exercise the real neutral spawn boundary against tiny local node
 * servers — a compliant echo server, a garbage server, an immediate crash, and
 * a frame flood — proving the honest failure modes: handshake, discovery,
 * call, defaults-deny lease enforcement, timeout and crash handling.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { capabilityLeaseSchema, newId, nowIso, sha256Hex, type CapabilityLease } from "@keystone/schemas";
import type { ToolContext } from "@keystone/tools";

import {
  McpHandshakeError,
  McpSession,
  McpTimeoutError,
  mcpHandshakeProbe,
  wrapMcpTools,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "fixtures");
const node = process.execPath;

function server(script: string, extra: Partial<ConstructorParameters<typeof McpSession>[0]> = {}) {
  return new McpSession({
    command: node,
    args: [resolve(fixtures, script)],
    cwd: fixtures,
    handshakeTimeoutMs: 3_000,
    callTimeoutMs: 3_000,
    maxRestarts: 1,
    ...extra,
  });
}

test("handshake and tool discovery against a compliant server", async () => {
  const session = server("mcp-echo-server.js");
  try {
    const { serverInfo } = await session.start();
    assert.equal(serverInfo.name, "echo-server");
    assert.equal(serverInfo.version, "1.2.3");
    const tools = await session.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["echo", "shout"]);
  } finally {
    await session.stop();
  }
});

test("tools/call round-trips untrusted output", async () => {
  const session = server("mcp-echo-server.js");
  try {
    await session.start();
    const result = await session.callTool("echo", { hello: "keystone" });
    const text = (result.content ?? []).map((b) => b.text).join("");
    assert.ok(text.includes('"hello":"keystone"'), text);
  } finally {
    await session.stop();
  }
});

test("a garbage/non-speaking server fails the handshake", async () => {
  const session = server("mcp-garbage-server.js", { handshakeTimeoutMs: 1_500 });
  await assert.rejects(() => session.start(), McpHandshakeError);
  await session.stop();
});

test("a server that crashes immediately fails the handshake", async () => {
  const session = server("mcp-crash-server.js", { handshakeTimeoutMs: 1_500 });
  await assert.rejects(() => session.start());
  await session.stop();
});

test("an oversized, unterminated frame caps out instead of growing memory", async () => {
  const session = server("mcp-flood-server.js", { maxFrameBytes: 100_000, handshakeTimeoutMs: 1_500 });
  // The flood does not speak JSON-RPC; the handshake must time out / be refused.
  await assert.rejects(() => session.start(), McpHandshakeError);
  await session.stop();
});

test("an unanswered request times out instead of hanging", async () => {
  const session = server("mcp-echo-server.js");
  try {
    await session.start();
    // The echo server only answers initialize/tools.list/tools.call; an unknown
    // method gets no reply, so the per-request timeout must fire.
    await assert.rejects(
      () =>
        (session as unknown as { request(m: string, p: unknown, t: number): Promise<unknown> }).request(
          "no/such/method",
          {},
          300,
        ),
      McpTimeoutError,
    );
  } finally {
    await session.stop();
  }
});

// --- Lease enforcement on wrapped tools -----------------------------------

function makeLease(command: string): CapabilityLease {
  return capabilityLeaseSchema.parse({
    leaseId: newId("lease"),
    taskId: newId("task"),
    branchId: newId("branch"),
    subject: { kind: "extension", id: "mcp-echo" },
    capability: "cmd.exec",
    resource: { kind: "command", values: [command], mode: "execute" },
    constraints: {},
    budget: { maxCalls: 5 },
    scopeDigest: sha256Hex("test-scope"),
    issuedAt: nowIso(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedBy: "kernel",
    status: "active",
    consumedCalls: 0,
  }) as CapabilityLease;
}

function ctxFor(lease: CapabilityLease): ToolContext {
  return {
    rootPath: fixtures,
    taskId: newId("task"),
    branchId: newId("branch"),
    paths: {} as ToolContext["paths"],
    lease,
  };
}

test("MCP discovery exposes no callable tools without an explicitly declared cmd.exec ceiling", async () => {
  const session = server("mcp-echo-server.js");
  try {
    await session.start();
    assert.deepEqual(
      wrapMcpTools({ session, tools: await session.listTools(), capabilities: [] }),
      [],
    );
    assert.deepEqual(
      wrapMcpTools({ session, tools: await session.listTools(), capabilities: ["fs.read"] }),
      [],
    );
  } finally {
    await session.stop();
  }
});

test("wrapped MCP tool refuses without a lease covering the command (defaults-deny)", async () => {
  const session = server("mcp-echo-server.js");
  try {
    await session.start();
    const [tool] = wrapMcpTools({ session, tools: await session.listTools(), capabilities: ["cmd.exec"] });
    assert.ok(tool !== undefined);
    // A lease for a *different* command does not cover this server.
    const wrongLease = makeLease("something-else");
    await assert.rejects(
      () => tool!.run({ a: 1 }, ctxFor(wrongLease)),
      /lease does not cover/,
    );
  } finally {
    await session.stop();
  }
});

test("wrapped MCP tool runs under a covering lease and returns untrusted output", async () => {
  const session = server("mcp-echo-server.js");
  try {
    await session.start();
    const tools = wrapMcpTools({ session, tools: await session.listTools(), capabilities: ["cmd.exec"] });
    const echo = tools.find((t) => t.descriptor.id.endsWith(".echo"));
    assert.ok(echo !== undefined);
    const result = await echo!.run({ hello: "world" }, ctxFor(makeLease(node)));
    assert.equal(result.status, "succeeded");
    assert.ok((result.stdout ?? "").includes('"hello":"world"'), result.stdout);
  } finally {
    await session.stop();
  }
});

test("the conformance probe passes a good server and fails a garbage one", async () => {
  const good = await mcpHandshakeProbe({
    manifest: {
      name: "echo",
      transport: { type: "stdio", command: node, args: [resolve(fixtures, "mcp-echo-server.js")] },
    } as never,
    packageRoot: fixtures,
    handshakeTimeoutMs: 2_500,
  }).run();
  assert.equal(good.passed, true, good.detail);

  const bad = await mcpHandshakeProbe({
    manifest: {
      name: "garbage",
      transport: { type: "stdio", command: node, args: [resolve(fixtures, "mcp-garbage-server.js")] },
    } as never,
    packageRoot: fixtures,
    handshakeTimeoutMs: 800,
  }).run();
  assert.equal(bad.passed, false);
});
