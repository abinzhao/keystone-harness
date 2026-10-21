/**
 * `keystone ci` — the locally deterministic automation surface.
 *
 * This is the one command a CI runner or another agent drives unattended. It is
 * deliberately narrower than `keystone task run`:
 *
 *   - It is *always* non-interactive. It never reads the terminal and never
 *     blocks on a prompt; a decision it cannot answer records a pending item and
 *     the task stops (exit 3) instead of hanging the build.
 *   - On completion it exports a **redacted** machine-readable proof artifact and
 *     prints a single stable JSON object on stdout that points at it.
 *   - Exit codes are the shared contract in `../exit-codes.ts`; exit 0 is still
 *     reserved for `proven`, so a run that did not prove never looks green.
 *
 * The command changes no kernel semantics: every state transition goes through
 * `KernelSession`, the proof is a deterministic projection of the ledger, and
 * redaction strips file content while keeping hashes/statuses.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  defaultEnvelope,
  KernelSession,
  projectIdForWorkspace,
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
  nowIso,
  type AutonomyEnvelope,
  type InterventionRequest,
} from "@keystone/schemas";

import {
  getBoolean,
  getList,
  getString,
  parseArgs,
  requireString,
  UsageError,
} from "../args.ts";
import { exitCodeForTask } from "../exit-codes.ts";
import {
  budgetFrom,
  parsePositiveInt,
  pathsFor,
  type CliContext,
  type CommandModule,
} from "./shared.ts";
import { loadScriptedFixture, parseReferences } from "./task.ts";

const RUN_MODES = ["minimal", "standard", "isolated"] as const;
type CiMode = (typeof RUN_MODES)[number];

/** The stable result object a CI runner parses. Field names are frozen (v1). */
const RESULT_VERSION = 1;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCiMode(value: string | undefined): CiMode {
  if (value === undefined) return "standard";
  if (!(RUN_MODES as readonly string[]).includes(value)) {
    throw new UsageError(`--mode must be one of ${RUN_MODES.join("|")}, received "${value}"`);
  }
  return value as CiMode;
}

function stderrLine(context: CliContext, text: string): void {
  context.stderr.write(`${text}\n`);
}

