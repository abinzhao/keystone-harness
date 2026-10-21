/**
 * A supervised stdio MCP client session (ADR-0009).
 *
 * The adapter launches the manifest-declared command *only* through the neutral
 * spawn boundary (`resolveSpawnTarget` + `sanitizeEnv`), speaks the fixed MCP
 * handshake over newline-delimited stdio, and exposes `tools/list` /
 * `tools/call`. It owns the child's lifecycle: handshake and per-call timeouts,
 * no automatic tool-call retry, and a process-group kill on stop.
 *
 * Governance, not convenience, shapes this file:
 *  - the child gets a sanitized, allowlisted environment — never the parent's
 *    long-lived credentials;
 *  - every frame the child emits is treated as untrusted; oversized frames and
 *    malformed lines are refused/diagnosed, never parsed as authority;
 *  - the client mints no lease and writes no state — it only produces
 *    observations and names the isolation trigger when something goes wrong.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { contentHash } from "@keystone/schemas";

import { sanitizeEnv } from "@keystone/tools";
import { resolveSpawnTarget } from "@keystone/spawn";

import {
  decodeLine,
  encodeFrame,
  type InitializeResult,
  type JsonRpcResponse,
  type McpTool,
  type ToolsCallResult,
} from "./protocol.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpSessionOptions {
  /** The manifest-declared command (bare name or absolute path). */
  readonly command: string;
  readonly args?: readonly string[];
  /** Resolved working directory for the child. */
  readonly cwd: string;
  /** Extra env from the manifest, filtered for secret material. */
  readonly env?: Record<string, string>;
  readonly handshakeTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Crash restarts before the session gives up and names the trigger. */
  readonly maxRestarts?: number;
  /** Largest single inbound frame accepted; beyond this the child is hostile. */
  readonly maxFrameBytes?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export type McpSessionState =
  | "new"
  | "starting"
  | "ready"
  | "restarting"
  | "stopped"
  | "failed";

export class McpProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
  }
}

export class McpHandshakeError extends McpProtocolError {
  constructor(message: string) {
    super(message, "mcp_handshake_failed");
  }
}

export class McpTimeoutError extends McpProtocolError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`MCP server did not respond within ${timeoutMs}ms`, "mcp_timeout");
    this.name = "McpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

interface Pending {
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FRAME_BYTES = 1_000_000;

export class McpSession {
  readonly command: string;
  private readonly options: Required<
    Pick<
      McpSessionOptions,
      | "cwd"
      | "handshakeTimeoutMs"
      | "callTimeoutMs"
      | "maxRestarts"
      | "maxFrameBytes"
      | "clientName"
      | "clientVersion"
    >
  > & { readonly args: readonly string[]; readonly env: Record<string, string> };

  state: McpSessionState = "new";
  serverInfo: { name: string; version: string } | undefined;

  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private closed = true;
  private closedListeners: Array<(code: number | null) => void> = [];

  constructor(options: McpSessionOptions) {
    this.command = options.command;
    this.options = {
      cwd: options.cwd,
      args: options.args ?? [],
      env: options.env ?? {},
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      maxRestarts: options.maxRestarts ?? 1,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      clientName: options.clientName ?? "keystone",
      clientVersion: options.clientVersion ?? "1.0",
    };
  }

  /** Binds command arguments, cwd and declared environment without disclosing it. */
  get launchDigest(): string {
    return contentHash({ command: this.command, args: this.options.args, cwd: resolve(this.options.cwd), env: this.options.env });
  }

  /** Spawn the child and complete the MCP handshake. */
  async start(): Promise<{ readonly serverInfo: { name: string; version: string } }> {
    if (this.state === "ready" || this.state === "starting") throw new McpHandshakeError("session already started");
    this.state = "starting";
    this.spawnChild();
    try {
      const result = await this.handshake();
      this.serverInfo = result.serverInfo ?? { name: this.command, version: "0.0.0" };
      this.state = "ready";
      return { serverInfo: this.serverInfo };
    } catch (error) {
      await this.killChild();
      this.state = "failed";
      // Any handshake failure — spawn error, protocol error, or a timeout — is
      // surfaced as a handshake failure, since a server that cannot complete the
      // opening exchange cannot be trusted regardless of the cause.
      const message = error instanceof Error ? error.message : String(error);
      throw new McpHandshakeError(`handshake failed: ${message}`);
    }
  }

