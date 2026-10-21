import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionLifecycleService, extensionDecisionResource, type ExtensionExecutionRequest } from "@keystone/extensions";
import { getArtifactText, KernelSession, resolveKeystonePaths } from "@keystone/kernel";
import { compileContract, detectProjectProfile, resolveEngineeringAction } from "@keystone/pack-engineering";
import {
  actionProposalSchema, autonomyEnvelopeSchema, contentHash, newId, nowIso, sha256Bytes,
  userDecisionSchema, type UserDecision,
} from "@keystone/schemas";
import * as integration from "../src/extension-integration.ts";

async function setup(readPaths = ["input.txt"], allowedCommands: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "keystone-extension-integration-"));
  const project = join(root, "project");
  const directory = join(root, "extension");
  await mkdir(project); await mkdir(directory);
  await writeFile(join(project, "input.txt"), "runtime fixture");
  const source = `import { readFileSync } from 'node:fs';
export const entry = {run: async (args, ctx) => ({
status: 'succeeded', stdout: readFileSync(ctx.rootPath + '/input.txt','utf8'),
changedPaths: [], durationMs: 0, truncated: false, outputBytes: 0})};`;
  await writeFile(join(directory, "entry.mjs"), source);
  await writeFile(join(directory, "keystone-extension.json"), JSON.stringify({
    name: "runtime-fixture", version: "1.0.0", publisher: "fixture", kind: "tool", apiVersion: "1.0",
    integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
    capabilities: ["fs.read"], sideEffects: [{ kind: "fs_read" }], reversibility: "reversible",
    egressHosts: [], credentialHandles: [], dataClassification: { reads: "internal", egress: [] },
    produces: { observations: [], evidenceTypes: [] }, execution: { idempotent: true, replayable: true },
    dependencies: [], conflicts: [], uninstall: "safe", entry: { module: "entry.mjs", export: "entry" },
  }));
  const paths = resolveKeystonePaths(join(root, "home"));
  const service = new ExtensionLifecycleService({ registryFile: join(paths.home, "extensions/registry.json") });
  const reviewed = await service.review(directory);
  await service.install(directory, reviewed.reviewHash, true);
  const decision = {
    decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"), at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "test fixture",
    appliesTo: { resources: [extensionDecisionResource(reviewed.read.manifest, reviewed.reviewHash, "probe")] },
  } as unknown as UserDecision;
  await service.probe("runtime-fixture", { reviewHash: reviewed.reviewHash, decision });
  await service.activate("runtime-fixture", { reviewHash: reviewed.reviewHash });
  const projectId = newId("proj") as never;
  const session = await KernelSession.create({
    paths, projectId, requestedBy: "user", actorId: "fixture",
    request: "Read fixture input", references: readPaths.map((value) => ({ kind: "file" as const, value })),
    proposeContract: compileContract, resolveAction: resolveEngineeringAction,
  });
  await session.submit();
  const budget = { maxTokens: 10000, maxWallClockMs: 30000, maxRetries: 1 };
  await session.compile({
    profile: await detectProjectProfile(project, projectId),
    autonomy: autonomyEnvelopeSchema.parse({
      projectId, readPaths, writePaths: [], allowedCommands, allowedHosts: [],
      allowedCredentials: [], externalSystems: "none", maxReversibility: "reversible",
      untrustedContentEgress: "deny_all", budget, updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
    }), budget,
  });
  await session.start();
  return { root, project, directory, service, paths, session };
}

function proposal(session: KernelSession, id = "extension.runtime-fixture", version = "1.0.0") {
  return actionProposalSchema.parse({
    proposalId: newId("prop"), taskId: session.taskId, branchId: session.branchId,
    stepId: "step.fixture", at: nowIso(), modelRef: { id: "builder", provider: "fixture", modelName: "fixture" },
    intent: "read", tool: { id, version }, parameters: { query: "read" }, rationale: "fixture",
    expectedEffects: [], reversibility: "reversible", requestedCapabilities: ["fs.read"], producesEvidenceFor: [],
  });
}

