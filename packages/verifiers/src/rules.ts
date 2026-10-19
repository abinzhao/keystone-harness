/**
 * Project-rule verifier (PRD PI-05, VF-01).
 *
 * A small set of structural rules that must hold regardless of what the code
 * does. Two are checked directly against the changed paths; the third is a
 * completeness note — an invariant whose backing condition is not part of this
 * run cannot be considered checked, and that gap is surfaced as `incomplete`
 * rather than silently ignored.
 *
 * This is a deterministic check over names, so it is E1 evidence and may only
 * serve auxiliary (non-required) conditions.
 */

import { levelCanStandAlone } from "@keystone/schemas";

import type { Verifier, VerifierContext, VerifierOutcome } from "./types.ts";

/** Instruction files an agent must never rewrite on its own behalf (PI-05). */
const RULE_FILES = ["AGENTS.md", "CLAUDE.md"];
/** Lockfiles are managed by package managers, not by a task (PRD 9.7). */
const LOCK_FILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

export const projectRuleVerifier: Verifier = {
  descriptor: {
    kind: "project_rule",
    id: "verifier.project_rule",
    version: "1.0.0",
    evidenceLevel: "E1",
    canSatisfyRequiredCondition: levelCanStandAlone("E1"),
    independence: {
      mode: "separate_process",
      independentOf: ["builder_loop_model", "builder_loop_process"],
    },
    timeoutMs: 30_000,
    requiresCommand: false,
    description: "Checks structural project rules against the changed paths.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    const changed = new Set(ctx.changedPaths.map(normalise));

    const violations: string[] = [];
    for (const file of RULE_FILES) {
      if (changed.has(file)) {
        violations.push(`"${file}" is an agent instruction file and must not be modified by a task`);
      }
    }
    for (const file of LOCK_FILES) {
      if (changed.has(file)) {
        violations.push(`"${file}" is a lockfile and must not be modified by a task`);
      }
    }

    const incomplete: string[] = [];
    const covered = new Set(ctx.conditions.map((condition) => condition.conditionId));
    for (const invariant of ctx.contract.invariants) {
      for (const conditionId of invariant.checkedBy ?? []) {
        if (!covered.has(conditionId)) {
          incomplete.push(
            `invariant "${invariant.invariantId}" is checked by "${conditionId}", ` +
              "which is not part of this verification run",
          );
        }
      }
    }

    if (violations.length > 0) {
      return {
        status: "failed",
        summary: violations.join("; "),
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
        ...(incomplete.length === 0 ? {} : { incomplete }),
      };
    }

    return {
      status: "passed",
      summary: "no project-rule violations were found in the changed paths",
      outputBytes: 0,
      truncated: false,
      durationMs: 0,
      ...(incomplete.length === 0 ? {} : { incomplete }),
    };
  },
};

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
