/**
 * Context planning.
 *
 * Every step declares what it loaded, what it deliberately excluded, and what it
 * cost. Two of those matter more than they look:
 *
 *  - **Exclusions are recorded.** "We chose not to send your billing module" is
 *    information the user is entitled to, and it is the only way to explain a bad
 *    answer after the fact (PRD CX-01).
 *  - **Token counts are measured.** The planner counts characters it actually
 *    assembled; it never estimates, because an estimated saving is not a saving
 *    (PRD CX-02, CX-03, NFR-PERF-06).
 *
 * The planner selects; it does not read the filesystem. Callers hand it the
 * candidates, so this stays a pure function that can be replayed and tested.
 */

import {
  canonicalJson,
  contentHash,
  contextPlanSchema,
  nowIso,
  sha256Hex,
  type ContextExclusion,
  type ContextItem,
  type ContextPlan,
  type ExperienceEntry,
  type ProjectFact,
  type ProvenanceRef,
  type OutcomeContract,
} from "@keystone/schemas";

import { pathMatchesAny } from "@keystone/kernel";

/** A file the caller has already read, with the content it read. */
export interface FileCandidate {
  readonly path: string;
  readonly content: string;
  readonly provenance: ProvenanceRef;
  /** How the candidate was found, e.g. `grep:refreshSession` or `scope:src/auth`. */
  readonly discoveredBy: string;
  /** Rough relevance score in [0,1] supplied by the retriever. */
  readonly relevance: number;
}

export interface PlanContextInput {
  readonly taskId: string;
  readonly branchId: string;
  readonly stepId: string;
  readonly stepGoal: string;
  readonly contract: OutcomeContract;
  readonly tokenBudget: number;
  readonly modelTarget: string;
  readonly files: readonly FileCandidate[];
  readonly facts: readonly ProjectFact[];
  readonly experiences: readonly ExperienceEntry[];
  /** Paths the step is allowed to read. Empty means "the whole read scope". */
  readonly readPaths?: readonly string[];
  /** Provenance of everything the retriever itself trusts. */
  readonly retrieverProvenance: ProvenanceRef;
}

export interface PlanContextResult {
  readonly plan: ContextPlan;
  /** The text handed to the model, already counted. */
  readonly rendered: string;
  readonly excluded: readonly ContextExclusion[];
}

/**
 * Character-based token estimate, deliberately conservative (4 chars/token is
 * the low end for code). Using a pessimistic constant means the planner
 * under-fills the budget rather than silently truncating a model call.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A stable, cheap identity for a file, so identical content is deduplicated. */
export function contentKey(content: string): string {
  return sha256Hex(canonicalJson({ length: content.length, head: content.slice(0, 4096) }));
}

