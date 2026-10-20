/**
 * Focused tests for the engineering Outcome-Contract proposal (ADR-0006).
 *
 * These were extracted verbatim from `packages/kernel/test/contract-experience.test.ts`
 * when the compiler moved into the pack. They pin that the proposal output is
 * byte-for-byte the same behaviour as before the extraction.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  autonomyEnvelopeSchema,
  newId,
  outcomeContractSchema,
  projectProfileSchema,
  type AutonomyEnvelope,
  type ProjectId,
  type ProjectProfile,
} from "@keystone/schemas";

import { compileContract } from "../src/index.ts";

function iso(): string {
  return new Date().toISOString();
}

function autonomyFor(projectId: string): AutonomyEnvelope {
  return autonomyEnvelopeSchema.parse({
    projectId,
    readPaths: ["**"],
    writePaths: ["**"],
    allowedCommands: ["node", "pnpm", "tsc", "eslint"],
    allowedHosts: [],
    allowedCredentials: [],
    externalSystems: "none",
    maxReversibility: "reversible",
    untrustedContentEgress: "deny_all",
    budget: { maxTokens: 100_000, maxWallClockMs: 3_600_000, maxRetries: 2 },
    updatedAt: iso(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}

function profileFor(
  projectId: string,
  commands: ProjectProfile["commands"],
  instructionFiles: readonly string[] = [],
): ProjectProfile {
  return projectProfileSchema.parse({
    projectId,
    rootPath: "/repo",
    name: "demo",
    vcs: "git",
    languages: ["typescript"],
    packageManager: "pnpm",
    support: { status: "supported", reasons: [] },
    commands,
    instructionFiles,
    createdAt: iso(),
    updatedAt: iso(),
  }) as ProjectProfile;
}

test("compileContract infers a concrete scope and emits required E2 conditions", () => {
  const projectId = newId("proj") as ProjectId;
  const result = compileContract({
    taskId: newId("task"),
    projectId,
    request: "修复登录 Session 过期后的重复刷新问题，并确保现有登录行为不变",
    profile: profileFor(projectId, [
      { kind: "test", command: "node --test", status: "identified", source: "packages/kernel/package.json#scripts.test" },
      { kind: "typecheck", command: "tsc --noEmit", status: "identified", source: "package.json#scripts.typecheck" },
      { kind: "lint", command: "eslint .", status: "identified", source: "package.json#scripts.lint" },
    ]),
    autonomy: autonomyFor(projectId),
  });

  // The test command is declared in `packages/kernel`, so the compiler can infer
  // that directory instead of leaving the scope unknown. No scope question is
  // raised, so the task is ready.
  assert.deepEqual(result.contract.scope.include, [
    { kind: "directory", pattern: "packages/kernel", intent: "write" },
  ]);
  assert.deepEqual(result.contract.scope.unknown, []);
  assert.equal(result.contract.status, "ready");
  assert.equal(result.questions.length, 0);

  const byId = new Map(result.contract.completionConditions.map((c) => [c.conditionId, c]));
  const tests = byId.get("cond.target_tests");
  assert.ok(tests !== undefined);
  assert.equal(tests.minEvidenceLevel, "E2");
  assert.equal(tests.required, true);
  assert.equal(tests.verifier.kind, "test");
  const params = tests.verifier.params as Record<string, unknown> | undefined;
  assert.equal(params?.["command"], "node --test");

  const scopeCheck = byId.get("cond.scope_check");
  assert.ok(scopeCheck !== undefined);
  assert.equal(scopeCheck.required, true);
  assert.equal(scopeCheck.verifier.kind, "diff_scope");

  assert.ok(result.contract.invariants.some((i) => i.invariantId === "inv.preserve_behaviour"));
});

test("compileContract raises a verification question when no test command exists", () => {
  const projectId = newId("proj") as ProjectId;
  const result = compileContract({
    taskId: newId("task"),
    projectId,
    request: "add a health check endpoint",
    profile: profileFor(projectId, [
      { kind: "build", command: "tsc", status: "identified", source: "package.json#scripts.build" },
    ]),
    autonomy: autonomyFor(projectId),
  });

  assert.ok(result.questions.some((q) => q.affects === "verification"));
  assert.equal(result.contract.status, "awaiting_approval");
  const tests = result.contract.completionConditions.find((c) => c.conditionId === "cond.target_tests");
  assert.ok(tests !== undefined);
  assert.equal(tests.verifier.params, undefined);
});

test("compileContract output already satisfies the contract schema", () => {
  const projectId = newId("proj") as ProjectId;
  const result = compileContract({
    taskId: newId("task"),
    projectId,
    request: "fix a bug",
    profile: profileFor(projectId, [
      { kind: "test", command: "pnpm test", status: "identified", source: "package.json#scripts.test" },
    ]),
    autonomy: autonomyFor(projectId),
  });
  assert.doesNotThrow(() => outcomeContractSchema.parse(result.contract));
});
