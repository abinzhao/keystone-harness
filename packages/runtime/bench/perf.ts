/**
 * Performance baseline.
 *
 * PRD 12.2 is explicit that a latency number without its measurement conditions
 * is not a release conclusion. So this script *is* the measurement definition:
 * it prints the hardware, the dataset it built, the sample count, and whether
 * each measurement was cold or warm, next to the numbers.
 *
 * Measured (matching NFR-PERF-01/02 and the proof-open path in DP-02):
 *   cli.cold-start      spawning the CLI for the first time        cold
 *   cli.task-list       listing a store with N persisted tasks     cold
 *   kernel.task-switch  opening a task and folding its ledger      warm
 *   proof.open          re-deriving the proof from the ledger      warm
 *
 * Run: pnpm run bench [--tasks 20] [--samples 15]
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  KernelSession,
  defaultEnvelope,
  resolveKeystonePaths,
} from "@keystone/kernel";
import {
  compileContract,
  resolveEngineeringAction,
} from "@keystone/pack-engineering";
import {
  autonomyEnvelopeSchema,
  newId,
  nowIso,
  type Budget,
  type ProjectProfile,
} from "@keystone/schemas";

const exec = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const cliPath = join(repositoryRoot, "packages", "cli", "src", "bin.ts");

interface Options {
  readonly tasks: number;
  readonly samples: number;
  readonly eventsPerTask: number;
}

function parseOptions(argv: readonly string[]): Options {
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    tasks: read("--tasks", 20),
    samples: read("--samples", 15),
    eventsPerTask: read("--events", 80),
  };
}

function percentiles(values: readonly number[]): {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[index] ?? 0;
  };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: at(0),
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length === 0 ? 0 : sum / sorted.length,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function profileFor(projectId: string): ProjectProfile {
  const now = nowIso();
  return {
    projectId,
    rootPath: process.cwd(),
    name: "benchmark-fixture",
    vcs: "git",
    languages: ["typescript"],
    packageManager: "pnpm",
    support: { status: "supported", reasons: ["synthetic dataset for the performance baseline"] },
    commands: [
      { kind: "test", command: "pnpm run test", status: "identified", source: "package.json#scripts.test" },
    ],
    instructionFiles: [],
    createdAt: now,
    updatedAt: now,
  } as ProjectProfile;
}

/** Build a store with `tasks` tasks, each carrying `eventsPerTask` real events. */
async function seed(
  paths: ReturnType<typeof resolveKeystonePaths>,
  options: Options,
): Promise<string[]> {
  const budget: Budget = { maxTokens: 1_000_000, maxWallClockMs: 3_600_000, maxRetries: 3 };
  const taskIds: string[] = [];

  for (let index = 0; index < options.tasks; index += 1) {
    const projectId = `proj_${"0".repeat(25)}${index % 10}`;
    const session = await KernelSession.create({
      paths,
      projectId: projectId as never,
      request: `benchmark task ${index}`,
      actorId: "bench",
      // The kernel ships no engineering policy (ADR-0006, M1): it cannot draft a
      // contract or resolve capabilities on its own. Like @keystone/runtime, the
      // bench wires the engineering scenario seams, or compile() fails loudly.
      proposeContract: compileContract,
      resolveAction: resolveEngineeringAction,
    });
    await session.submit();
    await session.compile({
      profile: profileFor(projectId),
      facts: [],
      autonomy: autonomyEnvelopeSchema.parse({
        ...defaultEnvelope(projectId as never, budget),
        writePaths: ["src/**"],
        allowedCommands: ["pnpm"],
        updatedAt: nowIso(),
        updatedBy: "user",
      }),
      budget,
    });
    await session.start();

    // Pad the ledger with plausible events so the fold has real work to do:
    // reading a 60-event task is a different cost from reading a 5-event one.
    const { buildEvent } = await import("@keystone/kernel");
    const { chainTip, appendEvent } = await import("@keystone/kernel");
    const { readLedger } = await import("@keystone/kernel");
    const ledgerFile = paths.ledgerFile(session.taskId);
    const existing = (await readLedger(ledgerFile)).events;
    const events = [...existing];
    for (let step = 0; step < Math.floor(options.eventsPerTask / 2); step += 1) {
      const consumed = buildEvent(
        {
          taskId: session.taskId,
          branchId: session.branchId,
          type: "budget.consumed",
          payload: {
            delta: { tokens: 1_200, retries: 0, wallClockMs: 900, costUsd: 0.002 },
            reason: `benchmark step ${step}`,
            measured: true,
          },
          actorKind: "kernel",
          actorId: "bench",
        },
        chainTip(events),
      );
      events.push(consumed);
      const executed = buildEvent(
        {
          taskId: session.taskId,
          branchId: session.branchId,
          type: "action.executed",
          payload: {
            proposalId: newId("prop"),
            status: "succeeded",
            durationMs: 12,
            changedPaths: [`src/file-${step % 7}.ts`],
          },
          actorKind: "tool",
          actorId: "tool.fs",
        },
        chainTip(events),
      );
      events.push(executed);
    }
    for (const event of events.slice(existing.length)) {
      await appendEvent(ledgerFile, event);
    }

    taskIds.push(session.taskId);
  }

  return taskIds;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  // `os.tmpdir()` honours TMPDIR/TEMP/TMP per platform; a literal "/tmp" does
  // not exist on Windows.
  const home = await mkdtemp(join(tmpdir(), "keystone-bench-"));
  const paths = resolveKeystonePaths(home);
  const environment = {
    ...process.env,
    KEYSTONE_HOME: home,
    // The child must not inherit a test context, or `node --test` style
    // discovery in a child process exits 0 without doing anything.
    NODE_TEST_CONTEXT: "",
  };

  try {
    process.stdout.write(
      `Building the dataset: ${options.tasks} tasks x ${options.eventsPerTask} padded events\n`,
    );
    const seededAt = Date.now();
    const taskIds = await seed(paths, options);
    const seedMs = Date.now() - seededAt;

    const coldStart: number[] = [];
    for (let sample = 0; sample < options.samples; sample += 1) {
      const started = performance.now();
      await exec("node", [cliPath, "doctor"], { env: environment });
      coldStart.push(performance.now() - started);
    }

    const taskList: number[] = [];
    for (let sample = 0; sample < options.samples; sample += 1) {
      const started = performance.now();
      await exec("node", [cliPath, "task", "list"], { env: environment });
      taskList.push(performance.now() - started);
    }

    // Warm, in-process: this is what a workbench does when the user switches
    // task, so it is measured the way the workbench would do it (NFR-PERF-02).
    const target = taskIds[taskIds.length - 1] as never;
    const taskSwitch: number[] = [];
    for (let sample = 0; sample < options.samples * 3; sample += 1) {
      const started = performance.now();
      const session = await KernelSession.open({ paths, taskId: target });
      session.summary();
      taskSwitch.push(performance.now() - started);
    }

    const proofOpen: number[] = [];
    const session = await KernelSession.open({ paths, taskId: target });
    for (let sample = 0; sample < options.samples; sample += 1) {
      const started = performance.now();
      await session.exportProof({ changedPaths: [] });
      proofOpen.push(performance.now() - started);
    }

    const results = {
      environment: {
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        cores: cpus().length,
        totalMemoryGb: round(totalmem() / 1024 ** 3),
        node: process.version,
      },
      dataset: {
        tasks: options.tasks,
        eventsPerTask: options.eventsPerTask,
        seedMs,
        store: "synthetic ledger-only store (no workspace scan)",
      },
      measurements: {
        "cli.cold-start": { unit: "ms", cold: true, samples: coldStart.length, ...percentiles(coldStart) },
        "cli.task-list": { unit: "ms", cold: true, samples: taskList.length, ...percentiles(taskList) },
        "kernel.task-switch": { unit: "ms", cold: false, samples: taskSwitch.length, ...percentiles(taskSwitch) },
        "proof.open": { unit: "ms", cold: false, samples: proofOpen.length, ...percentiles(proofOpen) },
      },
    };

    const rounded = JSON.parse(
      JSON.stringify(results, (_key, value) => (typeof value === "number" ? round(value) : value)),
    );
    process.stdout.write(`${JSON.stringify(rounded, null, 2)}\n`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

await main();
