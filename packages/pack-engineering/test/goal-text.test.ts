import assert from "node:assert/strict";
import test from "node:test";
import { autonomyEnvelopeSchema, newId, nowIso, projectProfileSchema } from "@keystone/schemas";
import { compileContract } from "../src/contract/compile.ts";

test("file extensions and URLs do not truncate the user's goal at an internal dot", () => {
  const projectId = newId("proj");
  const request = "分析 @src/auth/session.js:4-5 为什么重复刷新，并给出建议。不要修改代码。";
  const profile = projectProfileSchema.parse({
    projectId, rootPath: "/fixture", name: "fixture", vcs: "git", languages: [],
    support: { status: "supported", reasons: [] }, commands: [], instructionFiles: [],
    createdAt: nowIso(), updatedAt: nowIso(),
  });
  const autonomy = autonomyEnvelopeSchema.parse({
    projectId, readPaths: ["**"], writePaths: [], allowedCommands: [], allowedHosts: [],
    allowedCredentials: [], externalSystems: "none", maxReversibility: "reversible",
    untrustedContentEgress: "deny_all", budget: { maxTokens: 1000, maxWallClockMs: 10000, maxRetries: 0 },
    updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
  });
  const result = compileContract({ taskId: newId("task"), projectId, request, taskIntent: "analysis", profile, autonomy });
  assert.equal(result.contract.goal, "分析 @src/auth/session.js:4-5 为什么重复刷新，并给出建议。");
});
