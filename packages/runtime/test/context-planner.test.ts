import assert from "node:assert/strict";
import test from "node:test";

import { compileContract } from "@keystone/pack-engineering";
import {
  autonomyEnvelopeSchema, experienceEntrySchema, newId, projectFactSchema,
  projectProfileSchema, sha256Hex, type ExperienceEntry, type ProjectFact,
  type ProvenanceRef,
} from "@keystone/schemas";
import { approximateTokens, compactFileCandidate, contentKey, planContext, type PlanContextInput } from "../src/context/planner.ts";

const at = "2026-10-21T00:00:00.000Z";
function source(locator = "src/a.ts"): ProvenanceRef {
  return {
    provenanceId: newId("prov") as never, sourceKind: "repository", trustLevel: "observed",
    locator, derivedFrom: [], invalidatedBy: [`workspace.changed:${locator}`], observedAt: at as never,
  };
}
function input(): PlanContextInput {
  const projectId = newId("proj");
  const profile = projectProfileSchema.parse({
    projectId, rootPath: "/repo", name: "planner-fixture", vcs: "git",
    languages: ["typescript"], packageManager: "pnpm",
    support: { status: "supported", reasons: [] },
    commands: [{ kind: "test", command: "node --test", status: "identified", source: "package.json#scripts.test" }],
    instructionFiles: [], createdAt: at, updatedAt: at,
  });
  const autonomy = autonomyEnvelopeSchema.parse({
    projectId, readPaths: ["**"], writePaths: ["src/**"], allowedCommands: ["node"],
    allowedHosts: [], allowedCredentials: [], externalSystems: "none",
    maxReversibility: "reversible", untrustedContentEgress: "deny_all",
    budget: { maxTokens: 200_000, maxWallClockMs: 60_000, maxRetries: 2 },
    updatedAt: at, updatedBy: "user", widenedBy: [],
  });
  const contract = compileContract({
    projectId, taskId: newId("task"), request: "Fix session refresh without changing behavior",
    references: [{ kind: "directory", value: "src" }], profile, autonomy,
  }).contract;
  return {
    taskId: contract.taskId, branchId: newId("branch"), stepId: "step.context",
    stepGoal: "inspect refresh", contract, tokenBudget: 30_000, modelTarget: "scripted",
    files: [], facts: [], experiences: [], retrieverProvenance: source("retriever"),
  };
}
function file(path: string, content: string) {
  return { path, content, provenance: source(path), discoveredBy: "scope", relevance: 0.8 };
}
function fact(base: PlanContextInput, kind: ProjectFact["kind"], subjects: string[], statement: string): ProjectFact {
  return projectFactSchema.parse({
    factId: newId("fact"), projectId: base.contract.projectId, kind, statement,
    source: source(subjects[0]), derivedFrom: [], invalidatedBy: ["workspace.changed"],
    status: "active", observedAt: at, updatedAt: at, subjects,
  });
}
function experience(base: PlanContextInput): ExperienceEntry {
  return experienceEntrySchema.parse({
    entryId: newId("exp"), projectId: base.contract.projectId, category: "patch_pattern",
    statement: "Reuse the independently checked refresh guard",
    applicability: { paths: ["src/**"], symbols: [], languages: [], packageManagers: [], toolVersions: [], taskShapes: [] },
    provenance: source(), promotedAt: at, promotedBy: "deterministic_derivation",
    supportingTaskIds: [], supportingEvidenceIds: [newId("evd")],
    invalidatedBy: [], frozen: false, status: "active", note: "",
  });
}

test("content identity covers tails beyond 4 KiB", () => {
  const prefix = "x".repeat(5000);
  assert.notEqual(contentKey(`${prefix}a`), contentKey(`${prefix}b`));
  assert.equal(contentKey(`${prefix}a`), sha256Hex(`${prefix}a`));
});

test("capsule contains the actual contract, including permissions and completion criteria", () => {
  const base = input();
  const result = planContext(base);
  assert.ok(result.rendered.includes(base.contract.goal));
  for (const condition of base.contract.completionConditions) {
    assert.ok(result.rendered.includes(condition.description));
  }
  assert.ok(result.rendered.includes("deny_all"));
  assert.ok(result.rendered.includes("src/**"));
});

test("mandatory capsule reservation rejects insufficient budget before optional admission", () => {
  assert.throws(() => planContext({ ...input(), tokenBudget: 1 }), /mandatory.*budget/i);
});

test("admission budgets complete wrappers and mandatory text", () => {
  const base = input();
  const mandatory = planContext(base);
  const result = planContext({
    ...base, tokenBudget: mandatory.plan.tokensUsed + 5, files: [file("src/a.ts", "12345678901234567890")],
  });
  assert.equal(result.plan.items.filter((item) => item.kind === "file").length, 0);
  assert.ok(result.plan.tokensUsed <= result.plan.tokenBudget);
  assert.equal(result.plan.tokensUsed, approximateTokens(result.rendered));
});

