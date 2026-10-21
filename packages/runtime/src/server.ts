/**
 * Local Run Protocol server.
 *
 * Desktop, IDE and CI shells all need the same thing: the Keystone runtime,
 * reachable from a process that is not the runtime. This is that boundary, and
 * it speaks the same protocol the CLI uses — no second semantics (PRD 8.10
 * ST-03, 1.4).
 *
 * Security posture, because a local server that can run commands is a real
 * attack surface:
 *
 *  - It binds to loopback only. Binding elsewhere requires an explicit host and
 *    is not offered by the CLI.
 *  - Every request needs a per-session bearer token, generated on start and
 *    handed to the client out of band. A page or script that has not been given
 *    the token cannot start a task, read a proof, or answer an intervention.
 *  - The workbench page receives the token in the URL *fragment*, which browsers
 *    never send to a server, so it does not end up in logs or `Referer` headers.
 *  - Answers to interventions are recorded as user decisions; the server cannot
 *    fabricate one, because `UserDecision.recordedBy` is a literal the schema
 *    enforces.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogFor, DEFAULT_LANGUAGE, isLanguage, type Language } from "@keystone/i18n";
import {
  defaultRegistryLocation,
  ExtensionRegistry,
  ExtensionLifecycleService,
  extensionDecisionResource,
  HarnessLabService,
  LocalPackageError,
  lowRiskActiveExtensions,
} from "@keystone/extensions";
import {
  KernelSession,
  listBranches,
  listCheckpoints,
  projectIdForWorkspace,
  readLedger,
  resolveKeystonePaths,
  type ContractPatch,
  type KeystonePaths,
} from "@keystone/kernel";
import { buildAdapter, createCredentialBroker, enabledModels, routeFor, type CredentialResolver, type ModelAdapter, type ModelRole } from "@keystone/models";
import { compileContract, detectProjectProfile, listDirtyPaths } from "@keystone/pack-engineering";
import {
  autonomyEnvelopeSchema,
  contentHash,
  artifactIdValidator,
  newId,
  nowIso,
  userDecisionSchema,
  USER_DECISIONS,
  TASK_STATUSES,
  type AutonomyEnvelope,
  type Budget,
  type Capability,
  type InterventionRequest,
  type InputAttachment,
  type OutcomeContract,
  type Scope,
  type UserDecision,
} from "@keystone/schemas";

import { clearProjectExperience, DataError, deleteTaskHistory, storeInventory } from "./data.ts";
import { migrateData, previewCleanup, readCredentialService } from "./data-management.ts";
import { changedPathsForTask, taskWorktreeDiff } from "./diff.ts";
import {
  KeystoneRuntime,
  type RunControlRequest,
  type RunDraftTaskOptions,
  type RunTaskOptions,
  type RunTaskResult,
} from "./keystone-runtime.ts";
import { modeCapabilities, type RunMode } from "./modes.ts";
import { resolveStartPolicy } from "./start-policy.ts";
import {
  findDirtyOverlap,
  gradeStartRisk,
  type StartRiskResult,
} from "./start-risk.ts";
import { WorkspaceBusyError } from "./workspace-lock.ts";
import { ProjectRegistry, ProjectServiceError } from "./projects/registry.ts";
import { FileWorkspaceService, FileServiceError } from "./files/service.ts";
import { AttachmentError, AttachmentStore } from "./attachments.ts";
import { SettingsError, SettingsStore } from "./settings.ts";
import { observeWorkspace } from "./workspace-observation.ts";
import { humanFileBoundary } from "./human-files.ts";
import { runHumanCommand } from "./human-commands.ts";
import { cognitionView } from "./cognition.ts";
import { changeExperience } from "./experience-actions.ts";
import { compareContinuousBranches, continuousBranchViews, forkContinuousBranch } from "./continuous-branches.ts";
import { createLocalCollaboration } from "./collaboration/index.ts";
import { ProcessorService, routeInputProcessors, type InputProcessorRegistration } from "./input-processors.ts";
import { compareBaselineCandidate } from "./baseline-verification.ts";
import { checkReleaseReadiness, STABLE_GATES } from "../../../scripts/release/readiness.ts";

const SERVER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
// 1.1.0 adds the read-only `POST /v1/contract/preview` draft endpoint (ADR-0008,
// Decision E). 1.2.0 (ADR-0013) adds an additive `risk` object to that preview
// response and a `startMode` request on `POST /v1/tasks`; both are additive, so
// a 1.0.0/1.1.0 client keeps working, it just loses the low-risk auto-start.
// 1.5.0 adds draft continuation, local input processing and observation-only
// historical comparison without changing existing request or response shapes.
const PROTOCOL_VERSION = "keystone.run.protocol@1.5.0";
const DEFAULT_INTERVENTION_TIMEOUT_MS = 10 * 60_000;

export interface ServeOptions {
  readonly paths?: KeystonePaths;
  readonly models?: readonly ModelAdapter[];
  readonly credentials?: CredentialResolver;
  readonly routes?: Partial<Record<ModelRole, readonly string[]>>;
  readonly mode?: RunMode;
  readonly port?: number;
  readonly token?: string;
  /**
   * The presentation language for the served workbench page. Resolved by the
   * caller (the CLI) and defaulted to the shipped language when omitted, so a
   * test or embedder that does not care still gets a working page.
   */
  readonly language?: Language;
  readonly inputProcessors?: readonly InputProcessorRegistration[];
  /**
   * How long a run waits for an answer to an intervention before giving up.
   *
   * A workbench wants this long (a human may be away); a test wants it short. It
   * is configurable rather than fixed because "waiting forever" and "giving up
   * immediately" are both wrong in one of those two situations, and the caller is
   * the only one who knows which it is.
   */
  readonly interventionTimeoutMs?: number;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly protocolVersion: string;
  close(): Promise<void>;
}

interface InFlightRun {
  readonly taskId: string;
  status: "running" | "finished" | "failed";
  result?: RunTaskResult;
  error?: string;
  readonly startedAt: string;
  /** Decisions this run is waiting for, in the order they were raised. */
  readonly interventions: InterventionRequest[];
}

/** One runtime, one run at a time per workspace — the kernel's own rule. */
class ServeState {
  readonly pending = new Map<string, (decision: UserDecision | undefined) => void>();
  readonly runs = new Map<string, InFlightRun>();
  readonly interventions = new Map<string, InterventionRequest>();
  /**
   * Control requests waiting for a running task to pick up, per task.
   *
   * They are queued rather than applied here: the run owns the kernel session
   * while it is in flight, and a second writer would fork the ledger's hash
   * chain (ADR-0003). The run applies them at its next step boundary.
   */
  readonly controls = new Map<string, RunControlRequest[]>();
  readonly aborters = new Map<string, AbortController>();
}

