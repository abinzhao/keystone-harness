import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { compareBranches, getArtifactBytes, KernelSession, listBranches, loadCheckpoint, putJsonArtifact,
  summarizeBranch, type KeystonePaths } from "@keystone/kernel";
import { contentHash, nowIso, runBindingSchema, runBranchSchema, sha256Bytes,
  type RunBranch, type RunBinding } from "@keystone/schemas";
import { changedPathsFromEvents } from "./diff.ts";
import { applyWorkspacePatch, createIsolatedWorkspace } from "./isolation.ts";
import { observeWorkspace } from "./workspace-observation.ts";

const exec = promisify(execFile);
interface WorkspaceCapsule {
  version: "keystone.workspace-recovery/1";
  head: string;
  patch: string;
  changedPaths: string[];
  files: { path: string; bytes: string; mode: number }[];
  trackedModes?: { path: string; mode: number }[];
  fingerprint: string;
  observedFiles: [string, string][];
}
const forbidden = /(^|\/)(\.env(?:\..*)?|credentials?|secrets?|.*\.(?:pem|key|p12))$/i;
function confined(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === ".." || part === ".git") && !forbidden.test(path);
}

export async function captureRecoveryWorkspace(paths: KeystonePaths, root: string): Promise<string | undefined> {
  try {
    const before = await observeWorkspace(root);
    const head = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const patch = (await exec("git", ["-C", root, "diff", "--binary", "HEAD"], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    if ((await exec("git", ["-C", root, "diff", "--cached", "--name-only"])).stdout.trim()) return undefined;
    const dirty = (await exec("git", ["-C", root, "diff", "--name-only", "HEAD"])).stdout.split("\n").filter(Boolean);
    if (dirty.some((path) => !confined(path))) return undefined;
    const tracked = (await exec("git", ["-C", root, "ls-files", "-z", "--cached"])).stdout.split("\0").filter(Boolean);
    const untracked = (await exec("git", ["-C", root, "ls-files", "-z", "--others", "--exclude-standard"])).stdout.split("\0").filter(Boolean);
    if (tracked.some((path) => forbidden.test(path)) || untracked.some((path) => !confined(path))) return undefined;
    const covered = new Set([...tracked, ...untracked]);
    if ([...before.files.keys()].some((path) => !covered.has(path))) return undefined;
    const files: WorkspaceCapsule["files"] = [];
    const trackedModes: NonNullable<WorkspaceCapsule["trackedModes"]> = [];
    for (const path of dirty.filter((path) => tracked.includes(path))) {
      const info = await lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      // Git omits non-executable permission bits; deletions and links have no regular-file mode to restore.
      if (info?.isFile()) trackedModes.push({ path, mode: info.mode & 0o777 });
    }
    let bytes = Buffer.byteLength(patch);
    for (const path of untracked) {
      const info = await lstat(join(root, path));
      if (!info.isFile() || (bytes += info.size) > 4 * 1024 * 1024) return undefined;
      files.push({ path, bytes: (await readFile(join(root, path))).toString("base64"), mode: info.mode & 0o777 });
    }
    if ((await observeWorkspace(root)).fingerprint !== before.fingerprint) return undefined;
    return (await putJsonArtifact(paths, { version: "keystone.workspace-recovery/1", head, patch, changedPaths: dirty, files, trackedModes,
      fingerprint: before.fingerprint, observedFiles: [...before.files] })).artifactId;
  } catch { return undefined; }
}

export async function forkContinuousBranch(paths: KeystonePaths, taskId: string,
  input: { checkpointId: string; label: string; reason?: string }): Promise<RunBranch> {
  const session = await KernelSession.open({ paths, taskId: taskId as never });
  const checkpoint = await loadCheckpoint(paths, taskId, input.checkpointId);
  if (!checkpoint || checkpoint.branchId !== session.branchId) throw new Error("selected checkpoint unavailable");
  let capsule: WorkspaceCapsule | undefined;
  let binding: RunBinding | undefined;
  for (const ref of checkpoint.artifactRefs) {
    const bytes = await getArtifactBytes(paths, ref);
    if (!bytes || `art_${sha256Bytes(bytes)}` !== ref) throw new Error("checkpoint artifact missing or corrupt");
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value.version === "keystone.workspace-recovery/1") capsule = value as WorkspaceCapsule;
    if (value.schemaVersion === "keystone.runtime.runBinding@1.0.0") binding = runBindingSchema.parse(value);
  }
  if (!capsule || !binding || capsule.fingerprint !== checkpoint.verification.workspaceFingerprint) {
    throw new Error("checkpoint has no exact supported workspace capsule; historical execution fork unavailable");
  }
  const trackedModes = capsule.trackedModes ?? [];
  if (!Array.isArray(trackedModes) || trackedModes.some((file) => !file || typeof file.path !== "string" ||
    !confined(file.path) || !capsule.changedPaths?.includes(file.path) ||
    !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) {
    throw new Error("unsafe or unadmitted capsule tracked mode");
  }
  // The detached fork receives the checkpoint contract; permissions remain the
  // user's existing task envelope. No source session events are appended.
  const branch = await session.branch(input.label, input.reason ?? "user requested checkpoint fork",
    { checkpointId: input.checkpointId });
  const fork = await KernelSession.open({ paths, taskId: taskId as never, branchId: branch.branchId });
  const contract = fork.contract()!;
  if (!["executing", "verifying", "auto_repairing"].includes(fork.state().status)) throw new Error("checkpoint is not an executable fork point");
  const resource = contract.scope.include.filter((entry) => entry.intent === "write").map((entry) => entry.pattern);
  if (!resource.length) throw new Error("fork requires an existing writable task scope");
  const parameters = { checkpointId: input.checkpointId, capsuleHash: contentHash(capsule), label: input.label };
  const grant = await fork.authorizeOperation({ subject: { kind: "orchestrator", id: "user.checkpoint-fork" },
    capability: "git.write", resourceValues: resource, parametersHash: contentHash(parameters), reversibility: "reversible" });
  if (!grant.ok) throw new Error(grant.denial.detail);
  const restoredPaths = [...new Set([...(capsule.changedPaths ?? []), ...capsule.files.map((file) => file.path)])];
  if (capsule.patch && capsule.changedPaths === undefined) throw new Error("legacy capsule has no restorable path admission");
  const filesGrant = restoredPaths.length ? await fork.authorizeOperation({
    subject: { kind: "orchestrator", id: "user.checkpoint-fork" }, capability: "fs.write",
    resourceValues: restoredPaths, parametersHash: contentHash(parameters), reversibility: "reversible",
  }) : undefined;
  if (filesGrant && !filesGrant.ok) {
    await fork.consumeExecutionLease(grant.lease.leaseId);
    throw new Error(filesGrant.denial.detail);
  }
  const start = Date.now();
  let consumed = false;
  try {
    const workPath = await createIsolatedWorkspace(binding.workspacePath, capsule.head, false);
    if (capsule.patch) await applyWorkspacePatch(workPath, capsule.patch);
    for (const file of capsule.files) {
      if (!confined(file.path)) throw new Error("unsafe capsule path");
      await mkdir(join(workPath, file.path, ".."), { recursive: true });
      await writeFile(join(workPath, file.path), Buffer.from(file.bytes, "base64"), { mode: file.mode });
    }
    for (const file of trackedModes) {
      if (!filesGrant?.ok) throw new Error("tracked mode restore requires filesystem lease");
      const parts = file.path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        if (!(await lstat(join(workPath, ...parts.slice(0, depth)))).isDirectory()) {
          throw new Error("tracked mode restore cannot traverse a non-directory");
        }
      }
      const target = join(workPath, file.path);
      if (!(await lstat(target)).isFile()) throw new Error("tracked mode restore requires a regular file");
      await chmod(target, file.mode);
    }
    const nextBinding = await putJsonArtifact(paths, runBindingSchema.parse({ ...binding,
      workPath, workspacePath: binding.workspacePath,
      baselineFingerprint: contentHash({
        files: binding.baselineFiles.map((file) => [file.path, file.hash]), head: capsule.head, branch: "",
      }),
    }));
    const restored = await observeWorkspace(workPath);
    if (contentHash([...restored.files]) !== contentHash(capsule.observedFiles)) {
      throw new Error("restored checkpoint workspace does not match source content/index; fork refused");
    }
    const fingerprint = restored.fingerprint;
    await fork.consumeExecutionLease(grant.lease.leaseId);
    if (filesGrant?.ok) await fork.consumeExecutionLease(filesGrant.lease.leaseId);
    consumed = true;
    await fork.recordBudget({ wallClockMs: Date.now() - start, reason: "create checkpoint worktree", measured: true });
    await fork.checkpoint("stage_boundary", { artifactRefs: [nextBinding.artifactId],
      verification: { workspaceFingerprint: fingerprint as never }, contractDigest: contentHash(contract) });
    await fork.recordBranchWorkspace(workPath);
    // The workspace location is derived from a committed binding, not used as
    // independent state authority. Return it for the caller's navigation.
    return { ...branch, workspacePath: workPath };
  } catch (error) {
    if (!consumed) await fork.consumeExecutionLease(grant.lease.leaseId);
    if (!consumed && filesGrant?.ok) await fork.consumeExecutionLease(filesGrant.lease.leaseId);
    throw error;
  }
}

export async function continuousBranchViews(paths: KeystonePaths, taskId: string) {
  const session = await KernelSession.open({ paths, taskId: taskId as never });
  const contract = session.contract();
  if (!contract) throw new Error("task has no contract");
  const primary = runBranchSchema.parse({ branchId: session.branchId, taskId, label: "primary",
    forkedAt: session.state().createdAt, reason: "primary run", status: "active",
    contractId: contract.contractId, contractVersion: contract.version });
  const records = [primary, ...await listBranches(paths, taskId)];
  return Promise.all(records.map(async (branch) => {
    const current = await KernelSession.open({ paths, taskId: taskId as never, branchId: branch.branchId });
    const changedPaths = changedPathsFromEvents(current.events());
    let fingerprint: string | undefined;
    const checkpoint = await current.latestCheckpoint();
    for (const ref of checkpoint?.artifactRefs ?? []) {
      const bytes = await getArtifactBytes(paths, ref);
      if (!bytes || `art_${sha256Bytes(bytes)}` !== ref) continue;
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (value.schemaVersion !== "keystone.runtime.runBinding@1.0.0") continue;
        const binding = runBindingSchema.parse(value);
        fingerprint = (await observeWorkspace(binding.workPath).catch(() => undefined))?.fingerprint;
      } catch { /* Missing or unreadable current workspace cannot support a current proof. */ }
    }
    const proof = await current.exportProof({ changedPaths,
      workspaceFingerprint: fingerprint ?? contentHash({ workspace: "unavailable", branchId: branch.branchId }) });
    const historical = summarizeBranch({ branch, state: current.state(),
      changedPaths, evidence: await current.evidence(), contract: current.contract() });
    const required = proof.conditions.filter((condition) => condition.required);
    const supported = required.filter((condition) => condition.satisfied).length;
    return { ...branch, summary: { ...historical,
      outcome: historical.outcome === "proven" && proof.outcome !== "proven" ? "unknown" as const : historical.outcome,
      verificationStatus: proof.outcome === "proven" ? "satisfied" as const
        : supported > 0 ? "partially_satisfied" as const : "unsatisfied" as const,
      residualRiskCount: Math.max(required.length - supported, proof.residualRisks.length, proof.outcome === "proven" ? 0 : 1),
    }, status: current.state().status, contract: current.contract(), proof };
  }));
}
export async function compareContinuousBranches(paths: KeystonePaths, taskId: string, left: string, right: string) {
  const rows = await continuousBranchViews(paths, taskId);
  const selected = rows.filter((row) => row.branchId === left || row.branchId === right);
  if (left === right || selected.length !== 2) throw new Error("choose two existing different branches");
  return { ...compareBranches(selected.map((row) => row.summary), { taskId, at: nowIso() }),
    budget: selected.map((row) => ({ branchId: row.branchId, tokens: row.summary.tokensUsed, wallClockMs: row.summary.wallClockMs })),
    changes: selected.map((row) => ({ branchId: row.branchId, paths: row.summary.changedPaths })),
    proof: selected.map((row) => ({ branchId: row.branchId, outcome: row.proof.outcome, verification: row.summary.verificationStatus })) };
}
