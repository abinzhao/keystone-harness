/**
 * Verification orchestration.
 *
 * Verifiers produce outcomes; the *kernel* turns them into evidence. This module
 * is the bridge, and its whole job is to be conservative:
 *
 *  - A verifier that reports `blocked` produces no evidence. A missing check is
 *    recorded as missing, never as a pass (PRD VF-01, 9.1).
 *  - Evidence level and independence come from the verifier's own declaration, so
 *    a verifier cannot claim more independence than it has.
 *  - Only conditions affected by the last change are re-run, but the caller is
 *    expected to run the full set before declaring completion (PRD VF-03).
 */

import {
  createProvenance,
  listEvidence,
  type KernelSession,
  type KeystonePaths,
} from "@keystone/kernel";
import {
  nowIso,
  contentHash,
  newId,
  type CompletionCondition,
  type EvidenceRecord,
  type OutcomeContract,
} from "@keystone/schemas";
import { builtinVerifiers, planVerification, type Verifier } from "@keystone/verifiers";
import { changedObservedPaths, observeWorkspace, type WorkspaceObservation } from "./workspace-observation.ts";

export interface VerificationRunInput {
  readonly rootPath: string;
  readonly paths: KeystonePaths;
  readonly session: KernelSession;
  readonly contract: OutcomeContract;
  readonly changedPaths: readonly string[];
  readonly verifiers?: readonly Verifier[];
  /** When set, only these conditions are executed (incremental repair). */
  readonly onlyConditionIds?: readonly string[];
  /**
   * Snapshot the verifiers run against. This is a snapshot *id* (the thing
   * evidence points at), not a fingerprint — the fingerprint is a content digest
   * used to decide whether a snapshot still describes the workspace.
   */
  readonly workspaceSnapshotId: string;
  /** Content digest of the workspace, recorded in the independence block. */
  readonly workspaceFingerprint?: string;
  readonly environmentFingerprint?: string;
  readonly signal?: AbortSignal;
}

export interface VerificationOutcome {
  readonly evidence: readonly EvidenceRecord[];
  readonly failed: readonly { conditionId: string; detail: string }[];
  readonly blocked: readonly { conditionId: string; detail: string }[];
  readonly unsupported: readonly { conditionId: string; reason: string }[];
  readonly passedConditionIds: readonly string[];
}

