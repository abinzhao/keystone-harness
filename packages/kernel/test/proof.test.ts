import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceRecordSchema,
  newId,
  outcomeContractSchema,
  sha256Hex,
  type EvidenceLevel,
  type EvidenceRecord,
  type IndependenceTarget,
  type OutcomeContract,
  type VerifierRef,
} from "@keystone/schemas";

import { detectCycles, evaluateCompletion } from "../src/proof/evaluate.ts";
import { buildProofGraph, proofNodeId } from "../src/proof/graph.ts";
import { renderProofPackage } from "../src/proof/package.ts";

const ISO = "2026-10-19T06:00:00.000Z";
const FP = "a".repeat(64);
const BRANCH = newId("branch");

interface ConditionSpec {
  readonly conditionId: string;
  readonly minEvidenceLevel?: EvidenceLevel;
  readonly requiresIndependence?: boolean;
  readonly required?: boolean;
  readonly dependsOn?: string[];
  readonly verifier?: VerifierRef;
}

/**
 * Build a Contract through the real schema so the fixture cannot drift from the
 * protocol (a fake that no longer validates is worse than no fake).
 */
function makeContract(options: {
  readonly conditions: readonly ConditionSpec[];
  readonly scopeInclude?: readonly string[];
  readonly scopeUnknown?: readonly string[];
  readonly version?: number;
}): OutcomeContract {
  const taskId = newId("task");
  const projectId = newId("proj");
  return outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: options.version ?? 1,
    taskId,
    projectId,
    createdAt: ISO,
    createdBy: "kernel",
    goal: "Fix duplicate session refresh after expiry",
    scope: {
      include: (options.scopeInclude ?? ["src/**"]).map((pattern) => ({
        kind: "glob" as const,
        pattern,
        intent: "write" as const,
      })),
      exclude: [],
      unknown: [...(options.scopeUnknown ?? [])],
    },
    invariants: [],
    completionConditions: options.conditions.map((spec) => ({
      conditionId: spec.conditionId,
      description: `check ${spec.conditionId}`,
      verifier: spec.verifier ?? { kind: "test" as const, id: "verifier.test", version: "1.0.0" },
      minEvidenceLevel: spec.minEvidenceLevel ?? "E2",
      requiresIndependence: spec.requiresIndependence ?? false,
      required: spec.required ?? true,
      ...(spec.dependsOn === undefined ? {} : { dependsOn: spec.dependsOn }),
    })),
    budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
    autonomy: {
      projectId,
      readPaths: ["**"],
      writePaths: ["src/**"],
      allowedCommands: ["pnpm"],
      allowedHosts: [],
      allowedCredentials: [],
      externalSystems: "none",
      maxReversibility: "reversible",
      untrustedContentEgress: "deny_all",
      budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
      updatedAt: ISO,
      updatedBy: "user",
      widenedBy: [],
    },
    uncertainties: [],
    interventionTriggers: ["ambiguity"],
    exitConditions: [
      { exitId: "exit.budget", kind: "budget_exhausted", description: "budget exhausted" },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
}

function makeEvidence(
  contract: OutcomeContract,
  options: {
    readonly conditionIds: readonly string[];
    readonly level?: EvidenceLevel;
    readonly status?: "valid" | "partially_invalid" | "invalid";
    readonly mode?: "same_process" | "separate_process" | "isolated_workspace" | "external_service";
    readonly independentOf?: readonly IndependenceTarget[];
    readonly environmentFingerprint?: string;
    readonly command?: string;
    readonly incomplete?: readonly string[];
  },
): EvidenceRecord {
  const evidenceId = newId("evd");
  return evidenceRecordSchema.parse({
    evidenceId,
    taskId: contract.taskId,
    branchId: BRANCH,
    conditionIds: [...options.conditionIds],
    level: options.level ?? "E2",
    producer: { kind: "verifier", id: "verifier.test", version: "1.0.0" },
    independence: {
      mode: options.mode ?? "separate_process",
      independentOf: [...(options.independentOf ?? ["builder_loop_process"])],
      ...(options.environmentFingerprint === undefined
        ? {}
        : { environmentFingerprint: options.environmentFingerprint }),
    },
    provenance: {
      provenanceId: newId("prov"),
      sourceKind: "verifier",
      trustLevel: "verified",
      locator: "test",
      derivedFrom: [],
      invalidatedBy: [],
      observedAt: ISO,
    },
    workspaceSnapshotId: newId("snap"),
    contractId: contract.contractId,
    contractVersion: contract.version,
    observation: {
      summary: `observation for ${evidenceId}`,
      truncated: false,
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.incomplete === undefined ? {} : { incomplete: [...options.incomplete] }),
    },
    createdAt: ISO,
    contentHash: sha256Hex(evidenceId),
    status: options.status ?? "valid",
    invalidatedBy: [],
  }) as EvidenceRecord;
}

