/**
 * Completion evaluation — the deterministic query that decides "proven".
 *
 * `已证明` is never a message, a status write or a model claim: it is this
 * function's result for a Contract, a set of Evidence records and (optionally)
 * the fingerprint of the workspace being proved (PRD VF-04, 9.1; ADR-0001).
 *
 * Everything here is pure. The graph layer imports this module; this module
 * must not import the graph layer, so the two can be built and reasoned about
 * independently.
 */

import {
  completionDecisionSchema,
  conditionResultSchema,
  evidenceRank,
  levelCanStandAlone,
  levelSatisfies,
  trustRank,
  type CompletionCondition,
  type CompletionDecision,
  type ConditionReasonCode,
  type ConditionResult,
  type EvidenceLevel,
  type EvidenceRecord,
  type OutcomeContract,
  type ProofOutcome,
} from "@keystone/schemas";

import { checkPaths } from "../scope/scope.ts";

export { unmetRequiredConditions } from "@keystone/schemas";

export interface EvaluateInput {
  readonly contract: OutcomeContract;
  /** Recorded intent, supplied by the kernel rather than a verifier or client. */
  readonly taskIntent?: "analysis" | "engineering";
  readonly branchId: string;
  readonly changedPaths: readonly string[];
  readonly workspaceFingerprint?: string;
  readonly evidence: readonly EvidenceRecord[];
  readonly verifierFailures?: readonly { conditionId: string; detail: string }[];
}

export interface EvidenceAdmission {
  readonly admitted: boolean;
  readonly reasonCode: "satisfied" | "evidence_invalid" | "pending" | "workspace_changed";
  readonly reason: string;
}

/**
 * Applicability is checked before level or independence. A persisted `valid`
 * record is historical input, not permission to reuse it for another proof.
 * Shared with the graph so rejected support stays visible without rewriting it.
 */
export function evaluateEvidenceAdmission(
  input: Pick<EvaluateInput, "contract" | "branchId" | "workspaceFingerprint"> & {
    readonly evidence?: readonly EvidenceRecord[];
  },
  condition: CompletionCondition,
  record: EvidenceRecord,
): EvidenceAdmission {
  const reject = (
    reasonCode: Exclude<EvidenceAdmission["reasonCode"], "satisfied">,
    reason: string,
  ): EvidenceAdmission => ({ admitted: false, reasonCode, reason: `evidence ${record.evidenceId}: ${reason}` });

  if (record.taskId !== input.contract.taskId) return reject("evidence_invalid", "foreign task");
  if (record.branchId !== input.branchId) return reject("evidence_invalid", "foreign branch");
  if (record.contractId !== input.contract.contractId) return reject("evidence_invalid", "foreign contract");
  if (record.contractVersion !== input.contract.version) {
    return reject("evidence_invalid", `contract revision ${record.contractVersion} does not match ${input.contract.version}`);
  }
  if (record.producer.id !== condition.verifier.id || record.producer.version !== condition.verifier.version) {
    return reject("evidence_invalid", `producer ID/version does not match ${condition.verifier.id}@${condition.verifier.version}`);
  }
  const external = record.producer.kind === "external" && condition.verifier.kind === "external_ci";
  if (record.producer.kind !== "verifier" && !external) {
    return reject("evidence_invalid", `producer kind ${record.producer.kind} cannot perform ${condition.verifier.kind} verification`);
  }

  if (record.status !== "valid") {
    return reject(
      record.status === "partially_invalid" ? "pending" : "evidence_invalid",
      `record is ${record.status}; re-verification is required`,
    );
  }
  if (record.invalidatedBy.length > 0 || record.invalidatedAt !== undefined) {
    return reject("evidence_invalid", "record carries an actual invalidation; re-verification is required");
  }

  // Provenance invalidatedBy names potential triggers, not actual invalidation.
  // The latter belongs to EvidenceRecord and was checked above.
  const source = external ? "system" : "verifier";
  if (record.provenance.sourceKind !== source) {
    return reject("evidence_invalid", `provenance source ${record.provenance.sourceKind} is not ${source} output`);
  }
  const minimumTrust = condition.required || evidenceRank(record.level) >= evidenceRank("E2") ? "verified" : "observed";
  if (trustRank(record.provenance.trustLevel) < trustRank(minimumTrust)) {
    return reject("evidence_invalid", `provenance trust ${record.provenance.trustLevel} is below ${minimumTrust}`);
  }
  if (record.provenance.applicableSnapshot !== undefined &&
      record.provenance.applicableSnapshot !== record.workspaceSnapshotId) {
    return reject("evidence_invalid", "provenance applies to a different workspace snapshot");
  }
  if (condition.required && (record.observation.incomplete?.length ?? 0) > 0) {
    return reject("pending", `required observation is incomplete: ${record.observation.incomplete!.join("; ")}`);
  }
  if (input.workspaceFingerprint !== undefined &&
      record.independence.environmentFingerprint !== input.workspaceFingerprint) {
    return reject("workspace_changed", "workspace fingerprint is unknown or differs from the current workspace");
  }
  const supersedingFailure = input.evidence?.find((candidate) =>
    candidate.taskId === record.taskId && candidate.branchId === record.branchId &&
    candidate.contractId === record.contractId && candidate.contractVersion === record.contractVersion &&
    candidate.conditionIds.includes(condition.conditionId) &&
    candidate.producer.kind === record.producer.kind && candidate.producer.id === record.producer.id &&
    candidate.producer.version === record.producer.version &&
    candidate.provenance.sourceKind === record.provenance.sourceKind &&
    trustRank(candidate.provenance.trustLevel) >= trustRank("verified") &&
    candidate.independence.environmentFingerprint === record.independence.environmentFingerprint &&
    candidate.status === "invalid" && candidate.invalidatedBy.includes("verifier.reported_failure") &&
    (candidate.createdAt > record.createdAt ||
      (candidate.createdAt === record.createdAt && candidate.evidenceId > record.evidenceId)),
  );
  if (supersedingFailure !== undefined) {
    return reject("evidence_invalid", `superseded by verifier failure ${supersedingFailure.evidenceId}`);
  }
  return { admitted: true, reasonCode: "satisfied", reason: "evidence applies to the current proof" };
}

