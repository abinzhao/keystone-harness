/**
 * Isolated workspaces.
 *
 * Isolated mode exists for high-risk or hard-to-reproduce work: the run happens
 * in a separate Git worktree so the user's working copy is never touched, and a
 * failed attempt costs nothing to discard (PRD EX-05).
 *
 * The worktree is deliberately left in place when the run finishes. Removing it
 * would destroy the only copy of the change, and a task that silently deleted
 * its own output would be worse than one that leaves a directory behind — so the
 * path is reported and cleanup is the caller's decision.
 */

import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}

/**
 * Create a detached worktree at HEAD.
 *
 * `--detach` is intentional: giving the worktree a branch name would create a
 * ref in the user's repository as a side effect of *starting* a run.
 */
export async function createIsolatedWorkspace(rootPath: string, revision = "HEAD",
  preserveDirty = true): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "keystone-isolated-"));
  try {
    await exec("git", ["-C", rootPath, "worktree", "add", "--detach", directory, revision]);
    if (preserveDirty) {
      const patch = await exec("git", ["-C", rootPath, "diff", "--binary", "HEAD"],
        { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
      if (patch.stdout) await applyWorkspacePatch(directory, patch.stdout);
      const untracked = await exec("git", ["-C", rootPath, "ls-files", "-z", "--others", "--exclude-standard"],
        { maxBuffer: 1024 * 1024, timeout: 30000 });
      let bytes = 0;
      for (const path of untracked.stdout.split("\0").filter(Boolean)) {
        if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".git") ||
            /(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12))$/.test(path)) {
          throw new IsolationError("untracked path cannot be safely carried into an isolated workspace");
        }
        const source = join(rootPath, path);
        const info = await lstat(source);
        if (!info.isFile() || (bytes += info.size) > 8 * 1024 * 1024) {
          throw new IsolationError("untracked workspace snapshot exceeds supported regular-file/8MiB limits");
        }
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await copyFile(source, join(directory, path));
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new IsolationError(
      `could not create an isolated worktree from ${rootPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return directory;
}

export async function applyWorkspacePatch(directory: string, patch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", directory, "apply", "--binary", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (data: Buffer) => { if (error.length < 2000) error += data.toString(); });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new IsolationError(`snapshot patch could not be applied: ${error}`)));
    child.stdin.end(patch);
  });
}

/** Remove a worktree created by `createIsolatedWorkspace`. */
export async function removeIsolatedWorkspace(
  rootPath: string,
  directory: string,
): Promise<void> {
  try {
    await exec("git", ["-C", rootPath, "worktree", "remove", "--force", directory]);
  } catch {
    // A worktree whose directory was already deleted still has an entry in
    // .git/worktrees; prune is the documented way to clear it.
    await exec("git", ["-C", rootPath, "worktree", "prune"]).catch(() => undefined);
  }
}

/** Paths that changed inside an isolated worktree, relative to its root. */
export async function changedPathsIn(directory: string): Promise<readonly string[]> {
  const tracked = await exec("git", ["-C", directory, "diff", "--name-only", "HEAD"]).catch(
    () => ({ stdout: "" }),
  );
  const untracked = await exec("git", [
    "-C",
    directory,
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).catch(() => ({ stdout: "" }));

  const paths = new Set<string>();
  for (const line of `${tracked.stdout}\n${untracked.stdout}`.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") paths.add(trimmed);
  }
  return [...paths].sort();
}