test("all required conditions proven by E2 evidence within scope", () => {
  const contract = makeContract({
    conditions: [{ conditionId: "cond.tests", minEvidenceLevel: "E2" }],
  });
  const evidence = [makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP })];

  const decision = evaluateCompletion({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/auth/session.ts"],
    workspaceFingerprint: FP,
    evidence,
  });

  assert.equal(decision.outcome, "proven");
  const required = decision.conditionResults.filter((result) => result.required);
  assert.equal(required.length, 1);
  assert.equal(required[0]?.satisfied, true);
  assert.equal(required[0]?.reasonCode, "satisfied");
});

test("E0 evidence can never satisfy a condition", () => {
  const contract = makeContract({
    conditions: [{ conditionId: "cond.a", minEvidenceLevel: "E2" }],
  });
  const decision = evaluateCompletion({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence: [makeEvidence(contract, { conditionIds: ["cond.a"], level: "E0" })],
  });

  assert.equal(decision.outcome, "not_proven");
  assert.equal(decision.conditionResults[0]?.reasonCode, "insufficient_level");

  // Even a condition that nominally requires only E0 is raised to E1, because
  // E0 is a model claim and may never stand alone (PRD VF-02).
  const e0Contract = makeContract({
    conditions: [{ conditionId: "cond.b", minEvidenceLevel: "E0" }],
  });
  const e0Decision = evaluateCompletion({
    contract: e0Contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence: [makeEvidence(e0Contract, { conditionIds: ["cond.b"], level: "E0" })],
  });
  assert.equal(e0Decision.outcome, "not_proven");
  assert.equal(e0Decision.conditionResults[0]?.reasonCode, "insufficient_level");
  assert.equal(e0Decision.conditionResults[0]?.requiredLevel, "E1");
});

test("an invalid evidence record yields evidence_invalid", () => {
  const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
  const decision = evaluateCompletion({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence: [makeEvidence(contract, { conditionIds: ["cond.tests"], status: "invalid" })],
  });

  assert.equal(decision.outcome, "not_proven");
  assert.equal(decision.conditionResults[0]?.reasonCode, "evidence_invalid");
});

test("independence requirement rejects same-process and unenumerated verifiers", () => {
  const sameProcess = makeContract({
    conditions: [{ conditionId: "cond.ind", requiresIndependence: true }],
  });
  const first = evaluateCompletion({
    contract: sameProcess,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence: [
      makeEvidence(sameProcess, {
        conditionIds: ["cond.ind"],
        mode: "same_process",
        independentOf: [],
      }),
    ],
  });
  assert.equal(first.outcome, "not_proven");
  assert.equal(first.conditionResults[0]?.reasonCode, "not_independent");
  assert.equal(first.conditionResults[0]?.independenceSatisfied, false);

  const second = evaluateCompletion({
    contract: sameProcess,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence: [
      makeEvidence(sameProcess, {
        conditionIds: ["cond.ind"],
        mode: "separate_process",
        independentOf: [],
      }),
    ],
  });
  assert.equal(second.conditionResults[0]?.reasonCode, "not_independent");
});

