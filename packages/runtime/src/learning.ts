/**
 * Learning cycle.
 *
 * Wires the Experience Firewall into a run: what a finished task teaches, and
 * what a reused lesson actually did for the next task.
 *
 * The rule that shapes every decision here is that a success is not knowledge
 * (PRD LE-01..LE-04). Two consequences are visible in the code:
 *
 *  - Candidates are split by *how they are known*. A change set that made the
 *    tests pass is a deterministic tool result; "the fix probably lives in these
 *    files" is a model inference. Only the first can be promoted on the strength
 *    of one run.
 *  - Evaluations are written by the Assurance Loop from the *later* task's
 *    evidence, never by the model that produced the entry. The firewall enforces
 *    `evaluatedBy: "assurance_loop"`; this module supplies the judgement.
 */

import type { ExperienceFirewall, KernelSession } from "@keystone/kernel";
import {
  contentHash,
  derivedIdBody,
  nowIso,
  type EvidenceRecord,
  type ExperienceCandidate,
  type ExperienceEntry,
  type ExperienceEvaluation,
  type ProjectFact,
  type ProvenanceRef,
} from "@keystone/schemas";

/** What a finished run can teach. */
export interface RunLearningInput {
  readonly session: KernelSession;
  readonly firewall: import("@keystone/kernel").ExperienceFirewall;
  readonly projectId: string;
  readonly taskShape: string;
  readonly goal: string;
  readonly readPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly proven: boolean;
  readonly evidence: readonly EvidenceRecord[];
  readonly languages: readonly string[];
  readonly packageManagers: readonly string[];
  readonly toolVersions: readonly { id: string; version: string }[];
}

export interface LearningOutcome {
  readonly candidates: readonly ExperienceCandidate[];
  readonly promoted: readonly ExperienceEntry[];
  readonly skipped: readonly { statement: string; reason: string }[];
}

function provenanceFor(input: {
  sourceKind: ProvenanceRef["sourceKind"];
  trustLevel: ProvenanceRef["trustLevel"];
  locator: string;
  taskId: string;
  invalidatedBy: readonly string[];
  transformation: string;
}): ProvenanceRef {
  return {
    provenanceId: `prov_${derivedIdBody(`${input.locator}:${input.taskId}`)}`,
    sourceKind: input.sourceKind,
    trustLevel: input.trustLevel,
    locator: input.locator,
    derivedFrom: [],
    invalidatedBy: [...input.invalidatedBy],
    observedAt: nowIso(),
    transformation: input.transformation,
  } as unknown as ProvenanceRef;
}

/** Directory of a repository-relative path, used to scope applicability. */
function topLevelScope(paths: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").filter((part) => part !== "");
    if (parts.length >= 2) scopes.add(parts.slice(0, 2).join("/"));
    else if (parts.length === 1) scopes.add(parts[0] as string);
  }
  return [...scopes].sort().slice(0, 8);
}

/**
 * Turn a finished run into candidates.
 *
 * Failures that were repaired are recorded too: "this looked right and was not"
 * is the lesson that stops the same wrong patch being proposed again.
 */
export async function learnFromRun(input: RunLearningInput): Promise<LearningOutcome> {
  bindLearningEvents(input.firewall, input.session);
  const candidates: ExperienceCandidate[] = [];
  const promoted: ExperienceEntry[] = [];
  const skipped: { statement: string; reason: string }[] = [];

  if (!input.proven) {
    // An unproven run is not a lesson. Recording one would be exactly the
    // "single inference becomes project knowledge" mistake the firewall exists
    // to prevent (PRD LE-01).
    return {
      candidates: [],
      promoted: [],
      skipped: [{ statement: input.goal, reason: "the run was not proven, so it teaches nothing" }],
    };
  }

  const evidenceIds = input.evidence.filter((r) => r.status === "valid").map((r) => r.evidenceId);
  const scopes = topLevelScope(input.changedPaths);
  const applicabilityBase = {
    paths: scopes,
    symbols: [],
    languages: [...input.languages],
    packageManagers: [...input.packageManagers],
    toolVersions: [...input.toolVersions],
    taskShapes: [input.taskShape],
  };

  const propose = async (
    category: ExperienceCandidate["category"],
    statement: string,
    provenance: ProvenanceRef,
  ): Promise<void> => {
    const candidate = await input.firewall.proposeCandidate({
      projectId: input.projectId,
      sourceTaskIds: [input.session.taskId],
      category,
      statement,
      applicability: applicabilityBase,
      provenance,
      supportingEvidenceIds: evidenceIds,
      note: `derived from a proven run of "${input.goal}"`,
    });
    candidates.push(candidate);

    const verdict = input.firewall.evaluatePromotion(candidate);
    if (!verdict.eligible || verdict.basis === undefined) {
      skipped.push({ statement, reason: verdict.reason });
      return;
    }
    const entry = await input.firewall.promote(candidate.candidateId, verdict.basis);
    promoted.push(entry);
  };

  if (input.changedPaths.length > 0) {
    const content = input.changedPaths.slice().sort().join("\n");
    // A change set that made the required checks pass is a deterministic tool
    // result, so one run is enough to promote it.
    await propose(
      "patch_pattern",
      `changing ${content} satisfied the contract for "${input.goal}"; a similar task should start from these files`,
      provenanceFor({
        sourceKind: "tool",
        trustLevel: "verified",
        locator: `git diff:${contentHash(content).slice(0, 12)}`,
        taskId: input.session.taskId,
        invalidatedBy: ["workspace.changed", "tool.changed"],
        transformation: "learning-from-run",
      }),
    );
  }

  if (input.readPaths.length > 0) {
    const scopesRead = topLevelScope(input.readPaths);
    // Which files *looked* relevant is a model-shaped inference, so it stays a
    // candidate until a second task confirms it (PRD LE-02).
    await propose(
      "localization_path",
      `the code relevant to "${input.goal}" was found under ${scopesRead.join(", ")}`,
      provenanceFor({
        sourceKind: "model",
        trustLevel: "observed",
        locator: `step.localize:${derivedIdBody(input.goal)}`,
        taskId: input.session.taskId,
        invalidatedBy: ["workspace.changed"],
        transformation: "learning-from-run",
      }),
    );
  }

  return { candidates, promoted, skipped };
}

