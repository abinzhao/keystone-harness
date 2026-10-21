/**
 * Observation-only historical comparison (ADR-0015). A completed source task is
 * read-only; a separate maintenance contract owns all leases and artifacts.
 * Worktrees isolate our writes, not hostile test code or network access.
 */
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { decidePath, getArtifactBytes, KernelSession, loadCheckpoint, pathMatchesAny,
  putJsonArtifact, validateLease, type KeystonePaths } from "@keystone/kernel";
import { contentHash, isTerminal, newId, nowIso, outcomeContractSchema, projectProfileSchema,
  runBindingSchema, sha256Bytes, type CapabilityLease, type OutcomeContract, type TaskId } from "@keystone/schemas";
import { runCaptured, sanitizeEnv, splitCommand, type CapturedRun } from "@keystone/verifiers";
import { applyWorkspacePatch, createIsolatedWorkspace, removeIsolatedWorkspace } from "./isolation.ts";
import { changedObservedPaths, observeWorkspace, type WorkspaceObservation } from "./workspace-observation.ts";

const exec = promisify(execFile);
const LIMIT = 4 * 1024 * 1024;
const forbidden = /(^|\/)(\.env(?:\..*)?|credentials?|secrets?|.*\.(?:pem|key|p12))$/i;
const hashPattern = /^[0-9a-f]{64}$/;
interface Capsule {
  version: "keystone.workspace-recovery/1";
  head: string;
  patch: string;
  changedPaths: string[];
  files: { path: string; bytes: string; mode: number }[];
  modes?: { path: string; mode: number }[];
  fingerprint: string;
  observedFiles: [string, string][];
}
interface ProtectedCommand {
  conditionId: string;
  command: string;
  bin: string;
  args: string[];
  timeoutMs: number;
}
export interface BaselineComparisonInput {
  readonly confirmed: boolean;
  /** Optional reductions only; neither option widens the original envelope. */
  readonly maxWallClockMs?: number;
  readonly timeoutMs?: number;
  /** Process-local cancellation; never persisted in the contract or artifacts. */
  readonly signal?: AbortSignal;
}
export interface ComparisonCheck {
  conditionId: string;
  command: string;
  status: CapturedRun["status"];
  exitCode?: number;
  durationMs: number;
  outputArtifactId: string;
  tests: number;
  testNames: string[];
  validTests: boolean;
  assertionFailure: boolean;
}
export interface ComparisonVariant {
  variant: "baseline" | "candidate";
  contentHash: string;
  restoredContentHash: string;
  indexHash: string;
  restoredIndexHash: string;
  contentEquivalent: boolean;
  unchangedAfterExecution: boolean;
  checks: ComparisonCheck[];
}
export interface BaselineComparisonReport {
  version: "keystone.baseline-comparison/1";
  sourceTaskId: string;
  comparisonTaskId?: TaskId;
  status: "observed" | "blocked";
  verdict: "baseline_failed_candidate_passed" | "non_discriminating" | "candidate_failed" | "inconclusive";
  reason?: string;
  parentProofReused: false;
  evidenceLevel: null;
  evidenceIds: string[];
  artifactRefs: string[];
  variants: ComparisonVariant[];
  budget: { wallClockMs: number; tokens: number; maxWallClockMs: number };
  binding?: {
    sourceBranchId: string;
    sourceContractDigest: string;
    sourceLedgerHash: string;
    initialCheckpointId: string;
    capsuleArtifactId: string;
    candidateCapsuleArtifactId: string;
    baselineContentHash: string;
    candidateContentHash: string;
    protectedContentHash: string;
    protectedTestsUnchanged: boolean;
    environmentHash: string;
  };
  limitations: string[];
}

