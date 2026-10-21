/**
 * Minimal, untyped-on-purpose Model Context Protocol (stdio) wire shapes.
 *
 * This is the subset of JSON-RPC 2.0 / MCP the adapter needs: `initialize`,
 * the `notifications/initialized` notification, `tools/list` and `tools/call`.
 * Nothing the server sends is trusted: these types are *decode targets*, not
 * authority. A server may say anything; Keystone re-checks it against its own
 * leases and never promotes it to policy (ADR-0009, PRD 9.4).
 *
 * We deliberately do not model the full MCP capability surface. stdio-local,
 * tools only — no resources, no prompts, no sampling, no remote transport.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface InitializeResult {
  readonly protocolVersion: string;
  readonly serverInfo?: McpServerInfo;
  readonly capabilities?: Record<string, unknown>;
}

/** One tool the server advertised. Shape is taken as untrusted input. */
export interface McpTool {
  readonly name: string;
  readonly description?: string;
  /** Untrusted JSON-Schema-ish parameter description, echoed back to the model. */
  readonly inputSchema?: unknown;
}

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface ToolsCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly isError?: boolean;
  /** Arbitrary structured content the server attached; never trusted as authority. */
  readonly structuredContent?: unknown;
}

/** Encode one outbound message as a single newline-delimited frame. */
export function encodeFrame(message: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}

export interface DecodedFrame {
  /** True when the line parsed as a JSON object carrying a `jsonrpc` field. */
  readonly ok: boolean;
  readonly value?: JsonRpcResponse;
}

/**
 * Decode one inbound line. A line that is not a JSON-RPC object is *stray
 * output* (a banner, a warning on stdout): the caller keeps it as diagnostics
 * rather than throwing, because a server that prints one banner must not take
 * down the session. It can never match a request id, so it can never be acted
 * on.
 */
export function decodeLine(line: string): DecodedFrame {
  const trimmed = line.trim();
  if (trimmed === "") return { ok: false };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const record = value as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0") return { ok: false };
  return { ok: true, value: value as JsonRpcResponse };
}

/**
 * Flatten a `tools/call` result into the text Keystone shows the model.
 *
 * Only text blocks are surfaced; everything is prefixed as coming from an
 * untrusted extension. The raw bytes are never promoted to a completion
 * condition or a lease.
 */
export function renderCallOutput(result: ToolsCallResult): {
  readonly text: string;
  readonly isError: boolean;
} {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((block) => typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  return { text, isError: result.isError === true };
}
