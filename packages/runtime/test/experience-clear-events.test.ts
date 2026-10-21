import assert from "node:assert/strict";
import fsPromises, { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExperienceFirewall, KernelSession, resolveKeystonePaths } from "@keystone/kernel";
import { compileContract } from "@keystone/pack-engineering";
import { autonomyEnvelopeSchema, contentHash, newId, nowIso, provenanceRefSchema,
  type ExperienceEntry, type ProjectId } from "@keystone/schemas";
import { clearProjectExperience, DataError } from "../src/data.ts";
import { changeExperience } from "../src/experience-actions.ts";
import { judgeExperienceUse } from "../src/learning.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), "keystone-experience-clear-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { paths: resolveKeystonePaths(home), projectId: newId("proj") as ProjectId };
}

async function sessionFor(f: Awaited<ReturnType<typeof fixture>>) {
  const budget = { maxTokens: 1000, maxWallClockMs: 60000, maxRetries: 0 };
  const session = await KernelSession.create({
    paths: f.paths, projectId: f.projectId, request: "experience test fixture",
    requestedBy: "user", proposeContract: compileContract,
  });
  await session.submit();
  await session.compile({
    profile: {
      projectId: f.projectId, rootPath: f.paths.home, name: "fixture", vcs: "git",
      languages: [], commands: [], instructionFiles: [],
      support: { status: "supported", reasons: [] }, createdAt: nowIso(), updatedAt: nowIso(),
    },
    budget,
    autonomy: autonomyEnvelopeSchema.parse({
      projectId: f.projectId, readPaths: [], writePaths: [], allowedCommands: [],
      allowedHosts: [], allowedCredentials: [], externalSystems: "none",
      maxReversibility: "reversible", untrustedContentEgress: "deny_all",
      budget, updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
    }),
  });
  await session.start();
  return session;
}

async function seeded(f: Awaited<ReturnType<typeof fixture>>, options: {
  candidateOnly?: boolean; frozen?: boolean; untrusted?: boolean;
} = {}) {
  const session = await sessionFor(f);
  const firewall = new ExperienceFirewall(f.paths, f.projectId, async (event) => {
    switch (event.type) {
      case "experience.candidate_created": return session.recordExperienceCandidate(event.value);
      case "experience.promoted": return session.recordExperiencePromotion({
        ...event.value, frozen: options.frozen ?? false,
      });
      case "experience.evaluated": return session.recordExperienceEvaluation(event.value);
      case "experience.demoted": return session.recordExperienceDemotion(event.value);
    }
  });
  const evidence = await session.recordEvidence({
    conditionIds: ["cond.target_tests"], workspaceSnapshotId: newId("snap"),
    level: "E2", producer: { kind: "verifier", id: "verifier.test", version: "1.0.0" },
    independence: { mode: "separate_process", independentOf: ["builder_loop_model"] },
    provenance: provenanceRefSchema.parse({
      provenanceId: newId("prov"), sourceKind: "verifier", trustLevel: "verified",
      locator: "fixture verifier", derivedFrom: [], invalidatedBy: [], observedAt: nowIso(),
    }),
    observation: { summary: "fixture check passed", exitCode: 0, truncated: false },
  });
  const candidate = await firewall.proposeCandidate({
    projectId: f.projectId, sourceTaskIds: [session.taskId], category: "patch_pattern",
    statement: "the auth module was changed in a verified task",
    applicability: { paths: ["src/auth"], symbols: [], languages: [],
      packageManagers: [], toolVersions: [], taskShapes: [] },
    provenance: options.untrusted ? { ...evidence.provenance, sourceKind: "model",
      trustLevel: "untrusted" } : evidence.provenance,
    supportingEvidenceIds: [evidence.evidenceId],
  });
  let entry: ExperienceEntry | undefined;
  if (!options.candidateOnly) {
    entry = await firewall.promote(candidate.candidateId, "deterministic_derivation");
    if (options.frozen) entry = { ...entry, frozen: true };
    await firewall.recordEvaluation({
      entryId: entry.entryId, taskId: session.taskId, used: true,
      outcome: "not_evaluable", judgeEvidenceIds: [], detail: "no control run",
    });
  }
  await session.stop("fixture complete");
  await KernelSession.rebuildProjectExperience({ paths: f.paths, projectId: f.projectId });
  return { entry, candidate, source: session };
}

