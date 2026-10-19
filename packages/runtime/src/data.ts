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

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { foldTaskState, readJsonLines, readLedger, type KeystonePaths } from "@keystone/kernel";
import { isActive, projectProfileSchema } from "@keystone/schemas";

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
  /** Directories the storage layout documents as derived and rebuildable. */
  readonly derived: {
    readonly index: DataSize;
    readonly cache: DataSize;
    readonly proofs: DataSize;
  };
  readonly totals: DataSize;
}

export class DataError extends Error {
  readonly code: "invalid_id" | "task_active" | "not_found";
  constructor(code: DataError["code"], message: string) {
    super(message);
    this.name = "DataError";
    this.code = code;
  }
}

/** Recursive size of a directory; unreadable entries are skipped, not fatal. */
async function dirSize(dir: string): Promise<DataSize> {
  let files = 0;
  let bytes = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await dirSize(absolute);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) continue;
    files += 1;
    bytes += info.size;
  }
  return { files, bytes };
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
    ...(await dirSize(dir)),
  };
}

async function inventoryTask(paths: KeystonePaths, taskId: string): Promise<TaskInventory> {
  const ledger = await readLedger(paths.ledgerFile(taskId as never)).catch(() => undefined);
  let status: string | null = null;
  if (ledger !== undefined && ledger.events.length > 0) {
    status = foldTaskState(ledger.events).status;
  }
  const checkpoints = (await readdir(paths.checkpointsDir(taskId as never)).catch(() => [])).filter(
    (name) => name.endsWith(".json"),
  ).length;

  return {
    taskId,
    status,
    events: ledger?.events.length ?? 0,
    checkpoints,
    ...(await dirSize(paths.taskDir(taskId as never))),
  };
}

/** Read-only inventory of everything under the Keystone home. */
export async function storeInventory(paths: KeystonePaths): Promise<StoreInventory> {
  const projectIds = (await readdir(paths.projectsDir).catch(() => [])).filter((name) =>
    PROJECT_ID.test(name),
  );
  const taskIds = (await readdir(paths.tasksDir).catch(() => [])).filter((name) =>
    TASK_ID.test(name),
  );

  const projects: ProjectInventory[] = [];
  for (const projectId of projectIds) projects.push(await inventoryProject(paths, projectId));

  const tasks: TaskInventory[] = [];
  for (const taskId of taskIds) tasks.push(await inventoryTask(paths, taskId));

  const artifacts = await dirSize(paths.artifactsDir);
  const index = await dirSize(paths.indexDir);
  const cache = await dirSize(paths.cacheDir);
  const proofs = await dirSize(paths.proofsDir);

  const totals = [
    ...projects,
    ...tasks,
    artifacts,
    index,
    cache,
    proofs,
  ].reduce<DataSize>(
    (sum, entry) => ({ files: sum.files + entry.files, bytes: sum.bytes + entry.bytes }),
    { files: 0, bytes: 0 },
  );

  return { home: paths.home, projects, tasks, artifacts, derived: { index, cache, proofs }, totals };
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
  const exists = await stat(dir).catch(() => undefined);
  if (exists === undefined) {
    throw new DataError("not_found", `no stored history exists for task ${taskId}`);
  }

  const inventory = await inventoryTask(paths, taskId);
  if (inventory.status !== null && (isActive(inventory.status as never) || inventory.status === "resuming")) {
    throw new DataError(
      "task_active",
      `task ${taskId} is still "${inventory.status}"; stop it before deleting its history`,
    );
  }

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
 * Clear a project's experience cache: candidates, promoted entries and their
 * evaluations.
 *
 * This is the one cognition store that is safe to drop wholesale — the next
 * task simply stops being told about past lessons (PRD LE-04, CX-02). Project
 * facts are deliberately *not* cleared here: they carry user-confirmed rules
 * and repository observations that a cache reset has no business discarding.
 */
export async function clearProjectExperience(
  paths: KeystonePaths,
  projectId: string,
): Promise<ClearedExperience> {
  if (!PROJECT_ID.test(projectId)) {
    throw new DataError("invalid_id", `"${projectId}" is not a project id`);
  }
  const cleared: ClearedExperience = {
    projectId,
    candidates: await countLines(paths.experienceCandidatesFile(projectId as never)),
    entries: await countLines(paths.experienceEntriesFile(projectId as never)),
    evaluations: await countLines(paths.experienceEvaluationsFile(projectId as never)),
  };
  await rm(paths.experienceCandidatesFile(projectId as never), { force: true });
  await rm(paths.experienceEntriesFile(projectId as never), { force: true });
  await rm(paths.experienceEvaluationsFile(projectId as never), { force: true });
  return cleared;
}
