import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeEventHash, foldTaskState, KernelSession, projectIdForWorkspace,
  resolveKeystonePaths, verifyChain,
} from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { canonicalJson, contentHash, newId, sha256Bytes, type RunEvent } from "@keystone/schemas";
import { createLocalCollaboration, previewBundle } from "../src/collaboration/index.ts";
import { collectPreview, collectTaskBundle } from "../src/collaboration/local-io.ts";
import { maintenanceSession } from "../src/collaboration/local-session.ts";
import { bundleManifestSchema } from "../src/collaboration/signatures.ts";
import { forkContinuousBranch } from "../src/continuous-branches.ts";
import { removeIsolatedWorkspace } from "../src/isolation.ts";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import {
  autonomyFor, BUGGY_SESSION, envelopeFor, FINISH_ACTION, FIXED_SESSION,
  makeFixture, removeFixture, writeAction,
} from "./fixture.ts";

const ledgerBytes = (events: readonly RunEvent[]) =>
  Buffer.from(`${events.map((event) => canonicalJson(event)).join("\n")}\n`);

test("runtime historical fork exports with opt-in, previews and quarantines unchanged inherited bytes", async () => {
  const fixture = await makeFixture();
  let workspace: string | undefined;
  let local: ReturnType<typeof createLocalCollaboration> | undefined;
  try {
    const descriptor = scriptedModelDescriptor({ id: "portable-fork" });
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor, responses: [
        envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
        envelopeFor([FINISH_ACTION]),
      ] }),
    ] });
    const source = await runtime.runTask({
      workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }],
      autonomy: autonomyFor(["src/auth/**"]), acceptContractAutomatically: true, maxSteps: 2,
    });
    assert.equal(source.status, "proven");
    const parent = await KernelSession.open({ paths: fixture.paths, taskId: source.taskId });
    const parentBytes = await readFile(fixture.paths.ledgerFile(source.taskId));
    const checkpoint = parent.events().find((event) => event.type === "checkpoint.created");
    assert.ok(checkpoint);
    assert.ok(checkpoint.seq < parent.events().at(-1)!.seq, "fork point must be historical");
    const branch = await forkContinuousBranch(fixture.paths, source.taskId, {
      checkpointId: String(checkpoint.payload.checkpointId), label: "portable historical fork",
    });
    workspace = branch.workspacePath;
    assert.ok(workspace);
    assert.equal(await readFile(join(workspace, "src/auth/session.js"), "utf8"), BUGGY_SESSION);
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), FIXED_SESSION);
    const fork = await KernelSession.open({
      paths: fixture.paths, taskId: source.taskId, branchId: branch.branchId,
    });
    assert.equal(fork.state().branchId, branch.branchId);
    assert.ok(["executing", "verifying", "auto_repairing"].includes(fork.state().status));
    assert.equal(fork.replay().consistent, true);
    const inherited = Buffer.from(parentBytes.toString("utf8").split("\n").slice(0, checkpoint.seq).join("\n") + "\n");
    const forkBytes = await readFile(fixture.paths.branchLedgerFile(source.taskId, branch.branchId));
    assert.deepEqual(forkBytes.subarray(0, inherited.length), inherited);
    assert.equal(fork.events()[checkpoint.seq]!.type, "branch.created");
    assert.equal(fork.events()[checkpoint.seq]!.branchId, branch.branchId);
    assert.equal(verifyChain(fork.events()).ok, true);

    const projectId = await projectIdForWorkspace(fixture.root);
    local = createLocalCollaboration({ paths: () => fixture.paths, projects: async () => [{
      projectId, workspaceId: projectId, rootPath: fixture.root, name: "Fixture",
      status: "available", tasks: [source.taskId],
    }] });
    const call = (path: string, body: unknown) => local!.service.handle(
      "POST", `/v1/collaboration${path}`, body, { authenticated: true, source: "local_ui" },
    );
    const request = { projectId, taskId: source.taskId, branchId: branch.branchId, confirmed: true };
    const exported = await call("/export", { ...request, includeRecoveryWorkspace: true });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const refused = await call("/export", request);
    assert.equal(refused.status, 400);
    assert.match(refused.body.reason, /capsule|recovery/i);
    const reviewed = await call("/preview", { root: exported.body.root });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    const preview = await previewBundle(exported.body.root);
    assert.equal(preview.branchId, branch.branchId);
    assert.notEqual(preview.branchId, parent.branchId);
    assert.equal(preview.includesRecoveryWorkspace, true);
    assert.equal(preview.authority, "imported_candidate");
    assert.equal(foldTaskState(preview.events).branchId, branch.branchId);
    assert.deepEqual(await readFile(join(preview.root, "ledger.jsonl")), forkBytes);
    for (const artifact of preview.artifacts) {
      assert.deepEqual(await readFile(join(preview.root, artifact.path)),
        await readFile(join(fixture.paths.artifactsDir, artifact.sha256.slice(0, 2), artifact.sha256)));
    }
    assert.deepEqual((await collectPreview(preview)).files.get("ledger.jsonl"), forkBytes);
    const imported = await call("/import", {
      projectId, root: exported.body.root, digest: preview.digest, confirmed: true,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.authority, "imported_candidate");
    assert.equal(imported.body.trustLevel, "untrusted");
    const quarantined = await previewBundle(imported.body.destination);
    assert.equal(quarantined.branchId, branch.branchId);
    assert.equal(quarantined.digest, preview.digest);
    for (const path of ["manifest.json", "ledger.jsonl", ...preview.artifacts.map((artifact) => artifact.path)]) {
      assert.deepEqual(await readFile(join(imported.body.destination, path)), await readFile(join(preview.root, path)));
    }
    const receipt = await KernelSession.open({ paths: fixture.paths, taskId: imported.body.taskId });
    assert.equal(receipt.events().some((event) => event.type === "evidence.recorded" ||
      event.type.startsWith("proof.") || event.type === "branch.created"), false);
    assert.deepEqual(await readFile(fixture.paths.ledgerFile(source.taskId)), parentBytes);
    assert.deepEqual(await readFile(fixture.paths.branchLedgerFile(source.taskId, branch.branchId)), forkBytes);
  } finally {
    await local?.dispose();
    if (workspace) await removeIsolatedWorkspace(fixture.root, workspace);
    await removeFixture(fixture);
  }
});

