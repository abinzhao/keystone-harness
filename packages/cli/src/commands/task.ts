/**
 * `keystone task` — run, inspect, recover, branch and compare tasks.
 *
 * This is the command surface PRD 14 (the first-run acceptance loop) exercises
 * headlessly. It reimplements none of the kernel's logic: every state change
 * goes through `KernelSession`, and every run goes through `KeystoneRuntime`.
 *
 * Exit-code semantics (stable, so CI can branch on them):
 *   0  the task is `proven`
 *   3  human attention is required (a pending decision, or a contract that
 *      needs confirmation) — the run stopped, it did not fail
 *   1  any other failure
 *   2  the invocation itself was wrong (bad flag/usage)
 */

import { open as openFile, readFile } from "node:fs/promises";

import type { Translator } from "@keystone/i18n";
import {
  canResume,
  compareBranches,
  defaultEnvelope,
  describeRecovery,
  KernelSession,
  listBranches,
  projectIdForWorkspace,
  scanWorkspace,
  summarizeBranch,
} from "@keystone/kernel";
import {
  buildAdapter,
  createSequenceAdapter,
  enabledModels,
  FileCredentialStore,
  loadConfig,
  routeFor,
  scriptedModelDescriptor,
  type ModelAdapter,
  type ModelRole,
} from "@keystone/models";
import { KeystoneRuntime, type RunMode } from "@keystone/runtime";
import {
  autonomyEnvelopeSchema,
  newId,
  nowIso,
  runBranchSchema,
  userDecisionSchema,
  type AutonomyEnvelope,
  type BranchSummary,
  type Capability,
  type InterventionRequest,
  type RunBranch,
  type UserDecision,
} from "@keystone/schemas";

import {
  getBoolean,
  getList,
  getString,
  parseArgs,
  requireString,
  UsageError,
} from "../args.ts";
import { createOutput, type Output } from "../output.ts";
import {
  budgetFrom,
  collectChangedPaths,
  parsePositiveInt,
  pathsFor,
  readWorkspaceRoot,
  toTaskId,
  translatorForContext,
  type CliContext,
  type CommandModule,
} from "./shared.ts";

const REF_KINDS = ["file", "directory", "issue", "log", "url", "text"] as const;
type RefKind = (typeof REF_KINDS)[number];

const RUN_MODES = ["minimal", "standard", "isolated", "replay"] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseReferences(
  raw: readonly string[],
): { kind: RefKind; value: string }[] {
  return raw.map((entry) => {
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new UsageError(`--ref must look like <kind>:<value>, received "${entry}"`);
    }
    const kind = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!(REF_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(`--ref kind must be one of ${REF_KINDS.join("|")}, received "${kind}"`);
    }
    if (value.trim() === "") {
      throw new UsageError(`--ref value must not be empty ("${entry}")`);
    }
    return { kind: kind as RefKind, value };
  });
}

function parseMode(value: string | undefined): RunMode {
  if (value === undefined) return "standard";
  if (!(RUN_MODES as readonly string[]).includes(value)) {
    throw new UsageError(`--mode must be one of ${RUN_MODES.join("|")}, received "${value}"`);
  }
  return value as RunMode;
}

export async function loadScriptedFixture(file: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`--scripted-fixture file could not be read: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--scripted-fixture is not valid JSON: ${messageOf(error)}`);
  }
  const source = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { responses?: unknown }).responses)
      ? ((parsed as { responses: unknown[] }).responses)
      : undefined;
  if (source === undefined) {
    throw new UsageError("--scripted-fixture must be a JSON array of responses or { responses: [...] }");
  }
  const responses = source.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  if (responses.length === 0) throw new UsageError("--scripted-fixture contains no responses");
  return responses;
}

