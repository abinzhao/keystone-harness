/**
 * Shared guards and process plumbing for every built-in tool.
 *
 * Two invariants are enforced here rather than in each tool, so they cannot be
 * forgotten or drift (PRD 11.1, 11.3, 11.6):
 *
 *  - A path must stay inside the workspace even when an ancestor directory is a
 *    symlink pointing out of it, which is why containment is checked on the
 *    realpath of the nearest existing ancestor, not just on `path.resolve`.
 *  - The tool re-validates the capability lease itself. The caller *should* have
 *    checked already; a tool that trusts that is one bug away from an
 *    unauthenticated side effect.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  putJsonArtifact,
  validateLease,
  type KeystonePaths,
} from "@keystone/kernel";
import { resolveSpawnTarget } from "@keystone/spawn";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  objectOf,
  optional,
  str,
  type Capability,
  type CapabilityLease,
} from "@keystone/schemas";

import { PathEscapeError, ToolRefusedError } from "./types.ts";

/**
 * The result schema every built-in tool declares as `outputSchemaId`. It is
 * registered through `defineSchema` so the descriptor's schema id resolves in
 * the protocol registry instead of pointing at nothing (PRD PL-01, NFR-COMP-05).
 */
export const toolResultSchema = defineSchema(
  "keystone.tool.result",
  "1.0.0",
  objectOf({
    status: enumOf(["succeeded", "failed", "timeout", "cancelled"] as const),
    exitCode: optional(int()),
    stdout: optional(str()),
    stderr: optional(str()),
    outputBytes: int({ min: 0 }),
    changedPaths: arrayOf(str()),
    durationMs: int({ min: 0 }),
    artifactId: optional(str()),
    truncated: bool(),
    errorCode: optional(str()),
  }),
);

export const TOOL_RESULT_SCHEMA_ID = toolResultSchema.id;

/**
 * Resolve `target` against `rootPath` and require the result to stay inside it.
 * Returns the normalised absolute path (not the symlink-resolved one) so the
 * caller addresses the file the user named; the containment check itself uses
 * realpaths so a symlinked ancestor cannot launder an escape.
 *
 * Throws before any caller can write, which is what makes "refuse, never
 * write-then-report" enforceable (PRD EX-03).
 */
export function assertWithinRoot(rootPath: string, target: string): string {
  const root = resolve(rootPath);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);

  const realRoot = safeRealpathSync(root);
  const realTarget = realpathOfExistingAncestor(absolute);
  if (!isWithin(realRoot, realTarget)) {
    throw new PathEscapeError(
      `path "${target}" resolves to "${realTarget}", outside the workspace root "${root}"`,
    );
  }
  return absolute;
}

/**
 * Re-check the lease for this specific action. Both scope and envelope were
 * checked at issuance; this catches expiry, exhaustion, revocation and a
 * resource that the lease simply does not cover (PRD 11.3).
 */
export function assertLeaseCovers(
  lease: CapabilityLease,
  requirement: { capability: Capability; resourceValues: readonly string[] },
): void {
  const result = validateLease(lease, {
    capability: requirement.capability,
    resourceValues: requirement.resourceValues,
  });
  if (!result.ok) {
    throw new ToolRefusedError(result.denial.detail, result.denial.code);
  }
}

/** Repository-relative POSIX path, as the scope and artifact records expect. */
export function toRelative(rootPath: string, absolute: string): string {
  const rel = relative(resolve(rootPath), resolve(absolute));
  return rel === "" ? "." : rel.split(sep).join("/");
}

export function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "tool_error";
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function safeRealpathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Realpath of the deepest existing ancestor, re-joined with the parts that do
 * not exist yet. Resolving the whole path would fail for a new file; resolving
 * nothing would miss a symlinked parent, so we resolve exactly what exists.
 */
function realpathOfExistingAncestor(absolute: string): string {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Variables a child process needs to run at all. Deliberately small: an
 * allowlist means a new secret-shaped variable in the parent's environment is
 * excluded by default rather than leaked by default (PRD 11.3).
 */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TZ",
  "TERM",
  "PWD",
  "NODE_OPTIONS",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
]);

const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|PRIVATEKEY|ACCESSKEY|SESSION)/;