test("changed paths outside the contract scope force scope_exceeded", () => {
  const contract = makeContract({
    conditions: [{ conditionId: "cond.tests" }],
    scopeInclude: ["src/**"],
  });
  const decision = evaluateCompletion({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts", "lib/other.ts"],
    evidence: [makeEvidence(contract, { conditionIds: ["cond.tests"] })],
  });

  assert.equal(decision.outcome, "not_proven");
  assert.ok(decision.reasons.some((reason) => reason.code === "scope_exceeded"));
});

test("an explicit verifier failure overrides passing evidence", () => {
  const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
  const decision = evaluateCompletion({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence: [makeEvidence(contract, { conditionIds: ["cond.tests"] })],
    verifierFailures: [{ conditionId: "cond.tests", detail: "assertion failed in session.test.ts" }],
  });

  assert.equal(decision.outcome, "not_proven");
  assert.equal(decision.conditionResults[0]?.reasonCode, "verifier_failed");
  assert.ok(decision.reasons.some((reason) => reason.code === "verifier_failed"));
});

test("a dependsOn cycle is not provable and is reported", () => {
  const contract = makeContract({
    conditions: [
      { conditionId: "cond.a", dependsOn: ["cond.b"] },
      { conditionId: "cond.b", dependsOn: ["cond.a"] },
    ],
  });
  const evidence = [
    makeEvidence(contract, { conditionIds: ["cond.a", "cond.b"] }),
  ];

  const cycles = detectCycles(contract.completionConditions);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...(cycles[0] ?? [])].sort(), ["cond.a", "cond.b"]);

  const decision = evaluateCompletion({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    evidence,
  });
  assert.equal(decision.outcome, "not_proven");
  assert.ok(
    decision.reasons.some(
      (reason) => reason.code === "dependency_unsatisfied" && reason.detail.includes("cycle"),
    ),
  );
});

test("buildProofGraph structures nodes, edges and a stable content hash", () => {
  const contract = makeContract({
    conditions: [
      { conditionId: "cond.tests" },
      { conditionId: "cond.lint", required: false },
    ],
  });
  const evidence = [
    makeEvidence(contract, {
      conditionIds: ["cond.tests", "cond.lint"],
      command: "pnpm test",
      environmentFingerprint: FP,
    }),
  ];
  const input = {
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    workspaceFingerprint: FP,
    evidence,
  };

  const graph = buildProofGraph(input);

  assert.equal(graph.nodes.filter((node) => node.kind === "condition").length, 2);
  assert.deepEqual(
    graph.rootNodeIds,
    contract.completionConditions.map((condition) => proofNodeId("condition", condition.conditionId)),
  );

  const evidenceNodeId = proofNodeId("evidence", evidence[0]?.evidenceId ?? "");
  const relations = graph.edges
    .filter((edge) => edge.from === evidenceNodeId)
    .map((edge) => edge.relation);
  assert.ok(relations.includes("validated_by"));
  assert.ok(relations.includes("observed_in"));

  for (const node of graph.nodes) {
    assert.match(node.nodeId, /^[a-z][a-z0-9_.-]{0,63}$/);
  }

  const again = buildProofGraph(input);
  assert.equal(again.contentHash, graph.contentHash);
  assert.equal(proofNodeId("condition", "cond.tests"), "condition.cond.tests");
});

