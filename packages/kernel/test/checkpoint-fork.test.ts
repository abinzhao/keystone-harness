import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newId, nowIso, projectProfileSchema, outcomeContractSchema } from "@keystone/schemas";
import { defaultEnvelope, KernelSession, resolveKeystonePaths, type ContractProposer } from "../src/index.ts";

const propose: ContractProposer = (input) => ({ questions: [], contract: outcomeContractSchema.parse({
  contractId: newId("contract"), version: 1, taskId: input.taskId, projectId: input.projectId,
  createdAt: nowIso(), createdBy: "kernel", goal: input.request,
  scope: { include: [{ kind: "path", pattern: "src/a.ts", intent: "write" }], exclude: [], unknown: [] },
  invariants: [], completionConditions: [{ conditionId: "cond.tests", description: "test passes",
    verifier: { kind: "test", id: "verifier.test", version: "1.0.0" },
    minEvidenceLevel: "E2", requiresIndependence: false, required: true }], budget: input.budget ??
    { maxTokens: 1000, maxWallClockMs: 60000, maxRetries: 1 },
  autonomy: input.autonomy, uncertainties: [],
  interventionTriggers: ["ambiguity"], exitConditions: [
    { exitId: "exit.budget", kind: "budget_exhausted", description: "budget exceeded" }],
  status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
}) });

test("an explicit historical checkpoint forks only its covered event prefix", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-fork-"));
  const paths = resolveKeystonePaths(home);
  try {
    const projectId = newId("proj");
    const session = await KernelSession.create({ paths, projectId: projectId as never,
      request: "fix src/a.ts", references: [{ kind: "file", value: "src/a.ts" }], proposeContract: propose });
    await session.submit();
    await session.compile({ autonomy: defaultEnvelope(projectId as never,
      { maxTokens: 1000, maxWallClockMs: 60000, maxRetries: 1 }), profile: projectProfileSchema.parse({
      projectId, rootPath: "/tmp", name: "test", vcs: "git", languages: ["typescript"],
      support: { status: "supported", reasons: [] }, commands: [], instructionFiles: [],
      createdAt: nowIso(), updatedAt: nowIso(),
    }) });
    await session.start();
    const origin = await session.checkpoint("pre_branch");
    await session.recordBudget({ tokens: 123, wallClockMs: 1, reason: "after checkpoint", measured: true });
    const branch = await session.branch("historical", "counterfactual", { checkpointId: origin.checkpointId });
    const fork = await KernelSession.open({ paths, taskId: session.taskId, branchId: branch.branchId });
    assert.equal(fork.state().budgetUsed.tokens, 0);
    assert.equal(fork.state().branchId, branch.branchId);
    assert.equal(fork.events().some((event) => event.payload["reason"] === "after checkpoint"), false);
    assert.equal(session.state().budgetUsed.tokens, 123);
    assert.equal(fork.replay().consistent, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
