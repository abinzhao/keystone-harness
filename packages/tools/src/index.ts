/**
 * The built-in tool registry.
 *
 * One list, so a tool cannot be advertised without an implementation or
 * implemented without being discoverable. `TOOL_IDS` is the ordered authority;
 * `builtinTools()` derives from it and every descriptor is validated through the
 * protocol schema at load time (PRD PL-01, NFR-COMP-05).
 */

import type { ToolDescriptor } from "@keystone/schemas";

import { fsTools } from "./fs.ts";
import { gitTools } from "./git.ts";
import { shellTools } from "./shell.ts";
import type { Tool } from "./types.ts";

// The tool contract is part of this package's public surface: a runtime needs to
// name `Tool`, `ToolContext` and `ToolResult` to execute one, and to distinguish
// a refusal from a crash.
export type { Tool, ToolContext, ToolResult } from "./types.ts";
export { PathEscapeError, ToolRefusedError } from "./types.ts";
export { sanitizeEnv } from "./guard.ts";

export const TOOL_IDS = [
  "fs.read_file",
  "fs.write_file",
  "fs.delete_file",
  "fs.list_dir",
  "fs.search_text",
  "cmd.run",
  "git.status",
  "git.diff",
  "git.show_head",
  "git.commit",
  "git.rollback",
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

const all: readonly Tool<unknown>[] = [...fsTools, ...shellTools, ...gitTools];

/** All built-in tools. The element type is erased on purpose: callers dispatch
 * by descriptor id and validate arguments with the tool's own input schema. */
export function builtinTools(): readonly Tool<never>[] {
  return all as unknown as readonly Tool<never>[];
}

export function getTool(id: string): Tool<never> | undefined {
  return all.find((tool) => tool.descriptor.id === id) as unknown as Tool<never> | undefined;
}

export function toolDescriptors(): readonly ToolDescriptor[] {
  return all.map((tool) => tool.descriptor);
}

/** One-line, human-readable summary for the CLI's `tools` command. */
export function describeTool(id: string): string {
  const tool = all.find((candidate) => candidate.descriptor.id === id);
  if (tool === undefined) return `unknown tool: ${id}`;
  const descriptor = tool.descriptor;
  return `${descriptor.id} — ${descriptor.description} (capabilities: ${descriptor.capabilities.join(", ")}; reversibility: ${descriptor.reversibility})`;
}
