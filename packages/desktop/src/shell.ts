/**
 * The desktop shell orchestrator.
 *
 * It owns three things at once (ADR-0008, Decision A):
 *
 *  1. A supervised `keystone serve --json` child — the only Run Protocol runtime.
 *  2. A same-origin loopback proxy that serves the UI and injects the child's
 *     bearer token server-side, so the webview never holds a token and no CORS
 *     policy is opened.
 *  3. The shell-private `/desktop/*` onboarding routes (config, connection test,
 *     save, native folder picker), delegating to {@link DesktopConfigBridge}.
 *
 * Local threat boundary: these shell-private routes are unauthenticated on the
 * shell origin. They are protected by loopback binding, an ephemeral port,
 * single-instance ownership, and the browser same-origin policy — not by a
 * remotely meaningful identity. A hostile *local* process can still probe
 * loopback ports, so every `/desktop/*` route additionally requires an
 * unguessable per-start nonce (ADR-0008, Decision H): the native window loads
 * `${origin}/?ks-shell=<nonce>`, the shell mints an HttpOnly session cookie
 * from that first navigation, and rejects any `/desktop/*` request that does
 * not present the nonce (cookie, or the `x-keystone-shell-nonce` header for
 * tooling). An attacker who can only probe the port never sees the nonce.
 *
 * The shell holds no task state and never opens a KernelSession. It is a thin
 * launcher: if the child crashes, the shell reports it and exits; if the shell
 * exits, it kills the child so no runtime is left holding a workspace lock.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request, type OutgoingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { KeystonePaths } from "@keystone/kernel";

import { DesktopConfigBridge } from "./config-bridge.ts";
import { chooseFolder } from "./folder-picker.ts";
import { acquireInstanceLock, type InstanceLock } from "./single-instance.ts";
import { launchNativeWindow, nativeWindowSupported } from "./window.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Dev-time location of the CLI entry; overridden by the packaged bin layout. */
const DEFAULT_CLI_BIN = join(HERE, "..", "..", "cli", "src", "bin.ts");

export interface RuntimeTarget {
  readonly port: number;
  readonly token: string;
}

interface StartupRecord {
  readonly port: number;
  readonly token: string;
  readonly protocolVersion?: string;
}

export interface DesktopShellOptions {
  readonly paths: KeystonePaths;
  /** Override the CLI entry (tests / packaged layouts). */
  readonly cliBin?: string;
  readonly nodePath?: string;
  /** Extra args appended to `serve`, e.g. a scripted fixture for offline demos. */
  readonly runtimeArgs?: readonly string[];
  /** Called with the UI URL instead of opening a window/browser (tests). */
  readonly onBrowserOpen?: (url: string) => void;
  /** Called once the child runtime is reachable and the proxy can forward. */
  readonly onRuntimeReady?: (target: RuntimeTarget) => void;
  /**
   * Force the native WKWebView window on (`true`) or off (`false`); omitted
   * means auto: native on macOS when the helper binary exists, system browser
   * otherwise. `onBrowserOpen` always wins, so tests never open a GUI.
   */
  readonly nativeWindow?: boolean;
}

export class DesktopShell {
  private readonly paths: KeystonePaths;
  private readonly cliBin: string;
  private readonly nodePath: string;
  private readonly runtimeArgs: readonly string[];
  private readonly onBrowserOpen?: (url: string) => void;
  private readonly onRuntimeReady?: (target: RuntimeTarget) => void;
  private readonly nativeWindowOption: boolean | undefined;
  private readonly bridge: DesktopConfigBridge;

  private server: Server | null = null;
  private lock: InstanceLock | null = null;
  private child: ChildProcess | null = null;
  private windowProc: ChildProcess | null = null;
  private target: RuntimeTarget | null = null;
  private closing = false;
  /** Per-start unguessable shell nonce; gates every `/desktop/*` route. */
  private readonly nonce: string = randomBytes(24).toString("hex");
  /** Guard so a child exit and a manual close do not fight. */
  private restarting = false;

  constructor(options: DesktopShellOptions) {
    this.paths = options.paths;
    this.cliBin = options.cliBin ?? DEFAULT_CLI_BIN;
    this.nodePath = options.nodePath ?? process.execPath;
    this.runtimeArgs = options.runtimeArgs ?? [];
    this.onBrowserOpen = options.onBrowserOpen;
    this.onRuntimeReady = options.onRuntimeReady;
    this.nativeWindowOption = options.nativeWindow;
    this.bridge = new DesktopConfigBridge({ paths: options.paths });
  }

