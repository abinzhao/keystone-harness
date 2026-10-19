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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogFor, DEFAULT_LANGUAGE, type Language } from "@keystone/i18n";
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
import type { ModelAdapter, ModelRole } from "@keystone/models";
import {
  autonomyEnvelopeSchema,
  newId,
  nowIso,
  userDecisionSchema,
  USER_DECISIONS,
  TASK_STATUSES,
  type AutonomyEnvelope,
  type Budget,
  type Capability,
  type InterventionRequest,
  type OutcomeContract,
  type Scope,
  type UserDecision,
} from "@keystone/schemas";

import { clearProjectExperience, DataError, deleteTaskHistory, storeInventory } from "./data.ts";
import { changedPathsForTask, taskWorktreeDiff } from "./diff.ts";
import {
  KeystoneRuntime,
  type RunControlRequest,
  type RunTaskOptions,
  type RunTaskResult,
} from "./keystone-runtime.ts";
import { modeCapabilities, type RunMode } from "./modes.ts";

const SERVER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = "keystone.run.protocol@1.0.0";
const DEFAULT_INTERVENTION_TIMEOUT_MS = 10 * 60_000;

export interface ServeOptions {
  readonly paths?: KeystonePaths;
  readonly models?: readonly ModelAdapter[];
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
    if (size > 2_000_000) throw new Error("request body is too large");
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
  const writes = unique.map((pattern) => ({
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
  const paths = options.paths ?? resolveKeystonePaths();
  const mode: RunMode = options.mode ?? "standard";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const interventionTimeoutMs = options.interventionTimeoutMs ?? DEFAULT_INTERVENTION_TIMEOUT_MS;
  const state = new ServeState();

  const runtime = await KeystoneRuntime.create({
    paths,
    models: options.models ?? [],
    ...(options.routes === undefined ? {} : { routes: options.routes }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    actorId: "serve",
  });

  /** Start a run and answer immediately; decisions arrive over HTTP. */
  const startRun = async (body: Record<string, unknown>): Promise<{ taskId: string }> => {
    const workspacePath = String(body["workspacePath"] ?? "");
    const request = String(body["request"] ?? "");
    if (workspacePath === "" || request === "") {
      throw new HttpError(400, "workspacePath and request are required");
    }
    const projectId = await projectIdForWorkspace(workspacePath);

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

    const completion = runtime
      .runTask({
        workspacePath,
        request,
        ...(Array.isArray(body["references"])
          ? { references: body["references"] as RunTaskOptions["references"] }
          : {}),
        autonomy: buildAutonomy(
          projectId,
          Array.isArray(body["writePaths"]) ? (body["writePaths"] as readonly string[]) : [],
          Array.isArray(body["allowedCommands"])
            ? (body["allowedCommands"] as readonly string[])
            : [],
        ),
        ...(body["acceptContract"] === true ? { acceptContractAutomatically: true } : {}),
        // The run applies queued pause/stop/revision itself, because it is the
        // session's only writer while it is in flight (ADR-0003).
        control: async () => state.controls.get(taskId ?? "")?.shift(),
        onTaskCreated: (created_) => {
          taskId = created_;
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
            state.pending.set(intervention.interventionId, resolve);
            // An unanswered question must not hold the run open forever; giving
            // up is honest, blocking indefinitely is not.
            setTimeout(() => {
              if (state.pending.delete(intervention.interventionId)) resolve(undefined);
            }, interventionTimeoutMs);
          });
        },
      })
      .then((result) => {
        if (taskId !== undefined) {
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
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const language = options.language ?? DEFAULT_LANGUAGE;
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
        const localized = withCatalog.replace('<html lang="en">', `<html lang="${language}">`);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        response.end(localized);
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

      // GET /v1/capabilities — what this runtime can do, so a client can refuse
      // to pretend it understands more than it does (NFR-COMP-03).
      if (request.method === "GET" && segments[0] === "capabilities") {
        json(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          mode,
          modeCapabilities: modeCapabilities(mode),
          taskStatuses: TASK_STATUSES,
          evidenceLevels: ["E0", "E1", "E2", "E3", "E4"],
          egress: runtime.describeEgress(),
        });
        return;
      }

      if (request.method === "GET" && segments[0] === "tasks" && segments.length === 1) {
        json(response, 200, { tasks: await listTaskSummaries(paths, state.runs) });
        return;
      }

      if (segments[0] === "tasks" && segments[1] !== undefined) {
        const taskId = segments[1];

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
          json(response, 200, await session.exportProof({ changedPaths }));
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
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
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
    budget: { maxTokens: 300_000, maxWallClockMs: 7_200_000, maxRetries: 3 },
    updatedAt: nowIso(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}