function requireComparison(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function confined(path: string): boolean {
  return /^[a-zA-Z0-9_. /-]+$/.test(path) && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") &&
    !forbidden.test(path);
}
function pairsHash(pairs: readonly (readonly [string, string])[]): string {
  return contentHash([...pairs].sort(([a], [b]) => a.localeCompare(b, "en")));
}
function observationHash(observation: WorkspaceObservation): string {
  return pairsHash([...observation.files]);
}
async function git(root: string, args: readonly string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args], { maxBuffer: LIMIT, timeout: 30_000 })).stdout;
}
async function indexHash(root: string, head?: string): Promise<string> {
  const entries = (await git(root, head ? ["ls-tree", "-r", "-z", head] : ["ls-files", "-s", "-z"]))
    .split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, object, stage] = entry.slice(0, tab).split(" ");
      requireComparison(tab >= 0 && mode && object && (head ? object === "blob" : stage === "0"),
        "unsupported Git index entry");
      const hash = head ? stage : object;
      return [entry.slice(tab + 1), mode, hash];
    });
  return contentHash(entries.sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0));
}
function parseCapsule(value: unknown): Capsule {
  requireComparison(value !== null && typeof value === "object", "historical capsule is malformed");
  const capsule = value as Capsule;
  requireComparison(capsule.version === "keystone.workspace-recovery/1" &&
    /^[0-9a-f]{40,64}$/.test(capsule.head) && typeof capsule.patch === "string" &&
    hashPattern.test(capsule.fingerprint) && Array.isArray(capsule.changedPaths) &&
    Array.isArray(capsule.files) && Array.isArray(capsule.observedFiles), "unsupported historical capsule");
  let size = Buffer.byteLength(capsule.patch);
  for (const file of capsule.files) {
    requireComparison(file && typeof file.path === "string" && confined(file.path) &&
      typeof file.bytes === "string" && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777 &&
      Buffer.from(file.bytes, "base64").toString("base64") === file.bytes, "unsafe ordinary capsule file");
    size += Buffer.from(file.bytes, "base64").byteLength;
  }
  requireComparison(size <= LIMIT && capsule.changedPaths.every((path) => typeof path === "string" && confined(path)) &&
    capsule.observedFiles.every((pair) => Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === "string" && confined(pair[0]) && hashPattern.test(pair[1])),
  "capsule exceeds safe paths, content or size limits");
  requireComparison(new Set(capsule.files.map((file) => file.path)).size === capsule.files.length &&
    new Set(capsule.observedFiles.map(([path]) => path)).size === capsule.observedFiles.length,
  "capsule contains duplicate paths");
  requireComparison(capsule.modes === undefined || Array.isArray(capsule.modes) &&
    capsule.modes.every((file) => file && typeof file.path === "string" && confined(file.path) &&
      Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777),
  "unsafe capsule permission restoration");
  return capsule;
}

