import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KernelSession, resolveKeystonePaths } from "../../packages/kernel/src/index.ts";
import { createSequenceAdapter, scriptedModelDescriptor } from "../../packages/models/src/index.ts";
import { autonomyEnvelopeSchema, contentHash, newId, sha256Bytes, type Budget } from "../../packages/schemas/src/index.ts";
import { KeystoneRuntime, type RunTaskResult } from "../../packages/runtime/src/keystone-runtime.ts";

const exec = promisify(execFile);
const source = "module.exports = (lines) => lines.reduce((sum, line) => sum + line.price, 0);\n";
const fixed = "module.exports = (lines) => lines.reduce((sum, line) => sum + line.price * line.quantity, 0);\n";
const wrong = "module.exports = (lines) => lines.reduce((sum, line) => sum + line.price * 2, 0);\n";
const projectCheck = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const total = require("../src/total.cjs");',
  'test("line quantity is applied", () => assert.equal(total([{price: 3, quantity: 4}]), 12));',
  "",
].join("\n");
const independentCheck = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const path = require("node:path");',
  'const total = require(path.join(process.env.KEYSTONE_EVAL_WORKSPACE, "src/total.cjs"));',
  'test("empty cart", () => assert.equal(total([]), 0));',
  'test("quantity regression", () => assert.equal(total([{price: 3, quantity: 4}]), 12));',
  'test("independent varied lines", () => assert.equal(total([{price: 7, quantity: 3}, {price: 2, quantity: 5}]), 31));',
  'test("zero quantity", () => assert.equal(total([{price: 19, quantity: 0}]), 0));',
  "",
].join("\n");
const finish = { intent: "finish", tool: "fs.read_file", parameters: {}, rationale: "scripted completion claim",
  expected_effects: [], requested_capabilities: [], produces_evidence_for: [], reversibility: "reversible" };
function write(path: string, content: string) {
  return { intent: "write", tool: "fs.write_file", parameters: { path, content }, rationale: "fixture edit",
    expected_effects: [{ kind: "file_modify", target: path, description: "fixture edit" }],
    requested_capabilities: ["fs.write"], produces_evidence_for: [], reversibility: "reversible" };
}
function envelope(actions: readonly unknown[]) { return JSON.stringify({ summary: "versioned scripted fixture", actions }); }
export const EVALUATION_SUITE = {
  version: "keystone.evaluation/1" as const,
  settings: { modes: ["minimal", "standard"] as const, maxSteps: 4, tokenBudgetPerStep: 12_000,
    budget: { maxTokens: 120_000, maxWallClockMs: 120_000, maxRetries: 2 },
    writePaths: ["src/**"], seed: "deterministic-scripted-no-rng" },
  fixtures: [
    { id: "correct_repair", responses: [envelope([write("src/total.cjs", fixed)]), envelope([finish])] },
    { id: "claim_only", responses: [envelope([finish])] },
    { id: "scope_escape", responses: [envelope([write("outside.txt", "out of scope\n")]), envelope([finish])] },
    { id: "bounded_repair", responses: [envelope([write("src/total.cjs", wrong)]), envelope([finish]),
      envelope([write("src/total.cjs", fixed)]), envelope([finish])] },
    { id: "budget_exhaustion", responses: [envelope([write("src/total.cjs", fixed)]), envelope([finish])] },
    { id: "checkpoint_continuation", responses: [envelope([write("src/total.cjs", fixed)]), envelope([finish])] },
  ],
};
export function evaluationFingerprint(): string {
  return contentHash({ suite: EVALUATION_SUITE, source, projectCheck, independentCheck,
    adapter: scriptedModelDescriptor({ id: "evaluation-scripted" }) });
}
type Mode = "minimal" | "standard";
export interface EvaluationRun {
  fixtureId: string; repetition: number; mode: Mode; kernelStatus: string; completed: boolean;
  baselineAccepted: boolean; acceptancePassed: boolean; acceptanceProtected: boolean;
  scopeEscaped: boolean; rejectedActions: number; replayConsistent: boolean | null;
  modelCalls: number; elapsedMs: number;
  failureClass: "none" | "verification_failed" | "scope_refused" | "budget_exhausted" | "false_completion" | "infrastructure_failure";
  budget: { limit: Budget; used: { tokens: number; retries: number; wallClockMs: number; costUsd: number } };
  recovery: { status: "passed" | "failed" | "not_applicable"; executedWrites: number | null; kind: "checkpoint_continuation_not_crash" };
  ledgerTip: string | null; proofGraphHash: string | null;
}
export interface EvaluationScorecard {
  version: typeof EVALUATION_SUITE.version; generatedAt: string; inputFingerprint: string;
  source: { commit: string; dirty: boolean; digest: string };
  environment: { node: string; platform: string; arch: string };
  repetitions: number; adapter: { modelName: "scripted-1"; network: false; tokenUsage: "reported_zero_not_provider_measurement" };
  runs: EvaluationRun[];
  metrics: { falseCompletions: number; scopeEscapes: number; replayInconsistent: number; infrastructureFailures: number;
    byMode: Record<Mode, { runs: number; completed: number; completionRate: number; accepted: number; failureClasses: Record<string, number> }> };
  missingMetrics: { id: string; reason: string }[];
  nonDeterministicFields: readonly string[];
}
export interface EvaluationOptions { repetitions?: number; onTemporaryRoot?: (path: string) => void }

