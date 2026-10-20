/**
 * E2 verifier: the deterministic parity checker, run in a child process.
 *
 * The E1 adapter (`./verifier.ts`) scans the catalogs *in this process*, which
 * is honest but weak: it shares the Builder Loop's process, so it can only ever
 * be auxiliary. "Done" for a localization change needs evidence the Builder Loop
 * did not produce itself — that is what this verifier supplies.
 *
 * It reuses the runtime's captured-run boundary (`runCaptured`) rather than
 * spawning on its own, so it gets the exact same guarantees as the built-in
 * test verifier: no shell, a scrubbed environment (no credentials leak), an
 * output cap backed by a content-addressed artifact, and a hard timeout. The
 * child process runs the same pure checker the E1 adapter calls in-process
 * (`./cli.ts` → `./checker.ts`), so the two can never disagree on what "parity"
 * means.
 *
 * Honesty block: it runs in a separate process but shares the workspace working
 * directory, so it claims independence only of `builder_loop_process` — never of
 * the workspace (PRD VF-01, VF-04), exactly like the built-in test verifier.
 */

import { fileURLToPath } from "node:url";

import { levelCanStandAlone } from "@keystone/schemas";
import { outcomeFromCaptured, runCaptured } from "@keystone/verifiers";
import type { Verifier, VerifierContext, VerifierOutcome } from "@keystone/verifiers";

const MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_SOURCE = "locales/en.json";
const DEFAULT_TARGET = "locales/zh.json";

/** The checker the child process runs; resolved relative to this module. */
const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));

/**
 * Which catalogs the check compares comes from the condition's verifier params —
 * the localization ContractProposer names them — so this verifier is not tied to
 * one fixed locale. Missing params fall back to the reference scenario's files.
 */
function catalogsOf(ctx: VerifierContext): { readonly source: string; readonly target: string } {
  const params = ctx.conditions[0]?.verifier?.params as Record<string, unknown> | undefined;
  const source =
    typeof params?.source === "string" && params.source.length > 0 ? params.source : DEFAULT_SOURCE;
  const target =
    typeof params?.target === "string" && params.target.length > 0 ? params.target : DEFAULT_TARGET;
  return { source, target };
}

export const localizationParityE2Verifier: Verifier = {
  descriptor: {
    kind: "custom",
    id: "extension.localization_placeholders.e2",
    version: "1.0.0",
    // Controlled execution in a separate process: this is what lets the
    // resulting evidence stand alone for a required condition (PRD VF-02).
    evidenceLevel: "E2",
    canSatisfyRequiredCondition: levelCanStandAlone("E2"),
    independence: {
      mode: "separate_process",
      independentOf: ["builder_loop_process"],
    },
    timeoutMs: 30_000,
    requiresCommand: false,
    description:
      "Runs the deterministic placeholder-parity checker for source vs target catalog in a child process.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    const { source, target } = catalogsOf(ctx);
    const command = `${process.execPath} ${CLI_PATH} ${source} ${target}`;

    const captured = await runCaptured(ctx.paths, process.execPath, [CLI_PATH, source, target], {
      cwd: ctx.rootPath,
      timeoutMs: ctx.timeoutMs ?? localizationParityE2Verifier.descriptor.timeoutMs,
      maxBytes: MAX_OUTPUT_BYTES,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    return outcomeFromCaptured(captured, {
      command,
      summary: `placeholder parity check (${source} vs ${target})`,
    });
  },
};