async function captureCandidate(root: string, before: WorkspaceObservation): Promise<Capsule> {
  requireComparison(!(await git(root, ["diff", "--cached", "--name-only"])).trim(),
    "staged index changes cannot be reproduced by the supported historical capsule");
  const tracked = (await git(root, ["ls-files", "-z", "--cached"])).split("\0").filter(Boolean);
  const untracked = (await git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  const covered = new Set([...tracked, ...untracked]);
  requireComparison([...before.files.keys()].every((path) => covered.has(path)),
    "ignored workspace content cannot be reproduced without widening restoration scope");
  const modes: NonNullable<Capsule["modes"]> = [];
  for (const path of covered) {
    requireComparison(confined(path), "workspace contains unsupported or sensitive paths");
    const info = await lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    requireComparison(info === undefined || info.isFile(), "symlinks and submodules cannot be safely restored");
    if (info && tracked.includes(path) && (info.mode & 0o777) !== ((info.mode & 0o111) ? 0o755 : 0o644)) {
      modes.push({ path, mode: info.mode & 0o777 });
    }
  }
  const patch = await git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
  const files: Capsule["files"] = [];
  let size = Buffer.byteLength(patch);
  for (const path of untracked) {
    const info = await lstat(join(root, path));
    requireComparison((size += info.size) <= LIMIT, "candidate capsule exceeds ordinary-file size limit");
    files.push({ path, bytes: (await readFile(join(root, path))).toString("base64"), mode: info.mode & 0o777 });
  }
  requireComparison(size <= LIMIT, "candidate patch exceeds size limit");
  const capsule = parseCapsule({ version: "keystone.workspace-recovery/1",
    head: (await git(root, ["rev-parse", "HEAD"])).trim(), patch,
    changedPaths: (await git(root, ["diff", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean),
    files, modes, fingerprint: before.fingerprint, observedFiles: [...before.files] });
  requireComparison((await observeWorkspace(root)).fingerprint === before.fingerprint,
    "source workspace changed while the candidate was captured");
  return capsule;
}

function protectedPath(path: string): boolean {
  const name = path.split("/").at(-1)!;
  return /(^|\/)(test|tests|__tests__|fixtures)(\/|$)/i.test(path) ||
    /(?:^test[.-]|[.-](?:test|spec)\.[cm]?[jt]sx?$)/i.test(name) ||
    /(?:config|lock)/i.test(name) || name === "package.json" || name === ".npmrc";
}
function commandsFrom(contract: OutcomeContract, input: BaselineComparisonInput): ProtectedCommand[] {
  const conditions = contract.completionConditions.filter((condition) =>
    condition.verifier.kind === "test" || condition.verifier.kind === "regression_test");
  requireComparison(conditions.length > 0 && conditions.length <= 16,
    "original contract has no supported protected test commands");
  return conditions.map((condition) => {
    const command = condition.verifier.params?.["command"];
    requireComparison(typeof command === "string" && command.length <= 512, "protected command is unidentified");
    const { command: bin, args } = splitCommand(command);
    requireComparison(contract.autonomy.allowedCommands.includes(bin), "protected command is outside original allowedCommands");
    requireComparison(bin === "node" || bin === "npm", "only identified node/npm test entries are supported");
    requireComparison(bin === "node" ? safeNodeArgs(args) :
      (args.join(" ") === "run test" || args.join(" ") === "test"), "arbitrary shell or test command flags are unsupported");
    return { conditionId: condition.conditionId, command, bin, args,
      timeoutMs: Math.min(condition.timeoutMs ?? 30_000, input.timeoutMs ?? 30_000, 30_000) };
  });
}
function safeNodeArgs(args: readonly string[]): boolean {
  return args[0] === "--test" && args.slice(1).every((path) => confined(path) &&
    !path.startsWith("-") && /\.[cm]?[jt]s$/.test(path));
}
async function validateEntries(root: string, commands: readonly ProtectedCommand[], tests: readonly string[]): Promise<void> {
  requireComparison(tests.length > 0, "no protected test files were identified");
  for (const command of commands) {
    if (command.bin === "npm") {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const script = manifest?.scripts?.test;
      requireComparison(typeof script === "string" && !manifest.scripts.pretest && !manifest.scripts.posttest,
        "npm test must have an identified entry and no lifecycle hooks");
      const parsed = splitCommand(script);
      requireComparison(parsed.command === "node" && safeNodeArgs(parsed.args), "npm script is not an exact supported node test entry");
      requireComparison(!(await lstat(join(root, ".npmrc")).catch(() => undefined)), "local npm configuration is unsupported");
    }
    for (const path of command.bin === "node" ? command.args.slice(1) : []) {
      requireComparison(tests.includes(path), "explicit test entry is not a protected test file");
    }
  }
}

async function patchPaths(root: string, patch: string): Promise<string[]> {
  if (!patch) return [];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", root, "apply", "--numstat", "-z", "-"], {
      shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("patch inspection timed out")); }, 30_000);
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
      if (Buffer.byteLength(stdout) > LIMIT) child.kill("SIGKILL");
    });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("historical patch could not be inspected"));
      else resolve(stdout);
    });
    child.stdin.end(patch);
  });
  const paths = output.split("\0").filter(Boolean).map((entry) => {
    const fields = entry.split("\t");
    requireComparison(fields.length === 3 && confined(fields[2]!), "unsafe patch path or rename");
    return fields[2]!;
  });
  return [...new Set(paths)].sort();
}

