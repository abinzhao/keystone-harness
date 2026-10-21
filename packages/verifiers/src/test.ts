/**
 * Test verifier (PRD VF-01).
 *
 * Runs the project's tests in a child process. That process is independent of
 * the Builder Loop's process, which is what lets the resulting evidence claim
 * `separate_process`; it is *not* independent of the working directory, so the
 * descriptor deliberately does not claim `builder_loop_workspace`.
 */

import { levelCanStandAlone } from "@keystone/schemas";

import { resolveScriptCommand } from "./commands.ts";
import { outcomeFromCaptured, runCaptured, splitCommand, type CapturedRun } from "./run.ts";
import type { Verifier, VerifierContext, VerifierOutcome } from "./types.ts";

const MAX_OUTPUT_BYTES = 200_000;

export const testVerifier: Verifier = {
  descriptor: {
    kind: "test",
    id: "verifier.test",
    version: "1.0.0",
    evidenceLevel: "E2",
    canSatisfyRequiredCondition: levelCanStandAlone("E2"),
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    timeoutMs: 600_000,
    requiresCommand: true,
    description: "Runs the project's test command in a separate process.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    const command = await resolveScriptCommand(ctx, "test");
    if (command === undefined) {
      return {
        status: "blocked",
        summary: "no test command could be identified, so tests were not run",
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
        incomplete: ["no test command could be identified for this project"],
      };
    }

    const { command: bin, args } = splitCommand(command);
    const captured = await runCaptured(ctx.paths, bin, args, {
      cwd: ctx.rootPath,
      timeoutMs: ctx.timeoutMs ?? testVerifier.descriptor.timeoutMs,
      maxBytes: MAX_OUTPUT_BYTES,
      ...(ctx.commandBoundary === undefined ? {} : { boundary: ctx.commandBoundary }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    return outcomeFromCaptured(captured, {
      command,
      summary: summariseTests(captured, command),
    });
  },
};

function summariseTests(captured: CapturedRun, command: string): string {
  if (captured.status === "blocked") return `the test command "${command}" could not be run`;
  const verdict = captured.status === "passed" ? "passed" : "failed";
  const lines = keyTestLines(captured);
  return lines.length === 0 ? `"${command}" ${verdict}` : `"${command}" ${verdict}: ${lines.join("; ")}`;
}

/**
 * Prefer the Node test-runner summary (`# pass N` / `# fail N`) when present;
 * otherwise fall back to the last few non-empty lines, which is where most
 * runners put their verdict.
 */
function keyTestLines(captured: CapturedRun): string[] {
  const lines = `${captured.stdout}\n${captured.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const counts = lines.filter((line) => /^#\s*(pass|fail)\s+\d+/.test(line));
  if (counts.length > 0) return counts.slice(0, 4);
  return lines.slice(-5);
}