test("renderProofPackage produces deterministic, redactable packages", () => {
  const contract = makeContract({
    conditions: [{ conditionId: "cond.tests" }],
    scopeUnknown: ["third_party/**"],
  });
  const evidence = [
    makeEvidence(contract, { conditionIds: ["cond.tests"], command: "pnpm test", environmentFingerprint: FP }),
    makeEvidence(contract, { conditionIds: ["cond.tests"], command: "pnpm test", environmentFingerprint: FP }),
    makeEvidence(contract, { conditionIds: ["cond.tests"], command: "pnpm lint", environmentFingerprint: FP }),
  ];
  const graph = buildProofGraph({
    contract,
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    workspaceFingerprint: FP,
    evidence,
  });

  const base = {
    graph,
    contract,
    changedPaths: ["src/a.ts"],
    evidence,
  };
  const provenPackage = renderProofPackage(base);
  assert.equal(provenPackage.outcome, "proven");
  assert.ok(provenPackage.summary.includes("proven"));
  assert.deepEqual(provenPackage.reproduceCommands, ["pnpm test", "pnpm lint"]);
  assert.ok(provenPackage.residualRisks.some((risk) => risk.includes("third_party/**")));

  // Same proof -> same content-addressed package id.
  assert.equal(renderProofPackage(base).packageId, provenPackage.packageId);

  // A not-proven graph still renders a human-readable summary.
  const notProvenGraph = buildProofGraph({
    contract: makeContract({ conditions: [{ conditionId: "cond.tests" }] }),
    branchId: BRANCH,
    changedPaths: ["src/a.ts"],
    workspaceFingerprint: FP,
    evidence: [],
  });
  const notProvenPackage = renderProofPackage({
    graph: notProvenGraph,
    contract,
    changedPaths: ["src/a.ts"],
    evidence: [],
  });
  assert.equal(notProvenPackage.outcome, "not_proven");
  assert.ok(notProvenPackage.summary.length > 0);

  // metadata_only strips statements and notes but keeps the summary content-free.
  const redacted = renderProofPackage({
    ...base,
    projectRules: [{ factId: newId("fact"), statement: "internal rule text" }],
    contextDecisions: [
      { planId: "plan.x", stepId: "s1", tokensUsed: 10, cacheHits: 2, note: "internal note text" },
    ],
    redaction: "metadata_only",
  });
  assert.equal(redacted.projectRules[0]?.statement, "<redacted>");
  assert.equal(redacted.contextDecisions[0]?.note, "<redacted>");
  assert.ok(redacted.residualRisks.some((risk) => risk.includes("metadata-only")));
});

const identityMismatches: {
  name: string;
  change: (record: EvidenceRecord) => Record<string, unknown>;
  reason: RegExp;
}[] = [
  { name: "foreign task", change: () => ({ taskId: newId("task") }), reason: /task/ },
  { name: "foreign branch", change: () => ({ branchId: newId("branch") }), reason: /branch/ },
  { name: "foreign contract", change: () => ({ contractId: newId("contract") }), reason: /contract/ },
  { name: "earlier revision", change: () => ({ contractVersion: 1 }), reason: /revision/ },
  { name: "future revision", change: () => ({ contractVersion: 3 }), reason: /revision/ },
  {
    name: "foreign producer ID",
    change: (record) => ({ producer: { ...record.producer, id: "verifier.foreign" } }),
    reason: /producer/,
  },
  {
    name: "foreign producer version",
    change: (record) => ({ producer: { ...record.producer, version: "2.0.0" } }),
    reason: /producer/,
  },
  ...(["tool", "model", "external", "user"] as const).map((kind) => ({
    name: `${kind} masquerading as a local verifier`,
    change: (record: EvidenceRecord) => ({ producer: { ...record.producer, kind } }),
    reason: /producer/,
  })),
];

