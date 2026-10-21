/**
 * Capability leases.
 *
 * Every side effect requires a lease. A lease binds *who* may do *what* to
 * *which* resources, under which parameters, for how long, and — when the
 * action exceeds the Autonomy Envelope — to the user decision that authorised
 * it (PRD 5.2, 8.4, 9.5, 11.3).
 *
 * The kernel is the only issuer (`issuedBy` is a literal). Models, tools,
 * extensions and sub-agents receive leases; they cannot mint them.
 */

import {
  branchIdValidator,
  decisionIdValidator,
  leaseIdValidator,
  taskIdValidator,
  isoTimestampValidator,
  localIdValidator,
} from "./ids.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  jsonValue,
  lit,
  nonEmptyStr,
  num,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

/**
 * Capability vocabulary. Kept coarse on purpose: fine-grained permissions are
 * expressed through the lease's `resources` and `constraints`, not by inventing
 * new capability names, so policy stays auditable.
 */
export const CAPABILITIES = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "cmd.exec",
  "net.fetch",
  "git.read",
  "git.write",
  "credential.use",
  "model.invoke",
  "external.write",
  "extension.activate",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Read-only capabilities cannot change the workspace or the outside world. */
export const READ_ONLY_CAPABILITIES: readonly Capability[] = [
  "fs.read",
  "git.read",
  "net.fetch",
  "model.invoke",
];

export function isReadOnlyCapability(capability: Capability): boolean {
  return READ_ONLY_CAPABILITIES.includes(capability);
}

/**
 * Who is acting. Sub-agents and extensions are separate subjects so that a
 * compromised extension cannot inherit the parent task's reach (PRD HI-04).
 */
export const LEASE_SUBJECT_KINDS = [
  "builder_loop",
  "sub_agent",
  "verifier",
  "orchestrator",
  "extension",
] as const;
export type LeaseSubjectKind = (typeof LEASE_SUBJECT_KINDS)[number];

export const resourceScopeSchema = defineSchema(
  "keystone.capability.resourceScope",
  "1.0.0",
  objectOf({
    kind: enumOf(["paths", "command", "host", "credential", "external_system"] as const),
    /**
     * Resource selectors. Paths are repository-relative; commands are exact
     * argv[0] names; hosts are exact DNS names (no wildcards — a wildcard host
     * would silently widen network reach).
     */
    values: arrayOf(nonEmptyStr(), { minItems: 1, maxItems: 64 }),
    mode: optional(enumOf(["read", "write", "execute"] as const)),
  }),
);

export const leaseConstraintsSchema = defineSchema(
  "keystone.capability.constraints",
  "1.1.0",
  objectOf({
    workingDirectory: optional(str()),
    timeoutMs: optional(int({ min: 1, max: 3_600_000 })),
    maxOutputBytes: optional(int({ min: 1 })),
    /** Required argv prefix, e.g. ["pnpm","test"] for a scoped test lease. */
    argvPrefix: optional(arrayOf(str(), { maxItems: 16 })),
    /** Additive in 1.1: exact canonical parameters bound by the issuer. */
    parametersHash: optional(str({ pattern: /^[0-9a-f]{64}$/ })),
    /** For `net.fetch`: allowed HTTP methods. */
    methods: optional(arrayOf(enumOf(["GET", "HEAD"] as const), { maxItems: 2 })),
    /** For `fs.write`: refuse to follow symlinks out of the workspace. */
    denySymlinkEscape: optional(bool()),
    extra: optional(jsonValue()),
  }),
);

export const leaseBudgetSchema = defineSchema(
  "keystone.capability.budget",
  "1.0.0",
  objectOf({
    maxCalls: int({ min: 1 }),
    maxBytes: optional(int({ min: 0 })),
    maxCostUsd: optional(num({ min: 0 })),
    maxWallClockMs: optional(int({ min: 1 })),
  }),
);

export const LEASE_STATUSES = ["active", "consumed", "expired", "revoked"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

export const capabilityLeaseSchema = defineSchema(
  "keystone.capability.lease",
  "1.1.0",
  objectOf({
    leaseId: leaseIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    subject: objectOf({
      kind: enumOf(LEASE_SUBJECT_KINDS),
      id: nonEmptyStr(),
    }),
    capability: enumOf(CAPABILITIES),
    resource: resourceScopeSchema.validator,
    constraints: leaseConstraintsSchema.validator,
    budget: leaseBudgetSchema.validator,
    /** Digest over subject+capability+resource+constraints+expiry. */
    scopeDigest: str({ pattern: /^[0-9a-f]{64}$/ }),
    issuedAt: isoTimestampValidator,
    expiresAt: isoTimestampValidator,
    /** The kernel is the only issuer; this literal is enforced on read. */
    issuedBy: lit("kernel"),
    /**
     * Present when the lease exceeds the project's Autonomy Envelope. The
     * referenced decision binds this specific capability, resource and window —
     * approving one task never approves another (PRD HI-03).
     */
    decisionRef: optional(decisionIdValidator),
    status: enumOf(LEASE_STATUSES),
    consumedCalls: int({ min: 0 }),
    /** Action proposal that consumed the most recent call; supports audit. */
    lastProposalRef: optional(localIdValidator),
    revokedReason: optional(str({ maxLength: 256 })),
  }),
);

export type CapabilityLease = InferSchema<typeof capabilityLeaseSchema>;
