import type { McpTool, ToolsCallResult } from "./protocol.ts";
import { McpProtocolError, McpTimeoutError } from "./stdio-client.ts";

/** Pinned Streamable HTTP subset: JSON responses only, no SSE or reconnect. */
export const MCP_HTTP_PROTOCOL_VERSION = "2025-03-26";

export interface McpHttpAuthorization {
  readonly url: string;
  readonly host: string;
  readonly method: "POST";
  readonly rpcMethod: string;
  readonly parameters: unknown;
}

export interface McpHttpOptions {
  readonly url: string;
  readonly egressHosts: readonly string[];
  /** Required on every RPC, including initialize/notifications. Never cached. */
  readonly authorize: (request: McpHttpAuthorization) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export class McpHttpSession {
  private readonly options: McpHttpOptions;
  private readonly endpoint: URL;
  private readonly stopSignal = new AbortController();
  private id = 1;
  private sessionId?: string;
  private ready = false;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  serverInfo?: { readonly name: string; readonly version: string };

  constructor(options: McpHttpOptions) {
    this.endpoint = new URL(options.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(this.endpoint.hostname);
    if ((this.endpoint.protocol !== "https:" && !(loopback && this.endpoint.protocol === "http:")) ||
        this.endpoint.username !== "" || this.endpoint.password !== "" ||
        this.endpoint.search !== "" || this.endpoint.hash !== "" ||
        !options.egressHosts.includes(this.endpoint.hostname)) {
      throw new McpProtocolError("HTTP MCP endpoint is outside the declared secure host boundary", "mcp_http_host");
    }
    const timeout = options.timeoutMs ?? 5000;
    const bytes = options.maxBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(bytes) || bytes < 1) {
      throw new McpProtocolError("invalid HTTP MCP bounds", "mcp_http_bounds");
    }
    this.timeoutMs = Math.min(timeout, 30000);
    this.maxBytes = Math.min(bytes, 1024 * 1024);
    this.options = { ...options, url: this.endpoint.href, egressHosts: [...options.egressHosts] };
  }

  async start(): Promise<void> {
    if (this.ready) throw new McpProtocolError("HTTP MCP session already ready", "mcp_http_state");
    const result = await this.rpc("initialize", {
      protocolVersion: MCP_HTTP_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "keystone", version: "1.0" },
    }) as Record<string, unknown>;
    const info = result?.serverInfo as Record<string, unknown> | undefined;
    if (result?.protocolVersion !== MCP_HTTP_PROTOCOL_VERSION || typeof info?.name !== "string" ||
        typeof info.version !== "string" || info.name.length > 256 || info.version.length > 128) {
      throw new McpProtocolError("HTTP MCP incompatible initialize response", "mcp_http_version");
    }
    await this.rpc("notifications/initialized", {}, undefined, true);
    this.serverInfo = { name: info.name, version: info.version };
    this.ready = true;
  }

  async listTools(): Promise<readonly McpTool[]> {
    this.assertReady();
    const result = await this.rpc("tools/list", {}) as { tools?: McpTool[] };
    if (!Array.isArray(result.tools) || result.tools.length > 512 ||
        result.tools.some((tool) => typeof tool?.name !== "string")) {
      throw new McpProtocolError("HTTP MCP tools response malformed", "mcp_tools_list");
    }
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<ToolsCallResult> {
    this.assertReady();
    return await this.rpc("tools/call", { name, arguments: args }, options.signal, false, options.timeoutMs) as ToolsCallResult;
  }

  private assertReady(): void {
    if (!this.ready || this.stopSignal.signal.aborted) throw new McpProtocolError("HTTP MCP session is not ready", "mcp_http_state");
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal, notification = false,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    const id = this.id++;
    const frame = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params });
    if (Buffer.byteLength(frame) > this.maxBytes) throw new McpProtocolError("HTTP MCP request exceeds byte limit", "mcp_http_bounds");
    const timeout = new AbortController();
    const combined = AbortSignal.any([timeout.signal, this.stopSignal.signal, ...(signal === undefined ? [] : [signal])]);
    const timer = setTimeout(() => timeout.abort(), Math.min(timeoutMs, this.timeoutMs));
    try {
      combined.throwIfAborted();
      await this.options.authorize({
        url: this.endpoint.href, host: this.endpoint.hostname, method: "POST",
        rpcMethod: method, parameters: params,
      });
      combined.throwIfAborted();
      const response = await fetch(this.endpoint, {
        method: "POST", redirect: "manual", signal: combined,
        headers: {
          "content-type": "application/json", accept: "application/json",
          "MCP-Protocol-Version": MCP_HTTP_PROTOCOL_VERSION,
          ...(this.sessionId === undefined ? {} : { "Mcp-Session-Id": this.sessionId }),
        }, body: frame,
      });
      if (!response.ok || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw new McpProtocolError("HTTP MCP request rejected or redirected", "mcp_http_status");
      }
      const session = response.headers.get("mcp-session-id");
      if (session !== null) {
        if (session.length > 256 || !/^[\x21-\x7e]+$/.test(session) ||
            (this.sessionId !== undefined && session !== this.sessionId)) {
          await response.body?.cancel();
          throw new McpProtocolError("HTTP MCP session identifier changed or malformed", "mcp_http_session");
        }
        this.sessionId = session;
      }
      if (notification) { await response.body?.cancel(); return undefined; }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || response.body === null) {
        await response.body?.cancel();
        throw new McpProtocolError("HTTP MCP requires bounded JSON responses; SSE is unsupported", "mcp_http_content");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maxBytes) throw new McpProtocolError("HTTP MCP response exceeds byte limit", "mcp_http_bounds");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let result: Record<string, unknown>;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new McpProtocolError("HTTP MCP malformed JSON", "mcp_http_content"); }
      if (result === null || typeof result !== "object" || result.jsonrpc !== "2.0" || result.id !== id ||
          result.error !== undefined || !Object.hasOwn(result, "result")) {
        throw new McpProtocolError("HTTP MCP rejected or mismatched RPC response", "mcp_http_rpc");
      }
      return result.result;
    } catch (error) {
      if (timeout.signal.aborted) throw new McpTimeoutError(Math.min(timeoutMs, this.timeoutMs));
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** No unleased DELETE or background reconnect on stop. */
  async stop(): Promise<void> {
    this.ready = false;
    this.stopSignal.abort();
  }
}
