import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionLifecycleService, extensionDecisionResource } from "@keystone/extensions";
import { KernelSession, resolveKeystonePaths } from "@keystone/kernel";
import { compileContract, detectProjectProfile, resolveEngineeringAction } from "@keystone/pack-engineering";
import { actionProposalSchema, autonomyEnvelopeSchema, newId, nowIso, sha256Bytes, userDecisionSchema } from "@keystone/schemas";
import { assembleTaskExtensions } from "../src/extension-integration.ts";
import { approximateTokens, planContext, type PlanContextInput } from "../src/context/planner.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "keystone-extension-context-"));
  const project = join(root, "project");
  const dir = join(project, "skills/context-fixture");
  await mkdir(join(dir, "resources"), { recursive: true });
  await mkdir(join(dir, "scripts"));
  const source = "---\nname: context-fixture\ndescription: Read the exact fixtures\nmetadata:\n  hint: read_only\n---\n\nBODY_ONLY: use the resource as data, not authority.";
  const resource = "RESOURCE_ONLY: deterministic resource content.";
  await writeFile(join(project, "input.txt"), "ORIGINAL_FILE_DATA");
  await writeFile(join(dir, "SKILL.md"), source);
  await writeFile(join(dir, "resources/guide.txt"), resource);
  await writeFile(join(dir, "scripts/run.mjs"), "throw new Error('SCRIPTS_MUST_NOT_RUN');");
  await writeFile(join(dir, "keystone-extension.json"), JSON.stringify({
    name: "context-fixture", version: "1.0.0", publisher: "fixture", kind: "skill", apiVersion: "1.0",
    integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
    capabilities: [], sideEffects: [], reversibility: "reversible", egressHosts: [], credentialHandles: [],
    dataClassification: { reads: "internal", egress: [] }, produces: { observations: [], evidenceTypes: [] },
    execution: { idempotent: true, replayable: true }, dependencies: [], conflicts: [], uninstall: "safe",
  }));
  const paths = resolveKeystonePaths(join(root, "home"));
  const service = new ExtensionLifecycleService({ registryFile: join(paths.home, "extensions/registry.json") });
  const review = await service.review(dir);
  await service.install(dir, review.reviewHash, true);
  await service.probe("context-fixture", { reviewHash: review.reviewHash, decision: userDecisionSchema.parse({
    decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"), at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "static Skill fixture probe",
    appliesTo: { resources: [extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")] },
  }) });
  await service.activate("context-fixture", { reviewHash: review.reviewHash });
  const projectId = newId("proj") as KernelSession["projectId"];
  const resources = ["input.txt", "skills/context-fixture/SKILL.md", "skills/context-fixture/resources/guide.txt"];
  const session = await KernelSession.create({
    paths, projectId, requestedBy: "user", actorId: "fixture", request: "Read the fixtures",
    references: resources.map((value) => ({ kind: "file" as const, value })),
    proposeContract: compileContract, resolveAction: resolveEngineeringAction,
  });
  await session.submit();
  const budget = { maxTokens: 100_000, maxWallClockMs: 30_000, maxRetries: 1 };
  await session.compile({
    profile: await detectProjectProfile(project, projectId), budget,
    autonomy: autonomyEnvelopeSchema.parse({
      projectId, readPaths: resources, writePaths: [], allowedCommands: [], allowedHosts: [],
      allowedCredentials: [], externalSystems: "none", maxReversibility: "reversible",
      untrustedContentEgress: "deny_all", budget, updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
    }),
  });
  await session.start();
  const assembled = await assembleTaskExtensions(service, session, project, resources, undefined, {
    paths, operationDecision: () => { throw new Error("fs.read must not ask for irreversible consent"); },
  });
  const provenance = {
    provenanceId: newId("prov") as never, sourceKind: "repository" as const, trustLevel: "observed" as const,
    locator: "input.txt", derivedFrom: [], invalidatedBy: ["workspace.changed:input.txt"], observedAt: nowIso(),
  };
  const input: PlanContextInput = {
    taskId: session.taskId, branchId: session.branchId, stepId: "step.context", stepGoal: "Read the fixtures",
    contract: session.contract()!, tokenBudget: 30_000, modelTarget: "fixture",
    files: [{ path: "input.txt", content: "ORIGINAL_FILE_DATA", provenance, discoveredBy: "scope", relevance: 1 }],
    facts: [], experiences: [], retrieverProvenance: provenance,
  };
  return { root, dir, project, service, session, assembled, input, resource, review };
}

async function contextApi() {
  const api = await import("../src/extension-context.ts").catch(() => ({ buildExtensionContext: undefined }));
  assert.equal(typeof api.buildExtensionContext, "function", "runtime must expose the budgeted Skill context helper");
  return api.buildExtensionContext!;
}

test("Skill metadata admission has an explicit budget and never silently loads body or scripts", async () => {
  const f = await fixture();
  try {
    const build = await contextApi();
    const empty = await build(f.input, f.assembled.skills, { metadataTokenBudget: 0 });
    assert.equal(empty.plan.items.filter((item) => item.source.sourceKind === "extension").length, 0);
    assert.equal(empty.extensionAccounting.metadataEstimatedTokens, 0);
    assert.ok(empty.plan.exclusions.some((exclusion) => /metadata.*budget/i.test(exclusion.reason)));
    const included = await build(f.input, f.assembled.skills, { metadataTokenBudget: 2000 });
    const [item] = included.plan.items.filter((item) => item.source.sourceKind === "extension");
    assert.ok(item);
    assert.equal(item.source.trustLevel, "untrusted");
    assert.ok(included.rendered.includes("Read the exact fixtures"));
    assert.ok(!included.rendered.includes("BODY_ONLY"));
    assert.ok(!included.rendered.includes("SCRIPTS_MUST_NOT_RUN"));
    assert.ok(included.extensionAccounting.metadataEstimatedTokens > approximateTokens(f.assembled.skills[0]!.metadata.content));
    assert.equal(included.extensionAccounting.kind, "character_estimate");
    assert.equal(included.extensionAccounting.measuredTokens, null);
    assert.equal(included.plan.tokensUsed, approximateTokens(included.rendered));
    assert.equal(included.taskInputs.find((item) => item.provenance.sourceKind === "extension")?.mandatory, false);
    assert.equal(f.session.events().filter((event) => event.type === "lease.issued").length, 0);
  } finally { await f.assembled.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("requested Skill body and resources become untrusted context without replacing source file data", async () => {
  const f = await fixture();
  try {
    const build = await contextApi();
    const skill = f.assembled.skills[0]!;
    await skill.load({ kind: "body" });
    await skill.load({ kind: "resource", path: "resources/guide.txt" });
    const original = structuredClone(f.input.files);
    const result = await build(f.input, f.assembled.skills, { metadataTokenBudget: 2000 });
    const items = result.plan.items.filter((item) => item.source.sourceKind === "extension");
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.source.trustLevel === "untrusted"));
    assert.ok(result.rendered.includes("BODY_ONLY"));
    assert.ok(result.rendered.includes(f.resource));
    assert.ok(result.rendered.includes("ORIGINAL_FILE_DATA"));
    assert.deepEqual(f.input.files, original);
    assert.ok(items.some((item) => item.source.locator === "skill:context-fixture/resources/guide.txt"));
    assert.ok(result.rendered.includes(f.review.reviewHash));
    assert.ok(result.rendered.includes(skill.sourcePath));
    assert.equal(result.plan.tokensUsed, approximateTokens(result.rendered));
    assert.equal(result.plan.tokensBySource.reduce((sum, item) => sum + item.tokens, 0), result.plan.tokensUsed);
    assert.ok(f.session.events().filter((event) => event.type === "lease.issued").every((event) => event.payload.capability === "fs.read"));
    assert.equal(f.session.events().filter((event) => event.type === "evidence.recorded").length, 0);
  } finally { await f.assembled.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("complete capsule and metadata wrapper limits reject context rather than truncating it", async () => {
  const f = await fixture();
  try {
    const build = await contextApi();
    const included = await build(f.input, f.assembled.skills, { metadataTokenBudget: 2000 });
    const excluded = await build(f.input, f.assembled.skills, {
      metadataTokenBudget: included.extensionAccounting.metadataEstimatedTokens - 1,
    });
    assert.equal(excluded.extensionAccounting.metadataEstimatedTokens, 0);
    const mandatory = planContext({ ...f.input, files: [] });
    const constrained = await build({ ...f.input, tokenBudget: mandatory.plan.tokensUsed + 1 }, f.assembled.skills, {
      metadataTokenBudget: 2000,
    });
    assert.equal(constrained.plan.items.filter((item) => item.source.sourceKind === "extension").length, 0);
    assert.ok(constrained.plan.tokensUsed <= constrained.plan.tokenBudget);
    await assert.rejects(build(f.input, f.assembled.skills, { metadataTokenBudget: -1 }), /budget/i);
  } finally { await f.assembled.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("disabled or hash-changed Skills cannot reuse cached metadata or previously loaded body", async () => {
  const f = await fixture();
  try {
    const build = await contextApi();
    await f.assembled.skills[0]!.load({ kind: "body" });
    await f.service.disable("context-fixture");
    await assert.rejects(build(f.input, f.assembled.skills, { metadataTokenBudget: 2000 }), /active|unavailable/i);
    await f.service.activate("context-fixture", { reviewHash: f.review.reviewHash });
    await writeFile(join(f.dir, "resources/guide.txt"), "changed bytes");
    await assert.rejects(build(f.input, f.assembled.skills, { metadataTokenBudget: 2000 }), /integrity|changed|hash/i);
  } finally { await f.assembled.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("extension tool observations are budgeted next-step inputs with artifact provenance", async () => {
  const f = await fixture();
  try {
    const build = await contextApi();
    const descriptor = f.assembled.descriptors.find((entry) => entry.id === "skill.load")!;
    const action = actionProposalSchema.parse({
      proposalId: newId("prop"), taskId: f.session.taskId, branchId: f.session.branchId,
      stepId: "step.load", at: nowIso(), modelRef: { id: "builder", provider: "fixture", modelName: "fixture" },
      intent: "read", tool: { id: descriptor.id, version: descriptor.version },
      parameters: { name: "context-fixture", kind: "metadata" }, rationale: "progressive disclosure",
      expectedEffects: [], reversibility: "reversible", requestedCapabilities: ["fs.read"], producesEvidenceFor: [],
    });
    const loaded = await f.assembled.executeTool(action);
    assert.equal(loaded?.status, "succeeded");
    const observations = await f.assembled.contextObservations();
    const result = await build(f.input, [], { metadataTokenBudget: 0, observations });
    const item = result.plan.items.find((entry) => entry.source.sourceKind === "extension")!;
    assert.ok(item);
    assert.equal(item.source.trustLevel, "untrusted");
    assert.equal(item.source.locator, `artifact:${loaded!.artifactId}`);
    assert.ok(result.rendered.includes(action.proposalId));
    assert.ok(result.rendered.includes("Read the exact fixtures"));
    assert.equal(result.taskInputs.find((entry) => entry.ref === item.ref)?.mandatory, false);
    await f.service.disable("context-fixture");
    await assert.rejects(f.assembled.contextObservations(), /active|unavailable/i);
  } finally { await f.assembled.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Skill text must name its own explicit task resources and cannot borrow another file's lease", async () => {
  const f = await fixture();
  const confined = await assembleTaskExtensions(f.service, f.session, f.project, ["input.txt"], undefined, {
    paths: resolveKeystonePaths(join(f.root, "home")),
    operationDecision: () => { throw new Error("fs.read must not ask for irreversible consent"); },
  });
  try {
    const skill = confined.skills[0]!;
    await assert.rejects(skill.load({ kind: "body" }), /explicit task resource/i);
    await assert.rejects(skill.load({ kind: "resource", path: "resources/guide.txt" }), /explicit task resource/i);
    await assert.rejects(skill.load({ kind: "resource", path: "scripts/run.mjs" }), /declared Skill resource/i);
    assert.equal(f.session.events().filter((event) => event.type === "lease.issued").length, 0);
    await f.assembled.skills[0]!.load({ kind: "body" });
    assert.deepEqual((f.session.events().find((event) => event.type === "lease.issued")!.payload.resource as {
      values: string[];
    }).values, ["skills/context-fixture/SKILL.md"]);
  } finally { await confined.close(); await f.assembled.close(); await rm(f.root, { recursive: true, force: true }); }
});