test("candidate, demoted, deleted, expired, invalidated and negative experience cannot leak", () => {
  const base = input();
  const good = experience(base);
  const entries = [
    { ...good, entryId: newId("exp"), status: "quarantined" },
    { ...good, entryId: newId("exp"), status: "demoted" },
    { ...good, entryId: newId("exp"), status: "deleted" },
    { ...good, entryId: newId("exp"), provenance: { ...good.provenance, extended: { freshUntil: "2020-01-01T00:00:00.000Z" } } },
    { ...good, entryId: newId("exp"), invalidatedBy: ["contradicted_by_fact"] },
    { ...good, entryId: newId("exp"), provenance: { ...good.provenance, trustLevel: "untrusted" } },
  ] as unknown as ExperienceEntry[];
  const result = planContext({ ...base, experiences: entries });
  assert.deepEqual(result.plan.experiencesUsed, []);
  assert.equal(result.excluded.length, entries.length);
});

test("rules apply to the read scope, not just writes, and are mandatory", () => {
  const base = input();
  const rule = fact(base, "rule", ["src/read-only"], "Do not remove the audit marker.");
  const unrelated = fact(base, "rule", ["other"], "Unrelated secret instruction");
  const scoped = {
    ...base,
    contract: { ...base.contract, scope: { ...base.contract.scope, include: [
      ...base.contract.scope.include, { kind: "directory" as const, pattern: "src/read-only", intent: "read" as const },
    ] } },
    readPaths: ["src/read-only"], facts: [rule, unrelated],
  };
  const result = planContext(scoped);
  assert.deepEqual(result.plan.factsUsed, [rule.factId]);
  assert.ok(result.rendered.includes(rule.statement));
  assert.ok(!result.rendered.includes(unrelated.statement));
  assert.throws(() => planContext({ ...scoped, tokenBudget: planContext({ ...scoped, facts: [] }).plan.tokensUsed }), /mandatory.*budget/i);
});

test("source hashes and trust prevent identical text dedupe from merging provenance", () => {
  const base = input();
  const first = file("src/a.ts", "same");
  const second = { ...file("src/b.ts", "same"), provenance: { ...source("src/b.ts"), trustLevel: "untrusted" as const } };
  const result = planContext({ ...base, files: [first, second] });
  assert.equal(result.plan.items.filter((item) => item.kind === "file").length, 2);
  assert.ok(result.rendered.includes("untrusted"));
  assert.ok(result.rendered.includes(sha256Hex("same")));
});

test("freshness and current invalidation signals also exclude frozen facts", () => {
  const base = input();
  const stale = { ...fact(base, "symbol", ["src/a.ts"], "old"), status: "frozen" as const, freshUntil: "2020-01-01T00:00:00.000Z" as never };
  const changed = fact(base, "symbol", ["src/a.ts"], "changed");
  const extended = { ...base, facts: [stale, changed], invalidatedRefs: ["workspace.changed"] };
  const result = planContext(extended);
  assert.deepEqual(result.plan.factsUsed, []);
});

test("foreign-project experience and files outside effective read permissions are excluded", () => {
  const base = input();
  const foreign = { ...experience(base), projectId: newId("proj") as never };
  const result = planContext({
    ...base, experiences: [foreign], readPaths: ["**"],
    contract: { ...base.contract, autonomy: { ...base.contract.autonomy, readPaths: ["src/a.ts"] } },
    files: [file("src/b.ts", "outside envelope"), file("../escape.ts", "escape")],
  });
  assert.deepEqual(result.plan.experiencesUsed, []);
  assert.equal(result.plan.items.filter((item) => item.kind === "file").length, 0);
});

test("negative assurance evaluations reject otherwise active experience", () => {
  const base = input();
  const entry = experience(base);
  const extended = {
    ...base, experiences: [entry],
    experienceEvaluations: [{
      evaluationId: newId("eval") as never, entryId: entry.entryId, taskId: base.contract.taskId,
      used: true, outcome: "negative_transfer" as const, judgeEvidenceIds: [],
      evaluatedBy: "assurance_loop" as const, evaluatedAt: at as never, detail: "regression",
    }],
  };
  assert.deepEqual(planContext(extended).plan.experiencesUsed, []);
});

test("compact excerpts preserve full-source identity, provenance and constraints", async () => {
  const api = await import("../src/context/planner.ts") as unknown as {
    compactFileCandidate?: (candidate: ReturnType<typeof file> & { constraints: string[] }, start: number, end: number) => ReturnType<typeof file>;
  };
  assert.equal(typeof api.compactFileCandidate, "function");
  const original = { ...file("src/a.ts", "first\nsecond\nthird\n"), constraints: ["Keep the audit marker"] };
  const compact = api.compactFileCandidate!(original, 2, 2);
  assert.equal(compact.content, "second");
  assert.equal(compact.provenance.trustLevel, original.provenance.trustLevel);
  const result = planContext({ ...input(), files: [compact] });
  assert.ok(result.rendered.includes(sha256Hex(original.content)));
  assert.ok(result.rendered.includes(original.provenance.provenanceId));
  assert.ok(result.rendered.includes("Keep the audit marker"));
  assert.ok(result.rendered.includes("excerpt"));
});

