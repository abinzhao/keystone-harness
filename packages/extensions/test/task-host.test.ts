import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, newId, sha256Bytes, type CapabilityLease, type UserDecision } from "@keystone/schemas";
import * as ext from "../src/index.ts";

async function fixture(source: string, kind = "tool") {
  const root = await mkdtemp(join(tmpdir(), "keystone-task-host-"));
  const dir = join(root, "package");
  const project = join(root, "project");
  await mkdir(dir);
  await mkdir(project);
  await writeFile(join(project, "input.txt"), "selected input");
  await writeFile(join(project, "secret.txt"), "must not be copied");
  await writeFile(join(dir, "entry.mjs"), source);
  const manifest = {
    name: "fixture", version: "1.0.0", publisher: "fixture",
    integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
    kind, apiVersion: "1.0", capabilities: ["fs.read"], sideEffects: [{ kind: "fs_read" }],
    reversibility: "reversible", egressHosts: [], credentialHandles: [],
    dataClassification: { reads: "internal", egress: [] },
    produces: { observations: ["fixture"], evidenceTypes: ["project_rule_check"] },
    execution: { replayable: true, idempotent: true }, dependencies: [], conflicts: [],
    uninstall: "safe", entry: { module: "entry.mjs", export: "entry" },
  };
  await writeFile(join(dir, "keystone-extension.json"), JSON.stringify(manifest));
  const service = new ext.ExtensionLifecycleService({ registryFile: join(root, "registry.json") });
  const review = await service.review(dir);
  await service.install(dir, review.reviewHash, true);
  await service.probe("fixture", { reviewHash: review.reviewHash, decision: {
    decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"),
    at: new Date().toISOString(), decision: "allow", recordedBy: "user", rationale: "fixture",
    appliesTo: { resources: [ext.extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")] },
  } as unknown as UserDecision });
  await service.activate("fixture", { reviewHash: review.reviewHash });
  return { root, dir, project, service, review };
}

const source = `
import { readFileSync, existsSync } from 'node:fs';
globalThis.importedInParent = true;
export const entry = { run: async (args, ctx) => ({
 status: 'succeeded', stdout: readFileSync(ctx.rootPath + '/input.txt', 'utf8') +
 ':' + existsSync(ctx.rootPath + '/secret.txt'), changedPaths: [], outputBytes: 0,
 durationMs: 0, truncated: false
}) };`;

function lease(request: ext.ExtensionExecutionRequest, patch: Record<string, unknown> = {}): CapabilityLease {
  return {
    leaseId: newId("lease"), taskId: request.taskId, branchId: request.branchId,
    subject: request.subject, capability: request.capability,
    resource: { kind: "paths", values: [...request.resourceValues] },
    constraints: { parametersHash: contentHash(request.parameters), timeoutMs: 2000, maxOutputBytes: 8192 },
    budget: { maxCalls: 1 }, scopeDigest: "0".repeat(64),
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString(),
    issuedBy: "kernel", status: "active", consumedCalls: 0, ...patch,
  } as unknown as CapabilityLease;
}

test("task host registers isolated tools, uses exact kernel hook and copies only authorized resources", async () => {
  const f = await fixture(source);
  try {
    assert.equal(typeof ext.createTaskExtensionHost, "function");
    let calls = 0;
    const host = ext.createTaskExtensionHost({
      service: f.service, taskId: "task", branchId: "branch", rootPath: f.project,
      resources: ["input.txt"], execute: async (request, run) => {
        calls++;
        assert.equal(request.subject.kind, "extension");
        assert.deepEqual(request.resourceValues, ["input.txt"]);
        return run(lease(request));
      },
    });
    const tools = await host.tools();
    assert.equal(tools.length, 1);
    const result = await host.callTool(tools[0]!.descriptor.id, { query: "fixture" });
    assert.equal(result.status, "succeeded");
    assert.equal(result.stdout, "selected input:false");
    assert.equal(calls, 1);
    assert.equal((globalThis as Record<string, unknown>).importedInParent, undefined);
    await writeFile(join(f.dir, "helper.mjs"), "changed");
    await assert.rejects(host.callTool(tools[0]!.descriptor.id, {}), /integrity|changed/i);
    await host.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("host refuses mismatched subject/parameters and cancels in-flight calls when disabled", async () => {
  const f = await fixture("export const entry = { run: async () => new Promise(() => {}) };");
  try {
    let bad = true;
    let started!: () => void;
    started = () => {};
    const host = ext.createTaskExtensionHost({
      service: f.service, taskId: "task", branchId: "branch", rootPath: f.project,
      resources: ["input.txt"], execute: async (request, run) => {
        started();
        return run(lease(request, bad ? { subject: { kind: "builder_loop", id: "builder" } } : {}));
      },
    });
    const [tool] = await host.tools();
    assert.ok(tool);
    await assert.rejects(host.callTool(tool.descriptor.id, {}), /subject/i);
    bad = false;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const call = host.callTool(tool.descriptor.id, {});
    await admitted;
    await f.service.disable("fixture");
    const result = await call;
    assert.equal(result.status, "cancelled");
    await host.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("isolated verifier returns only conservative observations; probe cancellation is bounded", async () => {
  const f = await fixture(`
export const entry = { descriptor: { id: 'fixture', version: '1.0.0', kind: 'project_rule',
 evidenceLevel: 'E1', canSatisfyRequiredCondition: false,
 independence: { mode: 'same_process', independentOf: [] } },
 run: async () => ({ status: 'passed', summary: 'read fixture', outputBytes: 0, durationMs: 0, truncated: false }) };`, "verifier");
  try {
    const host = ext.createTaskExtensionHost({
      service: f.service, taskId: "task", branchId: "branch", rootPath: f.project,
      resources: ["input.txt"], execute: async (request, run) => run(lease(request)),
    });
    const [verifier] = await host.verifiers();
    assert.ok(verifier);
    assert.equal(verifier.descriptor.evidenceLevel, "E1");
    assert.equal(verifier.descriptor.canSatisfyRequiredCondition, false);
    assert.deepEqual(verifier.descriptor.independence.independentOf, []);
    const outcome = await verifier.run({ conditions: [], changedPaths: [] });
    assert.equal(outcome.status, "passed");
    await host.close();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(ext.probeLocalInstall(f.dir, {
      reviewHash: f.review.reviewHash, signal: controller.signal,
      decision: { decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"),
        at: new Date().toISOString(), decision: "allow", recordedBy: "user",
        rationale: "fixture", appliesTo: { resources: [] } } as unknown as UserDecision,
    }), /abort|cancel/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("task host bounds timeout/output and rejects parameter or branch mismatch before execution", async () => {
  for (const behavior of [
    "await new Promise(() => { setInterval(() => {}, 1000); })",
    "'x'.repeat(100000)",
  ]) {
    const f = await fixture(`export const entry = { run: async () => ({
      status: 'succeeded', stdout: ${behavior} }) };`);
    try {
      let patch: Record<string, unknown> = { constraints: { parametersHash: "1".repeat(64) } };
      const host = ext.createTaskExtensionHost({
        service: f.service, taskId: "task", branchId: "branch", rootPath: f.project, resources: ["input.txt"],
        execute: async (request, run) => run(lease(request, patch)),
      });
      await assert.rejects(host.callTool("extension.fixture", {}), /parameters/i);
      patch = { branchId: "wrong" };
      await assert.rejects(host.callTool("extension.fixture", {}), /branch|subject/i);
      patch = {};
      const result = await host.callTool("extension.fixture", {});
      assert.equal(result.status, behavior.startsWith("await") ? "timeout" : "failed");
      assert.equal(result.truncated, !behavior.startsWith("await"));
      await host.close();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("task host discovers and calls reviewed stdio tools only through a command lease", async () => {
  const f = await fixture(source);
  try {
    const mcp = `import { createInterface } from 'node:readline';
createInterface({input: process.stdin}).on('line', raw => {
 const r = JSON.parse(raw); if (r.id === undefined) return;
 const result = r.method === 'initialize' ? { protocolVersion: '2024-11-05', serverInfo: { name: 'fixture', version: '1.0.0' } }
 : r.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : {content: [{type:'text',text:JSON.stringify(r.params.arguments)}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`;
    await writeFile(join(f.dir, "server.mjs"), mcp);
    const manifest = { ...f.review.read.manifest, kind: "protocol", entry: undefined,
      transport: { type: "stdio", command: process.execPath, args: ["server.mjs"] },
      capabilities: ["cmd.exec"], sideEffects: [{ kind: "process_spawn" }], reversibility: "irreversible",
    };
    await writeFile(join(f.dir, "keystone-extension.json"), JSON.stringify(manifest));
    const review = await f.service.review(f.dir);
    await f.service.install(f.dir, review.reviewHash, true);
    const decision = (action: "probe" | "activate") => ({
      decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"), at: new Date().toISOString(),
      decision: "allow", recordedBy: "user", rationale: "fixture",
      appliesTo: { resources: [ext.extensionDecisionResource(review.read.manifest, review.reviewHash, action)] },
    }) as unknown as UserDecision;
    await f.service.probe("fixture", { reviewHash: review.reviewHash, decision: decision("probe") });
    await f.service.activate("fixture", { reviewHash: review.reviewHash, decision: decision("activate") });
    let calls = 0;
    const host = ext.createTaskExtensionHost({
      service: f.service, taskId: "task", branchId: "branch", rootPath: f.project, resources: ["input.txt"],
      execute: async (request, run) => {
        assert.equal(request.capability, "cmd.exec");
        assert.deepEqual(request.resourceValues, ["node"]);
        calls++;
        return run({ ...lease(request), resource: { kind: "command", values: ["node"] } });
      },
    });
    const [tool] = await host.mcpTools("fixture");
    assert.ok(tool);
    const result = await host.callMcpTool("fixture", "echo", { hello: "fixture" });
    assert.equal(result.status, "succeeded");
    assert.match(result.stdout ?? "", /fixture/);
    assert.equal(calls, 2, "discovery and call each pass the injected kernel boundary");
    await f.service.disable("fixture");
    await assert.rejects(host.callMcpTool("fixture", "echo", {}), /active|unavailable/i);
    await host.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("read-only child blocks network module imports and undeclared global network entry points", async () => {
  for (const code of [
    "import { connect } from 'node:net'; export const entry = { run: async () => ({status:'succeeded'}) };",
    "export const entry = { run: async () => ({status:'succeeded',stdout: String(typeof fetch) + ':' + typeof process.getBuiltinModule}) };",
  ]) {
    const f = await fixture(code);
    try {
      const host = ext.createTaskExtensionHost({
        service: f.service, taskId: "task", branchId: "branch", rootPath: f.project, resources: ["input.txt"],
        execute: async (request, run) => run(lease(request)),
      });
      const result = await host.callTool("extension.fixture", {});
      if (code.startsWith("import")) assert.equal(result.status, "failed");
      else assert.equal(result.stdout, "undefined:undefined");
      await host.close();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("task host pins reviewed identity and refuses a newly activated same-name upgrade", async () => {
  const f = await fixture(source);
  try {
    const host = ext.createTaskExtensionHost({
      service: f.service, taskId: "task", branchId: "branch", rootPath: f.project, resources: ["input.txt"],
      execute: async (request, run) => run(lease(request)),
    });
    await host.tools();
    const next = source.replace("selected input", "new input") + "\n// upgraded\n";
    await writeFile(join(f.dir, "entry.mjs"), next);
    await writeFile(join(f.dir, "keystone-extension.json"), JSON.stringify({
      ...f.review.read.manifest, version: "2.0.0",
      integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(next)) },
    }));
    const review = await f.service.review(f.dir);
    await f.service.install(f.dir, review.reviewHash, true);
    await f.service.probe("fixture", { reviewHash: review.reviewHash, decision: {
      decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"), at: new Date().toISOString(),
      decision: "allow", recordedBy: "user", rationale: "fixture",
      appliesTo: { resources: [ext.extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")] },
    } as unknown as UserDecision });
    await f.service.activate("fixture", { reviewHash: review.reviewHash });
    await assert.rejects(host.callTool("extension.fixture", {}), /hash|changed|version/i);
    await host.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
