/**
 * Local data inventory and user-initiated cleanup (PRD ST-02, 12.4).
 *
 * Keystone keeps everything outside the managed repository, under
 * `~/.keystone` (ADR-0005). A user is entitled to see what is stored and to
 * remove it — but removal has consequences that must be stated before it
 * happens, so this module separates the two: `storeInventory` only reads, and
 * each removal returns exactly what it destroyed.
 *
 * Two deliberate boundaries:
 *
 *  - Nothing here touches a repository. Deleting project cognition or a task's
 *    history never deletes the user's code (PRD ST-02).
 *  - A task that is still active is never deleted: its ledger is the only record
 *    of a change that may already be on disk, and erasing it would leave an
 *    effect with no account of itself (PRD 9.1, NFR-REL-01).
 */

import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { foldTaskState, KernelSession, readJsonLines, readLedger, type KeystonePaths } from "@keystone/kernel";
import { experienceCandidateSchema, experienceEntrySchema, experienceEvaluationSchema,
  isTerminal, projectProfileSchema, type TaskState } from "@keystone/schemas";
import { rejectExperienceCandidateWithConsent, withExperienceMaintenance } from "./experience-actions.ts";

/** Ids come from a URL; they must be validated before they become a file path. */
const TASK_ID = /^task_[0-9A-Za-z]+$/;
const PROJECT_ID = /^proj_[0-9A-Za-z]+$/;

export interface DataSize {
  readonly files: number;
  readonly bytes: number;
}

export interface ProjectInventory extends DataSize {
  readonly projectId: string;
  readonly name: string | null;
  readonly rootPath: string | null;
  readonly facts: number;
  readonly experience: {
    readonly candidates: number;
    readonly entries: number;
    readonly evaluations: number;
  };
}

export interface TaskInventory extends DataSize {
  readonly taskId: string;
  readonly status: string | null;
  readonly events: number;
  readonly checkpoints: number;
}

export interface StoreInventory {
  readonly home: string;
  readonly projects: readonly ProjectInventory[];
  readonly tasks: readonly TaskInventory[];
  readonly artifacts: DataSize;
  /** Only filenames/configuration handles are read, never credential material. */
  readonly credentials: DataSize & { readonly handles: readonly string[] };
  /** Input metadata plus its original artifact bytes; overlaps `artifacts`. */
  readonly attachments: DataSize;
  readonly settings: DataSize;
  /** Task ledgers, checkpoints and branch metadata; overlaps `tasks`. */
  readonly history: DataSize;
  /** Directories the storage layout documents as derived and rebuildable. */
  readonly derived: {
    readonly index: DataSize;
    readonly cache: DataSize;
    readonly proofs: DataSize;
  };
  readonly totals: DataSize;
}

export class DataError extends Error {
  readonly code: "invalid_id" | "invalid_options" | "task_active" | "not_found" |
    "unsafe_path" | "protected_data" | "referenced_data" | "invalid_store" |
    "overlap" | "destination_exists" | "credentials_require_migration" |
    "verification_failed" | "source_changed" | "io_error";
  readonly status: number;
  readonly impact?: DataSize & { readonly category?: string; readonly preview?: boolean; readonly destination?: string };
  constructor(code: DataError["code"], message: string, impact?: DataError["impact"]) {
    super(message);
    this.name = "DataError";
    this.code = code;
    this.status = code === "not_found" ? 404 :
      ["invalid_id", "invalid_options", "unsafe_path"].includes(code) ? 400 :
      code === "io_error" ? 500 : 409;
    this.impact = impact;
  }
}

export function pathWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DataError("io_error", "stored data is inaccessible");
  }
}

/** Refuse symlinks (even internal ones) rather than implicitly following them. */
export async function assertStorePath(paths: KeystonePaths, path: string): Promise<void> {
  const home = resolve(paths.home);
  const absolute = resolve(path);
  if (!pathWithin(home, absolute)) throw new DataError("unsafe_path", "path is outside the data store");
  const parts = relative(home, absolute).split(sep).filter(Boolean);
  let current = home;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]!);
    const info = await optionalStat(current);
    if (info === undefined) return;
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) ||
        (index < parts.length - 1 && !info.isDirectory())) {
      throw new DataError("unsafe_path", "data operations require ordinary files and directories without symlinks");
    }
    const canonical = await realpath(current);
    if (!pathWithin(await realpath(home), canonical)) throw new DataError("unsafe_path", "stored path escapes the data home");
  }
}

