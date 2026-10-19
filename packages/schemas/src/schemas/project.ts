/**
 * Project World Model: project profile, workspace snapshots, and facts.
 *
 * Three timing questions must stay separable (PRD PI-04): when a fact *holds in
 * the project*, when Keystone *observed* it, and which *snapshot* it applies to.
 * Collapsing them is how "the model remembered something that used to be true"
 * bugs are born.
 */

import {
  decisionIdValidator,
  factIdValidator,
  projectIdValidator,
  snapshotIdValidator,
  isoTimestampValidator,
  sha256Validator,
} from "./ids.ts";
import { provenanceRefSchema } from "./provenance.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

/**
 * Whether the project is inside the supported matrix. An unsupported project
 * must say so rather than silently producing weak cognition (PRD PI-01).
 */
export const SUPPORT_STATUSES = ["supported", "partially_supported", "unsupported"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** A command Keystone believes runs build/test/typecheck/lint/run. */
export const projectCommandSchema = defineSchema(
  "keystone.project.command",
  "1.0.0",
  objectOf({
    kind: enumOf(["build", "test", "typecheck", "lint", "run"] as const),
    /** Absent means "could not identify" — never guess a command (PI-01 §4). */
    command: optional(str({ maxLength: 512 })),
    status: enumOf(["identified", "unrecognized"] as const),
    /** Where the command was found, e.g. `package.json#scripts.test`. */
    source: optional(str({ maxLength: 256 })),
  }),
);

export const projectProfileSchema = defineSchema(
  "keystone.project.profile",
  "1.0.0",
  objectOf({
    projectId: projectIdValidator,
    /** Absolute path to the Git work tree root. */
    rootPath: nonEmptyStr(),
    name: nonEmptyStr(),
    vcs: enumOf(["git"] as const),
    languages: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    packageManager: optional(nonEmptyStr()),
    support: objectOf({
      status: enumOf(SUPPORT_STATUSES),
      reasons: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    }),
    commands: arrayOf(projectCommandSchema.validator, { maxItems: 32 }),
    /** Files recognised as agent instruction sources, e.g. `AGENTS.md`. */
    instructionFiles: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    createdAt: isoTimestampValidator,
    updatedAt: isoTimestampValidator,
  }),
);

export type ProjectProfile = InferSchema<typeof projectProfileSchema>;

/**
 * One tracked file in a snapshot. Only metadata and a digest are stored —
 * Keystone never copies user source into its own store (ADR-0005).
 */
export const snapshotEntrySchema = defineSchema(
  "keystone.project.snapshotEntry",
  "1.0.0",
  objectOf({
    path: nonEmptyStr(),
    size: int({ min: 0 }),
    sha256: sha256Validator,
    /** Octal git mode, e.g. `100644`, `100755`, `120000` for symlinks. */
    mode: str({ pattern: /^(100644|100755|120000|160000)$/ }),
    /** Porcelain status: `""` (clean), `M`, `A`, `D`, `?`, `R`. */
    gitStatus: str({ maxLength: 8 }),
  }),
);

/**
 * Workspace state used for recovery checks and evidence invalidation.
 *
 * `fingerprint` covers the *full* scan even when `entries` was truncated for
 * storage, so a cheap equality check stays available on large repositories.
 */
export const workspaceSnapshotSchema = defineSchema(
  "keystone.project.workspaceSnapshot",
  "1.0.0",
  objectOf({
    snapshotId: snapshotIdValidator,
    projectId: projectIdValidator,
    at: isoTimestampValidator,
    headCommit: optional(nonEmptyStr()),
    branch: optional(nonEmptyStr()),
    /** True when the work tree differs from HEAD in any way. */
    dirty: bool(),
    untrackedCount: int({ min: 0 }),
    entries: arrayOf(snapshotEntrySchema.validator, { maxItems: 100_000 }),
    entriesTruncated: bool(),
    entryCount: int({ min: 0 }),
    totalBytes: int({ min: 0 }),
    /** Paths deliberately excluded from scanning (`.git`, build output, ...). */
    excluded: arrayOf(nonEmptyStr(), { maxItems: 128 }),
    fingerprint: sha256Validator,
  }),
);

export type WorkspaceSnapshot = InferSchema<typeof workspaceSnapshotSchema>;
export type SnapshotEntry = InferSchema<typeof snapshotEntrySchema>;

export const FACT_KINDS = [
  "structure",
  "module",
  "entry_point",
  "symbol",
  "dependency",
  "test_mapping",
  "command",
  "rule",
  "exception",
  "language",
  "package_manager",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_STATUSES = ["active", "stale", "invalidated", "frozen"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/**
 * A single project fact.
 *
 * Conflict resolution order (PRD PI-02) is expressed by `source.trustLevel` plus
 * `frozen`: a user-confirmed frozen rule outranks anything a tool or index can
 * derive, and a low-trust source may never silently overwrite a higher one.
 */
export const projectFactSchema = defineSchema(
  "keystone.project.fact",
  "1.0.0",
  objectOf({
    factId: factIdValidator,
    projectId: projectIdValidator,
    kind: enumOf(FACT_KINDS),
    /** The claim itself, in developer-readable language. */
    statement: nonEmptyStr(),
    /** Where it came from. Trust lives here, not on the fact. */
    source: provenanceRefSchema.validator,
    /** Facts this one was derived from, for invalidation propagation. */
    derivedFrom: arrayOf(factIdValidator, { maxItems: 64 }),
    /** Snapshot the fact was observed against. */
    applicableSnapshot: optional(snapshotIdValidator),
    /**
     * When the fact has an inherent expiry (e.g. "tool X is version Y").
     * Absence means "valid until invalidated", not "valid forever".
     */
    freshUntil: optional(isoTimestampValidator),
    /** Machine-readable invalidation conditions, e.g. `deps.package-lock.changed`. */
    invalidatedBy: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    status: enumOf(FACT_STATUSES),
    /** Set when a user froze the fact; frozen facts resist automatic updates. */
    frozenBy: optional(decisionIdValidator),
    observedAt: isoTimestampValidator,
    updatedAt: isoTimestampValidator,
    /** Project-relative paths this fact is about — the inverse index key. */
    subjects: arrayOf(nonEmptyStr(), { maxItems: 64 }),
  }),
);

export type ProjectFact = InferSchema<typeof projectFactSchema>;

/**
 * Conflict precedence (PRD PI-02). Lower rank wins.
 *
 * Two facts at the same rank that disagree is a genuine conflict: it must be
 * surfaced as an intervention rather than resolved silently.
 */
export function factPrecedenceRank(sourceKind: string, frozen: boolean, trustLevel: string): number {
  if (frozen && trustLevel === "user_confirmed") return 0;
  switch (sourceKind) {
    case "user":
      return 0;
    case "tool":
    case "verifier":
      return 1;
    case "repository":
      return 2;
    case "experience":
      return 3;
    case "model":
      return 4;
    default:
      return 4;
  }
}
