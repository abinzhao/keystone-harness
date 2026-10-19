/**
 * Primitive value shapes shared by every Keystone schema.
 *
 * Types only — no runtime behaviour beyond the tiny Result helpers. Keystone
 * stores and transmits protocol objects as JSON, so every persisted field must
 * be representable as JSON (PRD 12.5: Contract, Run Event, Evidence, Proof and
 * Extension Manifest use independent schema versions).
 */

/** Values that survive `JSON.stringify` without coercion. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Nominal typing for identifiers. Prevents passing a TaskId where an
 * EvidenceId is expected — these are the objects that carry authority.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TaskId = Brand<string, "TaskId">;
export type ContractId = Brand<string, "ContractId">;
export type EventId = Brand<string, "EventId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type BranchId = Brand<string, "BranchId">;
export type LeaseId = Brand<string, "LeaseId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type ConditionId = Brand<string, "ConditionId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type ProvenanceId = Brand<string, "ProvenanceId">;
export type ProjectId = Brand<string, "ProjectId">;
export type FactId = Brand<string, "FactId">;
export type ExperienceId = Brand<string, "ExperienceId">;
export type EvaluationId = Brand<string, "EvaluationId">;
export type InterventionId = Brand<string, "InterventionId">;
export type DecisionId = Brand<string, "DecisionId">;
export type ProposalId = Brand<string, "ProposalId">;
export type ExtensionId = Brand<string, "ExtensionId">;

/** RFC 3339 / ISO 8601 instant in UTC, e.g. `2026-10-19T06:00:00.000Z`. */
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

/** Lowercase hex sha-256 digest. Used for content addressing and hash chains. */
export type Sha256Hex = Brand<string, "Sha256Hex">;

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Narrow `T | undefined` without a truthiness check (0 and "" are valid values). */
export function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

export function unreachable(value: never, context: string): never {
  throw new Error(`unreachable in ${context}: ${JSON.stringify(value)}`);
}
