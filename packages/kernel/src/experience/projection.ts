import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, experienceCandidateSchema, experienceEntrySchema, experienceEvaluationSchema,
  type ExperienceCandidate, type ExperienceEntry, type ExperienceEvaluation, type ProjectId, type TaskId, type RunEvent } from "@keystone/schemas";
import { readLedger } from "../ledger/ledger.ts";
import { withLock, writeFileAtomic } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";

export async function rebuildExperience(paths: KeystonePaths, projectId: string): Promise<void> {
  const project = projectId as ProjectId;
  await withLock(join(paths.projectDir(project), "experience.lock"), { timeoutMs: 10_000 }, async () => {
    const names = await readdir(paths.tasksDir).catch(() => []);
    const all: RunEvent[] = [];
    for (const taskId of names) {
      const task = taskId as TaskId;
      const main = await readLedger(paths.ledgerFile(task));
      if (main.events[0]?.payload["projectId"] !== projectId) continue;
      if (!main.integrity.ok || main.tornTail) throw new Error("experience source ledger integrity failed");
      all.push(...main.events);
      const branches = await readdir(join(paths.taskDir(task), "branches")).catch(() => []);
      for (const file of branches.filter((name) => name.endsWith(".jsonl"))) {
        const result = await readLedger(join(paths.taskDir(task), "branches", file));
        if (!result.integrity.ok || result.tornTail) throw new Error("experience branch ledger integrity failed");
        all.push(...result.events);
      }
    }
    const events = [...new Map(all.map((event) => [event.eventId, event])).values()]
      .filter((event) => event.type.startsWith("experience."))
      .sort((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId));
    if (!events.length) return;
    const candidates = new Map<string, ExperienceCandidate>();
    const terminalCandidates = new Map<string, ExperienceCandidate>();
    const entries = new Map<string, ExperienceEntry>();
    const evaluations = new Map<string, ExperienceEvaluation>();
    for (const event of events) {
      switch (event.type) {
        case "experience.candidate_created": {
          const value = experienceCandidateSchema.parse(event.payload);
          if (value.status === "rejected" || value.status === "expired") terminalCandidates.set(value.candidateId, value);
          candidates.set(value.candidateId, terminalCandidates.get(value.candidateId) ?? value);
          break;
        }
        case "experience.promoted": {
          const value = experienceEntrySchema.parse(event.payload); entries.set(value.entryId, value);
          const candidate = value.candidateId && candidates.get(value.candidateId);
          if (candidate && !terminalCandidates.has(candidate.candidateId)) candidates.set(candidate.candidateId, { ...candidate, status: "promoted" });
          break;
        }
        case "experience.demoted": {
          const value = entries.get(String(event.payload["entryId"]));
          if (value) entries.set(value.entryId, experienceEntrySchema.parse({ ...value, status: "demoted",
            invalidatedBy: [...new Set([...value.invalidatedBy, String(event.payload["reason"])])].slice(0, 32),
            note: String(event.payload["detail"]).slice(0, 2000) }));
          break;
        }
        case "experience.evaluated": {
          const value = experienceEvaluationSchema.parse(event.payload); evaluations.set(value.evaluationId, value); break;
        }
      }
    }
    for (const [id, candidate] of terminalCandidates) candidates.set(id, candidate);
    for (const [file, rows] of [
      [paths.experienceCandidatesFile(project), [...candidates.values()]],
      [paths.experienceEntriesFile(project), [...entries.values()]],
      [paths.experienceEvaluationsFile(project), [...evaluations.values()]],
    ] as const) await writeFileAtomic(file, rows.length ? `${rows.map((value) => canonicalJson(value)).join("\n")}\n` : "");
  });
}
