/**
 * Diff-scope verifier (PRD EX-03, VF-01).
 *
 * "Done" includes "changed nothing outside the contract". This check is
 * deterministic and involves no model, so it can honestly claim independence
 * from the Builder Loop's model and process — but it reads the same working
 * tree, so it does not claim workspace independence.
 *
 * An empty change set is reported as *passed* (there is nothing out of scope)
 * while still surfacing "no changed paths were observed" as an incomplete item:
 * "nothing to violate" and "we saw nothing at all" must not look identical.
 */

import { checkPaths } from "@keystone/kernel";
import { levelCanStandAlone } from "@keystone/schemas";

import { runCaptured } from "./run.ts";
import type { Verifier, VerifierContext, VerifierOutcome } from "./types.ts";

const MAX_SHOWN = 20;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 100_000;

export const diffScopeVerifier: Verifier = {
  descriptor: {
    kind: "diff_scope",
    id: "verifier.diff_scope",
    version: "1.0.0",
    evidenceLevel: "E2",
    canSatisfyRequiredCondition: levelCanStandAlone("E2"),
    independence: {
      mode: "separate_process",
      independentOf: ["builder_loop_model", "builder_loop_process"],
    },
    timeoutMs: 60_000,
    requiresCommand: false,
    description: "Checks that every changed path is inside the contract's write scope.",
  },

  async run(ctx: VerifierContext): Promise<VerifierOutcome> {
    let changed: readonly string[];
    if (ctx.changedPaths.length > 0) {
      changed = [...ctx.changedPaths];
    } else {
      const observed = await observeChangedPaths(ctx);
      if (observed.blockedReason !== undefined) {
        return {
          status: "blocked",
          summary: `the changed paths could not be determined: ${observed.blockedReason}`,
          outputBytes: 0,
          truncated: false,
          durationMs: 0,
          incomplete: [observed.blockedReason],
        };
      }
      changed = observed.paths;
    }

    if (changed.length === 0) {
      return {
        status: "passed",
        summary: "no changes detected; nothing to check against the contract scope",
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
        incomplete: ["no changed paths were observed"],
      };
    }

    const check = checkPaths(changed, "write", ctx.contract.scope);
    if (check.violations.length > 0) {
      const shown = check.violations.slice(0, MAX_SHOWN);
      const remaining = check.violations.length - shown.length;
      return {
        status: "failed",
        summary:
          `${check.violations.length} changed path(s) fall outside the contract scope: ` +
          `${shown.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
        outputBytes: 0,
        truncated: false,
        durationMs: 0,
      };
    }

    return {
      status: "passed",
      summary: `all ${changed.length} changed path(s) are within the contract scope`,
      outputBytes: 0,
      truncated: false,
      durationMs: 0,
    };
  },
};

interface ChangeObservation {
  readonly paths: readonly string[];
  readonly blockedReason?: string;
}

/**
 * Ask git what changed. A failure to read the tree is reported as blocked
 * rather than an empty (and therefore "clean") result, which would be a false
 * reassurance.
 */
async function observeChangedPaths(ctx: VerifierContext): Promise<ChangeObservation> {
  const tracked = await gitLines(ctx, ["diff", "--name-only", "HEAD"]);
  const untracked = await gitLines(ctx, ["ls-files", "--others", "--exclude-standard"]);

  if (!tracked.ok || !untracked.ok) {
    return {
      paths: [],
      blockedReason: tracked.reason ?? untracked.reason ?? "git could not be run",
    };
  }
  return { paths: [...new Set([...tracked.lines, ...untracked.lines])] };
}

async function gitLines(
  ctx: VerifierContext,
  args: readonly string[],
): Promise<{ ok: boolean; lines: string[]; reason?: string }> {
  const captured = await runCaptured(ctx.paths, "git", args, {
    cwd: ctx.rootPath,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: GIT_MAX_BYTES,
    ...(ctx.commandBoundary === undefined ? {} : { boundary: ctx.commandBoundary }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

  if (captured.status !== "passed") {
    const reason =
      captured.blockedReason ??
      `"git ${args.join(" ")}" exited with status "${captured.status}"`;
    return { ok: false, lines: [], reason };
  }

  const lines = captured.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: true, lines };
}