// Refusal fixtures do not depend on export succeeding or the roundtrip test running.
async function historyFixture() {
  const home = await mkdtemp(join(tmpdir(), "keystone-portable-history-"));
  const paths = resolveKeystonePaths(home);
  const projectId = newId("proj");
  const parent = await maintenanceSession(paths, {
    projectId, workspaceId: projectId, rootPath: home, name: "Portable history", status: "available",
  }, { goal: "Verify portable history", resources: ["src/**"] });
  const checkpoint = await parent.checkpoint("pre_branch");
  await parent.recordBudget({ tokens: 7, wallClockMs: 1, reason: "excluded parent suffix" });
  const branch = await parent.branch("child", "historical test", { checkpointId: checkpoint.checkpointId });
  const fork = await KernelSession.open({ paths, taskId: parent.taskId, branchId: branch.branchId });
  await fork.recordBudget({ tokens: 1, wallClockMs: 1, reason: "child observation" });
  await fork.recordBranchWorkspace(join(home, "fork"));
  const events = [...fork.events()];
  assert.equal(verifyChain(events).ok, true);
  return { home, paths, parent, branch, fork, events, root: join(home, "candidate") };
}
type HistoryFixture = Awaited<ReturnType<typeof historyFixture>>;

function rehash(events: readonly RunEvent[]): RunEvent[] {
  let prevHash: RunEvent["prevHash"] = null;
  return events.map((event, index) => {
    const next = { ...event, seq: index + 1, prevHash };
    const hashed = { ...next, hash: computeEventHash(next) };
    prevHash = hashed.hash;
    return hashed;
  });
}

function replacePayload(events: RunEvent[], index: number, changes: Record<string, unknown>) {
  const event = events[index]!;
  events[index] = { ...event, payload: { ...event.payload, ...changes } };
}

async function writeCandidate(fixture: HistoryFixture, events: readonly RunEvent[], branchId = fixture.branch.branchId) {
  const ledger = ledgerBytes(events);
  const manifest = bundleManifestSchema.parse({
    version: "keystone.task-bundle/1", taskId: fixture.parent.taskId, branchId,
    environmentDigest: contentHash([]),
    ledger: { path: "ledger.jsonl", sha256: sha256Bytes(ledger), tipHash: events.at(-1)!.hash, eventCount: events.length },
    artifacts: [],
  });
  await mkdir(fixture.root, { recursive: true });
  await writeFile(join(fixture.root, "ledger.jsonl"), ledger);
  await writeFile(join(fixture.root, "manifest.json"), canonicalJson(manifest));
}

