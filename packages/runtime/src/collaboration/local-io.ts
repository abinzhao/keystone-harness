import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type KeystonePaths } from "@keystone/kernel";
import { canonicalJson, contentHash, newId, sha256Bytes } from "@keystone/schemas";
import { assertStorePath } from "../data.ts";
import { boundedRead, inside, portablePath, validateBundleHistory, type BundlePreview } from "./bundles.ts";
import { bundleManifestSchema, rejectRunEventSecrets, rejectSecrets } from "./signatures.ts";
import { authorizedLease, localDecision, maintenanceSession, type LocalProject } from "./local-session.ts";

export const LOCAL_BYTES = 32 * 1024 * 1024;
export interface PortableFiles {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly digest: string;
}

export function localRoots(paths: KeystonePaths) {
  const root = join(paths.home, "collaboration");
  return { root, exports: join(root, "exports"), inbox: join(root, "inbox"), quarantine: join(root, "quarantine") };
}

export async function assertBundleRoot(root: string, allowed: readonly string[]) {
  const requested = resolve(root);
  const declared = allowed.map((path) => resolve(path)).find((path) => inside(path, requested) && path !== requested);
  if (!declared) throw new Error("bundle root not admitted; use a package directory inside exports or inbox");
  let current = declared;
  if ((await lstat(current)).isSymbolicLink()) throw new Error("bundle root symlink rejected");
  for (const part of relative(declared, requested).split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("bundle root symlink rejected");
  }
  if (!inside(await realpath(declared), await realpath(requested))) throw new Error("bundle root escape rejected");
  return requested;
}

