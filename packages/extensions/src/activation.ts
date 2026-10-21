/**
 * Activation gating and capability ceilings.
 *
 * Three invariants live here:
 *
 *  - An extension is activated only with a passing conformance run, a verified
 *    digest, and — when it can reach outside the machine — an explicit user
 *    decision (PRD PL-02, 11.7).
 *  - An extension's capability ceiling is the *intersection* of what it declared
 *    and what the user's envelope already allows. It can never widen either
 *    (PRD HI-04, 9.7).
 *  - A crash, a timeout, a manifest violation or an integrity failure has a
 *    named isolation trigger, so the kernel can record *why* an extension was
 *    cut off rather than just that it was.
 */

import type {
  Capability,
  ConformanceReport,
  ExtensionManifest,
  UserDecision,
} from "@keystone/schemas";

export interface ActivationGateInput {
  readonly manifest: ExtensionManifest;
  readonly conformance?: ConformanceReport;
  readonly integrityVerified: boolean;
  /** A live user decision approving installation, when one exists. */
  readonly decision?: UserDecision;
}

export interface ActivationGateResult {
  readonly allowed: boolean;
  readonly requiresConfirmation: boolean;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}

/** True when the extension can move data or change anything outside the repo. */
export function reachesOutside(manifest: ExtensionManifest): boolean {
  return (
    manifest.capabilities.includes("net.fetch") ||
    manifest.capabilities.includes("external.write") ||
    manifest.capabilities.includes("credential.use") ||
    manifest.egressHosts.length > 0
  );
}

export function canActivate(input: ActivationGateInput): ActivationGateResult {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!input.integrityVerified) {
    blockers.push(
      "the package digest does not match the manifest; activate only after the source is verified",
    );
  }
  if (input.conformance === undefined) {
    blockers.push("no conformance run has been recorded for this extension");
  } else if (!input.conformance.passed) {
    for (const entry of input.conformance.checks.filter((check) => check.blocking && !check.passed)) {
      blockers.push(`${entry.checkId}: ${entry.detail}`);
    }
  }

  const needsConfirmation = reachesOutside(input.manifest) ||
    input.manifest.capabilities.includes("cmd.exec") || input.manifest.reversibility === "irreversible";
  const decision = input.decision;
  const decisionIsLive =
    decision !== undefined &&
    decision.recordedBy === "user" && decision.decision === "allow" &&
    (decision.appliesTo.expiresAt === undefined ||
      Date.parse(decision.appliesTo.expiresAt) > Date.now());

  if (needsConfirmation && !decisionIsLive) {
    // Not a blocker in the sense of "defective", but activation cannot proceed
    // without it — the distinction matters for how the UI words the request.
    blockers.push(
      "this extension can reach outside the machine, so it needs an explicit user decision before activation",
    );
  }

  if (input.manifest.reversibility === "irreversible" && !decisionIsLive) {
    blockers.push(
      "an extension that declares irreversible effects cannot be activated automatically",
    );
  }

  if (input.manifest.uninstall === "unsupported") {
    notes.push("this extension declares that it cannot be uninstalled");
  }
  if (input.manifest.conflicts.length > 0) {
    notes.push(`declared conflicts: ${input.manifest.conflicts.join(", ")}`);
  }
  if (input.manifest.execution.replayable === false) {
    notes.push("this extension is not replayable, so its evidence cannot be re-derived");
  }

  return {
    allowed: blockers.length === 0,
    requiresConfirmation: needsConfirmation,
    blockers,
    notes,
  };
}

/**
 * The capabilities an extension may actually receive: what it declared,
 * intersected with what the environment allows. Order follows the manifest so
 * the result is stable.
 */
export function capabilityCeiling(
  manifest: ExtensionManifest,
  environmentAllows: readonly Capability[],
): readonly Capability[] {
  const allowed = new Set(environmentAllows);
  return manifest.capabilities.filter((capability) => allowed.has(capability));
}

/**
 * Clamp a runtime request to the ceiling. A request for more than the ceiling is
 * never silently trimmed to "close enough": the excess is returned so the caller
 * can report it.
 */
export function clampRequestedCapabilities(
  requested: readonly Capability[],
  ceiling: readonly Capability[],
): { readonly granted: readonly Capability[]; readonly refused: readonly Capability[] } {
  const allowed = new Set(ceiling);
  const granted: Capability[] = [];
  const refused: Capability[] = [];
  for (const capability of requested) {
    if (allowed.has(capability)) granted.push(capability);
    else refused.push(capability);
  }
  return { granted, refused };
}

export const ISOLATION_TRIGGERS = [
  "crash",
  "timeout",
  "manifest_violation",
  "incompatible_event",
  "integrity_failure",
  "user_disabled",
] as const;
export type IsolationTrigger = (typeof ISOLATION_TRIGGERS)[number];

export class ExtensionManifestViolationError extends Error {
  readonly extensionName: string;
  constructor(extensionName: string, message: string) {
    super(`${extensionName} violated its manifest: ${message}`);
    this.name = "ExtensionManifestViolationError";
    this.extensionName = extensionName;
  }
}

export class ExtensionTimeoutError extends Error {
  readonly extensionName: string;
  constructor(extensionName: string, timeoutMs: number) {
    super(`${extensionName} did not respond within ${timeoutMs}ms`);
    this.name = "ExtensionTimeoutError";
    this.extensionName = extensionName;
  }
}

export function isolationTriggerFor(error: unknown): IsolationTrigger {
  if (error instanceof ExtensionManifestViolationError) return "manifest_violation";
  if (error instanceof ExtensionTimeoutError) return "timeout";
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ExtensionIntegrityError"
  ) {
    return "integrity_failure";
  }
  return "crash";
}

/**
 * What can still be done after an extension is isolated. When no safe capability
 * remains, the caller must move the task to "needs attention" rather than
 * degrading silently (PRD EX-05).
 */
export function degradationAfterIsolation(options: {
  readonly remainingCapabilities: readonly Capability[];
  readonly taskNeeds: readonly Capability[];
}): { readonly mode: "standard" | "minimal" | "needs_attention"; readonly lost: readonly Capability[] } {
  const remaining = new Set(options.remainingCapabilities);
  const lost = options.taskNeeds.filter((capability) => !remaining.has(capability));
  if (lost.length === 0) return { mode: "standard", lost };
  const canStillVerify = lost.every(
    (capability) => capability === "model.invoke" || capability === "net.fetch",
  );
  return { mode: canStillVerify ? "minimal" : "needs_attention", lost };
}
