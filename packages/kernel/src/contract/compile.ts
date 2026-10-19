/**
 * The result compiler: user request + known context -> Outcome Contract.
 *
 * `compileContract` produces the machine-readable statement of "done" (PRD
 * OT-02). Two rules shape every branch below:
 *
 *  - Nothing is invented. Every scope entry, invariant and condition traces
 *    back to the request, its references, or the project profile. When the
 *    modification scope cannot be resolved, the compiler writes it into
 *    `scope.unknown` and raises a question instead of guessing (PRD OT-01,
 *    PI-01 §4).
 *  - Required conditions never demand less than E2. E0/E1 cannot stand alone
 *    (PRD VF-02), so emitting E1 on a required check would make completion
 *    unprovable by construction.
 */

import { posix } from "node:path";

import {
  newId,
  outcomeContractSchema,
  type AutonomyEnvelope,
  type Budget,
  type CompletionCondition,
  type ExitCondition,
  type InterventionTrigger,
  type Invariant,
  type OutcomeContract,
  type ProjectFact,
  type ProjectProfile,
  type ScopeEntry,
} from "@keystone/schemas";

export interface ContractQuestion {
  /** Matches `localIdValidator` so it can round-trip as an uncertainty id. */
  readonly questionId: string;
  readonly question: string;
  readonly affects: "implementation" | "scope" | "verification";
  readonly suggestedAnswer: string;
}

export interface CompileContractInput {
  readonly taskId: string;
  readonly projectId: string;
  /** The user's request, verbatim. */
  readonly request: string;
  readonly references?: readonly {
    kind: "file" | "directory" | "issue" | "log" | "url" | "text";
    value: string;
  }[];
  readonly profile: ProjectProfile;
  readonly facts?: readonly ProjectFact[];
  /** Defaults the user or the project provides (e.g. the project's Autonomy Envelope). */
  readonly autonomy: AutonomyEnvelope;
  readonly budget?: Budget;
}

export interface CompileContractResult {
  readonly contract: OutcomeContract;
  readonly questions: readonly ContractQuestion[];
}

const MAX_GOAL_CHARS = 200;

const DEFAULT_BUDGET: Budget = {
  maxTokens: 300_000,
  maxWallClockMs: 7_200_000,
  maxRetries: 3,
};

/**
 * Never guess lock files or build output. Keeping them out of the write scope
 * is what stops an Agent from "fixing" dependency resolution by editing a lock
 * file, which the PRD forbids outright.
 */
const EXCLUDED_SCOPE: readonly ScopeEntry[] = [
  { kind: "glob", pattern: "node_modules/**", intent: "write" },
  { kind: "glob", pattern: "dist/**", intent: "write" },
  { kind: "glob", pattern: ".keystone/**", intent: "write" },
  { kind: "glob", pattern: "*.lock", intent: "write" },
  { kind: "path", pattern: "package-lock.json", intent: "write" },
];

const DEFAULT_TRIGGERS: readonly InterventionTrigger[] = [
  "ambiguity",
  "scope_expansion",
  "irreversible_action",
  "budget_exhausted",
  "undecidable",
  "conflicting_constraints",
];

const DEFAULT_EXIT_CONDITIONS: readonly ExitCondition[] = [
  {
    exitId: "exit.budget",
    kind: "budget_exhausted",
    description: "the task budget (tokens, wall-clock or retries) is exhausted",
  },
  {
    exitId: "exit.no_progress",
    kind: "no_progress",
    description: "further steps make no measurable progress toward completion",
  },
];

/** Keywords whose presence implies behaviour that must not regress. */
const PRESERVE_KEYWORDS = [
  "不改变",
  "保持",
  "不变",
  "兼容",
  "向后兼容",
  "public api",
  "existing behaviour",
  "existing behavior",
] as const;

/** Keywords whose presence implies the task is about tests. */
const TEST_KEYWORDS = ["测试", "test"] as const;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The goal is the request's first sentence, verbatim. Rephrasing it would let
 * the compiler smuggle in intent the user never expressed, which is exactly the
 * failure mode PRD OT-02 warns about.
 */
