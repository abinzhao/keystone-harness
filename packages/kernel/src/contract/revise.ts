/**
 * Contract revision.
 *
 * A revision never edits the previous contract: it produces a new version that
 * points back at its parent, so evidence produced under an earlier version stays
 * attributable (PRD OT-03). Two consequences drive the return value:
 *
 *  - Shrinking the write scope strands evidence and leases that were issued for
 *    the removed paths, so `invalidated` names every path that disappeared.
 *  - Widening the scope is never silent, so the revised contract enters
 *    `awaiting_approval` (PRD OT-03).
 */

import {
  canonicalJson,
  evidenceRank,
  newId,
  outcomeContractSchema,
  type Budget,
  type CompletionCondition,
  type ExitCondition,
  type InterventionTrigger,
  type Invariant,
  type OutcomeContract,
  type Scope,
  type ScopeEntry,
} from "@keystone/schemas";

export interface ContractPatch {
  readonly goal?: string;
  readonly scope?: Scope;
  readonly invariants?: readonly Invariant[];
  readonly completionConditions?: readonly CompletionCondition[];
  readonly budget?: Budget;
  readonly interventionTriggers?: readonly InterventionTrigger[];
  readonly exitConditions?: readonly ExitCondition[];
}

export interface ReviseContractResult {
  readonly contract: OutcomeContract;
  readonly changedFields: readonly string[];
  /** Things the revision invalidates, described for the UI (PRD OT-03). */
  readonly invalidated: readonly string[];
}

const PATCH_FIELDS = [
  "goal",
  "scope",
  "invariants",
  "completionConditions",
  "budget",
  "interventionTriggers",
  "exitConditions",
] as const;

/** Top-level content fields compared by `diffContracts`. Contract identity and
 * revision metadata are deliberately excluded: they always differ between
 * versions, so including them would make the diff useless. */
const CONTENT_FIELDS = [
  "goal",
  "scope",
  "invariants",
  "completionConditions",
  "budget",
  "autonomy",
  "uncertainties",
  "interventionTriggers",
  "exitConditions",
  "status",
] as const;

function writeEntries(scope: Scope): readonly ScopeEntry[] {
  return scope.include.filter((entry) => entry.intent === "write");
}

function entryKey(entry: ScopeEntry): string {
  return `${entry.kind}::${entry.pattern}`;
}

/** Write-scope patterns present before a revision and gone after it. */
function goneWritePatterns(previous: Scope, next: Scope): readonly string[] {
  const nextKeys = new Set(writeEntries(next).map(entryKey));
  const gone = writeEntries(previous)
    .filter((entry) => !nextKeys.has(entryKey(entry)))
    .map((entry) => entry.pattern);
  return [...new Set(gone)].sort();
}

/** Write-scope patterns newly added by a revision. */
function addedWritePatterns(previous: Scope, next: Scope): readonly string[] {
  const previousKeys = new Set(writeEntries(previous).map(entryKey));
  const added = writeEntries(next)
    .filter((entry) => !previousKeys.has(entryKey(entry)))
    .map((entry) => entry.pattern);
  return [...new Set(added)].sort();
}

/** Paths that leave the write scope across a revision, for the UI to explain. */
export function outOfScopeAfterRevision(
  previous: OutcomeContract,
  next: OutcomeContract,
): readonly string[] {
  return goneWritePatterns(previous.scope, next.scope);
}

/**
 * Conditions whose evidence may need to be re-run: removed ones, ones whose
 * minimum evidence level rose, and newly added ones. Rendered as one readable
 * tag so the UI can list exactly which conditions invalidated prior evidence.
 */
function changedConditionIds(
  previous: readonly CompletionCondition[],
  next: readonly CompletionCondition[],
): readonly string[] {
  const previousById = new Map(previous.map((condition) => [condition.conditionId, condition]));
  const nextById = new Map(next.map((condition) => [condition.conditionId, condition]));
  const changed = new Set<string>();

  for (const [id, before] of previousById) {
    const after = nextById.get(id);
    if (after === undefined) {
      changed.add(id);
      continue;
    }
    if (evidenceRank(after.minEvidenceLevel) > evidenceRank(before.minEvidenceLevel)) {
      changed.add(id);
    }
  }
  for (const id of nextById.keys()) {
    if (!previousById.has(id)) changed.add(id);
  }

  return [...changed].sort();
}

export function diffContracts(a: OutcomeContract, b: OutcomeContract): readonly string[] {
  const changed: string[] = [];
  for (const field of CONTENT_FIELDS) {
    if (canonicalJson(a[field] as unknown) !== canonicalJson(b[field] as unknown)) {
      changed.push(field);
    }
  }
  return changed.sort();
}

export function reviseContract(
  previous: OutcomeContract,
  patch: ContractPatch,
  reason: string,
  source: "user" | "kernel",
): ReviseContractResult {
  const nextScope = patch.scope ?? previous.scope;
  const gone = goneWritePatterns(previous.scope, nextScope);
  const added = addedWritePatterns(previous.scope, nextScope);

  // Scope expansion can never be applied automatically; it drops back to the
  // human-confirmation status regardless of the previous status.
  const status = added.length > 0 ? "awaiting_approval" : previous.status;

  const contract = outcomeContractSchema.parse({
    ...previous,
    // A revision is a new object, not a mutated one: fresh identity, version
    // bumped, lineage recorded (PRD OT-03).
    contractId: newId("contract"),
    version: previous.version + 1,
    createdAt: new Date().toISOString(),
    goal: patch.goal ?? previous.goal,
    scope: nextScope,
    invariants: patch.invariants ?? previous.invariants,
    completionConditions: patch.completionConditions ?? previous.completionConditions,
    budget: patch.budget ?? previous.budget,
    interventionTriggers: patch.interventionTriggers ?? previous.interventionTriggers,
    exitConditions: patch.exitConditions ?? previous.exitConditions,
    parentContractId: previous.contractId,
    revisionReason: reason.slice(0, 2000),
    revisionSource: source,
    status,
  }) as OutcomeContract;

  const changedFields: string[] = [];
  for (const field of PATCH_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (canonicalJson(value as unknown) !== canonicalJson(previous[field] as unknown)) {
      changedFields.push(field);
    }
  }
  changedFields.sort();

  const invalidated: string[] = [];
  for (const path of gone) invalidated.push(`evidence_outside_scope:${path}`);
  if (added.length > 0) invalidated.push("requires_confirmation:scope_expansion");

  const affectedConditions = changedConditionIds(
    previous.completionConditions,
    contract.completionConditions,
  );
  if (affectedConditions.length > 0) {
    invalidated.push(`conditions_changed:${affectedConditions.join(",")}`);
  }

  return { contract, changedFields, invalidated };
}
