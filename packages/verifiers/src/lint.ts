/**
 * Lint verifier (PRD VF-02).
 *
 * Lint output is an E1 tool record: useful as an auxiliary signal, but it can
 * never satisfy a *required* completion condition on its own. The descriptor
 * says so explicitly through `canSatisfyRequiredCondition`, and the
 * independence claim reflects that this runs a separate process but still
 * shares the working directory.
 */

import { levelCanStandAlone } from "@keystone/schemas";

import { resolveScriptCommand } from "./commands.ts";
import { outcomeFromCaptured, runCaptured, splitCommand } from "./run.ts";
import type { Verifier, VerifierContext, VerifierOutcome } from "./types.ts";

const MAX_OUTPUT_BYTES = 200_000;

export const lintVerifier: Verifier = {
  descriptor: {
    kind: "lint",
    id: "verifier.lint",
    version: "1.0.0",
    evidenceLevel: "E1",
    canSatisfyRequiredCondition: levelCanStandAlone("E1"),
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    timeoutMs: 300_000,
    requiresCommand: true,
    description: "Runs the project's lint command and records its output.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    const command = await resolveScriptCommand(ctx, "lint");
    if (command === undefined) {
      return {
        status: "blocked",
        summary: "no lint command could be identified, so lint was not run",
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
        incomplete: ["no lint command could be identified for this project"],
      };
    }

    const { command: bin, args } = splitCommand(command);
    const captured = await runCaptured(ctx.paths, bin, args, {
      cwd: ctx.rootPath,
      timeoutMs: ctx.timeoutMs ?? lintVerifier.descriptor.timeoutMs,
      maxBytes: MAX_OUTPUT_BYTES,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    const verdict = captured.status === "passed" ? "passed" : "failed";
    return outcomeFromCaptured(captured, { command, summary: `"${command}" ${verdict}` });
  },
};
