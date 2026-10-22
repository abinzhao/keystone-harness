import { spawn } from "node:child_process";
import { TraeCliError } from "./errors.ts";

export interface ProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
}

export interface ProcessResult { stdout: Buffer; exitCode: number }

export async function runBounded(options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new TraeCliError("cancelled");
  return new Promise((resolve, reject) => {
    let failure: TraeCliError | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd, env: options.env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    };
    const fail = (error: TraeCliError) => {
      failure ??= error;
      killGroup();
    };
    const abort = () => fail(new TraeCliError("cancelled"));
    const timer = setTimeout(() => fail(new TraeCliError("timeout")), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const receive = (chunk: Buffer, stdout: boolean) => {
      if (failure) return;
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) return fail(new TraeCliError("output_limit"));
      if (!stdout) return;
      try {
        if (options.onStdout) options.onStdout(chunk);
        else chunks.push(chunk);
      } catch (error) {
        fail(error instanceof TraeCliError ? error : new TraeCliError("protocol"));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => receive(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => receive(chunk, false));
    child.on("error", () => fail(new TraeCliError("cli_failed")));
    child.stdin.on("error", () => { /* Exit/close determines failure; never expose EPIPE diagnostics. */ });
    child.stdin.end(options.stdin);
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Also remove children on an otherwise successful early parent exit.
      killGroup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new TraeCliError("cli_failed"));
      else resolve({ stdout: Buffer.concat(chunks), exitCode: code });
    });
  });
}
