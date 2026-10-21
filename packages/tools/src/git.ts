/**
 * Git read tools.
 *
 * These observe the repository and change nothing, so they are reversible,
 * idempotent and replayable — re-reading the same revision yields the same bytes
 * (PRD EX-04). Diffs are the largest output in normal use, so their ceiling is
 * raised to 4 MB and anything past it is stored content-addressed (PRD 12.4).
 */

import {
  arrayOf,
  bool,
  defineSchema,
  nonEmptyStr,
  objectOf,
  optional,
  toolDescriptorSchema,
  type InferSchema,
  type ToolDescriptor,
} from "@keystone/schemas";

import {
  TOOL_RESULT_SCHEMA_ID,
  assertLeaseCovers,
  assertWithinRoot,
  spawnCapture,
  toRelative,
  type CapturedOutput,
} from "./guard.ts";
import { ToolRefusedError, type Tool, type ToolContext, type ToolResult } from "./types.ts";

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
    return runGit(ctx, ["status", "--porcelain=v1"], gitStatusTool.descriptor, _args);
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
    return runGit(ctx, argv, gitDiffTool.descriptor, args);
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
    return runGit(ctx, ["show", revision], gitShowHeadTool.descriptor, args);
  },
};

const gitCommitInput = defineSchema(
  "keystone.tool.git.commit.input",
  "1.0.0",
  objectOf({
    paths: arrayOf(nonEmptyStr(), { minItems: 1, maxItems: 256 }),
    message: nonEmptyStr(),
  }),
);
type GitCommitArgs = InferSchema<typeof gitCommitInput>;

/**
 * Stage and commit exactly the given in-scope paths.
 *
 * This is a side effect, so it re-checks the lease for each named path *before*
 * any `git add` runs (PRD EX-03). Two refusals happen before the index changes:
 *  - out-of-scope: a path the lease does not cover;
 *  - dirty-overlap: a path that was already dirty/untracked at onboarding, which
 *    must not have the user's pre-existing hunk swept into the agent's commit
 *    (PRD PI-01 line 312; ADR-0007, decision B1).
 *
 * `git commit -- <paths>` records only those paths' working-tree content, so
 * other staged/unstaged changes are never included. On failure the harness does
 * not move refs itself (decision A3); it reports the failure and leaves the
 * repository for the existing fingerprint-based recovery / explicit rollback.
 */
export const gitCommitTool: Tool<GitCommitArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "git.commit",
    version: "1.0.0",
    description: "Stage and commit only the given in-scope paths with a message",
    capabilities: ["git.write"],
    sideEffects: ["git"],
    // A commit can be undone by the explicit git.rollback action, but never
    // automatically, so it is compensable — not irreversible.
    reversibility: "compensable",
    idempotent: false,
    replayable: false,
    inputSchemaId: gitCommitInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: gitCommitInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    const rels = args.paths.map((path) => toRelative(ctx.rootPath, assertWithinRoot(ctx.rootPath, path)));
    // Out-of-scope denial before any index write.
    assertLeaseCovers(ctx.lease, { capability: "git.write", resourceValues: rels }, args);

    // Dirty-overlap refusal: never sweep a pre-existing user change into this commit.
    const baseline = ctx.baselineDirtyPaths;
    if (baseline !== undefined) {
      const overlaps = rels.filter((rel) => baseline.has(rel));
      if (overlaps.length > 0) {
        throw new ToolRefusedError(
          `refusing to commit ${overlaps.join(", ")}: it was already dirty/untracked at ` +
            "onboarding, so committing it would sweep a pre-existing user change into the " +
            "agent commit; resolve it or run in an isolated workspace",
          "preexisting_dirty_overlap",
        );
      }
    }

    const preHead = (await gitWrite(ctx, ["rev-parse", "HEAD"])).stdout.trim();

    const stage = await gitWrite(ctx, ["add", "--", ...rels]);
    if (stage.status !== "succeeded") {
      return toResult(start, stage, []);
    }
    const commit = await gitWrite(ctx, ["commit", "-m", args.message, "--", ...rels]);
    if (commit.status !== "succeeded") {
      // No automatic ref movement on failure (ADR-0007, decision A3).
      return toResult(start, commit, []);
    }
    const postHead = (await gitWrite(ctx, ["rev-parse", "HEAD"])).stdout.trim();
    const stdout =
      `Committed ${rels.length} path(s): ${short(preHead)}..${short(postHead)}\n${commit.stdout}`;
    return {
      status: "succeeded",
      stdout,
      outputBytes: Buffer.byteLength(stdout, "utf8"),
      changedPaths: rels,
      durationMs: Date.now() - start,
      truncated: false,
    };
  },
};