export interface StoreFile {
  readonly path: string;
  readonly bytes: number;
}

/** Inventory never opens files; missing stores are empty, access errors are not. */
export async function listStoreFiles(paths: KeystonePaths, dir = paths.home): Promise<StoreFile[]> {
  await assertStorePath(paths, dir);
  const info = await optionalStat(dir);
  if (info === undefined) return [];
  if (info.isFile()) return [{ path: dir, bytes: info.size }];
  const files: StoreFile[] = [];
  for (const name of (await readdir(dir)).sort()) {
    files.push(...await listStoreFiles(paths, join(dir, name)));
  }
  return files;
}

export function sizeOf(files: readonly StoreFile[]): DataSize {
  return files.reduce<DataSize>((sum, file) => ({ files: sum.files + 1, bytes: sum.bytes + file.bytes }), { files: 0, bytes: 0 });
}

async function dirSize(paths: KeystonePaths, dir: string): Promise<DataSize> {
  return sizeOf(await listStoreFiles(paths, dir));
}

async function directoryNames(paths: KeystonePaths, dir: string): Promise<string[]> {
  await assertStorePath(paths, dir);
  if (await optionalStat(dir) === undefined) return [];
  return (await readdir(dir)).sort();
}

async function taskState(paths: KeystonePaths, taskId: string): Promise<TaskState | undefined> {
  await assertStorePath(paths, paths.ledgerFile(taskId as never));
  try {
    const ledger = await readLedger(paths.ledgerFile(taskId as never));
    if (!ledger.integrity.ok || ledger.tornTail || ledger.events.some((event) => event.taskId !== taskId)) return undefined;
    return foldTaskState(ledger.events);
  } catch { return undefined; }
}

/** Unknown/torn/future task records cannot establish that deletion is safe. */
export async function assertInactiveTasks(
  paths: KeystonePaths,
  options: { readonly projectId?: string; readonly impact?: DataError["impact"] } = {},
): Promise<void> {
  for (const taskId of await directoryNames(paths, paths.tasksDir)) {
    const state = TASK_ID.test(taskId) ? await taskState(paths, taskId) : undefined;
    if (state !== undefined && options.projectId !== undefined && state.projectId !== options.projectId) continue;
    if (state === undefined || !isTerminal(state.status) || state.activeLeaseIds.length > 0) {
      throw new DataError("task_active", "a task is nonterminal or cannot be verified inactive; stop and recover it first", options.impact);
    }
  }
}

export function containsProtectedRule(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsProtectedRule);
  const record = value as Record<string, unknown>;
  return record.frozen === true || record.status === "frozen" ||
    record.promotedBy === "user_confirmation" || record.userConfirmed === true ||
    record.confirmedBy === "user" || Object.values(record).some(containsProtectedRule);
}

async function countLines(filePath: string): Promise<number> {
  const { items } = await readJsonLines<unknown>(filePath);
  return items.length;
}

async function inventoryProject(
  paths: KeystonePaths,
  projectId: string,
): Promise<ProjectInventory> {
  let name: string | null = null;
  let rootPath: string | null = null;
  // `project.json` is a pretty-printed single document, not JSON Lines, so it is
  // read whole rather than line by line.
  const profileText = await readFile(paths.projectFile(projectId as never), "utf8").catch(
    () => undefined,
  );
  if (profileText !== undefined) {
    try {
      const parsed = projectProfileSchema.parse(JSON.parse(profileText));
      name = parsed.name;
      rootPath = parsed.rootPath;
    } catch {
      // A profile from a future or broken runtime is still listed, with the
      // fields it could not supply reported as unknown.
    }
  }

  const dir = paths.projectDir(projectId as never);
  return {
    projectId,
    name,
    rootPath,
    facts: await countLines(paths.factsFile(projectId as never)),
    experience: {
      candidates: await countLines(paths.experienceCandidatesFile(projectId as never)),
      entries: await countLines(paths.experienceEntriesFile(projectId as never)),
      evaluations: await countLines(paths.experienceEvaluationsFile(projectId as never)),
    },
    ...(await dirSize(paths, dir)),
  };
}

async function inventoryTask(paths: KeystonePaths, taskId: string): Promise<TaskInventory> {
  const ledger = await readLedger(paths.ledgerFile(taskId as never)).catch(() => undefined);
  let status: string | null = null;
  status = (await taskState(paths, taskId))?.status ?? null;
  const checkpoints = (await readdir(paths.checkpointsDir(taskId as never)).catch(() => [])).filter(
    (name) => name.endsWith(".json"),
  ).length;

  return {
    taskId,
    status,
    events: ledger?.events.length ?? 0,
    checkpoints,
    ...(await dirSize(paths, paths.taskDir(taskId as never))),
  };
}

