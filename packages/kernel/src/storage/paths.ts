/**
 * Storage layout.
 *
 * Runtime data never lives inside a managed repository: writing there would
 * pollute the user's working tree, show up in git status, and break the premise
 * that a snapshot contains only the user's content (ADR-0005).
 *
 * The ledger is the only source of truth. `index/`, `cache/` and `proofs/` are
 * derived and may be deleted at any time; they rebuild from the ledger, the
 * artifacts and the project model (PRD NFR-REL-06).
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { derivedIdBody, type BranchId, type CheckpointId, type ProjectId, type TaskId } from "@keystone/schemas";

export const KEYSTONE_HOME_ENV = "KEYSTONE_HOME";

export interface KeystonePaths {
  readonly home: string;
  readonly configFile: string;
  readonly credentialsDir: string;
  readonly projectsDir: string;
  readonly tasksDir: string;
  readonly artifactsDir: string;
  readonly indexDir: string;
  readonly cacheDir: string;
  readonly proofsDir: string;
  readonly projectDir: (projectId: ProjectId) => string;
  readonly projectFile: (projectId: ProjectId) => string;
  readonly factsFile: (projectId: ProjectId) => string;
  readonly experienceCandidatesFile: (projectId: ProjectId) => string;
  readonly experienceEntriesFile: (projectId: ProjectId) => string;
  readonly experienceEvaluationsFile: (projectId: ProjectId) => string;
  readonly taskDir: (taskId: TaskId) => string;
  readonly ledgerFile: (taskId: TaskId) => string;
  readonly branchLedgerFile: (taskId: TaskId, branchId: BranchId) => string;
  readonly checkpointsDir: (taskId: TaskId) => string;
  readonly checkpointFile: (taskId: TaskId, checkpointId: CheckpointId) => string;
  readonly taskLockFile: (taskId: TaskId) => string;
  readonly snapshotFile: (projectId: ProjectId, snapshotId: string) => string;
  readonly proofsDirFor: (taskId: TaskId) => string;
}

/**
 * Resolve the store root. `KEYSTONE_HOME` overrides `~/.keystone`, which is how
 * tests get an isolated store and how users relocate their data.
 */
export function resolveKeystonePaths(homeOverride?: string): KeystonePaths {
  const home = resolve(
    homeOverride ?? process.env[KEYSTONE_HOME_ENV] ?? join(homedir(), ".keystone"),
  );

  const projectsDir = join(home, "projects");
  const tasksDir = join(home, "tasks");
  const artifactsDir = join(home, "artifacts");

  const projectDir = (projectId: ProjectId): string => join(projectsDir, projectId);
  const taskDir = (taskId: TaskId): string => join(tasksDir, taskId);

  return {
    home,
    configFile: join(home, "config.json"),
    credentialsDir: join(home, "credentials"),
    projectsDir,
    tasksDir,
    artifactsDir,
    indexDir: join(home, "index"),
    cacheDir: join(home, "cache"),
    proofsDir: join(home, "proofs"),

    projectDir,
    projectFile: (projectId) => join(projectDir(projectId), "project.json"),
    factsFile: (projectId) => join(projectDir(projectId), "facts.jsonl"),
    experienceCandidatesFile: (projectId) =>
      join(projectDir(projectId), "experience", "candidates.jsonl"),
    experienceEntriesFile: (projectId) =>
      join(projectDir(projectId), "experience", "entries.jsonl"),
    experienceEvaluationsFile: (projectId) =>
      join(projectDir(projectId), "experience", "evaluations.jsonl"),

    taskDir,
    ledgerFile: (taskId) => join(taskDir(taskId), "ledger.jsonl"),
    branchLedgerFile: (taskId, branchId) =>
      join(taskDir(taskId), "branches", `${branchId}.jsonl`),
    checkpointsDir: (taskId) => join(taskDir(taskId), "checkpoints"),
    checkpointFile: (taskId, checkpointId) =>
      join(taskDir(taskId), "checkpoints", `${checkpointId}.json`),
    taskLockFile: (taskId) => join(taskDir(taskId), "task.lock"),
    snapshotFile: (projectId, snapshotId) =>
      join(projectDir(projectId), "snapshots", `${snapshotId}.json`),
    proofsDirFor: (taskId) => join(home, "proofs", taskId),
  };
}

/**
 * Deterministic project id: the same workspace always maps to the same store
 * directory, on every machine, without a registry. Realpath is used so that a
 * symlinked checkout does not create a second, silently divergent project.
 */
export async function projectIdForWorkspace(workspacePath: string): Promise<ProjectId> {
  const absolute = isAbsolute(workspacePath)
    ? workspacePath
    : resolve(process.cwd(), workspacePath);
  let canonical = absolute;
  try {
    canonical = await realpath(absolute);
  } catch {
    // The path may not exist yet; the caller reports that separately.
  }
  return `proj_${derivedIdBody(canonical)}` as ProjectId;
}
