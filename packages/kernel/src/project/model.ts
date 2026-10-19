/**
 * Project Fact store (PRD PI-02, PI-03, PI-04).
 *
 * Facts are append-only on disk (`facts.jsonl`): each update is a new line and
 * the in-memory index keeps the latest line per `factId`, so a fact's history —
 * when it held, when it was observed, which snapshot it applied to — is never
 * overwritten (ADR-0003, ADR-0005).
 *
 * Conflict resolution follows PRD PI-02: precedence is ranked by source kind and
 * trust, and two facts of *equal* rank that disagree are surfaced to the user
 * rather than resolved silently. A low-precedence source may never quietly
 * overwrite a higher one.
 */

import {
  canonicalJson,
  factPrecedenceRank,
  nowIso,
  projectFactSchema,
  type DecisionId,
  type ProjectFact,
  type ProjectId,
} from "@keystone/schemas";

import { appendLineDurable, readJsonLines } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";

export interface ConflictPair {
  readonly a: ProjectFact;
  readonly b: ProjectFact;
}

export interface Resolution {
  readonly winner: ProjectFact;
  readonly loser: ProjectFact;
  /** True when the two facts are equally authoritative and the user must decide. */
  readonly requiresUser: boolean;
}

export interface InvalidationResult {
  /** Facts named directly by the caller that existed and were invalidated. */
  readonly invalidated: readonly string[];
  /** Downstream facts invalidated because they derived from an invalidated one. */
  readonly cascaded: readonly string[];
}

function precedenceRank(fact: ProjectFact): number {
  return factPrecedenceRank(
    fact.source.sourceKind,
    fact.frozenBy !== undefined,
    fact.source.trustLevel,
  );
}

export class ProjectFactStore {
  private readonly paths: KeystonePaths;
  private readonly projectId: ProjectId;
  private readonly facts = new Map<string, ProjectFact>();

  constructor(paths: KeystonePaths, projectId: ProjectId) {
    this.paths = paths;
    this.projectId = projectId;
  }

  private file(): string {
    return this.paths.factsFile(this.projectId);
  }

  /** Load the latest version of every fact into memory (later lines win). */
  async load(): Promise<void> {
    const { items } = await readJsonLines<ProjectFact>(this.file());
    this.facts.clear();
    for (const item of items) {
      const fact = projectFactSchema.parse(item) as ProjectFact;
      this.facts.set(fact.factId, fact);
    }
  }

  async upsert(fact: ProjectFact): Promise<void> {
    const parsed = projectFactSchema.parse(fact) as ProjectFact;
    await this.write(parsed);
  }

  all(): readonly ProjectFact[] {
    return [...this.facts.values()];
  }

  byId(factId: string): ProjectFact | undefined {
    return this.facts.get(factId);
  }

  /** Facts about `path` directly or about any directory that contains it. */
  bySubject(path: string): readonly ProjectFact[] {
    const target = normalisePath(path);
    return this.all().filter((fact) =>
      fact.subjects.some((subject) => subjectCovers(normalisePath(subject), target)),
    );
  }

  /**
   * Invalidate the named facts and everything derived from them, transitively.
   * Precision matters (PI-04): a local change must not force a full rebuild of
   * project cognition, so only the affected fact graph is touched.
   */
  async invalidate(factIds: readonly string[], reason: string): Promise<InvalidationResult> {
    const direct = factIds.filter((id) => this.facts.has(id));
    const affected = new Set(direct);

    let grew = true;
    while (grew) {
      grew = false;
      for (const fact of this.facts.values()) {
        if (affected.has(fact.factId)) continue;
        if (fact.derivedFrom.some((parent) => affected.has(parent))) {
          affected.add(fact.factId);
          grew = true;
        }
      }
    }

    const cascaded = [...affected].filter((id) => !direct.includes(id));
    const at = nowIso();
    for (const id of affected) {
      const fact = this.facts.get(id);
      if (fact === undefined) continue;
      await this.write(
        projectFactSchema.parse({
          ...fact,
          status: "invalidated",
          invalidatedBy: withReason(fact.invalidatedBy, reason),
          updatedAt: at,
        }) as ProjectFact,
      );
    }

    return { invalidated: direct, cascaded };
  }