for (const { name, change, reason } of identityMismatches) {
  test(`proof admission rejects schema-valid ${name} without rewriting history`, () => {
    const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }], version: 2 });
    const original = makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP });
    const record = evidenceRecordSchema.parse({ ...original, ...change(original) }) as EvidenceRecord;
    const before = structuredClone(record);
    const input = {
      contract, branchId: BRANCH, changedPaths: ["src/a.ts"], workspaceFingerprint: FP, evidence: [record],
    };
    const decision = evaluateCompletion(input);
    assert.equal(decision.outcome, "not_proven");
    assert.equal(decision.conditionResults[0]?.reasonCode, "evidence_invalid");
    assert.match(decision.conditionResults[0]?.reason ?? "", reason);

    const graph = buildProofGraph(input);
    assert.deepEqual(graph.decision, decision);
    const evidenceNode = graph.nodes.find((node) => node.kind === "evidence");
    assert.equal(evidenceNode?.status, "invalid");
    assert.match(evidenceNode?.reason ?? "", reason);
    assert.ok(!graph.edges.some((edge) => edge.from === evidenceNode?.nodeId && edge.relation === "supports"));
    const pkg = renderProofPackage({ ...input, graph });
    assert.equal(pkg.outcome, "not_proven");
    assert.equal(pkg.evidenceIndex[0]?.status, "invalid");
    assert.ok(pkg.unverified.some((item) => item.includes(record.evidenceId)));
    assert.deepEqual(record, before);
  });
}

const provenanceMismatches: {
  name: string;
  change: (record: EvidenceRecord) => Record<string, unknown>;
}[] = [
  {
    name: "actual evidence invalidation despite a valid status",
    change: () => ({ invalidatedBy: ["workspace_changed"] }),
  },
  {
    name: "actual evidence invalidation timestamp despite a valid status",
    change: () => ({ invalidatedAt: ISO }),
  },
  ...(["untrusted", "observed"] as const).map((trustLevel) => ({
    name: `${trustLevel} required evidence`,
    change: (record: EvidenceRecord) => ({ provenance: { ...record.provenance, trustLevel } }),
  })),
  ...(["model", "tool", "web", "issue", "extension", "experience", "repository", "user", "imported_contract", "system"] as const)
    .map((sourceKind) => ({
      name: `${sourceKind} provenance masquerading as verified verifier output`,
      change: (record: EvidenceRecord) => ({ provenance: { ...record.provenance, sourceKind } }),
    })),
  {
    name: "provenance bound to a different snapshot",
    change: (record) => ({ provenance: { ...record.provenance, applicableSnapshot: newId("snap") } }),
  },
];

for (const { name, change } of provenanceMismatches) {
  test(`proof admission rejects ${name}`, () => {
    const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
    const original = makeEvidence(contract, { conditionIds: ["cond.tests"] });
    const record = evidenceRecordSchema.parse({ ...original, ...change(original) }) as EvidenceRecord;
    const input = { contract, branchId: BRANCH, changedPaths: [], evidence: [record] };
    const decision = evaluateCompletion(input);
    assert.equal(decision.outcome, "not_proven");
    assert.equal(decision.conditionResults[0]?.reasonCode, "evidence_invalid");
  });
}

test("normal runtime provenance triggers are not actual invalidations", () => {
  const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
  const original = makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP });
  const record = evidenceRecordSchema.parse({
    ...original,
    provenance: {
      ...original.provenance,
      applicableSnapshot: original.workspaceSnapshotId,
      invalidatedBy: ["workspace.changed", "verifier.changed"],
      transformation: "verification-run",
    },
  }) as EvidenceRecord;
  const input = { contract, branchId: BRANCH, changedPaths: [], workspaceFingerprint: FP, evidence: [record] };
  assert.equal(evaluateCompletion(input).outcome, "proven");
  const graph = buildProofGraph(input);
  assert.equal(graph.nodes.find((node) => node.kind === "evidence")?.status, "supported");
  assert.equal(renderProofPackage({ ...input, graph }).evidenceIndex[0]?.status, "valid");
});

