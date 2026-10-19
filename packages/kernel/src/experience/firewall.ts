/**
 * The Experience Firewall.
 *
 * A successful run is not knowledge. Experience only reaches a later task after
 * it passes source, applicability and transfer checks, and it leaves again when
 * it stops helping (PRD LE-01..LE-04). The asymmetry that matters: candidates
 * are produced by the Builder Loop, but evaluations are produced by the
 * Assurance Loop — a model never grades its own experience.
 *
 * Persistence is append-only JSON Lines. Updating a candidate, entry or
 * evaluation appends a new record for the same id, and `load` keeps the last
 * record per id, so the store is crash-safe and the earlier history stays on
 * disk for audit.
 */

import {
  canonicalJson,
  experienceCandidateSchema,
  experienceEntrySchema,
  experienceEvaluationSchema,
  isUntrusted,
  newId,
  type DemotionReason,
  type ExperienceCandidate,
  type ExperienceCategory,
  type ExperienceEntry,
  type ExperienceEvaluation,
  type ProjectId,
  type PromotionBasis,
  type ProvenanceRef,
  type TransferOutcome,
} from "@keystone/schemas";

import { appendLineDurable, readJsonLines } from "../storage/atomic.ts";
import type { KeystonePaths } from "../storage/paths.ts";

/** The applicability shape is derived from the candidate so it cannot drift. */
type Applicability = ExperienceCandidate["applicability"];

export interface ProposeCandidateInput {
  readonly projectId: string;
  readonly sourceTaskIds: readonly string[];
  readonly category: ExperienceCategory;
  readonly statement: string;
  readonly applicability: Applicability;
  readonly provenance: ProvenanceRef;
  readonly supportingEvidenceIds: readonly string[];
  readonly note?: string;
}

export interface PromotionVerdict {
  readonly eligible: boolean;
  readonly basis?: PromotionBasis;
  readonly reason: string;
}

interface SelectionQuery {
  readonly taskShape?: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly toolVersions?: readonly { readonly id: string; readonly version: string }[];
}

interface Classification {
  readonly included: boolean;
  readonly reason: string;
}

function byId<T extends { readonly entryId: string }>(a: T, b: T): number {
  return a.entryId.localeCompare(b.entryId);
}

/** Directory-style prefix overlap: either side is the other or an ancestor. */
function pathIntersects(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, "");
  const right = b.replace(/\/+$/, "");
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function anyPathIntersects(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) => pathIntersects(left, right)));
}

/** Last record per id wins, so an appended update supersedes the original. */
function indexLastWins<T>(
  items: readonly unknown[],
  idOf: (value: T) => string,
  parse: (value: unknown) => T,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const parsed = parse(item);
    map.set(idOf(parsed), parsed);
  }
  return map;
}

export class ExperienceFirewall {
  private readonly paths: KeystonePaths;
  private readonly projectId: string;
  private candidatesById: Map<string, ExperienceCandidate> = new Map();
  private entriesById: Map<string, ExperienceEntry> = new Map();
  private evaluationsByEntry: Map<string, ExperienceEvaluation[]> = new Map();

  constructor(paths: KeystonePaths, projectId: string) {
    this.paths = paths;
    this.projectId = projectId;
  }

  private get candidatesFile(): string {
    return this.paths.experienceCandidatesFile(this.projectId as ProjectId);
  }

  private get entriesFile(): string {
    return this.paths.experienceEntriesFile(this.projectId as ProjectId);
  }

  private get evaluationsFile(): string {
    return this.paths.experienceEvaluationsFile(this.projectId as ProjectId);
  }

  async load(): Promise<void> {
    const candidates = await readJsonLines<unknown>(this.candidatesFile);
    const entries = await readJsonLines<unknown>(this.entriesFile);
    const evaluations = await readJsonLines<unknown>(this.evaluationsFile);

    this.candidatesById = indexLastWins<ExperienceCandidate>(
      candidates.items,
      (value) => value.candidateId,
      (value) => experienceCandidateSchema.parse(value) as ExperienceCandidate,
    );
    this.entriesById = indexLastWins<ExperienceEntry>(
      entries.items,
      (value) => value.entryId,
      (value) => experienceEntrySchema.parse(value) as ExperienceEntry,
    );

    this.evaluationsByEntry = new Map();
    for (const item of evaluations.items) {
      const evaluation = experienceEvaluationSchema.parse(item) as ExperienceEvaluation;
      const bucket = this.evaluationsByEntry.get(evaluation.entryId) ?? [];
      bucket.push(evaluation);
      this.evaluationsByEntry.set(evaluation.entryId, bucket);
    }
  }