interface EvaluationContext {
  readonly input: EvaluateInput;
  readonly byId: Map<string, CompletionCondition>;
  readonly memo: Map<string, ConditionResult>;
  /** Conditions currently on the recursion stack, for cycle detection. */
  readonly visiting: Set<string>;
}

function makeContext(input: EvaluateInput): EvaluationContext {
  return {
    input,
    byId: new Map(input.contract.completionConditions.map((condition) => [condition.conditionId, condition])),
    memo: new Map(),
    visiting: new Set(),
  };
}

/**
 * PRD VF-02: E0 is a model claim and can never satisfy a completion condition,
 * so a condition that nominally requires E0 is raised to E1 — the lowest level
 * that can ever count for anything.
 */
function effectiveMinLevel(condition: CompletionCondition): EvidenceLevel {
  return condition.minEvidenceLevel === "E0" ? "E1" : condition.minEvidenceLevel;
}

/**
 * Whether `level` can carry this condition. Two rules beyond the plain ordering:
 * E0 can never stand alone, and a *required* condition needs evidence that
 * stands on its own (E2+); E1 is only acceptable for auxiliary checks
 * (PRD VF-02).
 */
function levelSatisfiesCondition(level: EvidenceLevel, condition: CompletionCondition): boolean {
  if (!levelSatisfies(level, effectiveMinLevel(condition))) return false;
  return condition.required ? levelCanStandAlone(level) : level !== "E0";
}

function highestLevel(levels: readonly EvidenceLevel[]): EvidenceLevel {
  let best: EvidenceLevel = levels[0] ?? "E0";
  for (const level of levels) {
    if (evidenceRank(level) > evidenceRank(best)) best = level;
  }
  return best;
}

/**
 * Independence (PRD VF-01, VF-04). Sharing the Builder Loop's process is never
 * independent. An isolated workspace or an external service is stronger
 * isolation than a separate process and counts even when it does not spell out
 * the process axis explicitly.
 */
