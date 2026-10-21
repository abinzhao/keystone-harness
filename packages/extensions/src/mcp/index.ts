/**
 * Governed local stdio MCP adapter (ADR-0009).
 *
 * A thin, untrusted-child boundary: launch a manifest-declared command via the
 * neutral spawn boundary, handshake, discover tools, wrap them as lease-checked
 * Keystone tools, supervise and stop. No remote transport; no auto-permissions;
 * all child content is untrusted input.
 */

export * from "./protocol.ts";
export * from "./stdio-client.ts";
export * from "./wrap.ts";
export * from "./conformance-probe.ts";
