/**
 * Language selection.
 *
 * Only two languages exist today, and the *default is Chinese* because the
 * product's first audience is Chinese-speaking (PRD, product brief). The
 * decision is deliberately a tiny pure function so it can be unit tested for
 * every source combination without touching a filesystem or an environment.
 *
 * Precedence, highest first:
 *   1. an explicit `--lang` flag
 *   2. the `KEYSTONE_LANG` environment variable
 *   3. the `language` field in `config.json`
 *   4. the built-in default (Chinese)
 *
 * An unrecognised value at any level is ignored rather than being an error: a
 * typo in one source must not stop the tool from running, and the next source
 * still gets its say (falling through to the default).
 */

export const LANGUAGES = ["zh-CN", "en"] as const;

export type Language = (typeof LANGUAGES)[number];

/** The shipped default: Chinese, because that is the primary audience. */
export const DEFAULT_LANGUAGE: Language = "zh-CN";

/** Environment variable that overrides the configured language. */
export const LANGUAGE_ENV = "KEYSTONE_LANG";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Map a user-supplied tag onto a supported language. Accepts the bare language
 * and the common regional/script variants so `zh`, `zh-Hans`, `en-US` and the
 * exact tags all work, case-insensitively.
 */
export function normalizeLanguage(value: string | undefined): Language | undefined {
  if (value === undefined) return undefined;
  const tag = value.trim().toLowerCase();
  if (tag === "") return undefined;
  if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return undefined;
}

export interface LanguageSources {
  /** The `--lang` flag value, if the invocation supplied one. */
  readonly flag?: string | undefined;
  /** The `KEYSTONE_LANG` value, if set. */
  readonly env?: string | undefined;
  /** The `language` value from `config.json`, if present. */
  readonly config?: string | undefined;
}

export function resolveLanguage(sources: LanguageSources): Language {
  return (
    normalizeLanguage(sources.flag) ??
    normalizeLanguage(sources.env) ??
    normalizeLanguage(sources.config) ??
    DEFAULT_LANGUAGE
  );
}
