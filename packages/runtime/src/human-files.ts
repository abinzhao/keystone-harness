/** A user edit is a separate leased operation, never a model completion claim. */
import { readdir } from "node:fs/promises";
import { KernelSession, putJsonArtifact, type KeystonePaths } from "@keystone/kernel";
import { compileContract, detectProjectProfile, resolveEngineeringAction } from "@keystone/pack-engineering";
import { autonomyEnvelopeSchema, contentHash, newId, nowIso, type ProjectId } from "@keystone/schemas";
import type { FileMutationBoundary } from "./files/service.ts";
import type { KeystoneRuntime } from "./keystone-runtime.ts";
import { changedObservedPaths, observeWorkspace } from "./workspace-observation.ts";

export function humanFileBoundary(
  paths: KeystonePaths, runtime: KeystoneRuntime, project: { rootPath: string; workspaceId: string },
): FileMutationBoundary {
  return {
    async execute(request, effect) {
      return runtime.withWorkspaceWrite(project.workspaceId, async () => {
        const targets = [...new Set([request.path, ...(request.destination === undefined ? [] : [request.destination])])];
        const projectId = project.workspaceId as ProjectId;
        const session = await KernelSession.create({
          paths, projectId, requestedBy: "user", actorId: "workbench.user",
          request: `Human file ${request.operation}: ${targets.join(", ")}`,
          references: targets.map((value) => ({ kind: "file" as const, value })),
          proposeContract: compileContract, resolveAction: resolveEngineeringAction,
        });
        await session.submit();
        const budget = { maxTokens: 1000, maxWallClockMs: 60_000, maxRetries: 0 };
        await session.compile({
          profile: await detectProjectProfile(project.rootPath, projectId),
          autonomy: autonomyEnvelopeSchema.parse({
            projectId, readPaths: ["**"], writePaths: targets, allowedCommands: [], allowedHosts: [],
            allowedCredentials: [], externalSystems: "none", maxReversibility: "compensable",
            untrustedContentEgress: "deny_all", budget, updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
          }), budget,
        });
        await session.start();
        const grant = await session.authorizeOperation({
          subject: { kind: "orchestrator", id: "workbench.user" },
          capability: request.operation === "delete" ? "fs.delete" : "fs.write", resourceValues: targets,
          parametersHash: contentHash(request.parameters), reversibility: "compensable",
        });
        if (!grant.ok) { await session.stop(grant.denial.detail); throw new Error(grant.denial.detail); }
        const before = await observeWorkspace(project.rootPath);
        const started = Date.now();
        let failed = false;
        try {
          const result = await effect();
          const artifact = await putJsonArtifact(paths, result);
          const after = await observeWorkspace(project.rootPath);
          const changedPaths = changedObservedPaths(before, after);
          await session.recordExecution({
            proposalId: newId("prop"), leaseId: grant.lease.leaseId, status: "succeeded",
            durationMs: Date.now() - started, artifactId: artifact.artifactId, changedPaths, origin: "human",
          });
          for (const taskId of await readdir(paths.tasksDir).catch(() => [])) {
            if (taskId === session.taskId || !/^task_[0-9A-Z]+$/i.test(taskId)) continue;
            const previous = await KernelSession.open({ paths, taskId: taskId as never });
            if (previous.state().projectId === projectId) await previous.invalidateStaleEvidence({
              previousFingerprint: before.fingerprint, currentFingerprint: after.fingerprint, changedPaths,
            });
          }
          return result;
        } catch (error) {
          failed = true;
          // Effects are always observed, even if an operation fails mid-write.
          const after = await observeWorkspace(project.rootPath);
          await session.recordExecution({
            proposalId: newId("prop"), status: "failed", durationMs: Date.now() - started,
            changedPaths: changedObservedPaths(before, after), origin: "human", errorCode: "human_edit_failed",
          });
          throw error;
        } finally {
          await session.stop(failed ? "human edit failed; inspect the recorded operation" : "human edit recorded; verification is a separate task");
        }
      });
    },
  };
}