async function assertNotSelectable(f: Awaited<ReturnType<typeof fixture>>) {
  await KernelSession.rebuildProjectExperience({ paths: f.paths, projectId: f.projectId });
  const firewall = new ExperienceFirewall(f.paths, f.projectId);
  await firewall.load();
  assert.deepEqual(firewall.selectForContext({ paths: ["src/auth"] }), []);
  return firewall;
}

function assertRejectionDecision(session: KernelSession, candidateId: string, reason: string) {
  const decision = session.events().find((event) => event.type === "intervention.decided" &&
    (event.payload["appliesTo"] as { resources?: string[] })?.resources?.includes(candidateId));
  assert.ok(decision);
  assert.equal(decision.taskId, session.taskId);
  assert.equal(decision.branchId, session.branchId);
  assert.equal(decision.payload["taskId"], session.taskId);
  assert.equal(decision.payload["branchId"], session.branchId);
  assert.equal(decision.payload["decision"], "allow");
  assert.equal(decision.payload["recordedBy"], "user");
  assert.deepEqual(decision.payload["appliesTo"], { resources: [candidateId] });
  assert.deepEqual(decision.payload["modifications"], {
    parametersHash: contentHash({ candidateId, reason }),
  });
  const rejection = session.events().find((event) => event.type === "experience.candidate_created" &&
    event.payload["candidateId"] === candidateId && event.payload["status"] === "rejected");
  assert.ok(rejection, "rejection must be a committed kernel event");
  assert.ok(rejection.seq > decision.seq, "the bound user decision must precede rejection");
  assert.equal(session.state().status, "stopped");
  assert.deepEqual(session.contract()?.scope, { include: [], exclude: [], unknown: [] });
  assert.deepEqual(session.contract()?.autonomy.readPaths, []);
  assert.deepEqual(session.contract()?.autonomy.writePaths, []);
  assert.deepEqual(session.contract()?.autonomy.allowedCommands, []);
  assert.deepEqual(session.contract()?.autonomy.allowedHosts, []);
  assert.equal(session.contract()?.budget.maxTokens, 0);
  assert.ok(!session.events().some((event) => event.type === "proof.satisfied"));
}

test("clear revokes reusable experience durably, preserves counts and never proves maintenance", async (t) => {
  const f = await fixture(t);
  const { entry, source } = await seeded(f);
  const sourceBytes = await readFile(f.paths.ledgerFile(source.taskId));
  assert.deepEqual(await clearProjectExperience(f.paths, f.projectId), {
    projectId: f.projectId, candidates: 1, entries: 1, evaluations: 1,
  });
  for (const file of [f.paths.experienceCandidatesFile(f.projectId),
    f.paths.experienceEntriesFile(f.projectId), f.paths.experienceEvaluationsFile(f.projectId)]) {
    assert.equal(await readFile(file, "utf8").catch(() => ""), "");
  }
  const repaired = await assertNotSelectable(f);
  assert.ok(repaired.candidates().every((candidate) => candidate.status !== "quarantined"));
  assert.deepEqual(await readFile(f.paths.ledgerFile(source.taskId)), sourceBytes);
  const maintenanceId = (await readdir(f.paths.tasksDir)).find((id) => id !== source.taskId);
  assert.ok(maintenanceId);
  const maintenance = await KernelSession.open({ paths: f.paths, taskId: maintenanceId as never });
  assert.equal(maintenance.state().status, "stopped");
  assert.deepEqual(maintenance.contract()?.scope, { include: [], exclude: [], unknown: [] });
  assert.deepEqual(maintenance.contract()?.autonomy.readPaths, []);
  assert.deepEqual(maintenance.contract()?.autonomy.writePaths, []);
  assert.deepEqual(maintenance.contract()?.autonomy.allowedCommands, []);
  assert.equal(maintenance.contract()?.budget.maxTokens, 0);
  assert.equal(maintenance.events()[0]?.payload["requestedBy"], "user");
  assert.ok(maintenance.events().some((event) => event.type === "experience.demoted" &&
    event.payload["entryId"] === entry!.entryId && event.payload["reason"] === "user_requested"));
  assert.ok(!maintenance.events().some((event) => event.type === "proof.satisfied"));
});

