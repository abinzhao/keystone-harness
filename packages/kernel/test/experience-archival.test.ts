import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { contentHash, experienceCandidateSchema, newId, nowIso, userDecisionSchema, type ProjectId } from "@keystone/schemas";
import { ExperienceFirewall, KernelSession, resolveKeystonePaths } from "../src/index.ts";

test("candidate archival requires exact user consent and cannot be revived by ID reuse", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-archive-"));
  const paths = resolveKeystonePaths(home);
  const projectId = newId("proj") as ProjectId;
  try {
    const origin = await KernelSession.create({ paths, projectId, request: "candidate fixture" });
    const candidate = experienceCandidateSchema.parse({
      candidateId: newId("exp"), projectId, sourceTaskIds: [origin.taskId], category: "patch_pattern",
      statement: "candidate is never execution knowledge",
      applicability: { paths: [], symbols: [], languages: [], packageManagers: [], taskShapes: [], toolVersions: [] },
      provenance: { provenanceId: newId("prov"), sourceKind: "model", trustLevel: "untrusted",
        locator: "fixture", derivedFrom: [], invalidatedBy: [], observedAt: nowIso() },
      supportingEvidenceIds: [], createdAt: nowIso(), status: "quarantined", note: "",
    });
    await origin.recordExperienceCandidate(candidate);
    const session = await KernelSession.create({ paths, projectId, requestedBy: "user", request: "reject fixture candidate" });
    const input = { candidateId: candidate.candidateId, reason: "explicit user rejection", decisionId: newId("dec") };
    await assert.rejects(session.rejectExperienceCandidate(input), /exact recorded local user decision/);
    await session.recordUserDecision(userDecisionSchema.parse({
      decisionId: input.decisionId, taskId: session.taskId, branchId: session.branchId, at: nowIso(),
      decision: "allow", rationale: input.reason, recordedBy: "user",
      appliesTo: { resources: [input.candidateId] },
      modifications: { parametersHash: contentHash({ candidateId: input.candidateId, reason: input.reason }) },
    }));
    await assert.rejects(session.rejectExperienceCandidate({ ...input, reason: "different" }), /exact recorded/);
    await session.rejectExperienceCandidate(input);
    await writeFile(paths.experienceCandidatesFile(projectId), "corrupt projection");
    await KernelSession.rebuildProjectExperience({ paths, projectId });
    const firewall = new ExperienceFirewall(paths, projectId); await firewall.load();
    assert.equal(firewall.candidates()[0]?.status, "rejected");
    await assert.rejects(origin.recordExperienceCandidate(candidate), /identity cannot replace/);
    await assert.rejects(firewall.promote(candidate.candidateId, "user_confirmation"), /not promotable/);
    assert.equal(firewall.promoted().length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