test("preview independently accepts committed child history and same-child workspace binding", async () => {
  const fixture = await historyFixture();
  try {
    await writeCandidate(fixture, fixture.events);
    const preview = await previewBundle(fixture.root);
    assert.equal(preview.branchId, fixture.branch.branchId);
    assert.equal(preview.events.filter((event) => event.type === "branch.created").length, 2);
    const bundle = await collectTaskBundle(fixture.paths, fixture.parent.taskId, fixture.branch.branchId);
    assert.deepEqual(bundle.files.get("ledger.jsonl"), ledgerBytes(fixture.events));
    assert.equal(JSON.parse(bundle.files.get("manifest.json")!.toString("utf8")).branchId, fixture.branch.branchId);
  } finally { await rm(fixture.home, { recursive: true, force: true }); }
});

test("portable history accepts nested committed forks without relabeling either ancestor", async () => {
  const fixture = await historyFixture();
  try {
    const checkpoint = await fixture.fork.checkpoint("pre_branch");
    const nested = await fixture.fork.branch("grandchild", "nested fork", { checkpointId: checkpoint.checkpointId });
    const grandchild = await KernelSession.open({
      paths: fixture.paths, taskId: fixture.parent.taskId, branchId: nested.branchId,
    });
    const events = grandchild.events();
    const original = ledgerBytes(fixture.fork.events());
    assert.deepEqual(ledgerBytes(events).subarray(0, original.length), original);
    await writeCandidate(fixture, events, nested.branchId);
    assert.equal((await previewBundle(fixture.root)).branchId, nested.branchId);
    const bundle = await collectTaskBundle(fixture.paths, fixture.parent.taskId, nested.branchId);
    assert.deepEqual(bundle.files.get("ledger.jsonl"), ledgerBytes(events));
  } finally { await rm(fixture.home, { recursive: true, force: true }); }
});

const invalidHistories: readonly {
  name: string; mutate: (events: RunEvent[], fixture: HistoryFixture, transition: number, checkpoint: number) => void;
}[] = [
  { name: "branch switch without branch.created", mutate(events, _fixture, transition) {
    const event = events[transition]!;
    events[transition] = { ...event, type: "budget.consumed",
      payload: { ...events.findLast((row) => row.type === "budget.consumed")!.payload,
        reason: "uncommitted switch" } };
  } },
  { name: "foreign event task", mutate(events, _fixture, transition) {
    events[transition] = { ...events[transition]!, taskId: newId("task") as RunEvent["taskId"] };
  } },
  { name: "foreign branch payload task", mutate(events, _fixture, transition) {
    replacePayload(events, transition, { taskId: newId("task") });
  } },
  { name: "branch payload different from event branch", mutate(events, _fixture, transition) {
    replacePayload(events, transition, { branchId: newId("branch") });
  } },
  { name: "wrong current parent branch", mutate(events, _fixture, transition) {
    replacePayload(events, transition, { forkedFromBranchId: newId("branch") });
  } },
  { name: "missing parent branch", mutate(events, _fixture, transition) {
    const payload = { ...events[transition]!.payload };
    delete payload.forkedFromBranchId;
    events[transition] = { ...events[transition]!, payload };
  } },
  { name: "uncommitted parent checkpoint", mutate(events, _fixture, transition) {
    replacePayload(events, transition, { parentCheckpointId: newId("ckpt") });
  } },
  { name: "missing parent checkpoint", mutate(events, _fixture, transition) {
    const payload = { ...events[transition]!.payload };
    delete payload.parentCheckpointId;
    events[transition] = { ...events[transition]!, payload };
  } },
  { name: "parent suffix past the selected checkpoint", mutate(events, fixture, transition) {
    const observation = events.findLast((event) => event.type === "budget.consumed")!;
    events.splice(transition, 0, { ...observation, branchId: fixture.parent.branchId,
      eventId: newId("evt") as RunEvent["eventId"] });
  } },
  { name: "checkpoint state contradicting the inherited Contract", mutate(events, _fixture, transition, checkpoint) {
    const state = events[checkpoint]!.payload.state as Record<string, unknown>;
    replacePayload(events, checkpoint, { contractVersion: 999, state: { ...state, contractVersion: 999 } });
    replacePayload(events, transition, { contractVersion: 999 });
    replacePayload(events, events.length - 1, { contractVersion: 999 });
  } },
  { name: "foreign checkpoint task", mutate(events, _fixture, _transition, checkpoint) {
    replacePayload(events, checkpoint, { taskId: newId("task") });
  } },
  { name: "foreign checkpoint branch", mutate(events, _fixture, _transition, checkpoint) {
    replacePayload(events, checkpoint, { branchId: newId("branch") });
  } },
  { name: "wrong checkpoint prefix position", mutate(events, _fixture, _transition, checkpoint) {
    replacePayload(events, checkpoint, { seq: 0 });
  } },
  { name: "wrong checkpoint state branch", mutate(events, _fixture, _transition, checkpoint) {
    const state = events[checkpoint]!.payload.state as Record<string, unknown>;
    replacePayload(events, checkpoint, { state: { ...state, branchId: newId("branch") } });
  } },
  { name: "branch contract differs from checkpoint", mutate(events, _fixture, transition) {
    replacePayload(events, transition, { contractVersion: 999 });
  } },
  { name: "same-child binding changes ancestry", mutate(events) {
    replacePayload(events, events.length - 1, { forkedFromBranchId: newId("branch") });
  } },
  { name: "same-child binding changes checkpoint", mutate(events) {
    replacePayload(events, events.length - 1, { parentCheckpointId: newId("ckpt") });
  } },
  { name: "same-child binding changes contract", mutate(events) {
    replacePayload(events, events.length - 1, { contractVersion: 999 });
  } },
  { name: "switch back to an ancestor", mutate(events, fixture) {
    const index = events.length - 1;
    events[index] = { ...events[index]!, branchId: fixture.parent.branchId, payload: {
      ...events[index]!.payload, branchId: fixture.parent.branchId, forkedFromBranchId: fixture.branch.branchId,
    } };
  } },
];