test("an incomplete required observation is pending in completion and export", () => {
  const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
  const record = makeEvidence(contract, {
    conditionIds: ["cond.tests"], environmentFingerprint: FP, incomplete: ["regression case did not run"],
  });
  const before = structuredClone(record);
  const input = { contract, branchId: BRANCH, changedPaths: [], workspaceFingerprint: FP, evidence: [record] };
  const decision = evaluateCompletion(input);
  assert.equal(decision.outcome, "not_proven");
  assert.equal(decision.conditionResults[0]?.reasonCode, "pending");
  assert.match(decision.conditionResults[0]?.reason ?? "", /regression case did not run/);
  const graph = buildProofGraph(input);
  assert.deepEqual(graph.decision, decision);
  assert.equal(graph.nodes.find((node) => node.kind === "evidence")?.status, "pending");
  const pkg = renderProofPackage({ ...input, graph });
  assert.equal(pkg.outcome, "not_proven");
  assert.equal(pkg.evidenceIndex[0]?.status, "partially_invalid");
  assert.ok(pkg.unverified.some((item) => item.includes("regression case did not run")));
  assert.deepEqual(record, before);
});

for (const fingerprint of [undefined, "b".repeat(64)]) {
  test(`current proof rejects ${fingerprint === undefined ? "unknown" : "stale"} workspace fingerprints`, () => {
    const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
    const record = makeEvidence(contract, {
      conditionIds: ["cond.tests"],
      ...(fingerprint === undefined ? {} : { environmentFingerprint: fingerprint }),
    });
    const input = { contract, branchId: BRANCH, changedPaths: [], workspaceFingerprint: FP, evidence: [record] };
    const decision = evaluateCompletion(input);
    assert.equal(decision.outcome, "not_proven");
    assert.equal(decision.conditionResults[0]?.reasonCode, "workspace_changed");
    const graph = buildProofGraph(input);
    assert.deepEqual(graph.decision, decision);
    assert.equal(graph.nodes.find((node) => node.kind === "evidence")?.status, "invalid");
    const pkg = renderProofPackage({ ...input, graph, environment: { workspaceFingerprint: FP } });
    assert.equal(pkg.outcome, "not_proven");
    assert.equal(pkg.evidenceIndex[0]?.status, "invalid");
    assert.equal(record.status, "valid");
  });
}

test("historical proof without a current fingerprint remains replayable", () => {
  const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
  const record = makeEvidence(contract, { conditionIds: ["cond.tests"] });
  const input = { contract, branchId: BRANCH, changedPaths: [], evidence: [record] };
  assert.equal(evaluateCompletion(input).outcome, "proven");
  assert.equal(buildProofGraph(input).decision.outcome, "proven");
});

test("a newer verifier failure supersedes an older pass in completion and exported support", () => {
  const contract = makeContract({ conditions: [{ conditionId: "cond.tests" }] });
  const pass = makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP });
  const failure = evidenceRecordSchema.parse({
    ...makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP, status: "invalid" }),
    invalidatedBy: ["verifier.reported_failure"],
  }) as EvidenceRecord;
  const input = { contract, branchId: BRANCH, changedPaths: [], workspaceFingerprint: FP, evidence: [pass, failure] };
  assert.equal(evaluateCompletion(input).outcome, "not_proven");
  const graph = buildProofGraph(input);
  assert.equal(renderProofPackage({ ...input, graph }).outcome, "not_proven");
  assert.equal(graph.edges.filter((edge) => edge.relation === "supports").length, 0);
  const foreign = evidenceRecordSchema.parse({ ...failure, taskId: newId("task") }) as EvidenceRecord;
  assert.equal(evaluateCompletion({ ...input, evidence: [pass, foreign] }).outcome, "proven");
  const repaired = makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP });
  assert.equal(evaluateCompletion({ ...input, evidence: [pass, failure, repaired] }).outcome, "proven");
});

