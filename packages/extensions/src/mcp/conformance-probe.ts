/**
 * Behavioral conformance probe for a stdio MCP extension (ADR-0009).
 *
 * A manifest that *declares* a stdio transport is only a promise. This probe
 * launches the declared command through the same supervised boundary the
 * runtime will use, completes the MCP handshake, asks for `tools/list`, and
 * stops the child. It proves the honest failure modes too: a server that never
 * handshakes, exits immediately, or emits nothing usable fails conformance
 * rather than being trusted at activation.
 *
 * The probe writes no state and grants nothing.
 */

import { resolve } from "node:path";

import type { ConformanceProbe } from "../conformance.ts";
import type { ExtensionManifest } from "@keystone/schemas";

import { McpSession } from "./stdio-client.ts";

export interface McpHandshakeProbeOptions {
  readonly manifest: ExtensionManifest;
  /** Absolute package root; the child's cwd and relative args resolve against it. */
  readonly packageRoot: string;
  readonly handshakeTimeoutMs?: number;
}

export function mcpHandshakeProbe(options: McpHandshakeProbeOptions): ConformanceProbe {
  const transport = options.manifest.transport;
  return {
    checkId: "mcp.handshake",
    blocking: true,
    detail: `launches "${options.manifest.transport?.command ?? ""}" and completes the MCP handshake`,
    async run() {
      if (transport === undefined || transport.type !== "stdio") {
        return { passed: false, detail: "no stdio transport declared" };
      }
      const root = resolve(options.packageRoot);
      const session = new McpSession({
        command: transport.command,
        args: transport.args,
        cwd: resolve(root, transport.cwd ?? "."),
        ...(transport.env === undefined ? {} : { env: transport.env }),
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
        callTimeoutMs: 5_000,
        maxRestarts: 0,
      });
      try {
        const { serverInfo } = await session.start();
        const tools = await session.listTools();
        return {
          passed: true,
          detail:
            `handshake ok with ${serverInfo.name}@${serverInfo.version}; ` +
            `discovered ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ") || "(none)"}`,
        };
      } catch (error) {
        return {
          passed: false,
          detail: `stdio server did not conform: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        await session.stop();
      }
    },
  };
}
