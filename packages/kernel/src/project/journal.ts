import { join } from "node:path";
import { canonicalJson, contentHash, derivedIdBody, factPrecedenceRank, newId, nowIso,
  projectFactSchema, type ProjectFact, type ProjectId, type RunEvent } from "@keystone/schemas";
import { buildEvent } from "../ledger/events.ts";
import { appendEvent, chainTip, readLedger } from "../ledger/ledger.ts";
import { withLock, writeFileAtomic } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";
import { ProjectFactStore } from "./model.ts";

export interface ProjectJournalInput { readonly paths: KeystonePaths; readonly projectId: string }
export interface ProjectFactUpdate extends ProjectJournalInput {
  readonly facts: readonly ProjectFact[];
  readonly reason: string;
}
export interface ProjectFactEdit extends ProjectJournalInput {
  readonly factId: string;
  readonly expectedHash: string;
  readonly statement?: string;
  readonly frozen?: boolean;
  readonly invalidated?: boolean;
}

// This is a project stream, outside tasks/. Its deterministic envelope ids do
// not create a task or take part in task folding.
async function read(input: ProjectJournalInput): Promise<RunEvent[]> {
  const result = await readLedger(join(input.paths.projectDir(input.projectId as ProjectId), "cognition.events.jsonl"));
  if (!result.integrity.ok || result.tornTail) throw new Error("project journal integrity failed");
  return [...result.events];
}
function fold(events: readonly RunEvent[]): Map<string, ProjectFact> {
  const facts = new Map<string, ProjectFact>();
  for (const event of events) {
    if (event.type !== "project.fact_updated") throw new Error("unsupported project journal event");
    const fact = projectFactSchema.parse(event.payload);
    facts.set(fact.factId, fact);
  }
  return facts;
}
async function project(input: ProjectJournalInput, events: readonly RunEvent[]): Promise<void> {
  const rows = [...fold(events).values()].map((value) => canonicalJson(value));
  await writeFileAtomic(input.paths.factsFile(input.projectId as ProjectId), rows.length ? `${rows.join("\n")}\n` : "");
}
async function append(input: ProjectJournalInput, events: RunEvent[], fact: ProjectFact): Promise<void> {
  const event = buildEvent({
    taskId: `task_${derivedIdBody(input.projectId)}`, branchId: `branch_${derivedIdBody(`${input.projectId}:cognition`)}`,
    type: "project.fact_updated", payload: fact as unknown as Record<string, unknown>,
    actorKind: "kernel", actorId: "project-cognition",
  }, chainTip(events));
  await appendEvent(join(input.paths.projectDir(input.projectId as ProjectId), "cognition.events.jsonl"), event);
  events.push(event);
}
async function locked<T>(input: ProjectJournalInput, action: (events: RunEvent[]) => Promise<T>): Promise<T> {
  return withLock(join(input.paths.projectDir(input.projectId as ProjectId), "cognition.lock"),
    { holder: `kernel:project:${process.pid}`, timeoutMs: 10_000 }, async () => action(await read(input)));
}

export async function rebuildFacts(input: ProjectJournalInput): Promise<void> {
  await locked(input, async (events) => { if (events.length) await project(input, events); });
}
export async function updateFacts(input: ProjectFactUpdate): Promise<void> {
  await locked(input, async (events) => {
    if (!events.length) {
      // Existing observed facts are explicitly journalled once, preserving their
      // original provenance. Subsequent projection contents are never trusted.
      const legacy = new ProjectFactStore(input.paths, input.projectId as ProjectId);
      await legacy.load();
      for (const fact of legacy.all()) await append(input, events, fact);
    }
    const current = fold(events);
    for (const raw of input.facts) {
      const next = projectFactSchema.parse(raw);
      if (next.projectId !== input.projectId) throw new Error("project fact belongs to another project");
      const previous = current.get(next.factId);
      if (previous?.status === "frozen") continue;
      if (previous && factPrecedenceRank(next.source.sourceKind, false, next.source.trustLevel) >
          factPrecedenceRank(previous.source.sourceKind, false, previous.source.trustLevel)) continue;
      if (previous && contentHash(previous) === contentHash(next)) continue;
      await append(input, events, next);
      current.set(next.factId, next);
    }
    await project(input, events);
  });
}
export async function editFact(input: ProjectFactEdit): Promise<ProjectFact> {
  return locked(input, async (events) => {
    const fact = fold(events).get(input.factId);
    if (!fact) throw new Error("project fact not found");
    if (contentHash(fact) !== input.expectedHash) throw new Error("project fact changed; reload before editing");
    const decisionId = newId("dec");
    const edited = projectFactSchema.parse({
      ...fact,
      ...(input.statement === undefined ? {} : { statement: input.statement,
        source: { ...fact.source, provenanceId: newId("prov"), sourceKind: "user",
          trustLevel: "user_confirmed", locator: `user-decision:${decisionId}`,
          derivedFrom: [fact.source.provenanceId], observedAt: nowIso() } }),
      ...(input.frozen === undefined ? {} : { status: input.frozen ? "frozen" : "active",
        frozenBy: input.frozen ? decisionId : undefined }),
      ...(input.invalidated ? { status: "invalidated", invalidatedBy: ["user_requested"] } : {}),
      updatedAt: nowIso(),
    });
    await append(input, events, edited);
    // A correction/withdrawal invalidates derived facts; frozen user facts stay.
    if (input.statement !== undefined || input.invalidated) {
      const affected = new Set([fact.factId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const child of fold(events).values()) {
          if (affected.has(child.factId) || child.status === "frozen" ||
              !child.derivedFrom.some((id) => affected.has(id))) continue;
          await append(input, events, projectFactSchema.parse({ ...child, status: "invalidated",
            invalidatedBy: [...new Set([...child.invalidatedBy, `fact_changed:${fact.factId}`])].slice(0, 32),
            updatedAt: nowIso() }));
          affected.add(child.factId); grew = true;
        }
      }
    }
    await project(input, events);
    return edited;
  });
}
