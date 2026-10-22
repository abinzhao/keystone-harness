import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { access, rm } from "node:fs/promises";
import { nativeFixture, lease } from "./fixtures.ts";
import { createTraeCliAdapter, discoverTraeCliModels, probeTraeCli } from "../src/adapter.ts";
import type { TransportProposal } from "../src/types.ts";
import type { ModelAdapter } from "../../models/src/types.ts";

const request = { messages: [{ role: "user" as const, content: "Return a public synthetic answer." }], tools: [], jsonMode: true };
const options = { endpointHost: "api.example.com", egressHosts: ["api.example.com"] };

test("public probes and model discovery run separately with exact leases and sanitized results", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  const calls: TransportProposal[] = [];
  const authorizeTransport = async (p: TransportProposal) => { calls.push(p); return lease(p); };
  try {
    const probe = await probeTraeCli({ ...options, cliPath: fixture.executable, authorizeTransport });
    assert.equal(probe.version, "0.210.1");
    assert.equal(probe.authentication, "not-verified");
    assert.equal(probe.nativeTools, false);
    assert.deepEqual(calls.map((p) => p.parameters.purpose), ["version", "help"]);
    assert.ok(calls[1]!.parameters.args.includes("--output-schema"));
    assert.ok(calls[1]!.parameters.args.includes("--ignore-user-config"));
    const models = await discoverTraeCliModels({ ...options, cliPath: fixture.executable, authorizeTransport });
    assert.deepEqual(models, [{ modelName: "synthetic", displayName: "Synthetic" }]);
    assert.equal(JSON.stringify(models).includes("PRIVATE"), false);
    assert.equal(calls.at(-1)!.parameters.purpose, "models");
    for (const call of calls) await assert.rejects(access(call.parameters.cwd));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("adapter keeps text envelope inert, real usage and no cost or native calls", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  let active = true, integrity = true;
  const calls: TransportProposal[] = [];
  const authorizeTransport = async (p: TransportProposal) => { calls.push(p); return lease(p); };
  try {
    const adapter = await createTraeCliAdapter({ ...options, cliPath: fixture.executable, modelName: "synthetic",
      authorizeTransport, isActive: () => active, checkIntegrity: () => integrity });
    assert.equal(adapter.descriptor.protocol, "trae-cli-exec");
    assert.equal(adapter.descriptor.kind, "cloud");
    const response = await adapter.complete({ ...request, authorizeTransport });
    assert.deepEqual(response, { text: '{"summary":"Public synthetic answer","actions":[]}', toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 8 },
      measuredUsage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: 2 },
      modelName: "synthetic", finishReason: "stop" });
    const args = calls.at(-1)!.parameters.args;
    assert.ok(args.includes("--ignore-user-config") && args.includes("--ignore-rules") && args.includes("--ephemeral"));
    assert.equal(args.some((arg) => arg.includes("Return a public")), false);
    active = false;
    await assert.rejects(adapter.complete({ ...request, authorizeTransport }), { code: "inactive" });
    active = true; integrity = false;
    await assert.rejects(adapter.complete({ ...request, authorizeTransport }), { code: "integrity" });
    integrity = true;
    await assert.rejects(adapter.complete({ ...request, authorizeTransport: async (p) => {
      active = false;
      return lease(p);
    } }), { code: "inactive" });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("unsupported request capabilities and absent authorization never invoke generate", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  let count = 0;
  const authorizeTransport = async (p: TransportProposal) => { count++; return lease(p); };
  try {
    const adapter = await createTraeCliAdapter({ ...options, cliPath: fixture.executable, modelName: "synthetic",
      authorizeTransport, isActive: () => true });
    const before = count;
    for (const patch of [{ tools: [{}] }, { maxTokens: 100 }, { temperature: 0 },
      { messages: [{ role: "user" as const, content: [{ type: "image" }] }] }, { jsonMode: false }]) {
      await assert.rejects(adapter.complete({ ...request, ...patch, authorizeTransport }), { code: "configuration" });
    }
    await assert.rejects(adapter.complete(request), { code: "authorization" });
    await assert.rejects(adapter.complete({ ...request, authorizeTransport,
      messages: [{ role: "user", content: "x".repeat(1048577) }] }), { code: "input_limit" });
    assert.equal(count, before);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("isolation violation latches the adapter off and emits only a fixed lifecycle notification", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  let notified = false, calls = 0;
  const authorizeTransport = async (p: TransportProposal) => { calls++; return lease(p); };
  try {
    const adapter = await createTraeCliAdapter({ ...options, cliPath: fixture.executable, modelName: "tool",
      authorizeTransport, isActive: () => true, onIsolationViolation: () => { notified = true; } });
    const integrated: ModelAdapter = adapter;
    assert.equal(integrated.descriptor.protocol, "trae-cli-exec");
    await assert.rejects(adapter.complete({ ...request, authorizeTransport }), { code: "isolation_violation" });
    const before = calls;
    await assert.rejects(adapter.complete({ ...request, authorizeTransport }), { code: "isolation_violation" });
    assert.equal(calls, before);
    assert.equal(notified, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("real fixture events enforce native errors, tool refusal, floods, timeout and cancellation", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  const authorizeTransport = async (p: TransportProposal) => lease(p);
  try {
    for (const [modelName, code] of [["auth", "authentication"], ["tool", "isolation_violation"],
      ["flood", "output_limit"], ["timeout", "timeout"]]) {
      const adapter = await createTraeCliAdapter({ ...options, cliPath: fixture.executable, modelName: modelName!,
        authorizeTransport, isActive: () => true, limits: { timeoutMs: 3000, maxOutputBytes: 4096, maxFrameBytes: 2048 } });
      await assert.rejects(adapter.complete({ ...request, authorizeTransport }), { code });
    }
    const adapter = await createTraeCliAdapter({ ...options, cliPath: fixture.executable, modelName: "timeout",
      authorizeTransport, isActive: () => true });
    const controller = new AbortController();
    const task = adapter.complete({ ...request, signal: controller.signal, authorizeTransport });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(task, { code: "cancelled" }); } finally { clearTimeout(timer); }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("generation suppresses installed CLI startup agents, plugins, hosts and automatic retries", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixture = await nativeFixture();
  try {
    const authorizeTransport = async (proposal: TransportProposal) => lease(proposal);
    const adapter = await createTraeCliAdapter({
      ...options, cliPath: fixture.executable, modelName: "feature-policy", isActive: () => true, authorizeTransport,
    });
    assert.equal((await adapter.complete({ ...request, authorizeTransport })).finishReason, "stop");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("actual confined subprocess receives fixed native telemetry policy", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixture = await nativeFixture();
  try {
    const authorizeTransport = async (proposal: TransportProposal) => lease(proposal);
    const adapter = await createTraeCliAdapter({
      ...options, cliPath: fixture.executable, modelName: "telemetry-policy", isActive: () => true, authorizeTransport,
    });
    assert.equal((await adapter.complete({ ...request, authorizeTransport })).finishReason, "stop");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a gateway bind collision reauthorizes new setup parameters before any CLI generation", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixture = await nativeFixture();
  const occupied = createServer(socket => socket.destroy());
  const generations: TransportProposal[] = [];
  try {
    const authorizeTransport = async (proposal: TransportProposal) => {
      if (proposal.parameters.purpose === "generate") {
        generations.push(proposal);
        if (generations.length === 1) {
          const port = Number(/localhost:(\d+)/.exec(proposal.parameters.args[1]!)?.[1]);
          await new Promise<void>(resolve => occupied.listen(port, "127.0.0.1", resolve));
        }
      }
      return lease(proposal);
    };
    const adapter = await createTraeCliAdapter({
      ...options, cliPath: fixture.executable, modelName: "synthetic", isActive: () => true, authorizeTransport,
    });
    assert.equal((await adapter.complete({ ...request, authorizeTransport })).finishReason, "stop");
    assert.ok(generations.length >= 2 && generations.length <= 3);
    assert.notEqual(generations[0]!.parametersHash, generations[1]!.parametersHash);
    assert.notEqual(generations[0]!.parameters.cwd, generations[1]!.parameters.cwd);
    for (const proposal of generations) await assert.rejects(access(proposal.parameters.cwd));
  } finally {
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