test("cache metadata is matched against full content and never invents saved tokens", () => {
  const candidate = {
    ...file("src/a.ts", "export const a = 1;"),
    cache: { contentHash: sha256Hex("export const a = 1;"), matchBasis: "full hash and parser version", kind: "parse" as const },
  };
  const result = planContext({ ...input(), files: [candidate] });
  assert.equal(result.plan.cacheHits.length, 1);
  assert.equal(result.plan.cacheHits[0]?.savedTokens, 0);
  assert.equal(result.plan.items.find((item) => item.kind === "file")?.fromCache, true);
  assert.deepEqual(planContext({ ...input(), files: [{ ...candidate, content: "changed" }] }).plan.cacheHits, []);
});

test("accounting explicitly distinguishes character estimates from provider measurements", () => {
  const result = planContext(input()) as ReturnType<typeof planContext> & {
    accounting?: { kind: string; estimatedTokens: number; measuredTokens: null; characters: number };
  };
  assert.equal(result.accounting?.kind, "character_estimate");
  assert.equal(result.accounting?.measuredTokens, null);
  assert.equal(result.accounting?.characters, result.rendered.length);
  assert.equal(result.accounting?.estimatedTokens, result.plan.tokensUsed);
  assert.equal(result.plan.tokensBySource.reduce((sum, item) => sum + item.tokens, 0), result.plan.tokensUsed);
});

test("glob-only read scopes still load ancestor instructions with no source candidates", () => {
  const base = input();
  const content = "Keep source audit events.";
  const result = planContext({
    ...base, readPaths: ["src/**/*.ts"],
    instructions: [{ path: "src/AGENTS.md", scope: "src/**", content, sourceHash: sha256Hex(content), provenance: source("src/AGENTS.md") }],
  });
  assert.ok(result.rendered.includes(content));
  assert.equal(result.plan.items.filter((item) => item.kind === "instruction").length, 1);
});

test("read exclusions cannot admit instructions from an entirely excluded subtree", () => {
  const base = input();
  const content = "Excluded instruction.";
  const result = planContext({
    ...base, readPaths: ["src/private/**"],
    contract: { ...base.contract, scope: { ...base.contract.scope,
      exclude: [{ kind: "directory", pattern: "src/private", intent: "read" }] } },
    instructions: [{ path: "src/private/AGENTS.md", scope: "src/private/**", content, sourceHash: sha256Hex(content), provenance: source("src/private/AGENTS.md") }],
  });
  assert.ok(!result.rendered.includes(content));
});

test("compacted parse-cache metadata remains a real parse hit, not a token saving", () => {
  const original = {
    ...file("src/a.ts", "first\nsecond\nthird\n"),
    cache: { contentHash: sha256Hex("first\nsecond\nthird\n"), matchBasis: "full source hash", kind: "parse" as const },
  };
  const compact = compactFileCandidate(original, 2, 2);
  const result = planContext({ ...input(), files: [compact] });
  assert.equal(result.plan.cacheHits.length, 1);
  assert.equal(result.plan.cacheHits[0]?.savedTokens, 0);
});

test("root instructions apply with broad reads and no selected files", () => {
  const base = input();
  const content = "Mandatory root constraint.";
  const instruction = { path: "AGENTS.md", scope: "**", content, sourceHash: sha256Hex(content), provenance: source("AGENTS.md") };
  const result = planContext({ ...base, readPaths: ["**"], instructions: [instruction] });
  assert.ok(result.rendered.includes(content));
  const exact = planContext({
    ...base, readPaths: ["**"], instructions: [instruction],
    contract: { ...base.contract, autonomy: { ...base.contract.autonomy, readPaths: ["src/only.ts"] } },
  });
  assert.ok(exact.rendered.includes(content));
});

test("no rule applies when read scope is denied entirely", () => {
  const base = input();
  const content = "Not applicable with denied reads.";
  const result = planContext({
    ...base, readPaths: ["**"],
    contract: { ...base.contract, autonomy: { ...base.contract.autonomy, readPaths: [] } },
    instructions: [{ path: "AGENTS.md", scope: "**", content, sourceHash: sha256Hex(content), provenance: source("AGENTS.md") }],
  });
  assert.ok(!result.rendered.includes(content));
});

test("excerpt provenance forms a derivation without self-reference or dropping restrictions", () => {
  const original = file("src/a.ts", "first\nsecond");
  const compact = compactFileCandidate(original, 2, 2);
  assert.notEqual(compact.provenance.provenanceId, original.provenance.provenanceId);
  assert.ok(compact.provenance.derivedFrom.includes(original.provenance.provenanceId));
  assert.ok(!compact.provenance.derivedFrom.includes(compact.provenance.provenanceId));
  assert.deepEqual(compact.provenance.invalidatedBy, original.provenance.invalidatedBy);
  assert.deepEqual(compactFileCandidate(original, 2, 2), compact);
});