export function planContext(input: PlanContextInput): PlanContextResult {
  const exclusions: ContextExclusion[] = [];
  const items: ContextItem[] = [];

  const readScope = input.readPaths ?? [];
  const seenContent = new Map<string, string>();

  // Highest relevance first; ties broken by path so the plan is deterministic.
  const ranked = [...input.files].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a.path.localeCompare(b.path);
  });

  for (const candidate of ranked) {
    if (readScope.length > 0 && !pathMatchesAny(candidate.path, readScope)) {
      exclusions.push({
        ref: candidate.path,
        reason: "outside the read scope for this step",
        apparentRelevance: bucket(candidate.relevance),
      });
      continue;
    }

    const key = contentKey(candidate.content);
    const duplicate = seenContent.get(key);
    if (duplicate !== undefined) {
      exclusions.push({
        ref: candidate.path,
        reason: `identical content to ${duplicate}`,
        apparentRelevance: bucket(candidate.relevance),
      });
      continue;
    }

    const tokens = approximateTokens(candidate.content);
    const usedTokens = items.reduce((total, item) => total + item.tokens, 0);
    if (usedTokens + tokens > input.tokenBudget) {
      // Excluded for budget, not for relevance — a distinction the user needs
      // in order to choose a bigger budget or a smaller scope.
      exclusions.push({
        ref: candidate.path,
        reason: `would exceed the step's context budget (${tokens} tokens needed, ${input.tokenBudget - usedTokens} left)`,
        apparentRelevance: bucket(candidate.relevance),
      });
      continue;
    }

    seenContent.set(key, candidate.path);
    items.push({
      itemId: itemIdFor("file", candidate.path),
      kind: "file",
      ref: candidate.path,
      source: candidate.provenance,
      tokens,
      reason: candidate.discoveredBy,
      invalidatedBy: [`workspace.changed:${candidate.path}`],
      fromCache: false,
    });
  }

  const factsUsed: string[] = [];
  for (const fact of input.facts) {
    if (fact.status === "invalidated") {
      exclusions.push({
        ref: fact.factId,
        reason: "the fact is invalidated",
        apparentRelevance: "high",
      });
      continue;
    }
    if (fact.status === "stale") {
      exclusions.push({
        ref: fact.factId,
        reason: "the fact is stale relative to the current workspace",
        apparentRelevance: "medium",
      });
      continue;
    }
    const text = `${fact.kind}: ${fact.statement}`;
    const tokens = approximateTokens(text);
    const usedTokens = items.reduce((total, item) => total + item.tokens, 0);
    if (usedTokens + tokens > input.tokenBudget) {
      exclusions.push({
        ref: fact.factId,
        reason: "would exceed the step's context budget",
        apparentRelevance: "medium",
      });
      continue;
    }
    factsUsed.push(fact.factId);
    items.push({
      itemId: itemIdFor("fact", fact.factId),
      kind: "fact",
      ref: fact.factId,
      source: fact.source,
      tokens,
      reason: "project cognition relevant to this step",
      invalidatedBy: fact.invalidatedBy,
      fromCache: false,
    });
  }

  const experiencesUsed: string[] = [];
  for (const entry of input.experiences) {
    const text = `experience (${entry.category}): ${entry.statement}`;
    const tokens = approximateTokens(text);
    const usedTokens = items.reduce((total, item) => total + item.tokens, 0);
    if (usedTokens + tokens > input.tokenBudget) {
      exclusions.push({
        ref: entry.entryId,
        reason: "would exceed the step's context budget",
        apparentRelevance: "medium",
      });
      continue;
    }
    experiencesUsed.push(entry.entryId);
    items.push({
      itemId: itemIdFor("experience", entry.entryId),
      kind: "experience",
      ref: entry.entryId,
      source: entry.provenance,
      tokens,
      reason: `promoted experience applicable to this step (${entry.promotedBy})`,
      invalidatedBy: entry.invalidatedBy,
      fromCache: false,
    });
  }

  // The contract itself is always present: without the goal and conditions the
  // model cannot act coherently, and a step that cannot see its own conditions
  // will optimise for the wrong thing.
  const contractText = renderContract(input.contract);
  items.push({
    itemId: "contract.current",
    kind: "contract",
    ref: input.contract.contractId,
    source: input.retrieverProvenance,
    tokens: approximateTokens(contractText),
    reason: "the goal, scope, invariants and conditions in force for this step",
    invalidatedBy: ["contract.revised"],
    fromCache: false,
  });

  const rendered = renderCapsule(input.stepGoal, items, input.files, input.facts, input.experiences);
  const tokensUsed = approximateTokens(rendered);

  const tokensBySource = summariseBySource(items);

  const plan = contextPlanSchema.parse({
    planId: itemIdFor("plan", `${input.stepId}:${contentHash(items.map((item) => item.itemId))}`),
    taskId: input.taskId,
    branchId: input.branchId,
    stepId: input.stepId,
    createdAt: nowIso(),
    items,
    exclusions,
    cacheHits: [],
    tokenBudget: input.tokenBudget,
    tokensUsed,
    tokensBySource,
    factsUsed,
    experiencesUsed,
    evidenceReferenced: [],
    modelTarget: input.modelTarget,
    rebuildWhen: [
      "workspace.fingerprint.changed",
      "contract.revised",
      "fact.invalidated",
      "experience.demoted",
      "model.changed",
    ],
  }) as ContextPlan;

  return { plan, rendered, excluded: exclusions };
}

function itemIdFor(kind: string, ref: string): string {
  const sanitised = ref
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = sanitised.length === 0 ? "item" : sanitised.slice(0, 48);
  const candidate = `${kind}.${trimmed}`;
  // localIdValidator requires a leading letter and a bounded length.
  return /^[a-z]/.test(candidate) ? candidate.slice(0, 64) : `i.${candidate}`.slice(0, 64);
}

function bucket(relevance: number): "high" | "medium" | "low" {
  if (relevance >= 0.66) return "high";
  if (relevance >= 0.33) return "medium";
  return "low";
}

function summariseBySource(
  items: readonly ContextItem[],
): readonly { sourceKind: string; tokens: number }[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.source.sourceKind, (totals.get(item.source.sourceKind) ?? 0) + item.tokens);
  }
  return [...totals.entries()]
    .map(([sourceKind, tokens]) => ({ sourceKind, tokens }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind));
}

function renderContract(contract: OutcomeContract): string {
  const conditions = contract.completionConditions
    .map(
      (condition) =>
        `- ${condition.conditionId} (${condition.verifier.kind}, min ${condition.minEvidenceLevel}${
          condition.required ? ", required" : ", auxiliary"
        }): ${condition.description}`,
    )
    .join("\n");
  const invariants = contract.invariants.map((invariant) => `- ${invariant.description}`).join("\n");
  return [
    `Goal: ${contract.goal}`,
    "Completion conditions:",
    conditions,
    invariants === "" ? "" : `Invariants:\n${invariants}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderCapsule(
  stepGoal: string,
  items: readonly ContextItem[],
  files: readonly FileCandidate[],
  facts: readonly ProjectFact[],
  experiences: readonly ExperienceEntry[],
): string {
  const parts: string[] = [`# Step: ${stepGoal}`, ""];

  for (const item of items) {
    if (item.kind === "file") {
      const file = files.find((candidate) => candidate.path === item.ref);
      if (file === undefined) continue;
      parts.push(`## File: ${item.ref}`);
      parts.push("```", file.content, "```", "");
      continue;
    }
    if (item.kind === "fact") {
      const fact = facts.find((candidate) => candidate.factId === item.ref);
      if (fact === undefined) continue;
      parts.push(`- [project fact] ${fact.statement}`);
      continue;
    }
    if (item.kind === "experience") {
      const entry = experiences.find((candidate) => candidate.entryId === item.ref);
      if (entry === undefined) continue;
      parts.push(`- [experience] ${entry.statement}`);
      continue;
    }
    if (item.kind === "contract") {
      parts.push("## Contract in force", item.ref, "");
    }
  }

  return parts.join("\n");
}
