/**
 * Git read tools.
 *
 * These observe the repository and change nothing, so they are reversible,
 * idempotent and replayable — re-reading the same revision yields the same bytes
 * (PRD EX-04). Diffs are the largest output in normal use, so their ceiling is
 * raised to 4 MB and anything past it is stored content-addressed (PRD 12.4).
 */

import {
  bool,
  defineSchema,
  nonEmptyStr,
  objectOf,
  optional,
  toolDescriptorSchema,
  type InferSchema,
  type ToolDescriptor,
} from "@keystone/schemas";

import { TOOL_RESULT_SCHEMA_ID, assertLeaseCovers, spawnCapture } from "./guard.ts";
import { type Tool, type ToolContext, type ToolResult } from "./types.ts";

const GIT_TIMEOUT_MS = 30_000;
/** Repository-relative selectors for a whole-worktree git read. */
const WORKTREE_RESOURCE = ".";

const gitStatusInput = defineSchema("keystone.tool.git.status.input", "1.0.0", objectOf({}));
type GitStatusArgs = InferSchema<typeof gitStatusInput>;

export const gitStatusTool: Tool<GitStatusArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "git.status",
    version: "1.0.0",
    description: "Show the working tree status as porcelain output",
    capabilities: ["git.read"],
    sideEffects: ["none"],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: gitStatusInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: gitStatusInput.validator,
  async run(_args, ctx): Promise<ToolResult> {
    return runGit(ctx, ["status", "--porcelain=v1"], gitStatusTool.descriptor);
  },
};

const gitDiffInput = defineSchema(
  "keystone.tool.git.diff.input",
  "1.0.0",
  objectOf({
    staged: optional(bool()),
    path: optional(nonEmptyStr()),
  }),
);
type GitDiffArgs = InferSchema<typeof gitDiffInput>;

export const gitDiffTool: Tool<GitDiffArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "git.diff",
    version: "1.0.0",
    description: "Show unstaged or staged changes, optionally limited to a path",
    capabilities: ["git.read"],
    sideEffects: ["none"],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: gitDiffInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 4_000_000,
  }) as ToolDescriptor,
  input: gitDiffInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const argv = ["diff"];
    if (args.staged === true) argv.push("--cached");
    if (args.path !== undefined) argv.push("--", args.path);
    return runGit(ctx, argv, gitDiffTool.descriptor);
  },
};

const gitShowHeadInput = defineSchema(
  "keystone.tool.git.show_head.input",
  "1.0.0",
  objectOf({ path: optional(nonEmptyStr()) }),
);
type GitShowHeadArgs = InferSchema<typeof gitShowHeadInput>;

export const gitShowHeadTool: Tool<GitShowHeadArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "git.show_head",
    version: "1.0.0",
    description: "Show the HEAD commit, or one file at HEAD",
    capabilities: ["git.read"],
    sideEffects: ["none"],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: gitShowHeadInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 4_000_000,
  }) as ToolDescriptor,
  input: gitShowHeadInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const revision = args.path === undefined ? "HEAD" : `HEAD:${args.path}`;
    return runGit(ctx, ["show", revision], gitShowHeadTool.descriptor);
  },
};

async function runGit(
  ctx: ToolContext,
  argv: readonly string[],
  descriptor: ToolDescriptor,
): Promise<ToolResult> {
  const start = Date.now();
  // A git read observes the whole worktree, so the lease resource is the root.
  assertLeaseCovers(ctx.lease, { capability: "git.read", resourceValues: [WORKTREE_RESOURCE] });

  const maxBytes = ctx.lease.constraints.maxOutputBytes ?? descriptor.maxOutputBytes;
  const captured = await spawnCapture("git", argv, {
    cwd: ctx.rootPath,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes,
    paths: ctx.paths,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

  return {
    status: captured.status,
    ...(captured.exitCode === undefined ? {} : { exitCode: captured.exitCode }),
    stdout: captured.stdout,
    stderr: captured.stderr,
    outputBytes: captured.outputBytes,
    changedPaths: [],
    durationMs: Date.now() - start,
    truncated: captured.truncated,
    ...(captured.artifactId === undefined ? {} : { artifactId: captured.artifactId }),
    ...(captured.errorCode === undefined ? {} : { errorCode: captured.errorCode }),
  };
}

export const gitTools: readonly Tool<unknown>[] = [
  gitStatusTool as unknown as Tool<unknown>,
  gitDiffTool as unknown as Tool<unknown>,
  gitShowHeadTool as unknown as Tool<unknown>,
];
