import assert from "node:assert/strict";
import test from "node:test";
import { autonomyEnvelopeSchema, contentHash, newId, projectProfileSchema } from "@keystone/schemas";
import { compileContract } from "../../pack-engineering/src/contract/compile.ts";
import { issueLease } from "../src/lease/lease.ts";

test("configured transport command is allowed only for its exact extension subject and argument prefix", () => {
  const projectId = newId("proj");
  const permission = { subjectId: "extension:trae-model@1", executable: "/bin/trae-cli", argvPrefix: ["exec", "--json"] };
  const envelope = autonomyEnvelopeSchema.parse({
    projectId, readPaths: ["**"], writePaths: [], allowedCommands: [], allowedHosts: [], allowedCredentials: [],
    externalSystems: "none", maxReversibility: "reversible", untrustedContentEgress: "deny_all",
    budget: { maxTokens: 1000, maxWallClockMs: 10000, maxRetries: 1 },
    updatedAt: new Date().toISOString(), updatedBy: "user", widenedBy: [], modelTransports: [permission],
  });
  assert.ok((envelope as any).modelTransports?.length, "transport ceiling must survive schema parsing");
  const taskId = newId("task"), branchId = newId("branch");
  const { contract } = compileContract({
    taskId, projectId, request: "Explain code", taskIntent: "analysis", autonomy: envelope,
    profile: projectProfileSchema.parse({
      projectId, rootPath: "/fixture", name: "fixture", vcs: "git", languages: [], commands: [],
      support: { status: "supported", reasons: [] }, instructionFiles: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }),
  });
  const input = {
    taskId, branchId, contract, envelope, capability: "cmd.exec" as const,
    subject: { kind: "extension" as const, id: permission.subjectId },
    resourceValues: [permission.executable], argvPrefix: ["exec", "--json", "-"],
    parametersHash: contentHash({ input: "synthetic" }),
  };
  assert.equal(issueLease(input).ok, true);
  assert.equal(issueLease({ ...input, subject: { kind: "builder_loop", id: permission.subjectId } }).ok, false);
  assert.equal(issueLease({ ...input, subject: { kind: "extension", id: "another-extension" } }).ok, false);
  assert.equal(issueLease({ ...input, argvPrefix: ["exec", "--dangerously-bypass-approvals-and-sandbox"] }).ok, false);
  assert.equal(issueLease({ ...input, parametersHash: undefined }).ok, false);
  assert.equal(issueLease({ ...input, resourceValues: ["/bin/other"] }).ok, false);
  assert.equal(issueLease({ ...input, contract: { ...contract, autonomy: { ...contract.autonomy, modelTransports: [] } } } as any).ok, false);
  assert.deepEqual(envelope.allowedCommands, []);
});
