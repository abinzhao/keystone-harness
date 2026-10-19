import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  autonomyEnvelopeSchema,
  canonicalJson,
  experienceEntrySchema,
  newId,
  outcomeContractSchema,
  projectProfileSchema,
  provenanceRefSchema,
  type AutonomyEnvelope,
  type ExperienceCandidate,
  type ExperienceEntry,
  type OutcomeContract,
  type ProjectId,
  type ProjectProfile,
  type ProvenanceRef,
  type Scope,
  type ScopeEntry,
} from "@keystone/schemas";

import { compileContract } from "../src/contract/compile.ts";
import { exportContractJson, importContract, checkCompatibility } from "../src/contract/export.ts";
import { diffContracts, outOfScopeAfterRevision, reviseContract } from "../src/contract/revise.ts";
import { ExperienceFirewall } from "../src/experience/firewall.ts";
import { appendLineDurable } from "../src/storage/atomic.ts";
import { resolveKeystonePaths, type KeystonePaths } from "../src/storage/paths.ts";

function iso(): string {
  return new Date().toISOString();
}

function autonomyFor(projectId: string): AutonomyEnvelope {
  return autonomyEnvelopeSchema.parse({
    projectId,
    readPaths: ["**"],
    writePaths: ["**"],
    allowedCommands: ["node", "pnpm", "tsc", "eslint"],
    allowedHosts: [],
    allowedCredentials: [],
    externalSystems: "none",
    maxReversibility: "reversible",
    untrustedContentEgress: "deny_all",
    budget: { maxTokens: 100_000, maxWallClockMs: 3_600_000, maxRetries: 2 },
    updatedAt: iso(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}

function profileFor(
  projectId: string,
  commands: ProjectProfile["commands"],
  instructionFiles: readonly string[] = [],
): ProjectProfile {
  return projectProfileSchema.parse({
    projectId,
    rootPath: "/repo",
    name: "demo",
    vcs: "git",
    languages: ["typescript"],
    packageManager: "pnpm",
    support: { status: "supported", reasons: [] },
    commands,
    instructionFiles,
    createdAt: iso(),
    updatedAt: iso(),
  }) as ProjectProfile;
}

function glob(pattern: string): ScopeEntry {
  return { kind: "glob", pattern, intent: "write" };
}

function scopeOf(include: readonly ScopeEntry[]): Scope {
  return { include, exclude: [], unknown: [] };
}

function baseContract(
  projectId: string,
  scope: Scope,
  completionConditions: OutcomeContract["completionConditions"] = [
    {
      conditionId: "cond.target_tests",
      description: "tests pass",
      verifier: { kind: "test", id: "verifier.test", version: "1.0.0" },
      minEvidenceLevel: "E2",
      requiresIndependence: false,
      required: true,
    },
  ],
): OutcomeContract {
  return outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId: newId("task"),
    projectId,
    createdAt: iso(),
    createdBy: "kernel",
    goal: "do the thing",
    scope,
    invariants: [],
    completionConditions,
    budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
    autonomy: autonomyFor(projectId),
    uncertainties: [],
    interventionTriggers: ["ambiguity", "scope_expansion"],
    exitConditions: [
      { exitId: "exit.budget", kind: "budget_exhausted", description: "budget gone" },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
}

test("compileContract infers a concrete scope and emits required E2 conditions", () => {
  const projectId = newId("proj");
  const result = compileContract({
    taskId: newId("task"),
    projectId,
    request: "修复登录 Session 过期后的重复刷新问题，并确保现有登录行为不变",
    profile: profileFor(projectId, [
      { kind: "test", command: "node --test", status: "identified", source: "packages/kernel/package.json#scripts.test" },
      { kind: "typecheck", command: "tsc --noEmit", status: "identified", source: "package.json#scripts.typecheck" },
      { kind: "lint", command: "eslint .", status: "identified", source: "package.json#scripts.lint" },
    ]),
    autonomy: autonomyFor(projectId),
  });

  // The test command is declared in `packages/kernel`, so the compiler can infer
  // that directory instead of leaving the scope unknown. No scope question is
  // raised, so the task is ready.
  assert.deepEqual(result.contract.scope.include, [
    { kind: "directory", pattern: "packages/kernel", intent: "write" },
  ]);
  assert.deepEqual(result.contract.scope.unknown, []);
  assert.equal(result.contract.status, "ready");
  assert.equal(result.questions.length, 0);

  const byId = new Map(result.contract.completionConditions.map((c) => [c.conditionId, c]));
  const tests = byId.get("cond.target_tests");
  assert.ok(tests !== undefined);
  assert.equal(tests.minEvidenceLevel, "E2");
  assert.equal(tests.required, true);
  assert.equal(tests.verifier.kind, "test");
  const params = tests.verifier.params as Record<string, unknown> | undefined;
  assert.equal(params?.["command"], "node --test");

  const scopeCheck = byId.get("cond.scope_check");
  assert.ok(scopeCheck !== undefined);
  assert.equal(scopeCheck.required, true);
  assert.equal(scopeCheck.verifier.kind, "diff_scope");

  assert.ok(result.contract.invariants.some((i) => i.invariantId === "inv.preserve_behaviour"));
});

test("compileContract raises a verification question when no test command exists", () => {
  const projectId = newId("proj");
  const result = compileContract({
    taskId: newId("task"),
    projectId,
    request: "add a health check endpoint",
    profile: profileFor(projectId, [
      { kind: "build", command: "tsc", status: "identified", source: "package.json#scripts.build" },
    ]),
    autonomy: autonomyFor(projectId),
  });

  assert.ok(result.questions.some((q) => q.affects === "verification"));
  assert.equal(result.contract.status, "awaiting_approval");
  const tests = result.contract.completionConditions.find((c) => c.conditionId === "cond.target_tests");
  assert.ok(tests !== undefined);
  assert.equal(tests.verifier.params, undefined);
});

test("compileContract output already satisfies the contract schema", () => {
  const projectId = newId("proj");
  const result = compileContract({
    taskId: newId("task"),
    projectId,
    request: "fix a bug",
    profile: profileFor(projectId, [
      { kind: "test", command: "pnpm test", status: "identified", source: "package.json#scripts.test" },
    ]),
    autonomy: autonomyFor(projectId),
  });
  assert.doesNotThrow(() => outcomeContractSchema.parse(result.contract));
});

test("reviseContract shrinking scope invalidates stranded evidence and keeps history intact", () => {
  const projectId = newId("proj");
  const previous = baseContract(projectId, scopeOf([glob("src/a/**"), glob("src/b/**")]));
  const snapshot = structuredClone(previous);

  const next = reviseContract(
    previous,
    { scope: scopeOf([glob("src/a/**")]) },
    "narrow the scope to a",
    "user",
  );

  assert.deepEqual(outOfScopeAfterRevision(previous, next.contract), ["src/b/**"]);
  assert.equal(next.contract.version, previous.version + 1);
  assert.equal(next.contract.parentContractId, previous.contractId);
  assert.notEqual(next.contract.contractId, previous.contractId);
  assert.ok(next.invalidated.includes("evidence_outside_scope:src/b/**"));
  assert.deepEqual(next.changedFields, ["scope"]);
  // History is untouched.
  assert.deepEqual(previous, snapshot);
});

test("reviseContract widening scope requires human confirmation", () => {
  const projectId = newId("proj");
  const previous = baseContract(projectId, scopeOf([glob("src/a/**")]));

  const next = reviseContract(
    previous,
    { scope: scopeOf([glob("src/a/**"), glob("src/c/**")]) },
    "widen the scope to c",
    "kernel",
  );

  assert.equal(next.contract.status, "awaiting_approval");
  assert.ok(next.invalidated.includes("requires_confirmation:scope_expansion"));
});

test("reviseContract flags conditions whose evidence may need to be rerun", () => {
  const projectId = newId("proj");
  const previous = baseContract(projectId, scopeOf([glob("src/a/**")]));
  const raised = previous.completionConditions.map((condition) => ({
    ...condition,
    minEvidenceLevel: "E3" as const,
  }));

  const next = reviseContract(
    previous,
    { completionConditions: raised },
    "require an independent re-check",
    "user",
  );

  assert.ok(next.invalidated.includes("conditions_changed:cond.target_tests"));
  assert.ok(diffContracts(previous, next.contract).includes("completionConditions"));
});

test("export/import round-trips a contract through canonical JSON", () => {
  const projectId = newId("proj");
  const contract = baseContract(projectId, scopeOf([glob("src/a/**")]));

  const json = exportContractJson(contract);
  const imported = importContract(JSON.parse(json));

  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.deepEqual(imported.contract, contract);
  assert.deepEqual(imported.migrationPreview, []);

  const compat = checkCompatibility(JSON.parse(json));
  assert.equal(compat.compatible, true);
  assert.ok(compat.notes.some((note) => note.includes("schemaVersion")));
});

test("importContract previews a same-major version and refuses a cross-major one", () => {
  const projectId = newId("proj");
  const contract = baseContract(projectId, scopeOf([glob("src/a/**")]));
  const parsed = JSON.parse(exportContractJson(contract)) as Record<string, unknown>;

  const sameMajor = importContract({ ...parsed, schemaVersion: "keystone.contract.outcome@1.4.0" });
  assert.equal(sameMajor.ok, true);
  if (sameMajor.ok) assert.ok(sameMajor.migrationPreview.length > 0);

  const crossMajor = importContract({ ...parsed, schemaVersion: "keystone.contract.outcome@2.0.0" });
  assert.equal(crossMajor.ok, false);
  if (!crossMajor.ok) assert.match(crossMajor.reason, /execution is forbidden/);
});

test("importContract rejects an object that fails validation", () => {
  const result = importContract({ schemaVersion: "keystone.contract.outcome@1.0.0", goal: "x" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /contract failed validation/);
});

// ---------------------------------------------------------------------------
// Experience Firewall
// ---------------------------------------------------------------------------

const EMPTY_APPLICABILITY: ExperienceCandidate["applicability"] = {
  paths: [],
  symbols: [],
  languages: [],
  packageManagers: [],
  toolVersions: [],
  taskShapes: [],
};

function provenance(trustLevel: ProvenanceRef["trustLevel"], sourceKind: ProvenanceRef["sourceKind"]): ProvenanceRef {
  return provenanceRefSchema.parse({
    provenanceId: newId("prov"),
    sourceKind,
    trustLevel,
    locator: "test",
    derivedFrom: [],
    invalidatedBy: [],
    observedAt: iso(),
  }) as ProvenanceRef;
}

interface FirewallFixture {
  readonly fw: ExperienceFirewall;
  readonly paths: KeystonePaths;
  readonly projectId: ProjectId;
  readonly dir: string;
}

async function makeFirewall(): Promise<FirewallFixture> {
  const dir = await mkdtemp(join(tmpdir(), "keystone-exp-"));
  const paths = resolveKeystonePaths(dir);
  const projectId = newId("proj") as ProjectId;
  const fw = new ExperienceFirewall(paths, projectId);
  await fw.load();
  return { fw, paths, projectId, dir };
}

test("firewall: a single-task candidate stays quarantined and is not promotable", async () => {
  const { fw, projectId, dir } = await makeFirewall();
  try {
    const candidate = await fw.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task")],
      category: "patch_pattern",
      statement: "a single success is not knowledge",
      applicability: EMPTY_APPLICABILITY,
      provenance: provenance("observed", "model"),
      supportingEvidenceIds: [newId("evd")],
    });

    assert.equal(candidate.status, "quarantined");
    const verdict = fw.evaluatePromotion(candidate);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.basis, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("firewall: a candidate verified across two tasks promotes as independent_verification", async () => {
  const { fw, projectId, dir } = await makeFirewall();
  try {
    const candidate = await fw.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task"), newId("task")],
      category: "localization_path",
      statement: "session refresh lives in the auth callback",
      applicability: EMPTY_APPLICABILITY,
      provenance: provenance("observed", "model"),
      supportingEvidenceIds: [newId("evd")],
    });

    const verdict = fw.evaluatePromotion(candidate);
    assert.equal(verdict.eligible, true);
    assert.equal(verdict.basis, "independent_verification");

    const entry = await fw.promote(candidate.candidateId, verdict.basis ?? "independent_verification");
    assert.equal(entry.status, "active");
    assert.equal(entry.promotedBy, "independent_verification");
    assert.ok(fw.promoted().some((candidate) => candidate.entryId === entry.entryId));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("firewall: untrusted provenance can never promote", async () => {
  const { fw, projectId, dir } = await makeFirewall();
  try {
    const candidate = await fw.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task"), newId("task")],
      category: "failure_cause",
      statement: "text scraped from a web page",
      applicability: EMPTY_APPLICABILITY,
      provenance: provenance("untrusted", "web"),
      supportingEvidenceIds: [newId("evd")],
    });

    const verdict = fw.evaluatePromotion(candidate);
    assert.equal(verdict.eligible, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("firewall: negative transfer and tool-version drift exclude entries with a reason", async () => {
  const { fw, projectId, dir } = await makeFirewall();
  try {
    const negative = await fw.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task"), newId("task")],
      category: "dead_end",
      statement: "retrying the refresh synchronously",
      applicability: EMPTY_APPLICABILITY,
      provenance: provenance("observed", "model"),
      supportingEvidenceIds: [newId("evd")],
    });
    const negativeEntry = await fw.promote(negative.candidateId, "independent_verification");
    await fw.recordEvaluation({
      entryId: negativeEntry.entryId,
      taskId: newId("task"),
      used: true,
      outcome: "negative_transfer",
      judgeEvidenceIds: [newId("evd")],
    });

    const versioned = await fw.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task")],
      category: "test_mapping",
      statement: "pnpm runs the tests",
      applicability: { ...EMPTY_APPLICABILITY, toolVersions: [{ id: "pnpm", version: "8" }] },
      provenance: provenance("verified", "repository"),
      supportingEvidenceIds: [newId("evd")],
    });
    const versionedEntry = await fw.promote(versioned.candidateId, "deterministic_derivation");

    const query = { toolVersions: [{ id: "pnpm", version: "9" }] };
    const selected = fw.selectForContext(query);
    const exclusions = fw.exclusions(query);

    assert.ok(!selected.some((item) => item.entry.entryId === negativeEntry.entryId));
    assert.equal(
      exclusions.find((item) => item.entryId === negativeEntry.entryId)?.reason,
      "negative transfer observed",
    );
    assert.equal(
      exclusions.find((item) => item.entryId === versionedEntry.entryId)?.reason,
      "tool version changed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("firewall: a frozen entry stays usable after a reload", async () => {
  const { fw, paths, projectId, dir } = await makeFirewall();
  try {
    const candidate = await fw.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task"), newId("task")],
      category: "patch_pattern",
      statement: "keep this around",
      applicability: EMPTY_APPLICABILITY,
      provenance: provenance("observed", "model"),
      supportingEvidenceIds: [newId("evd")],
    });
    const entry = await fw.promote(candidate.candidateId, "independent_verification");

    // Freezing protects the entry from automatic demotion; it does not hide it.
    const frozen = experienceEntrySchema.parse({ ...entry, frozen: true }) as ExperienceEntry;
    await appendLineDurable(paths.experienceEntriesFile(projectId), canonicalJson(frozen));

    const reloaded = new ExperienceFirewall(paths, projectId);
    await reloaded.load();
    const found = reloaded.selectForContext({}).find((item) => item.entry.entryId === entry.entryId);

    assert.ok(found !== undefined);
    assert.equal(found?.entry.frozen, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