export interface ExperienceJudgementInput {
  readonly session: KernelSession;
  readonly firewall: import("@keystone/kernel").ExperienceFirewall;
  /** Entries the run was given, with the reason they were selected. */
  readonly used: readonly { entry: ExperienceEntry; reason: string }[];
  readonly proven: boolean;
  readonly changedPaths: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
}

export interface ExperienceJudgement {
  readonly evaluations: readonly ExperienceEvaluation[];
  readonly demoted: readonly { entryId: string; reason: string }[];
  readonly notes: readonly string[];
}

/**
 * Judge how the entries a run used actually behaved.
 *
 * Task evidence describes the run, not the causal effect of an individual
 * entry. Without an entry-attributed observation or a controlled comparison,
 * neither success nor failure establishes transfer (PRD LE-03, 13.2).
 */
export async function judgeExperienceUse(
  input: ExperienceJudgementInput,
): Promise<ExperienceJudgement> {
  bindLearningEvents(input.firewall, input.session);
  const evaluations: ExperienceEvaluation[] = [];
  const notes: string[] = [];

  const judgeEvidenceIds = input.evidence
    .filter((record) => record.status === "valid")
    .map((record) => record.evidenceId);

  for (const usage of input.used) {
    const entry = usage.entry;
    const scopeTouched = input.changedPaths.some((path) =>
      entry.applicability.paths.length === 0
        ? true
        : entry.applicability.paths.some(
            (scope) => path === scope || path.startsWith(`${scope}/`),
          ),
    );

    let detail: string;
    if (!scopeTouched) {
      detail =
        "the run changed nothing inside the entry's applicability, so this usage says nothing about the entry";
    } else {
      detail = `the entry was in context and its scope was modified; the task ${input.proven ? "reached proven" : "did not reach proven"}, but no entry-attributed causal evidence or control run is available`;
    }
    notes.push(`${entry.entryId}: ${detail}`);

    const evaluation = await input.firewall.recordEvaluation({
      entryId: entry.entryId,
      taskId: input.session.taskId,
      used: true,
      outcome: "not_evaluable",
      judgeEvidenceIds,
      detail,
    });
    evaluations.push(evaluation);
  }

  return { evaluations, demoted: [], notes };
}

function bindLearningEvents(firewall: ExperienceFirewall, session: KernelSession): void {
  firewall.bindCommit(async (event) => {
    switch (event.type) {
      case "experience.candidate_created": return session.recordExperienceCandidate(event.value);
      case "experience.promoted": return session.recordExperiencePromotion(event.value);
      case "experience.evaluated": return session.recordExperienceEvaluation(event.value);
      case "experience.demoted": return session.recordExperienceDemotion(event.value);
    }
  });
}

/** Project facts that are worth re-checking after a run touched the workspace. */
export function factsToInvalidate(
  facts: readonly ProjectFact[],
  changedPaths: readonly string[],
): readonly string[] {
  if (changedPaths.length === 0) return [];
  return facts
    .filter((fact) => fact.status === "active")
    .filter((fact) =>
      fact.subjects.length === 0
        ? false
        : fact.subjects.some((subject) =>
            changedPaths.some((path) => path === subject || path.startsWith(`${subject.replace(/\/+$/, "")}/`)),
          ),
    )
    .map((fact) => fact.factId);
}
