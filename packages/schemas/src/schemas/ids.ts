/**
 * Branded validators for identifiers, timestamps and digests.
 *
 * Keystone ids are `<prefix>_<ULID>` (see `ids.ts`). Validating the shape at the
 * boundary means a truncated or hand-written id fails loudly instead of being
 * carried into an evidence chain and only surfacing during a proof query.
 *
 * The `as unknown as` casts are the one place nominal typing is introduced: the
 * runtime check is a plain string shape test, and the brand is what stops a
 * `LeaseId` from being passed where an `EvidenceId` belongs.
 */

import type {
  ArtifactId,
  BranchId,
  CheckpointId,
  ConditionId,
  ContractId,
  DecisionId,
  EvaluationId,
  EvidenceId,
  EventId,
  ExperienceId,
  ExtensionId,
  FactId,
  InterventionId,
  IsoTimestamp,
  LeaseId,
  ProjectId,
  ProposalId,
  ProvenanceId,
  Sha256Hex,
  SnapshotId,
  TaskId,
} from "../primitives.ts";
import type { Validator } from "../validate.ts";
import { str } from "../validate.ts";

const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

function idValidator<T extends string>(prefix: string, description: string): Validator<T> {
  return str({
    pattern: new RegExp(`^${prefix}_${ULID_BODY}$`),
    description: `${description} (${prefix}_<ULID>)`,
  }) as unknown as Validator<T>;
}

export const taskIdValidator = idValidator<TaskId>("task", "Task identifier");
export const contractIdValidator = idValidator<ContractId>("contract", "Outcome Contract identifier");
export const eventIdValidator = idValidator<EventId>("evt", "Run event identifier");
export const checkpointIdValidator = idValidator<CheckpointId>("ckpt", "Checkpoint identifier");
export const branchIdValidator = idValidator<BranchId>("branch", "Run branch identifier");
export const leaseIdValidator = idValidator<LeaseId>("lease", "Capability lease identifier");
export const evidenceIdValidator = idValidator<EvidenceId>("evd", "Evidence record identifier");
export const conditionIdValidator = idValidator<ConditionId>("cond", "Completion condition identifier");
/**
 * Artifacts are content addresses, not random ids: `art_<sha256>`. Lookup needs
 * no index, and two runs that produce identical output share one artifact, which
 * is what keeps "large tool output" from bloating the ledger (PRD 12.4).
 */
export const artifactIdValidator = str({
  pattern: /^art_[0-9a-f]{64}$/,
  description: "content-addressed artifact id (art_<sha256 hex>)",
}) as unknown as Validator<ArtifactId>;
export const snapshotIdValidator = idValidator<SnapshotId>("snap", "Workspace snapshot identifier");
export const provenanceIdValidator = idValidator<ProvenanceId>("prov", "Provenance record identifier");
export const projectIdValidator = idValidator<ProjectId>("proj", "Project identifier");
export const factIdValidator = idValidator<FactId>("fact", "Project fact identifier");
export const experienceIdValidator = idValidator<ExperienceId>("exp", "Experience entry identifier");
export const evaluationIdValidator = idValidator<EvaluationId>("eval", "Experience evaluation identifier");
export const interventionIdValidator = idValidator<InterventionId>("intr", "Intervention request identifier");
export const decisionIdValidator = idValidator<DecisionId>("dec", "User decision identifier");
export const proposalIdValidator = idValidator<ProposalId>("prop", "Action proposal identifier");
export const extensionIdValidator = idValidator<ExtensionId>("ext", "Extension identifier");

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Instant in UTC on the RFC 3339 form produced by `Date.prototype.toISOString`. */
export const isoTimestampValidator = str({
  pattern: ISO_RE,
  description: "ISO 8601 instant in UTC, e.g. 2026-10-19T06:00:00.000Z",
}) as unknown as Validator<IsoTimestamp>;

/** Lowercase hex sha-256 digest. */
export const sha256Validator = str({
  pattern: /^[0-9a-f]{64}$/,
  description: "lowercase hex sha-256 digest",
}) as unknown as Validator<Sha256Hex>;

/** Repository-relative POSIX path. Rejects absolute paths and parent escapes. */
export const relativePathValidator = str({
  pattern: /^(?![\\/])(?!.*(?:^|\/)\.\.(?:\/|$)).+$/,
  description: "repository-relative POSIX path without parent escapes",
});

/**
 * Stable identifier scoped to its parent object — completion conditions,
 * invariants, proof nodes, context items, proposals, decisions.
 *
 * These are deliberately *not* ULIDs: they must remain stable across Contract
 * revisions so that evidence produced before a revision can still be matched to
 * the condition it was produced for (PRD OT-03).
 */
export const localIdValidator = str({
  pattern: /^[a-z][a-z0-9_.-]{0,63}$/,
  description: "stable local identifier, e.g. cond.tests_pass",
});
