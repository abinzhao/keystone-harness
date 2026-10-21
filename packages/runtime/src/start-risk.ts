/**
 * Risk-graded startup decision (ADR-0013).
 *
 * This is the runtime's single, deterministic answer to: *may a write task
 * start without an extra confirmation click?* It is deliberately a pure
 * function of the compiled Outcome Contract, the Autonomy Envelope that would
 * be used, the compiler's open questions, the dirty worktree paths that overlap
 * the write scope, and the effective start policy. It:
 *
 *  - reads no model, no network and no clock;
 *  - is re-derived server-side at start time, so a client's `startMode` is a
 *    request, never a grant (AGENTS.md §2 inv. 1, 5);
 *  - only ever narrows — it can refuse or demand confirmation, never widen the
 *    envelope or self-approve.
 *
 * The graded result is structured so a reviewer can audit exactly which inputs
 * drove it: the open-question count, the unresolved scope, the envelope's
 * relevant edges, the overlapping dirty paths, and the policy in force.
 */

import { globToRegExp } from "@keystone/kernel";
import type { AutonomyEnvelope, OutcomeContract } from "@keystone/schemas";

/** A compiler question, narrowed to what the grader needs. */
export interface GradedQuestion {
  readonly questionId: string;
  readonly affects: "implementation" | "scope" | "verification";
}

/**
 * The effective start policy, already resolved from the user toggle and any
 * project policy file. Tightening is a union: either source demanding
 * confirmation forces it, and nothing here can widen an auto-start.
 */
export interface StartPolicy {
  /** User preference: confirm every write task, however low-risk. */
  readonly confirmAllWrites: boolean;
  /** Project policy (`.keystone/policy.json`): confirm every write here. */
  readonly projectConfirmAllWrites: boolean;
  /**
   * Whether a clean, low-risk write may auto-start after the preview at all.
   * Default true; a project policy may set it false to force confirmation.
   */
  readonly allowAutoStartForLowRisk: boolean;
}

export const DEFAULT_START_POLICY: StartPolicy = {
  confirmAllWrites: false,
  projectConfirmAllWrites: false,
  allowAutoStartForLowRisk: true,
};

/** Why a task needs a human before its side effects begin. */
export type ConfirmationReason =
  | "ambiguity"
  | "scope_expansion"
  | "irreversible"
  | "external_action"
  | "high_risk"
  | "policy_required";

/** A refusal reason (only `dirty_overlap` today; kept as its own tag). */
export type RefusalReason = "dirty_overlap";

export type StartDecision = "auto_start" | "require_confirmation" | "refuse";

/** The auditable result of grading a submission. */
export interface StartRiskResult {
  readonly decision: StartDecision;
  readonly reasons: readonly (ConfirmationReason | RefusalReason)[];
  /** Dirty worktree paths the task would write into (empty unless refused). */
  readonly dirtyOverlap: readonly string[];
  /** Human-readable recovery guidance, set when decision is `refuse`. */
  readonly recovery: string | undefined;
  /** The exact inputs the grade was derived from, for audit. */
  readonly audited: {
    readonly openQuestionCount: number;
    readonly scopeUnknown: readonly string[];
    readonly contractStatus: OutcomeContract["status"];
    readonly maxReversibility: AutonomyEnvelope["maxReversibility"];
    readonly externalSystems: AutonomyEnvelope["externalSystems"];
    readonly allowedHosts: readonly string[];
    readonly writePatterns: readonly string[];
    readonly policy: StartPolicy;
  };
}

/**
 * Command tokens that imply a non-reversible, blast-radius action. Matched as
 * a substring of the joined command line, so `git push --force` and
 * `rm -rf` both trip it. Routine build wrappers (`node`, `pnpm test`) do not.
 */
const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\b[^\n;]*-[a-z]*r/, // rm -r / -rf
  /\bgit\s+push\b[^\n;]*(--force\b|-f\b)/,
  /\bgit\s+reset\b[^\n;]*--hard\b/,
  /\bgit\s+clean\b[^\n;]*-[a-z]*f/,
  /\bgit\s+checkout\b[^\n;]*--\b/, // checkout -- <path> discards edits
  /\b(npm|pnpm|yarn)\s+unpublish\b/,
  /\bdrop\s+(table|database|schema)\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
];

/** Write patterns that mean "the whole repository" — an unbounded blast radius. */
const ROOT_SCOPE_PATTERNS: readonly string[] = ["**", "**/*", ".", "./", "/", "*"];

export interface GradeStartRiskInput {
  readonly contract: OutcomeContract;
  readonly envelope: AutonomyEnvelope;
  readonly questions: readonly GradedQuestion[];
  /** Write paths the user actually named (empty = read-only; handled by caller). */
  readonly userWritePaths: readonly string[];
  /** Dirty worktree paths that overlap the write scope (pre-computed). */
  readonly dirtyOverlap: readonly string[];
  readonly policy: StartPolicy;
}

