/**
 * Pure placeholder-parity checker.
 *
 * A translator who drops a placeholder (`Welcome {name}` -> "欢迎") or invents
 * one the source never had (`Welcome {name}` -> "欢迎 {user}") has not localized
 * the message: the renderer will either crash on the missing value or render a
 * blank the product never asked for. Catching that deterministically, before a
 * release, is cheaper than catching it in review.
 *
 * This module deliberately holds no I/O: it takes already-read catalog objects
 * and returns findings, so it can be unit-tested, reasoned about, and reused
 * from both the governed E1 verifier adapter and the runnable CLI.
 */

/** A flattened message catalog: message key -> format string. */
export type MessageCatalog = Readonly<Record<string, string>>;

export type PlaceholderFindingKind =
  | "missing_translation"
  | "dropped_placeholder"
  | "extra_placeholder"
  | "orphan_translation";

export interface PlaceholderFinding {
  readonly key: string;
  readonly kind: PlaceholderFindingKind;
  /** The placeholder name, when the finding is about one; empty otherwise. */
  readonly placeholder: string;
  readonly detail: string;
}

/**
 * Match both `{name}` (ICU / string-format) and `{{name}}` (i18next / Vue-style)
 * placeholders, tolerant of inner whitespace. Group 1 is the doubled-brace form,
 * group 2 the single-brace form, so they never double-count each other.
 */
const PLACEHOLDER =
  /\{\{\s*([A-Za-z0-9_]+)\s*\}\}|\{\s*([A-Za-z0-9_]+)\s*\}/g;

/**
 * The set of placeholder names a format string uses.
 *
 * Order-agnostic on purpose: a translation may reorder placeholders, and that is
 * correct for many languages. What must not change is the *set*.
 */
export function extractPlaceholders(message: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of message.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function asCatalog(value: unknown): MessageCatalog | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return undefined;
  }
  return value as MessageCatalog;
}

/** Parse a catalog file's text. Returns undefined when it is not a flat string map. */
export function parseCatalog(text: string): MessageCatalog | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return asCatalog(parsed);
}

/**
 * Compare a translated catalog against the source it claims to render.
 *
 * A result of `[]` means parity: every source key is translated, and each
 * translation uses exactly the placeholders the source used. Anything else is a
 * finding that names the key and the placeholder so it can be fixed.
 */
export function checkCatalogParity(
  source: MessageCatalog,
  target: MessageCatalog,
): readonly PlaceholderFinding[] {
  const findings: PlaceholderFinding[] = [];

  for (const key of Object.keys(source)) {
    const translated = target[key];
    if (translated === undefined) {
      findings.push({
        key,
        kind: "missing_translation",
        placeholder: "",
        detail: `the source message "${key}" has no translation`,
      });
      continue;
    }

    const sourceNames = extractPlaceholders(source[key] ?? "");
    const targetNames = extractPlaceholders(translated);

    for (const name of sourceNames) {
      if (!targetNames.has(name)) {
        findings.push({
          key,
          kind: "dropped_placeholder",
          placeholder: name,
          detail: `"${key}" drops the {${name}} placeholder the source requires`,
        });
      }
    }
    for (const name of targetNames) {
      if (!sourceNames.has(name)) {
        findings.push({
          key,
          kind: "extra_placeholder",
          placeholder: name,
          detail: `"${key}" uses {${name}}, which the source does not provide`,
        });
      }
    }
  }

  for (const key of Object.keys(target)) {
    if (source[key] === undefined) {
      findings.push({
        key,
        kind: "orphan_translation",
        placeholder: "",
        detail: `"${key}" is translated but no longer exists in the source catalog`,
      });
    }
  }

  return findings;
}

/** True when the translated catalog keeps every source placeholder, and invents none. */
export function catalogParityHolds(source: MessageCatalog, target: MessageCatalog): boolean {
  return checkCatalogParity(source, target).length === 0;
}