function buildDecision(
  request: InterventionRequest,
  decision: "allow" | "deny" | "modify",
  optionId: string | undefined,
  rationale: string,
  capability: Capability | undefined,
): UserDecision {
  // `recordedBy` is the schema's literal "user": only a human answer can
  // produce this object, which is what makes the decision trustworthy (PRD HI-03).
  return userDecisionSchema.parse({
    decisionId: newId("dec"),
    interventionId: request.interventionId,
    taskId: request.taskId,
    branchId: request.branchId,
    at: nowIso(),
    decision,
    ...(optionId === undefined ? {} : { optionId }),
    rationale,
    appliesTo: {
      ...(capability === undefined ? {} : { capability }),
      resources: [],
    },
    recordedBy: "user",
  }) as UserDecision;
}

/** Ask the user, in the terminal, how to answer an intervention. */
async function askIntervention(
  request: InterventionRequest,
  output: Output,
  t: Translator,
): Promise<UserDecision | undefined> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    output.section(t("A decision is required"));
    output.line(`  ${request.question}`);
    output.line(`  ${t("Why you: {reason}", { reason: request.whyUserNeeded })}`);
    output.line(`  ${t("If ignored: {impact}", { impact: request.ifIgnoredImpact })}`);
    request.options.forEach((option, index) => {
      output.line(
        `  ${t("[{index}] {label} — {scope} (budget: {budget})", {
          index: index + 1,
          label: option.label,
          scope: option.effectOnScope,
          budget: option.effectOnBudget,
        })}`,
      );
    });
    const recommended = request.options.find(
      (option) => option.optionId === request.recommendedAction.optionId,
    );
    if (recommended !== undefined) {
      output.line(
        `  ${t("Recommended: {label} — {rationale}", {
          label: recommended.label,
          rationale: request.recommendedAction.rationale,
        })}`,
      );
    }

    const answer = (
      await rl.question(t("Choose [a]llow / [d]eny / [m]odify (default: allow the recommendation): "))
    )
      .trim()
      .toLowerCase();

    if (answer === "d" || answer === "deny") {
      return buildDecision(request, "deny", undefined, "denied by the user via the CLI", undefined);
    }
    if (answer === "m" || answer === "modify") {
      return buildDecision(request, "modify", undefined, "amended by the user via the CLI", undefined);
    }
    const chosen = recommended ?? request.options[0];
    return buildDecision(
      request,
      "allow",
      chosen?.optionId,
      `allowed by the user via the CLI: ${chosen?.label ?? "recommended option"}`,
      chosen?.grants[0],
    );
  } finally {
    rl.close();
  }
}