/** Read-only inventory of everything under the Keystone home. */
export async function storeInventory(paths: KeystonePaths): Promise<StoreInventory> {
  const allFiles = await listStoreFiles(paths);
  const projectIds = (await directoryNames(paths, paths.projectsDir)).filter((name) =>
    PROJECT_ID.test(name),
  );
  const taskIds = (await directoryNames(paths, paths.tasksDir)).filter((name) =>
    TASK_ID.test(name),
  );

  const projects: ProjectInventory[] = [];
  for (const projectId of projectIds) projects.push(await inventoryProject(paths, projectId));

  const tasks: TaskInventory[] = [];
  for (const taskId of taskIds) tasks.push(await inventoryTask(paths, taskId));

  const under = (dir: string) => allFiles.filter((file) => pathWithin(dir, file.path));
  const credentialFiles = under(paths.credentialsDir);
  const handles = new Set(credentialFiles.flatMap((file) => {
    const name = relative(paths.credentialsDir, file.path);
    return /^[a-z0-9][a-z0-9._-]{1,63}\.json$/.test(name) ? [name.slice(0, -5)] : [];
  }));
  const configText = await readFile(paths.configFile, "utf8").catch(() => undefined);
  if (configText !== undefined) {
    try {
      const config = JSON.parse(configText) as { models?: { credentialHandle?: unknown }[] };
      for (const model of config.models ?? []) {
        if (typeof model.credentialHandle === "string" && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(model.credentialHandle)) handles.add(model.credentialHandle);
      }
    } catch { /* Invalid configuration does not hide its on-disk size. */ }
  }
  const inputFiles = under(join(paths.home, "inputs"));
  const attachmentPaths = new Set(inputFiles.map((file) => file.path));
  for (const file of inputFiles.filter((entry) => entry.path.endsWith(".json"))) {
    try {
      const metadata = JSON.parse(await readFile(file.path, "utf8")) as { artifactId?: unknown };
      if (typeof metadata.artifactId !== "string" || !/^art_[a-f0-9]{64}$/.test(metadata.artifactId)) continue;
      const digest = metadata.artifactId.slice(4);
      attachmentPaths.add(join(paths.artifactsDir, digest.slice(0, 2), digest));
    } catch { /* Unreadable input metadata is still counted, not guessed. */ }
  }
  return {
    home: paths.home, projects, tasks,
    artifacts: sizeOf(under(paths.artifactsDir)),
    credentials: { ...sizeOf(credentialFiles), handles: [...handles].sort() },
    attachments: sizeOf(allFiles.filter((file) => attachmentPaths.has(file.path))),
    settings: sizeOf(allFiles.filter((file) => ["config.json", "presentation.json", "settings.json", "credential-service.json"].includes(relative(paths.home, file.path)))),
    history: sizeOf(under(paths.tasksDir)),
    derived: { index: sizeOf(under(paths.indexDir)), cache: sizeOf(under(paths.cacheDir)), proofs: sizeOf(under(paths.proofsDir)) },
    totals: sizeOf(allFiles),
  };
}

export interface DeletedTask {
  readonly taskId: string;
  readonly events: number;
  readonly checkpoints: number;
  readonly bytes: number;
}

/**
 * Delete one task's stored history: its ledger, checkpoints, run branches and
 * any proof artifacts keyed by its id.
 *
 * Refused while the task is active — deleting the ledger of a run that may have
 * already changed the workspace would destroy the only account of that change.
 * The caller must stop it first.
 */
export async function deleteTaskHistory(
  paths: KeystonePaths,
  taskId: string,
): Promise<DeletedTask> {
  if (!TASK_ID.test(taskId)) {
    throw new DataError("invalid_id", `"${taskId}" is not a task id`);
  }
  const dir = paths.taskDir(taskId as never);
  await assertStorePath(paths, dir);
  await assertStorePath(paths, paths.proofsDirFor(taskId as never));
  const exists = await optionalStat(dir);
  if (exists === undefined) {
    throw new DataError("not_found", `no stored history exists for task ${taskId}`);
  }

  await assertInactiveTasks(paths);
  const inventory = await inventoryTask(paths, taskId);
  await listStoreFiles(paths, paths.proofsDirFor(taskId as never));

  await rm(dir, { recursive: true, force: true });
  await rm(paths.proofsDirFor(taskId as never), { recursive: true, force: true });

  return {
    taskId,
    events: inventory.events,
    checkpoints: inventory.checkpoints,
    bytes: inventory.bytes,
  };
}

