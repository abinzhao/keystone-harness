/**
 * KeystoneRuntime — the composition root.
 *
 * This is where the two loops meet:
 *
 *  - The **Builder Loop** plans and acts: build a Context Plan, ask the model for
 *    proposals, get them authorised, run the tools.
 *  - The **Assurance Loop** decides: whether to ask the user, whether the budget
 *    allows another attempt, whether the contract is satisfied, what the run
 *    learned, and what the delivered proof says.
 *
 * The runtime is deliberately the only place that holds both. Everything it does
 * to authoritative state goes through `KernelSession`, so a task's history is
 * reproducible even if this file changes.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  defaultEnvelope,
  ExperienceFirewall,
  KernelSession,
  projectIdForWorkspace,
  ProjectFactStore,
  type ContractPatch,
  type ContractProposer,
  type EvaluationResult,
  type KeystonePaths,
} from "@keystone/kernel";
import {
  compileContract,
  detectProjectProfile,
  resolveEngineeringAction,
  scanWorkspace,
} from "@keystone/pack-engineering";
import {
  buildActionPrompt,
  ModelRouter,
  parseActionEnvelope,
  toActionProposals,
  type ModelAdapter,
  type ModelRole,
} from "@keystone/models";
import {
  derivedIdBody,
  newId,
  nowIso,
  type ActionProposal,
  type AutonomyEnvelope,
  type Budget,
  type EvidenceLevel,
  type ExperienceEntry,
  type InterventionRequest,
  type OutcomeContract,
  type ProjectProfile,
  type ProofPackage,
  type TaskId,
  type TaskStatus,
  type UserDecision,
  type WorkspaceSnapshot,
} from "@keystone/schemas";
import { builtinTools, type Tool } from "@keystone/tools";
import { builtinVerifiers, type Verifier } from "@keystone/verifiers";

import {
  budgetStateFrom,
  contextPressure,
  evaluateBudget,
  nextStepTokenBudget,
} from "./assurance/budget.ts";
import {
  buildInterventionRequest,
  interventionForDenial,
} from "./assurance/intervention.ts";
import { planContext, type FileCandidate } from "./context/planner.ts";
import { createIsolatedWorkspace } from "./isolation.ts";
import { factsToInvalidate, judgeExperienceUse, learnFromRun } from "./learning.ts";
import { evaluateDegradation, modeCapabilities, type RunMode } from "./modes.ts";
import { runVerification, type VerificationOutcome } from "./verification.ts";
import { WorkspaceWriteAdmission } from "./workspace-lock.ts";

export interface RuntimeOptions {
  readonly paths: KeystonePaths;
  readonly models: readonly ModelAdapter[];
  readonly routes?: Partial<Record<ModelRole, readonly string[]>>;
  readonly tools?: readonly Tool<never>[];
  readonly verifiers?: readonly Verifier[];
  /**
   * Scenario pack that drafts the Outcome Contract. Defaults to the engineering
   * `compileContract`; a non-engineering vertical (e.g. localization) injects its
   * own proposer so its required conditions target extension-owned verifiers by
   * id (ADR-0006). The kernel only folds whatever this returns into state.
   */
  readonly contractProposer?: ContractProposer;
  readonly mode?: RunMode;
  readonly actorId?: string;
}

export interface ProjectAttachment {
  readonly projectId: string;
  readonly rootPath: string;
  readonly profile: ProjectProfile;
  readonly snapshot: WorkspaceSnapshot;
  readonly facts: ProjectFactStore;
  /** Promoted experience for this project, read through the Experience Firewall. */
  readonly firewall: ExperienceFirewall;
}

/** What the run learned, and what it did with what it was given. */
export interface RunLearning {
  readonly usedEntries: readonly { entryId: string; reason: string }[];
  readonly candidates: readonly { candidateId: string; statement: string }[];
  readonly promoted: readonly { entryId: string; statement: string }[];
  readonly skipped: readonly { statement: string; reason: string }[];
  readonly evaluations: readonly { entryId: string; outcome: string; detail: string }[];
  readonly demoted: readonly { entryId: string; reason: string }[];
  readonly invalidatedFacts: readonly string[];
}

export interface TaskReference {
  readonly kind: "file" | "directory" | "issue" | "log" | "url" | "text";
  readonly value: string;
}

export interface RunTaskOptions {
  readonly workspacePath: string;
  readonly request: string;
  readonly references?: readonly TaskReference[];
  readonly autonomy?: AutonomyEnvelope;
  readonly budget?: Budget;
  readonly maxSteps?: number;
  readonly tokenBudgetPerStep?: number;
  /**
   * Called when the runtime needs a human decision. Returning `undefined` leaves
   * the task waiting rather than guessing — the correct behaviour for a
   * non-interactive caller.
   */
  readonly onIntervention?: (request: InterventionRequest) => Promise<UserDecision | undefined>;
  /** Accept an `awaiting_approval` contract without asking (CI and tests). */
  readonly acceptContractAutomatically?: boolean;
  /**
   * Called as soon as the task exists.
   *
   * A host that must answer the caller before the run finishes (an HTTP server, an
   * editor command) needs the id while the run is still in flight; without this
   * the only way to learn it would be to guess or to block (PRD ST-03).
   */
  readonly onTaskCreated?: (taskId: TaskId) => void;
  /**
   * Polled between steps for a control request from the user (PRD 7.1, OT-03,
   * UI-05).
   *
   * A running task owns its kernel session, and a second writer on the same
   * ledger would fork the event hash chain. So pause, stop and revision are
   * *requests* the run applies itself through the session it already holds,
   * never state another writer changes behind its back (ADR-0003).
   *
   * Return `undefined` (or omit the callback entirely) to run unattended.
   */
  readonly control?: () => Promise<RunControlRequest | undefined>;
}