/** Write exactly one JSON object to stdout — the only thing a CI runner parses. */
function stdoutResult(context: CliContext, value: Record<string, unknown>): void {
  context.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface ArtifactInfo {
  readonly path: string;
  readonly bytes: number;
  readonly redaction: string;
  readonly proofGraphHash: string;
}

/**
 * Re-project the ledger as a redacted proof and write it to disk.
 *
 * Re-opening the session (rather than reusing the in-memory proof) is what makes
 * the artifact redacted: the runtime's own copy keeps file content, while this
 * passes `redaction: "metadata_only"`. Returns `null` (and reports why on
 * stderr) when a proof cannot be produced yet — e.g. the task stopped before a
 * contract existed — so a missing artifact is a reported gap, not a crash.
 */
async function exportRedactedArtifact(
  context: CliContext,
  taskId: string,
  changedPaths: readonly string[],
  outFile: string,
): Promise<ArtifactInfo | null> {
  try {
    const session = await KernelSession.open({ paths: pathsFor(context), taskId: taskId as never });
    const proof = await session.exportProof({
      changedPaths: [...changedPaths],
      redaction: "metadata_only",
    });
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    const { size } = await stat(outFile);
    return {
      path: outFile,
      bytes: size,
      redaction: proof.redaction,
      proofGraphHash: proof.proofGraphHash,
    };
  } catch (error) {
    stderrLine(context, `keystone ci: proof artifact was not exported: ${messageOf(error)}`);
    return null;
  }
}

async function run(argv: readonly string[], context: CliContext): Promise<number> {
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
      "scripted-fixture": "string",
      out: "string",
    },
  });

  const projectPath = requireString(args, "project");
  const request = requireString(args, "request");
  const references = parseReferences(getList(args, "ref"));
  const mode = parseCiMode(getString(args, "mode"));
  const maxSteps = parsePositiveInt(getString(args, "max-steps"), "max-steps");
  const writePaths = getList(args, "write-path");
  const allowedCommands = getList(args, "allow-command");
  const acceptContract = getBoolean(args, "accept-contract");
  const requestedModelId = getString(args, "model");
  const fixture = getString(args, "scripted-fixture");
  const outFile = resolve(getString(args, "out") ?? "keystone-proof.json");

  const paths = pathsFor(context);
  const projectId = await projectIdForWorkspace(projectPath);
  const config = await loadConfig({ configFile: paths.configFile });
  const credentials = new FileCredentialStore({ credentialsDir: paths.credentialsDir });

  // Model wiring mirrors `task run`: an offline scripted fixture for tests and
  // evaluation, otherwise the configured BYOK adapters.
  const adapters: ModelAdapter[] = [];
  let routes: Partial<Record<ModelRole, readonly string[]>>;
  if (fixture !== undefined) {
    const responses = await loadScriptedFixture(fixture);
    const id = requestedModelId ?? "scripted";
    adapters.push(createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id }), responses }));
    routes = { builder: [id], summarizer: [id], planner: [id] };
    stderrLine(context, "keystone ci: using the offline scripted model (deterministic, no network).");
  } else {
    for (const entry of enabledModels(config)) {
      try {
        adapters.push(buildAdapter(entry, credentials));
      } catch (error) {
        stderrLine(context, `keystone ci: skipping model "${entry.id}": ${messageOf(error)}`);
      }
    }
    routes = {
      builder: routeFor(config, "builder"),
      summarizer: routeFor(config, "summarizer"),
      planner: routeFor(config, "planner"),
    };
  }

  if (adapters.length === 0) {
    stdoutResult(context, {
      command: "keystone.ci",
      resultVersion: RESULT_VERSION,
      taskId: null,
      status: "failed",
      exitCode: exitCodeForTask("failed", 0),
      outcome: null,
      mode,
      steps: 0,
      changedPaths: [],
      artifact: null,
      conditions: [],
      unverified: [],
      residualRisks: [],
      reproduceCommands: [],
      reasons: ["No usable model is configured. Configure a BYOK model first, or pass --scripted-fixture for an offline run."],
      pendingInterventions: [],
    });
    return exitCodeForTask("failed", 0);
  }

  const budget = budgetFrom(config);
  const autonomy = autonomyEnvelopeSchema.parse({
    ...defaultEnvelope(projectId, budget),
    writePaths: [...writePaths],
    allowedCommands: [...allowedCommands],
    updatedAt: nowIso(),
    updatedBy: "user",
  }) as AutonomyEnvelope;

  // Non-interactive by construction: a decision we cannot answer is recorded and
  // the run stops at needs_attention (exit 3). We never read the terminal.
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
      pending.push(intervention);
      stderrLine(
        context,
        `keystone ci: pending decision (non-interactive; stopping): ${intervention.question}`,
      );
      return undefined;
    },
  });

  const proof = result.proof;
  const artifact = await exportRedactedArtifact(
    context,
    result.taskId,
    result.changedPaths,
    outFile,
  );

  const exitCode = exitCodeForTask(result.status, pending.length);

  stdoutResult(context, {
    command: "keystone.ci",
    resultVersion: RESULT_VERSION,
    taskId: result.taskId,
    status: result.status,
    exitCode,
    outcome: proof?.outcome ?? null,
    mode: result.mode,
    steps: result.steps,
    changedPaths: [...result.changedPaths],
    artifact,
    conditions: proof?.conditions ?? [],
    unverified: proof?.unverified ?? [],
    residualRisks: proof?.residualRisks ?? [],
    reproduceCommands: proof?.reproduceCommands ?? [],
    reasons: [...result.reasons],
    pendingInterventions: pending.map((item) => ({
      interventionId: item.interventionId,
      question: item.question,
    })),
  });

  return exitCode;
}

export const command: CommandModule = {
  name: "ci",
  summary: (t) => t("Run a task headlessly for CI: redacted proof + stable JSON exit code"),
  usage: "keystone ci --project <path> --request <text> [options]",
  help: [
    "keystone ci --project <path> --request <text> [options]",
    "",
    "  Run a task fully non-interactively (never prompts), export a redacted proof",
    "  artifact, and print one stable JSON object on stdout.",
    "",
    "  --project <path>           Repository/project root (required)",
    "  --request <text>           What to accomplish (required)",
    "  --ref <kind>:<value>       Attach a reference (repeatable)",
    "  --mode <m>                 minimal | standard | isolated (default: standard)",
    "  --max-steps <n>            Cap the number of steps",
    "  --write-path <glob>        Declare a writable path in the Autonomy Envelope (repeatable)",
    "  --allow-command <name>     Allow a command without asking (repeatable)",
    "  --accept-contract          Proceed when the contract awaits confirmation",
    "                             (without it, an awaiting-approval contract exits 3)",
    "  --model <id>               Pin the model id to use",
    "  --scripted-fixture <file>  Offline/deterministic model for tests and CI",
    "  --out <file>               Proof artifact path (default: ./keystone-proof.json)",
    "",
    "Exit codes: 0 proven · 3 needs attention · 1 did not prove · 2 usage error.",
  ].join("\n"),
  run,
};
