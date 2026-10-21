import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExperienceFirewall, KernelSession, ProjectFactStore, withLock, writeFileAtomic, type KeystonePaths } from "@keystone/kernel";
import { scanProjectCognition } from "@keystone/pack-engineering";
import { canonicalJson, contentHash, nowIso, type ProjectProfile, type WorkspaceSnapshot } from "@keystone/schemas";

export async function refreshCognition(paths: KeystonePaths, rootPath: string,
  profile: ProjectProfile, snapshot: WorkspaceSnapshot): Promise<void> {
  await withLock(join(paths.projectDir(profile.projectId), "cognition-scan.lock"), { timeoutMs: 30000 }, async () => {
    const cacheFile = join(paths.projectDir(profile.projectId), "cognition-cache.json");
    let previous: unknown;
    try { previous = JSON.parse(await readFile(cacheFile, "utf8")); }
    catch { previous = undefined; }
    const result = await scanProjectCognition({ rootPath, profile, snapshot, previous });
    const facts = new ProjectFactStore(paths, profile.projectId);
    await KernelSession.rebuildProjectFacts({ paths, projectId: profile.projectId });
    await facts.load();
    const invalid = facts.all().filter((fact) => result.invalidatedFactIds.includes(fact.factId))
      .map((fact) => ({ ...fact, status: "invalidated" as const,
        invalidatedBy: [...new Set([...fact.invalidatedBy, "source_changed_or_deleted"])].slice(0, 32),
        updatedAt: nowIso() }));
    await KernelSession.updateProjectFacts({ paths, projectId: profile.projectId,
      facts: [...result.facts, ...invalid], reason: "incremental_cognition" });
    await writeFileAtomic(cacheFile, canonicalJson(result.cache));
    await writeFileAtomic(join(paths.projectDir(profile.projectId), "cognition.json"), canonicalJson({
      at: snapshot.at, snapshotId: snapshot.snapshotId, stats: result.stats, coverage: result.coverage,
      limitations: result.limitations, units: result.units.map((unit) => ({
        path: unit.path, sourceHash: unit.sourceHash, symbols: unit.symbols,
        imports: unit.imports, exports: unit.exports, tests: unit.tests,
      })), instructions: result.instructions.map(({ content: _content, ...rule }) => rule),
    }));
  });
}

export async function cognitionView(paths: KeystonePaths, projectId: string) {
  await KernelSession.rebuildProjectFacts({ paths, projectId });
  await KernelSession.rebuildProjectExperience({ paths, projectId });
  const facts = new ProjectFactStore(paths, projectId as never); await facts.load();
  const firewall = new ExperienceFirewall(paths, projectId); await firewall.load();
  let index: unknown = null;
  try { index = JSON.parse(await readFile(join(paths.projectDir(projectId as never), "cognition.json"), "utf8")); }
  catch { /* Missing projection is shown as unindexed. */ }
  return { projectId, facts: facts.all().map((fact) => ({ ...fact, hash: contentHash(fact) })),
    experience: { entries: firewall.promoted(), candidates: firewall.candidates() },
    conflicts: facts.pendingConflicts(), index, scan: index, refreshedAt: nowIso() };
}