/** Queue a control request for a running task to pick up at its next step. */
function queueControl(
  state: ServeState,
  taskId: string,
  request: RunControlRequest,
): void {
  const queue = state.controls.get(taskId) ?? [];
  queue.push(request);
  state.controls.set(taskId, queue);
  if (request.kind === "stop" || request.kind === "pause") {
    state.aborters.get(taskId)?.abort();
    for (const [id, intervention] of state.interventions) {
      if (intervention.taskId !== taskId) continue;
      const resolve = state.pending.get(id);
      if (resolve !== undefined) { state.pending.delete(id); resolve(undefined); }
    }
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // A local tool must not be embeddable or sniffable.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > 29_000_000) throw new HttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() === "" ? {} : JSON.parse(text);
}

function authorize(request: IncomingMessage, token: string): boolean {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return false;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || value === undefined) return false;
  // Constant-time-ish comparison: same length check first, then XOR fold.
  if (value.length !== token.length) return false;
  let difference = 0;
  for (let index = 0; index < value.length; index += 1) {
    difference |= value.charCodeAt(index) ^ token.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The task list, with pending decisions counted from both places they live.
 *
 * A question raised while a run is in flight is not always in the ledger — the
 * runtime can ask its host before recording anything — so the in-flight set is
 * merged in by id. Counting only the folded ledger would leave a blocked task
 * looking idle in the list, which is exactly the case the list exists to surface
 * (PRD HI-01, UI-02).
 */
async function listTaskSummaries(
  paths: KeystonePaths,
  inflight: ReadonlyMap<string, InFlightRun>,
): Promise<readonly unknown[]> {
  const { readdir } = await import("node:fs/promises");
  const directory = join(paths.home, "tasks");
  const names = await readdir(directory).catch(() => []);
  const summaries: unknown[] = [];
  for (const name of names) {
    if (!name.startsWith("task_")) continue;
    try {
      const session = await KernelSession.open({
        paths,
        taskId: name as never,
      });
      const state = session.summary();
      const created = session.events().find((event) => event.type === "task.created");
      const pending = new Set<string>(session.state().pendingInterventions);
      for (const intervention of inflight.get(state.taskId)?.interventions ?? []) {
        pending.add(intervention.interventionId);
      }
      summaries.push({
        taskId: state.taskId,
        status: state.status,
        stage: state.stage,
        projectId: state.projectId,
        pendingInterventions: pending.size,
        outstandingEvidence: state.outstandingEvidence,
        updatedAt: state.updatedAt,
        headline: state.headline,
        title: String(created?.payload["request"] ?? state.headline).slice(0, 160),
      });
    } catch (error) {
      // A task whose ledger cannot be verified is reported as such, not hidden.
      summaries.push({
        taskId: name,
        status: "unrecoverable",
        headline:
          error instanceof Error ? `ledger could not be verified: ${error.message}` : "unreadable",
        updatedAt: nowIso(),
      });
    }
  }
  return summaries.sort((a, b) =>
    String((b as { updatedAt?: string }).updatedAt ?? "").localeCompare(
      String((a as { updatedAt?: string }).updatedAt ?? ""),
    ),
  );
}

async function taskDetail(paths: KeystonePaths, taskId: string): Promise<unknown> {
  const session = await KernelSession.open({ paths, taskId: taskId as never });
  const state = session.state();
  const contract = session.contract();
  const evidence = await session.evidence();
  const checkpoint = await session.latestCheckpoint();
  const branches = await listBranches(paths, taskId);
  const ledger = await readLedger(paths.ledgerFile(taskId as never));
  const created = ledger.events.find((event) => event.type === "task.created");

  return {
    taskId: state.taskId,
    projectId: state.projectId,
    branchId: state.branchId,
    status: state.status,
    stage: state.stage,
    seq: state.seq,
    updatedAt: state.updatedAt,
    budgetUsed: state.budgetUsed,
    degradation: state.degradation ?? null,
    proofGraphHash: state.proofGraphHash ?? null,
    proofInvalidated: state.proofInvalidated ?? null,
    request: created?.payload["request"] ?? "",
    references: created?.payload["references"] ?? [],
    ledger: {
      events: ledger.events.length,
      integrityOk: ledger.integrity.ok,
      ...(ledger.integrity.ok ? {} : { integrityReason: ledger.integrity.reason }),
    },
    contract: projectContract(contract),
    evidence: evidence.map((record) => ({
      evidenceId: record.evidenceId,
      level: record.level,
      producer: `${record.producer.id}@${record.producer.version}`,
      conditionIds: record.conditionIds,
      status: record.status,
      createdAt: record.createdAt,
      summary: record.observation.summary.slice(0, 300),
    })),
    branches: branches.map((branch) => ({
      branchId: branch.branchId,
      label: branch.label,
      status: branch.status,
      parentCheckpointId: branch.parentCheckpointId ?? null,
    })),
    checkpoint: checkpoint === undefined ? null : { checkpointId: checkpoint.checkpointId, seq: checkpoint.seq },
    replay: session.replay(),
    attachments: created?.payload["attachments"] ?? [],
    configurationSnapshot: created?.payload["configurationSnapshot"] ?? null,
  };
}

/**
 * The contract as a client sees it.
 *
 * One projection, used by both the task detail and the revision endpoint, so a
 * shell cannot be shown a contract that differs from the one it just wrote.
 */
function projectContract(contract: OutcomeContract | undefined): Record<string, unknown> | null {
  if (contract === undefined) return null;
  return {
    contractId: contract.contractId,
    version: contract.version,
    status: contract.status,
    goal: contract.goal,
    writeScope: contract.scope.include
      .filter((entry) => entry.intent === "write")
      .map((entry) => entry.pattern),
    readScope: contract.scope.include
      .filter((entry) => entry.intent === "read")
      .map((entry) => entry.pattern),
    unknowns: contract.scope.unknown,
    invariants: contract.invariants.map((invariant) => ({
      invariantId: invariant.invariantId,
      description: invariant.description,
      checkedBy: invariant.checkedBy ?? [],
    })),
    completionConditions: contract.completionConditions.map((condition) => ({
      conditionId: condition.conditionId,
      description: condition.description,
      required: condition.required,
      minEvidenceLevel: condition.minEvidenceLevel,
      requiresIndependence: condition.requiresIndependence,
      verifier: condition.verifier.kind,
    })),
    budget: contract.budget,
    autonomy: {
      writePaths: contract.autonomy.writePaths,
      allowedCommands: contract.autonomy.allowedCommands,
      allowedHosts: contract.autonomy.allowedHosts,
      externalSystems: contract.autonomy.externalSystems,
      maxReversibility: contract.autonomy.maxReversibility,
    },
    uncertainties: contract.uncertainties.map((uncertainty) => ({
      uncertaintyId: uncertainty.uncertaintyId,
      question: uncertainty.question,
      affects: uncertainty.affects,
      resolution: uncertainty.resolution,
    })),
    interventionTriggers: contract.interventionTriggers,
    exitConditions: contract.exitConditions.map((condition) => ({
      exitId: condition.exitId,
      kind: condition.kind,
      description: condition.description,
    })),
    parentContractId: contract.parentContractId ?? null,
    revisionReason: contract.revisionReason ?? null,
  };
}

/**
 * Replace the writable part of the scope with the paths the user names.
 *
 * Read scope, excludes and unresolved areas are carried over untouched: a
 * revision that only answers "where may you write" must not silently drop the
 * boundaries the user set earlier (PRD OT-03).
 */
function scopeWithWritePaths(current: Scope, writePaths: readonly string[]): Scope {
  const reads = current.include.filter((entry) => entry.intent === "read");
  const unique = [...new Set(writePaths.map((path) => path.trim()).filter((path) => path !== ""))];
  const writes = unique.map((pattern) => current.include.find((entry) =>
    entry.intent === "write" && (entry.pattern === pattern ||
      (entry.kind === "directory" && `${entry.pattern.replace(/\/+$/, "")}/**` === pattern)),
  ) ?? ({
    kind: pattern.includes("*") ? ("glob" as const) : ("path" as const),
    pattern,
    intent: "write" as const,
  }));
  return { include: [...reads, ...writes], exclude: current.exclude, unknown: current.unknown };
}

/**
 * Build a revision patch from a request body.
 *
 * `undefined` means the body asked for nothing: bumping a contract version with
 * no change would create a revision that explains itself as "no reason", which
 * is worse than refusing.
 */
function buildRevision(
  body: Record<string, unknown>,
  current: OutcomeContract,
): ContractPatch | undefined {
  const revision: { goal?: string; scope?: Scope; budget?: Budget } = {};
  const goal = typeof body["goal"] === "string" ? body["goal"].trim() : "";
  if (goal !== "") revision.goal = goal;
  if (Array.isArray(body["writePaths"])) {
    revision.scope = scopeWithWritePaths(
      current.scope,
      (body["writePaths"] as readonly unknown[]).map((value) => String(value)),
    );
  }
  const budget = body["budget"];
  if (budget !== null && typeof budget === "object") {
    const record = budget as Record<string, unknown>;
    revision.budget = {
      maxTokens: Number(record["maxTokens"] ?? current.budget.maxTokens),
      maxWallClockMs: Number(record["maxWallClockMs"] ?? current.budget.maxWallClockMs),
      maxRetries: Number(record["maxRetries"] ?? current.budget.maxRetries),
    };
  }
  if (revision.goal === undefined && revision.scope === undefined && revision.budget === undefined) {
    return undefined;
  }
  return revision;
}

/** The reason a user gave, or a neutral default for one they did not. */
function revisionReason(body: Record<string, unknown>): string {
  return typeof body["reason"] === "string" && body["reason"].trim() !== ""
    ? body["reason"].trim()
    : "revised from the workbench";
}

export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  let paths = options.paths ?? resolveKeystonePaths();
  const mode: RunMode = options.mode ?? "standard";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const interventionTimeoutMs = options.interventionTimeoutMs ?? DEFAULT_INTERVENTION_TIMEOUT_MS;
  const state = new ServeState();
  let projects = new ProjectRegistry(paths);
  let attachments = new AttachmentStore(paths);
  let settings = new SettingsStore(paths);
  let extensions = new ExtensionLifecycleService(defaultRegistryLocation(paths.home));
  let lab = new HarnessLabService({ reportsDirectory: join(paths.home, "lab", "reports") });
  let collaboration = createLocalCollaboration({ paths: () => paths, projects: () => projects.list() });
  let processors = new ProcessorService({ paths, extensions, processors: options.inputProcessors });
  let managingData = false;
  let storeRequests = 0;
  const assets = new Map<string, string>();
  const webRoot = join(SERVER_DIRECTORY, "..", "web");
  const collectAssets = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(entry.name)) continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) await collectAssets(join(directory, entry.name), `${name}/`);
      else if (entry.isFile() && /\.(?:js|css)$/.test(name)) assets.set(`/assets/${name}`, join(directory, entry.name));
    }
  };
  await collectAssets(webRoot);

  const createRuntime = () => KeystoneRuntime.create({
    paths,
    extensions,
    models: options.models ?? [],
    ...(options.routes === undefined ? {} : { routes: options.routes }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    actorId: "serve",
  });
  let runtime = await createRuntime();
  const applyConfiguredModels = async (): Promise<Awaited<ReturnType<SettingsStore["read"]>>> => {
    const configuration = await settings.read();
    if (configuration.config.models.length === 0) {
      runtime.configureModels(options.models ?? [], options.routes ?? {});
    } else {
      const broker = options.credentials ?? createCredentialBroker({
        credentialsDir: paths.credentialsDir, service: await readCredentialService(paths),
      });
      runtime.configureModels(enabledModels(configuration.config).map((entry) => buildAdapter(entry, broker)), {
        builder: routeFor(configuration.config, "builder"),
        planner: routeFor(configuration.config, "planner"),
        summarizer: routeFor(configuration.config, "summarizer"),
      });
    }
    return configuration;
  };
  await applyConfiguredModels();

  /** Start a run and answer immediately; decisions arrive over HTTP. */
  const startRun = async (body: Record<string, unknown>, draftTaskId?: string): Promise<{ taskId: string }> => {
    let workspacePath = String(body["workspacePath"] ?? "");
    let requestText = String(body["request"] ?? "");
    let originalAttachments: readonly InputAttachment[] | undefined;
    if (draftTaskId === undefined) {
      if (workspacePath === "" || requestText === "") {
        throw new HttpError(400, "workspacePath and request are required");
      }
      try { workspacePath = (await projects.register({ rootPath: workspacePath })).rootPath; }
      catch (error) {
        throw new HttpError(400, `the task could not be created: ${error instanceof Error ? error.message : "workspace is unavailable"}`);
      }
    } else {
      const draft = await KernelSession.open({ paths, taskId: draftTaskId as never });
      if (draft.state().status !== "draft") throw new HttpError(409, `task cannot start from ${draft.state().status}`);
      const created = draft.events().find((event) => event.type === "task.created");
      const recordedRequest = created?.payload["request"];
      if (typeof recordedRequest !== "string" || recordedRequest.length === 0) {
        throw new HttpError(409, "draft request is unavailable");
      }
      if (requestText !== "" && requestText !== recordedRequest) {
        throw new HttpError(409, "draft request is immutable; revise only after the local task starts");
      }
      const project = await projects.get(draft.projectId);
      if (!project || project.status !== "available" || project.archived) {
        throw new HttpError(409, "draft project is unavailable");
      }
      if (workspacePath !== "" && workspacePath !== project.rootPath) {
        throw new HttpError(409, "draft workspace is immutable");
      }
      if (Array.isArray(body["attachmentIds"]) && body["attachmentIds"].length > 0) {
        throw new HttpError(409, "draft inputs are immutable; start a new task to add attachments");
      }
      workspacePath = project.rootPath;
      requestText = recordedRequest;
      originalAttachments = (created?.payload["attachments"] ?? []) as readonly InputAttachment[];
    }
    const writePaths = Array.isArray(body["writePaths"])
      ? (body["writePaths"] as readonly string[])
      : [];
    const allowedCommands = Array.isArray(body["allowedCommands"])
      ? (body["allowedCommands"] as readonly string[])
      : [];

    // A confirmed start is an explicit user acceptance (the modal's Start
    // button) or the legacy `acceptContract` flag. The grade decides whether
    // that signal is required; the client cannot self-attest a safer grade.
    const confirmedStart = body["startMode"] === "confirmed" || body["acceptContract"] === true;

    // Write tasks are graded server-side (ADR-0013). Read-only tasks name no
    // write paths and run straight through; a write task is refused on dirty
    // overlap, or held for confirmation unless it graded `auto_start`.
    if (writePaths.length > 0) {
      let graded;
      try {
        graded = await gradeSubmission({
          workspacePath,
          requestText,
          writePaths,
          allowedCommands,
          references: Array.isArray(body["references"])
            ? (body["references"] as readonly {
                kind: "file" | "directory" | "issue" | "log" | "url" | "text";
                value: string;
              }[])
            : [],
          userConfirmAllWrites: body["confirmAllWrites"] === true,
          defaults: (await settings.read()).config.defaults,
        });
      } catch (error) {
        throw new HttpError(
          400,
          `the task could not be started: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (graded.risk.decision === "refuse") {
        throw new HttpError(409, graded.risk.recovery ?? "this task is refused for this working copy");
      }
      if (graded.risk.decision === "require_confirmation" && !confirmedStart) {
        throw new HttpError(
          409,
          `this task needs confirmation before it writes (${graded.risk.reasons.join(", ")}). ` +
            "Preview it, then start with an explicit confirmation.",
        );
      }
    }

    const projectId = await projectIdForWorkspace(workspacePath);
    const selected = await attachments.select(projectId, originalAttachments?.map((entry) => entry.attachmentId) ??
      (Array.isArray(body["attachmentIds"]) ? body["attachmentIds"].map(String) : []));
    const configuration = await applyConfiguredModels();
    const builder = runtime.describeEgress().find((entry) => entry.role === "builder");
    if (selected.some((entry) => entry.kind === "image") && !builder?.multimodal) throw new HttpError(409, "the selected builder does not support image input");
    if (selected.length > 0 && builder?.local === false && body["allowAttachmentEgress"] !== true) {
      throw new HttpError(409, `confirm attachment egress to ${builder.endpointHost} before starting`);
    }
    const aborter = new AbortController();

    let taskId: string | undefined;
    // The id only exists once the runtime has attached the project and created
    // the session, which is asynchronous. Waiting for it here is what lets the
    // HTTP call answer with the id while the run itself continues in the
    // background — the alternative is a caller that cannot tell which task it
    // just started.
    let announce: { resolve: (id: string) => void; reject: (error: unknown) => void } | undefined;
    const created = new Promise<string>((resolve, reject) => {
      announce = { resolve, reject };
    });

    const runOptions: RunDraftTaskOptions = {
        workspacePath,
        configurationSnapshot: {
          revision: configuration.revision,
          modelIds: runtime.describeEgress().map((entry) => entry.modelId),
          ...(builder === undefined ? {} : { builderModelId: builder.modelId }),
        },
        signal: aborter.signal,
        autonomy: buildAutonomy(projectId, writePaths, allowedCommands, configuration.config.defaults),
        // A confirmed (or auto-started low-risk) run accepts the compiled
        // contract without an extra round trip; an unconfirmed write never
        // reaches here — it was refused above.
        ...(confirmedStart ? { acceptContractAutomatically: true } : {}),
        // The run applies queued pause/stop/revision itself, because it is the
        // session's only writer while it is in flight (ADR-0003).
        control: async () => state.controls.get(taskId ?? "")?.shift(),
        onTaskCreated: async (created_) => {
          await attachments.bind(selected.map((entry) => entry.attachmentId), created_);
          taskId = created_;
          state.aborters.set(created_, aborter);
          state.runs.set(created_, {
            taskId: created_,
            status: "running",
            startedAt: nowIso(),
            interventions: [],
          });
          announce?.resolve(created_);
        },
        onIntervention: async (intervention) => {
          state.interventions.set(intervention.interventionId, intervention);
          state.runs.get(taskId ?? "")?.interventions.push(intervention);
          return await new Promise<UserDecision | undefined>((resolve) => {
            let timer: NodeJS.Timeout;
            state.pending.set(intervention.interventionId, (decision) => { clearTimeout(timer); resolve(decision); });
            // An unanswered question must not hold the run open forever; giving
            // up is honest, blocking indefinitely is not.
            timer = setTimeout(() => {
              if (state.pending.delete(intervention.interventionId)) resolve(undefined);
            }, interventionTimeoutMs);
            timer.unref();
          });
        },
      };
    const completion = (draftTaskId === undefined
      ? runtime.runTask({
          ...runOptions,
          request: requestText,
          attachments: selected,
          attachmentParts: await attachments.parts(selected,
            Math.min(24_000, (configuration.config.defaults?.maxTokens ?? 300_000) * 2)),
          ...(Array.isArray(body["references"])
            ? { references: body["references"] as RunTaskOptions["references"] }
            : {}),
        })
      : runtime.runDraftTask(draftTaskId, runOptions))
      .then((result) => {
        if (taskId !== undefined) {
          state.aborters.delete(taskId);
          state.runs.set(taskId, {
            taskId,
            status: "finished",
            result,
            startedAt: state.runs.get(taskId)?.startedAt ?? nowIso(),
            interventions: state.runs.get(taskId)?.interventions ?? [],
          });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (taskId !== undefined) {
          state.aborters.delete(taskId);
          state.runs.set(taskId, {
            taskId,
            status: "failed",
            error: message,
            startedAt: state.runs.get(taskId)?.startedAt ?? nowIso(),
            interventions: state.runs.get(taskId)?.interventions ?? [],
          });
        }
        announce?.reject(error instanceof Error ? error : new Error(message));
      });
    void completion;

    try {
      return { taskId: await created };
    } catch (error) {
      // A busy workspace is a conflict, not a bad request: the caller pointed at a
      // valid workspace, it just already has a standard writer. 409 tells the client
      // to switch to isolated mode rather than retry the same thing.
      if (error instanceof WorkspaceBusyError) {
        throw new HttpError(409, error.message);
      }
      // Creation itself failed (no Git repository, unreadable path, a bad
      // contract). The caller gets the reason, not a task id that will never
      // make progress.
      throw new HttpError(
        400,
        `the task could not be created: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let ownsManagement = false;
    let countedRequest = false;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const nonce = randomBytes(16).toString("base64");
        const storedLanguage = (await settings.read()).config.language;
        const language = isLanguage(storedLanguage) ? storedLanguage : options.language ?? DEFAULT_LANGUAGE;
        const html = await readFile(join(SERVER_DIRECTORY, "..", "web", "workbench.html"), "utf8");
        // The workbench ships with no build step, so the server injects the
        // resolved language and its catalog into the page directly. The page
        // then looks strings up client side, using the one catalog the runtime
        // already holds, instead of carrying a second copy of the message table.
        // `<` is escaped because a translation could otherwise contain
        // "</script>" and close the injected tag early.
        const catalogJson = JSON.stringify(catalogFor(language)).replace(/</g, "\\u003c");
        const withCatalog = html.replace(
          "</head>",
          `<script>window.KEYSTONE_LANG=${JSON.stringify(language)};window.KEYSTONE_I18N=${catalogJson};</script></head>`,
        );
        const localized = withCatalog.replace('<html lang="en">', `<html lang="${language}">`)
          .replace(/<script(?=[ >])/g, `<script nonce="${nonce}"`);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        });
        response.end(localized);
        return;
      }
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset !== undefined) {
        response.writeHead(200, {
          "content-type": asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
        });
        response.end(await readFile(asset));
        return;
      }

      if (!url.pathname.startsWith("/v1/")) {
        json(response, 404, { error: "unknown path" });
        return;
      }

      if (!authorize(request, token)) {
        json(response, 401, {
          error: "missing or invalid token",
          hint: "pass the token printed when the server started, as `Authorization: Bearer <token>`",
        });
        return;
      }

      const segments = url.pathname.slice("/v1/".length).split("/").filter((part) => part !== "");
      if (managingData) throw new HttpError(409, "data management is in progress; retry after it finishes");
      const isManagement = request.method === "POST" && segments[0] === "data" &&
        ["cleanup", "migrate"].includes(segments[1] ?? "");
      if (isManagement) {
        if (storeRequests > 0 || [...state.runs.values()].some((run) => run.status === "running")) {
          throw new HttpError(409, "finish active requests and tasks before managing data");
        }
        managingData = true;
        ownsManagement = true;
      } else {
        storeRequests += 1;
        countedRequest = true;
      }

      if (isManagement && segments[1] === "cleanup") {
        json(response, 200, await previewCleanup(paths, await readBody(request) as Parameters<typeof previewCleanup>[1]));
        return;
      }
      if (isManagement && segments[1] === "migrate") {
        const result = await migrateData(paths, await readBody(request) as Parameters<typeof migrateData>[1]);
        if (!result.preview && result.verified && result.newHome !== undefined) {
          await collaboration.dispose();
          paths = resolveKeystonePaths(result.newHome);
          projects = new ProjectRegistry(paths);
          attachments = new AttachmentStore(paths);
          settings = new SettingsStore(paths);
          extensions = new ExtensionLifecycleService(defaultRegistryLocation(paths.home));
          lab = new HarnessLabService({ reportsDirectory: join(paths.home, "lab", "reports") });
          collaboration = createLocalCollaboration({ paths: () => paths, projects: () => projects.list() });
          processors = new ProcessorService({ paths, extensions, processors: options.inputProcessors });
          runtime = await createRuntime();
          await applyConfiguredModels();
          state.runs.clear(); state.interventions.clear(); state.controls.clear();
        }
        json(response, 200, result);
        return;
      }

      if (segments[0] === "settings" && segments.length === 1) {
        if (request.method === "GET") { json(response, 200, await applyConfiguredModels()); return; }
        if (request.method === "POST") {
          await settings.save(await readBody(request) as Parameters<SettingsStore["save"]>[0]);
          json(response, 200, await applyConfiguredModels());
          return;
        }
      }
      if (segments[0] === "settings" && segments[1] === "catalog" && request.method === "GET") {
        const language = url.searchParams.get("language");
        if (!isLanguage(language)) throw new HttpError(400, "unsupported presentation language");
        json(response, 200, { language, catalog: catalogFor(language) });
        return;
      }
      if (segments[0] === "settings" && segments[1] === "probe" && request.method === "POST") {
        json(response, 200, await settings.probe(await readBody(request) as { id: string; kind: string }, options.credentials));
        return;
      }
      if (segments[0] === "attachments") {
        if (segments.length === 1 && request.method === "POST") {
          const input = await readBody(request) as Parameters<AttachmentStore["import"]>[0];
          if (await projects.get(input.projectId) === undefined) throw new HttpError(404, "project not found");
          json(response, 201, { attachment: await attachments.import(input) });
          return;
        }
        if (segments.length === 1 && request.method === "GET") {
          json(response, 200, { attachments: await attachments.list(url.searchParams.get("projectId") ?? "") });
          return;
        }
        if (segments.length === 2 && request.method === "DELETE") {
          await attachments.remove(segments[1]!); json(response, 200, { removed: true }); return;
        }
      }
      if (segments[0] === "projects") {
        if (segments.length === 3 && segments[2] === "cognition") {
          const project = await projects.get(segments[1]!);
          if (!project) throw new HttpError(404, "project not found");
          if (request.method === "POST") {
            if (project.status !== "available") throw new HttpError(409, "project workspace is unavailable");
            await runtime.attachProject(project.rootPath);
          } else if (request.method !== "GET") throw new HttpError(405, "unsupported cognition operation");
          json(response, 200, await cognitionView(paths, project.workspaceId)); return;
        }
        if (segments.length === 4 && segments[2] === "facts" && request.method === "PATCH") {
          const project = await projects.get(segments[1]!);
          if (!project) throw new HttpError(404, "project not found");
          const body = await readBody(request) as Record<string, unknown>;
          if (typeof body["expectedHash"] !== "string") throw new HttpError(400, "expectedHash is required");
          const fact = await KernelSession.editProjectFact({ paths, projectId: project.workspaceId,
            factId: segments[3]!, expectedHash: body["expectedHash"],
            ...(typeof body["statement"] === "string" ? { statement: body["statement"] } : {}),
            ...(typeof body["frozen"] === "boolean" ? { frozen: body["frozen"] } : {}),
            ...(body["invalidated"] === true ? { invalidated: true } : {}) });
          json(response, 200, { fact: { ...fact, hash: contentHash(fact) } }); return;
        }
        if (segments.length === 4 && segments[2] === "experience" && segments[3] !== "clear" && request.method === "POST") {
          const project = await projects.get(segments[1]!);
          if (!project || project.status !== "available") throw new HttpError(409, "project unavailable");
          const body = await readBody(request) as Record<string, unknown>;
          if (!["confirm", "revoke"].includes(String(body["action"]))) throw new HttpError(400, "unknown experience action");
          json(response, 200, await changeExperience(paths, project, segments[3]!, {
            action: body["action"] as "confirm" | "revoke",
            ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}) })); return;
        }
        if (segments.length === 1 && request.method === "GET") {
          json(response, 200, { projects: await projects.list() }); return;
        }
        if (segments.length === 1 && request.method === "POST") {
          json(response, 201, { project: await projects.register(await readBody(request) as Parameters<ProjectRegistry["register"]>[0]) }); return;
        }
        if (segments.length === 2 && request.method === "PATCH") {
          json(response, 200, { project: await projects.update(segments[1]!, await readBody(request) as Parameters<ProjectRegistry["update"]>[1]) }); return;
        }
        if (segments.length === 2 && request.method === "DELETE") {
          json(response, 200, await projects.remove(segments[1]!)); return;
        }
        if (segments.length === 3 && segments[2] === "commands" && request.method === "POST") {
          const project = await projects.get(segments[1]!);
          if (project?.status !== "available") throw new HttpError(409, "project workspace is unavailable");
          try {
            json(response, 200, await runHumanCommand(paths, runtime, project, await readBody(request) as Parameters<typeof runHumanCommand>[3]));
          } catch (error) {
            if (error instanceof WorkspaceBusyError) throw error;
            throw new HttpError(400, error instanceof Error ? error.message : "command refused");
          }
          return;
        }
        if (segments.length === 3 && ["files", "file", "search"].includes(segments[2]!)) {
          const project = await projects.get(segments[1]!);
          if (project === undefined) throw new HttpError(404, "project not found");
          if (project.status !== "available") throw new HttpError(409, "project workspace is unavailable");
          const files = new FileWorkspaceService({
            rootPath: project.rootPath, paths,
            boundary: humanFileBoundary(paths, runtime, project),
          });
          if (request.method === "GET" && segments[2] === "files") {
            json(response, 200, await files.tree({
              path: url.searchParams.get("path") ?? ".",
              offset: Number(url.searchParams.get("offset") ?? 0),
              limit: Number(url.searchParams.get("limit") ?? 100),
            })); return;
          }
          if (request.method === "GET" && segments[2] === "file") {
            json(response, 200, await files.read({ path: url.searchParams.get("path") ?? "" })); return;
          }
          if (request.method === "GET" && segments[2] === "search") {
            json(response, 200, await files.search({ q: url.searchParams.get("q") ?? "" })); return;
          }
          if (request.method === "POST" && segments[2] === "files") {
            json(response, 200, await files.mutate(await readBody(request) as Parameters<FileWorkspaceService["mutate"]>[0]));
            return;
          }
        }
      }

      if (segments[0] === "extensions") {
        if (segments.length === 1 && request.method === "GET") {
          json(response, 200, { extensions: await extensions.list(), supportedKinds: ["tool", "verifier", "skill", "protocol"] }); return;
        }
        if (segments.length === 2 && segments[1] === "review" && request.method === "POST") {
          const body = await readBody(request) as Record<string, unknown>;
          json(response, 200, await extensions.review(String(body["directory"] ?? body["path"] ?? ""))); return;
        }
        if (segments.length === 2 && segments[1] === "install" && request.method === "POST") {
          const body = await readBody(request) as Record<string, unknown>;
          json(response, 200, await extensions.install(String(body["directory"] ?? body["path"] ?? ""),
            String(body["reviewHash"] ?? ""), body["confirmed"] === true)); return;
        }
        if (segments.length === 3 && request.method === "POST") {
          const body = await readBody(request) as Record<string, unknown>;
          const name = segments[1]!, action = segments[2]!;
          if (body["confirmed"] !== true) throw new HttpError(400, "explicit extension action confirmation required");
          if (action === "disable") { json(response, 200, await extensions.disable(name)); return; }
          if (action === "uninstall") { json(response, 200, await extensions.uninstall(name)); return; }
          const entry = (await extensions.list()).find((item) => item.manifest.name === name);
          if (!entry) throw new HttpError(404, "extension not found");
          const hash = String(body["reviewHash"] ?? "");
          const decision = userDecisionSchema.parse({ decisionId: newId("dec"),
            taskId: newId("task"), branchId: newId("branch"), at: nowIso(), recordedBy: "user",
            decision: "allow", rationale: `authenticated workbench ${action} confirmation`,
            appliesTo: { capability: "extension.activate", resources: [
              extensionDecisionResource(entry.manifest, hash, action === "probe" ? "probe" : "activate")],
              expiresAt: new Date(Date.now() + 60000).toISOString() } });
          if (action === "probe") {
            json(response, 200, await extensions.probe(name, { reviewHash: hash, decision })); return;
          }
          if (action === "activate") {
            json(response, 200, await extensions.activate(name, { reviewHash: hash, decision })); return;
          }
        }
      }
      if (segments[0] === "lab") {
        if (request.method === "GET") { json(response, 200, { reports: await lab.list() }); return; }
        if (request.method === "POST") {
          const body = await readBody(request) as Record<string, unknown>;
          if (body["confirmed"] !== true) throw new HttpError(400, "explicit isolated Lab confirmation required");
          const directory = String(body["directory"] ?? body["path"] ?? "");
          const review = await extensions.review(directory);
          if (body["reviewHash"] !== review.reviewHash) throw new HttpError(409, "Lab review changed");
          const decision = userDecisionSchema.parse({ decisionId: newId("dec"), taskId: newId("task"),
            branchId: newId("branch"), at: nowIso(), decision: "allow", recordedBy: "user",
            rationale: "authenticated isolated conformance probe confirmation",
            appliesTo: { capability: "extension.activate", resources: [
              extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")] } });
          json(response, 200, await lab.run(directory, { reviewHash: review.reviewHash, decision })); return;
        }
      }
      if (segments[0] === "collaboration") {
        const address = server.address();
        const currentPort = typeof address === "object" && address !== null ? address.port : 0;
        if ((request.headers.origin !== undefined &&
          ![`http://127.0.0.1:${currentPort}`, `http://localhost:${currentPort}`].includes(request.headers.origin)) ||
          request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "local collaboration origin required");
        const result = await collaboration.service.handle(request.method ?? "GET", url.pathname,
          request.method === "GET" ? undefined : await readBody(request), { authenticated: true, source: "local_ui" });
        json(response, result.status, result.body); return;
      }
      if (segments[0] === "input-processors") {
        const aborter = new AbortController();
        request.once("aborted", () => aborter.abort());
        response.once("close", () => { if (!response.writableEnded) aborter.abort(); });
        const result = await routeInputProcessors(processors, { method: request.method ?? "GET",
          pathname: url.pathname, body: request.method === "GET" ? undefined : await readBody(request),
          signal: aborter.signal, ...(url.searchParams.get("projectId") === null
            ? {} : { projectId: url.searchParams.get("projectId")! }) });
        if (result) { if (!response.destroyed) json(response, result.status, result.body); return; }
      }
      if (segments[0] === "release" && segments[1] === "readiness" && request.method === "GET") {
        const directory = join(paths.home, "release");
        const input = await readFile(join(directory, "readiness-input.json"), "utf8").catch(() => undefined);
        json(response, 200, input ? await checkReleaseReadiness(JSON.parse(input), { root: directory }) :
          { localReady: false, stableReady: false, channel: "rc",
            gates: STABLE_GATES.map((gateId) => ({ gateId, status: "missing", reason: "No verified release evidence supplied." })) });
        return;
      }

      // GET /v1/capabilities — what this runtime can do, so a client can refuse
      // to pretend it understands more than it does (NFR-COMP-03).
      if (request.method === "GET" && segments[0] === "capabilities") {
        // Read-only visibility: which low-risk extensions are active. Listing an
        // extension never grants anything — the kernel still issues every lease
        // against the user's envelope — so this is safe to expose to a shell.
        const registry = new ExtensionRegistry(defaultRegistryLocation(paths.home));
        await registry.load();
        json(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          mode,
          modeCapabilities: modeCapabilities(mode),
          taskStatuses: TASK_STATUSES,
          evidenceLevels: ["E0", "E1", "E2", "E3", "E4"],
          egress: runtime.describeEgress(),
          extensions: lowRiskActiveExtensions(registry.list()),
        });
        return;
      }

      // POST /v1/contract/preview — draft a readable Outcome Contract WITHOUT
      // creating a task, a session, a ledger event or any workspace write
      // (ADR-0008, Decision E). A write task uses this to show the human what it
      // intends to bind to before `POST /v1/tasks` does anything. It resolves the
      // project id, runs the read-only profile detection, builds the autonomy
      // envelope the real run would use, and calls the pure engineering
      // `compileContract`. The projection is the same one task detail serves, so
      // what the user reads before confirming is what the run will bind.
      if (request.method === "POST" && segments[0] === "contract" && segments[1] === "preview") {
        const body = (await readBody(request)) as Record<string, unknown>;
        const workspacePath = String(body["workspacePath"] ?? "");
        const requestText = String(body["request"] ?? "");
        if (workspacePath === "" || requestText === "") {
          json(response, 400, { error: "workspacePath and request are required" });
          return;
        }
        const writePaths = Array.isArray(body["writePaths"])
          ? (body["writePaths"] as readonly unknown[]).map((value) => String(value))
          : [];
        const allowedCommands = Array.isArray(body["allowedCommands"])
          ? (body["allowedCommands"] as readonly unknown[]).map((value) => String(value))
          : [];
        const userConfirmAllWrites = body["confirmAllWrites"] === true;
        try {
          const graded = await gradeSubmission({
            workspacePath,
            requestText,
            writePaths,
            allowedCommands,
            references: Array.isArray(body["references"])
              ? (body["references"] as readonly {
                  kind: "file" | "directory" | "issue" | "log" | "url" | "text";
                  value: string;
                }[])
              : [],
            userConfirmAllWrites,
            defaults: (await settings.read()).config.defaults,
          });
          json(response, 200, {
            contract: projectContract(graded.contract),
            // The contract's inferred write scope may be empty on its own; the
            // boundary the user is actually being asked to grant is the envelope
            // we built from their write paths. Surface it so the confirmation
            // modal shows exactly what may change.
            writePaths: graded.autonomy.writePaths,
            allowedCommands: graded.autonomy.allowedCommands,
            questions: graded.questions.map((question) => ({
              questionId: question.questionId,
              question: question.question,
              affects: question.affects,
              suggestedAnswer: question.suggestedAnswer,
            })),
            // The server-authoritative startup grade (ADR-0013). The workbench
            // renders this: an `auto_start` result still shows the preview,
            // then begins without an extra click; `require_confirmation` names
            // its reasons; `refuse` shows the dirty-overlap recovery.
            risk: projectRisk(graded.risk),
          });
        } catch (error) {
          // An unreadable path, a non-Git workspace or a profile the pack refuses
          // to read is a client problem: the preview cannot be drafted, so say so
          // rather than starting a task that would fail the same way.
          json(response, 400, {
            error: `the contract could not be previewed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      if (request.method === "GET" && segments[0] === "tasks" && segments.length === 1) {
        json(response, 200, { tasks: await listTaskSummaries(paths, state.runs) });
        return;
      }

      if (segments[0] === "tasks" && segments[1] !== undefined) {
        const taskId = segments[1];
        if (segments[2] === "start" && request.method === "POST") {
          if (state.runs.get(taskId)?.status === "running") throw new HttpError(409, "task is already running");
          const body = await readBody(request) as Record<string, unknown>;
          json(response, 202, await startRun(body, taskId));
          return;
        }
        if (segments[2] === "verify-comparison" && request.method === "POST") {
          if (state.runs.get(taskId)?.status === "running") {
            throw new HttpError(409, "pause or finish the source task before historical comparison");
          }
          const body = await readBody(request) as Record<string, unknown>;
          if (body["confirmed"] !== true) {
            throw new HttpError(409, "explicit baseline comparison confirmation required");
          }
          const aborter = new AbortController();
          request.once("aborted", () => aborter.abort());
          response.once("close", () => { if (!response.writableEnded) aborter.abort(); });
          try {
            const report = await compareBaselineCandidate(paths, taskId, {
              confirmed: true,
              ...(body["maxWallClockMs"] === undefined ? {} : { maxWallClockMs: Number(body["maxWallClockMs"]) }),
              ...(body["timeoutMs"] === undefined ? {} : { timeoutMs: Number(body["timeoutMs"]) }),
              signal: aborter.signal,
            });
            if (!response.destroyed) json(response, 200, report);
          } catch (error) {
            throw new HttpError(409, aborter.signal.aborted
              ? "baseline comparison cancelled; source task and workspace were not changed"
              : error instanceof Error ? error.message : "baseline comparison refused");
          }
          return;
        }
        if (segments[2] === "branches" && request.method === "GET") {
          json(response, 200, { branches: await continuousBranchViews(paths, taskId) }); return;
        }
        if (segments[2] === "branches" && request.method === "POST") {
          if (state.runs.get(taskId)?.status === "running") throw new HttpError(409, "pause the source task before forking");
          const body = await readBody(request) as Record<string, unknown>;
          try { json(response, 200, await forkContinuousBranch(paths, taskId, {
            checkpointId: String(body["checkpointId"] ?? ""), label: String(body["label"] ?? ""),
            ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}) })); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "fork refused"); }
          return;
        }
        if (segments[2] === "compare" && request.method === "GET") {
          try { json(response, 200, await compareContinuousBranches(paths, taskId,
            url.searchParams.get("left") ?? "", url.searchParams.get("right") ?? "")); }
          catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "comparison refused"); }
          return;
        }
        if (segments[2] === "resume" && request.method === "POST") {
          if (state.runs.get(taskId)?.status === "running") throw new HttpError(409, "task is already running");
          const body = await readBody(request) as Record<string, unknown>;
          await applyConfiguredModels();
          const aborter = new AbortController();
          let announced = false;
          let announce: (value: unknown) => void = () => undefined;
          let rejectStart: (reason: unknown) => void = () => undefined;
          const ready = new Promise((resolve, reject) => { announce = resolve; rejectStart = reject; });
          const continuation = runtime.resumeTask(taskId, {
            signal: aborter.signal, control: async () => state.controls.get(taskId)?.shift(),
            onTaskCreated: () => {
              state.aborters.set(taskId, aborter);
              state.runs.set(taskId, { taskId, status: "running", startedAt: nowIso(), interventions: [] });
              announced = true; announce({ taskId, status: "running" });
            },
            onIntervention: async (intervention) => {
              state.interventions.set(intervention.interventionId, intervention);
              state.runs.get(taskId)?.interventions.push(intervention);
              return new Promise<UserDecision | undefined>((resolve) => {
                const timer = setTimeout(() => { state.pending.delete(intervention.interventionId); resolve(undefined); }, interventionTimeoutMs);
                timer.unref();
                state.pending.set(intervention.interventionId, (decision) => { clearTimeout(timer); resolve(decision); });
              });
            },
          }, typeof body["branchId"] === "string" ? body["branchId"] : undefined).then((result) => {
            state.aborters.delete(taskId);
            state.runs.set(taskId, { taskId, status: "finished", result,
              startedAt: state.runs.get(taskId)?.startedAt ?? nowIso(),
              interventions: state.runs.get(taskId)?.interventions ?? [] });
          }).catch((error) => {
            state.aborters.delete(taskId);
            if (!announced) rejectStart(new HttpError(409, error instanceof Error ? error.message : "resume refused"));
            else state.runs.set(taskId, { taskId, status: "failed", error: error instanceof Error ? error.message : "resume failed",
              startedAt: state.runs.get(taskId)?.startedAt ?? nowIso(), interventions: [] });
          });
          void continuation;
          json(response, 202, await ready); return;
        }
        if (request.method === "GET" && segments[2] === "artifacts" && segments[3] !== undefined) {
          const artifactId = artifactIdValidator.parse(segments[3]);
          const session = await KernelSession.open({ paths, taskId: taskId as never });
          const references = JSON.stringify(session.events());
          if (!references.includes(`"${artifactId}"`)) throw new HttpError(404, "artifact is not referenced by this task");
          const { getArtifactBytes } = await import("@keystone/kernel");
          const bytes = await getArtifactBytes(paths, artifactId);
          if (bytes === undefined) throw new HttpError(404, "artifact is unavailable");
          json(response, 200, { artifactId, content: new TextDecoder().decode(bytes.slice(0, 1_000_000)), truncated: bytes.length > 1_000_000 });
          return;
        }

        if (request.method === "GET" && segments.length === 2) {
          json(response, 200, await taskDetail(paths, taskId));
          return;
        }

        if (request.method === "GET" && segments[2] === "events") {
          const since = Number(url.searchParams.get("since") ?? "0");
          const ledger = await readLedger(paths.ledgerFile(taskId as never));
          const events = ledger.events
            .filter((event) => event.seq > (Number.isFinite(since) ? since : 0))
            .map((event) => ({
              seq: event.seq,
              type: event.type,
              at: event.at,
              actor: event.actor,
              payload: event.payload,
            }));
          json(response, 200, {
            events,
            integrity: ledger.integrity,
            tornTail: ledger.tornTail,
          });
          return;
        }

        if (request.method === "GET" && segments[2] === "proof") {
          const session = await KernelSession.open({ paths, taskId: taskId as never });
          if (session.contract() === undefined) {
            // A task in `draft` has no contract yet, so it has nothing to prove.
            // That is a normal state, not a server fault.
            json(response, 404, {
              error: "this task has no contract yet, so there is no proof",
            });
            return;
          }
          const changedPaths = await changedPathsForTask(paths, taskId);
          const diff = await taskWorktreeDiff(paths, taskId);
          const current = diff.rootPath === null ? undefined : await observeWorkspace(diff.rootPath).catch(() => undefined);
          json(response, 200, await session.exportProof({
            changedPaths, workspaceFingerprint: current?.fingerprint ?? contentHash({ workspace: "unavailable", taskId }),
          }));
          return;
        }

        if (request.method === "POST" && segments[2] === "decisions") {
          const body = (await readBody(request)) as Record<string, unknown>;
          const interventionId = String(body["interventionId"] ?? "");
          const intervention = state.interventions.get(interventionId);
          if (intervention === undefined) {
            json(response, 404, {
              error: "no open intervention with that id",
              hint: "read /v1/tasks/:id to see the interventions that are actually waiting",
            });
            return;
          }

          // Validated here rather than left to the schema, whose failure would be
          // an unhelpful 500: a decision must name a choice and record a reason,
          // because the reason is what makes the decision reviewable later
          // (PRD HI-03).
          const choice = String(body["decision"] ?? "");
          if (!(USER_DECISIONS as readonly string[]).includes(choice)) {
            json(response, 400, {
              error: `decision must be one of: ${USER_DECISIONS.join(", ")}`,
            });
            return;
          }
          const rationale = typeof body["rationale"] === "string" ? body["rationale"].trim() : "";
          if (rationale === "") {
            json(response, 400, { error: "a decision must record a rationale" });
            return;
          }

          const decision = userDecisionSchema.parse({
            decisionId: newId("dec"),
            interventionId,
            taskId,
            branchId: intervention.branchId,
            at: nowIso(),
            decision: choice,
            rationale,
            appliesTo: {
              ...(body["grants"] === undefined
                ? {}
                : { capability: body["grants"] as Capability }),
              resources: Array.isArray(body["resources"])
                ? (body["resources"] as readonly string[])
                : [],
              ...(body["expiresAt"] === undefined
                ? {}
                : { expiresAt: String(body["expiresAt"]) as never }),
            },
            // The schema fixes this to the literal `user`, because a decision is
            // the one thing a model or a client must never be able to fabricate
            // (PRD HI-03, 11.2). The server can only record that a user answered;
            // it cannot answer on their behalf.
            recordedBy: "user",
          }) as UserDecision;

          const resolve = state.pending.get(interventionId);
          if (resolve === undefined) {
            json(response, 409, { error: "the intervention is no longer waiting for an answer" });
            return;
          }
          state.pending.delete(interventionId);
          const open = state.runs.get(taskId)?.interventions;
          if (open !== undefined) {
            const index = open.findIndex((entry) => entry.interventionId === interventionId);
            if (index !== -1) open.splice(index, 1);
          }
          resolve(decision);
          json(response, 200, { recorded: true, decisionId: decision.decisionId });
          return;
        }

        if (request.method === "GET" && segments[2] === "run") {
          const run = state.runs.get(taskId);
          if (run === undefined) {
            json(response, 404, { error: "no run is recorded for this task in this server session" });
            return;
          }
          json(response, 200, {
            taskId: run.taskId,
            status: run.status,
            startedAt: run.startedAt,
            ...(run.error === undefined ? {} : { error: run.error }),
            ...(run.result === undefined
              ? {}
              : {
                  taskStatus: run.result.status,
                  steps: run.result.steps,
                  changedPaths: run.result.changedPaths,
                  reasons: run.result.reasons,
                  learning: run.result.learning,
                  degraded: run.result.degraded ?? null,
                  isolatedWorkspace: run.result.isolatedWorkspace ?? null,
                }),
            pendingInterventions: run.interventions,
          });
          return;
        }

        // GET /v1/tasks/:id/checkpoints — the restore points a reviewer can see.
        if (request.method === "GET" && segments[2] === "checkpoints") {
          const checkpoints = await listCheckpoints(paths, taskId);
          json(response, 200, {
            checkpoints: checkpoints
              .map((checkpoint) => ({
                checkpointId: checkpoint.checkpointId,
                branchId: checkpoint.branchId,
                seq: checkpoint.seq,
                reason: checkpoint.reason,
                createdAt: checkpoint.createdAt,
                parentCheckpointId: checkpoint.parentCheckpointId ?? null,
                contractVersion: checkpoint.contractVersion ?? null,
              }))
              .sort((a, b) => a.seq - b.seq),
          });
          return;
        }

        // GET /v1/tasks/:id/diff — the change itself, recomputed read-only.
        if (request.method === "GET" && segments[2] === "diff") {
          json(response, 200, await taskWorktreeDiff(paths, taskId));
          return;
        }

        // POST /v1/tasks/:id/contract — revise the Outcome Contract (PRD OT-03).
        //
        // A revision is a *mid-flight* operation: the kernel only permits it while
        // a task is ready or working, so it is queued for the running task to
        // apply rather than written here. A second session writing now would
        // compute its chain tip from its own stale event log and fork the hash
        // chain (ADR-0003).
        if (request.method === "POST" && segments[2] === "contract") {
          const body = (await readBody(request)) as Record<string, unknown>;
          const session = await KernelSession.open({
            paths,
            taskId: taskId as never,
            actorId: "workbench",
          });
          const current = session.contract();
          if (current === undefined) {
            json(response, 400, { error: "this task has no contract to revise" });
            return;
          }
          const revision = buildRevision(body, current);
          if (revision === undefined) {
            json(response, 400, {
              error: "a revision needs at least one of: goal, writePaths, budget",
            });
            return;
          }
          if (state.runs.get(taskId)?.status !== "running") {
            json(response, 409, {
              error:
                "a revision applies to a task that is still working; start or resume it and " +
                "send the revision while it runs",
            });
            return;
          }
          queueControl(state, taskId, {
            kind: "revise",
            patch: revision,
            reason: revisionReason(body),
          });
          json(response, 202, { queued: true, taskId, kind: "revise" });
          return;
        }

        // POST /v1/tasks/:id/control — pause or stop a task (PRD 7.1, UI-05).
        //
        // While a run is in flight the request is queued and the run applies it
        // at its next step boundary; a second session writing now would fork the
        // ledger (ADR-0003). With no run in flight it is applied directly: pause
        // and stop are the user's unconditional rights, and their only legal
        // target is a task that is still active.
        if (request.method === "POST" && segments[2] === "control") {
          const body = (await readBody(request)) as Record<string, unknown>;
          const kind = String(body["kind"] ?? "");
          if (kind !== "pause" && kind !== "stop") {
            json(response, 400, { error: 'kind must be one of "pause", "stop"' });
            return;
          }
          const reason =
            typeof body["reason"] === "string" && body["reason"].trim() !== ""
              ? body["reason"].trim()
              : `the user asked the task to ${kind}`;

          if (state.runs.get(taskId)?.status === "running") {
            queueControl(state, taskId, { kind, reason });
            json(response, 202, { queued: true, taskId, kind });
            return;
          }

          try {
            const session = await KernelSession.open({
              paths,
              taskId: taskId as never,
              actorId: "workbench",
            });
            if (kind === "pause") await session.pause(reason, true);
            else await session.stop(reason, true);
            json(response, 200, { queued: false, taskId, kind, status: session.state().status });
          } catch (error) {
            // A transition that is not legal in the current status is a client
            // problem, not a server fault.
            json(response, 409, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }

        // DELETE /v1/tasks/:id — remove this task's stored history (PRD ST-02).
        if (request.method === "DELETE" && segments.length === 2) {
          try {
            json(response, 200, { removed: await deleteTaskHistory(paths, taskId) });
          } catch (error) {
            if (!(error instanceof DataError)) throw error;
            json(response, dataErrorStatus(error), { error: error.message });
          }
          return;
        }
      }

      // GET /v1/data — what is stored locally, and how much of it (PRD ST-02).
      if (request.method === "GET" && segments[0] === "data" && segments.length === 1) {
        json(response, 200, await storeInventory(paths));
        return;
      }

      // POST /v1/projects/:id/experience/clear — drop a project's experience cache.
      if (
        request.method === "POST" &&
        segments[0] === "projects" &&
        segments[1] !== undefined &&
        segments[2] === "experience" &&
        segments[3] === "clear"
      ) {
        try {
          json(response, 200, { cleared: await clearProjectExperience(paths, segments[1]) });
        } catch (error) {
          if (!(error instanceof DataError)) throw error;
          json(response, dataErrorStatus(error), { error: error.message });
        }
        return;
      }

      if (request.method === "POST" && segments[0] === "tasks" && segments.length === 1) {
        const body = (await readBody(request)) as Record<string, unknown>;
        json(response, 202, await startRun(body));
        return;
      }

      json(response, 404, { error: "unknown endpoint" });
    } catch (error) {
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof LocalPackageError) { json(response, 400, { error: error.message }); return; }
      if (error instanceof SettingsError || error instanceof AttachmentError || error instanceof ProjectServiceError || error instanceof FileServiceError) {
        json(response, error.status, { error: error.message }); return;
      }
      if (error instanceof WorkspaceBusyError) { json(response, 409, { error: error.message }); return; }
      if (error instanceof DataError) {
        json(response, error.status, { error: error.message, code: error.code, ...(error.impact === undefined ? {} : { impact: error.impact }) });
        return;
      }
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (countedRequest) storeRequests -= 1;
      if (ownsManagement) managingData = false;
    }
  };

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    token,
    protocolVersion: PROTOCOL_VERSION,
    async close(): Promise<void> {
      await collaboration.dispose();
      for (const [taskId] of state.aborters) queueControl(state, taskId, { kind: "stop", reason: "server closed" });
      for (const resolve of state.pending.values()) resolve(undefined);
      state.pending.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * The change set a task actually produced is derived from its own ledger by
 * `changedPathsForTask` (see ./diff.ts), so the proof a client sees on another
 * machine states the same change set as the one produced locally (DP-01, EX-02).
 */

/** Project the auditable start risk onto the wire (ADR-0013). */
function projectRisk(risk: StartRiskResult): Record<string, unknown> {
  return {
    decision: risk.decision,
    reasons: risk.reasons,
    ...(risk.dirtyOverlap.length === 0 ? {} : { dirtyOverlap: risk.dirtyOverlap }),
    ...(risk.recovery === undefined ? {} : { recovery: risk.recovery }),
    inputs: {
      openQuestionCount: risk.audited.openQuestionCount,
      scopeUnknown: risk.audited.scopeUnknown,
      maxReversibility: risk.audited.maxReversibility,
      externalSystems: risk.audited.externalSystems,
      allowedHosts: risk.audited.allowedHosts,
      policy: risk.audited.policy,
    },
  };
}

/** HTTP status for a data-management refusal, so the client can react to it. */
function dataErrorStatus(error: DataError): number {
  switch (error.code) {
    case "not_found":
      return 404;
    case "task_active":
      return 409;
    default:
      return 400;
  }
}

function buildAutonomy(
  projectId: string,
  writePaths: readonly string[],
  allowedCommands: readonly string[],
  defaults?: Partial<Budget>,
): AutonomyEnvelope {
  // Built from the real project id and nothing else. An omitted `writePaths`
  // therefore produces an envelope with no writable path, so a caller that
  // forgot to say what may change gets a task that cannot change anything —
  // rather than one that can change everything.
  return autonomyEnvelopeSchema.parse({
    projectId,
    readPaths: ["**"],
    writePaths: [...writePaths],
    allowedCommands: [...allowedCommands],
    allowedHosts: [],
    allowedCredentials: [],
    externalSystems: "none",
    maxReversibility: "reversible",
    untrustedContentEgress: "deny_all",
    budget: { maxTokens: 300_000, maxWallClockMs: 7_200_000, maxRetries: 3, ...defaults },
    updatedAt: nowIso(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}

/**
 * Read-only contract draft + risk grade for one submission (ADR-0013).
 *
 * Shared by the preview endpoint and the start path so both derive the grade
 * from the identical inputs. It creates no session, no task and no ledger
 * event. The dirty-worktree probe is best-effort: a workspace we cannot read
 * as Git is refused by the compile step anyway, so an empty overlap here must
 * never *permit* a task the compile step would reject.
 */
async function gradeSubmission(input: {
  readonly workspacePath: string;
  readonly requestText: string;
  readonly writePaths: readonly string[];
  readonly allowedCommands: readonly string[];
  readonly references: readonly {
    readonly kind: "file" | "directory" | "issue" | "log" | "url" | "text";
    readonly value: string;
  }[];
  readonly userConfirmAllWrites: boolean;
  readonly defaults?: Partial<Budget>;
}): Promise<{
  readonly projectId: string;
  readonly autonomy: AutonomyEnvelope;
  readonly contract: OutcomeContract;
  readonly questions: {
    readonly questionId: string;
    readonly question: string;
    readonly affects: string;
    readonly suggestedAnswer: string;
  }[];
  readonly risk: StartRiskResult;
}> {
  const projectId = await projectIdForWorkspace(input.workspacePath);
  const profile = await detectProjectProfile(input.workspacePath, projectId);
  const autonomy = buildAutonomy(projectId, input.writePaths, input.allowedCommands, input.defaults);
  const proposal = compileContract({
    taskId: newId("task"),
    projectId,
    request: input.requestText,
    profile,
    autonomy,
    // The workbench derives one reference per write path so the compiler's
    // scope matches what the user typed; without it the scope is "unknown" and
    // every write is conservatively graded scope_expansion.
    ...(input.references.length > 0 ? { references: input.references } : {}),
  });

  const writePatterns = proposal.contract.scope.include
    .filter((entry) => entry.intent === "write")
    .map((entry) => entry.pattern);
  const dirtyPaths = await listDirtyPaths(input.workspacePath).catch(() => [] as readonly string[]);
  const dirtyOverlap = findDirtyOverlap(dirtyPaths, writePatterns);
  const policy = await resolveStartPolicy(input.workspacePath, input.userConfirmAllWrites);

  const risk = gradeStartRisk({
    contract: proposal.contract,
    envelope: autonomy,
    questions: proposal.questions.map((question) => ({
      questionId: question.questionId,
      affects: question.affects,
    })),
    userWritePaths: input.writePaths,
    dirtyOverlap,
    policy,
  });

  return {
    projectId,
    autonomy,
    contract: proposal.contract,
    questions: proposal.questions.map((question) => ({
      questionId: question.questionId,
      question: question.question,
      affects: question.affects,
      suggestedAnswer: question.suggestedAnswer,
    })),
    risk,
  };
}
