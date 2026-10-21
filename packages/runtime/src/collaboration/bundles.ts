import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { foldTaskState, verifyChain } from "@keystone/kernel";
import {
  checkpointSchema, contentHash, runBranchSchema, sha256Bytes,
  type Checkpoint, type RunBranch, type RunEvent,
} from "@keystone/schemas";
import { bundleManifestSchema, rejectRunEventSecrets, rejectSecrets } from "./signatures.ts";

const MAX_BYTES = 32 * 1024 * 1024;
export function portablePath(path: string): string {
  if (path.length === 0 || path.length > 512 || isAbsolute(path) || /[\\:%\x00-\x1f]/.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === ".." ||
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("unsafe portable path");
  }
  return path;
}

export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export async function boundedRead(root: string, path: string, limit: number): Promise<Buffer> {
  portablePath(path);
  let current = root;
  for (const component of path.split("/")) {
    current = join(current, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error("bundle symlink rejected");
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("bundle size or file kind rejected");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error("bundle changed during read");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export interface BundlePreview {
  readonly root: string; readonly digest: string; readonly taskId: string; readonly branchId: string;
  readonly environmentDigest: string; readonly authority: "imported_candidate";
  readonly includesRecoveryWorkspace: boolean;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly { artifactId: string; sha256: string; bytes: number; path: string }[];
  readonly totalBytes: number; readonly limitations: readonly string[];
}

/** Validate logical ancestry without relabeling or rehashing inherited events. */
export function validateBundleHistory(events: readonly RunEvent[], taskId: string, selectedBranchId?: string): string {
  if (events[0]?.type !== "task.created" || events.some((event) => event.taskId !== taskId)) {
    throw new Error("ledger identity mismatch");
  }
  if (!verifyChain(events).ok) throw new Error("ledger integrity rejected");
  let currentBranchId = events[0].branchId;
  let binding: Omit<RunBranch, "workspacePath"> | undefined;
  const branches = new Set<string>([currentBranchId]);
  const checkpoints = new Map<string, Checkpoint>();
  for (const event of events) {
    if (event.type === "branch.created") {
      const { workspacePath: _workspacePath, ...branch } = runBranchSchema.parse(event.payload);
      if (branch.taskId !== taskId || branch.branchId !== event.branchId) {
        throw new Error("ledger branch identity mismatch");
      }
      if (event.branchId === currentBranchId) {
        // recordBranchWorkspace re-commits the binding; only its location may change.
        if (!binding || contentHash(branch) !== contentHash(binding)) {
          throw new Error("ledger branch binding changed");
        }
      } else {
        const checkpoint = branch.parentCheckpointId === undefined ? undefined : checkpoints.get(branch.parentCheckpointId);
        if (branches.has(branch.branchId) || branch.forkedFromBranchId !== currentBranchId ||
            !checkpoint || checkpoint.branchId !== currentBranchId || event.seq !== checkpoint.seq + 2 ||
            branch.contractId !== checkpoint.contractId || branch.contractVersion !== checkpoint.contractVersion) {
          throw new Error("ledger branch transition rejected");
        }
        // The copied prefix must represent the selected checkpoint's actual state.
        if (contentHash(foldTaskState(events.slice(0, checkpoint.seq))) !== contentHash(checkpoint.state)) {
          throw new Error("ledger checkpoint differs from inherited state");
        }
        currentBranchId = branch.branchId;
        branches.add(currentBranchId);
        binding = branch;
      }
    } else if (event.branchId !== currentBranchId) {
      throw new Error("ledger branch switch is not committed");
    }
    if (event.type === "checkpoint.created") {
      const checkpoint = checkpointSchema.parse(event.payload);
      const { integrity, ...fields } = checkpoint;
      if (checkpoint.taskId !== taskId || checkpoint.branchId !== currentBranchId ||
          checkpoint.seq !== event.seq - 1 || checkpoint.state.seq !== checkpoint.seq ||
          checkpoint.state.taskId !== taskId || checkpoint.state.branchId !== currentBranchId ||
          checkpoint.contractId !== checkpoint.state.contractId ||
          checkpoint.contractVersion !== checkpoint.state.contractVersion ||
          contentHash(fields) !== integrity || checkpoints.has(checkpoint.checkpointId)) {
        throw new Error("ledger checkpoint identity or integrity rejected");
      }
      checkpoints.set(checkpoint.checkpointId, checkpoint);
    }
  }
  const state = foldTaskState(events);
  if (state.taskId !== taskId || state.branchId !== currentBranchId ||
      (selectedBranchId !== undefined && selectedBranchId !== currentBranchId)) {
    throw new Error("ledger final branch identity mismatch");
  }
  return currentBranchId;
}

/** Reads and verifies only. It never restores files, follows commands or admits evidence. */
export async function previewBundle(directory: string): Promise<BundlePreview> {
  const root = await realpath(directory);
  const manifestBytes = await boundedRead(root, "manifest.json", 1024 * 1024);
  const raw: unknown = JSON.parse(manifestBytes.toString("utf8"));
  rejectSecrets(raw);
  const manifest = bundleManifestSchema.parse(raw);
  if (manifest.ledger.path !== portablePath(manifest.ledger.path) || manifest.ledger.path !== "ledger.jsonl") {
    throw new Error("ledger path must be ledger.jsonl");
  }
  const ledger = await boundedRead(root, manifest.ledger.path, MAX_BYTES);
  if (sha256Bytes(ledger) !== manifest.ledger.sha256 || !ledger.toString("utf8").endsWith("\n")) {
    throw new Error("ledger digest or torn record rejected");
  }
  const rows = ledger.toString("utf8").slice(0, -1).split("\n");
  if (rows.length !== manifest.ledger.eventCount) throw new Error("ledger count mismatch");
  const events = rows.map((line) => {
    const rawEvent: unknown = JSON.parse(line);
    return rejectRunEventSecrets(rawEvent);
  });
  validateBundleHistory(events, manifest.taskId, manifest.branchId);
  if (events.at(-1)?.hash !== manifest.ledger.tipHash) throw new Error("ledger integrity rejected");
  const artifactIds = new Set<string>();
  const paths = new Set<string>(["manifest.json", "ledger.jsonl"]);
  let totalBytes = ledger.length + manifestBytes.length;
  for (const artifact of manifest.artifacts) {
    portablePath(artifact.path);
    if (artifact.artifactId !== `art_${artifact.sha256}` ||
        artifact.path !== `artifacts/${artifact.sha256.slice(0, 2)}/${artifact.sha256}` ||
        paths.has(artifact.path.toLowerCase()) || artifactIds.has(artifact.artifactId)) {
      throw new Error("artifact path or address mismatch");
    }
    totalBytes += artifact.bytes;
    if (totalBytes > MAX_BYTES) throw new Error("bundle byte budget exceeded");
    paths.add(artifact.path.toLowerCase());
    artifactIds.add(artifact.artifactId);
    const bytes = await boundedRead(root, artifact.path, Math.min(MAX_BYTES, artifact.bytes));
    if (bytes.length !== artifact.bytes || sha256Bytes(bytes) !== artifact.sha256) throw new Error("artifact integrity rejected");
    rejectSecrets(bytes.toString("utf8"));
    const text = bytes.toString("utf8");
    if (/^\s*[{[]/.test(text)) {
      let json: unknown;
      try { json = JSON.parse(text); } catch { /* Non-JSON tool output is permitted. */ }
      if (json !== undefined) {
        rejectSecrets(json);
        if ((json as { version?: unknown } | null)?.version === "keystone.workspace-recovery/1") {
          if (manifest.includesRecoveryWorkspace !== true) {
            throw new Error("workspace recovery capsule is not implicitly portable");
          }
        }
      }
    }
  }
  const checkRefs = (value: unknown): void => {
    if (typeof value === "string" && /^art_/.test(value)) {
      if (!/^art_[0-9a-f]{64}$/.test(value) || !artifactIds.has(value)) throw new Error("missing artifact reference");
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) checkRefs(child);
    }
  };
  for (const event of events) checkRefs(event.payload);
  return {
    root, digest: contentHash(manifest), taskId: manifest.taskId, branchId: manifest.branchId,
    environmentDigest: manifest.environmentDigest, authority: "imported_candidate",
    includesRecoveryWorkspace: manifest.includesRecoveryWorkspace === true,
    events, artifacts: manifest.artifacts, totalBytes,
    limitations: ["Integrity is not authenticity or local completion.", "No execution or workspace restoration.",
      "Secrets in arbitrary source text cannot be exhaustively detected.", "Concurrent hostile filesystem mutation is not sandboxed."],
  };
}