async function runTask(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    flags: {
      project: "string",
      request: "string",
      ref: "repeat",
      mode: "string",
      "max-steps": "string",
      "write-path": "repeat",
      "allow-command": "repeat",
      "accept-contract": "boolean",
      model: "string",
      json: "boolean",
      verbose: "boolean",
      "non-interactive": "boolean",
      "scripted-fixture": "string",
    },
  });

  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const projectPath = requireString(args, "project");
  const request = requireString(args, "request");
  const references = parseReferences(getList(args, "ref"));
  const mode = parseMode(getString(args, "mode"));
  const maxSteps = parsePositiveInt(getString(args, "max-steps"), "max-steps");
  const writePaths = getList(args, "write-path");
  const allowedCommands = getList(args, "allow-command");
  const acceptContract = getBoolean(args, "accept-contract");
  const nonInteractive = getBoolean(args, "non-interactive");
  const requestedModelId = getString(args, "model");
  const fixture = getString(args, "scripted-fixture");

  const paths = pathsFor(context);
  const projectId = await projectIdForWorkspace(projectPath);
  const config = await loadConfig({ configFile: paths.configFile });
  const credentials = new FileCredentialStore({ credentialsDir: paths.credentialsDir });

  const adapters: ModelAdapter[] = [];
  let routes: Partial<Record<ModelRole, readonly string[]>>;

  if (fixture !== undefined) {
    // The scripted model is a legitimate offline entry point (PRD EX-05), not a
    // test-only back door: it is what lets a Minimal run be evaluated without a
    // network or a key.
    const responses = await loadScriptedFixture(fixture);
    const id = requestedModelId ?? "scripted";
    adapters.push(createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id }), responses }));
    routes = { builder: [id], summarizer: [id], planner: [id] };
    output.line(
      t(
        "Using the built-in scripted model: deterministic, offline execution (tests / evaluation, PRD EX-05).",
      ),
    );
  } else {
    for (const entry of enabledModels(config)) {
      try {
        adapters.push(buildAdapter(entry, credentials));
      } catch (error) {
        output.error(t('skipping model "{id}": {reason}', { id: entry.id, reason: messageOf(error) }));
      }
    }
    routes = {
      builder: routeFor(config, "builder"),
      summarizer: routeFor(config, "summarizer"),
      planner: routeFor(config, "planner"),
    };
  }

  if (adapters.length === 0) {
    // Do not fail silently: blame-free, executable next steps are the whole
    // point of this branch (PRD 12.3).
    output.error(
      t("No usable model is configured, so no task can run. Configure a model (BYOK) first:"),
    );
    output.error("  1) keystone model add --id my-model --kind cloud --provider <provider> --model <model-name> \\");
    output.error("       --base-url <https://host/v1> --endpoint-host <host> [--credential-handle my-model]");
    output.error("  2) keystone model credential set my-model   # paste the API key on stdin");
    output.error("  3) keystone model route builder my-model");
    output.error(t("For offline evaluation only, pass --scripted-fixture <file.json>."));
    return 1;
  }

  const budget = budgetFrom(config);
  const autonomy = autonomyEnvelopeSchema.parse({
    ...defaultEnvelope(projectId, budget),
    writePaths: [...writePaths],
    allowedCommands: [...allowedCommands],
    updatedAt: nowIso(),
    updatedBy: "user",
  }) as AutonomyEnvelope;
  if (writePaths.length === 0) {
    output.error(
      t("Note: no --write-path was given, so the Autonomy Envelope has no writable paths."),
    );
    output.error(
      t(
        "The task will stop for approval when it tries to change a file. Re-run with --write-path <glob>.",
      ),
    );
  }

  const pending: InterventionRequest[] = [];
  const runtime = await KeystoneRuntime.create({ paths, models: adapters, routes, mode });
  const result = await runtime.runTask({
    workspacePath: projectPath,
    request,
    references,
    autonomy,
    budget,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    acceptContractAutomatically: acceptContract,
    onIntervention: async (intervention) => {
      if (!context.isTTY || nonInteractive) {
        // Non-interactive callers never block: record the item and let the task
        // rest at `needs_attention` (PRD HI-01).
        pending.push(intervention);
        output.error(
          t("Pending decision (non-interactive; the task will stop): {question}", {
            question: intervention.question,
          }),
        );
        return undefined;
      }
      return askIntervention(intervention, output, t);
    },
  });

  const proof = result.proof;
  const conditions = proof?.conditions ?? [];
  const unverified = proof?.unverified ?? [];
  const residualRisks = proof?.residualRisks ?? [];
  const reproduceCommands = proof?.reproduceCommands ?? [];

  output.section(t("Task"));
  output.keyValue({
    [t("taskId")]: result.taskId,
    [t("status")]: result.status,
    [t("mode")]: result.mode,
    [t("steps")]: result.steps,
    [t("files changed")]: result.changedPaths.length,
  });
  for (const path of result.changedPaths) output.line(`  ${path}`);

  output.section(t("Completion conditions"));
  if (conditions.length === 0) {
    output.line(`  ${t("(no contract conditions were evaluated)")}`);
  }
  for (const condition of conditions) {
    const achieved =
      condition.achievedLevel === undefined
        ? ""
        : t(", achieved {level}", { level: condition.achievedLevel });
    output.line(
      `  ${t("[{mark}] {conditionId} ({kind}, min {level}) — {verdict}: {reasonCode}", {
        mark: condition.satisfied ? t("ok").padEnd(4) : t("OPEN"),
        conditionId: condition.conditionId,
        kind: condition.required ? t("required") : t("auxiliary"),
        level: `${condition.requiredLevel}${achieved}`,
        verdict: condition.satisfied ? t("satisfied") : t("not satisfied"),
        reasonCode: condition.reasonCode,
      })}`,
    );
  }

  output.section(t("Not verified and residual risk"));
  if (unverified.length === 0 && residualRisks.length === 0) output.line(`  ${t("none reported")}`);
  for (const item of unverified) output.line(`  ${t("unverified: {item}", { item })}`);
  for (const item of residualRisks) output.line(`  ${t("residual risk: {item}", { item })}`);

  output.section(t("Reproduce"));
  for (const command of reproduceCommands) output.line(`  ${command}`);
  output.line(`  keystone proof show ${result.taskId}`);

  if (result.reasons.length > 0) {
    output.section(t("Why it stopped"));
    for (const reason of result.reasons) output.line(`  - ${reason}`);
  }
  if (pending.length > 0) {
    output.section(t("Pending decisions"));
    for (const item of pending) output.line(`  - ${item.question}`);
  }

  output.json({
    taskId: result.taskId,
    status: result.status,
    mode: result.mode,
    steps: result.steps,
    changedPaths: result.changedPaths,
    outcome: proof?.outcome ?? null,
    summary: result.summary,
    conditions,
    evidenceIndex: proof?.evidenceIndex ?? [],
    unverified,
    residualRisks,
    reproduceCommands,
    reasons: result.reasons,
    pendingInterventions: pending.map((item) => ({
      interventionId: item.interventionId,
      trigger: item.trigger,
      question: item.question,
      whyUserNeeded: item.whyUserNeeded,
      ifIgnoredImpact: item.ifIgnoredImpact,
    })),
  });

  if (result.status === "proven") return 0;
  if (
    result.status === "needs_attention" ||
    result.status === "awaiting_approval" ||
    pending.length > 0
  ) {
    return 3;
  }
  return 1;
}

