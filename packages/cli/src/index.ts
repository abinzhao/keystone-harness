/**
 * `@keystone/cli` — the headless client.
 *
 * `runCli` is the single entry point: it resolves the presentation language,
 * dispatches to a command, maps a `UsageError` to exit code 2 and any other
 * failure to exit code 1, and prints a readable message rather than a stack.
 * `bin.ts` is the thin process wrapper.
 *
 * Language is resolved once, here, so every command and every help screen agrees
 * and no command has to declare a `--lang` flag of its own.
 */

import { translatorFor, type Language, type Translator } from "@keystone/i18n";

import { UsageError } from "./args.ts";
import { command as ciCommand } from "./commands/ci.ts";
import { command as doctorCommand } from "./commands/doctor.ts";
import { command as extensionCommand } from "./commands/extension.ts";
import { command as modelCommand } from "./commands/model.ts";
import { command as projectCommand } from "./commands/project.ts";
import { command as proofCommand } from "./commands/proof.ts";
import { command as protocolCommand } from "./commands/protocol.ts";
import { command as replayCommand } from "./commands/replay.ts";
import { command as serveCommand } from "./commands/serve.ts";
import { command as taskCommand } from "./commands/task.ts";
import type { CliContext, CommandModule } from "./commands/shared.ts";
import { extractLanguageFlag, resolveCliLanguage } from "./language.ts";

export type { CliContext, CommandModule, WriteStream } from "./commands/shared.ts";
export type { Language } from "@keystone/i18n";

/** The command registry, in the order shown by `keystone --help`. */
export const commands: readonly CommandModule[] = [
  projectCommand,
  taskCommand,
  ciCommand,
  extensionCommand,
  proofCommand,
  replayCommand,
  protocolCommand,
  modelCommand,
  doctorCommand,
  serveCommand,
];

const registry: ReadonlyMap<string, CommandModule> = new Map(
  commands.map((command) => [command.name, command]),
);

function topLevelHelp(t: Translator): string {
  const width = commands.reduce((max, command) => Math.max(max, command.name.length), 0);
  const lines = [
    t("keystone — evidence-native, local-first engineering agent harness"),
    "",
    t("Usage: keystone <command> [options]"),
    "",
    t("Commands:"),
  ];
  for (const command of commands) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary(t)}`);
  }
  lines.push(
    "",
    t("Options:"),
    // The one flag every command shares, so it is documented once, here.
    `  --lang <zh-CN|en>  ${t("Output language (default: zh-CN)")}`,
    "",
    t("Run `keystone <command> --help` for command-specific options."),
    "",
  );
  return `${lines.join("\n")}`;
}

export async function runCli(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const { argv: rest, flag } = extractLanguageFlag(argv);
  const language: Language = await resolveCliLanguage(context, flag);
  const t = translatorFor(language);
  const localized: CliContext = { ...context, language };

  try {
    return await dispatch(rest, localized, t);
  } catch (error) {
    if (error instanceof UsageError) {
      // A bad invocation is the caller's error: exit code 2, with a hint.
      context.stderr.write(`${error.message}\n`);
      context.stderr.write(`${t('Run "keystone --help" for usage.')}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

async function dispatch(
  argv: readonly string[],
  context: CliContext,
  t: Translator,
): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    context.stdout.write(topLevelHelp(t));
    return 0;
  }

  const command = registry.get(first);
  if (command === undefined) {
    throw new UsageError(t('unknown command "{command}"', { command: first }));
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    context.stdout.write(`${command.help}\n`);
    return 0;
  }
  return command.run(rest, context);
}