  async proposeCandidate(input: ProposeCandidateInput): Promise<ExperienceCandidate> {
    const candidate = experienceCandidateSchema.parse({
      candidateId: newId("exp"),
      projectId: this.projectId,
      sourceTaskIds: [...new Set(input.sourceTaskIds)],
      category: input.category,
      statement: input.statement,
      applicability: input.applicability,
      provenance: input.provenance,
      supportingEvidenceIds: [...input.supportingEvidenceIds],
      createdAt: new Date().toISOString(),
      // Every candidate starts quarantined; promotion is a separate, audited step.
      status: "quarantined",
      note: input.note ?? "",
    }) as ExperienceCandidate;

    await appendLineDurable(this.candidatesFile, canonicalJson(candidate));
    this.candidatesById.set(candidate.candidateId, candidate);
    return candidate;
  }

  /** Quarantined candidates are never returned here. */
  promoted(): readonly ExperienceEntry[] {
    return [...this.entriesById.values()]
      .filter((entry) => entry.status === "active")
      .sort(byId);
  }

  candidates(): readonly ExperienceCandidate[] {
    return [...this.candidatesById.values()].sort((a, b) =>
      a.candidateId.localeCompare(b.candidateId),
    );
  }

  evaluatePromotion(candidate: ExperienceCandidate): PromotionVerdict {
    // Untrusted content can never become long-term experience, whatever else is
    // true of it (PRD 9.4, LE-02).
    if (isUntrusted(candidate.provenance.trustLevel)) {
      return {
        eligible: false,
        reason: "source is untrusted, so it can never become long-term experience (PRD 9.4)",
      };
    }

    const uniqueTasks = new Set(candidate.sourceTaskIds).size;
    const hasEvidence = candidate.supportingEvidenceIds.length > 0;

    if (uniqueTasks >= 2 && hasEvidence) {
      return {
        eligible: true,
        basis: "independent_verification",
        reason: `independently verified across ${uniqueTasks} tasks with supporting evidence`,
      };
    }

    const trust = candidate.provenance.trustLevel;
    if (trust === "user_confirmed" || trust === "authoritative") {
      return { eligible: true, basis: "user_confirmation", reason: "the user confirmed this" };
    }

    const sourceKind = candidate.provenance.sourceKind;
    if ((sourceKind === "tool" || sourceKind === "verifier" || sourceKind === "repository") && hasEvidence) {
      return {
        eligible: true,
        basis: "deterministic_derivation",
        reason: `derived from a deterministic ${sourceKind} result with supporting evidence`,
      };
    }

    return {
      eligible: false,
      reason:
        "not promotable: needs 2+ independent tasks with evidence, user confirmation, or " +
        `derivation from a deterministic source; got ${uniqueTasks} task(s) from a ` +
        `${sourceKind} source with ${candidate.supportingEvidenceIds.length} evidence record(s)`,
    };
  }

  async promote(candidateId: string, basis: PromotionBasis): Promise<ExperienceEntry> {
    const candidate = this.candidatesById.get(candidateId);
    if (candidate === undefined) {
      throw new Error(`unknown experience candidate ${candidateId}`);
    }

    const entry = experienceEntrySchema.parse({
      entryId: newId("exp"),
      projectId: this.projectId,
      candidateId: candidate.candidateId,
      category: candidate.category,
      statement: candidate.statement,
      applicability: candidate.applicability,
      provenance: candidate.provenance,
      promotedAt: new Date().toISOString(),
      promotedBy: basis,
      supportingTaskIds: candidate.sourceTaskIds,
      supportingEvidenceIds: candidate.supportingEvidenceIds,
      invalidatedBy: [],
      frozen: false,
      status: "active",
      note: "",
    }) as ExperienceEntry;

    await appendLineDurable(this.entriesFile, canonicalJson(entry));
    this.entriesById.set(entry.entryId, entry);

    const promotedCandidate = experienceCandidateSchema.parse({
      ...candidate,
      status: "promoted",
    }) as ExperienceCandidate;
    await appendLineDurable(this.candidatesFile, canonicalJson(promotedCandidate));
    this.candidatesById.set(promotedCandidate.candidateId, promotedCandidate);

    return entry;
  }