/** Read only the first line of a ledger, to identify a task without loading it. */
async function firstLineOf(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await openFile(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    const line = (newline === -1 ? text : text.slice(0, newline)).trim();
    return line === "" ? undefined : line;
  } finally {
    await handle.close();
  }
}

async function runList(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, { flags: { json: "boolean", verbose: "boolean" } });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const paths = pathsFor(context);
  const summaries: ReturnType<KernelSession["summary"]>[] = [];
  const unrecoverable: { taskId: string; reason: string }[] = [];

  const entries = await readDirSafe(paths.tasksDir);
  for (const name of entries) {
    const taskId = toTaskId(name);
    if ((await firstLineOf(paths.ledgerFile(taskId))) === undefined) continue;
    try {
      const session = await KernelSession.open({ paths, taskId });
      summaries.push(session.summary());
    } catch (error) {
      // A ledger that fails integrity verification is reported as such, not
      // allowed to crash the whole listing.
      unrecoverable.push({ taskId: name, reason: messageOf(error) });
    }
  }

  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  output.section(t("Tasks"));
  if (summaries.length === 0 && unrecoverable.length === 0) output.line(`  ${t("no tasks found")}`);
  for (const summary of summaries) {
    output.line(`  ${t("{status} stage={stage} pending={pending} updated={updated}  {taskId}", {
      status: summary.status.padEnd(16),
      stage: summary.stage.padEnd(12),
      pending: summary.pendingInterventions,
      updated: summary.updatedAt,
      taskId: summary.taskId,
    })}`);
    output.detail(summary.headline);
  }
  for (const failure of unrecoverable) {
    output.error(t("[unrecoverable] {taskId}: {reason}", { taskId: failure.taskId, reason: failure.reason }));
  }

  output.json({ tasks: summaries, unrecoverable });
  return 0;
}

async function readDirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function openSession(
  context: CliContext,
  taskIdValue: string,
): Promise<KernelSession> {
  const taskId = toTaskId(taskIdValue);
  return KernelSession.open({ paths: pathsFor(context), taskId });
}

