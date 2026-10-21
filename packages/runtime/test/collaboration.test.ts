import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEvent, chainTip } from "@keystone/kernel";
import { canonicalJson, contentHash, newId, provenanceRefSchema, sha256Bytes, sha256Hex } from "@keystone/schemas";
import {
  CollaborationService, importCandidate, previewBundle, signDocument, verifyDocument,
} from "../src/collaboration/index.ts";

const now = new Date("2026-10-21T12:00:00.000Z");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const peers = [{ identityId: "alice", publicKey, revoked: false }];
const binding = {
  purpose: "proof", taskId: newId("task"), contractDigest: sha256Hex("contract"),
  conditionIds: ["cond.test"], environmentDigest: sha256Hex("environment"),
  issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
};
const expected = {
  purpose: binding.purpose, taskId: binding.taskId, contractDigest: binding.contractDigest,
  conditionIds: binding.conditionIds, environmentDigest: binding.environmentDigest,
};

test("Ed25519 canonical signatures preserve all claims, levels and trust without deciding completion", () => {
  const document = { level: "E0", trustLevel: "untrusted", outcome: "not_proven", data: { b: 2, a: 1 } };
  const signed = signDocument(document, binding, "alice", keys.privateKey);
  const verified = verifyDocument(signed, { peers, expected, now });
  assert.equal(verified.ok, true);
  assert.deepEqual(signed.document, document);
  assert.equal(verified.authority, "integrity_only");
  assert.equal(verifyDocument({ ...signed, document: { ...document, data: { a: 1, b: 2 } } },
    { peers, expected, now }).ok, true);
  assert.equal(verifyDocument({ ...signed, document: { ...document, level: "E4" } },
    { peers, expected, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers, expected: { ...expected, taskId: newId("task") }, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers, expected: { ...expected, environmentDigest: sha256Hex("other") }, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers, expected: { ...expected, contractDigest: sha256Hex("other") }, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers, expected: { ...expected, conditionIds: ["other"] }, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers: [{ ...peers[0]!, identityId: "mallory" }], expected, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers: [{ ...peers[0]!, revoked: true }], expected, now }).ok, false);
  assert.equal(verifyDocument(signed, { peers, expected, now: new Date(binding.expiresAt) }).ok, false);
  const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyDocument(signed, { peers: [{ ...peers[0]!, publicKey: wrongKey }], expected, now }).ok, false);
  assert.throws(() => signDocument({ apiKey: "example-not-a-real-key" }, binding, "alice", keys.privateKey), /secret/i);
});

async function bundleFixture() {
  const root = await mkdtemp(join(tmpdir(), "keystone-collaboration-"));
  const taskId = newId("task");
  const branchId = newId("branch");
  const bytes = Buffer.from("local observation\n");
  const digest = sha256Bytes(bytes);
  const artifactId = `art_${digest}`;
  const events = [buildEvent({
    taskId, branchId, type: "task.created", actorKind: "kernel", actorId: "fixture",
    payload: { projectId: newId("proj"), request: "fixture", requestedBy: "user", references: [] },
  }, chainTip([]))];
  events.push(buildEvent({
    taskId, branchId, type: "action.executed", actorKind: "tool", actorId: "fixture",
    payload: { proposalId: newId("prop"), status: "succeeded", durationMs: 1,
      changedPaths: [], outputArtifactId: artifactId },
  }, chainTip(events)));
  const ledger = `${events.map((event) => canonicalJson(event)).join("\n")}\n`;
  const artifactPath = `artifacts/${digest.slice(0, 2)}/${digest}`;
  await mkdir(join(root, "artifacts", digest.slice(0, 2)), { recursive: true });
  await writeFile(join(root, artifactPath), bytes);
  await writeFile(join(root, "ledger.jsonl"), ledger);
  const manifest = {
    version: "keystone.task-bundle/1", taskId, branchId,
    environmentDigest: binding.environmentDigest,
    ledger: { path: "ledger.jsonl", sha256: sha256Hex(ledger), tipHash: events.at(-1)!.hash, eventCount: events.length },
    artifacts: [{ artifactId, path: artifactPath, sha256: digest, bytes: bytes.length }],
  };
  await writeFile(join(root, "manifest.json"), canonicalJson(manifest));
  return { root, manifest, ledger, artifactPath };
}