  async demote(
    entryId: string,
    reason: DemotionReason,
    detail: string,
  ): Promise<{ entry: ExperienceEntry; affectedTaskIds: readonly string[] }> {
    const entry = this.entriesById.get(entryId);
    if (entry === undefined) {
      throw new Error(`unknown experience entry ${entryId}`);
    }

    const demoted = experienceEntrySchema.parse({
      ...entry,
      status: "demoted",
      invalidatedBy: [...entry.invalidatedBy, reason].slice(0, 32),
      note: detail.slice(0, 2000),
    }) as ExperienceEntry;

    await appendLineDurable(this.entriesFile, canonicalJson(demoted));
    this.entriesById.set(demoted.entryId, demoted);

    // `affectedTaskIds` is intentionally empty: the runtime owns the running
    // task index and fills this in so the task list can rebuild their Context
    // Plans (PRD LE-04). The firewall only knows the experience store.
    return { entry: demoted, affectedTaskIds: [] };
  }

  async recordEvaluation(input: {
    readonly entryId: string;
    readonly taskId: string;
    readonly used: boolean;
    readonly exclusionReason?: string;
    readonly outcome: TransferOutcome;
    readonly judgeEvidenceIds: readonly string[];
    readonly detail?: string;
  }): Promise<ExperienceEvaluation> {
    const evaluation = experienceEvaluationSchema.parse({
      evaluationId: newId("eval"),
      entryId: input.entryId,
      taskId: input.taskId,
      used: input.used,
      ...(input.exclusionReason === undefined ? {} : { exclusionReason: input.exclusionReason }),
      outcome: input.outcome,
      judgeEvidenceIds: [...input.judgeEvidenceIds],
      // Fixed to the Assurance Loop: the Builder Loop's model never judges its
      // own experience (PRD LE-03).
      evaluatedBy: "assurance_loop",
      evaluatedAt: new Date().toISOString(),
      detail: input.detail ?? "",
    }) as ExperienceEvaluation;

    await appendLineDurable(this.evaluationsFile, canonicalJson(evaluation));
    const bucket = this.evaluationsByEntry.get(evaluation.entryId) ?? [];
    bucket.push(evaluation);
    this.evaluationsByEntry.set(evaluation.entryId, bucket);
    return evaluation;
  }

  /** Selects entries usable for a step, with a reason for every exclusion. */
  selectForContext(
    query: SelectionQuery,
  ): readonly { entry: ExperienceEntry; reason: string }[] {
    const selected: { entry: ExperienceEntry; reason: string }[] = [];
    for (const entry of this.promoted()) {
      const classification = this.classify(entry, query);
      if (classification.included) selected.push({ entry, reason: classification.reason });
    }
    return selected;
  }

  exclusions(
    query: SelectionQuery,
  ): readonly { entryId: string; reason: string }[] {
    const excluded: { entryId: string; reason: string }[] = [];
    for (const entry of this.promoted()) {
      const classification = this.classify(entry, query);
      if (!classification.included) excluded.push({ entryId: entry.entryId, reason: classification.reason });
    }
    return excluded;
  }

  private classify(entry: ExperienceEntry, query: SelectionQuery): Classification {
    if (entry.status !== "active") {
      return { included: false, reason: `entry is ${entry.status}` };
    }
    // `frozen === true` is deliberately NOT an exclusion. Freezing protects an
    // entry from automatic demotion; it does not disable it (PRD LE-04).

    const evaluations = this.evaluationsByEntry.get(entry.entryId) ?? [];
    if (evaluations.some((evaluation) => evaluation.outcome === "negative_transfer")) {
      return { included: false, reason: "negative transfer observed" };
    }

    if (entry.invalidatedBy.length > 0) {
      return { included: false, reason: `invalidated: ${entry.invalidatedBy.join(", ")}` };
    }

    const versionClash = entry.applicability.toolVersions.find((tool) => {
      const current = (query.toolVersions ?? []).find((candidate) => candidate.id === tool.id);
      return current !== undefined && current.version !== tool.version;
    });
    if (versionClash !== undefined) {
      return { included: false, reason: "tool version changed" };
    }

    if (
      entry.applicability.paths.length > 0 &&
      !anyPathIntersects(entry.applicability.paths, query.paths ?? [])
    ) {
      return { included: false, reason: "paths not applicable" };
    }

    if (entry.applicability.taskShapes.length > 0) {
      const shape = query.taskShape;
      if (shape === undefined || !entry.applicability.taskShapes.includes(shape)) {
        return { included: false, reason: "task shape not applicable" };
      }
    }

    return { included: true, reason: "active and applicability matches the current task context" };
  }
}
