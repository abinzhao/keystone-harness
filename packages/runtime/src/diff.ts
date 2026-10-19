/**
 * The change set a task produced, rendered as a unified diff.
 *
 * A proof says *which* paths changed; a reviewer wants to read the change
 * itself (PRD DP-02). The ledger is the authority for the path list — it is the
 * only record that exists on a machine that never held the working copy
 * (PRD EX-02, DP-01) — so the diff is recomputed from the repository at
 * `rootPath` and narrowed to exactly those paths.
 *
 * This is a read-only observation: `git diff` writes nothing, so it is not a
 * capability-leased side effect. It is deliberately *not* a verifier and does
 * not produce evidence: reading a diff is not a check, and treating it as one
 * would let a human edit masquerade as verification.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { projectProfileSchema, type ProjectId, type ProjectProfile } from "@keystone/schemas";
import { readLedger, type KeystonePaths } from "@keystone/kernel";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
const MAX_DIFF_BYTES = 2_000_000;

export interface TaskDiff {
  readonly taskId: string;
  readonly projectId: string | null;
  readonly rootPath: string | null;
  readonly changedPaths: readonly string[];
  /**
   * `task_paths` — the diff is limited to what the ledger says the task changed.
   * `worktree` — the ledger recorded no change, so the whole worktree diff is
   * shown instead. The distinction is surfaced rather than hidden: a reviewer
   * must not mistake an unrelated edit for the task's own work.
   */
  readonly scope: "task_paths" | "worktree";
  readonly available: boolean;
  readonly unifiedDiff: string;
  readonly truncated: boolean;
  readonly reason?: string;
}

/**
 * The paths a task actually changed, read from its own ledger.
 *
 * Shared with the proof endpoint so a remote reviewer and a local one are told
 * the same change set.
 */
export async function changedPathsForTask(
  paths: KeystonePaths,
  taskId: string,
): Promise<readonly string[]> {
  const ledger = await readLedger(paths.ledgerFile(taskId as never));
  return changedPathsFromEvents(ledger.events);
}

export function changedPathsFromEvents(events: readonly { type: string; payload: Record<string, unknown> }[]): readonly string[] {
  const changed = new Set<string>();
  for (const event of events) {
    if (event.type !== "action.executed") continue;
    const paths = event.payload["changedPaths"];
    if (!Array.isArray(paths)) continue;
    for (const entry of paths) {
      if (typeof entry === "string" && entry !== "") changed.add(entry);
    }
  }
  return [...changed].sort();
}

/** The project a task belongs to, taken from its `task.created` event. */
export function projectIdFromEvents(
  events: readonly { type: string; payload: Record<string, unknown> }[],
): string | null {
  const created = events.find((event) => event.type === "task.created");
  const projectId = created?.payload["projectId"];
  return typeof projectId === "string" ? projectId : null;
}

async function readProfile(
  paths: KeystonePaths,
  projectId: string,
): Promise<ProjectProfile | undefined> {
  const text = await readFile(paths.projectFile(projectId as ProjectId), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return projectProfileSchema.parse(JSON.parse(text)) as ProjectProfile;
  } catch {
    // A profile this runtime cannot parse is reported as "not available" rather
    // than crashing the endpoint; the reason travels with the response.
    return undefined;
  }
}

/** Recompute a task's diff from the repository it changed. */
export async function taskWorktreeDiff(
  paths: KeystonePaths,
  taskId: string,
): Promise<TaskDiff> {
  const ledger = await readLedger(paths.ledgerFile(taskId as never));
  const changedPaths = changedPathsFromEvents(ledger.events);
  const projectId = projectIdFromEvents(ledger.events);

  const base: Omit<TaskDiff, "available" | "reason" | "unifiedDiff" | "truncated" | "scope"> = {
    taskId,
    projectId,
    rootPath: null,
    changedPaths,
  };

  if (projectId === null) {
    return {
      ...base,
      rootPath: null,
      scope: "task_paths",
      available: false,
      unifiedDiff: "",
      truncated: false,
      reason: "the task has no recorded project, so its repository is unknown",
    };
  }

  const profile = await readProfile(paths, projectId);
  if (profile === undefined) {
    return {
      ...base,
      rootPath: null,
      scope: "task_paths",
      available: false,
      unifiedDiff: "",
      truncated: false,
      reason: "no readable project profile was found for this task",
    };
  }

  const scope: TaskDiff["scope"] = changedPaths.length > 0 ? "task_paths" : "worktree";
  const argv = ["-C", profile.rootPath, "diff", "--no-color", "--no-ext-diff"];
  if (scope === "task_paths") argv.push("--", ...changedPaths);

  try {
    const { stdout } = await exec("git", argv, {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_DIFF_BYTES,
    });
    return {
      ...base,
      rootPath: profile.rootPath,
      scope,
      available: true,
      unifiedDiff: stdout,
      truncated: Buffer.byteLength(stdout) >= MAX_DIFF_BYTES,
      ...(scope === "worktree"
        ? {
            reason:
              "the ledger recorded no changed path for this task, so the whole worktree diff is shown",
          }
        : {}),
    };
  } catch (error) {
    // A missing directory, a tree that is not a repository, or a missing git
    // binary all land here. The reviewer gets the reason, not an empty diff that
    // looks like "nothing changed".
    return {
      ...base,
      rootPath: profile.rootPath,
      scope,
      available: false,
      unifiedDiff: "",
      truncated: false,
      reason: `git diff could not be produced in ${profile.rootPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