async function checkGitSafety(root: string, heads: readonly string[]): Promise<void> {
  const unsafe = await git(root, ["config", "--get-regexp", "^(filter\\.|core\\.(hooksPath|fsmonitor)|extensions\\.worktreeConfig)"])
    .catch((error: { code?: number }) => { if (error.code === 1) return ""; throw error; });
  requireComparison(!unsafe.trim(), "Git filters, hooks or worktree configuration require a sandboxed comparison");
  const hooksPath = (await git(root, ["rev-parse", "--git-path", "hooks/post-checkout"])).trim();
  const hook = await lstat(resolve(root, hooksPath)).catch(() => undefined);
  requireComparison(!hook || !(hook.mode & 0o111), "active Git checkout hooks are unsupported");
  for (const head of heads) {
    const tree = (await git(root, ["ls-tree", "-r", "-z", head])).split("\0").filter(Boolean);
    requireComparison(tree.every((entry) => /^(100644|100755) blob /.test(entry) &&
      confined(entry.slice(entry.indexOf("\t") + 1))), "Git base includes unsafe paths, symlinks or submodules");
  }
}
function testObservation(captured: CapturedRun) {
  const output = captured.stdout;
  const count = Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0);
  const skipped = Number(/^# skipped (\d+)$/m.exec(output)?.[1] ?? 0);
  const todo = Number(/^# todo (\d+)$/m.exec(output)?.[1] ?? 0);
  const testNames = [...output.matchAll(/^\s*# Subtest: (.+)$/gm)].map((match) => match[1]!).sort();
  const malformed = /SyntaxError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|uncaughtException|cancelledByParent/.test(output + captured.stderr) ||
    /testCodeFailure/.test(output) && !/ERR_ASSERTION|AssertionError/.test(output);
  const forged = /^# (?:TAP version|# (?:Subtest:|tests |fail |pass |cancelled |skipped |todo )|(?:not )?ok \d+|1\.\.)/m.test(output);
  const validTests = !captured.truncated && count > 0 && testNames.length > 0 && !skipped && !todo && !malformed && !forged &&
    /^# cancelled 0$/m.test(output) && /^# fail \d+$/m.test(output);
  const assertionFailure = validTests && captured.status === "failed" && /ERR_ASSERTION|AssertionError/.test(output);
  return { tests: count, testNames, validTests, assertionFailure };
}

/**
 * Confirmed route integration: await compareBaselineCandidate(paths, id, body).
 * Returns no Evidence or Proof; UI must display `verdict`, never parent status.
 */
export async function compareBaselineCandidate(paths: KeystonePaths, taskId: string,
  input: BaselineComparisonInput): Promise<BaselineComparisonReport> {
  requireComparison(input?.confirmed === true, "comparison requires explicit user confirmation");
  for (const value of [input.maxWallClockMs, input.timeoutMs]) {
    requireComparison(value === undefined || (Number.isSafeInteger(value) && value > 0), "invalid comparison budget");
  }
  requireComparison(/^task_[a-zA-Z0-9_-]+$/.test(taskId), "invalid source task id");
  const parent = await KernelSession.open({ paths, taskId: taskId as TaskId });
  requireComparison(isTerminal(parent.state().status), "comparison needs a finished source task");
  const sourceContract = parent.contract();
  requireComparison(sourceContract, "source task has no contract");
  const report: BaselineComparisonReport = {
    version: "keystone.baseline-comparison/1", sourceTaskId: taskId, status: "blocked", verdict: "inconclusive",
    parentProofReused: false, evidenceLevel: null, evidenceIds: [], artifactRefs: [], variants: [],
    budget: { wallClockMs: 0, tokens: 0, maxWallClockMs: 0 },
    limitations: [
      "Observation artifacts only; no E2/E3 evidence, completion decision or source Proof is reused.",
      "Worktrees are not an OS or network sandbox; run only trusted local test code.",
      "The same current environment is used for both variants; the historical runtime environment is not reproduced.",
      "Only exact node --test and npm test entries, ordinary files and an unstaged index are supported.",
    ],
  };
  let maintenance: KernelSession | undefined;
  const artifacts = new Set<string>();
  const worktrees: { root: string; path: string; cleanup: CapabilityLease; parametersHash: string }[] = [];
  const unusedCleanup: CapabilityLease[] = [];
  let finalSourceCheck: (() => Promise<void>) | undefined;
  const started = Date.now();
  const checkCancellation = () => requireComparison(!input.signal?.aborted, "comparison cancelled by caller");
  try {
    checkCancellation();
    const commands = commandsFrom(sourceContract, input);
    const event = parent.events().find((entry) => entry.type === "checkpoint.created");
    requireComparison(event, "initial historical checkpoint is missing");
    const checkpoint = await loadCheckpoint(paths, taskId, String(event.payload.checkpointId));
    requireComparison(checkpoint && checkpoint.integrity === event.payload.integrity &&
      checkpoint.taskId === taskId && checkpoint.branchId === parent.branchId &&
      checkpoint.contractDigest === contentHash(sourceContract), "initial checkpoint contract or ledger binding differs");
    let baseline: Capsule | undefined;
    let binding: ReturnType<typeof runBindingSchema.parse> | undefined;
    let capsuleArtifactId = "";
    for (const ref of checkpoint.artifactRefs) {
      requireComparison(/^art_[0-9a-f]{64}$/.test(ref), "invalid checkpoint artifact reference");
      const bytes = await getArtifactBytes(paths, ref);
      requireComparison(bytes && `art_${sha256Bytes(bytes)}` === ref, "historical checkpoint artifact missing or corrupt");
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (value.version === "keystone.workspace-recovery/1") {
        requireComparison(!baseline, "multiple historical capsules are ambiguous");
        baseline = parseCapsule(value); capsuleArtifactId = ref;
      }
      if (value.schemaVersion === "keystone.runtime.runBinding@1.0.0") {
        requireComparison(!binding, "multiple run bindings are ambiguous");
        binding = runBindingSchema.parse(value);
      }
    }
    requireComparison(baseline && binding && baseline.fingerprint === checkpoint.verification.workspaceFingerprint &&
      baseline.fingerprint === binding.baselineFingerprint &&
      pairsHash(baseline.observedFiles) === pairsHash(binding.baselineFiles.map((file) => [file.path, file.hash])),
    "initial checkpoint has no exact supported historical capsule and run binding");
    const root = await realpath(binding.workPath);
    requireComparison(await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim()) === root,
      "run binding does not identify a workspace root");
    await checkGitSafety(root, [baseline.head, (await git(root, ["rev-parse", "HEAD"])).trim()]);
    const sourceLedger = await readFile(paths.ledgerFile(parent.taskId));
    const sourceLedgerHash = sha256Bytes(sourceLedger);
    const candidateObservation = await observeWorkspace(root);
    const candidateIndexHash = await indexHash(root);
    const candidate = await captureCandidate(root, candidateObservation);
    const baselineMap = new Map(baseline.observedFiles);
    const candidateMap = new Map(candidate.observedFiles);
    const protectedPaths = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])].filter(protectedPath).sort();
    requireComparison(protectedPaths.every((path) => baselineMap.get(path) === candidateMap.get(path)),
      "protected tests, fixtures, package or configuration bytes changed");
    const testPaths = protectedPaths.filter((path) => /(?:^|\/)test[^/]*\.[cm]?[jt]s$|[.-](?:test|spec)\.[cm]?[jt]s$/i.test(path));
    await validateEntries(root, commands, testPaths);
    const originalWrite = (path: string) => decidePath(path, "write", sourceContract.scope).allowed &&
      pathMatchesAny(path, sourceContract.autonomy.writePaths);
    const admitted = [...new Set([...baseline.changedPaths, ...baseline.files.map((file) => file.path),
      ...(baseline.modes ?? []).map((file) => file.path),
      ...candidate.changedPaths, ...candidate.files.map((file) => file.path),
      ...(candidate.modes ?? []).map((file) => file.path)])];
    requireComparison(admitted.every(originalWrite), "capsule restoration includes paths outside the original admitted write scope");
    requireComparison(protectedPaths.every((path) => !baseline!.changedPaths.includes(path) &&
      !baseline!.files.some((file) => file.path === path)), "historical protected tests must come unchanged from the Git base");
    const gitResource = [...candidateMap.keys()].find(originalWrite);
    requireComparison(gitResource, "comparison worktree creation needs an existing original writable scope resource");
    const maxWallClockMs = Math.min(input.maxWallClockMs ?? 240_000,
      sourceContract.budget.maxWallClockMs, sourceContract.autonomy.budget.maxWallClockMs, 240_000);
    requireComparison(maxWallClockMs >= 1000 && sourceContract.budget.maxTokens > 0 &&
      sourceContract.autonomy.budget.maxTokens > 0, "original budget cannot admit comparison");
    report.budget.maxWallClockMs = maxWallClockMs;
    requireComparison(!process.env.NODE_OPTIONS, "NODE_OPTIONS can change test loading; comparison refused");
    const environment = () => contentHash({ env: sanitizeEnv(process.env), node: process.version,
      executable: process.execPath, platform: process.platform, arch: process.arch });
    const environmentHash = environment();
    await checkGitSafety(root, [baseline.head, candidate.head]);
    for (const capsule of [baseline, candidate]) {
      requireComparison(contentHash(await patchPaths(root, capsule.patch)) === contentHash([...new Set(capsule.changedPaths)].sort()),
        "patch paths do not match capsule restoration admission");
    }
    const stableSource = async () => {
      checkCancellation();
      requireComparison((await observeWorkspace(root)).fingerprint === candidateObservation.fingerprint &&
        await indexHash(root) === candidateIndexHash &&
        sha256Bytes(await readFile(paths.ledgerFile(parent.taskId))) === sourceLedgerHash &&
        environment() === environmentHash, "source workspace, ledger or environment changed during comparison");
      checkCancellation();
    };
    finalSourceCheck = stableSource;
    await stableSource();
    const budget = { maxTokens: 1, maxWallClockMs, maxRetries: 0 };
    const autonomy = { ...sourceContract.autonomy, allowedCommands: [...new Set(commands.map((command) => command.bin))],
      allowedHosts: [], allowedCredentials: [], externalSystems: "none" as const, budget };
    maintenance = await KernelSession.create({ paths, projectId: parent.projectId, requestedBy: "user",
      actorId: "runtime.baseline-comparison", request: `Observe historical comparison for ${taskId}`,
      proposeContract: (proposal) => ({ questions: [], contract: outcomeContractSchema.parse({
        ...sourceContract, contractId: newId("contract"), taskId: proposal.taskId, version: 1,
        createdAt: nowIso(), createdBy: "user", goal: `Independently observe baseline and candidate for ${taskId}`,
        autonomy, budget, status: "ready", parentContractId: undefined, revisionReason: undefined, revisionSource: undefined,
        invariants: [{ invariantId: "comparison_immutable", description: "Keep source task and protected test bytes unchanged",
          checkedBy: ["comparison_binding"] }],
        completionConditions: [
          { conditionId: "comparison_binding", description: "Exact historical and candidate content/index, immutable protected tests",
            verifier: { kind: "comparison", id: "baseline.binding", version: "1.0.0" },
            required: true, requiresIndependence: false, minEvidenceLevel: "E2" },
          ...commands.flatMap((command, index) => ["baseline", "candidate"].map((variant) => ({
            conditionId: `comparison_${variant}_${index}`, description: `${variant}: ${command.command}`,
            verifier: { kind: "comparison", id: "baseline.command", version: "1.0.0",
              params: { command: command.command, sourceConditionId: command.conditionId, variant } },
            required: true, requiresIndependence: false, minEvidenceLevel: "E2" as const,
            timeoutMs: command.timeoutMs,
          }))),
        ],
      }) }),
    });
    report.comparisonTaskId = maintenance.taskId;
    await maintenance.submit();
    await maintenance.compile({ autonomy, budget, profile: projectProfileSchema.parse({
      projectId: parent.projectId, rootPath: root, name: "baseline comparison", vcs: "git", languages: ["JavaScript"],
      support: { status: "partially_supported", reasons: ["observation-only local node test comparison"] },
      commands: commands.map((command) => ({ kind: "test", command: command.command, status: "identified",
        source: `contract:${sourceContract.contractId}/${command.conditionId}` })),
      instructionFiles: [], createdAt: nowIso(), updatedAt: nowIso(),
    }) });
    await maintenance.start();
    await maintenance.recordBudget({ wallClockMs: Date.now() - started, reason: "comparison read-only preflight", measured: true });
    const candidateArtifact = await putJsonArtifact(paths, { ...candidate,
      sourceTaskId: taskId, comparisonTaskId: maintenance.taskId, sourceLedgerHash,
      initialCheckpointId: checkpoint.checkpointId, indexHash: candidateIndexHash,
      trustLevel: "untrusted", derivedFrom: [checkpoint.checkpointId] });
    artifacts.add(candidateArtifact.artifactId);
    report.binding = { sourceBranchId: parent.branchId, sourceContractDigest: contentHash(sourceContract),
      sourceLedgerHash, initialCheckpointId: checkpoint.checkpointId, capsuleArtifactId,
      candidateCapsuleArtifactId: candidateArtifact.artifactId,
      baselineContentHash: pairsHash(baseline.observedFiles), candidateContentHash: pairsHash(candidate.observedFiles),
      protectedContentHash: pairsHash(protectedPaths.map((path) => [path, baselineMap.get(path)!])),
      protectedTestsUnchanged: true, environmentHash };
    const session = maintenance;
    const grant = async (capability: "git.write" | "fs.write" | "cmd.exec", resources: string[],
      parameters: Record<string, unknown>, cwd?: string, timeoutMs?: number, argv?: string[]) => {
      const parametersHash = contentHash(parameters);
      const result = await session.authorizeOperation({ subject: { kind: capability === "cmd.exec" ? "verifier" : "orchestrator",
        id: "runtime.baseline-comparison" }, capability, resourceValues: resources, parametersHash, reversibility: "reversible",
        ttlMs: 300_000, ...(cwd ? { workingDirectory: cwd } : {}),
        ...(timeoutMs ? { timeoutMs } : {}), ...(argv ? { argvPrefix: argv } : {}) });
      requireComparison(result.ok, result.ok ? "" : result.denial.detail);
      const valid = validateLease(result.lease, { capability, resourceValues: resources, parametersHash });
      requireComparison(valid.ok, valid.ok ? "" : valid.denial.detail);
      return { lease: result.lease, parametersHash };
    };
    const effect = async <T>(capability: "git.write" | "fs.write", resources: string[],
      parameters: Record<string, unknown>, action: () => Promise<T>, changedPaths: string[] = []) => {
      const { lease } = await grant(capability, resources, parameters);
      const start = Date.now();
      let success = false;
      try { const result = await action(); success = true; return result; }
      finally {
        await session.recordExecution({ proposalId: newId("prop"), leaseId: lease.leaseId,
          status: success ? "succeeded" : "failed", durationMs: Date.now() - start, changedPaths, origin: "verifier" });
      }
    };
    for (const [index, capsule] of [baseline, candidate].entries()) {
      await stableSource();
      const cleanupParameters = { operation: "cleanup", root, head: capsule.head, variant: index,
        sourceTaskId: taskId, capsuleHash: contentHash(capsule) };
      const cleanup = await grant("git.write", [gitResource], cleanupParameters);
      unusedCleanup.push(cleanup.lease);
      const path = await effect("git.write", [gitResource], { operation: "create", root, head: capsule.head,
        sourceTaskId: taskId, capsuleHash: contentHash(capsule) }, () => createIsolatedWorkspace(root, capsule.head, false));
      worktrees.push({ root, path, cleanup: cleanup.lease, parametersHash: cleanup.parametersHash });
      unusedCleanup.pop();
      checkCancellation();
      const restoredPaths = [...new Set([...capsule.changedPaths, ...capsule.files.map((file) => file.path),
        ...(capsule.modes ?? []).map((file) => file.path)])];
      if (restoredPaths.length) {
        await effect("fs.write", restoredPaths, { operation: "restore", path, capsuleHash: contentHash(capsule) }, async () => {
          checkCancellation();
          if (capsule.patch) await applyWorkspacePatch(path, capsule.patch);
          for (const file of capsule.files) {
            checkCancellation();
            await mkdir(dirname(join(path, file.path)), { recursive: true });
            await writeFile(join(path, file.path), Buffer.from(file.bytes, "base64"), { mode: file.mode });
            await chmod(join(path, file.path), file.mode);
          }
          for (const file of capsule.modes ?? []) {
            checkCancellation();
            await chmod(join(path, file.path), file.mode);
          }
        }, restoredPaths);
      }
      const restored = await observeWorkspace(path);
      const expectedIndexHash = index === 0 ? await indexHash(root, capsule.head) : candidateIndexHash;
      const restoredIndexHash = await indexHash(path);
      requireComparison(observationHash(restored) === pairsHash(capsule.observedFiles) && restoredIndexHash === expectedIndexHash,
        "restored full file/index content differs from the bound capsule");
      await validateEntries(path, commands, testPaths);
      const variant: ComparisonVariant = { variant: index === 0 ? "baseline" : "candidate",
        contentHash: pairsHash(capsule.observedFiles), restoredContentHash: observationHash(restored),
        indexHash: expectedIndexHash, restoredIndexHash,
        contentEquivalent: true, unchangedAfterExecution: true, checks: [] };
      report.variants.push(variant);
      for (const command of commands) {
        await stableSource();
        const before = await observeWorkspace(path);
        requireComparison(observationHash(before) === variant.contentHash, "variant changed before protected execution");
        const remaining = maxWallClockMs - (Date.now() - started);
        requireComparison(remaining > 500, "comparison wall-clock budget exhausted");
        const timeoutMs = Math.max(1, Math.min(command.timeoutMs, remaining - 250));
        const captured = await runCaptured(paths, command.bin, command.args, {
          cwd: path, timeoutMs, maxBytes: LIMIT, ...(input.signal ? { signal: input.signal } : {}),
          boundary: {
            authorize: async (bin, args) => {
              checkCancellation();
              const { lease } = await grant("cmd.exec", [bin],
                { bin, args, path, timeoutMs, environmentHash, contentHash: variant.contentHash }, path, timeoutMs, [...args]);
              try {
                await stableSource();
                return lease.leaseId;
              } catch (error) {
                await session.consumeExecutionLease(lease.leaseId);
                throw error;
              }
            },
            complete: async (leaseId, result) => {
              const after = await observeWorkspace(path);
              const changedPaths = changedObservedPaths(before, after);
              variant.unchangedAfterExecution = changedPaths.length === 0 && after.fingerprint === before.fingerprint &&
                await indexHash(path) === expectedIndexHash;
              await session.recordExecution({ proposalId: newId("prop"), leaseId,
                status: input.signal?.aborted ? "cancelled" : result.status === "passed" ? "succeeded" :
                  result.status === "timeout" ? "timeout" : "failed",
                ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
                durationMs: result.durationMs, changedPaths, outputBytes: result.outputBytes,
                outputHash: contentHash({ stdout: result.stdout, stderr: result.stderr }), origin: "verifier" });
            },
          },
        });
        const artifact = await putJsonArtifact(paths, { sourceTaskId: taskId, comparisonTaskId: session.taskId,
          variant: variant.variant, conditionId: command.conditionId, command: command.command,
          workspaceContentHash: variant.contentHash, environmentHash, captured, trustLevel: "untrusted",
          derivedFrom: [index === 0 ? capsuleArtifactId : candidateArtifact.artifactId, checkpoint.checkpointId] });
        artifacts.add(artifact.artifactId);
        if (captured.artifactId) artifacts.add(captured.artifactId);
        variant.checks.push({ conditionId: command.conditionId, command: command.command, status: captured.status,
          ...(captured.exitCode === undefined ? {} : { exitCode: captured.exitCode }),
          durationMs: captured.durationMs, outputArtifactId: artifact.artifactId, ...testObservation(captured) });
        requireComparison(variant.unchangedAfterExecution, "test execution mutated bound code, test bytes or index");
        await stableSource();
      }
    }
    await stableSource();
    const baselineChecks = report.variants[0]!.checks;
    const candidateChecks = report.variants[1]!.checks;
    const valid = baselineChecks.every((check, index) => check.validTests && candidateChecks[index]!.validTests &&
      check.tests === candidateChecks[index]!.tests &&
      contentHash(check.testNames) === contentHash(candidateChecks[index]!.testNames));
    report.status = "observed";
    if (!valid) report.reason = "malformed, skipped, empty or differing test identities; no discriminating assertion comparison";
    else if (candidateChecks.some((check) => check.status !== "passed")) report.verdict = "candidate_failed";
    else if (baselineChecks.every((check) => check.status === "passed")) report.verdict = "non_discriminating";
    else if (baselineChecks.every((check) => check.status === "passed" || check.assertionFailure)) {
      report.verdict = "baseline_failed_candidate_passed";
    } else report.reason = "baseline failed without an identified test assertion; causality is not established";
  } catch (error) {
    report.status = "blocked";
    report.verdict = "inconclusive";
    report.reason = error instanceof Error ? error.message : "comparison unavailable";
  } finally {
    if (maintenance) {
      for (const lease of unusedCleanup) await maintenance.consumeExecutionLease(lease.leaseId);
      for (const worktree of worktrees.reverse()) {
        const start = Date.now();
        let cleaned = false;
        try {
          const valid = validateLease(worktree.cleanup, { capability: "git.write",
            resourceValues: worktree.cleanup.resource.values, parametersHash: worktree.parametersHash });
          requireComparison(valid.ok, valid.ok ? "" : valid.denial.detail);
          await removeIsolatedWorkspace(worktree.root, worktree.path);
          requireComparison(!(await lstat(worktree.path).catch(() => undefined)), "worktree cleanup did not remove its directory");
          cleaned = true;
        } catch {
          report.status = "blocked"; report.verdict = "inconclusive";
          report.reason = "comparison worktree cleanup unavailable; manual cleanup may be required";
        } finally {
          await maintenance.recordExecution({ proposalId: newId("prop"), leaseId: worktree.cleanup.leaseId,
            status: cleaned ? "succeeded" : "failed", durationMs: Date.now() - start, origin: "verifier" });
        }
      }
      try { await finalSourceCheck?.(); }
      catch (error) {
        report.status = "blocked"; report.verdict = "inconclusive";
        report.reason = error instanceof Error ? error.message : "source comparison binding changed";
      }
      report.budget.wallClockMs = Date.now() - started;
      const unaccounted = Math.max(0, report.budget.wallClockMs - maintenance.state().budgetUsed.wallClockMs);
      await maintenance.recordBudget({ wallClockMs: unaccounted, reason: "comparison observation and artifact bookkeeping", measured: true });
      if (report.budget.wallClockMs > report.budget.maxWallClockMs) {
        report.status = "blocked"; report.verdict = "inconclusive"; report.reason = "comparison measured wall-clock budget exceeded";
      }
      report.artifactRefs = [...artifacts];
      const stored = await putJsonArtifact(paths, report);
      report.artifactRefs.push(stored.artifactId);
      await maintenance.checkpoint("stage_boundary", { artifactRefs: report.artifactRefs,
        contractDigest: contentHash(maintenance.contract()) });
      await maintenance.stop(input.signal?.aborted ? "Comparison cancelled by caller; cleanup completed" :
        "Observation-only comparison complete; no proof decision was requested", false,
        maintenance.contract()!.completionConditions.map((condition) => condition.conditionId));
    }
  }
  return report;
}