test("task extension integration uses actual extension leases, stores artifacts and records each proposal once", async () => {
  const f = await setup();
  try {
    const extensions = await integration.assembleTaskExtensions(f.service, f.session, f.project, ["input.txt"], undefined, { paths: f.paths });
    assert.deepEqual(extensions.descriptors.map((descriptor) => descriptor.id), ["extension.runtime-fixture"]);
    const before = f.session.events().length;
    assert.equal(await extensions.executeTool(proposal(f.session, "fs.read")), undefined);
    assert.equal(f.session.events().length, before);
    const action = proposal(f.session);
    const result = await extensions.executeTool(action);
    assert.ok(result);
    assert.equal(result.status, "succeeded");
    assert.equal(result.stdout, "runtime fixture");
    assert.equal(result.executionRecorded, true);
    assert.ok(result.leaseId);
    assert.ok(result.artifactId);
    const artifact = JSON.parse((await getArtifactText(f.paths, result.artifactId!))!);
    assert.equal(artifact.provenance.trustLevel, "untrusted");
    assert.equal(artifact.provenance.extension, "extension.runtime-fixture");
    assert.equal(extensions.observations.length, 1);
    assert.equal(extensions.observations[0]!.provenance.sourceKind, "extension");
    assert.equal(extensions.observations[0]!.provenance.trustLevel, "untrusted");
    assert.equal(extensions.observations[0]!.result.stdout, "runtime fixture");
    assert.equal(extensions.observations[0]!.result.artifactId, result.artifactId);
    assert.deepEqual(extensions.observations[0]!.parameters, action.parameters);
    const issued = f.session.events().filter((event) => event.type === "lease.issued");
    const consumed = f.session.events().filter((event) => event.type === "lease.consumed");
    const executed = f.session.events().filter((event) => event.type === "action.executed");
    assert.equal(issued.length, 1);
    assert.equal(consumed.length, 1);
    assert.equal(executed.length, 1);
    assert.equal(executed[0]?.payload.proposalId, action.proposalId);
    assert.equal(executed[0]?.payload.leaseId, result.leaseId);
    const grant = issued[0]!.payload as Record<string, unknown>;
    assert.equal((grant.subject as { kind: string }).kind, "extension");
    assert.notEqual((grant.constraints as { parametersHash: string }).parametersHash, contentHash(action.parameters));
    assert.ok(f.session.events().some((event) => event.type === "budget.consumed"));
    await extensions.close();
    await assert.rejects(extensions.executeTool(proposal(f.session)), /closed/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("integration Tool wrappers ignore Builder leases; version and lifecycle failures never reach standard authorization", async () => {
  const f = await setup();
  try {
    const extensions = await integration.assembleTaskExtensions(f.service, f.session, f.project, ["input.txt"], undefined, { paths: f.paths });
    const [tool] = extensions.tools;
    assert.ok(tool);
    const result = await tool.run({}, {
      rootPath: f.project, taskId: f.session.taskId, branchId: f.session.branchId,
      paths: f.paths, lease: { subject: { kind: "builder_loop" } } as never,
    });
    assert.equal(result.status, "succeeded");
    const wrongVersion = await extensions.executeTool(proposal(f.session, tool.descriptor.id, "2.0.0"));
    assert.equal(wrongVersion?.status, "failed");
    assert.equal(wrongVersion?.leaseId, undefined);
    await f.service.disable("runtime-fixture");
    const disabled = await extensions.executeTool(proposal(f.session));
    assert.equal(disabled?.status, "failed");
    assert.equal(disabled?.leaseId, undefined);
    assert.equal(f.session.events().filter((event) => event.type === "lease.issued").length, 1);
    await extensions.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("integration assembles conservative verifiers and progressive Skill context without executing scripts", async () => {
  const skillPath = "skills/runtime-skill/SKILL.md";
  const f = await setup(["input.txt", skillPath]);
  try {
    const verifierSource = `export const entry = {
descriptor: {id:'fixture',version:'1.0.0',kind:'project_rule',evidenceLevel:'E1',
canSatisfyRequiredCondition:false,independence:{mode:'same_process',independentOf:[]}},
run: async () => ({status:'passed',summary:'fixture observation',outputBytes:0,durationMs:0,truncated:false})};`;
    const original = (await f.service.list())[0]!.manifest;
    const verifierDir = join(f.root, "verifier");
    const skillDir = join(f.project, "skills/runtime-skill");
    await mkdir(verifierDir); await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(join(verifierDir, "entry.mjs"), verifierSource);
    await writeFile(join(verifierDir, "keystone-extension.json"), JSON.stringify({
      ...original, name: "runtime-verifier", kind: "verifier",
      integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(verifierSource)) },
      produces: { observations: ["fixture"], evidenceTypes: ["project_rule_check"] },
    }));
    const skillSource = "---\nname: runtime-skill\ndescription: fixture guidance\n---\n\nDo not execute scripts.";
    await writeFile(join(skillDir, "SKILL.md"), skillSource);
    await writeFile(join(skillDir, "scripts/run.sh"), "exit 1");
    await writeFile(join(skillDir, "keystone-extension.json"), JSON.stringify({
      ...original, name: "runtime-skill", kind: "skill", entry: undefined, capabilities: [], sideEffects: [],
      integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(skillSource)) },
    }));
    for (const dir of [verifierDir, skillDir]) {
      const reviewed = await f.service.review(dir);
      await f.service.install(dir, reviewed.reviewHash, true);
      await f.service.probe(reviewed.read.manifest.name, {
        reviewHash: reviewed.reviewHash, decision: {
          decisionId: newId("dec"), taskId: f.session.taskId, branchId: f.session.branchId, at: nowIso(),
          decision: "allow", recordedBy: "user", rationale: "fixture",
          appliesTo: { resources: [extensionDecisionResource(reviewed.read.manifest, reviewed.reviewHash, "probe")] },
        } as unknown as UserDecision,
      });
      await f.service.activate(reviewed.read.manifest.name, { reviewHash: reviewed.reviewHash });
    }
    const assembled = await integration.assembleTaskExtensions(f.service, f.session, f.project, ["input.txt", skillPath], undefined, { paths: f.paths });
    assert.equal(assembled.verifiers[0]?.descriptor.canSatisfyRequiredCondition, false);
    assert.equal(assembled.verifiers[0]?.descriptor.evidenceLevel, "E1");
    assert.equal((await assembled.verifiers[0]!.run({ conditions: [], changedPaths: [] })).status, "passed");
    assert.equal(assembled.skills[0]?.metadata.provenance.trustLevel, "untrusted");
    const skillTool = assembled.descriptors.find((descriptor) => descriptor.id === "skill.load");
    assert.ok(skillTool);
    const body = await assembled.executeTool(actionProposalSchema.parse({
      ...proposal(f.session), tool: { id: skillTool.id, version: skillTool.version },
      parameters: { name: "runtime-skill", kind: "body" },
    }));
    assert.equal(body?.status, "succeeded");
    assert.match(body?.stdout ?? "", /Do not execute scripts/);
    const reads = f.session.events().filter((event) => event.type === "lease.issued");
    assert.deepEqual((reads[1]!.payload.resource as { values: string[] }).values, [skillPath]);
    assert.ok(reads.every((event) => event.payload.capability === "fs.read"));
    await assert.rejects(assembled.skills[0]!.load({ kind: "resource", path: "scripts/run.sh" }), /resource|declared/i);
    assert.equal(f.session.events().filter((event) => event.type === "lease.consumed").length, 2);
    assert.equal(f.session.events().filter((event) => event.type === "evidence.recorded").length, 0);
    await assembled.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function installMcp(f: Awaited<ReturnType<typeof setup>>) {
  const dir = join(f.root, "mcp");
  await mkdir(dir);
  const inputSchema = { type: "object", required: ["message"], properties: {
    message: { type: "string" }, nested: { type: "object" },
  }, additionalProperties: false };
  const source = `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', raw => {
 const r = JSON.parse(raw); if(r.id === undefined) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',serverInfo:{name:'untrusted-name',version:'99.0.0'}}
 : r.method === 'tools/list' ? {tools:[{name:'echo/a',description:'Exact echo',inputSchema:${JSON.stringify(inputSchema)}},{name:'echo_a'}]}
 : {content:[{type:'text',text:JSON.stringify(r.params)}],isError:r.params.arguments.message === 'fail'};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`;
  await writeFile(join(dir, "server.mjs"), source);
  const original = (await f.service.list())[0]!.manifest;
  await writeFile(join(dir, "keystone-extension.json"), JSON.stringify({
    ...original, name: "runtime-mcp", kind: "protocol", entry: undefined,
    integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
    transport: { type: "stdio", command: process.execPath, args: ["server.mjs"] },
    capabilities: ["cmd.exec"], sideEffects: [{ kind: "process_spawn" }], reversibility: "irreversible",
  }));
  const review = await f.service.review(dir);
  await f.service.install(dir, review.reviewHash, true);
  const decision = (action: "probe" | "activate") => userDecisionSchema.parse({
    decisionId: newId("dec"), taskId: f.session.taskId, branchId: f.session.branchId, at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "reviewed fixture lifecycle",
    appliesTo: { resources: [extensionDecisionResource(review.read.manifest, review.reviewHash, action)] },
  });
  await f.service.probe("runtime-mcp", { reviewHash: review.reviewHash, decision: decision("probe") });
  await f.service.activate("runtime-mcp", { reviewHash: review.reviewHash, decision: decision("activate") });
  return { dir, review, inputSchema };
}

async function approveOperation(session: KernelSession, request: ExtensionExecutionRequest) {
  const decision = userDecisionSchema.parse({
    decisionId: newId("dec"), taskId: session.taskId, branchId: session.branchId, at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "explicit fixture operation consent",
    appliesTo: { capability: request.capability, resources: request.resourceValues },
    modifications: { parametersHash: contentHash(request.parameters) },
  });
  await session.recordUserDecision(decision);
  return decision;
}

test("reviewed MCP discovery advertises stable tools and routes exact proposals through fresh kernel leases", async () => {
  const f = await setup(["input.txt"], ["node"]);
  try {
    const mcp = await installMcp(f);
    const requests: ExtensionExecutionRequest[] = [];
    const assembled = await integration.assembleTaskExtensions(f.service, f.session, f.project, ["input.txt"], undefined, {
      paths: f.paths, operationDecision: async (request) => {
        requests.push(request);
        return approveOperation(f.session, request);
      },
    });
    try {
      const descriptors = assembled.descriptors.filter((descriptor) => descriptor.id.startsWith("mcp:"));
      assert.equal(descriptors.length, 2);
      assert.notEqual(descriptors[0]!.id, descriptors[1]!.id, "punctuation cannot alias tools");
      assert.equal(descriptors[0]!.version, "1.0.0", "use reviewed manifest version, not server claims");
      assert.deepEqual(descriptors[0]!.capabilities, ["cmd.exec"]);
      assert.equal(descriptors[0]!.reversibility, "irreversible");
      assert.ok(descriptors[0]!.description.includes(JSON.stringify(mcp.inputSchema)));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.parameters.operation, "tools/list");
      assert.equal(f.session.events().filter((event) => event.type === "action.executed").length, 0);
      const parameters = { message: "hello", nested: { text: "exact", values: [1, false] } };
      const action = actionProposalSchema.parse({
        ...proposal(f.session), tool: { id: descriptors[0]!.id, version: descriptors[0]!.version },
        parameters, requestedCapabilities: ["cmd.exec"], reversibility: "irreversible",
      });
      const result = await assembled.executeTool(action);
      assert.equal(result?.status, "succeeded");
      assert.deepEqual(JSON.parse(result!.stdout!), { name: "echo/a", arguments: parameters });
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1]!.parameters.params, { name: "echo/a", arguments: parameters });
      const grants = f.session.events().filter((event) => event.type === "lease.issued");
      assert.equal(grants.length, 2);
      assert.deepEqual(grants[1]!.payload.resource, { kind: "command", values: ["node"], mode: "execute" });
      assert.equal((grants[1]!.payload.constraints as { parametersHash: string }).parametersHash, contentHash(requests[1]!.parameters));
      assert.notEqual(grants[0]!.payload.leaseId, result!.leaseId);
      assert.equal(f.session.events().filter((event) => event.type === "lease.consumed").length, 2);
      const executed = f.session.events().filter((event) => event.type === "action.executed");
      assert.equal(executed.length, 1);
      assert.equal(executed[0]!.payload.proposalId, action.proposalId);
      const artifact = JSON.parse((await getArtifactText(f.paths, result!.artifactId!))!);
      assert.equal(artifact.provenance.trustLevel, "untrusted");
      assert.equal(artifact.provenance.extension, descriptors[0]!.id);
      const failed = await assembled.executeTool(actionProposalSchema.parse({ ...action, proposalId: newId("prop"), parameters: { message: "fail" } }));
      assert.equal(failed?.status, "failed", "MCP isError is not a success");
      await f.service.disable("runtime-mcp");
      const denied = await assembled.executeTool(actionProposalSchema.parse({ ...action, proposalId: newId("prop") }));
      assert.equal(denied?.status, "failed");
      assert.equal(denied?.leaseId, undefined);
      assert.equal(requests.length, 3, "disabled calls must fail before requesting consent");
    } finally { await assembled.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("MCP discovery requires exact recorded task consent, not lifecycle approval or an allowed command alone", async () => {
  const f = await setup(["input.txt"], ["node"]);
  try {
    await installMcp(f);
    await assert.rejects(integration.assembleTaskExtensions(
      f.service, f.session, f.project, ["input.txt"], undefined, { paths: f.paths },
    ), /recorded user decision|confirmation/i);
    await assert.rejects(integration.assembleTaskExtensions(
      f.service, f.session, f.project, ["input.txt"], undefined, {
        paths: f.paths, operationDecision: async (request) => {
          const decision = await approveOperation(f.session, request);
          return { ...decision, modifications: { parametersHash: contentHash({ different: true }) } };
        },
      },
    ), /recorded user decision|confirmation/i);
    assert.equal(f.session.events().filter((event) => event.type === "lease.issued").length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("MCP reviewed-byte changes fail before another command lease", async () => {
  const f = await setup(["input.txt"], ["node"]);
  try {
    const mcp = await installMcp(f);
    const assembled = await integration.assembleTaskExtensions(f.service, f.session, f.project, ["input.txt"], undefined, {
      paths: f.paths, operationDecision: (request) => approveOperation(f.session, request),
    });
    try {
      const descriptor = assembled.descriptors.find((entry) => entry.id.startsWith("mcp:"))!;
      assert.ok(descriptor);
      await writeFile(join(mcp.dir, "added.mjs"), "throw new Error('changed');");
      const result = await assembled.executeTool(actionProposalSchema.parse({
        ...proposal(f.session), tool: { id: descriptor.id, version: descriptor.version },
        parameters: { message: "changed" }, requestedCapabilities: ["cmd.exec"], reversibility: "irreversible",
      }));
      assert.equal(result?.status, "failed");
      assert.equal(result?.leaseId, undefined);
      assert.equal(f.session.events().filter((event) => event.type === "lease.issued").length, 1);
    } finally { await assembled.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recorded MCP consent cannot widen an envelope that disallows node", async () => {
  const f = await setup();
  try {
    await installMcp(f);
    await assert.rejects(integration.assembleTaskExtensions(
      f.service, f.session, f.project, ["input.txt"], undefined, {
        paths: f.paths, operationDecision: (request) => approveOperation(f.session, request),
      },
    ), /not among the commands/i);
    assert.equal(f.session.events().filter((event) => event.type === "lease.issued").length, 0);
    assert.deepEqual(f.session.contract()!.autonomy.allowedCommands, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