  /** The shell origin the window should load. Only valid after {@link start}. */
  origin(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (address === null || address === undefined) throw new Error("the shell is not listening yet");
    return `http://127.0.0.1:${address.port}/`;
  }

  /** The nonce this shell requires on `/desktop/*` (tests, diagnostics). */
  shellNonce(): string {
    return this.nonce;
  }

  private windowEnabled(): boolean {
    if (this.nativeWindowOption !== undefined) return this.nativeWindowOption;
    return nativeWindowSupported();
  }

  async start(): Promise<void> {
    this.lock = await acquireInstanceLock(this.paths.home);
    await this.spawnRuntime();

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));

    const url = this.origin();
    // The first navigation carries the nonce; the shell mints the cookie from
    // it (forwardToRuntime), and every later /desktop/* call proves it.
    const entryUrl = `${url}?ks-shell=${this.nonce}`;
    if (this.onBrowserOpen) {
      this.onBrowserOpen(entryUrl);
    } else if (this.windowEnabled()) {
      const windowLaunch = launchNativeWindow(entryUrl, { title: "Keystone" });
      this.windowProc = windowLaunch.process;
      this.windowProc.on("exit", (code) => {
        this.windowProc = null;
        // The native window closing *is* the user quitting the app.
        if (!this.closing) void this.close(`window closed (code ${code ?? "?"})`);
      });
    } else {
      openBrowser(entryUrl);
    }

    process.once("SIGINT", () => void this.close("SIGINT"));
    process.once("SIGTERM", () => void this.close("SIGTERM"));
  }

  /**
   * Restart the supervised runtime, e.g. after the wizard saved a new model.
   * The webview keeps talking to the same shell origin; only the injected token
   * and upstream port change.
   */
  async restartRuntime(): Promise<RuntimeTarget> {
    this.restarting = true;
    await this.killChild();
    try {
      return await this.spawnRuntime();
    } finally {
      this.restarting = false;
    }
  }

  private async spawnRuntime(): Promise<RuntimeTarget> {
    const child = spawn(
      this.nodePath,
      [this.cliBin, "serve", "--json", "--port", "0", ...this.runtimeArgs],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;

    const startup = await new Promise<StartupRecord>((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString();
        try {
          const parsed = JSON.parse(buffer) as StartupRecord;
          if (typeof parsed.port === "number" && typeof parsed.token === "string") {
            resolve(parsed);
          }
        } catch {
          // Pretty-printed JSON arrives in pieces; keep accumulating until it parses.
        }
      };
      child.stdout.on("data", onData);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
      });
      child.on("error", (error) => reject(error));
      child.on("exit", (code) => {
        reject(
          new Error(
            `the runtime exited before it was ready (code ${code ?? "?"}). ${stderr.trim()}`.trim(),
          ),
        );
      });
    });

    this.target = { port: startup.port, token: startup.token };
    // If the child dies on its own, bring the shell down with it: a desktop shell
    // whose runtime is gone has no useful screen to show.
    child.on("exit", (code) => {
      if (this.closing || this.restarting) return;
      void this.close(`runtime exited (code ${code ?? "?"})`);
    });
    this.onRuntimeReady?.(this.target);
    return this.target;
  }

  private killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // Give it a moment, then force-kill a runtime that ignores SIGTERM.
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    });
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    try {
      // A cross-origin browser cannot read our responses: we send no CORS headers,
      // so an application/json preflight fails and the request never leaves the
      // page. Refuse OPTIONS loudly rather than negotiate anything.
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/desktop/")) {
        await this.handleDesktop(url.pathname, req, res);
        return;
      }
      this.forwardToRuntime(req, res);
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Shell-private onboarding routes. Not part of the Run Protocol (ADR-0008 B). */
  private async handleDesktop(
    pathname: string,
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    // These routes touch real config and the 0600 credential store. A local
    // process that can merely reach loopback must not be able to drive them;
    // the nonce only ever exists in the native window's cookie / entry URL.
    if (!this.passesNonce(req)) {
      json(res, 403, { error: "shell nonce required" });
      return;
    }
    if (pathname === "/desktop/bootstrap" && req.method === "GET") {
      json(res, 200, await this.bridge.bootstrap());
      return;
    }
    if (pathname === "/desktop/config" && req.method === "GET") {
      json(res, 200, await this.bridge.listModels());
      return;
    }
    if (pathname === "/desktop/pick-folder" && req.method === "POST") {
      // The result carries its own `supported` flag (false where the OS has no
      // bridge), so callers degrade to "type a path" rather than failing.
      json(res, 200, await chooseFolder());
      return;
    }
    if (pathname === "/desktop/config/test" && req.method === "POST") {
      const body = (await readJson(req)) as { baseUrl?: string; apiKey?: string };
      json(res, 200, await this.bridge.testConnection({ baseUrl: body.baseUrl ?? "", apiKey: body.apiKey ?? "" }));
      return;
    }
    if (pathname === "/desktop/config/save" && req.method === "POST") {
      const body = (await readJson(req)) as {
        baseUrl?: string;
        apiKey?: string;
        modelName?: string;
        provider?: string;
      };
      const result = await this.bridge.saveModel({
        baseUrl: body.baseUrl ?? "",
        apiKey: body.apiKey ?? "",
        modelName: body.modelName ?? "",
        ...(body.provider === undefined ? {} : { provider: body.provider }),
      });
      // The running child read config.json at start; restart it so the new model
      // is actually registered, then report readiness.
      await this.restartRuntime();
      json(res, 200, result);
      return;
    }
    json(res, 404, { error: "unknown desktop route" });
  }

  /** Reverse-proxy to the supervised runtime, injecting the bearer token. */
  private forwardToRuntime(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): void {
    if (this.target === null) {
      json(res, 503, { error: "the runtime is starting; retry shortly" });
      return;
    }
    const upstream = request(
      {
        host: "127.0.0.1",
        port: this.target.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          // The webview holds no token: the shell authenticates upstream itself.
          authorization: `Bearer ${this.target.token}`,
          host: `127.0.0.1:${this.target.port}`,
        },
      },
      (upstreamRes) => {
        const outgoing: OutgoingHttpHeaders = { ...upstreamRes.headers };
        // The window's first navigation carries ?ks-shell=<nonce>. Mint the
        // HttpOnly session cookie from it; later /desktop/* calls then carry
        // the cookie automatically and prove the nonce.
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.searchParams.get("ks-shell") === this.nonce) {
          const cookie = `ks_shell_nonce=${this.nonce}; Path=/; HttpOnly; SameSite=Strict`;
          const existing = outgoing["set-cookie"];
          outgoing["set-cookie"] =
            existing === undefined
              ? cookie
              : Array.isArray(existing)
                ? [...existing, cookie]
                : [existing, cookie];
        }
        res.writeHead(upstreamRes.statusCode ?? 502, outgoing);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) json(res, 502, { error: "the runtime is unreachable" });
      else res.end();
    });
    req.pipe(upstream);
  }

  /**
   * Proof that the request comes from the shell's own window: the cookie the
   * first navigation minted, or (for tooling/tests) the matching header.
   * A probe that only knows the ephemeral loopback port has neither.
   */
  private passesNonce(req: import("node:http").IncomingMessage): boolean {
    const headerProbe = req.headers["x-keystone-shell-nonce"];
    if (typeof headerProbe === "string" && headerProbe === this.nonce) return true;
    const cookies = req.headers.cookie;
    if (typeof cookies !== "string") return false;
    for (const pair of cookies.split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name === "ks_shell_nonce" && rest.join("=") === this.nonce) return true;
    }
    return false;
  }

  async close(_reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.killChild();
    // The window is a supervised view: if the shell dies first (SIGINT, runtime
    // crash), kill the window so no native chrome is left pointing at a dead
    // proxy. If the window died first, this is a no-op.
    const windowProc = this.windowProc;
    this.windowProc = null;
    if (windowProc !== null && windowProc.exitCode === null) {
      windowProc.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => {
      if (this.server === null) return resolve();
      // A webview (or a test fetch) leaves keep-alive sockets open; close() alone
      // would wait for them to time out. Drop idle connections so shutdown is
      // prompt and no runtime keeps a workspace lock.
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
    await this.lock?.release();
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}