export function gradeStartRisk(input: GradeStartRiskInput): StartRiskResult {
  const writePatterns = input.contract.scope.include
    .filter((entry) => entry.intent === "write")
    .map((entry) => entry.pattern);

  const audited = {
    openQuestionCount: input.questions.length,
    scopeUnknown: input.contract.scope.unknown,
    contractStatus: input.contract.status,
    maxReversibility: input.envelope.maxReversibility,
    externalSystems: input.envelope.externalSystems,
    allowedHosts: [...input.envelope.allowedHosts],
    writePatterns,
    policy: input.policy,
  };

  // Refusal outranks every confirmation reason: a task that would clobber
  // uncommitted user work is not made safe by confirming it.
  if (input.dirtyOverlap.length > 0) {
    return {
      decision: "refuse",
      reasons: ["dirty_overlap"],
      dirtyOverlap: input.dirtyOverlap,
      recovery:
        "This task would write to files you already have uncommitted changes in: " +
        input.dirtyOverlap.slice(0, 8).join(", ") +
        (input.dirtyOverlap.length > 8 ? ` (+${input.dirtyOverlap.length - 8} more)` : "") +
        ". Keystone will not start against this working copy, or it would mix your " +
        "in-progress work with this task. Commit or stash those changes first, or " +
        "start this task in isolated mode (a throwaway worktree that leaves yours " +
        "untouched).",
      audited,
    };
  }

  const reasons = new Set<ConfirmationReason>();

  // Ambiguity: open questions, an approval-blocked contract, or unresolved
  // uncertainties. The system could not pin down what "done" means.
  if (
    input.questions.length > 0 ||
    input.contract.status === "awaiting_approval" ||
    input.contract.uncertainties.some((entry) => entry.resolution === "open")
  ) {
    reasons.add("ambiguity");
  }

  // Scope expansion: unresolved scope, or the compiler inferred a write scope
  // beyond the paths the user named.
  if (input.contract.scope.unknown.length > 0 || scopeWiderThanUserPaths(input)) {
    reasons.add("scope_expansion");
  }

  // Irreversible: the envelope has been widened to permit non-reversible
  // actions. The default envelope stays `reversible`, which still gates such
  // actions in-flight.
  if (input.envelope.maxReversibility === "compensable") {
    reasons.add("irreversible");
  }

  // External action: side effects can leave the machine.
  if (
    input.envelope.externalSystems !== "none" ||
    input.envelope.allowedHosts.length > 0 ||
    input.envelope.untrustedContentEgress === "allowlisted_only"
  ) {
    reasons.add("external_action");
  }

  // High risk: destructive commands, or an unbounded root write scope.
  if (matchesDestructiveCommand(input.envelope.allowedCommands) || rootWriteScope(writePatterns)) {
    reasons.add("high_risk");
  }

  // Policy: a user or project toggle demanding confirmation for writes.
  if (input.policy.confirmAllWrites || input.policy.projectConfirmAllWrites) {
    reasons.add("policy_required");
  }

  if (reasons.size > 0) {
    return {
      decision: "require_confirmation",
      reasons: [...reasons],
      dirtyOverlap: [],
      recovery: undefined,
      audited,
    };
  }

  // No safety reason: the only thing that can still block auto-start is a
  // project policy that does not permit it.
  if (!input.policy.allowAutoStartForLowRisk) {
    return {
      decision: "require_confirmation",
      reasons: ["policy_required"],
      dirtyOverlap: [],
      recovery: undefined,
      audited,
    };
  }

  return {
    decision: "auto_start",
    reasons: [],
    dirtyOverlap: [],
    recovery: undefined,
    audited,
  };
}

/**
 * The compiler inferred a write scope the user never named. In the workbench
 * flow references are derived from the user's write paths, so the two match;
 * this fires for the CLI/proposer path where the pack fills in directories.
 */
function scopeWiderThanUserPaths(input: GradeStartRiskInput): boolean {
  const named = input.userWritePaths.map(normalisePattern).filter((p) => p !== "");
  if (named.length === 0) return false;
  const writePatterns = input.contract.scope.include
    .filter((entry) => entry.intent === "write")
    .map((entry) => normalisePattern(entry.pattern));
  return writePatterns.some(
    (pattern) => !named.some((name) => pattern === name || pattern.startsWith(`${name}/`)),
  );
}

function matchesDestructiveCommand(commands: readonly string[]): boolean {
  const joined = commands.join(" ; ");
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(joined));
}

function rootWriteScope(writePatterns: readonly string[]): boolean {
  return writePatterns.some((pattern) => ROOT_SCOPE_PATTERNS.includes(normalisePattern(pattern)));
}

function normalisePattern(pattern: string): string {
  return pattern
    .replace(/^\.\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\/+$/, "");
}

/**
 * Which of the given dirty worktree paths overlap a set of write patterns.
 *
 * Shared with the admission probe so the preview and the start path agree on
 * what "overlaps" means: an exact/prefix match for plain paths and directories,
 * and a regex match for globs (the same matcher the context planner uses).
 */
export function findDirtyOverlap(
  dirtyPaths: readonly string[],
  writePatterns: readonly string[],
): readonly string[] {
  if (dirtyPaths.length === 0 || writePatterns.length === 0) return [];
  const exactOrPrefix = writePatterns
    .filter((pattern) => !pattern.includes("*"))
    .map(normalisePattern)
    .filter((pattern) => pattern !== "");
  const globs = writePatterns.filter((pattern) => pattern.includes("*")).map(globToRegExp);

  return dirtyPaths.filter((dirty) => {
    const normalised = normalisePattern(dirty);
    if (exactOrPrefix.some((pattern) => normalised === pattern || normalised.startsWith(`${pattern}/`))) {
      return true;
    }
    return globs.some((matcher) => matcher.test(dirty));
  });
}
