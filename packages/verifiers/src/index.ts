/**
 * Built-in verifier registry and verification planning.
 *
 * Planning is where "we cannot honestly verify this" becomes visible before
 * anything runs. A condition whose verifier is missing, or whose required
 * evidence level the verifier cannot reach, is never quietly assigned to a
 * weaker check — it is reported as unsupported so the kernel can ask for a
 * real one (PRD VF-02, VF-03).
 */

import type { CompletionCondition, OutcomeContract, VerifierKind } from "@keystone/schemas";

import { buildVerifier } from "./build.ts";
import { lintVerifier } from "./lint.ts";
import { projectRuleVerifier } from "./rules.ts";
import { diffScopeVerifier } from "./scope.ts";
import { testVerifier } from "./test.ts";
import { typecheckVerifier } from "./typecheck.ts";
import type { Verifier, VerifierDescriptor } from "./types.ts";

export * from "./types.ts";

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
 */
export function planVerification(
  contract: OutcomeContract,
  options: { affectedConditionIds?: readonly string[] } = {},
): VerificationPlan {
  const affected =
    options.affectedConditionIds === undefined
      ? undefined
      : new Set(options.affectedConditionIds);

  const selected = contract.completionConditions.filter(
    (condition) => affected === undefined || affected.has(condition.conditionId),
  );

  const grouped = new Map<Verifier, CompletionCondition[]>();
  const unsupported: UnsupportedCondition[] = [];

  for (const condition of selected) {
    const verifier = verifierForKind(condition.verifier.kind);
    if (verifier === undefined) {
      unsupported.push({
        condition,
        reason: `no built-in verifier handles kind "${condition.verifier.kind}"`,
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

    const bucket = grouped.get(verifier);
    if (bucket === undefined) grouped.set(verifier, [condition]);
    else bucket.push(condition);
  }

  const planned: PlannedVerification[] = [...grouped.entries()].map(
    ([verifier, conditions]) => ({ verifier, conditions }),
  );
  return { planned, unsupported };
}
