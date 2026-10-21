import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newId, sha256Bytes, type ExtensionManifest, type UserDecision } from "@keystone/schemas";
import * as extensions from "../src/index.ts";

const source = [
  "globalThis.extensionImportedInParent = true;",
  "export const verifier = {",
  "descriptor: { id: 'fixture', version: '1.0.0', kind: 'project_rule',",
  "evidenceLevel: 'E1', canSatisfyRequiredCondition: false,",
  "independence: { mode: 'same_process', independentOf: [] } },",
  "run: async () => ({ status: 'passed', summary: 'fixture', outputBytes: 0, truncated: false, durationMs: 0 }) };",
].join("\n");

async function fixture(root: string, name = "fixture-verifier", overrides: Record<string, unknown> = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "entry.mjs"), source);
  const manifest = {
    name, version: "1.0.0", publisher: "fixture",
    integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
    kind: "verifier", apiVersion: "1.0", capabilities: ["fs.read"],
    sideEffects: [{ kind: "fs_read" }], reversibility: "reversible",
    egressHosts: [], credentialHandles: [],
    dataClassification: { reads: "internal", egress: [] },
    produces: { observations: ["check"], evidenceTypes: ["project_rule_check"] },
    execution: { replayable: true, idempotent: true },
    dependencies: [], conflicts: [], uninstall: "safe",
    entry: { module: "entry.mjs", export: "verifier" }, ...overrides,
  } as ExtensionManifest;
  await writeFile(join(dir, "keystone-extension.json"), JSON.stringify(manifest));
  return { dir, manifest };
}

function approval(resource: string, overrides: Record<string, unknown> = {}): UserDecision {
  return {
    decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"),
    at: new Date().toISOString(), decision: "allow", rationale: "fixture approval",
    recordedBy: "user", appliesTo: { capability: "extension.activate", resources: [resource] },
    ...overrides,
  } as unknown as UserDecision;
}

function service(root: string) {
  assert.equal(typeof extensions.ExtensionLifecycleService, "function", "public lifecycle service is required");
  return new extensions.ExtensionLifecycleService({ registryFile: join(root, "registry.json") });
}