  /** Freeze a user-confirmed fact so automatic updates cannot overwrite it. */
  async freeze(factId: string, decisionId: string): Promise<void> {
    const fact = this.facts.get(factId);
    if (fact === undefined) return;
    await this.write(
      projectFactSchema.parse({
        ...fact,
        status: "frozen",
        frozenBy: decisionId as DecisionId,
        updatedAt: nowIso(),
      }) as ProjectFact,
    );
  }

  async unfreeze(factId: string): Promise<void> {
    const fact = this.facts.get(factId);
    if (fact === undefined) return;
    await this.write(
      projectFactSchema.parse({
        ...fact,
        status: "active",
        frozenBy: undefined,
        updatedAt: nowIso(),
      }) as ProjectFact,
    );
  }

  /**
   * Mark facts touching `subjects` as stale without cascading: their inputs
   * changed but nothing proves them wrong yet, so they are re-checked lazily.
   */
  async markStaleForSubjects(
    subjects: readonly string[],
    reason: string,
  ): Promise<readonly string[]> {
    const targets = subjects.map(normalisePath);
    const changed: string[] = [];
    const at = nowIso();
    for (const fact of this.all()) {
      if (fact.status === "invalidated" || fact.status === "frozen") continue;
      const overlaps = fact.subjects.some((subject) =>
        targets.some((target) => subjectsOverlap(normalisePath(subject), target)),
      );
      if (!overlaps) continue;
      await this.write(
        projectFactSchema.parse({
          ...fact,
          status: "stale",
          invalidatedBy: withReason(fact.invalidatedBy, reason),
          updatedAt: at,
        }) as ProjectFact,
      );
      changed.push(fact.factId);
    }
    return changed;
  }

  /**
   * Fact pairs that genuinely need a user decision: they disagree, are about
   * overlapping subjects, and sit at the same precedence rank. A pair at
   * different ranks is resolvable automatically (resolveConflict).
   */
  pendingConflicts(): readonly ConflictPair[] {
    const facts = this.all().filter((fact) => fact.status !== "invalidated");
    const pairs: ConflictPair[] = [];
    for (let i = 0; i < facts.length; i += 1) {
      for (let j = i + 1; j < facts.length; j += 1) {
        const a = facts[i];
        const b = facts[j];
        if (a === undefined || b === undefined) continue;
        if (a.statement === b.statement) continue;
        if (precedenceRank(a) !== precedenceRank(b)) continue;
        const overlaps = a.subjects.some((left) =>
          b.subjects.some((right) => subjectsOverlap(normalisePath(left), normalisePath(right))),
        );
        if (!overlaps) continue;
        pairs.push({ a, b });
      }
    }
    return pairs;
  }

  private async write(fact: ProjectFact): Promise<void> {
    await appendLineDurable(this.file(), canonicalJson(fact));
    this.facts.set(fact.factId, fact);
  }
}

/**
 * Precedence-based conflict resolution (PRD PI-02). Lower rank wins; equal rank
 * with disagreeing statements is not a silent win — it is a user intervention.
 */
export function resolveConflict(a: ProjectFact, b: ProjectFact): Resolution {
  const rankA = precedenceRank(a);
  const rankB = precedenceRank(b);
  const requiresUser = rankA === rankB && a.statement !== b.statement;

  if (rankA < rankB) return { winner: a, loser: b, requiresUser };
  if (rankB < rankA) return { winner: b, loser: a, requiresUser };
  return { winner: a, loser: b, requiresUser };
}

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when `subject` names `path` or a directory containing it. */
function subjectCovers(subject: string, path: string): boolean {
  return subject === path || path.startsWith(`${subject}/`);
}

/** Directory-aware overlap between two subject paths. */
function subjectsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function withReason(existing: readonly string[], reason: string): string[] {
  return existing.includes(reason) ? [...existing] : [...existing, reason];
}