test("failed projection removal reports failure but cannot resurrect a committed revocation", async (t) => {
  const f = await fixture(t);
  await seeded(f);
  const originalRm = fsPromises.rm;
  const replacement = t.mock.method(fsPromises, "rm", async (...args: Parameters<typeof originalRm>) => {
    if (args[0] === f.paths.experienceEntriesFile(f.projectId)) throw new Error("projection removal failed");
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(clearProjectExperience(f.paths, f.projectId),
      (error: unknown) => error instanceof DataError && error.code === "io_error");
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
  await assertNotSelectable(f);
  for (const taskId of await readdir(f.paths.tasksDir)) {
    const session = await KernelSession.open({ paths: f.paths, taskId: taskId as never });
    assert.equal(session.state().status, "stopped");
  }
});

test("a projection write failure after revocation commit is recoverable without reusing the entry", async (t) => {
  const f = await fixture(t);
  const { entry } = await seeded(f);
  const originalRename = fsPromises.rename;
  let failed = false;
  const replacement = t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof originalRename>) => {
    if (args[1] === f.paths.experienceEntriesFile(f.projectId)) {
      const rows = await readFile(args[0], "utf8");
      if (JSON.parse(rows.trim()).status === "demoted") {
        failed = true;
        throw new Error("projection write failed");
      }
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(clearProjectExperience(f.paths, f.projectId),
      (error: unknown) => error instanceof DataError && error.code === "io_error");
    assert.equal(failed, true);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
  await assertNotSelectable(f);
  const entries = JSON.parse((await readFile(f.paths.experienceEntriesFile(f.projectId), "utf8")).trim());
  assert.equal(entries.entryId, entry!.entryId);
  assert.equal(entries.status, "demoted");
});

test("a failed kernel revocation commit does not clear projections and stops maintenance", async (t) => {
  const f = await fixture(t);
  await seeded(f);
  const before = await readFile(f.paths.experienceEntriesFile(f.projectId));
  const replacement = t.mock.method(KernelSession.prototype, "recordExperienceDemotion",
    async () => { throw new Error("kernel commit failed"); });
  try {
    await assert.rejects(clearProjectExperience(f.paths, f.projectId),
      (error: unknown) => error instanceof DataError && error.code === "io_error");
  } finally { replacement.mock.restore(); }
  assert.deepEqual(await readFile(f.paths.experienceEntriesFile(f.projectId)), before);
  const firewall = new ExperienceFirewall(f.paths, f.projectId);
  await firewall.load();
  assert.equal(firewall.selectForContext({ paths: ["src/auth"] }).length, 1);
  for (const taskId of await readdir(f.paths.tasksDir)) {
    const session = await KernelSession.open({ paths: f.paths, taskId: taskId as never });
    assert.equal(session.state().status, "stopped");
  }
});

test("clear archives quarantined candidates with bound user consent and survives a lost projection", async (t) => {
  const f = await fixture(t);
  const { candidate, source } = await seeded(f, { candidateOnly: true });
  const before = await readFile(f.paths.ledgerFile(source.taskId));
  await rm(f.paths.experienceCandidatesFile(f.projectId));
  assert.deepEqual(await clearProjectExperience(f.paths, f.projectId), {
    projectId: f.projectId, candidates: 1, entries: 0, evaluations: 0,
  });
  assert.equal(await readFile(f.paths.experienceCandidatesFile(f.projectId), "utf8").catch(() => ""), "");
  const firewall = await assertNotSelectable(f);
  const archived = firewall.candidates().find((value) => value.candidateId === candidate.candidateId);
  assert.equal(archived?.status, "rejected");
  assert.deepEqual(archived?.provenance, candidate.provenance);
  await assert.rejects(firewall.promote(candidate.candidateId, "deterministic_derivation"), /not promotable/);
  await assert.rejects(changeExperience(f.paths, { workspaceId: f.projectId, rootPath: f.paths.home },
    candidate.candidateId, { action: "confirm" }), /only a quarantined candidate/);
  assert.deepEqual(await readFile(f.paths.ledgerFile(source.taskId)), before);
  const maintenanceId = (await readdir(f.paths.tasksDir)).find((id) => id !== source.taskId);
  assert.ok(maintenanceId);
  const maintenance = await KernelSession.open({ paths: f.paths, taskId: maintenanceId as never });
  assertRejectionDecision(maintenance, candidate.candidateId, "user cleared project experience");
  const tasksBeforeRetry = await readdir(f.paths.tasksDir);
  assert.deepEqual(await clearProjectExperience(f.paths, f.projectId), {
    projectId: f.projectId, candidates: 1, entries: 0, evaluations: 0,
  });
  assert.deepEqual(await readdir(f.paths.tasksDir), tasksBeforeRetry);
  const rebuilt = await assertNotSelectable(f);
  assert.equal(rebuilt.candidates()[0]?.status, "rejected");
});

test("clear rejects quarantined candidates before demoting active entries in one maintenance run", async (t) => {
  const f = await fixture(t);
  const { entry } = await seeded(f);
  const { candidate } = await seeded(f, { candidateOnly: true });
  const { candidate: otherCandidate } = await seeded(f, { candidateOnly: true, untrusted: true });
  assert.deepEqual(await clearProjectExperience(f.paths, f.projectId), {
    projectId: f.projectId, candidates: 3, entries: 1, evaluations: 1,
  });
  const firewall = await assertNotSelectable(f);
  assert.ok(firewall.candidates().every((value) => value.status !== "quarantined"));
  assert.equal((await readdir(f.paths.tasksDir)).length, 4);
  for (const taskId of await readdir(f.paths.tasksDir)) {
    const session = await KernelSession.open({ paths: f.paths, taskId: taskId as never });
    const demotion = session.events().find((event) => event.type === "experience.demoted");
    if (!demotion) continue;
    assertRejectionDecision(session, candidate.candidateId, "user cleared project experience");
    assertRejectionDecision(session, otherCandidate.candidateId, "user cleared project experience");
    assert.equal(session.events().filter((event) => event.type === "intervention.decided").length, 2);
    assert.equal(demotion.payload["entryId"], entry!.entryId);
    const rejection = session.events().find((event) => event.type === "experience.candidate_created" &&
      event.payload["status"] === "rejected");
    assert.ok(rejection && rejection.seq < demotion.seq);
  }
});

test("a failed candidate rejection commit preserves quarantine and stops maintenance", async (t) => {
  const f = await fixture(t);
  const { candidate } = await seeded(f, { candidateOnly: true });
  const before = await readFile(f.paths.experienceCandidatesFile(f.projectId));
  const replacement = t.mock.method(KernelSession.prototype, "rejectExperienceCandidate",
    async () => { throw new Error("kernel rejection failed"); });
  try {
    await assert.rejects(clearProjectExperience(f.paths, f.projectId),
      (error: unknown) => error instanceof DataError && error.code === "io_error");
  } finally { replacement.mock.restore(); }
  assert.deepEqual(await readFile(f.paths.experienceCandidatesFile(f.projectId)), before);
  const firewall = await assertNotSelectable(f);
  assert.equal(firewall.candidates().find((value) => value.candidateId === candidate.candidateId)?.status, "quarantined");
  for (const taskId of await readdir(f.paths.tasksDir)) {
    const session = await KernelSession.open({ paths: f.paths, taskId: taskId as never });
    assert.equal(session.state().status, "stopped");
  }
});

test("clear requires rebuilt candidate rejection rather than trusting an uncommitted response", async (t) => {
  const f = await fixture(t);
  await seeded(f, { candidateOnly: true });
  const before = await readFile(f.paths.experienceCandidatesFile(f.projectId));
  const replacement = t.mock.method(KernelSession.prototype, "rejectExperienceCandidate",
    async () => {});
  try {
    await assert.rejects(clearProjectExperience(f.paths, f.projectId),
      (error: unknown) => error instanceof DataError && error.code === "protected_data");
  } finally { replacement.mock.restore(); }
  assert.deepEqual(await readFile(f.paths.experienceCandidatesFile(f.projectId)), before);
});

test("a candidate projection write failure after rejection commit cannot restore quarantine", async (t) => {
  const f = await fixture(t);
  const { candidate } = await seeded(f, { candidateOnly: true });
  const originalRename = fsPromises.rename;
  let failed = false;
  const replacement = t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof originalRename>) => {
    if (args[1] === f.paths.experienceCandidatesFile(f.projectId)) {
      const rows = await readFile(args[0], "utf8");
      if (JSON.parse(rows.trim()).status === "rejected") {
        failed = true;
        throw new Error("candidate projection write failed");
      }
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(clearProjectExperience(f.paths, f.projectId),
      (error: unknown) => error instanceof DataError && error.code === "io_error");
    assert.equal(failed, true);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
  const firewall = await assertNotSelectable(f);
  assert.equal(firewall.candidates().find((value) => value.candidateId === candidate.candidateId)?.status, "rejected");
  for (const taskId of await readdir(f.paths.tasksDir)) {
    const session = await KernelSession.open({ paths: f.paths, taskId: taskId as never });
    assert.equal(session.state().status, "stopped");
  }
});

test("clear refuses frozen ledger entries even after their projection is lost", async (t) => {
  const f = await fixture(t);
  const { source } = await seeded(f, { frozen: true });
  const before = await readFile(f.paths.ledgerFile(source.taskId));
  await rm(f.paths.experienceEntriesFile(f.projectId));
  await assert.rejects(clearProjectExperience(f.paths, f.projectId),
    (error: unknown) => error instanceof DataError && error.code === "protected_data");
  assert.deepEqual(await readFile(f.paths.ledgerFile(source.taskId)), before);
  assert.equal((await readdir(f.paths.tasksDir)).length, 1);
});

test("confirmed user entries remain protected from wholesale clear", async (t) => {
  const f = await fixture(t);
  const { candidate } = await seeded(f, { candidateOnly: true });
  await changeExperience(f.paths, { workspaceId: f.projectId, rootPath: f.paths.home },
    candidate.candidateId, { action: "confirm" });
  await assert.rejects(clearProjectExperience(f.paths, f.projectId),
    (error: unknown) => error instanceof DataError && error.code === "protected_data");
});

test("explicit single-entry revocation works without reading a repository and survives rebuild", async (t) => {
  const f = await fixture(t);
  const { entry } = await seeded(f, { frozen: true });
  const result = await changeExperience(f.paths, {
    workspaceId: f.projectId, rootPath: join(f.paths.home, "missing-workspace"),
  }, entry!.entryId, { action: "revoke" });
  assert.equal(result.entry.status, "demoted");
  const session = await KernelSession.open({ paths: f.paths, taskId: result.taskId });
  assert.deepEqual(session.contract()?.scope, { include: [], exclude: [], unknown: [] });
  await assertNotSelectable(f);
});

for (const untrusted of [false, true]) {
  test(`explicit candidate revocation preserves ${untrusted ? "untrusted" : "verified"} provenance`, async (t) => {
    const f = await fixture(t);
    const { candidate } = await seeded(f, { candidateOnly: true, untrusted });
    const reason = "user rejected the proposed lesson";
    const result = await changeExperience(f.paths, {
      workspaceId: f.projectId, rootPath: join(f.paths.home, "missing-workspace"),
    }, candidate.candidateId, { action: "revoke", reason });
    assert.equal(result.entry.status, "rejected");
    assert.deepEqual(result.entry.provenance, candidate.provenance);
    const maintenance = await KernelSession.open({ paths: f.paths, taskId: result.taskId });
    assertRejectionDecision(maintenance, candidate.candidateId, reason);
    const firewall = await assertNotSelectable(f);
    assert.equal(firewall.candidates().find((value) => value.candidateId === candidate.candidateId)?.status, "rejected");
  });
}

for (const proven of [false, true]) {
  test(`task ${proven ? "success" : "failure"} alone does not establish experience causality`, async (t) => {
    const f = await fixture(t);
    const { entry } = await seeded(f);
    const session = await sessionFor(f);
    const firewall = new ExperienceFirewall(f.paths, f.projectId);
    await firewall.load();
    try {
      const result = await judgeExperienceUse({
        session, firewall, used: [{ entry: entry!, reason: "scope matches" }],
        proven, changedPaths: ["src/auth/session.ts"], evidence: [],
      });
      assert.equal(result.evaluations[0]?.outcome, "not_evaluable");
      assert.deepEqual(result.demoted, []);
      assert.equal(firewall.selectForContext({ paths: ["src/auth"] }).length, 1);
      assert.ok(!session.events().some((event) => event.type === "experience.demoted"));
    } finally { await session.stop("fixture judgement complete"); }
  });
}

test("a failing verifier observation is not entry-attributed causal evidence", async (t) => {
  const f = await fixture(t);
  const { entry } = await seeded(f);
  const session = await sessionFor(f);
  const firewall = new ExperienceFirewall(f.paths, f.projectId);
  await firewall.load();
  try {
    await session.recordEvidence({
      conditionIds: ["cond.target_tests"], workspaceSnapshotId: newId("snap"),
      level: "E2", producer: { kind: "verifier", id: "verifier.test", version: "1.0.0" },
      independence: { mode: "separate_process", independentOf: ["builder_loop_model"] },
      provenance: entry!.provenance,
      observation: { summary: "auth test failed", exitCode: 1, truncated: false },
      status: "invalid", invalidatedBy: ["verification_failed"],
    });
    const result = await judgeExperienceUse({
      session, firewall, used: [{ entry: entry!, reason: "scope matches" }],
      proven: false, changedPaths: ["src/auth/session.ts"], evidence: await session.evidence(),
    });
    assert.equal(result.evaluations[0]?.outcome, "not_evaluable");
    assert.deepEqual(result.demoted, []);
    assert.equal(firewall.selectForContext({ paths: ["src/auth"] }).length, 1);
  } finally { await session.stop("fixture judgement complete"); }
});

test("a failed task using frozen experience records uncertainty without throwing or demoting", async (t) => {
  const f = await fixture(t);
  const { entry } = await seeded(f, { frozen: true });
  const session = await sessionFor(f);
  const firewall = new ExperienceFirewall(f.paths, f.projectId);
  await firewall.load();
  try {
    const result = await judgeExperienceUse({
      session, firewall, used: [{ entry: entry!, reason: "scope matches" }],
      proven: false, changedPaths: ["src/auth/session.ts"], evidence: [],
    });
    assert.equal(result.evaluations[0]?.outcome, "not_evaluable");
    assert.deepEqual(result.demoted, []);
    assert.equal(firewall.promoted()[0]?.frozen, true);
  } finally { await session.stop("fixture judgement complete"); }
});