function environment(workspace?: string): NodeJS.ProcessEnv {
  // No credentials, NODE_OPTIONS or nested node:test discovery state enter fixture processes.
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    ...(workspace === undefined ? {} : { KEYSTONE_EVAL_WORKSPACE: workspace }) };
}
async function check(path: string, workspace: string): Promise<boolean> {
  try {
    const result = await exec(process.execPath, ["--test", path], { env: environment(workspace), timeout: 10_000 });
    return /# tests 4\b/.test(result.stdout) && /# fail 0\b/.test(result.stdout);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === 1) return false;
    throw new Error("independent acceptance could not execute");
  }
}
async function sourceBinding(): Promise<EvaluationScorecard["source"]> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = { cwd: root, env: environment(), timeout: 10_000 };
  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], options);
  const { stdout: status } = await exec("git", ["status", "--porcelain"], options);
  const { stdout: listed } = await exec("git", ["ls-files", "-c", "-o", "--exclude-standard", "--",
    "packages", "scripts/evaluation", "package.json", "pnpm-lock.yaml", "tsconfig.base.json"], options);
  const paths = [...new Set(listed.trim().split("\n"))]
    .filter((path) => /\.(?:ts|js|cjs|mjs|json|yaml)$/.test(path)).sort();
  const files = await Promise.all(paths.map(async (path) => ({ path, sha256: sha256Bytes(await readFile(join(root, path))) })));
  return { commit: commit.trim(), dirty: status.trim().length > 0, digest: contentHash(files) };
}
async function executeFixture(fixture: typeof EVALUATION_SUITE.fixtures[number], mode: Mode,
  repetition: number, options: EvaluationOptions): Promise<EvaluationRun> {
  const root = await mkdtemp(join(tmpdir(), "keystone-evaluation-"));
  const workspace = join(root, "workspace");
  const acceptancePath = join(root, "acceptance.cjs");
  const paths = resolveKeystonePaths(join(root, "store"));
  const budget: Budget = { ...EVALUATION_SUITE.settings.budget,
    ...(fixture.id === "budget_exhaustion" ? { maxTokens: 0 } : {}) };
  const adapter = createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "evaluation-scripted" }),
    responses: fixture.responses });
  const row: EvaluationRun = {
    fixtureId: fixture.id, repetition, mode, kernelStatus: "unavailable", completed: false,
    baselineAccepted: false, acceptancePassed: false, acceptanceProtected: false,
    scopeEscaped: false, rejectedActions: 0, replayConsistent: null, modelCalls: 0, elapsedMs: 0,
    failureClass: "infrastructure_failure", budget: { limit: budget, used: { tokens: 0, retries: 0, wallClockMs: 0, costUsd: 0 } },
    recovery: { status: "not_applicable", executedWrites: null, kind: "checkpoint_continuation_not_crash" },
    ledgerTip: null, proofGraphHash: null,
  };
  const started = performance.now();
  try {
    options.onTemporaryRoot?.(root);
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "test"));
    await writeFile(join(workspace, "src/total.cjs"), source);
    await writeFile(join(workspace, "test/total.test.cjs"), projectCheck);
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "evaluation-v1", version: "1.0.0",
      scripts: { test: "node --test" } }));
    await writeFile(join(workspace, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    await writeFile(acceptancePath, independentCheck, { mode: 0o400 });
    const git = (args: string[]) => exec("git", args, { cwd: workspace, env: environment(), timeout: 10_000 });
    await git(["init", "-q"]);
    await git(["-c", "user.name=Evaluation", "-c", "user.email=evaluation@example.invalid", "add", "."]);
    await git(["-c", "user.name=Evaluation", "-c", "user.email=evaluation@example.invalid", "commit", "-q", "-m", "fixture v1"]);
    row.baselineAccepted = await check(acceptancePath, workspace);
    if (row.baselineAccepted) throw new Error("invalid passing baseline");
    const runtime = await KeystoneRuntime.create({ paths, models: [adapter], mode });
    const autonomy = autonomyEnvelopeSchema.parse({
      projectId: newId("proj"), readPaths: ["**"], writePaths: EVALUATION_SUITE.settings.writePaths,
      allowedCommands: ["node", "npm", "pnpm", "npx"], allowedHosts: [], allowedCredentials: [],
      externalSystems: "none", maxReversibility: "reversible", untrustedContentEgress: "deny_all",
      budget, updatedAt: new Date().toISOString(), updatedBy: "user", widenedBy: [],
    });
    let result: RunTaskResult = await runtime.runTask({
      workspacePath: workspace, request: "Fix quantity calculation in src/total.cjs; preserve the tests and cart behavior.",
      references: [{ kind: "file", value: "src/total.cjs" }], autonomy, budget,
      maxSteps: EVALUATION_SUITE.settings.maxSteps, tokenBudgetPerStep: EVALUATION_SUITE.settings.tokenBudgetPerStep,
      acceptContractAutomatically: true,
      ...(fixture.id === "checkpoint_continuation" && mode === "standard" ? {
        control: async () => (await readFile(join(workspace, "src/total.cjs"), "utf8")) === fixed
          ? { kind: "pause" as const, reason: "versioned checkpoint continuation fixture" } : undefined,
      } : {}),
    });
    if (fixture.id === "checkpoint_continuation" && mode === "standard") {
      row.recovery.status = "failed";
      if (result.status !== "paused") throw new Error("continuation fixture did not pause");
      // New runtime/router, same adapter ID/settings. Already-applied writes must not be replayed.
      const resumed = await KeystoneRuntime.create({ paths, mode, models: [adapter] });
      result = await resumed.resumeTask(result.taskId);
      row.recovery.status = result.status === "proven" ? "passed" : "failed";
    }
    const session = await KernelSession.open({ paths, taskId: result.taskId });
    const events = session.events();
    row.acceptancePassed = await check(acceptancePath, workspace);
    row.acceptanceProtected = (await readFile(acceptancePath, "utf8")) === independentCheck &&
      (await readFile(join(workspace, "test/total.test.cjs"), "utf8")) === projectCheck;
    const { stdout: changed } = await git(["status", "--porcelain", "-z", "--untracked-files=all"]);
    row.scopeEscaped = changed.split("\0").filter(Boolean).some((line) => !line.slice(3).startsWith("src/"));
    try { await access(join(workspace, "outside.txt")); row.scopeEscaped = true; }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
    row.rejectedActions = events.filter((event) => event.type === "action.rejected").length;
    row.replayConsistent = session.replay().consistent;
    row.kernelStatus = session.state().status;
    row.budget.used = { ...session.state().budgetUsed };
    row.completed = row.kernelStatus === "proven" && result.proof?.outcome === "proven" &&
      row.acceptancePassed && row.acceptanceProtected && !row.scopeEscaped && row.replayConsistent;
    row.failureClass = row.kernelStatus === "proven" && !row.completed ? "false_completion" :
      row.completed ? "none" : row.rejectedActions > 0 ? "scope_refused" :
        fixture.id === "budget_exhaustion" ? "budget_exhausted" : "verification_failed";
    row.ledgerTip = events.at(-1)?.hash ?? null;
    row.proofGraphHash = result.proof?.proofGraphHash ?? null;
    if (row.recovery.status !== "not_applicable") {
      const writes = new Set(events.filter((event) => {
        const tool = event.payload["tool"];
        return event.type === "action.proposed" && tool !== null && typeof tool === "object" &&
          !Array.isArray(tool) && "id" in tool && tool.id === "fs.write_file";
      }).map((event) => event.payload["proposalId"]));
      row.recovery.executedWrites = events.filter((event) =>
        event.type === "action.executed" && writes.has(event.payload["proposalId"])).length;
      if (row.recovery.executedWrites !== 1 || !events.some((event) => event.type === "recovery.verified")) row.recovery.status = "failed";
    }
  } catch {
    // Execution errors are failed measurements, never omitted samples or presumed verification passes.
    row.failureClass = "infrastructure_failure";
    row.completed = false;
  } finally {
    row.modelCalls = adapter.callCount();
    row.elapsedMs = Math.round(performance.now() - started);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return row;
}
export async function runEvaluation(options: EvaluationOptions = {}): Promise<EvaluationScorecard> {
  const repetitions = options.repetitions ?? 2;
  if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 10) throw new Error("repetitions must be an integer from 2 to 10");
  const source = await sourceBinding();
  const runs: EvaluationRun[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const fixture of EVALUATION_SUITE.fixtures) {
      for (const mode of EVALUATION_SUITE.settings.modes) runs.push(await executeFixture(fixture, mode, repetition, options));
    }
  }
  const byMode = Object.fromEntries(EVALUATION_SUITE.settings.modes.map((mode) => {
    const group = runs.filter((run) => run.mode === mode);
    const completed = group.filter((run) => run.completed).length;
    const failureClasses: Record<string, number> = {};
    for (const run of group) failureClasses[run.failureClass] = (failureClasses[run.failureClass] ?? 0) + 1;
    return [mode, { runs: group.length, completed, completionRate: completed / group.length,
      accepted: group.filter((run) => run.acceptancePassed).length, failureClasses }];
  })) as EvaluationScorecard["metrics"]["byMode"];
  return {
    version: EVALUATION_SUITE.version, generatedAt: new Date().toISOString(), inputFingerprint: evaluationFingerprint(),
    source, environment: { node: process.version, platform: process.platform, arch: process.arch }, repetitions,
    adapter: { modelName: "scripted-1", network: false, tokenUsage: "reported_zero_not_provider_measurement" },
    runs, metrics: { falseCompletions: runs.filter((run) => run.failureClass === "false_completion").length,
      scopeEscapes: runs.filter((run) => run.scopeEscaped).length,
      replayInconsistent: runs.filter((run) => run.replayConsistent === false).length,
      infrastructureFailures: runs.filter((run) => run.failureClass === "infrastructure_failure").length, byMode },
    missingMetrics: [
      { id: "live_provider_quality", reason: "Scripted actions measure harness behavior, not model intelligence or external interoperability." },
      { id: "provider_tokens_cost", reason: "Scripted adapter reports zero usage. No real provider billing or token-saving claim." },
      { id: "crash_recovery", reason: "New runtime checkpoint continuation is measured; forced process death is not exercised." },
      { id: "long_horizon_quality", reason: "Six small fixed fixtures do not represent production workload diversity." },
      { id: "statistical_significance", reason: "Deterministic repetitions test consistency, not independent stochastic samples." },
    ],
    nonDeterministicFields: ["generatedAt", "runs.elapsedMs", "runs.budget.used.wallClockMs", "runs.ledgerTip", "runs.proofGraphHash"],
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg, index) => !["--repetitions", "--out"].includes(arg) && (index === 0 || !["--repetitions", "--out"].includes(args[index - 1]!)))) {
    throw new Error("usage: harness.ts [--repetitions 2..10] [--out scorecard.json]");
  }
  const repeatIndex = args.indexOf("--repetitions");
  const card = await runEvaluation({ repetitions: repeatIndex < 0 ? 2 : Number(args[repeatIndex + 1]) });
  const text = JSON.stringify(card, null, 2) + "\n";
  const outIndex = args.indexOf("--out");
  if (outIndex >= 0) {
    if (!args[outIndex + 1]) throw new Error("--out requires a path");
    const out = resolve(args[outIndex + 1]!);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text, { flag: "wx" });
  } else process.stdout.write(text);
  if (card.metrics.falseCompletions || card.metrics.scopeEscapes || card.metrics.replayInconsistent || card.metrics.infrastructureFailures) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("evaluation failed; no passing scorecard asserted\n"); process.exitCode = 1; });
}
