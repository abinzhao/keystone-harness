/**
 * `keystone project` — attach and inspect a project.
 *
 * Detection is shown verbatim, including what could *not* be identified: an
 * unrecognised command is reported as `unrecognized`, never replaced with a
 * guessed command (PRD PI-01 §4). This is the CLI's view of the same profile
 * the desktop client reads.
 */

import { projectIdForWorkspace } from "@keystone/kernel";
import {
  detectProjectProfile,
  NotAGitRepositoryError,
  scanWorkspace,
} from "@keystone/pack-engineering";

import { getBoolean, parseArgs, UsageError } from "../args.ts";
import { createOutput } from "../output.ts";
import { pathsFor, translatorForContext, type CliContext, type CommandModule } from "./shared.ts";

async function runInspect(argv: readonly string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv, {
    positionals: ["path"],
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const t = translatorForContext(context);

  const target = args.positionals[0];
  if (target === undefined) return 2; // unreachable: parseArgs guarantees it

  const projectId = await projectIdForWorkspace(target);
  const profile = await detectProjectProfile(target, projectId);

  let snapshotSummary: Record<string, unknown>;
  let humanSnapshot: Record<string, string>;
  try {
    const snapshot = await scanWorkspace(target);
    snapshotSummary = {
      entryCount: snapshot.entryCount,
      dirty: snapshot.dirty,
      headCommit: snapshot.headCommit ?? null,
      branch: snapshot.branch ?? null,
      entriesTruncated: snapshot.entriesTruncated,
      fingerprint: snapshot.fingerprint,
    };
    humanSnapshot = {
      [t("tracked files")]: String(snapshot.entryCount),
      [t("dirty")]: snapshot.dirty ? t("yes (uncommitted changes present)") : t("no"),
      [t("head")]: snapshot.headCommit ?? t("(no commits)"),
      [t("branch")]: snapshot.branch ?? t("(unknown)"),
      [t("entries truncated")]: snapshot.entriesTruncated ? t("yes") : t("no"),
    };
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) {
      output.error(error.message);
      output.error(t("Keystone requires a Git work tree for recovery, branching and evidence invalidation."));
      return 1;
    }
    throw error;
  }

  // Ignore the store path here: `project inspect` reads the workspace directly
  // and does not touch the ledger.
  void pathsFor(context);

  output.section(t("Project"));
  output.keyValue({
    [t("name")]: profile.name,
    [t("root")]: profile.rootPath,
    [t("vcs")]: profile.vcs,
    [t("languages")]: profile.languages.join(", ") || t("(none detected)"),
    [t("package manager")]: profile.packageManager ?? t("(none detected)"),
  });

  output.section(t("Support matrix"));
  output.keyValue({
    [t("status")]: profile.support.status,
    [t("reason")]: profile.support.reasons.join("; "),
  });

  output.section(t("Commands"));
  for (const command of profile.commands) {
    if (command.status === "identified") {
      output.line(
        t("[identified]   {kind}: {command}  ({source})", {
          kind: command.kind,
          command: command.command ?? t("(none)"),
          source: command.source ?? t("unknown source"),
        }),
      );
    } else {
      output.line(
        t("[unrecognized] {kind}: not identified in this project — Keystone will not guess a command", {
          kind: command.kind,
        }),
      );
    }
  }

  output.section(t("Instruction files"));
  output.line(
    profile.instructionFiles.length > 0
      ? profile.instructionFiles.join(", ")
      : t("none found (no AGENTS.md, CLAUDE.md or .cursor/rules)"),
  );

  output.section(t("Workspace snapshot"));
  output.keyValue(humanSnapshot);
  output.detail(t("fingerprint: {value}", { value: String(snapshotSummary["fingerprint"] ?? "") }));

  output.json({
    projectId,
    profile,
    snapshot: snapshotSummary,
  });
  return 0;
}

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const sub = argv[0];
  if (sub === "inspect") return runInspect(argv.slice(1), context);
  throw new UsageError(
    `unknown subcommand "project ${sub ?? ""}"; expected "project inspect"`,
  );
}

export const command: CommandModule = {
  name: "project",
  summary: (t) => t("Attach and inspect a project's profile and support matrix"),
  usage: "keystone project inspect <path> [--json] [--verbose]",
  help: [
    "keystone project inspect <path>",
    "",
    "  Detect the project's languages, package manager, support matrix status and",
    "  the commands Keystone could identify. Commands it cannot identify are shown",
    "  as 'unrecognized' rather than guessed.",
    "",
    "  Options:",
    "    --json      Print the profile as JSON",
    "    --verbose    Include the workspace fingerprint",
  ].join("\n"),
  run,
};
