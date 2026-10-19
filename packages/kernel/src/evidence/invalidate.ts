/**
 * Precise evidence invalidation (PRD VF-06, PI-04).
 *
 * When the workspace, dependencies, tools, verifiers, Contract or a key project
 * fact change, affected evidence is marked along the proof graph rather than
 * throwing away the whole task history: historical "proven" records stay, but
 * their current usability becomes valid / partially_invalid / invalid.
 *
 * Every function here is pure and returns *new* records — invalidation must not
 * mutate the records a caller already holds, since those may still describe an
 * earlier, truthful observation.
 */

import {
  nowIso,
  type EvidenceRecord,
  type EvidenceStatus,
  type IsoTimestamp,
  type Sha256Hex,
} from "@keystone/schemas";

export type InvalidationTrigger =
  | "workspace_changed"
  | "dependency_changed"
  | "tool_changed"
  | "verifier_changed"
  | "contract_revised"
  | "fact_invalidated"
  | "source_untrusted";

export interface WorkspaceChangeInput {
  readonly previousFingerprint?: Sha256Hex;
  readonly currentFingerprint: Sha256Hex;
  readonly changedPaths: readonly string[];
  readonly currentContractVersion?: number;
}

export interface WorkspaceInvalidationResult {
  readonly invalidated: readonly EvidenceRecord[];
  readonly reason: string;
}

export type WorkspaceInvalidation = "valid" | "partially_invalid" | "invalid";

/** Producers that observe the workspace. `external` proofs do not (E4). */
const WORKSPACE_DEPENDENT_PRODUCERS = new Set(["tool", "verifier"]);

/** Sources whose poisoning must spread to evidence derived from them. */
const POISONABLE_SOURCES = new Set(["experience", "web", "issue", "extension"]);

/**
 * Decide how a workspace change affects one record (VF-06).
 *
 * The reasoning, in order:
 *  - If the fingerprint is unchanged, the workspace the evidence describes is
 *    still the workspace we have, so the evidence stands.
 *  - Only tool/verifier evidence (E1–E3) depends on the workspace; an external
 *    proof (E4) was produced elsewhere and is unaffected.
 *  - With specific changed paths we cannot tell whether this record covers them,
 *    so it is fully `invalid`; with only a fingerprint change we know something
 *    moved but not that this record is wrong, so it is `partially_invalid`.
 */
export function computeWorkspaceInvalidation(
  record: EvidenceRecord,
  input: WorkspaceChangeInput,
): WorkspaceInvalidation {
  if (input.previousFingerprint !== undefined && input.previousFingerprint === input.currentFingerprint) {
    return "valid";
  }
  if (!WORKSPACE_DEPENDENT_PRODUCERS.has(record.producer.kind)) return "valid";
  return input.changedPaths.length === 0 ? "partially_invalid" : "invalid";
}

export function invalidateForWorkspaceChange(
  records: readonly EvidenceRecord[],
  input: WorkspaceChangeInput,
): WorkspaceInvalidationResult {
  const at = nowIso();
  const invalidated: EvidenceRecord[] = [];
  for (const record of records) {
    const status = computeWorkspaceInvalidation(record, input);
    if (status === "valid") continue;
    invalidated.push(
      applyInvalidation(record, status, ["workspace_changed", input.currentFingerprint], at),
    );
  }

  const paths = input.changedPaths.length === 0 ? "no specific paths" : `${input.changedPaths.length} path(s)`;
  const reason =
    `workspace fingerprint changed to ${input.currentFingerprint} (${paths}); ` +
    "tool/verifier evidence was re-evaluated";

  return { invalidated, reason };
}

/**
 * Apply a lifecycle trigger to a set of records. The caller is responsible for
 * pre-filtering where the trigger is inherently scoped — e.g. only the records
 * that predate a Contract revision reach `contract_revised`.
 */
export function invalidateByTrigger(
  records: readonly EvidenceRecord[],
  trigger: InvalidationTrigger,
  detail: string,
): readonly EvidenceRecord[] {
  const at = nowIso();
  const tokens = detailTokens(trigger, detail);

  return records.map((record) => {
    const status = statusForTrigger(record, trigger);
    if (status === undefined) return record;
    return applyInvalidation(record, status, tokens, at);
  });
}

function statusForTrigger(
  record: EvidenceRecord,
  trigger: InvalidationTrigger,
): EvidenceStatus | undefined {
  switch (trigger) {
    case "verifier_changed":
      return record.producer.kind === "verifier" ? "invalid" : undefined;
    case "tool_changed":
      return record.producer.kind === "tool" ? "invalid" : undefined;
    case "dependency_changed":
      return (record.level === "E2" || record.level === "E3") &&
        (record.producer.kind === "tool" || record.producer.kind === "verifier")
        ? "partially_invalid"
        : undefined;
    case "contract_revised":
      return "partially_invalid";
    case "fact_invalidated":
    case "source_untrusted":
      return POISONABLE_SOURCES.has(record.provenance.sourceKind) ? "invalid" : undefined;
    default:
      return undefined;
  }
}

/**
 * A record's `invalidatedBy` holds machine-readable condition tokens, so a
 * free-form `detail` is only recorded when it already looks like one; otherwise
 * the trigger alone is enough to explain the change.
 */
function detailTokens(trigger: InvalidationTrigger, detail: string): string[] {
  const tokens: string[] = [trigger];
  if (/^[a-z][a-z0-9_.-]*$/.test(detail)) tokens.push(detail);
  return tokens;
}

/**
 * Return a copy of `record` with the new status, the reasons merged into
 * `invalidatedBy`, and the invalidation time set. The original is untouched.
 */
export function applyInvalidation(
  record: EvidenceRecord,
  status: EvidenceStatus,
  reason: string | readonly string[],
  at: IsoTimestamp,
): EvidenceRecord {
  const reasons = typeof reason === "string" ? [reason] : reason;
  const invalidatedBy = [...new Set([...record.invalidatedBy, ...reasons])];
  return {
    ...record,
    status,
    invalidatedBy,
    invalidatedAt: at,
  };
}
