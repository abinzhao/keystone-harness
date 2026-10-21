import { ExperienceFirewall, KernelSession, type KeystonePaths } from "@keystone/kernel";
import { autonomyEnvelopeSchema, contentHash, newId, nowIso, outcomeContractSchema, userDecisionSchema } from "@keystone/schemas";

/** Kernel metadata maintenance grants no workspace, model or external capabilities. */
export async function withExperienceMaintenance<T>(
  paths: KeystonePaths,
  projectId: string,
  request: string,
  operation: (session: KernelSession) => Promise<T>,
): Promise<T> {
  const budget = { maxTokens: 0, maxWallClockMs: 60000, maxRetries: 0 };
  const timestamp = nowIso();
  const autonomy = autonomyEnvelopeSchema.parse({
    projectId, readPaths: [], writePaths: [], allowedCommands: [], allowedHosts: [],
    allowedCredentials: [], externalSystems: "none", maxReversibility: "reversible",
    untrustedContentEgress: "deny_all", budget, updatedAt: timestamp, updatedBy: "user", widenedBy: [],
  });
  const session = await KernelSession.create({
    paths, projectId: projectId as never, requestedBy: "user", actorId: "workbench.user", request,
    proposeContract: (input) => ({
      contract: outcomeContractSchema.parse({
        contractId: newId("contract"), version: 1, taskId: input.taskId, projectId,
        createdAt: timestamp, createdBy: "user", goal: request,
        scope: { include: [], exclude: [], unknown: [] }, invariants: [],
        // The schema requires a condition; it is never evaluated as a proof.
        completionConditions: [{
          conditionId: "cond.experience-maintenance", description: "Maintenance does not claim task completion",
          verifier: { kind: "custom", id: "experience-maintenance", version: "1.0.0" },
          minEvidenceLevel: "E3", requiresIndependence: true, required: true,
        }],
        budget, autonomy, uncertainties: [], interventionTriggers: [],
        exitConditions: [{ exitId: "exit.experience-maintenance", kind: "user_stopped",
          description: "Stop after the user experience operation without claiming completion" }],
        status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
      }),
      questions: [],
    }),
  });
  try {
    await session.submit();
    await session.compile({
      profile: {
        projectId: projectId as never, rootPath: paths.projectDir(projectId as never), name: projectId,
        vcs: "git", languages: [], commands: [], instructionFiles: [],
        support: { status: "unsupported", reasons: ["metadata-only maintenance; no workspace inspection"] },
        createdAt: timestamp, updatedAt: timestamp,
      },
      budget, autonomy,
    });
    await session.start();
    return await operation(session);
  } finally {
    await session.stop("experience maintenance ended; no task completion claimed");
  }
}

export async function rejectExperienceCandidateWithConsent(
  session: KernelSession,
  candidateId: string,
  reason: string,
): Promise<void> {
  const decisionId = newId("dec");
  await session.recordUserDecision(userDecisionSchema.parse({
    decisionId, taskId: session.taskId, branchId: session.branchId, at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "authenticated explicit candidate rejection",
    appliesTo: { resources: [candidateId] },
    modifications: { parametersHash: contentHash({ candidateId, reason }) },
  }));
  await session.rejectExperienceCandidate({ candidateId, reason, decisionId });
}

export async function changeExperience(paths: KeystonePaths, project: {
  readonly workspaceId: string; readonly rootPath: string;
}, entryId: string, input: { readonly action: "confirm" | "revoke"; readonly reason?: string }) {
  await KernelSession.rebuildProjectExperience({ paths, projectId: project.workspaceId });
  return withExperienceMaintenance(paths, project.workspaceId, `User experience ${input.action}: ${entryId}`, async (session) => {
    const firewall = new ExperienceFirewall(paths, project.workspaceId, async (event) => {
      switch (event.type) {
        case "experience.candidate_created": return session.recordExperienceCandidate(event.value);
        case "experience.promoted": return session.recordExperiencePromotion(event.value);
        case "experience.evaluated": return session.recordExperienceEvaluation(event.value);
        case "experience.demoted": return session.recordExperienceDemotion(event.value);
      }
    });
    await firewall.load();
    if (input.action === "revoke") {
      const candidate = firewall.candidates().find((value) => value.candidateId === entryId);
      if (candidate?.status === "quarantined") {
        await rejectExperienceCandidateWithConsent(session, candidate.candidateId,
          input.reason ?? "user revoked experience");
        await KernelSession.rebuildProjectExperience({ paths, projectId: project.workspaceId });
        await firewall.load();
        const rejected = firewall.candidates().find((value) => value.candidateId === entryId);
        if (rejected?.status !== "rejected") throw new Error("candidate rejection could not be established from kernel events");
        return { entry: rejected, taskId: session.taskId };
      }
      const result = await firewall.demote(entryId, "user_requested", input.reason ?? "user revoked experience");
      return { entry: result.entry, taskId: session.taskId };
    }
    const original = firewall.candidates().find((candidate) => candidate.candidateId === entryId);
    if (!original || original.status !== "quarantined") throw new Error("only a quarantined candidate can be confirmed");
    if (["untrusted", "restricted"].includes(original.provenance.trustLevel)) throw new Error("untrusted candidate cannot be promoted");
    const decisionId = newId("dec");
    const candidate = await firewall.proposeCandidate({ ...original, supportingEvidenceIds: [],
      sourceTaskIds: [session.taskId], note: `confirmed from candidate:${original.candidateId}`,
      provenance: { ...original.provenance, sourceKind: "user", trustLevel: "user_confirmed",
        provenanceId: newId("prov") as never, locator: `user-decision:${decisionId}`,
        derivedFrom: [original.provenance.provenanceId], observedAt: nowIso() } });
    await session.recordUserDecision(userDecisionSchema.parse({
      decisionId, taskId: session.taskId, branchId: session.branchId, at: nowIso(),
      decision: "allow", recordedBy: "user", rationale: "authenticated explicit candidate confirmation",
      appliesTo: { resources: [candidate.candidateId] },
    }));
    return { entry: await firewall.promote(candidate.candidateId, "user_confirmation"), taskId: session.taskId };
  });
}
