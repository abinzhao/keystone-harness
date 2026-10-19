/**
 * The boundary every built-in tool is written against.
 *
 * A tool never executes on its own authority: it receives the exact lease the
 * caller was granted, and the tool re-checks it before touching anything
 * (defence in depth, PRD EX-01, 11.1). The result is an *observation* for the
 * run graph — it carries status, output, workspace changes and size, so the
 * kernel can bind evidence to it (PRD EX-02, 12.4).
 */

import type { KeystonePaths } from "@keystone/kernel";
import type { CapabilityLease, ToolDescriptor } from "@keystone/schemas";
import type { Validator } from "@keystone/schemas";

export interface ToolContext {
  /** Absolute path to the git worktree root. Every path is resolved against it. */
  readonly rootPath: string;
  readonly taskId: string;
  readonly branchId: string;
  /** Store layout, so oversized output can be persisted content-addressed (PRD 12.4). */
  readonly paths: KeystonePaths;
  /** The grant this call runs under. The tool re-validates it, always. */
  readonly lease: CapabilityLease;
  readonly workingDirectory?: string;
  readonly signal?: AbortSignal;
}

export interface ToolResult {
  readonly status: "succeeded" | "failed" | "timeout" | "cancelled";
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputBytes: number;
  readonly changedPaths: readonly string[];
  readonly durationMs: number;
  readonly artifactId?: string;
  readonly truncated: boolean;
  readonly errorCode?: string;
}

export interface Tool<TArgs = unknown> {
  readonly descriptor: ToolDescriptor;
  readonly input: Validator<TArgs>;
  run(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A tool refused to act. `code` is the kernel denial code (or a tool-local one),
 * so the caller can surface an actionable reason instead of a generic failure
 * (PRD HI-01).
 */
export class ToolRefusedError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ToolRefusedError";
    this.code = code;
  }
}

/**
 * A path resolved outside the workspace root, directly or through a symlinked
 * ancestor. This is always refused before any side effect (PRD 11.6).
 */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}