test("portable bundle validates real kernel ledger and hash artifacts without executing or trusting them", async () => {
  const fixture = await bundleFixture();
  try {
    const before = await readFile(join(fixture.root, "ledger.jsonl"), "utf8");
    const preview = await previewBundle(fixture.root);
    assert.equal(preview.taskId, fixture.manifest.taskId);
    assert.equal(preview.authority, "imported_candidate");
    assert.equal(preview.digest, contentHash(fixture.manifest));
    assert.equal(preview.events.length, 2);
    assert.equal(await readFile(join(fixture.root, "ledger.jsonl"), "utf8"), before);
    await writeFile(join(fixture.root, fixture.artifactPath), "tampered");
    await assert.rejects(() => previewBundle(fixture.root), /artifact/i);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("bundle refuses chain tamper, missing artifacts, mixed identity and secret fields", async () => {
  const fixture = await bundleFixture();
  try {
    const rows = fixture.ledger.trim().split("\n").map((line) => JSON.parse(line));
    rows[1].payload.durationMs = 999;
    const tampered = `${rows.map((row) => canonicalJson(row)).join("\n")}\n`;
    await writeFile(join(fixture.root, "ledger.jsonl"), tampered);
    await writeFile(join(fixture.root, "manifest.json"), canonicalJson({
      ...fixture.manifest, ledger: { ...fixture.manifest.ledger, sha256: sha256Hex(tampered) },
    }));
    await assert.rejects(() => previewBundle(fixture.root), /ledger/i);
    await writeFile(join(fixture.root, "ledger.jsonl"), fixture.ledger);
    await writeFile(join(fixture.root, "manifest.json"), canonicalJson({ ...fixture.manifest, taskId: newId("task") }));
    await assert.rejects(() => previewBundle(fixture.root), /identity/i);
    await writeFile(join(fixture.root, "manifest.json"), canonicalJson({ ...fixture.manifest, artifacts: [] }));
    await assert.rejects(() => previewBundle(fixture.root), /missing artifact/i);
    await writeFile(join(fixture.root, "manifest.json"), canonicalJson({ ...fixture.manifest, token: "example" }));
    await assert.rejects(() => previewBundle(fixture.root), /secret/i);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("bundle rejects traversal, absolute and Windows paths, symlinks and torn records", async () => {
  const fixture = await bundleFixture();
  try {
    for (const path of ["../ledger.jsonl", "/ledger.jsonl", "C:\\ledger.jsonl", "a/../ledger.jsonl", "%2e%2e/ledger.jsonl"]) {
      await writeFile(join(fixture.root, "manifest.json"), canonicalJson({
        ...fixture.manifest, ledger: { ...fixture.manifest.ledger, path },
      }));
      await assert.rejects(() => previewBundle(fixture.root), /path/i);
    }
    await writeFile(join(fixture.root, "manifest.json"), canonicalJson(fixture.manifest));
    await rm(join(fixture.root, fixture.artifactPath));
    await symlink(join(fixture.root, "ledger.jsonl"), join(fixture.root, fixture.artifactPath));
    await assert.rejects(() => previewBundle(fixture.root), /symlink/i);
    await writeFile(join(fixture.root, "ledger.jsonl"), fixture.ledger.trimEnd());
    await assert.rejects(() => previewBundle(fixture.root), /ledger/i);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("shared facts and experience retain upstream provenance and explicit unresolved conflicts", () => {
  for (const kind of ["fact", "experience"] as const) {
    const source = provenanceRefSchema.parse({ provenanceId: newId("prov"), sourceKind: "repository", trustLevel: "verified",
      locator: "team/project", derivedFrom: [], invalidatedBy: [], observedAt: now.toISOString() });
    const candidate = importCandidate({ kind, key: "refresh-rule", statement: "refresh once",
      source, sourceIdentity: "alice", sourceDigest: sha256Hex("source") },
    [{ id: "local.rule", key: "refresh-rule", statement: "refresh twice" }]);
    assert.equal(candidate.status, "imported_candidate");
    assert.equal(candidate.trustLevel, "untrusted");
    assert.deepEqual(candidate.source, source);
    assert.deepEqual(candidate.conflicts, ["local.rule"]);
  }
});

test("service exposes read-only status and defaults to denying import and adoption without parent admission", async () => {
  const fixture = await bundleFixture();
  try {
    const service = new CollaborationService({ peers: () => peers, bundleRoots: [fixture.root], now: () => now });
    const status = await service.handle("GET", "/v1/collaboration");
    assert.equal(status.status, 200);
    assert.equal((status.body as { externalCompatibility: string }).externalCompatibility, "local-fixture-only");
    const preview = await service.preview({ root: fixture.root });
    await assert.rejects(() => service.importBundle({ root: fixture.root, digest: preview.digest,
      destination: join(fixture.root, "import"), decisionId: "decision" }), /admission/i);
    await assert.rejects(() => service.preview({ root: tmpdir() }), /root/i);
    const verified = await service.handle("POST", "/v1/collaboration/verify",
      { signed: signDocument({ level: "E0" }, binding, "alice", keys.privateKey), expected });
    assert.equal((verified.body as { ok: boolean }).ok, true);
    const candidate = service.share({ kind: "fact", key: "k", statement: "s", source: provenanceRefSchema.parse({
      provenanceId: newId("prov"), sourceKind: "repository", trustLevel: "observed",
      locator: "team", derivedFrom: [], invalidatedBy: [], observedAt: now.toISOString(),
    }), sourceIdentity: "alice", sourceDigest: sha256Hex("s") }, []);
    await assert.rejects(() => service.adopt({ candidateId: candidate.candidateId, decisionId: "decision",
      digest: contentHash(candidate), resolveConflicts: [] }), /admission/i);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("import and adoption require exact reviewed digests, unused bounded destinations and explicit conflict decisions", async () => {
  const fixture = await bundleFixture();
  const target = await mkdtemp(join(tmpdir(), "keystone-import-"));
  let imports = 0;
  let adoptions = 0;
  try {
    const service = new CollaborationService({
      peers: () => peers, bundleRoots: [fixture.root], importRoots: [target],
      admission: {
        importBundle: async ({ destination, bundle }) => {
          imports++; assert.equal(bundle.authority, "imported_candidate");
          return { destination, eventId: "parent.import-event" };
        },
        adoptCandidate: async ({ candidate }) => {
          adoptions++; assert.equal(candidate.trustLevel, "untrusted");
          return { eventId: "parent.adoption-event" };
        },
      },
    });
    const preview = await service.preview({ root: fixture.root });
    const request = { root: fixture.root, digest: preview.digest, destination: join(target, "new-task"), decisionId: "local-decision" };
    await assert.rejects(() => service.importBundle({ ...request, digest: sha256Hex("other") }), /digest/i);
    await assert.rejects(() => service.importBundle({ ...request, destination: target }), /destination/i);
    await assert.rejects(() => service.importBundle({ ...request, destination: join(fixture.root, "outside") }), /destination/i);
    await symlink(fixture.root, join(target, "link"));
    await assert.rejects(() => service.importBundle({ ...request, destination: join(target, "link", "task") }), /symlink/i);
    assert.equal(imports, 0);
    assert.equal((await service.importBundle(request)).eventId, "parent.import-event");
    await assert.rejects(() => readFile(request.destination));
    const candidate = service.share({ kind: "experience", key: "rule", statement: "once",
      source: provenanceRefSchema.parse({ provenanceId: newId("prov"), sourceKind: "repository", trustLevel: "verified",
        locator: "team", derivedFrom: [], invalidatedBy: [], observedAt: now.toISOString() }),
      sourceIdentity: "alice", sourceDigest: sha256Hex("candidate") },
    [{ id: "local.rule", key: "rule", statement: "twice" }]);
    const adoption = { candidateId: candidate.candidateId, digest: contentHash(candidate), decisionId: "local-decision", resolveConflicts: ["local.rule"] };
    await assert.rejects(() => service.adopt({ ...adoption, resolveConflicts: [] }), /conflict/i);
    await assert.rejects(() => service.adopt({ ...adoption, digest: sha256Hex("other") }), /digest/i);
    assert.equal(adoptions, 0);
    await service.adopt(adoption);
    assert.equal(adoptions, 1);
    assert.equal(service.status().candidates[0]!.status, "imported_candidate");
    assert.equal(service.status().candidates[0]!.source.trustLevel, "verified");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
