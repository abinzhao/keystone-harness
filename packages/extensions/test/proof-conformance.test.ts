import assert from "node:assert/strict";
import test from "node:test";

import { buildProofGraph, evaluateCompletion, renderProofPackage } from "@keystone/kernel";
import {
  evidenceRecordSchema,
  extensionManifestSchema,
  newId,
  outcomeContractSchema,
  sha256Hex,
  type EvidenceRecord,
  type OutcomeContract,
} from "@keystone/schemas";

import { runConformance } from "../src/conformance.ts";

const ISO = "2026-10-21T06:00:00.000Z";
const FP = "a".repeat(64);

function fixture() {
  const projectId = newId("proj");
  const taskId = newId("task");
  const branchId = newId("branch");
  const budget = { maxTokens: 1000, maxWallClockMs: 60_000, maxRetries: 1 };
  const contract = outcomeContractSchema.parse({
    contractId: newId("contract"), version: 2, taskId, projectId, createdAt: ISO, createdBy: "kernel",
    goal: "Check extension evidence cannot replace kernel proof admission",
    scope: { include: [{ kind: "glob", pattern: "src/**", intent: "write" }], exclude: [], unknown: [] },
    invariants: [],
    completionConditions: [{
      conditionId: "cond.tests", description: "Tests pass independently",
      verifier: { kind: "custom", id: "extension.tests", version: "1.0.0" },
      minEvidenceLevel: "E3", requiresIndependence: true, required: true,
    }],
    budget,
    autonomy: {
      projectId, readPaths: ["**"], writePaths: ["src/**"], allowedCommands: ["node"],
      allowedHosts: [], allowedCredentials: [], externalSystems: "none", maxReversibility: "reversible",
      untrustedContentEgress: "deny_all", budget, updatedAt: ISO, updatedBy: "user", widenedBy: [],
    },
    uncertainties: [], interventionTriggers: ["ambiguity"],
    exitConditions: [{ exitId: "exit.budget", kind: "budget_exhausted", description: "Budget exhausted" }],
    status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
  const record = evidenceRecordSchema.parse({
    evidenceId: newId("evd"), taskId, branchId, conditionIds: ["cond.tests"], level: "E3",
    producer: { kind: "verifier", id: "extension.tests", version: "1.0.0" },
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"], environmentFingerprint: FP },
    provenance: {
      provenanceId: newId("prov"), sourceKind: "verifier", trustLevel: "verified", locator: "fixture",
      derivedFrom: [], invalidatedBy: ["workspace.changed", "verifier.changed"], observedAt: ISO,
    },
    workspaceSnapshotId: newId("snap"), contractId: contract.contractId, contractVersion: contract.version,
    observation: { summary: "Tests passed", truncated: false }, createdAt: ISO,
    contentHash: sha256Hex("fixture observation"), status: "valid", invalidatedBy: [],
  }) as EvidenceRecord;
  return { contract, branchId, changedPaths: [], workspaceFingerprint: FP, evidence: [record] };
}

const manifest = extensionManifestSchema.parse({
  name: "keystone-proof-conformance", version: "1.0.0", publisher: "keystone",
  integrity: { algorithm: "sha256", digest: sha256Hex("fixture extension") }, kind: "verifier", apiVersion: "1.0",
  capabilities: ["cmd.exec"], sideEffects: [{ kind: "process_spawn", scope: "fixture test runner" }],
  reversibility: "reversible", egressHosts: [], credentialHandles: [],
  dataClassification: { reads: "internal", egress: [] },
  produces: { observations: ["test_result"], evidenceTypes: ["test_run"] },
  execution: { replayable: true, idempotent: true }, dependencies: [], conflicts: [], uninstall: "safe",
});

const attacks: {
  name: string;
  change: (record: EvidenceRecord) => Record<string, unknown>;
}[] = [
  { name: "foreign task", change: () => ({ taskId: newId("task") }) },
  { name: "foreign branch", change: () => ({ branchId: newId("branch") }) },
  { name: "foreign contract", change: () => ({ contractId: newId("contract") }) },
  { name: "earlier revision", change: () => ({ contractVersion: 1 }) },
  { name: "different verifier", change: (record) => ({ producer: { ...record.producer, id: "other.verifier" } }) },
  { name: "different version", change: (record) => ({ producer: { ...record.producer, version: "2.0.0" } }) },
  { name: "model producer", change: (record) => ({ producer: { ...record.producer, kind: "model" } }) },
  { name: "untrusted extension output", change: (record) => ({
    provenance: { ...record.provenance, sourceKind: "extension", trustLevel: "untrusted" },
  }) },
];

for (const attack of attacks) {
  test(`proof conformance: a client cannot use ${attack.name} as current proof`, async () => {
    const input = fixture();
    const original = input.evidence[0]!;
    assert.equal(evaluateCompletion(input).outcome, "proven", "the control must be legal evidence");
    const offered = evidenceRecordSchema.parse({ ...original, ...attack.change(original) }) as EvidenceRecord;
    const before = structuredClone(offered);
    const candidate = { ...input, evidence: [offered] };
    const report = await runConformance({
      manifest,
      integrityVerified: true,
      probes: [{
        checkId: "proof.current_admission", blocking: true, detail: "kernel refuses foreign or untrusted support",
        run: async () => {
          const graph = buildProofGraph(candidate);
          const pkg = renderProofPackage({ ...candidate, graph });
          return {
            passed: graph.decision.outcome === "not_proven" && pkg.outcome === "not_proven",
            detail: `kernel outcome: ${graph.decision.outcome}; package outcome: ${pkg.outcome}`,
          };
        },
      }],
    });
    assert.equal(report.passed, true, report.checks.map((check) => check.detail).join("; "));
    assert.deepEqual(offered, before, "conformance must not rewrite the offered record");
  });
}
