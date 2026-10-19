/**
 * Capability leases.
 *
 * A lease is the kernel's answer to "may this subject do this, to this, now?".
 * Three rules shape the implementation:
 *
 *  - Scope and envelope are *both* checked. A capability inside the envelope but
 *    outside the contract's scope is still refused, and vice versa (PRD EX-03,
 *    HI-04).
 *  - A user decision never *bypasses* these checks. Confirming an action widens
 *    the Envelope (or revises the Contract) first; the lease is then issued
 *    inside the new boundary. Otherwise "allow once" would quietly become
 *    "allow always".
 *  - A refusal is actionable. Every denial names the reason and the option that
 *    would unblock it, so the user is never asked a question without context
 *    (PRD HI-01).
 */

import {
  capabilityLeaseSchema,
  newId,
  sha256Hex,
  contentHash,
  type AutonomyEnvelope,
  type Capability,
  type CapabilityLease,
  type DecisionId,
  type OutcomeContract,
  type UserDecision,
} from "@keystone/schemas";

import { decidePath, pathMatchesAny } from "../scope/scope.ts";

export type LeaseDenialCode =
  | "capability_outside_envelope"
  | "out_of_contract_scope"
  | "requires_confirmation"
  | "irreversible_requires_confirmation"
  | "untrusted_content_cannot_authorize"
  | "credential_not_permitted"
  | "network_host_not_permitted"
  | "command_not_permitted"
  | "external_system_not_permitted"
  | "lease_expired"
  | "lease_revoked"
  | "lease_exhausted"
  | "resource_not_in_lease"
  | "empty_resource_list";

export interface LeaseDenial {
  readonly code: LeaseDenialCode;
  readonly detail: string;
  /** What the user could allow to unblock this, if anything can. */
  readonly suggestedOption?: string;
}

export interface IssueLeaseInput {
  readonly taskId: string;
  readonly branchId: string;
  readonly subject: { kind: CapabilityLease["subject"]["kind"]; id: string };
  readonly capability: Capability;
  /** Repository-relative paths, a command name, a host, or a credential handle. */
  readonly resourceValues: readonly string[];
  readonly contract: OutcomeContract;
  readonly envelope: AutonomyEnvelope;
  readonly maxCalls?: number;
  readonly ttlMs?: number;
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly argvPrefix?: readonly string[];
  /**
   * Attribution only: which user decision put this action inside the boundary.
   * It is recorded for audit and shown in the proof package, and it does not
   * affect whether the lease is granted.
   */
  readonly decision?: UserDecision;
  /** True when the request was derived from content Keystone does not trust. */
  readonly derivedFromUntrusted?: boolean;
  readonly reversibility?: "reversible" | "compensable" | "irreversible";
}

export type LeaseIssueResult =
  | { readonly ok: true; readonly lease: CapabilityLease }
  | { readonly ok: false; readonly denial: LeaseDenial };

const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;

export function resourceKindFor(capability: Capability): CapabilityLease["resource"]["kind"] {
  switch (capability) {
    case "cmd.exec":
      return "command";
    case "net.fetch":
    case "model.invoke":
      return "host";
    case "credential.use":
      return "credential";
    case "external.write":
      return "external_system";
    default:
      return "paths";
  }
}

function modeFor(capability: Capability): "read" | "write" | "execute" | undefined {
  switch (capability) {
    case "fs.read":
    case "git.read":
      return "read";
    case "fs.write":
    case "fs.delete":
    case "git.write":
      return "write";
    case "cmd.exec":
      return "execute";
    default:
      return undefined;
  }
}

interface Reach {
  readonly allowed: boolean;
  readonly code: LeaseDenialCode;
  readonly detail: string;
  readonly suggestedOption?: string;
}

const ALLOWED: Reach = { allowed: true, code: "requires_confirmation", detail: "" };

