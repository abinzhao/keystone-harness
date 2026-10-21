/**
 * Deliberately tiny frontmatter parser for `SKILL.md`.
 *
 * A Skill's frontmatter is untrusted content Keystone reads before it decides
 * whether to show the skill to the model. We do not pull in a YAML dependency
 * (zero runtime deps, ADR-0004) — we parse the small, fixed shape a Skill
 * actually uses:
 *
 * ```
 * ---
 * name: some-skill
 * description: one line shown in the skill list
 * metadata:
 *   side_effects: read_only
 * ---
 * ```
 *
 * Anything richer is ignored, not an error: an unknown key must never be able
 * to smuggle a capability or a policy through.
 */

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  /** Free-form, untrusted hints; surfaced to the user, never acted on. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Body markdown after the closing fence. */
  readonly body: string;
}

export interface FrontmatterParseResult {
  readonly ok: boolean;
  readonly frontmatter?: SkillFrontmatter;
  readonly error?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse a SKILL.md file. Missing/invalid frontmatter is a *shape* failure, not
 * a throw — discovery should surface it and move on.
 */
export function parseSkillMarkdown(raw: string): FrontmatterParseResult {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) {
    return { ok: false, error: "SKILL.md has no opening --- frontmatter fence" };
  }
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) {
    return { ok: false, error: "SKILL.md frontmatter is malformed" };
  }
  const afterOpen = text.slice(firstNewline + 1);
  const closeMatch = afterOpen.search(/\n---(?:\n|$)/);
  if (closeMatch === -1) {
    return { ok: false, error: "SKILL.md has no closing --- frontmatter fence" };
  }

  const frontmatterText = afterOpen.slice(0, closeMatch);
  const body = afterOpen.slice(closeMatch + "\n---\n".length).trim();

  let name = "";
  let description = "";
  const metadata: Record<string, string> = {};

  const lines = frontmatterText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const isIndented = /^\s+/.test(line);
    if (isIndented) {
      // A metadata.* entry: "  side_effects: read_only".
      const nested = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (nested !== null && nested[1] !== undefined) {
        metadata[nested[1]] = unquote(nested[2] ?? "");
      }
      continue;
    }

    const top = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (top === null || top[1] === undefined) continue;
    const key = top[1];
    const value = unquote(top[2] ?? "");
    if (key === "name") name = value;
    else if (key === "description") description = value;
    // Unknown top-level keys are deliberately dropped: they cannot grant
    // anything by being present.
  }

  if (name === "") {
    return { ok: false, error: "SKILL.md frontmatter has no non-empty `name`" };
  }
  if (description === "") {
    return { ok: false, error: "SKILL.md frontmatter has no non-empty `description`" };
  }

  return { ok: true, frontmatter: { name, description, metadata, body } };
}