test("lifecycle review/install never imports code; probe requires a version/hash-bound user decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-lifecycle-"));
  try {
    const { dir } = await fixture(root);
    const svc = service(root);
    const reviewed = await svc.review(dir);
    assert.equal(reviewed.phase, "static");
    await assert.rejects(svc.install(dir, reviewed.reviewHash, false), /confirm/i);
    await assert.rejects(svc.install(dir, "0".repeat(64), true), /changed|hash/i);
    const installed = await svc.install(dir, reviewed.reviewHash, true);
    assert.equal(installed.status, "registered");
    assert.equal((globalThis as Record<string, unknown>).extensionImportedInParent, undefined);
    await assert.rejects(svc.activate(installed.manifest.name, { reviewHash: reviewed.reviewHash }), /conformance|probe/i);
    const resource = extensions.extensionDecisionResource(installed.manifest, reviewed.reviewHash, "probe");
    for (const decision of [
      approval("unrelated"),
      approval(resource, { decision: "deny" }),
      approval(resource, { recordedBy: "model" }),
      approval(resource, { appliesTo: { resources: [resource], expiresAt: "2000-01-01T00:00:00.000Z" } }),
    ]) await assert.rejects(svc.probe(installed.manifest.name, { reviewHash: reviewed.reviewHash, decision }));
    const probed = await svc.probe(installed.manifest.name, {
      reviewHash: reviewed.reviewHash, decision: approval(resource),
    });
    assert.equal(probed.conformance.passed, true);
    assert.equal((globalThis as Record<string, unknown>).extensionImportedInParent, undefined);
    await svc.activate(installed.manifest.name, { reviewHash: reviewed.reviewHash });
    const [view] = await service(root).list();
    assert.equal(view?.status, "active");
    assert.equal(view?.reviewHash, reviewed.reviewHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("upgrade diff and retained history reject old review hashes; uninstall never deletes user code", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-upgrade-"));
  try {
    const { dir } = await fixture(root);
    const svc = service(root);
    const before = await svc.review(dir);
    await svc.install(dir, before.reviewHash, true);
    await fixture(root, "fixture-verifier", {
      version: "2.0.0", capabilities: ["fs.read", "fs.write"],
      sideEffects: [{ kind: "fs_read" }, { kind: "fs_write" }],
    });
    const next = await svc.review(dir);
    assert.equal(next.upgrade?.fromVersion, "1.0.0");
    assert.equal(next.upgrade?.permissionsChanged, true);
    assert.deepEqual(next.upgrade?.addedCapabilities, ["fs.write"]);
    assert.ok(next.upgrade?.changedFiles.includes("keystone-extension.json"));
    await assert.rejects(svc.install(dir, before.reviewHash, true), /changed|hash/i);
    await svc.install(dir, next.reviewHash, true);
    await assert.rejects(svc.probe("fixture-verifier", {
      reviewHash: before.reviewHash,
      decision: approval(extensions.extensionDecisionResource(next.read.manifest, before.reviewHash, "probe")),
    }), /hash|changed/i);
    const [view] = await svc.list();
    assert.equal(view?.history.length, 1);
    assert.equal(view?.history[0]?.registration.manifest.version, "1.0.0");
    await assert.rejects(svc.rollback("fixture-verifier", before.reviewHash, true), /changed|hash/i);
    await svc.disable("fixture-verifier");
    await svc.uninstall("fixture-verifier");
    await access(join(dir, "entry.mjs"));
    const [removed] = await service(root).list();
    assert.equal(removed?.lifecycleStatus, "uninstalled");
    assert.equal(removed?.history.length, 1);
    await assert.rejects(svc.activate("fixture-verifier", { reviewHash: next.reviewHash }), /uninstalled/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing dependencies and active integrity mismatch fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-dependencies-"));
  try {
    const { dir } = await fixture(root, "dependent", { dependencies: [{ name: "missing", range: "^1.0.0" }] });
    const svc = service(root);
    const reviewed = await svc.review(dir);
    assert.ok(reviewed.blockers.some((reason) => reason.includes("missing")));
    await assert.rejects(svc.install(dir, reviewed.reviewHash, true), /missing/);
    await fixture(root, "dependent");
    const ready = await svc.review(dir);
    await svc.install(dir, ready.reviewHash, true);
    await svc.probe("dependent", {
      reviewHash: ready.reviewHash,
      decision: approval(extensions.extensionDecisionResource(ready.read.manifest, ready.reviewHash, "probe")),
    });
    await svc.activate("dependent", { reviewHash: ready.reviewHash });
    await writeFile(join(dir, "helper.mjs"), "export const tampered = true;");
    await assert.rejects(svc.assertUsable("dependent", ready.reviewHash), /integrity|changed/i);
    assert.equal((await svc.list())[0]?.status, "isolated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("independent registry writers merge updates instead of losing entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-registry-concurrent-"));
  try {
    const { manifest: first } = await fixture(root, "first");
    const { manifest: second } = await fixture(root, "second");
    const location = { registryFile: join(root, "registry.json") };
    const a = new extensions.ExtensionRegistry(location);
    const b = new extensions.ExtensionRegistry(location);
    await Promise.all([a.load(), b.load()]);
    await Promise.all([a.register({
      manifest: first, source: { kind: "local_path", locator: root }, integrityVerified: true,
    }), b.register({
      manifest: second, source: { kind: "local_path", locator: root }, integrityVerified: true,
    })]);
    await a.load();
    assert.deepEqual(a.list().map((entry) => entry.manifest.name), ["first", "second"]);
    await Promise.all([a.disable("first"), b.disable("second")]);
    await a.load();
    assert.deepEqual(a.list().map((entry) => entry.status), ["disabled", "disabled"]);
    const persisted = JSON.parse(await readFile(location.registryFile, "utf8"));
    assert.equal(persisted.entries.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