/**
 * What the user asked a running task to do.
 *
 * Every variant is applied by the run loop with its own session; `revise`
 * carries an already-built patch because the loop, not the caller, is the only
 * party that sees the contract it will be compared against.
 */
export type RunControlRequest =
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "revise"; readonly patch: ContractPatch; readonly reason: string };

export interface RunDegradation {
  readonly mode: RunMode;
  readonly reason: string;
  readonly capabilitiesLost: readonly string[];
  readonly evidenceImpact: string;
}

export interface RunTaskResult {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
  readonly mode: RunMode;
  readonly steps: number;
  readonly changedPaths: readonly string[];
  readonly contract: OutcomeContract;
  readonly interventions: readonly InterventionRequest[];
  readonly verification: VerificationOutcome;
  readonly proof?: ProofPackage;
  /** What this run learned, and how it treated the experience it was given. */
  readonly learning: RunLearning;
  /** Set when the run lost a capability part-way through (PRD EX-05). */
  readonly degraded?: RunDegradation;
  /** Set in isolated mode: where the change actually lives. */
  readonly isolatedWorkspace?: string;
  /** Why the task stopped when it did not reach `proven`. */
  readonly reasons: readonly string[];
  readonly summary: string;
}

const DEFAULT_STEP_TOKEN_BUDGET = 24_000;
const MAX_FILES_PER_PLAN = 40;
const MAX_FILE_BYTES = 48_000;

export class KeystoneRuntime {
  private readonly paths: KeystonePaths;
  private readonly router = new ModelRouter();
  private readonly tools: readonly Tool<never>[];
  private readonly verifiers: readonly Verifier[];
  private readonly contractProposer: ContractProposer;
  private readonly mode: RunMode;
  private readonly actorId: string;
  /** Process-local admission: at most one standard writer per canonical workspace. */
  private readonly writeAdmission = new WorkspaceWriteAdmission();

  private constructor(options: RuntimeOptions) {
    this.paths = options.paths;
    this.tools = options.tools ?? builtinTools();
    this.verifiers = options.verifiers ?? builtinVerifiers();
    // Engineering remains the default vertical; a non-engineering pack injects its own.
    this.contractProposer = options.contractProposer ?? compileContract;
    this.mode = options.mode ?? "standard";
    this.actorId = options.actorId ?? "keystone";

    for (const adapter of options.models) this.router.register(adapter);
    for (const [role, ids] of Object.entries(options.routes ?? {})) {
      if (ids !== undefined) this.router.setRoute(role as ModelRole, ids);
    }
  }

  static async create(options: RuntimeOptions): Promise<KeystoneRuntime> {
    return new KeystoneRuntime(options);
  }

  /** Where this runtime's model traffic would go, for the user to inspect. */
  describeEgress(): ReturnType<ModelRouter["describeEgress"]> {
    return this.router.describeEgress();
  }

  /**
   * Attach a Git workspace: profile it, snapshot it, and record what could not be
   * identified. Unrecognised commands are stored as `unrecognized`, never guessed
   * (PRD PI-01).
   */
  async attachProject(workspacePath: string): Promise<ProjectAttachment> {
    const projectId = await projectIdForWorkspace(workspacePath);
    const profile = await detectProjectProfile(workspacePath, projectId as never);
    const snapshot = await scanWorkspace(workspacePath);

    await mkdir(this.paths.projectDir(projectId as never), { recursive: true });
    await writeFile(
      this.paths.projectFile(projectId as never),
      `${JSON.stringify(profile, null, 2)}\n`,
    );

    const facts = new ProjectFactStore(this.paths, projectId as never);
    await facts.load();
    await seedFacts(facts, projectId, profile, snapshot);

    const firewall = new ExperienceFirewall(this.paths, projectId);
    await firewall.load();

    return { projectId, rootPath: workspacePath, profile, snapshot, facts, firewall };
  }

  /**
   * Admit a run, then execute it.
   *
   * Admission happens before any project attachment or ledger write: a standard
   * run that cannot take the workspace writer lock is refused outright, with no
   * orphaned task left behind. The lock is released in `finally`, so a run that
   * finishes, fails, or is stopped by the user always frees the workspace.
   */
  async runTask(options: RunTaskOptions): Promise<RunTaskResult> {
    const projectId = await projectIdForWorkspace(options.workspacePath);
    const releaseWrite = this.acquireWorkspaceWrite(projectId);
    try {
      return await this.executeTask(options, projectId);
    } finally {
      releaseWrite();
    }
  }

  /**
   * Take the workspace writer lock for standard runs only.
   *
   * Isolated runs edit a throwaway worktree and replay/minimal do no new work, so
   * they neither hold nor wait on this lock (see ./workspace-lock.ts). A second
   * standard run on the same canonical workspace is refused here, before any side
   * effect, and directed to isolated mode.
   */
  private acquireWorkspaceWrite(projectId: string): () => void {
    if (this.mode !== "standard") return () => undefined;
    return this.writeAdmission.tryAcquire(projectId, nowIso());
  }

