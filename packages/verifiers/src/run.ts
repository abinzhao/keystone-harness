/**
 * Captured command execution.
 *
 * Every command a verifier runs goes through here so that the two properties
 * that make a result trustworthy are enforced in one place:
 *
 *  - No shell. Arguments are passed as an array to `spawn`, so a value that
 *    arrived from the repository or a model cannot turn into a pipeline,
 *    redirection or command substitution (PRD EX-02, 11.2).
 *  - A scrubbed environment. Only a small allowlist of variables reaches the
 *    child, and any name that looks like a credential is dropped first, so a
 *    token in the parent environment never leaks into a test run (PRD 11.3).
 *
 * When output exceeds the cap the *complete* bytes are stored as a
 * content-addressed artifact and only the head is returned inline, so a
 * reviewer can still fetch the exact output that was produced (PRD 12.4).
 */

import { spawn } from "node:child_process";

import { putArtifact, type KeystonePaths } from "@keystone/kernel";
import { resolveSpawnTarget } from "@keystone/spawn";

import type { VerifierOutcome } from "./types.ts";

const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  // POSIX and Windows spell the temp directory differently; both are plumbing.
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "NODE_OPTIONS",
  "CI",
  // Windows needs these for `cmd.exe` (used only to run `.cmd` launchers) and
  // for the OS to resolve the user profile at all.
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
] as const;

const ENV_ALLOWLIST_SET: ReadonlySet<string> = new Set(ENV_ALLOWLIST);

/** Names that end in a credential-like suffix are never forwarded. */
const SECRET_ENV_NAME = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;

export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    // Secrets are dropped before the allowlist check so the guarantee holds even
    // if the allowlist is extended later: a credential must never reach a child.
    if (SECRET_ENV_NAME.test(name)) continue;
    if (!ENV_ALLOWLIST_SET.has(name)) continue;
    if (typeof value !== "string") continue;
    sanitized[name] = value;
  }
  return sanitized;
}

/**
 * Split a stored command string into argv. Only whitespace is honoured; adding
 * quote or escape handling would quietly reintroduce the shell parsing
 * semantics that "never enable a shell" is meant to exclude. A command that
 * needs quoting must be expressed as an argv array by the caller instead.
 */
export function splitCommand(command: string): { command: string; args: string[] } {
  const parts = command
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const head = parts[0];
  if (head === undefined) return { command: "", args: [] };
  return { command: head, args: parts.slice(1) };
}

export interface RunCapturedOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface CapturedRun {
  readonly status: "passed" | "failed" | "timeout" | "blocked";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputBytes: number;
  readonly artifactId?: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly blockedReason?: string;
}

export async function runCaptured(
  paths: KeystonePaths,
  command: string,
  args: readonly string[],
  options: RunCapturedOptions,
): Promise<CapturedRun> {
  const started = Date.now();

  return await new Promise<CapturedRun>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // On Windows a `.cmd` launcher cannot be spawned directly, so the target may
    // be `cmd.exe` with pre-escaped arguments (see `resolveSpawnTarget`); on
    // POSIX this is the identity transform.
    const target = resolveSpawnTarget(command, args);
    const child = spawn(target.command, [...target.args], {
      cwd: options.cwd,
      env: sanitizeEnv(process.env),
      // Explicit, not "the default": a shell would make every argument a
      // potential injection point.
      shell: false,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited; nothing to stop.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1, options.timeoutMs));

    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    const finish = async (run: Omit<CapturedRun, "durationMs">): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...run, durationMs: Date.now() - started });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      outputBytes += chunk.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      outputBytes += chunk.byteLength;
    });

    child.on("error", (error) => {
      // A missing binary is "we could not run this", never "the check failed".
      const code = (error as NodeJS.ErrnoException).code;
      const blockedReason =
        code === "ENOENT"
          ? `command "${command}" was not found; it is not installed or not on PATH`
          : `command "${command}" could not be started: ${error.message}`;
      void finish({
        status: "blocked",
        stdout: "",
        stderr: "",
        outputBytes: 0,
        truncated: false,
        blockedReason,
      });
    });

    child.on("close", (code) => {
      void (async (): Promise<void> => {
        if (settled) return;
        const stdoutBuffer = Buffer.concat(stdoutChunks);
        const stderrBuffer = Buffer.concat(stderrChunks);
        const truncated = outputBytes > options.maxBytes;

        let artifactId: string | undefined;
        if (truncated) {
          // Full output, stdout before stderr, so nothing is lost when the
          // inline copy is capped.
          const stored = await putArtifact(paths, Buffer.concat([stdoutBuffer, stderrBuffer]));
          artifactId = stored.artifactId;
        }

        const status: CapturedRun["status"] = timedOut
          ? "timeout"
          : aborted
            ? "blocked"
            : code === 0
              ? "passed"
              : "failed";

        await finish({
          status,
          ...(code === null ? {} : { exitCode: code }),
          stdout: decodeCapped(stdoutBuffer, options.maxBytes),
          stderr: decodeCapped(stderrBuffer, options.maxBytes),
          outputBytes,
          truncated,
          ...(artifactId === undefined ? {} : { artifactId }),
          ...(aborted ? { blockedReason: "the run was aborted before it produced a verdict" } : {}),
        });
      })();
    });
  });
}

/**
 * Decode at most `maxBytes` from a buffer. A multi-byte character split by the
 * cut becomes U+FFFD rather than being dropped silently, and the full bytes are
 * available through the artifact when `truncated` is set.
 */
function decodeCapped(buffer: Buffer, maxBytes: number): string {
  const slice = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  return slice.toString("utf8");
}

export interface CommandOutcomeInput {
  readonly command: string;
  readonly summary: string;
  readonly incomplete?: readonly string[];
}

/**
 * Translate a captured run into a verifier outcome. A timeout is reported as a
 * failure *whose summary says it timed out* — "not finished" is not "passed",
 * and it must be legible in the proof package (PRD 9.1).
 */
export function outcomeFromCaptured(
  captured: CapturedRun,
  input: CommandOutcomeInput,
): VerifierOutcome {
  const status: VerifierOutcome["status"] =
    captured.status === "passed"
      ? "passed"
      : captured.status === "blocked"
        ? "blocked"
        : "failed";

  const incomplete = [
    ...(input.incomplete ?? []),
    ...(captured.blockedReason === undefined ? [] : [captured.blockedReason]),
  ];

  return {
    status,
    summary: captured.status === "timeout" ? `${input.summary} (timed out)` : input.summary,
    command: input.command,
    outputBytes: captured.outputBytes,
    truncated: captured.truncated,
    durationMs: captured.durationMs,
    ...(captured.exitCode === undefined ? {} : { exitCode: captured.exitCode }),
    ...(captured.stdout === "" ? {} : { stdout: captured.stdout }),
    ...(captured.stderr === "" ? {} : { stderr: captured.stderr }),
    ...(captured.artifactId === undefined ? {} : { artifactId: captured.artifactId }),
    ...(incomplete.length === 0 ? {} : { incomplete }),
  };
}