for (const { name, mutate } of invalidHistories) {
  test(`export and independent preview refuse hash-valid ${name}`, async () => {
    const fixture = await historyFixture();
    try {
      const events = [...fixture.events];
      const transition = events.findIndex((event) => event.type === "branch.created");
      const checkpoint = events.findIndex((event) => event.type === "checkpoint.created");
      mutate(events, fixture, transition, checkpoint);
      // Recompute capsule integrity too: identity checks cannot rely on stale digests.
      for (let index = 0; index < events.length; index++) {
        if (events[index]!.type !== "checkpoint.created") continue;
        const { integrity: _integrity, ...fields } = events[index]!.payload;
        replacePayload(events, index, { integrity: contentHash(fields) });
      }
      const invalid = rehash(events);
      assert.equal(verifyChain(invalid).ok, true, "negative fixture must pass schema and chain validation");
      await writeCandidate(fixture, invalid);
      await assert.rejects(() => previewBundle(fixture.root), /ledger|identity|branch|checkpoint/i);
      await writeFile(fixture.paths.branchLedgerFile(fixture.parent.taskId, fixture.branch.branchId), ledgerBytes(invalid));
      await assert.rejects(() => collectTaskBundle(fixture.paths, fixture.parent.taskId, fixture.branch.branchId),
        /ledger|identity|branch|checkpoint/i);
    } finally { await rm(fixture.home, { recursive: true, force: true }); }
  });
}

test("independent preview refuses a manifest naming genesis rather than the final branch", async () => {
  const fixture = await historyFixture();
  try {
    await writeCandidate(fixture, fixture.events, fixture.parent.branchId);
    await assert.rejects(() => previewBundle(fixture.root), /identity|branch/i);
  } finally { await rm(fixture.home, { recursive: true, force: true }); }
});

test("export refuses a selected branch file whose committed logical identity differs", async () => {
  const fixture = await historyFixture();
  try {
    const wrongBranch = newId("branch") as RunEvent["branchId"];
    const target = fixture.paths.branchLedgerFile(fixture.parent.taskId, wrongBranch);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, ledgerBytes(fixture.events));
    await assert.rejects(() => collectTaskBundle(fixture.paths, fixture.parent.taskId, wrongBranch), /ledger|identity|branch/i);
  } finally { await rm(fixture.home, { recursive: true, force: true }); }
});

test("export and independent preview refuse inherited event tamper even with an updated manifest digest", async () => {
  const fixture = await historyFixture();
  try {
    const events = [...fixture.events];
    replacePayload(events, 0, { request: "tampered inherited request" });
    assert.equal(verifyChain(events).ok, false);
    await writeCandidate(fixture, events);
    await assert.rejects(() => previewBundle(fixture.root), /ledger|integrity/i);
    await writeFile(fixture.paths.branchLedgerFile(fixture.parent.taskId, fixture.branch.branchId), ledgerBytes(events));
    await assert.rejects(() => collectTaskBundle(fixture.paths, fixture.parent.taskId, fixture.branch.branchId),
      /ledger|integrity/i);
  } finally { await rm(fixture.home, { recursive: true, force: true }); }
});