async function runShow(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const session = await openSession(context, taskIdValue);
  const summary = session.summary();
  const contract = session.contract();
  const evidence = await session.evidence();
  const checkpoint = await session.latestCheckpoint();

  output.section(t("Task"));
  output.keyValue({
    [t("taskId")]: summary.taskId,
    [t("status")]: summary.status,
    [t("stage")]: summary.stage,
    [t("branch")]: summary.branchId,
    [t("pending decisions")]: summary.pendingInterventions,
    [t("evidence records")]: evidence.length,
    [t("updated")]: summary.updatedAt,
  });

  output.section(t("Contract"));
  if (contract === undefined) {
    output.line(`  ${t("no contract has been compiled for this task yet")}`);
  } else {
    output.keyValue({
      [t("goal")]: contract.goal,
      [t("version")]: contract.version,
      [t("status")]: contract.status,
    });
    const include = contract.scope.include.map((entry) => entry.pattern).join(", ") || t("(none)");
    const exclude = contract.scope.exclude.map((entry) => entry.pattern).join(", ") || t("(none)");
    output.line(`  ${t("scope include: {paths}", { paths: include })}`);
    output.line(`  ${t("scope exclude: {paths}", { paths: exclude })}`);
    if (contract.scope.unknown.length > 0) {
      output.line(`  ${t("unresolved scope: {paths}", { paths: contract.scope.unknown.join(", ") })}`);
    }
    for (const invariant of contract.invariants) {
      output.line(`  ${t("invariant: {description}", { description: invariant.description })}`);
    }
    output.line(`  ${t("completion conditions:")}`);
    for (const condition of contract.completionConditions) {
      output.line(
        `    ${t("- {conditionId} ({kind}, min {level}{independence}): {description}", {
          conditionId: condition.conditionId,
          kind: condition.required ? t("required") : t("auxiliary"),
          level: condition.minEvidenceLevel,
          independence: condition.requiresIndependence ? t(", independent") : "",
          description: condition.description,
        })}`,
      );
    }
  }

  output.section(t("Evidence"));
  if (evidence.length === 0) output.line(`  ${t("none recorded")}`);
  for (const record of evidence) {
    output.line(
      `  [${record.status}] ${record.level} ${record.producer.id} → ${record.conditionIds.join(", ")}`,
    );
  }
  output.detail(t("evidence ids: {ids}", { ids: evidence.map((record) => record.evidenceId).join(", ") }));

  output.section(t("Latest checkpoint"));
  if (checkpoint === undefined) {
    output.line(`  ${t("none")}`);
  } else {
    output.keyValue({
      [t("checkpointId")]: checkpoint.checkpointId,
      [t("reason")]: checkpoint.reason,
      [t("at")]: checkpoint.createdAt,
    });
    output.detail(t("integrity: {value}", { value: checkpoint.integrity }));
  }

  output.json({
    summary,
    contract: contract ?? null,
    evidence: evidence.map((record) => ({
      evidenceId: record.evidenceId,
      level: record.level,
      status: record.status,
      conditionIds: record.conditionIds,
      producerId: record.producer.id,
      createdAt: record.createdAt,
    })),
    latestCheckpoint: checkpoint ?? null,
  });
  return 0;
}

async function runEvents(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { json: "boolean", verbose: "boolean" },
  });
  const verbose = getBoolean(args, "verbose");
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose,
  });
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const session = await openSession(context, taskIdValue);
  const events = session.events();

  output.section(t("Events"));
  for (const event of events) {
    output.line(
      `${String(event.seq).padStart(4)}  ${event.type.padEnd(28)} ${event.actor.kind}:${event.actor.id}`,
    );
    // Payloads are technical detail: only visible under --verbose (PRD 12.3).
    output.detail(JSON.stringify(event.payload));
  }

  output.json({
    taskId: taskIdValue,
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      at: event.at,
      actor: event.actor,
      ...(verbose ? { payload: event.payload } : {}),
    })),
  });
  return 0;
}

