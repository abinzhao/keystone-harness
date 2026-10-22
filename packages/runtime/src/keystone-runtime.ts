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
  getArtifactBytes,
  putJsonArtifact,
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
  scanProjectCognition,
} from "@keystone/pack-engineering";
import {
  buildActionPrompt,
  MODEL_ROLES,
  ModelRouter,
  parseActionEnvelope,
  toActionProposals,
  type ModelAdapter,
  type ModelRole,
  type ModelContentPart,
} from "@keystone/models";
import {
  derivedIdBody,
  arrayOf,
  canonicalJson,
  contentHash,
  defineSchema,
  lit,
  nonEmptyStr,
  newId,
  nowIso,
  objectOf,
  runBindingSchema,
  sha256Validator,
  sha256Bytes,
  userDecisionSchema,
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
  type ConfigurationSnapshot,
  type InputAttachment,
  type RunBinding,
} from "@keystone/schemas";
import { builtinTools, type Tool } from "@keystone/tools";
import { builtinVerifiers, type Verifier } from "@keystone/verifiers";
import { defaultRegistryLocation, ExtensionLifecycleService } from "@keystone/extensions";

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
import { ContextBudgetError, planContext, type FileCandidate, type PlanContextInput } from "./context/planner.ts";
import { createIsolatedWorkspace } from "./isolation.ts";
import { factsToInvalidate, judgeExperienceUse, learnFromRun } from "./learning.ts";
import { evaluateDegradation, modeCapabilities, type RunMode } from "./modes.ts";
import { runVerification, type VerificationOutcome } from "./verification.ts";
import { WorkspaceWriteAdmission } from "./workspace-lock.ts";
import { changedObservedPaths, observeWorkspace } from "./workspace-observation.ts";
import { refreshCognition } from "./cognition.ts";
import { assembleTaskExtensions, type TaskExtensionIntegration } from "./extension-integration.ts";
import { captureRecoveryWorkspace } from "./continuous-branches.ts";
import { AttachmentStore } from "./attachments.ts";
import { buildExtensionContext } from "./extension-context.ts";

export interface RuntimeOptions {
  readonly paths: KeystonePaths;
  readonly models: readonly ModelAdapter[];
  readonly routes?: Partial<Record<ModelRole, readonly string[]>>;
  readonly tools?: readonly Tool<never>[];
  readonly verifiers?: readonly Verifier[];
  /** Shared lifecycle signals revoke in-flight calls when the workbench disables an extension. */
  readonly extensions?: ExtensionLifecycleService;
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
  readonly taskIntent?: "analysis" | "engineering";
  /** Selects only a registered model for this run's immutable route snapshot. */
  readonly modelId?: string;
  readonly references?: readonly TaskReference[];
  readonly attachments?: readonly InputAttachment[];
  readonly attachmentParts?: readonly ModelContentPart[];
  readonly configurationSnapshot?: ConfigurationSnapshot;
  readonly signal?: AbortSignal;
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
  readonly onTaskCreated?: (taskId: TaskId) => void | Promise<void>;
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

export type RunDraftTaskOptions = Omit<
  RunTaskOptions,
  "request" | "references" | "attachments" | "attachmentParts"
>;

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

const taskModelRoutesSchema = defineSchema("keystone.runtime.taskModelRoutes", "1.0.0", objectOf({
  kind: lit("runtime.task-model-routes"),
  routes: objectOf({
    builder: arrayOf(nonEmptyStr()),
    planner: arrayOf(nonEmptyStr()),
    summarizer: arrayOf(nonEmptyStr()),
  }),
  registrationFingerprint: sha256Validator,
}));

function modelRegistrationFingerprint(router: ModelRouter): string {
  return contentHash(router.listAdapters().map(adapter => ({
    descriptor: adapter.descriptor,
    ...(adapter.configurationDigest === undefined ? {} : { configurationDigest: adapter.configurationDigest }),
    ...(adapter.transportPermission === undefined ? {} : { transportPermission: adapter.transportPermission }),
  })));
}

export class KeystoneRuntime {
  private readonly paths: KeystonePaths;
  private router = new ModelRouter();
  private readonly tools: readonly Tool<never>[];
  private readonly verifiers: readonly Verifier[];
  private readonly extensionService: ExtensionLifecycleService;
  private readonly contractProposer: ContractProposer;
  private readonly mode: RunMode;
  private readonly actorId: string;
  /** Process-local admission: at most one standard writer per canonical workspace. */
  private readonly writeAdmission = new WorkspaceWriteAdmission();

