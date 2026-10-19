/**
 * Typecheck verifier (PRD VF-01).
 *
 * Prefers an explicit command, then a real `tsc` invocation. It refuses to run
 * when there is no `tsconfig.json` to check: a compiler run against nothing
 * would produce an empty, meaningless "pass", and PRD 9.1 says an unverified
 * item must not be presented as done.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { levelCanStandAlone } from "@keystone/schemas";

import { conditionCommand } from "./commands.ts";
import { outcomeFromCaptured, runCaptured, splitCommand } from "./run.ts";
import type { Verifier, VerifierContext, VerifierOutcome } from "./types.ts";

const MAX_OUTPUT_BYTES = 200_000;

export const typecheckVerifier: Verifier = {
  descriptor: {
    kind: "typecheck",
    id: "verifier.typecheck",
    version: "1.0.0",
    evidenceLevel: "E2",
    canSatisfyRequiredCondition: levelCanStandAlone("E2"),
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    timeoutMs: 300_000,
    requiresCommand: false,
    description: "Runs the TypeScript compiler in no-emit mode against the project.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    const command = resolveTypecheckCommand(ctx);
    if (command === undefined) {
      return {
        status: "blocked",
        summary: "no tsconfig.json and no typecheck command were found, so typecheck was not run",
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
        incomplete: ["no tsconfig.json was found and no typecheck command was provided"],
      };
    }

    const { command: bin, args } = splitCommand(command);
    const captured = await runCaptured(ctx.paths, bin, args, {
      cwd: ctx.rootPath,
      timeoutMs: ctx.timeoutMs ?? typecheckVerifier.descriptor.timeoutMs,
      maxBytes: MAX_OUTPUT_BYTES,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    const verdict = captured.status === "passed" ? "passed" : "failed";
    return outcomeFromCaptured(captured, {
      command,
      summary: `"${command}" ${verdict}`,
    });
  },
};

function resolveTypecheckCommand(ctx: VerifierContext): string | undefined {
  const explicit = conditionCommand(ctx.conditions);
  if (explicit !== undefined) return explicit;

  // A compiler needs a project; without a tsconfig there is nothing to check.
  if (!existsSync(join(ctx.rootPath, "tsconfig.json"))) return undefined;

  // A local install puts a `tsc` shim on disk; on Windows that shim is
  // `tsc.cmd`, not the extension-less POSIX name.
  const binName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const localTsc = join(ctx.rootPath, "node_modules", ".bin", binName);
  return existsSync(localTsc) ? `${localTsc} --noEmit` : "npx --no-install tsc --noEmit";
}