  private async executeTask(
    options: RunTaskOptions,
    projectId: string,
  ): Promise<RunTaskResult> {
    const attachment = await this.attachProject(options.workspacePath);
    const capabilities = modeCapabilities(this.mode);
    // Isolated mode works in a throwaway worktree, so a failed attempt cannot
    // damage the user's working copy (PRD EX-05).
    const isolatedWorkspace =
      this.mode === "isolated" ? await createIsolatedWorkspace(options.workspacePath) : undefined;
    const workPath = isolatedWorkspace ?? options.workspacePath;

    const session = await KernelSession.create({
      paths: this.paths,
      projectId: attachment.projectId as never,
      request: options.request,
      references: options.references,
      actorId: this.actorId,
      // The wired scenario pack drafts the Outcome Contract and resolves which
      // capability a proposal needs; the kernel only folds the result into
      // authoritative state (ADR-0006, M1).
      proposeContract: this.contractProposer,
      resolveAction: resolveEngineeringAction,
    });
    // Name the holder so a later refusal can point at the task that is running.
    this.writeAdmission.noteHolder(projectId, session.taskId);
    options.onTaskCreated?.(session.taskId);

    const interventions: InterventionRequest[] = [];
    const changedPaths = new Set<string>();
    const readPaths = new Set<string>();
    const taskShape = inferTaskShape(options.request);
    const toolVersions = this.tools.map((tool) => ({
      id: tool.descriptor.id,
      version: tool.descriptor.version,
    }));
    let verification: VerificationOutcome = emptyVerification();
    let reasons: string[] = [];
    let steps = 0;

    const budget: Budget = options.budget ?? {
      maxTokens: 300_000,
      maxWallClockMs: 7_200_000,
      maxRetries: 3,
    };

    await session.submit();
    const compiled = await session.compile({
      profile: attachment.profile,
      // Minimal and replay deliberately ignore project cognition: their purpose
      // is to reproduce a result from basic facts, not to lean on what the
      // harness has learned about this repository.
      facts: capabilities.usesProjectCognition ? attachment.facts.all() : [],
      autonomy: options.autonomy ?? defaultEnvelope(attachment.projectId as never, budget),
      budget,
    });

    /**
     * The contract in force for the current step.
     *
     * A revision replaces this binding rather than editing anything: the loops
     * below read `contract`, so a mid-run revision takes effect on the next step
     * while every event already written keeps its own contract version
     * (PRD OT-03).
     */
    let contract = compiled.contract;

    if (
      contract.status === "awaiting_approval" &&
      options.acceptContractAutomatically !== true
    ) {
      // The contract has unresolved questions. Returning with the questions is
      // the honest outcome: the alternative is to guess and do the wrong task.
      return {
        taskId: session.taskId,
        status: session.state().status,
        mode: this.mode,
        steps: 0,
        changedPaths: [],
        contract,
        interventions,
        verification,
        learning: emptyLearning(),
        ...(isolatedWorkspace === undefined ? {} : { isolatedWorkspace }),
        reasons: compiled.questions.map((question) => question.question),
        summary:
          `the contract needs confirmation before work starts: ` +
          compiled.questions.map((question) => question.question).join("; "),
      };
    }

    // Experience is selected once, against the compiled contract, so the same
    // entries are offered on every repair attempt and the evaluation at the end
    // can name exactly what the run was told (PRD LE-03, CX-02).
    const selectedExperience = capabilities.usesExperience
      ? attachment.firewall.selectForContext({
          taskShape,
          paths: contract.scope.include.map((entry) => entry.pattern),
          toolVersions,
        })
      : [];

    await session.start();
    await session.checkpoint("stage_boundary");

    let fingerprint = attachment.snapshot.fingerprint;
    let snapshotId: string = attachment.snapshot.snapshotId;
    // Paths that were dirty/untracked at onboarding: a git.commit must refuse to
    // sweep them into the agent commit (PRD PI-01 line 312; ADR-0007, B1).
    const baselineDirtyPaths = new Set(
      attachment.snapshot.entries.filter((entry) => entry.gitStatus !== "").map((entry) => entry.path),
    );
    let lastProgressKey = "";
    let noProgressStreak = 0;
    let lastFailures: string[] = [];
    /**
     * Set when the run lost a capability mid-flight. The loops consult it so a
     * degraded run stops *working* but still *verifies*, which is the only way an
     * already-applied change can still be proven (PRD EX-05).
     */
    let degraded: RunDegradation | undefined;
    const maxSteps = options.maxSteps ?? 12;
    // Bounded repair: an unbounded "try again" loop is how a harness burns a
    // user's budget without ever reporting that it is stuck (PRD VF-03).
    const maxRepairAttempts = Math.max(1, Math.min(3, budget.maxRetries));
    let evaluation: EvaluationResult | undefined;
    /**
     * Set when the user asked the run to pause or stop. It skips the remaining
     * work *including verification*: continuing to verify after a stop request
     * would keep spending budget and, worse, would make "stopped" mean "stopped
     * after one more check".
     */
    let stopped = false;

    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      // Minimal, replay and any degraded run stop doing new work here: the run
      // continues only so the contract can be verified against whatever the
      // workspace already contains.
      if (!capabilities.usesModel || degraded !== undefined) break;

      for (let step = 1; step <= maxSteps; step += 1) {
        steps = step;
        const state = session.state();
        if (
          state.status === "needs_attention" ||
          state.status === "paused" ||
          state.status === "stopped"
        ) {
          reasons.push(`the task stopped at status "${state.status}"`);
          break;
        }

        // Apply anything the user asked for before spending another step on
        // work that is about to be redefined or abandoned (PRD UI-05).
        const control = await this.pollControl(options, session);
        if (control !== undefined) {
          if (control.revised !== undefined) {
            contract = control.revised;
            reasons.push(`the contract was revised to v${contract.version}: ${control.reason}`);
          } else {
            stopped = true;
            reasons.push(control.reason);
            break;
          }
        }

        const verdict = evaluateBudget(budgetStateFrom(state.budgetUsed, budget));
        if (verdict.exhausted) {
          const request = buildInterventionRequest({
            taskId: session.taskId,
            branchId: session.branchId,
            trigger: "budget_exhausted",
            contract,
            question: "The task budget is exhausted. Continue with more budget?",
            whyUserNeeded: verdict.reasons.join("; "),
            ifIgnoredImpact: "the task will exit with whatever is currently verified",
            recommended: {
              label: "Raise the budget",
              rationale: "the current attempt is out of resources",
            },
            alternatives: [
              {
                label: "Exit with what is verified so far",
                effectOnScope: "no change",
                effectOnBudget: "stops spending immediately",
                widensEnvelope: false,
              },
            ],
            contextSummary: verdict.reasons.join("; "),
          });
          interventions.push(request);
          const decision = await this.ask(options, request);
          if (decision === undefined || decision.decision !== "allow") {
            reasons.push(`budget exhausted: ${verdict.reasons.join("; ")}`);
            break;
          }
        }

        const plan = await this.buildPlan(
          session,
          contract,
          fingerprint,
          snapshotId,
          workPath,
          options,
          state,
          verdict,
          selectedExperience.map((selection) => selection.entry),
        );
        await session.recordContextPlan(plan.plan);
        for (const item of plan.plan.items) {
          if (item.kind === "file") readPaths.add(item.ref);
        }

        let envelope;
        try {
          envelope = await this.askBuilder(
            contract,
            plan.rendered,
            lastFailures,
            attempt,
          );
        } catch (error) {
          // The model is gone. Do not fake progress and do not silently weaken
          // the promise: record the degradation, stop *working*, and continue
          // into verification so an already-applied change can still be proven
          // or honestly reported as unproven (PRD 10, EX-05).
          const detail = error instanceof Error ? error.message : String(error);
          const decision = evaluateDegradation(
            {
              from: this.mode,
              to: "minimal",
              reason: `the builder model became unavailable: ${detail}`,
              lostCapabilities: ["model.invoke"],
            },
            { requiredEvidenceLevel: highestRequiredLevel(contract) },
          );
          degraded = {
            mode: "minimal",
            reason: `the builder model became unavailable: ${detail}`,
            capabilitiesLost: ["model.invoke"],
            evidenceImpact: decision.evidenceImpact ?? decision.explanation,
          };
          await session.applyDegradation({
            mode: "minimal",
            reason: degraded.reason,
            capabilitiesLost: degraded.capabilitiesLost,
            evidenceImpact: degraded.evidenceImpact,
          });
          reasons.push(degraded.reason);
          if (!decision.allowed) reasons.push(decision.explanation);
          break;
        }

        if (envelope.needs_user !== undefined) {
          const request = buildInterventionRequest({
            taskId: session.taskId,
            branchId: session.branchId,
            trigger: "ambiguity",
            contract,
            question: envelope.needs_user.question,
            whyUserNeeded: envelope.needs_user.why,
            ifIgnoredImpact: "the task cannot proceed without this decision",
            recommended: {
              label: envelope.needs_user.options[0] ?? "Provide the missing detail",
              rationale: "the model cannot determine this from the project alone",
            },
            alternatives: envelope.needs_user.options.slice(1).map((option) => ({
              label: option,
              effectOnScope: "depends on the choice",
              effectOnBudget: "depends on the choice",
              widensEnvelope: false,
            })),
            contextSummary: envelope.summary,
          });
          interventions.push(request);
          await session.requestIntervention(request);
          const decision = await this.ask(options, request);
          if (decision === undefined) {
            reasons.push("waiting for a user decision");
            break;
          }
          await session.decide(request, decision);
          continue;
        }

        if (
          envelope.actions.length === 0 ||
          envelope.actions.some((action) => action.intent === "finish")
        ) {
          break;
        }

        const builder = this.router.route("builder")[0];
        const proposals = toActionProposals(
          envelope,
          {
            taskId: session.taskId,
            branchId: session.branchId,
            stepId: plan.plan.stepId,
            modelRef: {
              id: builder?.descriptor.id ?? "unknown",
              provider: builder?.descriptor.provider ?? "unknown",
              modelName: builder?.descriptor.modelName ?? "unknown",
            },
          },
          { newId },
        );

        // One action per step. Batching would multiply the blast radius of a
        // single bad proposal, and the checkpoint granularity is per step.
        const proposal = proposals[0];
        if (proposal === undefined) break;

        const outcome = await this.executeProposal(
          session,
          proposal,
          contract,
          workPath,
          baselineDirtyPaths,
        );
        if (outcome.intervention !== undefined) {
          interventions.push(outcome.intervention);
          const decision = await this.ask(options, outcome.intervention);
          if (decision === undefined) {
            reasons.push("waiting for a user decision");
            break;
          }
          await session.decide(outcome.intervention, decision);
          continue;
        }
        if (outcome.stopReason !== undefined) {
          reasons.push(outcome.stopReason);
          break;
        }

        for (const path of outcome.changedPaths) changedPaths.add(path);

        if (outcome.changedPaths.length > 0) {
          // Writes invalidate earlier evidence: the old fingerprint no longer
          // describes the workspace (PRD VF-06).
          const snapshot = await scanWorkspace(workPath);
          await session.invalidateStaleEvidence({
            previousFingerprint: fingerprint,
            currentFingerprint: snapshot.fingerprint,
            changedPaths: outcome.changedPaths,
          });
          fingerprint = snapshot.fingerprint;
          snapshotId = snapshot.snapshotId;
        }

        const progressKey = `${[...changedPaths].sort().join(",")}`;
        noProgressStreak = progressKey === lastProgressKey ? noProgressStreak + 1 : 0;
        lastProgressKey = progressKey;
        if (noProgressStreak >= 2) {
          reasons.push(
            "two consecutive attempts produced no new change; stopping to avoid burning budget",
          );
          break;
        }
      }

      // A control request can also arrive while the run was waiting on a human or
      // between the last step and verification, so it is polled once more here:
      // a request the user sent must not be dropped just because the run happened
      // to stop working first.
      if (!stopped) {
        const late = await this.pollControl(options, session);
        if (late !== undefined) {
          if (late.revised !== undefined) {
            contract = late.revised;
            reasons.push(`the contract was revised to v${contract.version}: ${late.reason}`);
          } else {
            stopped = true;
            reasons.push(late.reason);
          }
        }
      }

      // A pause or stop the user asked for ends the attempt here: verifying a
      // task the user just stopped would spend budget and misreport the status.
      if (stopped) break;

      await session.checkpoint("pre_verification", {
        verification: { workspaceFingerprint: fingerprint as never },
      });

      verification = await runVerification({
        rootPath: workPath,
        paths: this.paths,
        session,
        contract,
        changedPaths: [...changedPaths],
        verifiers: this.verifiers,
        workspaceSnapshotId: snapshotId,
        workspaceFingerprint: fingerprint,
      });

      // Ask once, on the first attempt: repeating the same question on every
      // repair attempt is noise, and the answer cannot change by itself.
      if (attempt === 1 && verification.blocked.length > 0) {
        const blockedDetail = verification.blocked
          .map((entry) => `${entry.conditionId}: ${entry.detail}`)
          .join("; ");
        const request = buildInterventionRequest({
          taskId: session.taskId,
          branchId: session.branchId,
          trigger: "undecidable",
          contract,
          question:
            "Some completion conditions could not be evaluated. How should Keystone proceed?",
          whyUserNeeded: blockedDetail,
          ifIgnoredImpact:
            "the task cannot be proven; it will exit with the unverified conditions listed",
          recommended: {
            label: "Provide or agree on the missing verification command",
            rationale: "a condition without a runnable check cannot be proven",
          },
          contextSummary: blockedDetail,
        });
        interventions.push(request);
        await session.requestIntervention(request).catch(() => {
          // If the task is already in a state that cannot be interrupted, the
          // request is still reported; the state change is what failed.
        });
        const decision = await this.ask(options, request);
        if (decision !== undefined) await session.decide(request, decision).catch(() => undefined);
      }

      evaluation = await session.evaluateProof({
        changedPaths: [...changedPaths],
        workspaceFingerprint: fingerprint,
        verifierFailures: verification.failed,
      });

      if (evaluation.decision.outcome === "proven") break;

      reasons.push(...evaluation.decision.reasons.map((reason) => reason.detail));
      lastFailures = [
        ...verification.failed.map((entry) => `${entry.conditionId} failed: ${entry.detail}`),
        ...verification.blocked.map(
          (entry) => `${entry.conditionId} could not be checked: ${entry.detail}`,
        ),
      ];

      // Repair continues only while the kernel says a path remains. If the
      // verdict moved the task to `exited_gracefully`, there is nothing to retry.
      if (session.state().status !== "auto_repairing") break;
      if (attempt >= maxRepairAttempts) break;

      await session.beginRepair({
        attempt,
        rootCause:
          lastFailures.join("; ").slice(0, 500) || "completion conditions are not satisfied",
        changedPaths: [...changedPaths],
        madeProgress: changedPaths.size > 0,
      });
    }

