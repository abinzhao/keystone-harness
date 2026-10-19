/**
 * Build verifier (PRD VF-01).
 *
 * Same resolution as lint: an explicit command, else a declared `scripts.build`
 * run through the project's manager, else blocked. A build only exists if the
 * project declares one, so there is nothing to guess.
 */

import { levelCanStandAlone } from "@keystone/schemas";

import { resolveScriptCommand } from "./commands.ts";
import { outcomeFromCaptured, runCaptured, splitCommand } from "./run.ts";
import type { Verifier, VerifierContext, VerifierOutcome } from "./types.ts";

const MAX_OUTPUT_BYTES = 200_000;

export const buildVerifier: Verifier = {
  descriptor: {
    kind: "build",
    id: "verifier.build",
    version: "1.0.0",
    evidenceLevel: "E2",
    canSatisfyRequiredCondition: levelCanStandAlone("E2"),
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    timeoutMs: 600_000,
    requiresCommand: true,
    description: "Runs the project's build command in a separate process.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    const command = await resolveScriptCommand(ctx, "build");
    if (command === undefined) {
      return {
        status: "blocked",
        summary: "no build command could be identified, so the build was not run",
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
        incomplete: ["no build command could be identified for this project"],
      };
    }

    const { command: bin, args } = splitCommand(command);
    const captured = await runCaptured(ctx.paths, bin, args, {
      cwd: ctx.rootPath,
      timeoutMs: ctx.timeoutMs ?? buildVerifier.descriptor.timeoutMs,
      maxBytes: MAX_OUTPUT_BYTES,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    const verdict = captured.status === "passed" ? "passed" : "failed";
    return outcomeFromCaptured(captured, { command, summary: `"${command}" ${verdict}` });
  },
};
