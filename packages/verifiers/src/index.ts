/**
 * Built-in verifier registry and verification planning.
 *
 * Planning is where "we cannot honestly verify this" becomes visible before
 * anything runs. A condition whose verifier is missing, or whose required
 * evidence level the verifier cannot reach, is never quietly assigned to a
 * weaker check — it is reported as unsupported so the kernel can ask for a
 * real one (PRD VF-02, VF-03).
 */

import { levelSatisfies } from "@keystone/schemas";
import type { CompletionCondition, OutcomeContract, VerifierKind } from "@keystone/schemas";

import { buildVerifier } from "./build.ts";
import { lintVerifier } from "./lint.ts";
import { projectRuleVerifier } from "./rules.ts";
import { diffScopeVerifier } from "./scope.ts";
import { testVerifier } from "./test.ts";
import { typecheckVerifier } from "./typecheck.ts";
import type { Verifier, VerifierDescriptor } from "./types.ts";

export * from "./types.ts";
// The captured-run machinery is the reusable half of "run something in a child
// process honestly": no shell, scrubbed env, output capped into an artifact.
// Extensions reuse it so an extension verifier and a built-in one cannot drift.
export * from "./run.ts";

export const VERIFIER_IDS = [
  "verifier.test",
  "verifier.typecheck",
  "verifier.lint",
  "verifier.build",
  "verifier.diff_scope",
  "verifier.project_rule",
] as const;

const BUILTIN_VERIFIERS: readonly Verifier[] = [
  testVerifier,
  typecheckVerifier,
  lintVerifier,
  buildVerifier,
  diffScopeVerifier,
  projectRuleVerifier,
];

export function builtinVerifiers(): readonly Verifier[] {
  return BUILTIN_VERIFIERS;
}

export function getVerifier(id: string): Verifier | undefined {
  return BUILTIN_VERIFIERS.find((verifier) => verifier.descriptor.id === id);
}

export function verifierForKind(kind: VerifierKind): Verifier | undefined {
  return BUILTIN_VERIFIERS.find((verifier) => verifier.descriptor.kind === kind);
}

export function verifierDescriptors(): readonly VerifierDescriptor[] {
  return BUILTIN_VERIFIERS.map((verifier) => verifier.descriptor);
}

export interface PlannedVerification {
  readonly verifier: Verifier;
  readonly conditions: readonly CompletionCondition[];
}

export interface UnsupportedCondition {
  readonly condition: CompletionCondition;
  readonly reason: string;
}

export interface VerificationPlan {
  readonly planned: readonly PlannedVerification[];
  readonly unsupported: readonly UnsupportedCondition[];
}

/**
 * Assign conditions to verifiers.
 *
 * Ordering is stable: verifiers appear in the order their first condition
 * appears in the contract, and each verifier keeps its conditions in contract
 * order, so a plan is reproducible run to run (PRD VF-03).
 *
 * Resolution order for a condition is deliberate and is where extensions are
 * supported without touching the kernel:
 *
 *  1. **Explicit id first.** If a verifier in the injected pool (or a built-in)
 *     owns `condition.verifier.id`, that verifier runs. An injected verifier may
 *     therefore stand in for, or shadow, a built-in by id.
 *  2. **Built-in kind fallback.** Only when no verifier owns the id do we fall
 *     back to the historical kind lookup, so the engineering contract — which
 *     names `verifier.test`/`kind: "test"` — is unchanged.
 *
 * A condition that cannot be honestly served is reported as `unsupported`,
 * never silently handed to a weaker verifier (PRD VF-02):
 *  - a required condition needs a verifier that can stand alone;
 *  - the verifier's evidence level must reach the condition's minimum (a
 *    condition demanding E3 is not satisfied by quietly running E2);
 *  - a condition that requires independence cannot be served by a verifier that
 *    shares the Builder Loop's process.
 */
export function planVerification(
  contract: OutcomeContract,
  options: {
    affectedConditionIds?: readonly string[];
    /** Verifiers injected by the composition root (extensions, packs). They shadow built-ins by id. */
    verifiers?: readonly Verifier[];
  } = {},
): VerificationPlan {
  const affected =
    options.affectedConditionIds === undefined
      ? undefined
      : new Set(options.affectedConditionIds);

  const selected = contract.completionConditions.filter(
    (condition) => affected === undefined || affected.has(condition.conditionId),
  );

  // Injected verifiers come first so they shadow a built-in on an id collision.
  const byId = new Map<string, Verifier>();
  for (const verifier of [...(options.verifiers ?? []), ...BUILTIN_VERIFIERS]) {
    if (!byId.has(verifier.descriptor.id)) byId.set(verifier.descriptor.id, verifier);
  }

  const grouped = new Map<Verifier, CompletionCondition[]>();
  const unsupported: UnsupportedCondition[] = [];

  const resolve = (condition: CompletionCondition): Verifier | undefined =>
    byId.get(condition.verifier.id) ?? verifierForKind(condition.verifier.kind);

  for (const condition of selected) {
    const verifier = resolve(condition);
    if (verifier === undefined) {
      unsupported.push({
        condition,
        reason:
          `no verifier owns id "${condition.verifier.id}" and no built-in handles kind ` +
          `"${condition.verifier.kind}"`,
      });
      continue;
    }

    // A required condition must not be downgraded to a verifier that cannot
    // stand alone for completion; that would be a silent weakening of "done".
    if (condition.required && !verifier.descriptor.canSatisfyRequiredCondition) {
      unsupported.push({
        condition,
        reason:
          `condition ${condition.conditionId} is required but ${verifier.descriptor.id} ` +
          `can only produce ${verifier.descriptor.evidenceLevel} evidence`,
      });
      continue;
    }

    // The verifier's evidence must actually reach the level the condition asks
    // for. Running a weaker check and letting the proof later report
    // `insufficient_level` would spend a repair cycle to learn what planning knew.
    const wantsLevel = condition.minEvidenceLevel === "E0" ? "E1" : condition.minEvidenceLevel;
    if (!levelSatisfies(verifier.descriptor.evidenceLevel, wantsLevel)) {
      unsupported.push({
        condition,
        reason:
          `condition ${condition.conditionId} requires ${wantsLevel} evidence but ` +
          `${verifier.descriptor.id} only produces ${verifier.descriptor.evidenceLevel}; ` +
          "refusing to silently downgrade",
      });
      continue;
    }

    // A condition that demands independence cannot be served by a verifier that
    // shares the Builder Loop's process — the proof gate would reject it anyway,
    // so surface it here rather than after running it.
    if (
      condition.requiresIndependence &&
      verifier.descriptor.independence.mode === "same_process"
    ) {
      unsupported.push({
        condition,
        reason:
          `condition ${condition.conditionId} requires independence but ` +
          `${verifier.descriptor.id} runs in the same process`,
      });
      continue;
    }

    const bucket = grouped.get(verifier);
    if (bucket === undefined) grouped.set(verifier, [condition]);
    else bucket.push(condition);
  }

  const planned: PlannedVerification[] = [...grouped.entries()].map(
    ([verifier, conditions]) => ({ verifier, conditions }),
  );
  return { planned, unsupported };
}