    const proven = evaluation?.decision.outcome === "proven";

    // A returned run must not look like a running one. If the loops ended without
    // a verdict and the task is still in an active status, close it out honestly
    // and name what is unresolved (PRD 9.1).
    const finalStatus = session.state().status;
    if (
      !proven &&
      (finalStatus === "executing" ||
        finalStatus === "verifying" ||
        finalStatus === "auto_repairing")
    ) {
      const unsatisfied = (evaluation?.decision.conditionResults ?? [])
        .filter((result) => result.required && !result.satisfied)
        .map((result) => result.conditionId);
      const exhausted = evaluateBudget(budgetStateFrom(session.state().budgetUsed, budget)).exhausted;
      const exitCondition =
        contract.exitConditions.find((entry) =>
          exhausted ? entry.kind === "budget_exhausted" : entry.kind === "no_progress",
        ) ?? contract.exitConditions[0];
      if (exitCondition !== undefined) {
        await session
          .exitGracefully({
            exitId: exitCondition.exitId,
            description: exitCondition.description,
            unsatisfiedConditionIds: unsatisfied,
          })
          .catch(() => undefined);
      }
    }

    // Judge what the run was *given* before deciding what it *teaches*: an entry
    // that was in context while the run failed has to leave the reusable set
    // before the next task reads it (PRD LE-03, LE-04).
    const judgement =
      selectedExperience.length > 0
        ? await judgeExperienceUse({
            session,
            firewall: attachment.firewall,
            used: selectedExperience,
            proven,
            changedPaths: [...changedPaths],
            evidence: await session.evidence(),
          })
        : { evaluations: [], demoted: [], notes: [] };