test("foreign high-level evidence cannot supply independence or appear as current support", () => {
  const contract = makeContract({
    conditions: [{ conditionId: "cond.tests", minEvidenceLevel: "E3", requiresIndependence: true }],
  });
  const local = makeEvidence(contract, {
    conditionIds: ["cond.tests"], level: "E3", mode: "same_process", independentOf: [],
  });
  const foreign = evidenceRecordSchema.parse({
    ...makeEvidence(contract, { conditionIds: ["cond.tests"], level: "E4" }),
    branchId: newId("branch"),
  }) as EvidenceRecord;
  const input = { contract, branchId: BRANCH, changedPaths: [], evidence: [local, foreign] };
  assert.equal(evaluateCompletion(input).conditionResults[0]?.reasonCode, "not_independent");

  const independent = evidenceRecordSchema.parse({
    ...local, independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
  }) as EvidenceRecord;
  const result = evaluateCompletion({ ...input, evidence: [independent, foreign] });
  assert.equal(result.outcome, "proven");
  assert.equal(result.conditionResults[0]?.achievedLevel, "E3");
  assert.deepEqual(result.conditionResults[0]?.evidenceIds, [independent.evidenceId]);
});

test("a record supporting two conditions is admitted only for its declared verifier", () => {
  const contract = makeContract({
    conditions: [
      { conditionId: "cond.tests" },
      { conditionId: "cond.lint", verifier: { kind: "lint", id: "verifier.lint", version: "1.0.0" } },
    ],
  });
  const record = makeEvidence(contract, { conditionIds: ["cond.tests", "cond.lint"], environmentFingerprint: FP });
  const input = { contract, branchId: BRANCH, changedPaths: [], workspaceFingerprint: FP, evidence: [record] };
  const graph = buildProofGraph(input);
  assert.equal(graph.decision.outcome, "not_proven");
  assert.equal(graph.decision.conditionResults[0]?.satisfied, true);
  assert.equal(graph.decision.conditionResults[1]?.reasonCode, "evidence_invalid");
  const supported = graph.edges.filter((edge) => edge.relation === "supports").map((edge) => edge.to);
  assert.deepEqual(supported, [proofNodeId("condition", "cond.tests")]);
});

test("an auxiliary incomplete observation stays disclosed without blocking complete required evidence", () => {
  const contract = makeContract({
    conditions: [{ conditionId: "cond.tests" }, { conditionId: "cond.aux", required: false, minEvidenceLevel: "E1" }],
  });
  const complete = makeEvidence(contract, { conditionIds: ["cond.tests"], environmentFingerprint: FP });
  const auxiliary = evidenceRecordSchema.parse({
    ...makeEvidence(contract, {
      conditionIds: ["cond.aux"], level: "E1", environmentFingerprint: FP, incomplete: ["optional check skipped"],
    }),
    provenance: { ...complete.provenance, trustLevel: "observed" },
  }) as EvidenceRecord;
  const input = { contract, branchId: BRANCH, changedPaths: [], workspaceFingerprint: FP, evidence: [complete, auxiliary] };
  const graph = buildProofGraph(input);
  assert.equal(graph.decision.outcome, "proven");
  assert.equal(graph.decision.conditionResults[1]?.satisfied, true);
  assert.ok(renderProofPackage({ ...input, graph }).unverified.some((item) => item.includes("optional check skipped")));
});

test("external CI proof requires the declared producer and trusted system provenance", () => {
  const contract = makeContract({
    conditions: [{
      conditionId: "cond.ci", minEvidenceLevel: "E4", requiresIndependence: true,
      verifier: { kind: "external_ci", id: "ci.test", version: "1.0.0" },
    }],
  });
  const original = makeEvidence(contract, { conditionIds: ["cond.ci"], level: "E4", mode: "external_service" });
  const record = evidenceRecordSchema.parse({
    ...original,
    producer: { kind: "external", id: "ci.test", version: "1.0.0" },
    provenance: { ...original.provenance, sourceKind: "system" },
  }) as EvidenceRecord;
  const input = { contract, branchId: BRANCH, changedPaths: [], evidence: [record] };
  assert.equal(evaluateCompletion(input).outcome, "proven");
  const untrusted = evidenceRecordSchema.parse({
    ...record, provenance: { ...record.provenance, trustLevel: "untrusted" },
  }) as EvidenceRecord;
  assert.equal(evaluateCompletion({ ...input, evidence: [untrusted] }).outcome, "not_proven");
});
