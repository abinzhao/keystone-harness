/**
 * The localization result compiler: request + context -> Outcome Contract.
 *
 * This is the non-engineering counterpart to `@keystone/pack-engineering`'s
 * `compileContract` (ADR-0006). It drafts — never writes — the machine-readable
 * statement of "done" for a placeholder-parity localization change, and it does
 * so **without any kernel or schema change**: it is just a `ContractProposer`
 * the composition root injects into `KernelSession`.
 *
 * The single required condition names the extension's own E2 verifier **by
 * explicit id** — `extension.localization_placeholders.e2`, the child-process
 * parity checker — and asks for E2 evidence. It deliberately does NOT name the
 * engineering `verifier.test`: proving a localization change must not lean on the
 * engineering test harness, or the second vertical would not actually be a second
 * vertical. The runtime's planner resolves that id to the injected extension
 * verifier; if no such verifier is injected, the condition is reported
 * `unsupported` rather than silently reassigned to `verifier.test`.
 */

import type {
  ContractProposal,
  ContractProposer,
} from "@keystone/kernel";
import {
  newId,
  outcomeContractSchema,
  type Budget,
  type CompletionCondition,
  type OutcomeContract,
  type ScopeEntry,
} from "@keystone/schemas";

import { localizationParityE2Verifier } from "./e2-verifier.ts";

const DEFAULT_BUDGET: Budget = {
  maxTokens: 200_000,
  maxWallClockMs: 1_800_000,
  maxRetries: 3,
};

/** Source/target catalogs the parity condition compares, relative to the project root. */
const SOURCE_CATALOG = "locales/en.json";
const TARGET_CATALOG = "locales/zh.json";

const EXCLUDED_SCOPE: readonly ScopeEntry[] = [
  { kind: "glob", pattern: "node_modules/**", intent: "write" },
  { kind: "glob", pattern: ".keystone/**", intent: "write" },
  { kind: "path", pattern: "package-lock.json", intent: "write" },
];

const INTERVENTION_TRIGGERS = ["ambiguity", "scope_expansion", "irreversible_action"] as const;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The goal is the request's first sentence, verbatim — rephrasing would smuggle intent. */
function goalFromRequest(request: string): string {
  const collapsed = collapse(request);
  if (collapsed.length === 0) return "Complete the localization change";
  const match = collapsed.match(/^[^。！？.!?]*[。！？.!?]?/);
  const base = (match?.[0] ?? collapsed).trim() || collapsed;
  return base.length <= 200 ? base : `${base.slice(0, 199)}…`;
}

/**
 * Draft the localization contract. The only required completion check is the
 * extension-owned E2 parity verifier; there are no engineering test/typecheck/lint
 * conditions, so a proof for this task cannot rest on the engineering pack at all.
 */
export const compileLocalizationContract: ContractProposer = (input): ContractProposal => {
  const include: ScopeEntry[] = [];
  for (const ref of input.references ?? []) {
    if (ref.kind === "directory") include.push({ kind: "directory", pattern: ref.value, intent: "write" });
    else if (ref.kind === "file") include.push({ kind: "path", pattern: ref.value, intent: "write" });
  }
  // Default write scope for the reference scenario when no reference was named.
  if (include.length === 0) {
    include.push({ kind: "directory", pattern: "locales", intent: "write" });
  }

  const parityCondition: CompletionCondition = {
    conditionId: "cond.placeholder_parity",
    description:
      "the Chinese catalog preserves every placeholder the English source uses (and invents none)",
    verifier: {
      kind: localizationParityE2Verifier.descriptor.kind,
      id: localizationParityE2Verifier.descriptor.id,
      version: localizationParityE2Verifier.descriptor.version,
      params: { source: SOURCE_CATALOG, target: TARGET_CATALOG },
    },
    minEvidenceLevel: "E2",
    requiresIndependence: false,
    required: true,
  };

  const contract = outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId: input.taskId,
    projectId: input.projectId,
    createdAt: new Date().toISOString(),
    createdBy: "kernel",
    goal: goalFromRequest(input.request),
    scope: { include, exclude: EXCLUDED_SCOPE, unknown: [] },
    invariants: [],
    completionConditions: [parityCondition],
    budget: input.budget ?? DEFAULT_BUDGET,
    // The contract may only narrow the envelope it was handed.
    autonomy: input.autonomy,
    uncertainties: [],
    interventionTriggers: [...INTERVENTION_TRIGGERS],
    exitConditions: [
      {
        exitId: "exit.budget",
        kind: "budget_exhausted",
        description: "the task budget (tokens, wall-clock or retries) is exhausted",
      },
      {
        exitId: "exit.no_progress",
        kind: "no_progress",
        description: "further steps make no measurable progress toward a parity-preserving translation",
      },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;

  return { contract, questions: [] };
};
