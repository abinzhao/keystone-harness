/**
 * Explicit local data operations. The controller must block new work while
 * mutating data and switch its in-memory stores only after verified migration.
 * No ledgers, permission decisions, repository files or credentials are edited.
 */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic, type KeystonePaths } from "@keystone/kernel";
import { credentialServiceName } from "@keystone/models";
import {
  assertInactiveTasks, assertStorePath, containsProtectedRule, DataError,
  listStoreFiles, pathWithin, sizeOf, type DataSize, type StoreFile,
} from "./data.ts";

export type CleanupCategory = "cache" | "index" | "proofs";
export interface CleanupImpact extends DataSize {
  readonly category: CleanupCategory;
  readonly preview: boolean;
  readonly removed?: boolean;
}

async function jsonRecords(file: string): Promise<unknown[]> {
  try {
    const text = await readFile(file, "utf8");
    if (file.endsWith(".jsonl")) {
      if (text !== "" && !text.endsWith("\n")) throw new Error("incomplete record");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
    return [JSON.parse(text)];
  } catch {
    throw new DataError("invalid_store", "stored metadata is unreadable; recover it before data management");
  }
}

function stringsIn(value: unknown, output: Set<string>): void {
  if (typeof value === "string") output.add(value);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) stringsIn(child, output);
  }
}

function hasReferencedIdentity(value: unknown, references: ReadonlySet<string>): boolean {
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (["artifactId", "proofId", "contentHash", "proofGraphHash"].includes(key) &&
        typeof child === "string" && references.has(child)) return true;
    if (hasReferencedIdentity(child, references)) return true;
  }
  return false;
}