    const learned = await learnFromRun({
      session,
      firewall: attachment.firewall,
      projectId: attachment.projectId,
      taskShape,
      goal: contract.goal,
      readPaths: [...readPaths],
      changedPaths: [...changedPaths],
      proven,
      evidence: await session.evidence(),
      languages: attachment.profile.languages,
      packageManagers:
        attachment.profile.packageManager === undefined
          ? []
          : [attachment.profile.packageManager],
      toolVersions,
    });

    // Facts about files the run changed are no longer reliable; marking them
    // stale is what stops the next task from being told something that stopped
    // being true (PRD PI-02, PI-04).
    const staleFactIds = factsToInvalidate(attachment.facts.all(), [...changedPaths]);
    if (staleFactIds.length > 0) {
      await attachment.facts.markStaleForSubjects(
        [...changedPaths],
        "the workspace changed during a task",
      );
    }

    const learning: RunLearning = {
      usedEntries: selectedExperience.map((selection) => ({
        entryId: selection.entry.entryId,
        reason: selection.reason,
      })),
      candidates: learned.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        statement: candidate.statement,
      })),
      promoted: learned.promoted.map((entry) => ({
        entryId: entry.entryId,
        statement: entry.statement,
      })),
      skipped: [...learned.skipped],
      evaluations: judgement.evaluations.map((evaluation) => ({
        entryId: evaluation.entryId,
        outcome: evaluation.outcome,
        detail: evaluation.detail,
      })),
      demoted: [...judgement.demoted],
      invalidatedFacts: [...new Set(staleFactIds)],
    };

    const proof = await session.exportProof({
      changedPaths: [...changedPaths],
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        workspaceFingerprint: fingerprint,
      },
    });

    await session
      .checkpoint("stage_boundary", {
        verification: { workspaceFingerprint: fingerprint as never },
      })
      .catch(() => undefined);

    return {
      taskId: session.taskId,
      status: session.state().status,
      mode: this.mode,
      steps,
      changedPaths: [...changedPaths].sort(),
      contract,
      interventions,
      verification,
      proof,
      learning,
      ...(degraded === undefined ? {} : { degraded }),
      ...(isolatedWorkspace === undefined ? {} : { isolatedWorkspace }),
      reasons: [...new Set(reasons)],
      summary: proof.summary,
    };
  }

  private async ask(
    options: RunTaskOptions,
    request: InterventionRequest,
  ): Promise<UserDecision | undefined> {
    if (options.onIntervention === undefined) return undefined;
    return options.onIntervention(request);
  }

  /**
   * Apply a control request the user sent while the run was in flight.
   *
   * This run holds the kernel session, so it is the only writer: pause, stop and
   * revision are applied here rather than by a second session, which would fork
   * the ledger's hash chain (ADR-0003). `revise` hands the new contract back to
   * the loop; pause and stop end the loops.
   */
  private async pollControl(
    options: RunTaskOptions,
    session: KernelSession,
  ): Promise<{ readonly revised?: OutcomeContract; readonly reason: string } | undefined> {
    const request = await options.control?.();
    if (request === undefined) return undefined;

    if (request.kind === "revise") {
      const result = await session.revise(request.patch, request.reason);
      return { revised: result.contract, reason: request.reason };
    }

    if (request.kind === "pause") {
      try {
        await session.pause(request.reason, true);
        return { reason: `paused: ${request.reason}` };
      } catch {
        // A pause is only legal from an active status. If it does not apply, the
        // run cannot keep working either, so it stops instead of continuing
        // after a request to stop.
      }
    }
    await session.stop(request.reason, true);
    return { reason: `stopped: ${request.reason}` };
  }

  private async buildPlan(
    session: KernelSession,
    contract: OutcomeContract,
    fingerprint: string,
    snapshotId: string,
    workPath: string,
    options: RunTaskOptions,
    state: ReturnType<KernelSession["state"]>,
    verdict: ReturnType<typeof evaluateBudget>,
    experiences: readonly ExperienceEntry[],
  ): Promise<{
    plan: Awaited<ReturnType<typeof planContext>>["plan"];
    rendered: string;
    stepId: string;
  }> {
    const pressure = contextPressure(verdict);
    const files = await collectScopeFiles(workPath, contract, { limit: MAX_FILES_PER_PLAN });

    const builder = this.router.route("builder")[0];
    const result = planContext({
      taskId: session.taskId,
      branchId: session.branchId,
      stepId: `step.${state.stage}.${state.seq}`,
      stepGoal: pressure.shrinkContext
        ? `continue working on: ${contract.goal} (reduced context: ${pressure.explanation})`
        : `continue working on: ${contract.goal}`,
      contract,
      tokenBudget:
        options.tokenBudgetPerStep ??
        nextStepTokenBudget(budgetStateFrom(state.budgetUsed, contract.budget), {
          maxStepTokens: DEFAULT_STEP_TOKEN_BUDGET,
        }),
      modelTarget: builder?.descriptor.id ?? "unknown",
      files,
      // Facts are already part of the contract when project cognition is on; the
      // planner takes them separately so minimal mode can leave them out.
      facts: [],
      experiences,
      retrieverProvenance: {
        provenanceId: deterministicId("prov", fingerprint) as never,
        sourceKind: "repository",
        trustLevel: "observed",
        locator: workPath,
        applicableSnapshot: snapshotId as never,
        derivedFrom: [],
        invalidatedBy: ["workspace.changed"],
        observedAt: nowIso(),
        transformation: "scope-expansion",
      },
    });

    return { plan: result.plan, rendered: result.rendered, stepId: result.plan.stepId };
  }

  private async askBuilder(
    contract: OutcomeContract,
    contextSection: string,
    previousFailures: readonly string[],
    attempt: number,
  ): Promise<ReturnType<typeof parseActionEnvelope>> {
    const prompt = buildActionPrompt({
      goal: contract.goal,
      stepId: "step.current",
      stepGoal: "make progress on the contract without exceeding scope",
      invariants: contract.invariants.map((invariant) => invariant.description),
      writeScope: contract.scope.include.map((entry) => entry.pattern),
      allowedCommands: contract.autonomy.allowedCommands,
      availableTools: this.tools.map((tool) => tool.descriptor),
      contextSection,
      // A repair attempt must be told what failed, otherwise it repeats the
      // change that already did not work.
      observations: [...previousFailures],
      remainingBudget: {
        tokens: Math.max(0, contract.budget.maxTokens),
        retries: Math.max(0, contract.budget.maxRetries),
      },
      attempt,
    });

    // The builder speaks the text-envelope protocol: the tools are listed in the
    // prompt above (`availableTools`) and the model returns an action envelope as
    // JSON text. Native tool calling is not wired up, so `tools` must stay empty —
    // a non-empty array would make the OpenAI-compatible adapter refuse the call
    // before the network (ModelToolsUnsupportedError) rather than send the tools.
    const outcome = await this.router.complete("builder", {
      messages: [{ role: "user", content: prompt }],
      tools: [],
      jsonMode: true,
    });

    return parseActionEnvelope(outcome.response.text, outcome.modelId);
  }

  private async executeProposal(
    session: KernelSession,
    proposal: ActionProposal,
    contract: OutcomeContract,
    workPath: string,
    baselineDirtyPaths: ReadonlySet<string>,
  ): Promise<{
    changedPaths: readonly string[];
    stopReason?: string;
    intervention?: InterventionRequest;
  }> {
    const authorization = await session.authorize(proposal);
    if (!authorization.ok) {
      const intervention = interventionForDenial({
        taskId: session.taskId,
        branchId: session.branchId,
        contract,
        denial: authorization.denial,
        refusedCapabilities: proposal.requestedCapabilities,
        refusedPaths:
          proposal.expectedEffects.length > 0
            ? proposal.expectedEffects.map((effect) => effect.target)
            : Object.values(proposal.parameters)
                .filter((value): value is string => typeof value === "string")
                .slice(0, 4),
        contextSummary: proposal.rationale,
      });
      if (intervention !== undefined) return { changedPaths: [], intervention };
      return {
        changedPaths: [],
        stopReason: `the action was refused: ${authorization.denial.detail}`,
      };
    }

    const tool = this.tools.find((candidate) => candidate.descriptor.id === proposal.tool.id);
    if (tool === undefined) {
      await session.recordExecution({
        proposalId: proposal.proposalId,
        leaseId: authorization.lease.leaseId,
        status: "failed",
        durationMs: 0,
        errorCode: "tool_unavailable",
      });
      return {
        changedPaths: [],
        stopReason: `the model proposed tool "${proposal.tool.id}", which is not available in this mode`,
      };
    }

    const started = Date.now();
    const result = await tool.run(proposal.parameters as never, {
      rootPath: workPath,
      taskId: session.taskId,
      branchId: session.branchId,
      paths: this.paths,
      lease: authorization.lease,
      baselineDirtyPaths,
    } as never);

    await session.recordExecution({
      proposalId: proposal.proposalId,
      leaseId: authorization.lease.leaseId,
      status: result.status,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      durationMs: result.durationMs || Date.now() - started,
      ...(result.artifactId === undefined ? {} : { artifactId: result.artifactId }),
      ...(result.outputBytes === undefined ? {} : { outputBytes: result.outputBytes }),
      changedPaths: [...result.changedPaths],
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    });

    return { changedPaths: [...result.changedPaths] };
  }
}

