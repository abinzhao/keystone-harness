/**
 * `keystone replay` — re-derive the authoritative state from the ledger.
 *
 * Replay is the CLI's half of PRD 14 item 12 (and NFR-REL-05): it folds the
 * ledger again and checks the result equals the folded state the session
 * already held. A mismatch is a hard failure, not a warning — an unreproducible
 * status means every downstream proof is untrustworthy.
 */

import { KernelSession } from "@keystone/kernel";

import { getBoolean, parseArgs } from "../args.ts";
import { createOutput } from "../output.ts";
import { pathsFor, toTaskId, translatorForContext, type CliContext, type CommandModule } from "./shared.ts";

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv, {
    positionals: ["taskId"],
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const t = translatorForContext(context);
  const taskIdValue = args.positionals[0];
  if (taskIdValue === undefined) return 2;

  const session = await KernelSession.open({ paths: pathsFor(context), taskId: toTaskId(taskIdValue) });
  const result = session.replay();

  output.section(t("Replay"));
  output.keyValue({
    [t("taskId")]: taskIdValue,
    [t("status")]: result.status,
    [t("seq")]: result.seq,
    [t("consistent")]: result.consistent ? "yes" : "NO",
  });
  output.json({ taskId: taskIdValue, ...result });

  if (!result.consistent) {
    output.error(
      t("State cannot be replayed consistently: the ledger no longer folds to the status that was recorded."),
    );
    return 1;
  }
  return 0;
}

export const command: CommandModule = {
  name: "replay",
  summary: (t) => t("Replay a task's state from its ledger and check consistency"),
  usage: "keystone replay <taskId> [--json]",
  help: [
    "keystone replay <taskId>",
    "",
    "  Re-fold the task's ledger and report whether the authoritative status is",
    "  reproducible. Exits non-zero when the state is not consistent.",
  ].join("\n"),
  run,
};