async function fileHash(paths: KeystonePaths, file: string): Promise<string> {
  await assertStorePath(paths, file);
  const hash = createHash("sha256");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Includes both the independent registry and pre-registry project profiles. */
async function repositoryRoots(paths: KeystonePaths): Promise<string[]> {
  const files = await listStoreFiles(paths, paths.projectsDir);
  const roots = new Set<string>();
  for (const file of files) {
    const rel = relative(paths.projectsDir, file.path);
    if (rel !== "registry.json" && basename(file.path) !== "project.json") continue;
    const [metadata] = await jsonRecords(file.path);
    const record = metadata as { projects?: unknown; rootPath?: unknown } | null;
    const entries = rel === "registry.json" ? record?.projects : [record];
    if (!Array.isArray(entries)) throw new DataError("invalid_store", "project registry cannot establish repository boundaries");
    for (const entry of entries) {
      const root = (entry as { rootPath?: unknown } | null)?.rootPath;
      if (typeof root !== "string" || !isAbsolute(root)) throw new DataError("invalid_store", "project metadata cannot establish repository boundaries");
      roots.add(await canonicalDestination(root));
    }
  }
  return [...roots];
}

async function assertRepositorySeparation(paths: KeystonePaths, destination?: string): Promise<void> {
  const source = await canonicalDestination(paths.home);
  for (const root of await repositoryRoots(paths)) {
    if (pathWithin(root, source) || pathWithin(source, root) ||
        (destination !== undefined && (pathWithin(root, destination) || pathWithin(destination, root)))) {
      throw new DataError("overlap", "data storage must not overlap a registered repository");
    }
  }
}

/**
 * Preview and execution run the same safety checks. A protected/reference
 * refusal carries the complete proposed impact and removes nothing.
 */
export async function previewCleanup(
  paths: KeystonePaths,
  input: { readonly category: CleanupCategory; readonly preview: boolean },
): Promise<CleanupImpact> {
  if (input === null || typeof input !== "object" ||
      !["cache", "index", "proofs"].includes(input.category) || typeof input.preview !== "boolean") {
    throw new DataError("invalid_options", "cleanup requires a derived category and an explicit preview flag");
  }
  const directory = join(paths.home, input.category);
  const configured = input.category === "cache" ? paths.cacheDir : input.category === "index" ? paths.indexDir : paths.proofsDir;
  if (resolve(configured) !== resolve(directory)) throw new DataError("unsafe_path", "cleanup only operates on the documented derived directories");
  const files = await listStoreFiles(paths, directory);
  const impact: CleanupImpact = { category: input.category, ...sizeOf(files), preview: input.preview };
  await assertInactiveTasks(paths, { impact });
  await assertRepositorySeparation(paths);
  const referenceSources = new Map<string, Set<string>>();
  for (const dir of [paths.tasksDir, paths.projectsDir, join(paths.home, "inputs"), paths.proofsDir]) {
    for (const file of await listStoreFiles(paths, dir)) {
      if (!/\.jsonl?$/.test(file.path)) continue;
      const references = new Set<string>();
      for (const record of await jsonRecords(file.path)) stringsIn(record, references);
      for (const reference of references) {
        const sources = referenceSources.get(reference) ?? new Set<string>();
        sources.add(file.path);
        referenceSources.set(reference, sources);
      }
    }
  }
  for (const file of files) {
    // An object's self-identity is not an external reference. Other proofs in
    // the same cleanup batch still count as dependents and prevent removal.
    const references = new Set([...referenceSources].filter(([, sources]) =>
      [...sources].some((source) => source !== file.path)).map(([reference]) => reference));
    const name = basename(file.path);
    const identities = [
      file.path, relative(paths.home, file.path), relative(directory, file.path),
      relative(paths.home, file.path).split(sep).join("/"), name, name.replace(/\.json$/, ""),
    ];
    if (identities.some((identity) => references.has(identity)) ||
        references.has(`art_${name}`) || references.has(await fileHash(paths, file.path))) {
      throw new DataError("referenced_data", "cleanup would remove referenced checkpoint or proof data", impact);
    }
    if (/\.jsonl?$/.test(file.path)) {
      for (const record of await jsonRecords(file.path)) {
        if (containsProtectedRule(record)) throw new DataError("protected_data", "cleanup would remove frozen or user-confirmed rules", impact);
        if (hasReferencedIdentity(record, references)) throw new DataError("referenced_data", "cleanup would remove a referenced proof or artifact", impact);
      }
    }
  }
  if (input.preview) return impact;
  await assertInactiveTasks(paths, { impact });
  // Only unlink the inspected files; never recursively remove unseen arrivals.
  for (const file of files) {
    await assertStorePath(paths, file.path);
    await rm(file.path, { force: true });
  }
  return { ...impact, removed: true };
}

const SERVICE_METADATA = "credential-service.json";

/** Controller passes this value to createCredentialBroker({ ..., service }). */
export async function readCredentialService(paths: KeystonePaths): Promise<string> {
  const path = join(paths.home, SERVICE_METADATA);
  await assertStorePath(paths, path);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return credentialServiceName(paths.credentialsDir);
    throw new DataError("invalid_store", "credential namespace metadata is inaccessible");
  }
  try {
    const metadata = JSON.parse(text) as { version?: unknown; service?: unknown };
    if (metadata.version !== "1.0.0" || typeof metadata.service !== "string" ||
        !/^net\.keystone\.credentials\.[a-f0-9]{32}$/.test(metadata.service) ||
        Object.keys(metadata).some((key) => key !== "version" && key !== "service")) throw new Error();
    return metadata.service;
  } catch { throw new DataError("invalid_store", "invalid credential namespace metadata"); }
}

export interface MigrationResult extends DataSize {
  readonly destination: string;
  readonly verified: boolean;
  readonly preview: boolean;
  readonly newHome?: string;
  readonly sourcePreserved: true;
  readonly credentialService: string;
  readonly manifestHash: string;
  readonly ignoredLockfiles: number;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new DataError("io_error", "migration path is inaccessible");
  }
}

/** Resolve symlinked existing ancestors even when the final path is absent. */
async function canonicalDestination(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!await exists(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  try { return join(await realpath(ancestor), ...missing); }
  catch { throw new DataError("unsafe_path", "migration path cannot be resolved"); }
}

function transientLock(paths: KeystonePaths, file: string): boolean {
  const rel = relative(paths.home, file).split(sep).join("/");
  return ["settings.lock", "projects/registry.json.lock"].includes(rel) ||
    /^tasks\/task_[0-9A-Za-z]+\/(?:task|branches\/branch_[0-9A-Za-z]+)\.lock$/.test(rel) ||
    /^inputs\/attachment\.[a-f0-9]{32}\.json\.lock$/.test(rel);
}

interface ManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly hash: string;
}