async function runPauseStop(
  kind: "pause" | "stop",
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { reason: "string", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const session = await openSession(context, taskIdValue);
  if (kind === "pause") {
    await session.pause("paused by the user via the CLI");
  } else {
    await session.stop(getString(args, "reason") ?? "stopped by the user via the CLI");
  }
  const status = session.state().status;
  output.line(t('task {taskId} is now "{status}"', { taskId: taskIdValue, status }));
  output.json({ taskId: taskIdValue, status });
  return 0;
}

async function runResume(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const paths = pathsFor(context);
  const session = await openSession(context, taskIdValue);
  const checkpoint = await session.requestResume();
  output.detail(t("resuming from checkpoint {checkpointId}", { checkpointId: checkpoint.checkpointId }));

  const root = await readWorkspaceRoot(paths, session.projectId);
  if (root === undefined) {
    output.error(
      t("cannot resume: the task's workspace root is unknown (project record is missing)"),
    );
    return 1;
  }

  const snapshot = await scanWorkspace(root);
  const assessment = await session.recover({
    workspaceFingerprint: snapshot.fingerprint,
    ...(snapshot.headCommit === undefined ? {} : { currentHeadCommit: snapshot.headCommit }),
  });

  output.section(t("Recovery"));
  output.line(describeRecovery(assessment));
  // Recording the outcome is what moves the task out of `resuming`; the status
  // it lands on is the assessment's, never a hopeful default (PRD EX-04, 10).
  await session.completeRecovery(assessment);

  if (!canResume(assessment)) {
    output.section(t("Affected by the change"));
    for (const path of assessment.changedPaths) output.line(`  ${t("changed: {path}", { path })}`);
    if (assessment.invalidatedEvidenceIds.length > 0) {
      output.line(
        `  ${t("invalidated evidence: {ids}", { ids: assessment.invalidatedEvidenceIds.join(", ") })}`,
      );
    }
    if (assessment.invalidatedFactIds.length > 0) {
      output.line(`  ${t("invalidated facts: {ids}", { ids: assessment.invalidatedFactIds.join(", ") })}`);
    }
    output.error(t("The task cannot resume automatically and remains in needs_attention."));
    output.json({
      taskId: taskIdValue,
      resumable: false,
      status: session.state().status,
      assessment,
    });
    return 3;
  }

  output.line(
    t('task {taskId} resumed; status is now "{status}"', {
      taskId: taskIdValue,
      status: session.state().status,
    }),
  );
  output.json({ taskId: taskIdValue, resumable: true, status: session.state().status, assessment });
  return 0;
}

async function runBranch(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { label: "string", reason: "string", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const label = requireString(args, "label");
  const reason = requireString(args, "reason");
  const session = await openSession(context, taskIdValue);
  const branch = await session.branch(label, reason);

  output.section(t("Branch"));
  output.keyValue({
    [t("branch id")]: branch.branchId,
    [t("label")]: branch.label,
    [t("parent checkpoint")]: branch.parentCheckpointId ?? t("(none)"),
    [t("forked from")]: branch.forkedFromBranchId ?? t("(primary)"),
    [t("reason")]: branch.reason,
  });
  output.json(branch);
  return 0;
}

async function primarySummary(session: KernelSession): Promise<BranchSummary | undefined> {
  const contract = session.contract();
  if (contract === undefined) return undefined;
  const state = session.state();
  const branch = runBranchSchema.parse({
    branchId: state.branchId,
    taskId: state.taskId,
    label: "primary",
    forkedAt: state.createdAt,
    reason: "the task's primary branch",
    status: "active",
    contractId: contract.contractId,
    contractVersion: contract.version,
  }) as RunBranch;
  return summarizeBranch({
    branch,
    state,
    changedPaths: collectChangedPaths(session.events()),
    evidence: await session.evidence(),
    contract,
  });
}

async function branchSummary(
  context: CliContext,
  strTaskId: string,
  branch: RunBranch,
): Promise<BranchSummary | undefined> {
  let session: KernelSession;
  try {
    session = await KernelSession.open({
      paths: pathsFor(context),
      taskId: toTaskId(strTaskId),
      branchId: branch.branchId,
    });
  } catch {
    return undefined;
  }
  const contract = session.contract();
  return summarizeBranch({
    branch,
    state: session.state(),
    changedPaths: collectChangedPaths(session.events()),
    evidence: await session.evidence(),
    ...(contract === undefined ? {} : { contract }),
  });
}

async function runCompare(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { task: "string", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const paths = pathsFor(context);
  const summaries: BranchSummary[] = [];

  const mainSession = await openSession(context, taskIdValue);
  const primary = await primarySummary(mainSession);
  if (primary !== undefined) summaries.push(primary);
  for (const branch of await listBranches(paths, taskIdValue)) {
    const summary = await branchSummary(context, taskIdValue, branch);
    if (summary !== undefined) summaries.push(summary);
  }

  const other = getString(args, "task");
  if (other !== undefined) {
    const otherSession = await openSession(context, other);
    const otherPrimary = await primarySummary(otherSession);
    if (otherPrimary !== undefined) summaries.push(otherPrimary);
    for (const branch of await listBranches(paths, other)) {
      const summary = await branchSummary(context, other, branch);
      if (summary !== undefined) summaries.push(summary);
    }
  }

  if (summaries.length < 2) {
    output.line(
      t(
        "This task has {count} branch(es); at least two are needed to compare. Create another branch with `keystone task branch`.",
        { count: summaries.length },
      ),
    );
    output.json({ taskId: taskIdValue, branches: summaries, comparison: null });
    return 0;
  }

  const comparison = compareBranches(summaries, { taskId: taskIdValue });

  output.section(t("Branch comparison"));
  output.line(
    `  ${t("branch").padEnd(27)}${t("outcome").padEnd(17)}${t("verification").padEnd(20)}` +
      `${t("changed")}  ${t("residual")}  ${t("tokens")}`,
  );
  for (const entry of comparison.entries) {
    output.line(
      `  ${entry.label.slice(0, 24).padEnd(26)} ${entry.outcome.padEnd(16)} ` +
        `${entry.verificationStatus.padEnd(18)} ${String(entry.changedFileCount).padStart(7)} ` +
        `${String(entry.residualRiskCount).padStart(8)} ${String(entry.tokensUsed).padStart(7)}`,
    );
  }
  if (comparison.recommendation !== undefined) {
    output.section(t("Recommendation"));
    output.line(comparison.recommendation.rationale);
  }

  output.json(comparison);
  return 0;
}

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "run":
      return runTask(rest, context);
    case "list":
      return runList(rest, context);
    case "show":
      return runShow(rest, context);
    case "events":
      return runEvents(rest, context);
    case "pause":
      return runPauseStop("pause", rest, context);
    case "stop":
      return runPauseStop("stop", rest, context);
    case "resume":
      return runResume(rest, context);
    case "branch":
      return runBranch(rest, context);
    case "compare":
      return runCompare(rest, context);
    default:
      throw new UsageError(
        `unknown subcommand "task ${sub ?? ""}"; expected one of run, list, show, events, pause, stop, resume, branch, compare`,
      );
  }
}

export const command: CommandModule = {
  name: "task",
  summary: (t) => t("Run tasks, and inspect/recover/branch/compare them"),
  usage: "keystone task <run|list|show|events|pause|stop|resume|branch|compare> ...",
  help: [
    "keystone task run --project <path> --request <text> [options]",
    "  --ref <kind>:<value>       Attach a reference (repeatable; kind: file|directory|issue|log|url|text)",
    "  --mode <m>                 minimal | standard | isolated | replay (default: standard)",
    "  --max-steps <n>            Cap the number of steps",
    "  --write-path <glob>        Declare a writable path in the Autonomy Envelope (repeatable)",
    "  --allow-command <name>     Allow a command without asking (repeatable)",
    "  --accept-contract          Start without asking to confirm the contract",
    "  --model <id>               Pin the model id to use",
    "  --non-interactive          Never prompt; stop at needs_attention instead",
    "  --scripted-fixture <file>  Offline/deterministic model for tests and evaluation (PRD EX-05)",
    "  --json                     Print the structured result",
    "",
    "keystone task list [--json]",
    "keystone task show <taskId> [--json]",
    "keystone task events <taskId> [--verbose] [--json]",
    "keystone task pause <taskId>",
    "keystone task stop <taskId> [--reason <text>]",
    "keystone task resume <taskId>",
    "keystone task branch <taskId> --label <name> --reason <text>",
    "keystone task compare <taskId> [--task <otherTaskId>]",
    "",
    "Exit codes: 0 proven · 3 needs attention · 1 failure · 2 usage error.",
  ].join("\n"),
  run,
};
