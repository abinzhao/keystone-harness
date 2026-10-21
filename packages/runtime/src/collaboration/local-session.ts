import { KernelSession, validateLease, type KeystonePaths } from "@keystone/kernel";
import {
  autonomyEnvelopeSchema, contentHash, newId, nowIso, outcomeContractSchema, userDecisionSchema,
  type Capability, type CapabilityLease, type UserDecision,
} from "@keystone/schemas";

export interface LocalProject {
  readonly projectId: string; readonly workspaceId: string; readonly rootPath: string;
  readonly name: string; readonly status: string; readonly archived?: boolean;
  readonly tasks?: readonly string[];
}

/** No repository heuristics or Assurance run are needed for a bounded local operation. */
export async function maintenanceSession(paths: KeystonePaths, project: LocalProject, input: {
  goal: string; resources: readonly string[]; maxTokens?: number; maxWallClockMs?: number; endpoint?: string;
}) {
  const budget = { maxTokens: Math.max(1, input.maxTokens ?? 1000),
    maxWallClockMs: input.maxWallClockMs ?? 60000, maxRetries: 0 };
  const timestamp = nowIso();
  const autonomy = autonomyEnvelopeSchema.parse({
    projectId: project.workspaceId, readPaths: [], writePaths: [...input.resources],
    allowedCommands: [], allowedHosts: input.endpoint ? [new URL(input.endpoint).hostname] : [],
    allowedCredentials: [], externalSystems: input.endpoint ? "reversible_write" : "none",
    maxReversibility: input.endpoint ? "compensable" : "reversible", untrustedContentEgress: "deny_all",
    budget, updatedAt: timestamp, updatedBy: "user", widenedBy: [],
  });
  const session = await KernelSession.create({
    paths, projectId: project.workspaceId as never, requestedBy: "user", actorId: "workbench.collaboration",
    request: input.goal,
    proposeContract: (request) => ({
      contract: outcomeContractSchema.parse({
        contractId: newId("contract"), version: 1, taskId: request.taskId, projectId: request.projectId,
        createdAt: timestamp, createdBy: "user", goal: input.goal,
        scope: { include: input.resources.map((pattern) => ({ kind: "glob", pattern, intent: "write" })),
          exclude: [], unknown: [] },
        invariants: [], completionConditions: [{
          conditionId: "cond.local-maintenance", description: "No completion claimed by maintenance",
          verifier: { kind: "custom", id: "local-maintenance-unavailable", version: "1" },
          minEvidenceLevel: "E3", requiresIndependence: true, required: true,
        }], budget, autonomy, uncertainties: [], interventionTriggers: [],
        exitConditions: [{ exitId: "exit.local-maintenance", kind: "user_stopped",
          description: "Stop after the explicitly authorized operation; never evaluate Proof" }],
        status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
      }), questions: [],
    }),
  });
  await session.submit();
  await session.compile({ profile: {
    projectId: project.workspaceId as never, rootPath: project.rootPath, name: project.name, vcs: "git",
    languages: [], commands: [], instructionFiles: [], support: { status: "supported", reasons: [] },
    createdAt: timestamp, updatedAt: timestamp,
  }, budget, autonomy });
  await session.start();
  return session;
}

export async function localDecision(session: KernelSession, capability: Capability | undefined,
  resources: readonly string[], parameters: unknown, ttlMs = 60000): Promise<UserDecision> {
  const decision = userDecisionSchema.parse({
    decisionId: newId("dec"), taskId: session.taskId, branchId: session.branchId, at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "Authenticated explicit local collaboration UI action",
    modifications: { parametersHash: contentHash(parameters) },
    appliesTo: { ...(capability ? { capability } : {}), resources: [...resources],
      expiresAt: new Date(Date.now() + ttlMs).toISOString() },
  });
  await session.recordUserDecision(decision);
  return decision;
}

export async function authorizedLease(session: KernelSession, capability: Capability,
  resources: readonly string[], parametersHash: string, decision: UserDecision, ttlMs = 60000,
  subjectId = "workbench.collaboration"): Promise<CapabilityLease> {
  const result = await session.authorizeOperation({
    subject: { kind: "orchestrator", id: subjectId }, capability, resourceValues: resources,
    parametersHash, decision, ttlMs, maxCalls: 1,
    reversibility: capability === "external.write" ? "compensable" : "reversible",
  });
  if (!result.ok) throw new Error(`local lease denied: ${result.denial.code}`);
  if (!validateLease(result.lease, { capability, resourceValues: resources, parametersHash }).ok) {
    throw new Error("local lease binding rejected");
  }
  return result.lease;
}

/** Serialize event commits in a session without holding a lock across network IO. */
export function sessionQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
}
