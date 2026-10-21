import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeEnv } from "@keystone/tools";

const exec = promisify(execFile);

/** Read-only Git plumbing: no inherited Git directory override or index refresh. */
export async function readGit(rootPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", rootPath, ...args,
  ], {
    env: { ...sanitizeEnv(process.env), GIT_OPTIONAL_LOCKS: "0" },
    timeout: 20_000,
    maxBuffer: 2_000_000,
  });
  return stdout;
}