function satisfiesIndependence(record: EvidenceRecord): boolean {
  const { mode, independentOf } = record.independence;
  if (mode === "same_process") return false;
  if (independentOf.includes("builder_loop_process")) return true;
  return mode === "isolated_workspace" || mode === "external_service";
}

interface Draft {
  readonly satisfied: boolean;
  readonly reasonCode: ConditionReasonCode;
  readonly reason: string;
  readonly achievedLevel?: EvidenceLevel;
  readonly independenceSatisfied: boolean;
  readonly evidenceIds: readonly string[];
}

function candidateIds(input: EvaluateInput, conditionId: string): string[] {
  return input.evidence
    .filter((record) => record.conditionIds.includes(conditionId))
    .map((record) => record.evidenceId)
    .slice(0, 128);
}

function makeResult(condition: CompletionCondition, draft: Draft): ConditionResult {
  return conditionResultSchema.parse({
    conditionId: condition.conditionId,
    description: condition.description,
    required: condition.required,
    satisfied: draft.satisfied,
    reasonCode: draft.reasonCode,
    reason: draft.reason.slice(0, 2000),
    requiredLevel: effectiveMinLevel(condition),
    ...(draft.achievedLevel === undefined ? {} : { achievedLevel: draft.achievedLevel }),
    requiresIndependence: condition.requiresIndependence,
    independenceSatisfied: draft.independenceSatisfied,
    evidenceIds: [...draft.evidenceIds],
  }) as ConditionResult;
}

/**
 * The evidence-only verdict for one condition. Ordering of the checks matters:
 * level before independence, and independence only among records that already
 * meet the level, so a low-level record can never "pass" the independence gate.
 */
function evaluateEvidence(context: EvaluationContext, condition: CompletionCondition): Draft {
  const id = condition.conditionId;
  const candidates = context.input.evidence.filter((record) => record.conditionIds.includes(id));
  const evidenceIds = candidateIds(context.input, id);
  const vacuousIndependence = !condition.requiresIndependence;

  if (candidates.length === 0) {
    return {
      satisfied: false,
      reasonCode: "no_evidence",
      reason: `no evidence was offered for ${id}`,
      independenceSatisfied: vacuousIndependence,
      evidenceIds,
    };
  }

  const admissions = candidates.map((record) => ({
    record,
    admission: evaluateEvidenceAdmission(context.input, condition, record),
  }));
  const usable = admissions.filter((entry) => entry.admission.admitted).map((entry) => entry.record);
  if (usable.length === 0) {
    const rejection = admissions
      .map((entry) => entry.admission)
      .sort((a, b) => REASON_PRIORITY[a.reasonCode] - REASON_PRIORITY[b.reasonCode])[0]!;
    return {
      satisfied: false,
      reasonCode: rejection.reasonCode,
      reason: rejection.reason,
      independenceSatisfied: vacuousIndependence,
      evidenceIds,
    };
  }

  const achievedLevel = highestLevel(usable.map((record) => record.level));
  const qualifying = usable.filter((record) => levelSatisfiesCondition(record.level, condition));

  if (qualifying.length === 0) {
    return {
      satisfied: false,
      reasonCode: "insufficient_level",
      reason:
        `highest evidence for ${id} is ${achievedLevel}, below the ` +
        `${effectiveMinLevel(condition)} the condition requires`,
      achievedLevel,
      independenceSatisfied: vacuousIndependence,
      evidenceIds,
    };
  }

  const supporting = condition.requiresIndependence ? qualifying.filter(satisfiesIndependence) : qualifying;
  if (supporting.length === 0) {
    return {
      satisfied: false,
      reasonCode: "not_independent",
      reason:
        `${id} requires a verifier independent of the Builder Loop's process, ` +
        "but every qualifying record shares it",
      achievedLevel,
      independenceSatisfied: false,
      evidenceIds,
    };
  }

  return {
    satisfied: true,
    reasonCode: "satisfied",
    reason: `${id} is satisfied by ${supporting.length} record(s), highest level ${highestLevel(supporting.map((record) => record.level))}`,
    achievedLevel: highestLevel(supporting.map((record) => record.level)),
    independenceSatisfied: true,
    evidenceIds: supporting.map((record) => record.evidenceId).slice(0, 128),
  };
}

