import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { KernelSession } from "@keystone/kernel";
import { compileContract, resolveEngineeringAction } from "@keystone/pack-engineering";
import { canonicalJson, newId, sha256Hex, type CapabilityLease } from "@keystone/schemas";
import { autonomyFor, makeFixture, removeFixture } from "./fixture.ts";
import {
  CollaborationService, DelegationClient, DelegationReceiver, delegationBinding, signDocument,
  type DelegationRequest, type OutboundHooks,
} from "../src/collaboration/index.ts";

async function transportFixture() {
  const fixture = await makeFixture();
  const alice = generateKeyPairSync("ed25519");
  const bob = generateKeyPairSync("ed25519");
  let revoked = false;
  const peers = () => [
    { identityId: "alice", publicKey: alice.publicKey.export({ type: "spki", format: "pem" }).toString(), revoked: false },
    { identityId: "bob", publicKey: bob.publicKey.export({ type: "spki", format: "pem" }).toString(), revoked },
  ];
  let calls = 0;
  let hits = 0;
  let mutate: "none" | "tamper" | "replay" | "wrong_identity" | "oversized" = "none";
  let previous: unknown;
  let duringResponse: (() => Promise<void>) | undefined;
  let slow = false;
  const server = createServer(async (req, res) => {
    hits++;
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    try {
      const result = await receiver.receive(JSON.parse(Buffer.concat(parts).toString()));
      await duringResponse?.();
      let output: unknown = result;
      if (mutate === "tamper") output = { ...result, document: { ...(result.document as object), status: "completed" } };
      if (mutate === "replay") output = previous;
      if (mutate === "wrong_identity") output = signDocument(result.document, result.envelope.binding, "alice", alice.privateKey);
      previous = result;
      res.end(mutate === "oversized" ? "x".repeat(100_000) : canonicalJson(output));
    } catch { res.statusCode = 400; res.end("{}"); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/delegate`;
  const budget = { maxTokens: 200_000, maxWallClockMs: 600_000, maxRetries: 3 };
  const session = await KernelSession.create({
    paths: fixture.paths, projectId: newId("proj") as never, request: "observe remote child", actorId: "parent",
    proposeContract: compileContract, resolveAction: resolveEngineeringAction,
  });
  await session.submit();
  await session.compile({ profile: {
    projectId: session.summary().projectId, rootPath: fixture.root, name: "local", vcs: "git",
    languages: ["javascript"], commands: [], instructionFiles: [], support: { status: "supported", reasons: [] },
    createdAt: new Date().toISOString() as never, updatedAt: new Date().toISOString() as never,
  }, facts: [], autonomy: { ...autonomyFor(["src/**"]), allowedHosts: ["127.0.0.1"], externalSystems: "reversible_write" }, budget });
  await session.start();
  const receiver = new DelegationReceiver({
    identityId: "bob", endpoint, peers, scopePaths: ["src/child.js"], maxBudget: { maxTokens: 10, maxBytes: 16_384, maxWallClockMs: 5000 },
    admit: async (_request, signal) => {
      calls++;
      if (slow) await new Promise<void>((done) => {
        const timer = setTimeout(done, 100);
        signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
      });
      return { observation: { childClaimsCompleted: true, level: "E0" }, usage: { tokens: 0 } };
    },
    sign: (document, bound) => signDocument(document, bound, "bob", bob.privateKey),
  });
  const issued = new Map<string, CapabilityLease>();
  const observations: unknown[] = [];
  const hooks: OutboundHooks = {
    authorize: async (operation) => {
      const leases: CapabilityLease[] = [];
      for (const [capability, resources] of [
        ["net.fetch", [operation.host]], ["external.write", [operation.endpoint]],
      ] as const) {
        const result = await session.authorizeOperation({
          subject: { kind: "orchestrator", id: "alice" }, capability, resourceValues: resources,
          parametersHash: operation.parametersHash, ttlMs: operation.budget.maxWallClockMs,
          reversibility: "compensable",
        });
        assert.ok(result.ok);
        issued.set(result.lease.leaseId, result.lease);
        leases.push(result.lease);
      }
      return leases;
    },
    currentLease: async (id) => {
      if (!["executing", "verifying", "auto_repairing"].includes(session.state().status)) return undefined;
      const lease = issued.get(id)!;
      const revokedEvent = session.events().find((event) => event.type === "lease.revoked" && event.payload["leaseId"] === id);
      const calls = session.events().filter((event) => event.type === "lease.consumed" && event.payload["leaseId"] === id).length;
      return { ...lease, consumedCalls: calls, status: revokedEvent ? "revoked" : calls > 0 ? "consumed" : "active" };
    },
    consume: async (id) => session.consumeExecutionLease(id),
    observeParent: async (observation) => {
      observations.push(observation);
      // A real parent event records the transport effect, not Evidence or completion.
      const proposalId = newId("prop");
      await session.recordExecution({ proposalId, status: "succeeded", durationMs: 1, changedPaths: [] });
      return { eventId: session.events().at(-1)!.eventId };
    },
  };
  const client = new DelegationClient({ identityId: "alice", peers, endpoints: [endpoint], hooks });
  const request = (patch: Partial<DelegationRequest> = {}) => {
    const now = new Date();
    const document: DelegationRequest = {
      version: "keystone.delegation/1", operation: "delegate", requestId: newId("prop"), idempotencyKey: newId("prop"),
      taskId: session.taskId, requesterId: "alice", recipientId: "bob", endpoint,
      contractDigest: sha256Hex("contract"), environmentDigest: sha256Hex("env"), conditionIds: ["cond.child"],
      scopePaths: ["src/child.js"], budget: { maxTokens: 10, maxBytes: 16_384, maxWallClockMs: 5000 },
      parameters: { instruction: "observe only" }, issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5000).toISOString(), ...patch,
    };
    return signDocument(document, delegationBinding(document, "delegation.request"), "alice", alice.privateKey);
  };
  return {
    client, request, receiver, endpoint, session, peers, hooks, observations,
    calls: () => calls, hits: () => hits, revoke: () => { revoked = true; },
    mutate: (value: typeof mutate) => { mutate = value; }, slow: () => { slow = true; },
    duringResponse: (callback: () => Promise<void>) => { duringResponse = callback; },
    disconnect: () => { server.closeAllConnections(); server.close(); },
    close: async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await removeFixture(fixture); },
  };
}

test("actual loopback delegation is idempotent and parent observes E0 claims without being completed", async () => {
  const fixture = await transportFixture();
  try {
    const signed = fixture.request();
    const result = await fixture.client.delegate(signed);
    assert.equal(result.authority, "imported_candidate");
    assert.equal(result.trustLevel, "untrusted");
    assert.equal(result.claimed.status, "observed");
    assert.equal(fixture.observations.length, 1);
    assert.equal(fixture.session.state().status, "executing");
    assert.equal(fixture.session.events().some((event) => event.type === "evidence.recorded" || event.type === "proof.satisfied"), false);
    await fixture.client.delegate(signed);
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.hits(), 1);
    const replay = fixture.request({ idempotencyKey: (signed.document as DelegationRequest).idempotencyKey });
    await assert.rejects(() => fixture.client.delegate(replay), /idempotency|replay/i);
    const service = new CollaborationService({ peers: fixture.peers, delegation: fixture.client });
    assert.equal((await service.handle("POST", "/v1/collaboration/delegate", { signed })).status, 200);
  } finally { await fixture.close(); }
});

test("no outbound IO before admission, wrong leases, scope, expiry, identities or revoked peers", async () => {
  const fixture = await transportFixture();
  try {
    const denied = new DelegationClient({ identityId: "alice", peers: fixture.peers, endpoints: [fixture.endpoint] });
    await assert.rejects(() => denied.delegate(fixture.request()), /lease/i);
    assert.equal(fixture.hits(), 0);
    const wrong = new DelegationClient({ identityId: "alice", peers: fixture.peers, endpoints: [fixture.endpoint],
      hooks: { ...fixture.hooks, authorize: async (operation) => (await fixture.hooks.authorize(operation)).map((lease) =>
        ({ ...lease, constraints: { ...lease.constraints, parametersHash: sha256Hex("wrong") } })) } });
    await assert.rejects(() => wrong.delegate(fixture.request()), /lease/i);
    assert.equal(fixture.hits(), 0);
    await assert.rejects(() => fixture.client.delegate(fixture.request({ expiresAt: new Date(0).toISOString() })), /signature|expiry/i);
    await assert.rejects(() => fixture.client.delegate(fixture.request({ requesterId: "mallory" })), /identity/i);
    await assert.rejects(() => fixture.client.delegate(fixture.request({ scopePaths: ["../escape"] })), /path/i);
    fixture.revoke();
    await assert.rejects(() => fixture.client.delegate(fixture.request()), /identity|revoked/i);
    assert.equal(fixture.hits(), 0);
  } finally { await fixture.close(); }
});

test("tampered, replayed, wrong identity and oversized responses never become observations", async () => {
  const fixture = await transportFixture();
  try {
    await fixture.client.delegate(fixture.request());
    for (const mode of ["tamper", "replay", "wrong_identity", "oversized"] as const) {
      fixture.mutate(mode);
      await assert.rejects(() => fixture.client.delegate(fixture.request()), /response|budget|signature/i);
    }
    assert.equal(fixture.observations.length, 1);
    assert.equal(fixture.session.state().status, "executing");
  } finally { await fixture.close(); }
});

test("parent stop while response is in flight fences consumed leases and prevents observation", async () => {
  const fixture = await transportFixture();
  try {
    fixture.duringResponse(() => fixture.session.stop("revoke in flight"));
    await assert.rejects(() => fixture.client.delegate(fixture.request()), /lease/i);
    assert.equal(fixture.observations.length, 0);
    assert.equal(fixture.session.state().status, "stopped");
  } finally { await fixture.close(); }
});

test("signed cancel aborts remote work and local AbortSignal prevents outbound IO", async () => {
  const fixture = await transportFixture();
  try {
    fixture.slow();
    const signed = fixture.request();
    const pending = fixture.client.delegate(signed);
    while (fixture.calls() === 0) await new Promise((done) => setTimeout(done, 2));
    const cancel = fixture.request({ operation: "cancel", cancelsRequestId: (signed.document as DelegationRequest).requestId });
    const cancelled = await fixture.client.cancel(cancel);
    assert.equal(cancelled.claimed.status, "cancelled");
    assert.equal((await pending).claimed.status, "cancelled");
    const before = fixture.hits();
    await assert.rejects(() => fixture.client.delegate(fixture.request(), AbortSignal.abort()), /cancel/i);
    assert.equal(fixture.hits(), before);
  } finally { await fixture.close(); }
});

test("network failure returns no success and consumes attempt leases", async () => {
  const fixture = await transportFixture();
  try {
    fixture.disconnect();
    await assert.rejects(() => fixture.client.delegate(fixture.request()), /network/i);
    assert.equal(fixture.observations.length, 0);
    assert.equal(fixture.session.events().filter((event) => event.type === "lease.consumed").length, 2);
  } finally { await fixture.close(); }
});

test("receiver returns cancellation within budget even when admitted child ignores AbortSignal", { timeout: 1000 }, async () => {
  const keys = generateKeyPairSync("ed25519");
  const peers = () => [{ identityId: "alice", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), revoked: false }];
  const at = new Date();
  const request: DelegationRequest = {
    version: "keystone.delegation/1", operation: "delegate", requestId: "req.1", idempotencyKey: "idem.1",
    taskId: "task.fixture", requesterId: "alice", recipientId: "bob", endpoint: "http://127.0.0.1:1/delegate",
    contractDigest: sha256Hex("c"), environmentDigest: sha256Hex("e"), conditionIds: [],
    scopePaths: ["src/child.js"], budget: { maxBytes: 16_384, maxTokens: 1, maxWallClockMs: 15 },
    parameters: {}, issuedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 5000).toISOString(),
  };
  const receiver = new DelegationReceiver({
    identityId: "bob", endpoint: request.endpoint, peers, scopePaths: request.scopePaths, maxBudget: request.budget,
    admit: () => new Promise(() => undefined),
    sign: (document, binding) => signDocument(document, binding, "alice", keys.privateKey),
  });
  const signed = signDocument(request, delegationBinding(request, "delegation.request"), "alice", keys.privateKey);
  const result = await receiver.receive(signed);
  assert.equal((result.document as { status: string }).status, "cancelled");
});