function goalFromRequest(request: string): string {
  const collapsed = collapse(request);
  if (collapsed.length === 0) return "Complete the requested task";
  const match = collapsed.match(/^[^。！？.!?]*[。！？.!?]?/);
  const sentence = (match?.[0] ?? collapsed).trim();
  const base = sentence.length > 0 ? sentence : collapsed;
  return base.length <= MAX_GOAL_CHARS ? base : `${base.slice(0, MAX_GOAL_CHARS - 1)}…`;
}

/** The sentence that triggered an invariant, so the contract shows the source. */
function sentenceContaining(text: string, keywords: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  const hit = keywords.find((keyword) => lower.includes(keyword.toLowerCase()));
  if (hit === undefined) return undefined;
  const parts = text
    .split(/[。！？.!?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.find((part) => part.toLowerCase().includes(hit.toLowerCase())) ?? parts[0] ?? text;
}

/** A readable hint for the unresolved scope, taken from the request itself. */
function moduleHint(request: string): string {
  const match = request.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./*-]+/);
  return match?.[0] ?? "整个仓库";
}

function directoryOf(filePart: string): string {
  const cleaned = filePart.replace(/^\.\//, "");
  const dir = posix.dirname(cleaned);
  return dir === "." || dir === "/" || dir === "" ? "" : dir;
}

/**
 * Infer a concrete write scope only when the project tells us where code lives.
 * The test command's definition site (e.g. `packages/kernel/package.json`) and
 * known `test_mapping` facts name real directories; anything else is a guess and
 * is left to `scope.unknown`.
 */
function inferScopeDirectories(
  profile: ProjectProfile,
  facts: readonly ProjectFact[] | undefined,
): ScopeEntry[] {
  const directories = new Set<string>();

  const testCommand = profile.commands.find(
    (command) => command.kind === "test" && command.status === "identified",
  );
  if (testCommand?.source !== undefined) {
    const dir = directoryOf(testCommand.source.split("#")[0] ?? "");
    if (dir !== "") directories.add(dir);
  }

  for (const fact of facts ?? []) {
    if (fact.kind !== "test_mapping") continue;
    for (const subject of fact.subjects) {
      const dir = directoryOf(subject);
      if (dir !== "") directories.add(dir);
    }
  }

  return [...directories]
    .sort()
    .map((pattern): ScopeEntry => ({ kind: "directory", pattern, intent: "write" }));
}

export function compileContract(input: CompileContractInput): CompileContractResult {
  const questions: ContractQuestion[] = [];
  const invariants: Invariant[] = [];
  const conditions: CompletionCondition[] = [];

  const blob = [input.request, ...(input.references ?? []).map((ref) => ref.value)].join("\n");

  const preserveHit = sentenceContaining(blob, PRESERVE_KEYWORDS);
  if (preserveHit !== undefined) {
    invariants.push({
      invariantId: "inv.preserve_behaviour",
      description: `existing behaviour and public interfaces must not change (request: "${preserveHit}")`,
    });
  }
  const testHit = sentenceContaining(blob, TEST_KEYWORDS);
  if (testHit !== undefined) {
    invariants.push({
      invariantId: "inv.tests_remain_valid",
      description: `existing tests must keep passing (request: "${testHit}")`,
    });
  }

  const referenceEntries: ScopeEntry[] = [];
  for (const ref of input.references ?? []) {
    if (ref.kind === "file") {
      referenceEntries.push({ kind: "path", pattern: ref.value, intent: "write" });
    } else if (ref.kind === "directory") {
      referenceEntries.push({ kind: "directory", pattern: ref.value, intent: "write" });
    }
  }

  const unknownScope: string[] = [];
  let include: ScopeEntry[];
  if (referenceEntries.length > 0) {
    include = referenceEntries;
  } else {
    include = inferScopeDirectories(input.profile, input.facts);
    if (include.length === 0) {
      unknownScope.push(`修改范围未确定：${moduleHint(input.request)}`);
    }
  }

  const testCommand = input.profile.commands.find(
    (command) => command.kind === "test" && command.status === "identified",
  );
  const testCommandValue = testCommand?.command;
  if (testCommandValue === undefined) {
    questions.push({
      questionId: "q.verification.test_command",
      question:
        "Keystone could not identify a test command, so it cannot prove the change with controlled execution.",
      affects: "verification",
      suggestedAnswer: 'Provide the command that runs this project\'s tests, e.g. "pnpm test".',
    });
  }

  if (unknownScope.length > 0) {
    questions.push({
      questionId: "q.scope.unknown",
      question: "The modification scope could not be resolved from the request or the project.",
      affects: "scope",
      suggestedAnswer: "Name the file, directory or module this task is allowed to change.",
    });
  }

  /**
   * High-risk tasks get an independent re-check: a request grounded in a URL or
   * an Issue carries instructions Keystone did not author, and an unresolved
   * scope means the blast radius is unknown. In both cases a same-process test
   * run is not strong enough, so `cond.target_tests` demands independence.
   */
  const highRisk =
    unknownScope.length > 0 ||
    (input.references ?? []).some((ref) => ref.kind === "url" || ref.kind === "issue");

  conditions.push({
    conditionId: "cond.target_tests",
    description: "the change passes the project's tests",
    verifier: {
      kind: "test",
      id: "verifier.test",
      version: "1.0.0",
      ...(testCommandValue === undefined ? {} : { params: { command: testCommandValue } }),
    },
    minEvidenceLevel: "E2",
    requiresIndependence: highRisk,
    required: true,
  });

  const typecheck = input.profile.commands.find(
    (command) => command.kind === "typecheck" && command.status === "identified",
  );
  if (typecheck !== undefined) {
    conditions.push({
      conditionId: "cond.typecheck",
      description: "type checking passes",
      verifier: {
        kind: "typecheck",
        id: "verifier.typecheck",
        version: "1.0.0",
        ...(typecheck.command === undefined ? {} : { params: { command: typecheck.command } }),
      },
      minEvidenceLevel: "E2",
      requiresIndependence: false,
      required: true,
    });
  }

  const lint = input.profile.commands.find(
    (command) => command.kind === "lint" && command.status === "identified",
  );
  if (lint !== undefined) {
    conditions.push({
      conditionId: "cond.lint",
      description: "linting is clean",
      verifier: {
        kind: "lint",
        id: "verifier.lint",
        version: "1.0.0",
        ...(lint.command === undefined ? {} : { params: { command: lint.command } }),
      },
      // Auxiliary: E1 (a tool record) may satisfy a non-required check (VF-02).
      minEvidenceLevel: "E1",
      requiresIndependence: false,
      required: false,
    });
  }

  conditions.push({
    conditionId: "cond.scope_check",
    description: "the actual diff stays inside the contract scope",
    verifier: { kind: "diff_scope", id: "verifier.diff_scope", version: "1.0.0" },
    minEvidenceLevel: "E2",
    requiresIndependence: false,
    required: true,
  });

  if (input.profile.instructionFiles.length > 0) {
    conditions.push({
      conditionId: "cond.project_rules",
      description: "the project's instruction files are respected",
      verifier: { kind: "project_rule", id: "verifier.project_rule", version: "1.0.0" },
      minEvidenceLevel: "E1",
      requiresIndependence: false,
      required: false,
    });
  }

  const blocking = questions.some(
    (question) => question.affects === "scope" || question.affects === "verification",
  );

  const contract = outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId: input.taskId,
    projectId: input.projectId,
    createdAt: new Date().toISOString(),
    createdBy: "kernel",
    goal: goalFromRequest(input.request),
    scope: { include, exclude: EXCLUDED_SCOPE, unknown: unknownScope },
    invariants,
    completionConditions: conditions,
    budget: input.budget ?? DEFAULT_BUDGET,
    // The contract may only ever narrow the envelope it was handed; widening is
    // a recorded user decision (PRD HI-04), never a compiler output.
    autonomy: input.autonomy,
    uncertainties: questions.map((question) => ({
      uncertaintyId: question.questionId,
      question: question.question,
      affects: question.affects,
      resolution: "open",
    })),
    interventionTriggers: DEFAULT_TRIGGERS,
    exitConditions: DEFAULT_EXIT_CONDITIONS,
    status: blocking ? "awaiting_approval" : "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;

  return { contract, questions };
}