export async function runVerification(input: VerificationRunInput): Promise<VerificationOutcome> {
  const verifiers = input.verifiers ?? builtinVerifiers();
  const { planned, unsupported } = planVerification(input.contract, {
    ...(input.onlyConditionIds === undefined
      ? {}
      : { affectedConditionIds: input.onlyConditionIds }),
    // Extensions/packs inject verifiers by explicit id; planning resolves them
    // ahead of the built-in kind lookup and refuses any silent downgrade.
    verifiers,
  });

  const evidence: EvidenceRecord[] = [];
  const failed: { conditionId: string; detail: string }[] = [];
  const blocked: { conditionId: string; detail: string }[] = [];
  const passedConditionIds: string[] = [];

  for (const group of planned) {
    const conditions: readonly CompletionCondition[] = group.conditions;
    if (conditions.length === 0) continue;
    if (!["executing", "auto_repairing", "verifying"].includes(input.session.state().status)) {
      for (const condition of conditions) blocked.push({ conditionId: condition.conditionId, detail: "the task is no longer active" });
      continue;
    }
    const commandObservations = new Map<string, WorkspaceObservation>();

    const outcome = await group.verifier.run({
      rootPath: input.rootPath,
      taskId: input.session.taskId,
      branchId: input.session.branchId,
      paths: input.paths,
      contract: input.contract,
      conditions,
      changedPaths: [...input.changedPaths],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      commandBoundary: {
        async authorize(command, args, options) {
          const grant = await input.session.authorizeOperation({
            subject: { kind: "verifier", id: group.verifier.descriptor.id },
            capability: command === "git" ? "git.read" : "cmd.exec",
            resourceValues: [command === "git" ? "." : command],
            workingDirectory: options.cwd,
            timeoutMs: options.timeoutMs,
            parametersHash: contentHash({ command, args, cwd: options.cwd, timeoutMs: options.timeoutMs }),
          });
          if (!grant.ok) return undefined;
          commandObservations.set(grant.lease.leaseId, await observeWorkspace(input.rootPath));
          return grant.lease.leaseId;
        },
        async complete(leaseId, result) {
          const before = commandObservations.get(leaseId);
          const after = await observeWorkspace(input.rootPath);
          const changed = before === undefined ? [] : changedObservedPaths(before, after);
          await input.session.recordExecution({
            proposalId: newId("prop"), leaseId,
            status: result.status === "passed" ? "succeeded" : result.status === "timeout" ? "timeout" : "failed",
            durationMs: result.durationMs,
            outputBytes: result.outputBytes,
            ...(result.artifactId === undefined ? {} : { artifactId: result.artifactId }),
            changedPaths: changed,
            origin: "verifier",
          });
          if (before !== undefined && changed.length > 0) await input.session.invalidateStaleEvidence({
            previousFingerprint: before.fingerprint, currentFingerprint: after.fingerprint, changedPaths: changed,
          });
        },
      },
      ...(input.workspaceFingerprint === undefined
        ? {}
        : { workspaceFingerprint: input.workspaceFingerprint }),
    });

    const conditionIds = conditions.map((condition) => condition.conditionId);

    if (outcome.status === "blocked") {
      for (const conditionId of conditionIds) {
        blocked.push({
          conditionId,
          detail:
            outcome.incomplete?.[0] ??
            outcome.summary ??
            `${group.verifier.descriptor.id} could not run in this project`,
        });
      }
      continue;
    }

    // `inconclusive` is treated as a failure to prove, not as a pass: completion
    // requires positive evidence, and a check that did not conclude is not that.
    const succeeded = outcome.status === "passed" && (outcome.incomplete?.length ?? 0) === 0;
    const record = await input.session.recordEvidence({
      conditionIds,
      level: group.verifier.descriptor.evidenceLevel,
      // A failed run is recorded but marked unusable as support. Keeping the
      // output is what lets a reviewer see the failure; marking it `invalid` is
      // what stops a failing test from proving its own condition.
      ...(succeeded ? {} : { status: "invalid" as const, invalidatedBy: ["verifier.reported_failure"] }),
      producer: {
        kind: "verifier",
        id: group.verifier.descriptor.id,
        version: group.verifier.descriptor.version,
      },
      independence: {
        mode: group.verifier.descriptor.independence.mode,
        independentOf: [...group.verifier.descriptor.independence.independentOf],
        ...((input.workspaceFingerprint ?? input.environmentFingerprint) === undefined
          ? {}
          : { environmentFingerprint: (input.workspaceFingerprint ?? input.environmentFingerprint) as never }),
      },
      provenance: createProvenance({
        sourceKind: "verifier",
        trustLevel: "verified",
        locator: outcome.command ?? group.verifier.descriptor.id,
        invalidatedBy: ["workspace.changed", "verifier.changed"],
        transformation: "verification-run",
        observedAt: nowIso(),
        applicableSnapshot: input.workspaceSnapshotId,
      }),
      workspaceSnapshotId: input.workspaceSnapshotId,
      observation: {
        summary: outcome.summary,
        ...(outcome.command === undefined ? {} : { command: outcome.command }),
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        ...(outcome.artifactId === undefined ? {} : { artifactId: outcome.artifactId as never }),
        ...(outcome.outputBytes === undefined ? {} : { bytes: outcome.outputBytes }),
        truncated: outcome.truncated,
        ...(outcome.incomplete === undefined ? {} : { incomplete: [...outcome.incomplete] }),
      },
    });

    evidence.push(record);

    if (succeeded) {
      passedConditionIds.push(...conditionIds);
    } else {
      for (const condition of conditions) {
        failed.push({
          conditionId: condition.conditionId,
          detail: outcome.summary || `${group.verifier.descriptor.id} reported ${outcome.status}`,
        });
      }
    }
  }

  return {
    evidence,
    failed,
    blocked,
    unsupported: unsupported.map((entry) => ({
      conditionId: entry.condition.conditionId,
      reason: entry.reason,
    })),
    passedConditionIds,
  };
}

/** Evidence the kernel has already accepted for this task, for proof rendering. */
export async function collectedEvidence(
  paths: KeystonePaths,
  taskId: string,
): Promise<readonly EvidenceRecord[]> {
  return listEvidence(paths, taskId);
}
