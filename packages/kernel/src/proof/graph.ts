/**
 * Proof Graph construction.
 *
 * The graph is the audit trail of a completion decision: every condition node
 * can be walked backwards through `supports` → `verified_by` → `observed_in` to
 * the raw observation, which is what makes "proven" checkable rather than
 * asserted (PRD VF-04, DP-02).
 *
 * Dependency direction is one-way: this module imports the pure evaluator, never
 * the other way round, so the decision can be computed without a graph.
 */

import { createHash } from "node:crypto";

import {
  canonicalJson,
  crockfordBase32,
  proofGraphSchema,
  sha256Hex,
  type EvidenceRecord,
  type OutcomeContract,
  type ProofEdgeRelation,
  type ProofGraph,
  type ProofNodeKind,
  type ProofNodeStatus,
} from "@keystone/schemas";

import { evaluateCompletion, evaluateEvidenceAdmission } from "./evaluate.ts";

// Re-exported so callers can build a decision from the same module graph layer
// without importing the evaluator directly.
export { evaluateCompletion } from "./evaluate.ts";
export type { EvaluateInput } from "./evaluate.ts";

export interface ProofGraphInput {
  readonly contract: OutcomeContract;
  readonly taskIntent?: "analysis" | "engineering";
  readonly branchId: string;
  /** Paths the change set actually touched (from git diff). */
  readonly changedPaths: readonly string[];
  /** Current workspace fingerprint; omitted for a historical-only query. */
  readonly workspaceFingerprint?: string;
  /** Evidence offered in support, already persisted. */
  readonly evidence: readonly EvidenceRecord[];
  /** Snapshot the evidence was observed in, when known. */
  readonly workspaceSnapshotId?: string;
  /** Explicit verifier failures reported by the runtime. */
  readonly verifierFailures?: readonly { conditionId: string; detail: string }[];
}

const LOCAL_ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * A content-derived, character-class-safe token. Used when the human-readable
 * reference (an ULID, a producer id with a slash, a version with dots) cannot
 * appear verbatim in a local id.
 */
function shortToken(seed: string): string {
  const digest = new Uint8Array(createHash("sha256").update(seed, "utf8").digest());
  return crockfordBase32(digest).slice(0, 26).toLowerCase();
}

/**
 * A stable, readable node id of the form `<kind>.<refId>`.
 *
 * `localIdValidator` only admits lowercase `[a-z0-9_.-]`, but evidence ids are
 * ULIDs (uppercase) and producer versions may contain dots and slashes. The
 * reference is therefore normalised — lowercased and with illegal runs replaced
 * by `-` — and only hashed when that still cannot fit the 64-char limit, so the
 * common cases stay legible.
 */
export function proofNodeId(kind: ProofNodeKind, refId: string): string {
  const direct = `${kind}.${refId}`;
  if (LOCAL_ID_RE.test(direct)) return direct;

  const cleaned = refId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const candidate = `${kind}.${cleaned}`;
  if (LOCAL_ID_RE.test(candidate)) return candidate;

  const hashed = `${kind}.${shortToken(refId)}`;
  return LOCAL_ID_RE.test(hashed) ? hashed : hashed.slice(0, 64);
}

function validatorRef(producer: EvidenceRecord["producer"]): string {
  return `${producer.id}@${producer.version}`;
}

function conditionNodeStatus(
  result: { satisfied: boolean; reasonCode: string } | undefined,
): ProofNodeStatus {
  if (result === undefined) return "unsupported";
  if (result.satisfied) return "supported";
  switch (result.reasonCode) {
    case "evidence_invalid":
      return "invalid";
    case "pending":
      return "pending";
    case "verifier_failed":
      return "blocked";
    default:
      return "unsupported";
  }
}

function evidenceNodeState(
  input: ProofGraphInput,
  record: EvidenceRecord,
): { status: ProofNodeStatus; reason?: string } {
  const admissions = input.contract.completionConditions
    .filter((condition) => record.conditionIds.includes(condition.conditionId))
    .map((condition) => evaluateEvidenceAdmission(input, condition, record));
  if (admissions.some((admission) => admission.admitted)) return { status: "supported" };
  if (admissions.length === 0) {
    return { status: "unsupported", reason: "evidence references no current completion condition" };
  }
  const pending = admissions.find((admission) => admission.reasonCode === "pending");
  return {
    status: pending === undefined ? "invalid" : "pending",
    reason: (pending ?? admissions[0])!.reason.slice(0, 2000),
  };
}

