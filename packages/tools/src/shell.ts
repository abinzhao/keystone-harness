/**
 * Command execution.
 *
 * A command is an independent action with no implicit shell: the executable name
 * and its arguments arrive separately, and the name must be bare — a value like
 * `./evil.sh` is refused because a path separator would slip past a lease that
 * only allowlists `evil.sh` (PRD EX-02, 11.1). The tool is marked irreversible
 * and non-replayable: an external process may write anywhere, so its effects
 * cannot be undone or repeated with confidence (PRD 11.5).
 */

import {
  arrayOf,
  defineSchema,
  int,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  toolDescriptorSchema,
  type InferSchema,
  type ToolDescriptor,
} from "@keystone/schemas";

import {
  TOOL_RESULT_SCHEMA_ID,
  assertLeaseCovers,
  assertWithinRoot,
  spawnCapture,
} from "./guard.ts";
import { ToolRefusedError, type Tool, type ToolResult } from "./types.ts";

/** A lease may shorten a timeout; this is the absolute ceiling it cannot raise. */
const MAX_TIMEOUT_MS = 600_000;

const runCommandInput = defineSchema(
  "keystone.tool.cmd.run.input",
  "1.0.0",
  objectOf({
    command: nonEmptyStr(),
    args: optional(arrayOf(str(), { maxItems: 256 })),
    timeoutMs: optional(int({ min: 1 })),
    cwd: optional(str({ minLength: 1 })),
  }),
);
type RunCommandArgs = InferSchema<typeof runCommandInput>;

export const runCommandTool: Tool<RunCommandArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "cmd.run",
    version: "1.0.0",
    description: "Run one executable without a shell, inside the workspace",
    capabilities: ["cmd.exec"],
    sideEffects: ["command"],
    // External processes can write anywhere and hold resources we do not track.
    reversibility: "irreversible",
    idempotent: false,
    // Replaying the run graph must not re-run arbitrary commands; a command is
    // only replayable when the producer declares it so, which this one does not.
    replayable: false,
    inputSchemaId: runCommandInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: 120_000,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: runCommandInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();

    // Only a bare executable name: allowing a path separator would let the
    // caller run any file that happens to be named like an allowed command.
    if (args.command.includes("/") || args.command.includes("\\")) {
      throw new ToolRefusedError(
        `command "${args.command}" contains a path separator; only a bare executable name is allowed`,
        "command_has_path_separator",
      );
    }

    // New grants bind the complete arguments/cwd/timeout, not only argv[0].
    assertLeaseCovers(ctx.lease, { capability: "cmd.exec", resourceValues: [args.command] }, args);

    const cwd = assertWithinRoot(
      ctx.rootPath,
      args.cwd ?? ctx.workingDirectory ?? ctx.rootPath,
    );

    const requested = args.timeoutMs ?? runCommandTool.descriptor.defaultTimeoutMs;
    const capped = Math.min(requested, MAX_TIMEOUT_MS);
    const timeoutMs = Math.min(capped, ctx.lease.constraints.timeoutMs ?? capped);
    const maxBytes =
      ctx.lease.constraints.maxOutputBytes ?? runCommandTool.descriptor.maxOutputBytes;

    const captured = await spawnCapture(args.command, args.args ?? [], {
      cwd,
      timeoutMs,
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
      // A command's file effects are unknown to the tool; the workspace-layer
      // verification is what detects out-of-scope changes (PRD EX-03).
      changedPaths: [],
      durationMs: Date.now() - start,
      truncated: captured.truncated,
      ...(captured.artifactId === undefined ? {} : { artifactId: captured.artifactId }),
      ...(captured.errorCode === undefined ? {} : { errorCode: captured.errorCode }),
    };
  },
};

export const shellTools: readonly Tool<unknown>[] = [runCommandTool as unknown as Tool<unknown>];
