/** Explicit human commands are leased actions, never independent verification. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { KernelSession, putJsonArtifact, type KeystonePaths } from "@keystone/kernel";
import { compileContract, detectProjectProfile, resolveEngineeringAction } from "@keystone/pack-engineering";
import { autonomyEnvelopeSchema, contentHash, newId, nowIso, userDecisionSchema, type ProjectId } from "@keystone/schemas";
import { runCommandTool } from "../../tools/src/shell.ts";
import type { KeystoneRuntime } from "./keystone-runtime.ts";
import { changedObservedPaths, observeWorkspace } from "./workspace-observation.ts";

export async function runHumanCommand(
  paths: KeystonePaths, runtime: KeystoneRuntime,
  project: { rootPath: string; workspaceId: string },
  input: { command: string; args?: string[]; cwd?: string; timeoutMs?: number; writePaths?: string[]; confirmed?: boolean },
): Promise<Record<string, unknown>> {
  if (input.confirmed !== true) throw new Error("explicit command confirmation is required");
  const parsed = runCommandTool.input.parse({
    command: input.command, args: input.args ?? [], timeoutMs: input.timeoutMs ?? 30_000,
    cwd: join(project.rootPath, input.cwd ?? "."),
  });
  if (input.cwd?.split(/[\\/]/).includes("..") || input.cwd?.startsWith("/") ||
      input.command.includes("/") || input.command.includes("\\")) throw new Error("command and working directory must be confined");
  const writePaths = input.writePaths ?? [];
  if (!Array.isArray(writePaths) || writePaths.some((path) => typeof path !== "string" ||
      path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.split("/").includes(".git"))) {
    throw new Error("writePaths must be workspace-relative");
  }
  return runtime.withWorkspaceWrite(project.workspaceId, async () => {
    const projectId = project.workspaceId as ProjectId;
    const session = await KernelSession.create({
      paths, projectId, actorId: "workbench.user", requestedBy: "user",
      request: `Human command: ${parsed.command}`,
      references: writePaths.map((value) => ({ kind: "file" as const, value })),
      proposeContract: compileContract, resolveAction: resolveEngineeringAction,
    });
    await session.submit();
    const budget = { maxTokens: 1000, maxWallClockMs: 600_000, maxRetries: 0 };
    await session.compile({
      profile: await detectProjectProfile(project.rootPath, projectId), budget,
      autonomy: autonomyEnvelopeSchema.parse({
        projectId, readPaths: ["**"], writePaths, allowedCommands: [parsed.command],
        allowedHosts: [], allowedCredentials: [], externalSystems: "none",
        maxReversibility: "compensable", untrustedContentEgress: "deny_all",
        budget, updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
      }),
    });
    await session.start();
    const decision = userDecisionSchema.parse({
      decisionId: newId("dec"), taskId: session.taskId, branchId: session.branchId, at: nowIso(),
      recordedBy: "user", decision: "allow", rationale: "explicit workbench command confirmation",
      appliesTo: { capability: "cmd.exec", resources: [parsed.command], expiresAt: new Date(Date.now() + 600_000).toISOString() },
      modifications: { parametersHash: contentHash(parsed) },
    });
    await session.recordUserDecision(decision);
    const grant = await session.authorizeOperation({
      subject: { kind: "orchestrator", id: "workbench.user" }, capability: "cmd.exec",
      resourceValues: [parsed.command], workingDirectory: parsed.cwd,
      timeoutMs: parsed.timeoutMs, parametersHash: contentHash(parsed), reversibility: "irreversible", decision,
    });
    if (!grant.ok) { await session.stop(grant.denial.detail); throw new Error(grant.denial.detail); }
    const before = await observeWorkspace(project.rootPath);
    const proposalId = newId("prop");
    try {
      const result = await runCommandTool.run(parsed, {
        paths, rootPath: project.rootPath, taskId: session.taskId, branchId: session.branchId, lease: grant.lease,
      });
      const after = await observeWorkspace(project.rootPath);
      const changedPaths = changedObservedPaths(before, after);
      const output = await putJsonArtifact(paths, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
      await session.recordExecution({
        proposalId, leaseId: grant.lease.leaseId, origin: "human", status: result.status,
        durationMs: result.durationMs, outputBytes: result.outputBytes,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        artifactId: result.artifactId ?? output.artifactId,
        changedPaths,
      });
      for (const id of await readdir(paths.tasksDir)) {
        if (id === session.taskId || !/^task_[0-9A-Z]+$/i.test(id)) continue;
        const previous = await KernelSession.open({ paths, taskId: id as never });
        if (previous.projectId === projectId) await previous.invalidateStaleEvidence({
          previousFingerprint: before.fingerprint, currentFingerprint: after.fingerprint, changedPaths,
        });
      }
      const scopeViolated = session.state().status === "needs_attention";
      await session.stop("human command recorded; verification remains separate");
      return {
        taskId: session.taskId, command: parsed.command, args: parsed.args, cwd: parsed.cwd,
        ...result, artifactId: result.artifactId ?? output.artifactId, changedPaths, scopeViolated,
        lease: { ...grant.lease, status: "consumed", consumedCalls: 1, lastProposalRef: proposalId },
        isolation: "application_guards", environment: { platform: process.platform, nodeVersion: process.version, sanitized: true },
        reproduction: JSON.stringify({ command: parsed.command, args: parsed.args, cwd: parsed.cwd }),
      };
    } catch (error) {
      if (session.state().activeLeaseIds.includes(grant.lease.leaseId)) {
        await session.recordExecution({
          proposalId, leaseId: grant.lease.leaseId, origin: "human", status: "failed", durationMs: 0,
          changedPaths: changedObservedPaths(before, await observeWorkspace(project.rootPath)), errorCode: "human_command_failed",
        });
      }
      await session.stop("human command failed; inspect the recorded operation");
      throw error;
    }
  });
}