  private spawnChild(): void {
    const target = resolveSpawnTarget(this.command, this.options.args);
    const env = sanitizeEnv({}, this.options.env);
    for (const key of Object.keys(env)) {
      if (/^(?:NODE_|LD_|DYLD_|BASH_ENV$|ENV$)/i.test(key)) delete env[key];
    }
    env.PATH = process.env.PATH ?? "";
    if (process.platform === "win32" && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
    this.stdoutBuffer = "";
    this.closed = false;
    this.child = spawn(target.command, [...target.args], {
      cwd: resolve(this.options.cwd),
      env,
      shell: false,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    // Drain, never retain or log server diagnostics that may contain secrets.
    let stderrBytes = 0;
    this.child.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > this.options.maxFrameBytes) {
        this.failPending(new McpProtocolError("MCP diagnostics exceeded output limit", "mcp_oversized_frame"));
        void this.stop();
      }
    });
    this.child.stdin.on("error", () => {
      this.failPending(new McpProtocolError("MCP input closed", "mcp_exited"));
    });

    this.child.on("error", () => {
      // A spawn failure (ENOENT, permission) surfaces as a closed session.
      this.failPending(new McpHandshakeError(`could not launch "${this.command}"`));
      this.state = "failed";
    });

    this.child.on("close", (code) => {
      this.closed = true;
      for (const listener of this.closedListeners) listener(code);
      this.closedListeners = [];
      // Reject anything still in flight: the server went away.
      this.failPending(new McpProtocolError("MCP server process exited", "mcp_exited"));
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.options.maxFrameBytes) {
        this.failPending(new McpProtocolError("MCP server emitted an oversized frame", "mcp_oversized_frame"));
        this.stdoutBuffer = "";
        void this.stop();
        return;
      }
      this.dispatchLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > this.options.maxFrameBytes) {
      // A server that streams an unbounded line with no newline is hostile or
      // broken: refuse the session rather than grow memory.
      this.stdoutBuffer = "";
      this.failPending(
        new McpProtocolError(
          `MCP server emitted an oversized frame (> ${this.options.maxFrameBytes} bytes)`,
          "mcp_oversized_frame",
        ),
      );
      void this.stop();
    }
  }

  private dispatchLine(line: string): void {
    const decoded = decodeLine(line);
    if (!decoded.ok || decoded.value === undefined) return; // stray output, ignored
    const message = decoded.value;
    if (typeof message.id !== "number") return; // a notification, not a response
    const pending = this.pending.get(message.id);
    if (pending === undefined) return; // unsolicited; cannot be acted on
    clearTimeout(pending.timer);
    pending.cleanup();
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  private async handshake(): Promise<InitializeResult> {
    const response = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
      },
      this.options.handshakeTimeoutMs,
    );
    if (response.error !== undefined) {
      throw new McpHandshakeError(`initialize rejected: ${response.error.message}`);
    }
    const result = (response.result ?? {}) as InitializeResult;
    if (result.protocolVersion !== MCP_PROTOCOL_VERSION ||
        typeof result.serverInfo?.name !== "string" || typeof result.serverInfo.version !== "string" ||
        result.serverInfo.name.length > 256 || result.serverInfo.version.length > 128) {
      throw new McpHandshakeError("initialize response is malformed or uses an incompatible protocol version");
    }
    // Notification, fire-and-forget; no response expected.
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  /** List the tools the server advertises. Taken as untrusted input. */
  async listTools(): Promise<readonly McpTool[]> {
    const response = await this.request("tools/list", {});
    if (response.error !== undefined) {
      throw new McpProtocolError(`tools/list failed: ${response.error.message}`, "mcp_tools_list");
    }
    const result = (response.result ?? {}) as { tools?: readonly McpTool[] };
    if (!Array.isArray(result.tools) || result.tools.length > 512) {
      throw new McpProtocolError("tools/list result is malformed or exceeds tool limit", "mcp_tools_list");
    }
    return (result.tools ?? []).filter(
      (tool) => typeof tool === "object" && tool !== null && typeof tool.name === "string",
    );
  }

  /** Never replay an irreversible call, including on timeout or server errors. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ToolsCallResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? this.options.callTimeoutMs, this.options.callTimeoutMs);
    try {
      return await this.callOnce(name, args, timeoutMs, options.signal);
    } catch (error) {
      if (error instanceof McpTimeoutError ||
          (error instanceof McpProtocolError && error.code === "mcp_aborted")) await this.stop();
      throw error;
    }
  }

  private async callOnce(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ToolsCallResult> {
    if (this.state !== "ready") throw new McpProtocolError("MCP session is not ready", "mcp_stopped");
    signal?.throwIfAborted();
    const response = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
      signal,
    );
    if (response.error !== undefined) {
      throw new McpProtocolError("MCP tools/call was rejected", "mcp_tools_call");
    }
    return (response.result ?? {}) as ToolsCallResult;
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const limit = timeoutMs ?? this.options.callTimeoutMs;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        // Cancellation is advisory on the wire; stopping the child is the bound.
        this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } });
        reject(new McpProtocolError("call aborted", "mcp_aborted"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new McpTimeoutError(limit));
      }, limit);
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new McpProtocolError("call aborted", "mcp_aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, { resolve, reject, timer, cleanup });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(message: { readonly jsonrpc: "2.0"; readonly method: string; readonly params?: unknown } | { readonly jsonrpc: "2.0"; readonly id: number; readonly method: string; readonly params?: unknown }): void {
    const frame = encodeFrame(message);
    if (Buffer.byteLength(frame) > this.options.maxFrameBytes) {
      this.failPending(new McpProtocolError("outbound MCP frame exceeds limit", "mcp_oversized_frame"));
      return;
    }
    if (this.child === undefined || this.child.stdin.writableEnded) {
      this.failPending(new McpProtocolError("MCP session is closed", "mcp_stopped"));
      return;
    }
    this.child.stdin.write(frame);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.pid === undefined || this.closed) return;
    await new Promise<void>((resolve) => {
      // Bound the wait: the close event, or a short fallback — never a hang.
      const timer = setTimeout(resolve, 300);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    });
  }

  /** Stop the session and kill the whole process group. */
  async stop(): Promise<void> {
    this.state = "stopped";
    await this.killChild();
    this.failPending(new McpProtocolError("session stopped", "mcp_stopped"));
    this.state = "stopped";
  }
}