function checkContent(bytes: Buffer, includeRecoveryWorkspace = false) {
  const text = bytes.toString("utf8");
  rejectSecrets(text);
  let value: unknown;
  if (/^\s*[{[]/.test(text)) {
    try { value = JSON.parse(text); } catch { /* Ordinary non-JSON output remains portable. */ }
  }
  if (value !== undefined) {
    rejectSecrets(value);
    if ((value as { version?: unknown } | null)?.version === "keystone.workspace-recovery/1") {
      if (!includeRecoveryWorkspace) throw new Error("workspace recovery capsule export requires explicit source-content opt-in; implicit export refused");
      const capsule = value as { head?: unknown; patch?: unknown; changedPaths?: unknown; files?: unknown; fingerprint?: unknown; observedFiles?: unknown };
      const safe = (path: unknown) => typeof path === "string" && portablePath(path) === path &&
        !/(^|\/)(\.git|\.env(?:\..*)?|credentials?|secrets?|.*\.(?:pem|key|p12))$/i.test(path);
      if (typeof capsule.head !== "string" || !/^[0-9a-f]{40,64}$/.test(capsule.head) ||
          typeof capsule.patch !== "string" || typeof capsule.fingerprint !== "string" ||
          !/^[0-9a-f]{64}$/.test(capsule.fingerprint) ||
          !Array.isArray(capsule.changedPaths) || !capsule.changedPaths.every(safe) ||
          !Array.isArray(capsule.files) || capsule.files.some((file) =>
            !file || !safe(file.path) || typeof file.bytes !== "string" ||
            !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) ||
          !Array.isArray(capsule.observedFiles) || capsule.observedFiles.some((row) =>
            !Array.isArray(row) || row.length !== 2 || !safe(row[0]) || typeof row[1] !== "string" || !/^[0-9a-f]{64}$/.test(row[1]))) {
        throw new Error("unsupported workspace capsule cannot be exported");
      }
    }
  }
}

export async function collectTaskBundle(paths: KeystonePaths, taskId: string, branchId?: string,
  options: { readonly includeRecoveryWorkspace?: boolean } = {}) {
  if (!/^task_[0-9A-Za-z]+$/.test(taskId) || (branchId && !/^branch_[0-9A-Za-z]+$/.test(branchId))) {
    throw new Error("invalid local task or branch identity");
  }
  const ledgerFile = branchId ? paths.branchLedgerFile(taskId as never, branchId as never) : paths.ledgerFile(taskId as never);
  await assertStorePath(paths, ledgerFile);
  const ledger = await boundedRead(paths.home, relative(paths.home, ledgerFile).split(sep).join("/"), LOCAL_BYTES);
  if (!ledger.toString("utf8").endsWith("\n")) throw new Error("torn ledger cannot be exported");
  const rows = ledger.toString("utf8").slice(0, -1).split("\n");
  if (rows.length > 100000) throw new Error("ledger event budget exceeded");
  const events = rows.map((line) => {
    const raw: unknown = JSON.parse(line); return rejectRunEventSecrets(raw);
  });
  const logicalBranchId = validateBundleHistory(events, taskId, branchId);
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("art_")) {
      if (!/^art_[0-9a-f]{64}$/.test(value)) throw new Error("invalid referenced artifact");
      ids.add(value);
    } else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  events.forEach((e) => visit(e.payload));
  if (ids.size > 4096) throw new Error("artifact count limit exceeded");
  const files = new Map<string, Buffer>([["ledger.jsonl", ledger]]);
  const artifacts = [];
  let total = ledger.length;
  for (const artifactId of [...ids].sort()) {
    const digest = artifactId.slice(4);
    const path = `artifacts/${digest.slice(0, 2)}/${digest}`;
    await assertStorePath(paths, join(paths.artifactsDir, digest.slice(0, 2), digest));
    const bytes = await boundedRead(paths.artifactsDir, `${digest.slice(0, 2)}/${digest}`, LOCAL_BYTES - total);
    if (sha256Bytes(bytes) !== digest) throw new Error("referenced artifact integrity rejected");
    checkContent(bytes, options.includeRecoveryWorkspace === true);
    total += bytes.length;
    artifacts.push({ artifactId, path, sha256: digest, bytes: bytes.length });
    files.set(path, bytes);
  }
  const manifest = bundleManifestSchema.parse({
    version: "keystone.task-bundle/1", taskId, branchId: logicalBranchId,
    ...(options.includeRecoveryWorkspace === true ? { includesRecoveryWorkspace: true } : {}),
    environmentDigest: contentHash(events.filter((e) =>
      ["run.binding_recorded", "contract.compiled", "contract.revised", "checkpoint.created"].includes(e.type))),
    ledger: { path: "ledger.jsonl", sha256: sha256Bytes(ledger), tipHash: events.at(-1)!.hash, eventCount: events.length },
    artifacts,
  });
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  if (total + manifestBytes.length > LOCAL_BYTES || manifestBytes.length > 1024 * 1024) throw new Error("bundle byte budget exceeded");
  files.set("manifest.json", manifestBytes);
  return { files, digest: contentHash(manifest), projectId: events[0]!.payload["projectId"] };
}

export async function collectPreview(bundle: BundlePreview): Promise<PortableFiles> {
  const files = new Map<string, Buffer>();
  for (const path of ["manifest.json", "ledger.jsonl", ...bundle.artifacts.map((artifact) => artifact.path)]) {
    files.set(path, await boundedRead(bundle.root, path, LOCAL_BYTES));
  }
  const manifest = bundleManifestSchema.parse(JSON.parse(files.get("manifest.json")!.toString("utf8")));
  if (contentHash(manifest) !== bundle.digest ||
      sha256Bytes(files.get("ledger.jsonl")!) !== manifest.ledger.sha256 ||
      manifest.artifacts.some((a) => sha256Bytes(files.get(a.path)!) !== a.sha256)) throw new Error("bundle changed after preview");
  return { files, digest: bundle.digest };
}

/** One bounded operation; no unlisted files, overwrites, foreign ledger writes or private keys. */
export async function writePortableFiles(paths: KeystonePaths, project: LocalProject, destination: string,
  bundle: PortableFiles, goal: string, existingDirectory = false) {
  const roots = localRoots(paths);
  if (!inside(roots.root, destination) || destination === roots.root) throw new Error("destination outside local collaboration");
  await assertStorePath(paths, destination);
  if (!existingDirectory) {
    try { await lstat(destination); throw new Error("destination already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const resources = [roots.root, dirname(destination), destination, `${destination}/**`];
  const parameters = { destination, digest: bundle.digest,
    files: [...bundle.files].map(([path, bytes]) => ({ path, sha256: sha256Bytes(bytes), bytes: bytes.length })) };
  const session = await maintenanceSession(paths, project, { goal, resources });
  try {
    const decision = await localDecision(session, "fs.write", resources, parameters);
    const lease = await authorizedLease(session, "fs.write", resources, contentHash(parameters), decision);
    await session.consumeExecutionLease(lease.leaseId);
    await assertStorePath(paths, destination);
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination, { recursive: existingDirectory });
    for (const [path, bytes] of bundle.files) {
      portablePath(path);
      const target = join(destination, path);
      if (!inside(destination, target)) throw new Error("portable write path escape");
      await assertStorePath(paths, target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    await session.recordExecution({ proposalId: newId("prop"), status: "succeeded", durationMs: 0,
      changedPaths: [destination], outputHash: bundle.digest });
    return { taskId: session.taskId, eventId: session.events().findLast((e) => e.type === "action.executed")!.eventId };
  } finally { await session.stop("local operation recorded; no completion claimed"); }
}