/**
 * Long-lived credentials must never reach a shell: the process gets only
 * short-lived capability-equivalent reach, not the user's secrets (PRD 11.3,
 * "Shell 不直接持有长期凭证").
 */
export function isSecretLikeEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SECRET_NAME_PATTERN.test(upper)) return true;
  if (/(^|_)KEY($|_)/.test(upper)) return true;
  if (upper.startsWith("AWS_")) return true;
  if (upper.startsWith("GITHUB_") || upper.startsWith("GH_")) return true;
  return false;
}

/**
 * Copy an environment for a child process: only allowlisted plumbing variables,
 * never anything credential-shaped, plus explicitly provided `extra` values
 * (which are still filtered, so a caller cannot smuggle a token through).
 */
export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!ENV_ALLOWLIST.has(key)) continue;
    if (isSecretLikeEnvKey(key)) continue;
    out[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (isSecretLikeEnvKey(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

export interface SpawnCaptureOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Store for the full output when it is truncated (PRD 12.4). */
  readonly paths: KeystonePaths;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface CapturedOutput {
  readonly status: "succeeded" | "failed" | "timeout" | "cancelled";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
  readonly artifactId?: string;
  readonly errorCode?: string;
}

/**
 * Run one process without a shell. Arguments are passed as an array so a value
 * like `; rm -rf /` is a literal argument, not a second command (PRD EX-02: a
 * command is an independent action, not implicit shell state).
 *
 * On timeout the whole process group is killed — a command that spawned
 * children must not leave them running after the lease is gone (PRD 11.5).
 */
export async function spawnCapture(
  command: string,
  args: readonly string[],
  options: SpawnCaptureOptions,
): Promise<CapturedOutput> {
  const env = sanitizeEnv(process.env, options.env);
  // On Windows a `.cmd` launcher cannot be spawned directly, so the target may
  // be `cmd.exe` with pre-escaped arguments (see `resolveSpawnTarget`); on
  // POSIX this is the identity transform and the arguments stay a literal array.
  const target = resolveSpawnTarget(command, args);
  const child = spawn(target.command, [...target.args], {
    cwd: options.cwd,
    env,
    shell: false,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
    // A new process group lets us kill the command and everything it spawned.
    // (On Windows the negative-pid group kill is unsupported and the fallback
    // below terminates only the direct child, which is a known limitation.)
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    outChunks.push(chunk);
    outBytes += chunk.length;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errChunks.push(chunk);
    errBytes += chunk.length;
  });

  let timedOut = false;
  let cancelled = false;
  let exitCode: number | undefined;
  let errorCode: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const killTree = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; nothing to kill.
      }
    }
  };

  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const onAbort = (): void => {
      cancelled = true;
      killTree();
    };
    const onTimeout = (): void => {
      timedOut = true;
      killTree();
    };

    child.on("error", (error) => {
      errorCode = (error as NodeJS.ErrnoException).code ?? error.name;
      finish();
    });
    child.on("close", (code) => {
      exitCode = code ?? undefined;
      finish();
    });

    timer = setTimeout(onTimeout, options.timeoutMs);
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  const fullStdout = Buffer.concat(outChunks);
  const fullStderr = Buffer.concat(errChunks);
  const outputBytes = outBytes + errBytes;
  const truncated = outputBytes > options.maxBytes;

  let stdout = fullStdout.toString("utf8");
  let stderr = fullStderr.toString("utf8");
  let artifactId: string | undefined;
  if (truncated) {
    // Keep the complete bytes addressable; the caller's inline copy is a head.
    const stored = await putJsonArtifact(options.paths, {
      stdout: fullStdout.toString("utf8"),
      stderr: fullStderr.toString("utf8"),
    });
    artifactId = stored.artifactId;
    const stdoutBudget = Math.min(fullStdout.length, options.maxBytes);
    stdout = fullStdout.subarray(0, stdoutBudget).toString("utf8");
    stderr = fullStderr.subarray(0, Math.max(0, options.maxBytes - stdoutBudget)).toString("utf8");
  }

  const status: CapturedOutput["status"] = timedOut
    ? "timeout"
    : cancelled
      ? "cancelled"
      : errorCode !== undefined
        ? "failed"
        : exitCode === 0
          ? "succeeded"
          : "failed";

  return {
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    stdout,
    stderr,
    outputBytes,
    truncated,
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}
