/**
 * Budget accounting.
 *
 * The numbers here are the ones the user is shown (PRD CX-03): tokens, retries,
 * wall-clock and cost, each with a limit from the contract. The only subtlety is
 * what happens near the limit — the system must shrink its ambition (smaller
 * context, stop low-yield attempts) *before* the budget is gone, because running
 * out mid-edit is how a task ends up half-changed with no proof.
 */

import type { Budget, BudgetUsage, OutcomeContract, TaskState } from "@keystone/schemas";

export interface BudgetState {
  readonly tokens: { readonly used: number; readonly limit: number; readonly fraction: number };
  readonly retries: { readonly used: number; readonly limit: number; readonly fraction: number };
  readonly wallClockMs: { readonly used: number; readonly limit: number; readonly fraction: number };
  readonly costUsd: { readonly used: number; readonly limit: number | null; readonly fraction: number };
}

function fraction(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 1 : 0;
  return Math.min(1, used / limit);
}

export function budgetStateFrom(usage: BudgetUsage, budget: Budget): BudgetState {
  const costLimit = budget.maxCostUsd ?? null;
  return {
    tokens: {
      used: usage.tokens,
      limit: budget.maxTokens,
      fraction: fraction(usage.tokens, budget.maxTokens),
    },
    retries: {
      used: usage.retries,
      limit: budget.maxRetries,
      fraction: fraction(usage.retries, budget.maxRetries),
    },
    wallClockMs: {
      used: usage.wallClockMs,
      limit: budget.maxWallClockMs,
      fraction: fraction(usage.wallClockMs, budget.maxWallClockMs),
    },
    costUsd: {
      used: usage.costUsd,
      limit: costLimit,
      fraction: costLimit === null ? 0 : fraction(usage.costUsd, costLimit),
    },
  };
}

export interface BudgetVerdict {
  readonly exhausted: boolean;
  readonly nearlyExhausted: boolean;
  readonly reasons: readonly string[];
}

/** 0.8 is where ambition shrinks; 1.0 is where the task stops. */
const NEAR_LIMIT = 0.8;

export function evaluateBudget(state: BudgetState): BudgetVerdict {
  const reasons: string[] = [];
  let exhausted = false;
  let nearlyExhausted = false;

  const check = (
    label: string,
    entry: { used: number; limit: number | null; fraction: number },
  ): void => {
    if (entry.limit === null || entry.limit <= 0) return;
    if (entry.used >= entry.limit) {
      exhausted = true;
      reasons.push(`${label} exhausted (${entry.used}/${entry.limit})`);
      return;
    }
    if (entry.fraction >= NEAR_LIMIT) {
      nearlyExhausted = true;
      reasons.push(`${label} at ${Math.round(entry.fraction * 100)}% of its limit`);
    }
  };

  check("token budget", state.tokens);
  check("retry budget", state.retries);
  check("wall-clock budget", state.wallClockMs);
  check("cost budget", state.costUsd);

  return { exhausted, nearlyExhausted, reasons };
}

/** Add measured usage. Estimates must not be passed here — see PRD NFR-PERF-06. */
export function addUsage(current: BudgetUsage, delta: Partial<BudgetUsage>): BudgetUsage {
  return {
    tokens: current.tokens + (delta.tokens ?? 0),
    retries: current.retries + (delta.retries ?? 0),
    wallClockMs: current.wallClockMs + (delta.wallClockMs ?? 0),
    costUsd: current.costUsd + (delta.costUsd ?? 0),
  };
}

export function contractBudget(contract: OutcomeContract): Budget {
  return contract.budget;
}

export function usageFromTaskState(state: TaskState): BudgetUsage {
  return state.budgetUsed;
}

export interface ContextPressure {
  readonly shrinkContext: boolean;
  readonly stopLowYieldAttempts: boolean;
  readonly explanation: string;
}

/**
 * What a nearly-exhausted budget means for the next step: a smaller context and
 * no more speculative attempts. This is a *policy* output, so the caller can
 * record why the run changed shape rather than silently behaving differently.
 */
export function contextPressure(verdict: BudgetVerdict): ContextPressure {
  if (verdict.exhausted) {
    return {
      shrinkContext: true,
      stopLowYieldAttempts: true,
      explanation: `budget is exhausted (${verdict.reasons.join("; ")}); the task cannot continue in this branch`,
    };
  }
  if (verdict.nearlyExhausted) {
    return {
      shrinkContext: true,
      stopLowYieldAttempts: true,
      explanation:
        `budget is nearly exhausted (${verdict.reasons.join("; ")}); ` +
        "context is reduced to the highest-relevance items and low-yield attempts stop",
    };
  }
  return {
    shrinkContext: false,
    stopLowYieldAttempts: false,
    explanation: "budget is within plan",
  };
}

/**
 * A context budget for the next step, derived from the remaining tokens rather
 * than from a fixed constant, so a long task degrades gracefully instead of
 * failing at an arbitrary point.
 */
export function nextStepTokenBudget(state: BudgetState, options: { readonly maxStepTokens: number }): number {
  const remaining = Math.max(0, state.tokens.limit - state.tokens.used);
  const headroom = Math.floor(remaining * 0.25);
  return Math.max(1_000, Math.min(options.maxStepTokens, headroom));
}
