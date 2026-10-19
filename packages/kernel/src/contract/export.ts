/**
 * Outcome Contract import/export.
 *
 * The export is canonical JSON so every client hashes and diffs the same bytes
 * (PRD 12.5, NFR-COMP-01). The import is deliberately strict about versions: a
 * contract whose schema version cannot be migrated reliably must be refused,
 * never executed on a guess (PRD OT-04).
 */

import {
  SchemaValidationError,
  canonicalJson,
  outcomeContractSchema,
  type OutcomeContract,
} from "@keystone/schemas";

const CURRENT_SCHEMA_VERSION = "keystone.contract.outcome@1.0.0";
const SCHEMA_ID = "keystone.contract.outcome";
const SUPPORTED_MAJOR = "@1.";

/** Top-level keys the current schema knows; anything else is an unknown field. */
const KNOWN_TOP_LEVEL_FIELDS = new Set<string>([
  "contractId",
  "version",
  "taskId",
  "projectId",
  "createdAt",
  "createdBy",
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
  "parentContractId",
  "revisionReason",
  "revisionSource",
  "schemaVersion",
]);

export function exportContractJson(contract: OutcomeContract): string {
  return canonicalJson(contract);
}

export type ImportResult =
  | {
      readonly ok: true;
      readonly contract: OutcomeContract;
      readonly migrationPreview: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly migrationPreview?: readonly string[];
    };

function describeError(error: unknown): string {
  if (error instanceof SchemaValidationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function importContract(value: unknown): ImportResult {
  const record = asRecord(value);
  if (record === undefined) {
    return { ok: false, reason: "contract must be a JSON object" };
  }

  const schemaVersion = record["schemaVersion"];

  if (schemaVersion === CURRENT_SCHEMA_VERSION) {
    try {
      const contract = outcomeContractSchema.parse(record) as OutcomeContract;
      return { ok: true, contract, migrationPreview: [] };
    } catch (error) {
      return { ok: false, reason: `contract failed validation: ${describeError(error)}` };
    }
  }

  if (typeof schemaVersion === "string" && schemaVersion.startsWith(`${SCHEMA_ID}${SUPPORTED_MAJOR}`)) {
    // Same major version: the semantics are representable, so we may try to
    // import after an explicit migration preview. Only schema-level defaults
    // are filled; anything else missing surfaces as a validation failure.
    const migrationPreview = [
      `schemaVersion ${schemaVersion} imported as ${CURRENT_SCHEMA_VERSION} ` +
        "(same major version 1; no semantic migration needed)",
    ];
    const candidate = { ...record, schemaVersion: CURRENT_SCHEMA_VERSION };
    try {
      const contract = outcomeContractSchema.parse(candidate) as OutcomeContract;
      return { ok: true, contract, migrationPreview };
    } catch (error) {
      return {
        ok: false,
        reason: `cannot migrate ${schemaVersion}: ${describeError(error)}`,
        migrationPreview,
      };
    }
  }

  if (typeof schemaVersion !== "string") {
    return {
      ok: false,
      reason:
        "missing or invalid schemaVersion; a contract whose version cannot be " +
        "determined must not be executed (PRD OT-04)",
    };
  }

  return {
    ok: false,
    reason:
      `schemaVersion ${schemaVersion} is not compatible with ${CURRENT_SCHEMA_VERSION}; ` +
      "a cross-major migration cannot be performed reliably, so execution is forbidden (PRD OT-04)",
  };
}

export function checkCompatibility(value: unknown): {
  readonly compatible: boolean;
  readonly notes: readonly string[];
} {
  const record = asRecord(value);
  if (record === undefined) {
    return { compatible: false, notes: ["value is not a JSON object"] };
  }

  const notes: string[] = [];
  const schemaVersion = record["schemaVersion"];
  if (typeof schemaVersion === "string") {
    notes.push(`schemaVersion: ${schemaVersion}`);
  } else {
    notes.push("schemaVersion: missing or not a string");
  }

  const conditions = record["completionConditions"];
  notes.push(
    `completion conditions: ${Array.isArray(conditions) ? String(conditions.length) : "absent"}`,
  );

  const unknown = Object.keys(record).filter((key) => !KNOWN_TOP_LEVEL_FIELDS.has(key));
  notes.push(
    unknown.length === 0
      ? "no unknown top-level fields"
      : `unknown top-level fields: ${unknown.sort().join(", ")}`,
  );

  const compatible =
    typeof schemaVersion === "string" && schemaVersion.startsWith(`${SCHEMA_ID}${SUPPORTED_MAJOR}`);

  return { compatible, notes };
}