function emptyVerification(): VerificationOutcome {
  return { evidence: [], failed: [], blocked: [], unsupported: [], passedConditionIds: [] };
}

function emptyLearning(): RunLearning {
  return {
    usedEntries: [],
    candidates: [],
    promoted: [],
    skipped: [],
    evaluations: [],
    demoted: [],
    invalidatedFacts: [],
  };
}

/** The strictest evidence level any required condition asks for. */
function highestRequiredLevel(contract: OutcomeContract): EvidenceLevel {
  let highest: EvidenceLevel = "E0";
  const rank: Record<EvidenceLevel, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  for (const condition of contract.completionConditions) {
    if (!condition.required) continue;
    if (rank[condition.minEvidenceLevel] > rank[highest]) highest = condition.minEvidenceLevel;
  }
  return highest;
}

/**
 * Coarse task shape, used only for experience applicability matching.
 *
 * Deliberately keyword-based rather than model-based: a shape that came from the
 * model would let the model decide which of its own past lessons apply.
 */
function inferTaskShape(request: string): string {
  const text = request.toLowerCase();
  if (/(fix|bug|defect|broken|regress|修复|缺陷|报错|错误)/i.test(text)) return "bugfix";
  if (/(add|implement|feature|support|新增|实现|支持|增加)/i.test(text)) return "feature";
  if (/(refactor|restructure|clean|重构|整理)/i.test(text)) return "refactor";
  if (/(test|coverage|测试)/i.test(text)) return "test";
  if (/(doc|readme|文档)/i.test(text)) return "docs";
  return "change";
}