function evaluateWithDeps(context: EvaluationContext, condition: CompletionCondition): ConditionResult {
  const id = condition.conditionId;
  const cached = context.memo.get(id);
  if (cached !== undefined) return cached;

  // An explicit verifier failure overrides any passing evidence, so it is
  // checked before everything else (PRD VF-03, VF-04).
  const failure = context.input.verifierFailures?.find((entry) => entry.conditionId === id);
  if (failure !== undefined) {
    const result = makeResult(condition, {
      satisfied: false,
      reasonCode: "verifier_failed",
      reason: `the verifier reported a failure for ${id}: ${failure.detail}`,
      independenceSatisfied: !condition.requiresIndependence,
      evidenceIds: candidateIds(context.input, id),
    });
    context.memo.set(id, result);
    return result;
  }

  if (context.visiting.has(id)) {
    // A cycle back-edge. Report it without recursing further; the outer frames
    // turn this into a `dependency_unsatisfied` verdict for the whole cycle.
    return makeResult(condition, {
      satisfied: false,
      reasonCode: "dependency_unsatisfied",
      reason: `dependency cycle detected through ${id}`,
      independenceSatisfied: !condition.requiresIndependence,
      evidenceIds: candidateIds(context.input, id),
    });
  }

  const dependencies = condition.dependsOn ?? [];
  if (dependencies.length > 0) {
    context.visiting.add(id);
    let blocking: string | undefined;
    for (const dependency of dependencies) {
      const dependencyCondition = context.byId.get(dependency);
      const dependencyResult =
        dependencyCondition === undefined ? undefined : evaluateWithDeps(context, dependencyCondition);
      if (dependencyResult === undefined || !dependencyResult.satisfied) {
        blocking = dependency;
        break;
      }
    }
    context.visiting.delete(id);
    if (blocking !== undefined) {
      const result = makeResult(condition, {
        satisfied: false,
        reasonCode: "dependency_unsatisfied",
        reason: `${id} depends on ${blocking}, which is not satisfied`,
        independenceSatisfied: !condition.requiresIndependence,
        evidenceIds: candidateIds(context.input, id),
      });
      context.memo.set(id, result);
      return result;
    }
  }

  const result = makeResult(condition, evaluateEvidence(context, condition));
  context.memo.set(id, result);
  return result;
}

export function evaluateCondition(
  input: EvaluateInput,
  condition: CompletionCondition,
): ConditionResult {
  return evaluateWithDeps(makeContext(input), condition);
}

/**
 * Every cycle in the `dependsOn` graph, as a list of condition id paths.
 * Deterministic: cycles are discovered in contract order.
 */
export function detectCycles(conditions: readonly CompletionCondition[]): string[][] {
  const byId = new Map(conditions.map((condition) => [condition.conditionId, condition]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      if (start >= 0) {
        const cycle = stack.slice(start);
        const key = [...cycle].sort().join(">");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }
    const condition = byId.get(id);
    if (condition === undefined) return;
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of condition.dependsOn ?? []) visit(dependency);
    stack.pop();
    state.set(id, "done");
  };

  for (const condition of conditions) visit(condition.conditionId);
  return cycles;
}

const REASON_PRIORITY: Record<ConditionReasonCode, number> = {
  verifier_failed: 0,
  evidence_invalid: 1,
  pending: 2,
  insufficient_level: 3,
  no_evidence: 4,
  not_independent: 5,
  workspace_changed: 6,
  dependency_unsatisfied: 7,
  satisfied: 8,
  scope_exceeded: 9,
  condition_removed: 10,
};