export function issueLease(input: IssueLeaseInput): LeaseIssueResult {
  const { capability, contract, envelope } = input;
  const values = [...input.resourceValues];

  if (values.length === 0) {
    return {
      ok: false,
      denial: {
        code: "empty_resource_list",
        detail: "a lease must name at least one resource; an empty list would mean 'anything'",
      },
    };
  }

  if (input.reversibility === "irreversible") {
    return {
      ok: false,
      denial: {
        code: "irreversible_requires_confirmation",
        detail: "this action cannot be undone, so automatic approval never covers it",
        suggestedOption: "Confirm this specific action, naming the exact resource",
      },
    };
  }

  if (
    input.derivedFromUntrusted === true &&
    (capability === "external.write" || capability === "credential.use" || capability === "net.fetch")
  ) {
    return {
      ok: false,
      denial: {
        code: "untrusted_content_cannot_authorize",
        detail:
          "the request was derived from content Keystone does not trust, " +
          "and untrusted content cannot authorise data leaving the machine",
        suggestedOption: "Review the source and confirm the outbound action explicitly",
      },
    };
  }

  const envelopeReach = reachWithinEnvelope(capability, values, envelope);
  if (!envelopeReach.allowed) return { ok: false, denial: asDenial(envelopeReach) };

  const scopeReach = reachWithinContractScope(capability, values, contract);
  if (!scopeReach.allowed) return { ok: false, denial: asDenial(scopeReach) };

  const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const issuedAt = new Date();
  const mode = modeFor(capability);

  // Constructed through the schema: branded ids and the `issuedBy: "kernel"`
  // literal are enforced at the moment of issuance rather than trusted later.
  const lease = capabilityLeaseSchema.parse({
    leaseId: newId("lease"),
    taskId: input.taskId,
    branchId: input.branchId,
    subject: input.subject,
    capability,
    resource: {
      kind: resourceKindFor(capability),
      values,
      ...(mode === undefined ? {} : { mode }),
    },
    constraints: {
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.argvPrefix === undefined ? {} : { argvPrefix: [...input.argvPrefix] }),
      denySymlinkEscape: true,
    },
    budget: { maxCalls: input.maxCalls ?? 1 },
    scopeDigest: sha256Hex(
      contentHash({
        subject: input.subject,
        capability,
        values,
        contractId: contract.contractId,
        contractVersion: contract.version,
        envelopeUpdatedAt: envelope.updatedAt,
      }),
    ),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(),
    issuedBy: "kernel",
    ...(input.decision === undefined ? {} : { decisionRef: input.decision.decisionId as DecisionId }),
    status: "active",
    consumedCalls: 0,
  }) as CapabilityLease;

  return { ok: true, lease };
}

function asDenial(reach: Reach): LeaseDenial {
  return {
    code: reach.code,
    detail: reach.detail,
    ...(reach.suggestedOption === undefined ? {} : { suggestedOption: reach.suggestedOption }),
  };
}

function reachWithinEnvelope(
  capability: Capability,
  values: readonly string[],
  envelope: AutonomyEnvelope,
): Reach {
  switch (capability) {
    case "fs.read":
    case "git.read": {
      const outside = values.filter((path) => !pathMatchesAny(path, envelope.readPaths));
      return outside.length === 0
        ? ALLOWED
        : {
            allowed: false,
            code: "capability_outside_envelope",
            detail: `reading ${outside.join(", ")} is outside the project's read boundary`,
            suggestedOption: "Add these paths to the project's read paths",
          };
    }
    case "fs.write":
    case "fs.delete":
    case "git.write": {
      const outside = values.filter((path) => !pathMatchesAny(path, envelope.writePaths));
      return outside.length === 0
        ? ALLOWED
        : {
            allowed: false,
            code: "capability_outside_envelope",
            detail: `writing ${outside.join(", ")} is outside the project's write boundary`,
            suggestedOption: `Extend the project's write boundary to cover ${outside.join(", ")}`,
          };
    }
    case "cmd.exec": {
      const command = values[0] ?? "";
      return envelope.allowedCommands.includes(command)
        ? ALLOWED
        : {
            allowed: false,
            code: "command_not_permitted",
            detail: `"${command}" is not among the commands this project allows`,
            suggestedOption: `Allow "${command}" for this project`,
          };
    }
    case "net.fetch": {
      const host = values[0] ?? "";
      return envelope.allowedHosts.includes(host)
        ? ALLOWED
        : {
            allowed: false,
            code: "network_host_not_permitted",
            detail: `"${host}" is not an allowed network destination`,
            suggestedOption: `Allow "${host}" for this project`,
          };
    }
    case "model.invoke":
      // Model access is configured once by the user; the lease records which
      // endpoint was used rather than gating every call on a host allowlist.
      return ALLOWED;
    case "credential.use": {
      const handle = values[0] ?? "";
      return envelope.allowedCredentials.includes(handle)
        ? ALLOWED
        : {
            allowed: false,
            code: "credential_not_permitted",
            detail: `credential "${handle}" is not approved for this project`,
            suggestedOption: `Approve credential "${handle}"`,
          };
    }
    case "external.write":
      return envelope.externalSystems === "none"
        ? {
            allowed: false,
            code: "external_system_not_permitted",
            detail: "this project permits no writes to external systems",
            suggestedOption: "Allow a reversible external write for this project",
          }
        : ALLOWED;
    case "extension.activate":
      return ALLOWED;
  }
}