/**
 * A stable id derived from content.
 *
 * Deliberately not a hex slice: protocol ids use the Crockford base32 alphabet,
 * so a hex digest would be rejected by the very validator that protects the
 * ledger. `derivedIdBody` produces the right alphabet and stays reproducible, so
 * re-running a scan yields the same fact ids instead of duplicating them.
 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}_${derivedIdBody(seed)}`;
}

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".keystone"]);

/** Read the files a contract's write scope covers, bounded in count and size. */
export async function collectScopeFiles(
  rootPath: string,
  contract: OutcomeContract,
  options: { readonly limit: number },
): Promise<readonly FileCandidate[]> {
  const { globToRegExp } = await import("@keystone/kernel");
  const exactOrPrefix = contract.scope.include
    .filter((entry) => !entry.pattern.includes("*"))
    .map((entry) => entry.pattern);
  const globs = contract.scope.include
    .filter((entry) => entry.pattern.includes("*"))
    .map((entry) => globToRegExp(entry.pattern));
  const excluded = contract.scope.exclude.map((entry) => globToRegExp(entry.pattern));

  const candidates: FileCandidate[] = [];
  await walk(rootPath, rootPath, async (absolute, relativePath) => {
    if (candidates.length >= options.limit) return;
    if (excluded.some((pattern) => pattern.test(relativePath))) return;
    const matches =
      exactOrPrefix.some(
        (pattern) => relativePath === pattern || relativePath.startsWith(`${pattern}/`),
      ) || globs.some((pattern) => pattern.test(relativePath));
    if (!matches) return;

    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined || info.size > MAX_FILE_BYTES) return;
    const content = await readFile(absolute, "utf8").catch(() => undefined);
    if (content === undefined) return;

    candidates.push({
      path: relativePath,
      content,
      provenance: {
        provenanceId: deterministicId("prov", relativePath) as never,
        sourceKind: "repository",
        trustLevel: "observed",
        locator: relativePath,
        derivedFrom: [],
        invalidatedBy: [`workspace.changed:${relativePath}`],
        observedAt: nowIso(),
        transformation: "scope-expansion",
      },
      discoveredBy: "matches the contract write scope",
      relevance: 0.8,
    });
  });

  return candidates;
}