function buildReasons(
  results: readonly ConditionResult[],
  scopeViolations: readonly string[],
  cycles: readonly string[][],
): { code: ConditionReasonCode; detail: string }[] {
  const entries: { code: ConditionReasonCode; detail: string; order: number }[] = [];

  for (const result of results) {
    if (!result.required || result.satisfied) continue;
    entries.push({
      code: result.reasonCode,
      detail:
        result.reason.trim() === ""
          ? `condition ${result.conditionId} is not satisfied (${result.reasonCode})`
          : result.reason,
      order: REASON_PRIORITY[result.reasonCode],
    });
  }
  if (scopeViolations.length > 0) {
    entries.push({
      code: "scope_exceeded",
      detail: `the change set touched paths outside the contract scope: ${scopeViolations
        .slice(0, 10)
        .join(", ")}`,
      order: REASON_PRIORITY.scope_exceeded,
    });
  }
  for (const cycle of cycles) {
    entries.push({
      code: "dependency_unsatisfied",
      detail: `dependency cycle: ${[...cycle, cycle[0]].join(" -> ")}`,
      order: REASON_PRIORITY.dependency_unsatisfied,
    });
  }

  // `Array.prototype.sort` is stable, so equal priorities keep insertion order
  // (contract order for condition reasons).
  entries.sort((a, b) => a.order - b.order);
  return entries.slice(0, 64).map(({ code, detail }) => ({ code, detail: detail.slice(0, 2000) }));
}

/**
 * The timestamp a decision carries. It is derived from the inputs — the newest
 * evidence, or the contract's creation time when there is none — rather than the
 * wall clock, so that an identical proof always yields an identical decision and
 * therefore an identical Proof Graph hash. A proof is a deterministic query
 * (PRD 9.1, NFR-REL-05), not an event.
 */
function decisionTimestamp(input: EvaluateInput): string {
  const times = input.evidence.map((record) => record.createdAt).slice().sort();
  return times[times.length - 1] ?? input.contract.createdAt;
}

function removedConditionResult(
  conditionId: string,
  evidence: readonly EvidenceRecord[],
): ConditionResult {
  const referencing = evidence.filter((record) => record.conditionIds.includes(conditionId));
  const levels = referencing.map((record) => record.level);
  return conditionResultSchema.parse({
    conditionId,
    description: `evidence references "${conditionId}", which the current contract no longer defines`,
    required: false,
    satisfied: false,
    reasonCode: "condition_removed",
    reason: `${conditionId} was removed from the contract but evidence still points at it`,
    requiredLevel: "E1",
    ...(levels.length === 0 ? {} : { achievedLevel: highestLevel(levels) }),
    requiresIndependence: false,
    independenceSatisfied: false,
    evidenceIds: referencing.map((record) => record.evidenceId).slice(0, 128),
  }) as ConditionResult;
}

function isSha256(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{64}$/.test(value);
}

export function evaluateCompletion(input: EvaluateInput): CompletionDecision {
  const context = makeContext(input);
  const conditions = input.contract.completionConditions;
  const results = conditions.map((condition) => evaluateWithDeps(context, condition));

  // Conditions an evidence record still references after they were removed from
  // the contract are reported for diagnostics only (PRD OT-03).
  const known = new Set(conditions.map((condition) => condition.conditionId));
  const removed: ConditionResult[] = [];
  const seenRemoved = new Set<string>();
  for (const record of input.evidence) {
    for (const conditionId of record.conditionIds) {
      if (known.has(conditionId) || seenRemoved.has(conditionId)) continue;
      seenRemoved.add(conditionId);
      removed.push(removedConditionResult(conditionId, input.evidence));
    }
  }

  const cycles = detectCycles(conditions);
  const scopeCheck = checkPaths(input.changedPaths, "write", input.contract.scope);
  const reasons = buildReasons(results, scopeCheck.violations, cycles);
  if (input.taskIntent === "analysis") {
    reasons.unshift({ code: "pending", detail: "Analysis conclusions remain unverified; workspace observations do not prove model conclusions." });
  }

  const blocking = results.filter((result) => result.required && !result.satisfied);
  const outcome: ProofOutcome =
    input.taskIntent !== "analysis" && blocking.length === 0 && cycles.length === 0 && scopeCheck.violations.length === 0
      ? "proven"
      : "not_proven";

  return completionDecisionSchema.parse({
    taskId: input.contract.taskId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.version,
    branchId: input.branchId,
    at: decisionTimestamp(input),
    outcome,
    reasons: reasons.slice(0, 64),
    conditionResults: [...results, ...removed].slice(0, 256),
    changedPaths: [...input.changedPaths],
    ...(isSha256(input.workspaceFingerprint) ? { workspaceFingerprint: input.workspaceFingerprint } : {}),
  }) as CompletionDecision;
}