async function manifest(paths: KeystonePaths, files: readonly StoreFile[]): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const file of files) entries.push({ path: relative(paths.home, file.path).split(sep).join("/"), bytes: file.bytes, hash: await fileHash(paths, file.path) });
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function manifestDigest(entries: readonly ManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * Copy into a private sibling, compare sorted content hashes twice, then
 * publish. Source is never removed. No process configuration is changed here.
 */
export async function migrateData(
  paths: KeystonePaths,
  input: { readonly destination: string; readonly preview: boolean },
): Promise<MigrationResult> {
  if (input === null || typeof input !== "object" || typeof input.destination !== "string" ||
      !isAbsolute(input.destination) || input.destination.includes("\0") || typeof input.preview !== "boolean") {
    throw new DataError("invalid_options", "migration requires an absolute destination and an explicit preview flag");
  }
  if (!await exists(paths.home)) throw new DataError("not_found", "migration source data home does not exist");
  const destination = await canonicalDestination(input.destination);
  const source = await canonicalDestination(paths.home);
  if (pathWithin(source, destination) || pathWithin(destination, source)) throw new DataError("overlap", "migration source and destination must be separate");
  await assertRepositorySeparation(paths, destination);
  if (await exists(input.destination) || await exists(destination)) throw new DataError("destination_exists", "migration never overwrites an existing destination");
  const allFiles = await listStoreFiles(paths);
  await assertInactiveTasks(paths);
  if (allFiles.some((file) => pathWithin(paths.credentialsDir, file.path))) {
    throw new DataError("credentials_require_migration", "legacy credential files require explicit broker migration before moving the data home");
  }
  const credentialService = await readCredentialService(paths);
  const files = allFiles.filter((file) => !transientLock(paths, file.path));
  const initial = await manifest(paths, files);
  const metadata = JSON.stringify({ version: "1.0.0", service: credentialService });
  const expected = initial.filter((entry) => entry.path !== SERVICE_METADATA);
  expected.push({ path: SERVICE_METADATA, bytes: Buffer.byteLength(metadata), hash: createHash("sha256").update(metadata).digest("hex") });
  expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const result: MigrationResult = {
    destination, verified: false, preview: input.preview, sourcePreserved: true,
    credentialService, manifestHash: manifestDigest(expected),
    files: expected.length, bytes: expected.reduce((sum, entry) => sum + entry.bytes, 0),
    ignoredLockfiles: allFiles.length - files.length,
  };
  if (input.preview) return result;

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(parent, ".keystone-migration-"));
  let reservation: { ino: number; dev: number } | undefined;
  try {
    for (const file of files) {
      const target = join(stage, relative(paths.home, file.path));
      await assertStorePath(paths, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(file.path, target, constants.COPYFILE_EXCL);
      const handle = await open(target, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await writeFileAtomic(join(stage, SERVICE_METADATA), metadata);
    const stagePaths = { ...paths, home: stage };
    const copied = await manifest(stagePaths, await listStoreFiles(stagePaths));
    if (manifestDigest(copied) !== result.manifestHash) throw new DataError("verification_failed", "migration content hashes do not match; source is preserved", result);
    const currentFiles = (await listStoreFiles(paths)).filter((file) => !transientLock(paths, file.path));
    if (manifestDigest(await manifest(paths, currentFiles)) !== manifestDigest(initial)) throw new DataError("source_changed", "source changed during migration; source is preserved", result);
    await assertInactiveTasks(paths);
    await assertRepositorySeparation(paths, destination);
    if (await canonicalDestination(input.destination) !== destination) throw new DataError("unsafe_path", "destination identity changed during migration", result);
    // Reserve exclusively. rename replaces only this operation's empty directory,
    // never a pre-existing user destination (including one created during copy).
    try { await mkdir(destination, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DataError("destination_exists", "destination appeared during migration; nothing is overwritten", result);
      throw error;
    }
    const info = await lstat(destination);
    reservation = { ino: info.ino, dev: info.dev };
    if (info.isSymbolicLink() || !info.isDirectory() || (await readdir(destination)).length !== 0) {
      throw new DataError("destination_exists", "destination changed during migration; nothing is overwritten", result);
    }
    await rename(stage, destination);
    reservation = undefined;
    return { ...result, verified: true, newHome: destination };
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("io_error", "migration failed; the source and existing destinations are preserved", result);
  } finally {
    // Only this operation's staging directory and empty reservation are removed.
    await rm(stage, { recursive: true, force: true });
    if (reservation !== undefined) {
      const info = await lstat(destination).catch(() => undefined);
      if (info?.ino === reservation.ino && info.dev === reservation.dev) await rmdir(destination).catch(() => undefined);
    }
  }
}