async function walk(
  rootPath: string,
  currentPath: string,
  visit: (absolute: string, relativePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(rootPath, absolute, visit);
      continue;
    }
    await visit(absolute, relative(rootPath, absolute).split("\\").join("/"));
  }
}

/**
 * Seed project facts from a scan.
 *
 * An unrecognised command becomes a fact saying it is unrecognised — recording
 * the gap is the point, not filling it with a guess (PRD PI-01 §4).
 */
async function seedFacts(
  store: ProjectFactStore,
  projectId: string,
  profile: ProjectProfile,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const observedAt = nowIso();
  const base = {
    projectId,
    derivedFrom: [],
    invalidatedBy: ["workspace.changed"],
    status: "active" as const,
    observedAt,
    updatedAt: observedAt,
    subjects: [] as readonly string[],
  };

  await store.upsert({
    ...base,
    factId: deterministicId("fact", `${projectId}:languages`),
    kind: "language",
    statement: `project languages: ${profile.languages.join(", ") || "unknown"}`,
    source: {
      provenanceId: deterministicId("prov", "languages"),
      sourceKind: "repository",
      trustLevel: "observed",
      locator: "package.json",
      derivedFrom: [],
      invalidatedBy: ["workspace.changed"],
      observedAt,
    },
  } as never);

  for (const command of profile.commands) {
    await store.upsert({
      ...base,
      factId: deterministicId("fact", `${projectId}:${command.kind}`),
      kind: "command",
      statement:
        command.status === "identified"
          ? `${command.kind} command: ${command.command ?? "unknown"}`
          : `${command.kind} command could not be identified in this project`,
      source: {
        provenanceId: deterministicId("prov", `command:${command.kind}`),
        sourceKind: "repository",
        trustLevel: "observed",
        locator: command.source ?? "package.json",
        derivedFrom: [],
        invalidatedBy: ["workspace.changed"],
        observedAt,
      },
    } as never);
  }

  await store.upsert({
    ...base,
    factId: deterministicId("fact", `${projectId}:snapshot`),
    kind: "structure",
    statement: `workspace contains ${snapshot.entryCount} tracked file(s) at commit ${snapshot.headCommit ?? "unknown"}`,
    source: {
      provenanceId: deterministicId("prov", "snapshot"),
      sourceKind: "tool",
      trustLevel: "verified",
      locator: "git ls-files",
      applicableSnapshot: snapshot.snapshotId,
      derivedFrom: [],
      invalidatedBy: ["workspace.changed"],
      observedAt,
    },
    applicableSnapshot: snapshot.snapshotId,
  } as never);
}