const gitRollbackInput = defineSchema(
  "keystone.tool.git.rollback.input",
  "1.0.0",
  objectOf({
    target: nonEmptyStr(),
    reason: optional(nonEmptyStr()),
  }),
);
type GitRollbackArgs = InferSchema<typeof gitRollbackInput>;

/**
 * Explicit, user-approved, lease-gated rollback: move the branch pointer back to
 * a recorded commit with `git reset --soft <target>`.
 *
 * `--soft` moves HEAD but leaves the index and working tree untouched, so no
 * user dirty/untracked change and no agent change is overwritten (PRD PI-01 line
 * 312; ADR-0007, decision A3). This tool is never invoked automatically; the
 * model proposes it and it carries a user-decision `decisionRef` on its lease.
 */
export const gitRollbackTool: Tool<GitRollbackArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "git.rollback",
    version: "1.0.0",
    description:
      "Move the current branch back to a recorded commit without touching the working tree",
    capabilities: ["git.write"],
    sideEffects: ["git"],
    reversibility: "reversible",
    idempotent: false,
    replayable: false,
    inputSchemaId: gitRollbackInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: gitRollbackInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    // A branch-pointer operation spans the whole worktree.
    assertLeaseCovers(ctx.lease, { capability: "git.write", resourceValues: [WORKTREE_RESOURCE] }, args);

    const oldHead = (await gitWrite(ctx, ["rev-parse", "HEAD"])).stdout.trim();
    const verify = await gitWrite(ctx, ["rev-parse", "--verify", `${args.target}^{commit}`]);
    if (verify.status !== "succeeded") {
      return toResult(start, verify, [], "unknown_rollback_target");
    }
    const reset = await gitWrite(ctx, ["reset", "--soft", args.target]);
    if (reset.status !== "succeeded") {
      return toResult(start, reset, []);
    }
    const newHead = (await gitWrite(ctx, ["rev-parse", "HEAD"])).stdout.trim();
    const stdout =
      `Rolled back branch ${short(oldHead)}..${short(newHead)} (working tree preserved)\n${reset.stdout}`;
    return {
      status: "succeeded",
      stdout,
      outputBytes: Buffer.byteLength(stdout, "utf8"),
      changedPaths: [],
      durationMs: Date.now() - start,
      truncated: false,
    };
  },
};

/** Run a git sub-command for a write tool; the caller has already checked the lease. */
async function gitWrite(ctx: ToolContext, argv: readonly string[]): Promise<CapturedOutput> {
  return spawnCapture("git", argv, {
    cwd: ctx.rootPath,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: ctx.lease.constraints.maxOutputBytes ?? 1_000_000,
    paths: ctx.paths,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
}

function toResult(
  start: number,
  captured: CapturedOutput,
  changedPaths: readonly string[],
  errorCode?: string,
): ToolResult {
  return {
    status: captured.status,
    ...(captured.exitCode === undefined ? {} : { exitCode: captured.exitCode }),
    stdout: captured.stdout,
    stderr: captured.stderr,
    outputBytes: captured.outputBytes,
    changedPaths,
    durationMs: Date.now() - start,
    truncated: captured.truncated,
    ...(captured.artifactId === undefined ? {} : { artifactId: captured.artifactId }),
    ...(captured.errorCode === undefined && errorCode === undefined
      ? {}
      : { errorCode: captured.errorCode ?? errorCode }),
  };
}

function short(sha: string): string {
  return sha.length <= 8 ? sha : sha.slice(0, 8);
}

async function runGit(
  ctx: ToolContext,
  argv: readonly string[],
  descriptor: ToolDescriptor,
  parameters: unknown,
): Promise<ToolResult> {
  const start = Date.now();
  // A git read observes the whole worktree, so the lease resource is the root.
  assertLeaseCovers(ctx.lease, { capability: "git.read", resourceValues: [WORKTREE_RESOURCE] }, parameters);

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
  gitCommitTool as unknown as Tool<unknown>,
  gitRollbackTool as unknown as Tool<unknown>,
];
