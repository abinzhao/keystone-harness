import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { probeTraeCli } from "../src/adapter.ts";
import { KernelSession, resolveKeystonePaths } from "../../kernel/src/index.ts";
import {
  autonomyEnvelopeSchema, newId, outcomeContractSchema, projectProfileSchema,
  type ProjectId,
} from "../../schemas/src/index.ts";
import type { TransportProposal } from "../src/types.ts";

test("installed TRAE CLI version/help pass real KernelSession admission without home or network", {
  skip: process.platform !== "darwin" || process.env["KEYSTONE_TEST_INSTALLED_TRAE"] !== "1",
}, async () => {
  const home = await mkdtemp(tmpdir() + "/keystone-trae-kernel-probe-");
  const projectId = newId("proj") as ProjectId;
  const now = new Date().toISOString();
  const autonomy = autonomyEnvelopeSchema.parse({
    projectId, readPaths: [], writePaths: [], allowedCommands: [], allowedHosts: [],
    allowedCredentials: [], externalSystems: "none", maxReversibility: "reversible",
    untrustedContentEgress: "deny_all", budget: { maxTokens: 1000, maxWallClockMs: 60000, maxRetries: 0 },
    updatedAt: now, updatedBy: "user", widenedBy: [],
    modelTransports: [{ subjectId: "keystone.trae-cli", executable: "/usr/bin/sandbox-exec", argvPrefix: ["-p"] }],
  });
  const profile = projectProfileSchema.parse({
    projectId, rootPath: home, name: "public synthetic transport check", vcs: "git", languages: [],
    support: { status: "supported", reasons: ["Public synthetic probe"] },
    commands: [], instructionFiles: [], createdAt: now, updatedAt: now,
  });
  try {
    const session = await KernelSession.create({
      paths: resolveKeystonePaths(home), projectId, request: "Probe public CLI version/help only.",
      requestedBy: "user", actorId: "runtime",
      proposeContract: (input) => ({
        contract: outcomeContractSchema.parse({
          contractId: newId("contract"), version: 1, taskId: input.taskId, projectId, createdAt: now,
          createdBy: "kernel", goal: input.request, scope: { include: [], exclude: [], unknown: [] },
          invariants: [], completionConditions: [{
            conditionId: "public.version", description: "Inspect public CLI help",
            verifier: { kind: "project_rule", id: "public.version", version: "1.0.0" },
            minEvidenceLevel: "E1", requiresIndependence: false, required: true,
          }], budget: autonomy.budget, autonomy, uncertainties: [], interventionTriggers: ["ambiguity"],
          exitConditions: [{ exitId: "exit.budget", kind: "budget_exhausted", description: "Stop at budget" }],
          status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
        }), questions: [],
      }),
    });
    await session.submit(); await session.compile({ profile, autonomy }); await session.start();
    const issued: string[] = [];
    const authorizeTransport = async (proposal: TransportProposal) => {
      assert.deepEqual(proposal.parameters.egressHosts, []);
      const result = await session.authorizeOperation({
        subject: proposal.subject, capability: proposal.capability, resourceValues: proposal.resource.values,
        maxCalls: 1, workingDirectory: proposal.parameters.cwd, timeoutMs: proposal.parameters.timeoutMs,
        maxOutputBytes: proposal.parameters.maxOutputBytes, argvPrefix: ["-p"],
        parametersHash: proposal.parametersHash, ttlMs: 10000,
      });
      assert.ok(result.ok);
      issued.push(result.lease.leaseId);
      return result.lease;
    };
    const result = await probeTraeCli({
      cliPath: "/Users/bytedance/.local/bin/trae-cli", endpointHost: "api.example.com", egressHosts: ["api.example.com"],
      authorizeTransport, limits: { timeoutMs: 5000 },
    });
    assert.equal(result.version, "0.210.1");
    assert.equal(result.authentication, "not-verified");
    assert.equal(issued.length, 2);
    for (const id of issued) await session.consumeExecutionLease(id);
    assert.deepEqual(autonomy.allowedCommands, [], "model transport never expands Builder commands");
  } finally { await rm(home, { recursive: true, force: true }); }
});