export function buildProofGraph(input: ProofGraphInput): ProofGraph {
  const decision = evaluateCompletion({
    contract: input.contract,
    taskIntent: input.taskIntent,
    branchId: input.branchId,
    changedPaths: input.changedPaths,
    workspaceFingerprint: input.workspaceFingerprint,
    evidence: input.evidence,
    ...(input.verifierFailures === undefined ? {} : { verifierFailures: input.verifierFailures }),
  });

  const byConditionId = new Map(
    decision.conditionResults.map((result) => [result.conditionId, result]),
  );
  const conditions = new Map(input.contract.completionConditions.map((condition) => [condition.conditionId, condition]));

  const nodes: {
    nodeId: string;
    kind: ProofNodeKind;
    refId: string;
    label: string;
    status: ProofNodeStatus;
    reason?: string;
  }[] = [];

  const rootNodeIds = input.contract.completionConditions.map((condition) =>
    proofNodeId("condition", condition.conditionId),
  );

  for (const condition of input.contract.completionConditions) {
    const result = byConditionId.get(condition.conditionId);
    const status = conditionNodeStatus(result);
    nodes.push({
      nodeId: proofNodeId("condition", condition.conditionId),
      kind: "condition",
      refId: condition.conditionId,
      label: condition.description,
      status,
      ...(status === "supported" ? {} : { reason: (result?.reason ?? "not satisfied").slice(0, 2000) }),
    });
  }

  const validatorNodeIds = new Map<string, string>();
  const snapshotNodeIds = new Map<string, string>();

  for (const record of input.evidence) {
    const { status, reason } = evidenceNodeState(input, record);
    nodes.push({
      nodeId: proofNodeId("evidence", record.evidenceId),
      kind: "evidence",
      refId: record.evidenceId,
      label: record.observation.summary.trim() === "" ? record.evidenceId : record.observation.summary,
      status,
      ...(reason === undefined ? {} : { reason }),
    });

    const observationIncomplete = record.observation.incomplete ?? [];
    nodes.push({
      nodeId: proofNodeId("observation", record.evidenceId),
      kind: "observation",
      refId: record.evidenceId,
      label: `observation of ${record.evidenceId}`,
      status: observationIncomplete.length > 0 ? "pending" : "supported",
      ...(observationIncomplete.length === 0
        ? {}
        : { reason: `unresolved items: ${observationIncomplete.join("; ")}`.slice(0, 2000) }),
    });

    const validatorRefId = validatorRef(record.producer);
    if (!validatorNodeIds.has(validatorRefId)) {
      const nodeId = proofNodeId("validator", validatorRefId);
      validatorNodeIds.set(validatorRefId, nodeId);
      nodes.push({
        nodeId,
        kind: "validator",
        refId: validatorRefId,
        label: `${record.producer.kind} ${validatorRefId}`,
        status: "supported",
      });
    }

    const snapshotId = record.workspaceSnapshotId;
    if (!snapshotNodeIds.has(snapshotId)) {
      const nodeId = proofNodeId("snapshot", snapshotId);
      snapshotNodeIds.set(snapshotId, nodeId);
      nodes.push({
        nodeId,
        kind: "snapshot",
        refId: snapshotId,
        label: snapshotId,
        status: "supported",
      });
    }
  }

  const edges: { from: string; to: string; relation: ProofEdgeRelation }[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string, relation: ProofEdgeRelation): void => {
    const key = `${from}|${to}|${relation}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, relation });
  };

  for (const record of input.evidence) {
    const evidenceNode = proofNodeId("evidence", record.evidenceId);
    addEdge(proofNodeId("observation", record.evidenceId), evidenceNode, "derived_from");
    addEdge(evidenceNode, proofNodeId("validator", validatorRef(record.producer)), "validated_by");
    addEdge(evidenceNode, proofNodeId("snapshot", record.workspaceSnapshotId), "observed_in");
    for (const conditionId of record.conditionIds) {
      // Retain rejected observations, but never give them a current support edge.
      const condition = conditions.get(conditionId);
      if (condition !== undefined && evaluateEvidenceAdmission(input, condition, record).admitted) {
        addEdge(evidenceNode, proofNodeId("condition", conditionId), "supports");
      }
    }
  }

  const contentHash = sha256Hex(canonicalJson({ nodes, edges, rootNodeIds, decision }));

  return proofGraphSchema.parse({
    taskId: input.contract.taskId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.version,
    branchId: input.branchId,
    // Same derivation as the decision: reproducible over identical inputs.
    createdAt: decision.at,
    nodes,
    edges,
    rootNodeIds,
    decision,
    contentHash,
  }) as ProofGraph;
}