function reachWithinContractScope(
  capability: Capability,
  values: readonly string[],
  contract: OutcomeContract,
): Reach {
  const pathCapability =
    capability === "fs.read" ||
    capability === "fs.write" ||
    capability === "fs.delete" ||
    capability === "git.read" ||
    capability === "git.write";
  if (!pathCapability) return ALLOWED;

  const intent = capability === "fs.read" || capability === "git.read" ? "read" : "write";
  const outside: string[] = [];
  const reasons: string[] = [];
  for (const path of values) {
    const decision = decidePath(path, intent, contract.scope);
    if (!decision.allowed) {
      outside.push(path);
      reasons.push(decision.reason);
    }
  }
  return outside.length === 0
    ? ALLOWED
    : {
        allowed: false,
        code: "out_of_contract_scope",
        detail: reasons.join("; "),
        suggestedOption: `Extend the task scope to cover ${outside.join(", ")}`,
      };
}

export interface LeaseUseRequest {
  readonly capability: Capability;
  readonly resourceValues: readonly string[];
  readonly now?: Date;
}

export type LeaseUseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly denial: LeaseDenial };

export function validateLease(lease: CapabilityLease, request: LeaseUseRequest): LeaseUseResult {
  const now = request.now ?? new Date();

  if (lease.status === "revoked") {
    return {
      ok: false,
      denial: { code: "lease_revoked", detail: lease.revokedReason ?? "lease was revoked" },
    };
  }
  if (lease.status === "expired" || Date.parse(lease.expiresAt) <= now.getTime()) {
    return {
      ok: false,
      denial: {
        code: "lease_expired",
        detail:
          `lease expired at ${lease.expiresAt}; an expired grant cannot be reused ` +
          "for new actions (PRD 9.5)",
        suggestedOption: "Issue a fresh lease for this action",
      },
    };
  }
  if (lease.status === "consumed" || lease.consumedCalls >= lease.budget.maxCalls) {
    return {
      ok: false,
      denial: {
        code: "lease_exhausted",
        detail: `lease allowed ${lease.budget.maxCalls} call(s) and all were used`,
        suggestedOption: "Issue a fresh lease for this action",
      },
    };
  }
  if (lease.capability !== request.capability) {
    return {
      ok: false,
      denial: {
        code: "resource_not_in_lease",
        detail: `lease grants ${lease.capability}, not ${request.capability}`,
      },
    };
  }

  const outside = request.resourceValues.filter((value) => !resourceCovered(lease, value));
  if (outside.length > 0) {
    return {
      ok: false,
      denial: {
        code: "resource_not_in_lease",
        detail: `lease does not cover ${outside.join(", ")}`,
        suggestedOption: "Extend the task scope and issue a new lease",
      },
    };
  }

  return { ok: true };
}

function resourceCovered(lease: CapabilityLease, value: string): boolean {
  // Exact match by default: a prefix match would let `pnpm test` become
  // `pnpm test --filter=* && rm -rf`. A lease may still be written with an
  // explicit pattern, in which case the pattern is honoured as written.
  if (lease.resource.values.includes(value)) return true;
  const patterns = lease.resource.values.filter(
    (candidate) => candidate.includes("*") || candidate.includes("?"),
  );
  return patterns.length > 0 && pathMatchesAny(value, patterns);
}

/** Record one use. The lease transitions to `consumed` when its budget runs out. */
export function consumeLease(lease: CapabilityLease, proposalId?: string): CapabilityLease {
  const consumedCalls = lease.consumedCalls + 1;
  const exhausted = consumedCalls >= lease.budget.maxCalls;
  return {
    ...lease,
    consumedCalls,
    status: exhausted ? "consumed" : "active",
    ...(proposalId === undefined ? {} : { lastProposalRef: proposalId }),
  };
}

export function revokeLease(lease: CapabilityLease, reason: string): CapabilityLease {
  return { ...lease, status: "revoked", revokedReason: reason };
}

/**
 * A user stop must not wait for in-flight work, but must not allow new work:
 * every outstanding grant is revoked so no further side effect can be issued.
 */
export function revokeAll(
  leases: readonly CapabilityLease[],
  reason: string,
): readonly CapabilityLease[] {
  return leases.map((lease) => revokeLease(lease, reason));
}

export function describeLease(lease: CapabilityLease): string {
  const resources = lease.resource.values.join(", ");
  const decision = lease.decisionRef === undefined ? "" : ` (approved by ${lease.decisionRef})`;
  return `${lease.capability} on ${resources} until ${lease.expiresAt}${decision}`;
}

export function leaseMillisRemaining(lease: CapabilityLease, now = new Date()): number {
  return Math.max(0, Date.parse(lease.expiresAt) - now.getTime());
}
