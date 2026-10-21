/**
 * Complete content observation for execution attribution. Unlike onboarding
 * previews this includes ignored/build files: a process must not hide a scope
 * violation by writing a path Git ignores. Symlinks are hashed as links.
 */
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { contentHash, sha256Bytes } from "@keystone/schemas";

const exec = promisify(execFile);

export interface WorkspaceObservation {
  readonly fingerprint: string;
  readonly files: ReadonlyMap<string, string>;
}

export async function observeWorkspace(rootPath: string): Promise<WorkspaceObservation> {
  const { stdout } = await exec("git", ["-C", rootPath, "ls-files", "-z", "--cached", "--others"], {
    maxBuffer: 16_000_000, timeout: 30_000,
  });
  const names = [...new Set(stdout.split("\0").filter(Boolean))].sort();
  if (names.length > 100_000) throw new Error("workspace observation exceeds 100000 paths; isolated execution is required");
  const indexResult = await exec("git", ["-C", rootPath, "ls-files", "-s", "-z"], { maxBuffer: 16_000_000, timeout: 30_000 });
  const index = new Map(indexResult.stdout.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    return [entry.slice(tab + 1), entry.slice(0, tab)] as const;
  }));
  const head = await exec("git", ["-C", rootPath, "rev-parse", "--verify", "HEAD"], { timeout: 30_000 }).then((result) => result.stdout.trim(), () => "");
  const branch = await exec("git", ["-C", rootPath, "symbolic-ref", "--quiet", "HEAD"], { timeout: 30_000 }).then((result) => result.stdout.trim(), () => "");
  const files = new Map<string, string>();
  for (const name of names) {
    if (name.split("/").includes(".git") || name.startsWith("../") || name.startsWith("/")) continue;
    const absolute = join(rootPath, name);
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) continue;
    if (info.isSymbolicLink()) files.set(name, contentHash({ link: await readlink(absolute) }));
    else if (info.isFile()) {
      if (info.size > 64 * 1024 * 1024) throw new Error(`workspace file exceeds observation limit: ${name}`);
      files.set(name, contentHash({ bytes: sha256Bytes(await readFile(absolute)), mode: info.mode & 0o777, index: index.get(name) ?? null }));
    }
  }
  return { fingerprint: contentHash({ files: [...files], head, branch }), files };
}

export function changedObservedPaths(before: WorkspaceObservation, after: WorkspaceObservation): string[] {
  return [...new Set([...before.files.keys(), ...after.files.keys()])]
    .filter((path) => before.files.get(path) !== after.files.get(path)).sort();
}
