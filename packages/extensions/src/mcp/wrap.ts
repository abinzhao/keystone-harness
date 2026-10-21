/**
 * Wrap an MCP server's advertised tools as Keystone `Tool`s (ADR-0009).
 *
 * Discovery is untrusted input: a server may announce any number of tools with
 * any description. Two gates keep that from becoming reach:
 *
 *  - the descriptor advertises only the *ceiling* capabilities the parent
 *    extension was declared to have (intersected with the environment);
 *  - every call re-checks the presented lease for `cmd.exec` scoped to the
 *    server command. No covering lease → refused. The adapter never mints a
 *    lease and never widens one.
 *
 * The wrapped tool is marked irreversible/non-replayable exactly like
 * `cmd.run`: an external process may write anywhere, so its effects cannot be
 * undone or safely re-run.
 */

import { validateLease } from "@keystone/kernel";
import {
  looseObject,
  contentHash,
  toolDescriptorSchema,
  type Capability,
  type ToolDescriptor,
  type Validator,
} from "@keystone/schemas";
import { ToolRefusedError, type Tool, type ToolContext, type ToolResult } from "@keystone/tools";

import { McpTimeoutError, type McpSession } from "./stdio-client.ts";
import { renderCallOutput, type McpTool } from "./protocol.ts";

const MCP_TOOL_INPUT_SCHEMA_ID = "keystone.mcp.tool.input";
const MCP_TOOL_OUTPUT_SCHEMA_ID = "keystone.tool.result";

export interface WrapMcpToolsInput {
  readonly session: McpSession;
  /** The discovered tools to wrap. */
  readonly tools: readonly McpTool[];
  /**
   * The capability ceiling: what the parent extension was allowed to declare.
   * Defaults-deny — an empty ceiling means the tools exist but refuse.
   */
  readonly capabilities: readonly Capability[];
  /** Runtime binds the actual reviewed extension identity and checks live bytes. */
  readonly subjectId?: string;
  readonly assertAvailable?: () => Promise<void>;
}

export function mcpCallParameters(session: McpSession, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { launchDigest: session.launchDigest, name, arguments: args };
}

/** Sanitize a server-supplied tool name into a stable, non-empty descriptor id. */
function toolId(serverName: string, toolName: string): string {
  const base = `${serverName}.${toolName}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base : "mcp.tool";
}

export function wrapMcpTools(input: WrapMcpToolsInput): readonly Tool<Record<string, unknown>>[] {
  // Discovery never grants capability. A stdio MCP tool can only be exposed when
  // the parent manifest explicitly declared cmd.exec; an empty or unrelated
  // ceiling therefore exposes no callable tools rather than advertising reach
  // that the extension does not possess (ADR-0009).
  if (!input.capabilities.includes("cmd.exec")) return [];
  const ceiling: readonly Capability[] = ["cmd.exec"];
  return input.tools.map((tool) => {
    const descriptor = toolDescriptorSchema.parse({
      id: toolId(input.session.serverInfo?.name ?? "mcp", tool.name),
      version: input.session.serverInfo?.version ?? "0.0.0",
      description: (tool.description ?? "MCP-provided tool (untrusted extension input)").slice(0, 2000),
      capabilities: ceiling,
      // An external process can do anything; be honest about that.
      sideEffects: ["command"],
      reversibility: "irreversible",
      idempotent: false,
      replayable: false,
      inputSchemaId: MCP_TOOL_INPUT_SCHEMA_ID,
      outputSchemaId: MCP_TOOL_OUTPUT_SCHEMA_ID,
      defaultTimeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
    }) as ToolDescriptor;

    const inputValidator: Validator<Record<string, unknown>> = looseObject();

    const wrapped: Tool<Record<string, unknown>> = {
      descriptor,
      input: inputValidator,
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const start = Date.now();
        await input.assertAvailable?.();

        // Defaults-deny: the call must present a lease that covers launching
        // this exact server. A model proposal with no lease never reaches the
        // child. The kernel issued the lease against envelope + contract.
        const check = validateLease(ctx.lease, {
          capability: "cmd.exec",
          resourceValues: [input.session.command],
          parametersHash: contentHash(mcpCallParameters(input.session, tool.name, args)),
        });
        if (!check.ok) {
          throw new ToolRefusedError(check.denial.detail, check.denial.code);
        }
        if (ctx.lease.taskId !== ctx.taskId || ctx.lease.branchId !== ctx.branchId ||
            ctx.lease.subject.kind !== "extension" ||
            (input.subjectId !== undefined && ctx.lease.subject.id !== input.subjectId) ||
            ctx.lease.constraints.parametersHash !== contentHash(mcpCallParameters(input.session, tool.name, args))) {
          throw new ToolRefusedError("MCP call requires an extension subject and exact task/branch/launch/parameters binding", "mcp_binding_mismatch");
        }
        ctx.signal?.throwIfAborted();

        const timeoutMs = Math.min(ctx.lease.constraints.timeoutMs ?? 60000,
          ctx.lease.budget.maxWallClockMs ?? 60000, Date.parse(ctx.lease.expiresAt) - Date.now());
        try {
          const result = await input.session.callTool(tool.name, args, {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          });
          const { text, isError } = renderCallOutput(result);
          await input.assertAvailable?.();
          const maxBytes = Math.min(descriptor.maxOutputBytes, ctx.lease.constraints.maxOutputBytes ?? descriptor.maxOutputBytes,
            ctx.lease.budget.maxBytes ?? descriptor.maxOutputBytes);
          const bytes = Buffer.from(text);
          return {
            status: isError ? "failed" : "succeeded",
            stdout: bytes.subarray(0, maxBytes).toString("utf8"),
            outputBytes: bytes.byteLength,
            changedPaths: [],
            durationMs: Date.now() - start,
            truncated: bytes.byteLength > maxBytes,
          };
        } catch (error) {
          if (ctx.signal?.aborted) return {
            status: "cancelled", changedPaths: [], durationMs: Date.now() - start, outputBytes: 0, truncated: false,
          };
          if (error instanceof McpTimeoutError) {
            return {
              status: "timeout",
              stderr: error.message,
              outputBytes: Buffer.byteLength(error.message, "utf8"),
              changedPaths: [],
              durationMs: Date.now() - start,
              truncated: false,
              errorCode: "mcp_timeout",
            };
          }
          const message = "MCP call failed; extension output remains untrusted";
          return {
            status: "failed",
            stderr: message,
            outputBytes: Buffer.byteLength(message, "utf8"),
            changedPaths: [],
            durationMs: Date.now() - start,
            truncated: false,
            errorCode: "mcp_call_failed",
          };
        }
      },
    };
    return wrapped;
  });
}
