/**
 * Verifier package tests.
 *
 * Fixtures are real: a temporary Git repository and real child processes, using
 * `node --test` as the project's test script so nothing needs to be installed.
 * KeystonePaths point at a temporary home, so no artifact ever lands in the
 * developer's real store.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveKeystonePaths, type KeystonePaths } from "@keystone/kernel";
import {
  newId,
  outcomeContractSchema,
  type CompletionCondition,
  type EvidenceLevel,
  type OutcomeContract,
  type VerifierKind,
} from "@keystone/schemas";

import { projectRuleVerifier } from "../src/rules.ts";
import { sanitizeEnv, splitCommand } from "../src/run.ts";
import { diffScopeVerifier } from "../src/scope.ts";
import { testVerifier } from "../src/test.ts";
import { typecheckVerifier } from "../src/typecheck.ts";
import {
  VERIFIER_IDS,
  builtinVerifiers,
  getVerifier,
  planVerification,
  verifierDescriptors,
} from "../src/index.ts";
import type { VerifierContext } from "../src/types.ts";

const ISO = "2026-10-19T06:00:00.000Z";

const PASSING_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'test("adds", () => {',
  "  assert.equal(1 + 1, 2);",
  "});",
  "",
].join("\n");

const FAILING_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'test("adds", () => {',
  "  assert.equal(1 + 1, 3);",
  "});",
  "",
].join("\n");

interface ConditionSpec {
  readonly conditionId: string;
  readonly kind: VerifierKind;
  readonly command?: string;
  readonly required?: boolean;
  readonly minEvidenceLevel?: EvidenceLevel;
  readonly requiresIndependence?: boolean;
}

/** Build a Contract through the real schema so fixtures cannot drift. */
function makeContract(
  conditions: readonly ConditionSpec[],
  options: {
    readonly scopeInclude?: readonly string[];
    readonly invariants?: readonly {
      readonly invariantId: string;
      readonly description: string;
      readonly checkedBy?: readonly string[];
    }[];
  } = {},
): OutcomeContract {
  const taskId = newId("task");
  const projectId = newId("proj");
  return outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId,
    projectId,
    createdAt: ISO,
    createdBy: "kernel",
    goal: "verify the change is complete",
    scope: {
      include: (options.scopeInclude ?? ["src/**"]).map((pattern) => ({
        kind: "glob" as const,
        pattern,
        intent: "write" as const,
      })),
      exclude: [],
      unknown: [],
    },
    invariants: (options.invariants ?? []).map((invariant) => ({
      invariantId: invariant.invariantId,
      description: invariant.description,
      ...(invariant.checkedBy === undefined ? {} : { checkedBy: [...invariant.checkedBy] }),
    })),
    completionConditions: conditions.map((spec) => ({
      conditionId: spec.conditionId,
      description: `check ${spec.conditionId}`,
      verifier: {
        kind: spec.kind,
        id: `verifier.${spec.kind}`,
        version: "1.0.0",
        ...(spec.command === undefined ? {} : { params: { command: spec.command } }),
      },
      minEvidenceLevel: spec.minEvidenceLevel ?? "E2",
      requiresIndependence: spec.requiresIndependence ?? false,
      required: spec.required ?? true,
    })),
    budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
    autonomy: {
      projectId,
      readPaths: ["**"],
      writePaths: ["src/**"],
      allowedCommands: ["node", "git"],
      allowedHosts: [],
      allowedCredentials: [],
      externalSystems: "none",
      maxReversibility: "reversible",
      untrustedContentEgress: "deny_all",
      budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
      updatedAt: ISO,
      updatedBy: "user",
      widenedBy: [],
    },
    uncertainties: [],
    interventionTriggers: ["ambiguity"],
    exitConditions: [
      { exitId: "exit.budget", kind: "budget_exhausted", description: "budget exhausted" },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
}

function contextFor(options: {
  readonly rootPath: string;
  readonly paths: KeystonePaths;
  readonly contract: OutcomeContract;
  readonly conditions?: readonly CompletionCondition[];
  readonly changedPaths?: readonly string[];
  readonly timeoutMs?: number;
}): VerifierContext {
  return {
    rootPath: options.rootPath,
    taskId: "task_test",
    branchId: "branch_test",
    paths: options.paths,
    contract: options.contract,
    conditions: options.conditions ?? options.contract.completionConditions,
    changedPaths: options.changedPaths ?? [],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

async function newKeystonePaths(): Promise<KeystonePaths> {
  const home = await mkdtemp(join(tmpdir(), "keystone-home-"));
  return resolveKeystonePaths(home);
}

async function newProjectDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "keystone-verifiers-"));
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function initRepo(cwd: string): void {
  runGit(cwd, ["init", "-q"]);
  runGit(cwd, ["config", "user.email", "keystone-test@example.com"]);
  runGit(cwd, ["config", "user.name", "Keystone Test"]);
}

test("test verifier passes a passing project then fails a failing one", async () => {
  const root = await newProjectDir();
  const paths = await newKeystonePaths();
  try {
    await mkdir(join(root, "tests"), { recursive: true });
    const testFile = join(root, "tests", "sample.test.ts");
    await writeFile(testFile, PASSING_TEST, "utf8");

    const contract = makeContract([
      { conditionId: "cond.test", kind: "test", command: "node --test tests/sample.test.ts" },
    ]);
    const ctx = contextFor({ rootPath: root, paths, contract, timeoutMs: 60_000 });

    const passed = await testVerifier.run(ctx);
    assert.equal(passed.status, "passed");
    assert.match(passed.summary, /passed/);

    await writeFile(testFile, FAILING_TEST, "utf8");
    const failed = await testVerifier.run(ctx);
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test verifier is blocked when no test command can be identified", async () => {
  const root = await newProjectDir();
  const paths = await newKeystonePaths();
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "no-tests", version: "1.0.0", scripts: {} }),
      "utf8",
    );

    const contract = makeContract([{ conditionId: "cond.test", kind: "test" }]);
    const outcome = await testVerifier.run(contextFor({ rootPath: root, paths, contract }));

    assert.equal(outcome.status, "blocked");
    assert.ok((outcome.incomplete ?? []).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff scope verifier accepts in-scope, rejects out-of-scope and flags empty", async () => {
  const paths = await newKeystonePaths();
  const contract = makeContract([{ conditionId: "cond.scope", kind: "diff_scope" }], {
    scopeInclude: ["src/**"],
  });

  const inScope = await diffScopeVerifier.run(
    contextFor({ rootPath: process.cwd(), paths, contract, changedPaths: ["src/a.ts"] }),
  );
  assert.equal(inScope.status, "passed");
  assert.match(inScope.summary, /within the contract scope/);

  const outOfScope = await diffScopeVerifier.run(
    contextFor({
      rootPath: process.cwd(),
      paths,
      contract,
      changedPaths: ["src/a.ts", "docs/readme.md"],
    }),
  );
  assert.equal(outOfScope.status, "failed");
  assert.match(outOfScope.summary, /docs\/readme\.md/);

  const root = await newProjectDir();
  try {
    // A clean repository: git reports no changes either way.
    initRepo(root);
    await writeFile(join(root, "README.md"), "# project\n", "utf8");
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", "init"]);

    const empty = await diffScopeVerifier.run(
      contextFor({ rootPath: root, paths, contract, changedPaths: [] }),
    );
    assert.equal(empty.status, "passed");
    assert.ok((empty.incomplete ?? []).includes("no changed paths were observed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project rule verifier rejects rule-file and lockfile changes", async () => {
  const paths = await newKeystonePaths();
  const contract = makeContract([{ conditionId: "cond.rule", kind: "project_rule" }]);
  const base = { rootPath: process.cwd(), paths, contract };

  const agentFile = await projectRuleVerifier.run(
    contextFor({ ...base, changedPaths: ["AGENTS.md"] }),
  );
  assert.equal(agentFile.status, "failed");
  assert.match(agentFile.summary, /AGENTS\.md/);

  const lockfile = await projectRuleVerifier.run(
    contextFor({ ...base, changedPaths: ["pnpm-lock.yaml"] }),
  );
  assert.equal(lockfile.status, "failed");
  assert.match(lockfile.summary, /pnpm-lock\.yaml/);

  const clean = await projectRuleVerifier.run(
    contextFor({ ...base, changedPaths: ["src/index.ts"] }),
  );
  assert.equal(clean.status, "passed");
});

test("typecheck verifier is blocked without a tsconfig or compiler", async () => {
  const root = await newProjectDir();
  const paths = await newKeystonePaths();
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "no-tsconfig", version: "1.0.0" }),
      "utf8",
    );

    const contract = makeContract([{ conditionId: "cond.typecheck", kind: "typecheck" }]);
    const outcome = await typecheckVerifier.run(contextFor({ rootPath: root, paths, contract }));

    assert.equal(outcome.status, "blocked");
    assert.ok((outcome.incomplete ?? []).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planVerification reports unsupported conditions instead of downgrading them", () => {
  const contract = makeContract([
    { conditionId: "cond.ci", kind: "external_ci", required: false },
    { conditionId: "cond.lint", kind: "lint", required: true },
  ]);

  const plan = planVerification(contract);
  assert.deepEqual(
    plan.unsupported.map((entry) => entry.condition.conditionId),
    ["cond.ci", "cond.lint"],
  );
  assert.equal(plan.planned.length, 0);

  const lintEntry = plan.unsupported.find((entry) => entry.condition.conditionId === "cond.lint");
  assert.ok(lintEntry !== undefined);
  assert.match(lintEntry.reason, /E1/);
});

test("sanitizeEnv keeps allowlisted names and drops credentials", () => {
  const sanitized = sanitizeEnv({
    PATH: "/usr/bin",
    HOME: "/home/me",
    MY_TOKEN: "should-not-leak",
    AWS_SECRET_ACCESS_KEY: "should-not-leak",
    RANDOM_VAR: "not-allowlisted",
  });

  assert.equal(sanitized["PATH"], "/usr/bin");
  assert.equal(sanitized["HOME"], "/home/me");
  assert.equal(sanitized["MY_TOKEN"], undefined);
  assert.equal(sanitized["AWS_SECRET_ACCESS_KEY"], undefined);
  assert.equal(sanitized["RANDOM_VAR"], undefined);
});

test("splitCommand splits on whitespace without shell semantics", () => {
  assert.deepEqual(splitCommand("node --test"), { command: "node", args: ["--test"] });
});

test("built-in verifier registry is complete and addressable", () => {
  assert.deepEqual(
    builtinVerifiers().map((verifier) => verifier.descriptor.id),
    [...VERIFIER_IDS],
  );
  assert.equal(verifierDescriptors().length, VERIFIER_IDS.length);
  assert.equal(getVerifier("verifier.test")?.descriptor.kind, "test");
});

import type { Verifier } from "../src/types.ts";

function fakeVerifier(over: Partial<Verifier["descriptor"]>): Verifier {
  return {
    descriptor: {
      kind: "custom",
      id: "extension.demo.e2",
      version: "1.0.0",
      evidenceLevel: "E2",
      canSatisfyRequiredCondition: true,
      independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
      timeoutMs: 1_000,
      requiresCommand: false,
      description: "fake",
      ...over,
    },
    async run() {
      return {
        status: "passed",
        summary: "fake",
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
      };
    },
  };
}

test("an injected verifier is dispatched by explicit id ahead of kind fallback", () => {
  // The condition names a custom id the built-ins do not own.
  const contract = makeContract([
    { conditionId: "cond.custom", kind: "custom" },
  ]);
  // makeContract writes id = `verifier.${kind}`; override to point at the extension.
  const customCondition = contract.completionConditions[0];
  assert.ok(customCondition !== undefined);
  customCondition.verifier.id = "extension.demo.e2";

  // Without the injected verifier the custom kind is unsupported.
  const without = planVerification(contract);
  assert.deepEqual(without.planned.map((g) => g.verifier.descriptor.id), []);
  assert.equal(without.unsupported.length, 1);

  // With it injected, the condition is routed to the extension by id.
  const injected = fakeVerifier({});
  const withExt = planVerification(contract, { verifiers: [injected] });
  assert.deepEqual(withExt.unsupported.map((u) => u.condition.conditionId), []);
  assert.equal(withExt.planned.length, 1);
  const customGroup = withExt.planned[0];
  assert.ok(customGroup !== undefined);
  assert.equal(customGroup.verifier, injected);
  assert.deepEqual(customGroup.conditions.map((c) => c.conditionId), ["cond.custom"]);
});

test("an injected verifier shadows a built-in by id", () => {
  const contract = makeContract([{ conditionId: "cond.test", kind: "test", command: "true" }]);
  const shadow = fakeVerifier({ id: "verifier.test", kind: "test" });
  const plan = planVerification(contract, { verifiers: [shadow] });
  assert.equal(plan.planned.length, 1);
  const shadowGroup = plan.planned[0];
  assert.ok(shadowGroup !== undefined);
  assert.equal(shadowGroup.verifier, shadow, "the injected verifier must win on id collision");
});

test("a condition demanding a higher level than the verifier produces is unsupported, not downgraded", () => {
  const contract = makeContract([
    // required true (default), min E3, but the E2 injected verifier cannot reach E3.
    { conditionId: "cond.deep", kind: "custom", minEvidenceLevel: "E3" },
  ]);
  const deepCondition = contract.completionConditions[0];
  assert.ok(deepCondition !== undefined);
  deepCondition.verifier.id = "extension.demo.e2";
  const plan = planVerification(contract, { verifiers: [fakeVerifier({ evidenceLevel: "E2" })] });
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.unsupported.length, 1);
  const downgradeEntry = plan.unsupported[0];
  assert.ok(downgradeEntry !== undefined);
  assert.match(downgradeEntry.reason, /refusing to silently downgrade/);
});

test("a required independence condition cannot be served by a same-process verifier", () => {
  const contract = makeContract([
    { conditionId: "cond.indep", kind: "custom", requiresIndependence: true },
  ]);
  const indepCondition = contract.completionConditions[0];
  assert.ok(indepCondition !== undefined);
  indepCondition.verifier.id = "extension.weak.same";
  const sameProcess = fakeVerifier({
    id: "extension.weak.same",
    evidenceLevel: "E2",
    canSatisfyRequiredCondition: true,
    independence: { mode: "same_process", independentOf: [] },
  });
  const plan = planVerification(contract, { verifiers: [sameProcess] });
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.unsupported.length, 1);
  const indepEntry = plan.unsupported[0];
  assert.ok(indepEntry !== undefined);
  assert.match(indepEntry.reason, /same process/);
});
