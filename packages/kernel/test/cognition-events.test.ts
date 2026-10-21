import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, newId, nowIso, projectFactSchema, provenanceRefSchema, type ProjectFact, type ProjectId } from "@keystone/schemas";
import { ExperienceFirewall, KernelSession, ProjectFactStore, resolveKeystonePaths } from "../src/index.ts";

function fact(projectId: string): ProjectFact {
  return projectFactSchema.parse({
    factId: newId("fact"), projectId, kind: "rule", statement: "use explicit extensions",
    source: { provenanceId: newId("prov"), sourceKind: "repository", trustLevel: "observed",
      locator: "AGENTS.md", derivedFrom: [], invalidatedBy: [], observedAt: nowIso() },
    derivedFrom: [], invalidatedBy: [], status: "active", observedAt: nowIso(),
    updatedAt: nowIso(), subjects: ["src"],
  });
}

test("project events repair projections and protect frozen user facts from scans", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-cognition-"));
  const paths = resolveKeystonePaths(home);
  const projectId = newId("proj") as ProjectId;
  try {
    const original = fact(projectId);
    await KernelSession.updateProjectFacts({ paths, projectId, facts: [original], reason: "scan" });
    await KernelSession.editProjectFact({ paths, projectId, factId: original.factId,
      expectedHash: contentHash(original), statement: "user rule", frozen: true });
    await KernelSession.updateProjectFacts({ paths, projectId,
      facts: [{ ...original, statement: "scan tries to overwrite" }], reason: "rescan" });
    // Projection loss after an event commit is recoverable without source access.
    await writeFile(paths.factsFile(projectId), "broken projection");
    await KernelSession.rebuildProjectFacts({ paths, projectId });
    const store = new ProjectFactStore(paths, projectId);
    await store.load();
    assert.equal(store.byId(original.factId)?.statement, "user rule");
    assert.equal(store.byId(original.factId)?.status, "frozen");
    await assert.rejects(KernelSession.editProjectFact({ paths, projectId, factId: original.factId,
      expectedHash: contentHash(original), frozen: false }), /changed/);
    const journal = await readFile(join(paths.projectDir(projectId), "cognition.events.jsonl"), "utf8");
    assert.match(journal, /user rule/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("promotion rejects direct bypass and a failed event commit leaves no projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-cognition-"));
  const paths = resolveKeystonePaths(home);
  const projectId = newId("proj");
  try {
    const firewall = new ExperienceFirewall(paths, projectId);
    const candidate = await firewall.proposeCandidate({ projectId, sourceTaskIds: [newId("task")],
      category: "patch_pattern", statement: "model guess",
      applicability: { paths: [], symbols: [], languages: [], packageManagers: [], toolVersions: [], taskShapes: [] },
      provenance: provenanceRefSchema.parse({ provenanceId: newId("prov"), sourceKind: "model", trustLevel: "observed",
        locator: "model", derivedFrom: [], invalidatedBy: [], observedAt: nowIso() }),
      supportingEvidenceIds: [],
    });
    await assert.rejects(firewall.promote(candidate.candidateId, "user_confirmation"), /not promotable/);
    const governed = new ExperienceFirewall(paths, projectId, async () => { throw new Error("event commit failed"); });
    await assert.rejects(governed.proposeCandidate({ ...candidate, note: "" }), /event commit failed/);
    const reloaded = new ExperienceFirewall(paths, projectId);
    await reloaded.load();
    assert.equal(reloaded.candidates().length, 1);
    assert.equal(reloaded.promoted().length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