  private constructor(options: RuntimeOptions) {
    this.paths = options.paths;
    this.tools = options.tools ?? builtinTools();
    this.verifiers = options.verifiers ?? builtinVerifiers();
    this.extensionService = options.extensions ?? new ExtensionLifecycleService(defaultRegistryLocation(options.paths.home));
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

  listModels(): ReturnType<ModelRouter["listModels"]> {
    return this.router.listModels();
  }

  listModelAdapters(): readonly ModelAdapter[] {
    return this.router.listAdapters();
  }

  /** Swap routing for subsequent tasks; each active run holds its old router. */
  configureModels(models: readonly ModelAdapter[], routes: Partial<Record<ModelRole, readonly string[]>> = {}): void {
    const router = new ModelRouter();
    for (const adapter of models) router.register(adapter);
    for (const [role, ids] of Object.entries(routes)) if (ids !== undefined) router.setRoute(role as ModelRole, ids);
    this.router = router;
  }

  async withWorkspaceWrite<T>(projectId: string, effect: () => Promise<T>): Promise<T> {
    const release = this.writeAdmission.tryAcquire(projectId, nowIso());
    try { return await effect(); } finally { release(); }
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
    await KernelSession.rebuildProjectFacts({ paths: this.paths, projectId });
    await facts.load();
    await seedFacts(this.paths, projectId, profile, snapshot);
    await refreshCognition(this.paths, workspacePath, profile, snapshot);
    await facts.load();

    await KernelSession.rebuildProjectExperience({ paths: this.paths, projectId });
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
    const router = this.router.snapshot();
    if (options.modelId) {
      if (!router.listModels().some(entry => entry.id === options.modelId)) throw new Error("selected model is unavailable");
      for (const role of ["builder", "planner", "summarizer"] as const) router.setRoute(role, [options.modelId]);
    }
    const projectId = await projectIdForWorkspace(options.workspacePath);
    const releaseWrite = this.acquireWorkspaceWrite(projectId);
    try {
      return await this.executeTask(options, projectId, router);
    } finally {
      releaseWrite();
    }
  }

  async runDraftTask(taskId: string, options: RunDraftTaskOptions): Promise<RunTaskResult> {
    const session = await KernelSession.open({
      paths: this.paths,
      taskId: taskId as TaskId,
      actorId: this.actorId,
      proposeContract: this.contractProposer,
      resolveAction: resolveEngineeringAction,
    });
    if (session.state().status !== "draft") {
      throw new Error(`task cannot start from ${session.state().status}`);
    }
    const created = session.events().find((event) => event.type === "task.created");
    const request = created?.payload["request"];
    if (typeof request !== "string" || request.length === 0) throw new Error("draft task request is unavailable");
    const references = (created?.payload["references"] ?? []) as readonly TaskReference[];
    const attachments = (created?.payload["attachments"] ?? []) as readonly InputAttachment[];
    const projectId = await projectIdForWorkspace(options.workspacePath);
    if (projectId !== session.projectId) throw new Error("draft task belongs to another workspace");
    const router = this.router.snapshot();
    if (options.modelId) {
      if (!router.listModels().some(entry => entry.id === options.modelId)) throw new Error("selected model is unavailable");
      for (const role of ["builder", "planner", "summarizer"] as const) router.setRoute(role, [options.modelId]);
    }
    const releaseWrite = this.acquireWorkspaceWrite(projectId);
    try {
      return await this.executeTask({
        ...options,
        workspacePath: options.workspacePath,
        request,
        references,
        attachments,
        attachmentParts: await new AttachmentStore(this.paths).parts(attachments),
      }, projectId, router, { kind: "draft", session });
    } finally {
      releaseWrite();
    }
  }

  async resumeTask(taskId: string, options: Pick<RunTaskOptions,
    "signal" | "control" | "onIntervention" | "onTaskCreated" | "configurationSnapshot" | "attachmentParts"> = {},
    branchId?: string): Promise<RunTaskResult> {
    const session = await KernelSession.open({ paths: this.paths, taskId: taskId as never, branchId: branchId as never,
      actorId: this.actorId, resolveAction: resolveEngineeringAction });
    if (!["paused", "executing", "verifying", "auto_repairing", "resuming"].includes(session.state().status)) {
      throw new Error(`task cannot resume from ${session.state().status}`);
    }
    const checkpoint = await session.latestCheckpoint();
    if (!checkpoint) throw new Error("resume requires a complete checkpoint");
    let binding: RunBinding | undefined;
    let taskModelRoutes: ReturnType<typeof taskModelRoutesSchema.parse> | undefined;
    for (const ref of checkpoint.artifactRefs) {
      const bytes = await getArtifactBytes(this.paths, ref);
      if (!bytes || `art_${sha256Bytes(bytes)}` !== ref) throw new Error("resume artifact missing or corrupt");
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (value.schemaVersion === "keystone.runtime.runBinding@1.0.0") binding = runBindingSchema.parse(value);
        if (value.kind === "runtime.task-model-routes") {
          if (taskModelRoutes !== undefined) throw new Error("resume has conflicting model route bindings");
          taskModelRoutes = taskModelRoutesSchema.parse(value);
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    if (!binding) throw new Error("legacy task has no verifiable run binding; replay/export remain available");
    const originalInputs = (session.events().find((event) => event.type === "task.created")?.payload["attachments"] ?? []) as InputAttachment[];
    const attachmentParts = await new AttachmentStore(this.paths).parts(originalInputs);
    if (options.attachmentParts !== undefined && contentHash(options.attachmentParts) !== contentHash(attachmentParts)) {
      throw new Error("resume inputs differ from the recorded task; revise explicitly");
    }
    if (binding.mode !== this.mode) throw new Error("resume mode differs from the recorded run");
    let router = this.router.snapshot();
    if (taskModelRoutes !== undefined) {
      if (taskModelRoutes.registrationFingerprint !== modelRegistrationFingerprint(router)) {
        throw new Error("resume model registration configuration changed");
      }
      for (const role of MODEL_ROLES) {
        const ids = taskModelRoutes.routes[role];
        if (ids.some(id => !router.listModels().some(model => model.id === id))) {
          throw new Error("selected model is unavailable");
        }
        router.setRoute(role, ids);
      }
    } else if (binding.configurationSnapshot?.builderModelId !== undefined) {
      // Older selected tasks recorded only the builder ID. Preserve distinct
      // default roles if only that original configuration matches the binding.
      const selected = router.snapshot();
      const modelId = binding.configurationSnapshot.builderModelId;
      if (!selected.listModels().some(model => model.id === modelId)) throw new Error("selected model is unavailable");
      for (const role of MODEL_ROLES) selected.setRoute(role, [modelId]);
      if (binding.executionFingerprint === await this.executionFingerprint(selected)) router = selected;
    }
    if (binding.executionFingerprint !== await this.executionFingerprint(router)) throw new Error("resume execution configuration or active extension identities changed");
    if (options.configurationSnapshot && contentHash(options.configurationSnapshot) !== contentHash(binding.configurationSnapshot)) {
      throw new Error("resume configuration snapshot changed");
    }
    const release = this.acquireWorkspaceWrite(await projectIdForWorkspace(binding.workPath));
    try {
      const observation = await observeWorkspace(binding.workPath);
      if (observation.fingerprint !== checkpoint.verification.workspaceFingerprint) throw new Error("resume workspace changed since checkpoint");
      const assessment = await session.recover({ workspaceFingerprint: observation.fingerprint });
      if (!assessment.consistent) throw new Error(assessment.explanation);
      await session.requestResume();
      await session.completeRecovery({ ...assessment,
        resumedStatus: assessment.resumedStatus === "paused" ? "executing" : assessment.resumedStatus });
      return await this.executeTask({ workspacePath: binding.workspacePath, request: binding.request,
        maxSteps: binding.maxSteps, tokenBudgetPerStep: binding.tokenBudgetPerStep,
        configurationSnapshot: binding.configurationSnapshot, ...options,
        attachments: originalInputs, attachmentParts },
      session.projectId, router, { kind: "resume", session, binding });
    } finally { release(); }
  }

  private async executionFingerprint(router: ModelRouter): Promise<string> {
    const modelConfigurations = router.listAdapters().flatMap(adapter => adapter.configurationDigest === undefined
      ? [] : [{ modelId: adapter.descriptor.id, configurationDigest: adapter.configurationDigest }]);
    const base = contentHash({ tools: this.tools.map((tool) => tool.descriptor),
      verifiers: this.verifiers.map((verifier) => verifier.descriptor),
      models: router.listModels(), egress: router.describeEgress(),
      ...(modelConfigurations.length === 0 ? {} : { modelConfigurations }) });
    const extensions = (await this.extensionService.list()).filter((entry) => entry.lifecycleStatus === "active")
      .map((entry) => ({ manifest: entry.manifest, reviewHash: entry.reviewHash, source: entry.source.locator }))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    // Legacy runs with no active extensions retain their execution binding.
    return extensions.length ? contentHash({ base, extensions }) : base;
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
    if (this.mode === "isolated" || this.mode === "replay") return () => undefined;
    return this.writeAdmission.tryAcquire(projectId, nowIso());
  }

  private async executeTask(
    options: RunTaskOptions,
    projectId: string,
    router: ModelRouter,
    continuation?: {
      readonly kind: "resume";
      readonly session: KernelSession;
      readonly binding: RunBinding;
    } | {
      readonly kind: "draft";
      readonly session: KernelSession;
    },
  ): Promise<RunTaskResult> {
    const resumed = continuation?.kind === "resume" ? continuation : undefined;
    const startsLocally = continuation?.kind !== "resume";
    const attachment = await this.attachProject(options.workspacePath);
    const capabilities = modeCapabilities(this.mode);
    // Isolated mode works in a throwaway worktree, so a failed attempt cannot
    // damage the user's working copy (PRD EX-05).
    let isolatedWorkspace =
      resumed ? (resumed.binding.workPath !== options.workspacePath ? resumed.binding.workPath : undefined) :
      undefined;
    let workPath = isolatedWorkspace ?? options.workspacePath;
    let baselineObservation = resumed ? {
      fingerprint: resumed.binding.baselineFingerprint,
      files: new Map(resumed.binding.baselineFiles.map((file) => [file.path, file.hash])),
    } : await observeWorkspace(workPath);
    let currentObservation = await observeWorkspace(workPath);

    const session = continuation?.session ?? await KernelSession.create({
      paths: this.paths,
      projectId: attachment.projectId as never,
      request: options.request,
      ...(options.taskIntent === undefined ? {} : { taskIntent: options.taskIntent }),
      references: options.references,
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      ...(options.configurationSnapshot === undefined ? {} : { configurationSnapshot: options.configurationSnapshot }),
      actorId: this.actorId,
      // The wired scenario pack drafts the Outcome Contract and resolves which
      // capability a proposal needs; the kernel only folds the result into
      // authoritative state (ADR-0006, M1).
      proposeContract: this.contractProposer,
      resolveAction: resolveEngineeringAction,
    });
    // Name the holder so a later refusal can point at the task that is running.
    this.writeAdmission.noteHolder(projectId, session.taskId);
    await options.onTaskCreated?.(session.taskId);

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

    const budget: Budget = resumed?.session.contract()?.budget ?? options.budget ?? options.autonomy?.budget ?? {
      maxTokens: 300_000,
      maxWallClockMs: 7_200_000,
      maxRetries: 3,
    };

    if (startsLocally) await session.submit();
    const compiled = resumed ? { contract: session.contract()!, questions: [] } : await session.compile({
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

    // Retain actual admitted entries for evaluation; eligibility is refreshed
    // per step so a later revocation or contract revision cannot reuse them.
    const selectedExperience: ReturnType<ExperienceFirewall["selectForContext"]>[number][] = [];

    if (startsLocally) await session.start();
    if (startsLocally && this.mode === "isolated") {
      const resources = contract.scope.include.filter((entry) => entry.intent === "write")
        .map((entry) => entry.pattern);
      const grant = await session.authorizeOperation({
        subject: { kind: "orchestrator", id: "runtime.isolation" }, capability: "git.write",
        resourceValues: resources, parametersHash: contentHash({
          workspacePath: options.workspacePath, revision: "HEAD", preserveDirty: true,
        }), reversibility: "reversible",
      });
      if (!grant.ok) { await session.stop("isolated workspace provisioning refused"); throw new Error(grant.denial.detail); }
      const started = Date.now();
      try {
        isolatedWorkspace = await createIsolatedWorkspace(options.workspacePath);
        workPath = isolatedWorkspace;
        baselineObservation = await observeWorkspace(workPath);
        currentObservation = baselineObservation;
      } finally {
        await session.consumeExecutionLease(grant.lease.leaseId);
        await session.recordBudget({ wallClockMs: Date.now() - started, reason: "isolated workspace provisioning", measured: true });
      }
    }
    const extensionResources = (await collectScopeFiles(workPath, contract, { limit: 64 })).map((file) => file.path);
    const extensions = extensionResources.length ? await assembleTaskExtensions(
      this.extensionService, session,
      workPath, extensionResources, options.signal, { paths: this.paths,
        operationDecision: async (operation) => {
          const request = buildInterventionRequest({
            taskId: session.taskId, branchId: session.branchId, contract, trigger: "irreversible_action",
            question: "Run this reviewed extension process in its copied workspace?",
            whyUserNeeded: "Starting extension code requires confirmation of this exact operation.",
            ifIgnoredImpact: "This extension operation will remain unavailable; no code is launched.",
            recommended: { label: "Run this operation once", rationale: "The displayed parameters and resource are fixed for this call." },
            contextSummary: canonicalJson({ capability: operation.capability, resources: operation.resourceValues,
              parameters: operation.parameters, parametersHash: contentHash(operation.parameters) }),
          });
          interventions.push(request);
          await session.requestIntervention(request);
          const answer = await this.ask(options, request);
          if (answer === undefined) return undefined;
          const decision = userDecisionSchema.parse({ ...answer, interventionId: request.interventionId,
            appliesTo: { capability: operation.capability, resources: [...operation.resourceValues] },
            modifications: { parametersHash: contentHash(operation.parameters) } });
          if (decision.taskId !== session.taskId || decision.branchId !== session.branchId) throw new Error("extension decision belongs to another task");
          await session.decide(request, decision);
          return decision;
        },
      }) : undefined;
    try {

    let fingerprint = currentObservation.fingerprint;
    let snapshotId: string = workPath === options.workspacePath
      ? attachment.snapshot.snapshotId : (await scanWorkspace(workPath)).snapshotId;
    // Paths that were dirty/untracked at onboarding: a git.commit must refuse to
    // sweep them into the agent commit (PRD PI-01 line 312; ADR-0007, B1).
    const baselineDirtyPaths = new Set(
      resumed?.binding.baselineDirtyPaths ??
      attachment.snapshot.entries.filter((entry) => entry.gitStatus !== "").map((entry) => entry.path),
    );
    const binding = runBindingSchema.parse(resumed?.binding ?? {
      schemaVersion: "keystone.runtime.runBinding@1.0.0", workspacePath: options.workspacePath, workPath,
      mode: this.mode, request: options.request,
      baselineFingerprint: baselineObservation.fingerprint,
      baselineFiles: [...baselineObservation.files].map(([path, hash]) => ({ path, hash })),
      baselineDirtyPaths: [...baselineDirtyPaths], maxSteps: options.maxSteps ?? 12,
      ...(options.tokenBudgetPerStep === undefined ? {} : { tokenBudgetPerStep: options.tokenBudgetPerStep }),
      ...(options.configurationSnapshot === undefined ? {} : { configurationSnapshot: options.configurationSnapshot }),
      executionFingerprint: await this.executionFingerprint(router),
    });
    const bindingArtifact = await putJsonArtifact(this.paths, binding);
    const modelRoutesArtifact = await putJsonArtifact(this.paths, taskModelRoutesSchema.parse({
      kind: "runtime.task-model-routes",
      routes: Object.fromEntries(MODEL_ROLES.map(role => [
        role, router.route(role).map(adapter => adapter.descriptor.id),
      ])),
      registrationFingerprint: modelRegistrationFingerprint(router),
    }));
    const checkpointRun = async (reason: import("@keystone/schemas").CheckpointReason): Promise<void> => {
      const observation = await observeWorkspace(workPath);
      const workspaceArtifact = await captureRecoveryWorkspace(this.paths, workPath);
      await session.checkpoint(reason, { artifactRefs: [bindingArtifact.artifactId, modelRoutesArtifact.artifactId,
        ...(workspaceArtifact ? [workspaceArtifact] : [])],
        contractDigest: contentHash(contract),
        workspaceSnapshotId: snapshotId,
        verification: { workspaceFingerprint: observation.fingerprint as never } });
    };
    await checkpointRun("stage_boundary");
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

        await KernelSession.rebuildProjectExperience({ paths: this.paths, projectId: session.projectId });
        await attachment.firewall.load();
        const eligibleExperience = capabilities.usesExperience ? attachment.firewall.selectForContext({
          taskShape, paths: contract.scope.include.map((entry) => entry.pattern), toolVersions,
        }) : [];
        let plan: Awaited<ReturnType<KeystoneRuntime["buildPlan"]>>;
        try { plan = await this.buildPlan(
          session,
          contract,
          fingerprint,
          snapshotId,
          workPath,
          options,
          state,
          verdict,
          eligibleExperience.map((selection) => selection.entry),
          router,
          extensions,
        ); } catch (error) {
          const unavailableExtension = extensions !== undefined && error instanceof Error &&
            ["ToolRefusedError", "LocalPackageError"].includes(error.name);
          if (!(error instanceof ContextBudgetError) && !unavailableExtension) throw error;
          if (["executing", "verifying", "auto_repairing"].includes(session.state().status)) {
            await session.pause(error.message, false);
          }
          reasons.push(error.message); stopped = true; break;
        }
        snapshotId = plan.snapshotId;
        await session.recordContextPlan(plan.plan);
        for (const selection of eligibleExperience) {
          if (plan.plan.experiencesUsed.includes(selection.entry.entryId) &&
              !selectedExperience.some((used) => used.entry.entryId === selection.entry.entryId)) {
            selectedExperience.push(selection);
          }
        }
        for (const item of plan.plan.items) {
          if (item.kind === "file") readPaths.add(item.ref);
        }

        let envelope;
        try {
          envelope = await this.askBuilder(
            session,
            contract,
            plan.rendered,
            lastFailures,
            attempt,
            router,
            (options.attachmentParts ?? []).filter((part) => part.type !== "text"),
            options.signal,
            extensions?.descriptors ?? [],
          );
        } catch (error) {
          const pendingControl = await this.pollControl(options, session);
          if (pendingControl !== undefined && pendingControl.revised === undefined) {
            stopped = true;
            reasons.push(pendingControl.reason);
            break;
          }
          if (pendingControl?.revised !== undefined) {
            contract = pendingControl.revised;
            continue;
          }
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

        // A response arriving after control was queued cannot act on the old
        // contract. Account its usage, then discard it before any new grant.
        const afterWait = await this.pollControl(options, session);
        if (afterWait !== undefined) {
          if (afterWait.revised !== undefined) {
            contract = afterWait.revised;
            reasons.push(`the contract was revised to v${contract.version}: ${afterWait.reason}`);
            continue;
          }
          stopped = true;
          reasons.push(afterWait.reason);
          break;
        }

        const publicAnswer = (envelope.answer ?? envelope.summary).trim();
        const responseModel = router.listModels().find((entry) => entry.id === envelope.producerModelId);
        if (publicAnswer && responseModel) await session.recordModelResponse({
          stepId: plan.plan.stepId, modelId: responseModel.id, provider: responseModel.provider,
          modelName: responseModel.modelName, text: publicAnswer,
        });

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
          envelope.actions[0]?.intent === "finish"
        ) {
          break;
        }

        const builder = router.listModels().find((descriptor) => descriptor.id === envelope.producerModelId);
        const proposals = toActionProposals(
          { ...envelope, actions: envelope.actions.slice(0, 1) },
          {
            taskId: session.taskId,
            branchId: session.branchId,
            stepId: plan.plan.stepId,
            modelRef: {
              id: builder?.id ?? "unknown",
              provider: builder?.provider ?? "unknown",
              modelName: builder?.modelName ?? "unknown",
            },
          },
          { newId },
        );

        // One action per step. Batching would multiply the blast radius of a
        // single bad proposal, and the checkpoint granularity is per step.
        const proposal = proposals[0];
        if (proposal === undefined) break;
        const beforeAction = await this.pollControl(options, session);
        if (beforeAction !== undefined) {
          if (beforeAction.revised !== undefined) {
            contract = beforeAction.revised;
            continue;
          }
          stopped = true;
          reasons.push(beforeAction.reason);
          break;
        }

        const outcome = await this.executeProposal(
          session,
          proposal,
          contract,
          workPath,
          baselineDirtyPaths,
          options.signal,
          extensions,
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
          for (const path of outcome.changedPaths) changedPaths.add(path);
          reasons.push(outcome.stopReason);
          break;
        }

        for (const path of outcome.changedPaths) changedPaths.add(path);

        if (outcome.changedPaths.length > 0) {
          // Writes invalidate earlier evidence: the old fingerprint no longer
          // describes the workspace (PRD VF-06).
          const snapshot = await scanWorkspace(workPath);
          currentObservation = await observeWorkspace(workPath);
          await session.invalidateStaleEvidence({
            previousFingerprint: fingerprint,
            currentFingerprint: currentObservation.fingerprint,
            changedPaths: outcome.changedPaths,
          });
          fingerprint = currentObservation.fingerprint;
          snapshotId = snapshot.snapshotId;
        }
        await checkpointRun("stage_boundary");

        const lastExecution = session.events().filter((event) => event.type === "action.executed").at(-1);
        const progressKey = contentHash({
          changedPaths: [...changedPaths].sort(),
          tool: proposal.tool.id, parameters: proposal.parameters,
          outputHash: lastExecution?.payload["outputHash"] ?? null,
        });
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
      currentObservation = await observeWorkspace(workPath);
      for (const path of changedObservedPaths(baselineObservation, currentObservation)) changedPaths.add(path);
      if (currentObservation.fingerprint !== fingerprint) {
        await session.invalidateStaleEvidence({
          previousFingerprint: fingerprint, currentFingerprint: currentObservation.fingerprint,
          changedPaths: [...changedPaths],
        });
        fingerprint = currentObservation.fingerprint;
      }
      if (session.state().status === "needs_attention") break;

      await checkpointRun("pre_verification");

      verification = await runVerification({
        rootPath: workPath,
        paths: this.paths,
        session,
        contract,
        changedPaths: [...changedPaths],
        verifiers: [...this.verifiers, ...(extensions?.verifiers ?? []),
          ...(session.taskIntent() === "analysis" ? [{
            descriptor: {
              kind: "custom" as const, id: "verifier.analysis_workspace", version: "1.0.0",
              evidenceLevel: "E2" as const, canSatisfyRequiredCondition: true, timeoutMs: 30000,
              requiresCommand: false,
              independence: { mode: "same_process" as const, independentOf: ["builder_loop_model" as const] },
              description: "Compares complete observed workspace content before and after analysis",
            },
            async run() {
              const observed = await observeWorkspace(workPath);
              const unchanged = observed.fingerprint === baselineObservation.fingerprint;
              return {
                status: unchanged ? "passed" as const : "failed" as const,
                summary: unchanged ? "analysis left the complete workspace unchanged" : "workspace changed during analysis",
                outputBytes: 0, truncated: false, durationMs: 0,
              };
            },
          }] : []),
        ] as readonly Verifier[],
        workspaceSnapshotId: snapshotId,
        workspaceFingerprint: fingerprint,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      const verificationControl = await this.pollControl(options, session);
      if (verificationControl !== undefined) {
        if (verificationControl.revised !== undefined) {
          contract = verificationControl.revised;
          reasons.push(`the contract was revised to v${contract.version}: ${verificationControl.reason}`);
        } else {
          stopped = true;
          reasons.push(verificationControl.reason);
          break;
        }
      }

      if (session.taskIntent() === "analysis") {
        const unverified = contract.completionConditions
          .filter((condition) => condition.required && !verification.passedConditionIds.includes(condition.conditionId))
          .map((condition) => condition.conditionId);
        await session.exitGracefully({
          exitId: "exit.analysis_answer",
          description: "analysis returned; model conclusions remain unverified",
          unsatisfiedConditionIds: unverified,
        });
        reasons.push("analysis conclusions are model observations, not independent proof");
        break;
      }

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

      const afterWaitControl = await this.pollControl(options, session);
      if (afterWaitControl !== undefined) {
        if (afterWaitControl.revised !== undefined) contract = afterWaitControl.revised;
        else { stopped = true; reasons.push(afterWaitControl.reason); break; }
      }
      // The verifier or a concurrent human may change files while checks run.
      // A pass describes its observed fingerprint, never the later workspace.
      currentObservation = await observeWorkspace(workPath);
      for (const path of changedObservedPaths(baselineObservation, currentObservation)) changedPaths.add(path);
      if (currentObservation.fingerprint !== fingerprint) {
        await session.invalidateStaleEvidence({
          previousFingerprint: fingerprint, currentFingerprint: currentObservation.fingerprint,
          changedPaths: [...changedPaths],
        });
        fingerprint = currentObservation.fingerprint;
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
    if (staleFactIds.length > 0 && workPath === options.workspacePath) {
      await KernelSession.updateProjectFacts({ paths: this.paths, projectId: attachment.projectId,
        reason: "workspace_changed", facts: attachment.facts.all()
          .filter((fact) => staleFactIds.includes(fact.factId))
          .map((fact) => ({ ...fact, status: "stale", updatedAt: nowIso() })) });
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
      workspaceFingerprint: fingerprint,
      verifierFailures: verification.failed,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        workspaceFingerprint: fingerprint,
      },
    });

    await checkpointRun("stage_boundary");

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
    } finally { await extensions?.close(); }
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
    router: ModelRouter,
    extensions?: TaskExtensionIntegration,
  ): Promise<{
    plan: Awaited<ReturnType<typeof planContext>>["plan"];
    rendered: string;
    stepId: string;
    snapshotId: string;
  }> {
    const pressure = contextPressure(verdict);
    const files = await collectScopeFiles(workPath, contract, { limit: MAX_FILES_PER_PLAN });
    const profile = await detectProjectProfile(workPath, session.projectId);
    let observedAt = nowIso();
    let facts: readonly import("@keystone/schemas").ProjectFact[] = [];
    if (modeCapabilities(this.mode).usesProjectCognition) {
      const snapshot = await scanWorkspace(workPath);
      snapshotId = snapshot.snapshotId;
      observedAt = snapshot.at;
      if (workPath === options.workspacePath) {
        await refreshCognition(this.paths, workPath, profile, { ...snapshot, projectId: session.projectId });
        facts = await cognitionFacts(this.paths, session.projectId);
      } else {
        // Fork observations stay task-local; they must not rewrite cognition
        // about the user's primary workspace.
        const observed = await scanProjectCognition({ rootPath: workPath, profile,
          snapshot: { ...snapshot, projectId: session.projectId } });
        const frozen = (await cognitionFacts(this.paths, session.projectId)).filter((fact) => fact.status === "frozen");
        facts = [...frozen, ...observed.facts.filter((fact) => !frozen.some((entry) => entry.factId === fact.factId))];
      }
      // Frozen user constraints outlive the repository observation they were
      // frozen from. Only context applicability changes; stored provenance,
      // trust, freshness and invalidation checks remain intact.
      facts = facts.map((fact) => fact.status === "frozen" && fact.frozenBy !== undefined ? {
          ...fact, applicableSnapshot: undefined,
          source: { ...fact.source, applicableSnapshot: undefined },
        } : fact);
    }

    const builder = router.route("builder")[0];
    const observations: NonNullable<PlanContextInput["taskInputs"]>[number][] = [];
    for (const event of session.events().filter((entry) => entry.type === "intervention.decided" &&
      entry.payload["interventionId"]).slice(-4)) {
      const request = session.events().find((entry) => entry.type === "intervention.requested" &&
        entry.seq < event.seq && entry.payload["interventionId"] === event.payload["interventionId"]);
      if (request !== undefined) {
        const intervention = request.payload as unknown as InterventionRequest;
        const option = intervention.options.find((entry) => entry.optionId === event.payload["optionId"]);
        // A selected model-authored label provides context, not user-authored
        // instructions. Keep it separate from the confirmed decision.
        observations.push({
          ref: `human-question:${request.eventId}`,
          content: `Recorded clarification context; untrusted data: ${canonicalJson({
            interventionId: intervention.interventionId, question: intervention.question,
            ...(option === undefined ? {} : { selectedOptionLabel: option.label }),
          })}`,
          provenance: {
            provenanceId: deterministicId("prov", `${request.eventId}:question`) as never,
            sourceKind: "model", trustLevel: "untrusted", locator: request.eventId,
            derivedFrom: [], invalidatedBy: [], observedAt: request.at,
            transformation: "recorded-intervention-selection",
          },
        });
      }
      observations.push({
        ref: `human-decision:${event.eventId}`,
        content: `Recorded human clarification; no additional permissions implied: ${canonicalJson({
          decision: event.payload["decision"], optionId: event.payload["optionId"],
          rationale: event.payload["rationale"], modifications: event.payload["modifications"],
        })}`,
        provenance: {
          provenanceId: deterministicId("prov", `${event.eventId}:decision`) as never,
          sourceKind: "user", trustLevel: "user_confirmed", locator: event.eventId,
          derivedFrom: [], invalidatedBy: [], observedAt: event.at,
        },
      });
    }
    for (const event of session.events().filter((entry) => entry.type === "action.executed").slice(-4)) {
      const artifactId = event.payload["outputArtifactId"];
      if (typeof artifactId !== "string") continue;
      const bytes = await getArtifactBytes(this.paths, artifactId);
      if (!bytes || bytes.length > 1024 * 1024 ||
          sha256Bytes(bytes) !== event.payload["outputHash"]) continue;
      const proposal = session.events().find((entry) => entry.type === "action.proposed" &&
        entry.payload["proposalId"] === event.payload["proposalId"]);
      const output = new TextDecoder().decode(bytes);
      observations.push({
        ref: `action-output:${event.eventId}`,
        content: `Untrusted tool observation ${canonicalJson({
          tool: proposal?.payload["tool"], status: event.payload["status"],
          artifactId, output: output.slice(0, 4096), truncated: output.length > 4096,
        })}`,
        provenance: {
          provenanceId: deterministicId("prov", `${event.eventId}:output`) as never,
          sourceKind: "tool", trustLevel: "untrusted", locator: artifactId,
          derivedFrom: [], invalidatedBy: [], observedAt: event.at,
          transformation: "bounded-tool-output",
        },
      });
    }
    const input: PlanContextInput = {
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
      facts,
      experiences,
      taskInputs: [...observations, ...(options.attachmentParts ?? []).map((part, index) => ({
        ref: `task-input:${index}`,
        content: part.type === "text" ? part.text :
          `Image input ${part.sourceId}; artifact ${part.artifactId}; MIME ${part.mimeType}. Image provider token cost is unmeasured before invocation.`,
        provenance: {
          provenanceId: deterministicId("prov", `${session.taskId}:input:${index}`) as never,
          sourceKind: "user" as const, trustLevel: "untrusted" as const, locator: `task-input:${index}`,
          derivedFrom: (options.attachments ?? []).map((attachment) => attachment.provenance.provenanceId),
          invalidatedBy: ["input.removed"], observedAt: session.state().createdAt,
        },
      }))],
      taskShape: inferTaskShape(options.request),
      languages: profile.languages,
      packageManager: profile.packageManager,
      toolVersions: this.tools.map((tool) => ({ id: tool.descriptor.id, version: tool.descriptor.version })),
      retrieverProvenance: {
        provenanceId: deterministicId("prov", `${fingerprint}:${snapshotId}`) as never,
        sourceKind: "repository",
        trustLevel: "observed",
        locator: workPath,
        applicableSnapshot: snapshotId as never,
        derivedFrom: [],
        invalidatedBy: ["workspace.changed"],
        observedAt,
        transformation: "scope-expansion",
      },
    };
    const result = extensions ? await buildExtensionContext(input, extensions.skills, {
      metadataTokenBudget: Math.min(2000, Math.floor(input.tokenBudget / 10)),
      observations: await extensions.contextObservations(),
    }) : planContext(input);

    return { plan: result.plan, rendered: result.rendered, stepId: result.plan.stepId, snapshotId };
  }

  private async askBuilder(
    session: KernelSession,
    contract: OutcomeContract,
    contextSection: string,
    previousFailures: readonly string[],
    attempt: number,
    router: ModelRouter,
    attachmentParts: readonly ModelContentPart[],
    signal?: AbortSignal,
    extensionDescriptors: readonly import("@keystone/schemas").ToolDescriptor[] = [],
  ): Promise<ReturnType<typeof parseActionEnvelope> & { readonly producerModelId: string }> {
    const prompt = buildActionPrompt({
      goal: contract.goal,
      stepId: "step.current",
      stepGoal: "make progress on the contract without exceeding scope",
      invariants: contract.invariants.map((invariant) => invariant.description),
      writeScope: contract.scope.include.filter((entry) => entry.intent === "write").map((entry) => entry.pattern),
      allowedCommands: contract.autonomy.allowedCommands,
      availableTools: [...this.tools.map((tool) => tool.descriptor), ...extensionDescriptors],
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
    const model = router.route("builder")[0];
    if (model === undefined) throw new Error("no builder model is configured");
    const attempts = new Map<string, { leaseId: string; started: number }>();
    const transportLeases: string[] = [];
    const outcome = await router.complete("builder", {
        messages: [{ role: "user", content: attachmentParts.length === 0 ? prompt : [{ type: "text", text: prompt }, ...attachmentParts] }],
        tools: [], jsonMode: true,
        maxTokens: Math.max(1, Math.min(8192, contract.budget.maxTokens - session.state().budgetUsed.tokens)),
        async authorizeTransport(proposal) {
          if (signal?.aborted) throw new Error("model transport cancelled");
          if ("nativeAuthFile" in proposal.parameters) {
            const auth = await session.authorizeOperation({
              subject: proposal.subject, capability: "credential.use", resourceValues: ["trae-cli-native-login"],
              parametersHash: proposal.parametersHash,
            });
            if (!auth.ok) throw new Error(auth.denial.detail);
            transportLeases.push(auth.lease.leaseId);
          }
          const grant = await session.authorizeOperation({
            subject: proposal.subject, capability: "cmd.exec",
            resourceValues: proposal.resource.values, parametersHash: proposal.parametersHash,
            workingDirectory: proposal.parameters.cwd, timeoutMs: proposal.parameters.timeoutMs,
            maxOutputBytes: proposal.parameters.maxOutputBytes,
            argvPrefix: proposal.parameters.args.slice(0, 1),
            ttlMs: Math.min(300000, proposal.parameters.timeoutMs + 5000),
          });
          if (!grant.ok) throw new Error(grant.denial.detail);
          transportLeases.push(grant.lease.leaseId);
          return grant.lease;
        },
        ...(signal === undefined ? {} : { signal }),
      }, {
        async beforeAttempt(descriptor) {
          const grant = await session.authorizeOperation({
            subject: { kind: "builder_loop", id: descriptor.id },
            capability: "model.invoke", resourceValues: [descriptor.endpointHost],
            parametersHash: contentHash({ modelId: descriptor.id, prompt, attachmentParts }),
          });
          if (!grant.ok) throw new Error(grant.denial.detail);
          attempts.set(descriptor.id, { leaseId: grant.lease.leaseId, started: Date.now() });
        },
        async afterAttempt(descriptor, response) {
          const attempt = attempts.get(descriptor.id);
          if (attempt === undefined) throw new Error("model invocation has no capability lease");
          await session.consumeExecutionLease(attempt.leaseId);
          for (const leaseId of transportLeases.splice(0)) await session.consumeExecutionLease(leaseId);
          await session.recordBudget({
            tokens: response === undefined ? 0 : response.usage.inputTokens + response.usage.outputTokens,
            wallClockMs: Math.max(1, Date.now() - attempt.started),
            reason: `model.${descriptor.id}`, measured: response !== undefined,
          });
        },
      });

    return { ...parseActionEnvelope(outcome.response.text, outcome.modelId), producerModelId: outcome.modelId };
  }

  private async executeProposal(
    session: KernelSession,
    proposal: ActionProposal,
    contract: OutcomeContract,
    workPath: string,
    baselineDirtyPaths: ReadonlySet<string>,
    signal?: AbortSignal,
    extensions?: TaskExtensionIntegration,
  ): Promise<{
    changedPaths: readonly string[];
    stopReason?: string;
    intervention?: InterventionRequest;
  }> {
    const extension = await extensions?.executeTool(proposal);
    if (extension) return { changedPaths: extension.changedPaths,
      ...(extension.status === "succeeded" ? {} : { stopReason: `extension call ${extension.status}: ${extension.errorCode ?? "unavailable"}` }) };
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
    const before = await observeWorkspace(workPath);
    let result;
    try {
      result = await tool.run(proposal.parameters as never, {
        rootPath: workPath, taskId: session.taskId, branchId: session.branchId,
        paths: this.paths, lease: authorization.lease, baselineDirtyPaths,
        ...(signal === undefined ? {} : { signal }),
      } as never);
    } catch (error) {
      result = {
        status: "failed" as const, durationMs: Date.now() - started,
        changedPaths: [] as string[], outputBytes: 0, errorCode: error instanceof Error ? error.name : "tool_failed",
      };
    }
    const after = await observeWorkspace(workPath);
    const actualChangedPaths = [...new Set([...result.changedPaths, ...changedObservedPaths(before, after)])];
    const outputArtifact = result.stdout || result.stderr
      ? await putJsonArtifact(this.paths, { stdout: (result.stdout ?? "").slice(0, 32768),
          stderr: (result.stderr ?? "").slice(0, 32768), truncated: result.truncated ?? false })
      : undefined;

    await session.recordExecution({
      proposalId: proposal.proposalId,
      leaseId: authorization.lease.leaseId,
      status: result.status,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      durationMs: result.durationMs || Date.now() - started,
      ...(outputArtifact ? { artifactId: outputArtifact.artifactId } :
        result.artifactId === undefined ? {} : { artifactId: result.artifactId }),
      ...(outputArtifact === undefined ? {} : { outputHash: outputArtifact.sha256 }),
      ...(result.outputBytes === undefined ? {} : { outputBytes: result.outputBytes }),
      changedPaths: actualChangedPaths,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    });

    return {
      changedPaths: actualChangedPaths,
      ...(session.state().status === "needs_attention" ? { stopReason: "execution changed paths outside the contract scope" } : {}),
    };
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

async function cognitionFacts(paths: KeystonePaths, projectId: string) {
  await KernelSession.rebuildProjectFacts({ paths, projectId });
  const facts = new ProjectFactStore(paths, projectId as never);
  await facts.load();
  return facts.all();
}

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
  paths: KeystonePaths,
  projectId: string,
  profile: ProjectProfile,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const updates: import("@keystone/schemas").ProjectFact[] = [];
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

  updates.push({
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
    updates.push({
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

  updates.push({
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
  await KernelSession.updateProjectFacts({ paths, projectId, facts: updates, reason: "project_profile" });
}
