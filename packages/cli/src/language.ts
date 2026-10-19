/**
 * Language selection for the CLI.
 *
 * The decision itself is a pure function in `@keystone/i18n`; this module is the
 * thin I/O around it — pulling `--lang` out of argv, reading `KEYSTONE_LANG`, and
 * consulting `config.json` only when neither of those decided. `--lang` is
 * handled here rather than in each command so that it works uniformly, including
 * for `keystone --help`, and so a command's own flag parsing never has to know
 * about it.
 */

import {
  LANGUAGE_ENV,
  normalizeLanguage,
  resolveLanguage,
  type Language,
} from "@keystone/i18n";
import { KEYSTONE_HOME_ENV, resolveKeystonePaths } from "@keystone/kernel";
import { loadConfig } from "@keystone/models";

import type { CliContext } from "./commands/shared.ts";

export interface ExtractedLanguage {
  /** argv with any `--lang` flag and its value removed. */
  readonly argv: string[];
  readonly flag: string | undefined;
}

/**
 * Remove `--lang <value>` / `--lang=<value>` from argv, keeping the first value
 * if it is given more than once. The flag must be extracted centrally because
 * commands do not declare it, and an undeclared flag is a usage error.
 */
export function extractLanguageFlag(argv: readonly string[]): ExtractedLanguage {
  const rest: string[] = [];
  let flag: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token === "--lang") {
      const value = argv[index + 1];
      if (value !== undefined && value !== "" && !value.startsWith("--")) {
        if (flag === undefined) flag = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--lang=")) {
      const value = token.slice("--lang=".length);
      if (flag === undefined && value !== "") flag = value;
      continue;
    }
    rest.push(token);
  }

  return { argv: rest, flag };
}

/**
 * `--lang` beats `KEYSTONE_LANG` beats `config.json`. The config file is read
 * only when the first two did not settle it, so the common paths never touch
 * disk for this.
 */
export async function resolveCliLanguage(
  context: CliContext,
  flag: string | undefined,
): Promise<Language> {
  const env = context.env[LANGUAGE_ENV];
  if (normalizeLanguage(flag) !== undefined || normalizeLanguage(env) !== undefined) {
    return resolveLanguage({ flag, env });
  }
  return resolveLanguage({ flag, env, config: await configuredLanguage(context) });
}

async function configuredLanguage(context: CliContext): Promise<string | undefined> {
  try {
    const override = context.env[KEYSTONE_HOME_ENV];
    const paths = resolveKeystonePaths(
      override === undefined || override === "" ? undefined : override,
    );
    const config = await loadConfig({ configFile: paths.configFile });
    return config.language;
  } catch {
    // A missing or unreadable config must not stop the CLI; the default applies.
    return undefined;
  }
}
