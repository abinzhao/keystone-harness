import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilityLeaseSchema, contentHash, newId, nowIso, sha256Bytes, type UserDecision } from "@keystone/schemas";
import * as ext from "../src/index.ts";

test("HTTP MCP uses fixed protocol, per-RPC authorization, bounded JSON and refuses redirects", async () => {
  assert.equal(typeof ext.McpHttpSession, "function");
  let calls = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers["mcp-protocol-version"], "2025-03-26");
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const frame = JSON.parse(raw);
    if (request.url === "/redirect") { response.writeHead(302, { location: "/rpc" }).end(); return; }
    if (frame.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    calls++;
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: frame.method === "initialize"
      ? { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "1.0.0" } }
      : frame.method === "tools/list" ? { tools: [{ name: "echo" }] }
      : { content: [{ type: "text", text: "fixture" }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/rpc`;
  let allowed = true;
  let authorized = 0;
  const client = new ext.McpHttpSession({
    url, egressHosts: ["127.0.0.1"], authorize: async (rpc) => {
      authorized++;
      assert.equal(rpc.url, url);
      if (!allowed) throw new Error("denied");
    },
  });
  try {
    await client.start();
    assert.equal((await client.listTools())[0]?.name, "echo");
    await client.callTool("echo", {});
    const before = calls;
    allowed = false;
    await assert.rejects(client.callTool("echo", {}), /denied/);
    assert.equal(calls, before);
    assert.ok(authorized >= 5);
    const redirect = new ext.McpHttpSession({
      url: url.replace("/rpc", "/redirect"), egressHosts: ["127.0.0.1"], authorize: async () => {},
    });
    await assert.rejects(redirect.start(), /redirect|HTTP/i);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(client.callTool("echo", {}, { signal: aborted.signal }));
  } finally {
    await client.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Harness Lab executes against an actual isolated fixture with caller leases and retains a bounded report", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-lab-test-"));
  const source = `import { readFileSync } from 'node:fs';
export const entry = { run: async (args, ctx) => ({ status: 'succeeded',
stdout: readFileSync(ctx.rootPath + '/README.txt', 'utf8'), changedPaths: [],
outputBytes: 0, durationMs: 0, truncated: false }) };`;
  try {
    await writeFile(join(root, "entry.mjs"), source);
    await writeFile(join(root, "keystone-extension.json"), JSON.stringify({
      name: "lab-fixture", version: "1.0.0", publisher: "fixture", kind: "tool", apiVersion: "1.0",
      integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
      capabilities: ["fs.read"], sideEffects: [{ kind: "fs_read" }], reversibility: "reversible",
      egressHosts: [], credentialHandles: [], dataClassification: { reads: "internal", egress: [] },
      produces: { observations: [], evidenceTypes: [] }, execution: { replayable: true, idempotent: true },
      dependencies: [], conflicts: [], uninstall: "safe", entry: { module: "entry.mjs", export: "entry" },
    }));
    assert.equal(typeof ext.HarnessLabService, "function");
    const review = await ext.prepareLocalInstall(root);
    const lab = new ext.HarnessLabService({ reportsDirectory: join(root, ".reports") });
    const taskId = newId("task");
    const branchId = newId("branch");
    const decision = {
      decisionId: newId("dec"), taskId, branchId, at: nowIso(), decision: "allow",
      recordedBy: "user", rationale: "fixture",
      appliesTo: { resources: [ext.extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")] },
    } as unknown as UserDecision;
    const report = await lab.run(root, {
      reviewHash: review.reviewHash, decision,
      execute: async (request, run) => run(capabilityLeaseSchema.parse({
        leaseId: newId("lease"), taskId, branchId, subject: request.subject,
        capability: request.capability, resource: { kind: "paths", values: request.resourceValues },
        constraints: { parametersHash: contentHash(request.parameters) }, budget: { maxCalls: 1 },
        scopeDigest: "0".repeat(64), issuedAt: nowIso(), expiresAt: new Date(Date.now() + 10000).toISOString(),
        issuedBy: "kernel", status: "active", consumedCalls: 0,
      })),
    });
    assert.equal(report.fixtureRun?.status, "succeeded");
    assert.match(report.fixtureRun?.stdout ?? "", /Keystone Harness Lab fixture/);
    assert.equal(report.provenance.trustLevel, "untrusted");
    assert.equal((await lab.list()).length, 1);
    assert.equal(JSON.parse(await lab.export(report.reportId)).reviewHash, review.reviewHash);
    assert.equal(await readFile(join(root, "entry.mjs"), "utf8"), source);
    assert.equal("lease" in report, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