export interface ClearedExperience {
  readonly projectId: string;
  readonly candidates: number;
  readonly entries: number;
  readonly evaluations: number;
}

/**
 * Revoke a project's unprotected experience before dropping its projections.
 *
 * Audit events remain authoritative. Quarantined candidates require bound user
 * consent and kernel rejection; active entries require kernel demotion.
 * Frozen/user-confirmed records, facts and source task ledgers remain protected.
 */
export async function clearProjectExperience(
  paths: KeystonePaths,
  projectId: string,
): Promise<ClearedExperience> {
  if (!PROJECT_ID.test(projectId)) {
    throw new DataError("invalid_id", `"${projectId}" is not a project id`);
  }
  await listStoreFiles(paths, paths.projectDir(projectId as never));
  await assertInactiveTasks(paths, { projectId });
  const files = [paths.experienceCandidatesFile(projectId as never),
    paths.experienceEntriesFile(projectId as never), paths.experienceEvaluationsFile(projectId as never)] as const;
  const readRecords = async (file: string) => {
    let records;
    try { records = await readJsonLines<unknown>(file); }
    catch { throw new DataError("protected_data", "experience is unreadable; recover it before clearing"); }
    if (records.tornTail && await readFile(file, "utf8") !== "") {
      throw new DataError("protected_data", "experience is incomplete; recover it before clearing");
    }
    if (records.items.some(containsProtectedRule)) throw new DataError("protected_data", "frozen or user-confirmed experience cannot be cleared as cache");
    return records.items;
  };
  // Check both the existing projection and the authoritative rebuild: losing a
  // protected row must not turn a refused clear into an allowed one.
  for (const file of files) await readRecords(file);
  await listStoreFiles(paths, paths.tasksDir);
  try {
    await KernelSession.rebuildProjectExperience({ paths, projectId });
  } catch {
    throw new DataError("protected_data", "experience source cannot be verified; recover it before clearing");
  }
  const candidateRecords = await readRecords(files[0]);
  const entryRecords = await readRecords(files[1]);
  const evaluationRecords = await readRecords(files[2]);
  let candidates;
  let entries;
  try {
    candidates = candidateRecords.map((record) => experienceCandidateSchema.parse(record));
    entries = entryRecords.map((record) => experienceEntrySchema.parse(record));
    evaluationRecords.forEach((record) => experienceEvaluationSchema.parse(record));
    if (candidates.some((candidate) => candidate.projectId !== projectId) ||
        entries.some((entry) => entry.projectId !== projectId)) {
      throw new Error("foreign experience");
    }
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("protected_data", "experience records cannot be validated; recover them before clearing");
  }
  const cleared: ClearedExperience = {
    projectId,
    candidates: candidateRecords.length,
    entries: entryRecords.length,
    evaluations: evaluationRecords.length,
  };
  await assertInactiveTasks(paths, { projectId });
  try {
    if (candidates.some((candidate) => candidate.status === "quarantined") ||
        entries.some((entry) => entry.status === "active")) {
      await withExperienceMaintenance(paths, projectId, "User requested project experience clear", async (session) => {
        for (const candidate of candidates) {
          if (candidate.status !== "quarantined") continue;
          await rejectExperienceCandidateWithConsent(session, candidate.candidateId, "user cleared project experience");
        }
        for (const entry of entries) {
          if (entry.status !== "active") continue;
          await session.recordExperienceDemotion({
            entryId: entry.entryId, reason: "user_requested",
            detail: "user cleared project experience", affectedTaskIds: [],
          });
        }
      });
      await KernelSession.rebuildProjectExperience({ paths, projectId });
      const remainingCandidates = (await readRecords(files[0])).map((record) => experienceCandidateSchema.parse(record));
      const remainingEntries = (await readRecords(files[1])).map((record) => experienceEntrySchema.parse(record));
      if (remainingCandidates.some((candidate) => candidate.status === "quarantined") ||
          remainingEntries.some((entry) => entry.status === "active")) {
        throw new DataError("protected_data", "experience revocation could not be established from kernel events");
      }
    }
    for (const file of files) await rm(file, { force: true });
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("io_error", "experience clear was interrupted; committed revocations remain durable, retry after recovery");
  }
  return cleared;
}
