/**
 * Scope matching.
 *
 * Default deny: an empty `include` list allows nothing, and `unknown` entries
 * mean "not resolved yet" rather than "allowed". Both choices are deliberate —
 * the failure mode of an over-permissive scope is a silent change to code the
 * user never agreed to, which is exactly what PRD 11.1 forbids.
 */

import {
  canonicalJson,
  sha256Hex,
  type Scope,
  type ScopeEntry,
  type Sha256Hex,
} from "@keystone/schemas";

export type PathIntent = "read" | "write";

export interface ScopeDecision {
  readonly allowed: boolean;
  readonly matchedBy?: ScopeEntry;
  readonly excludedBy?: ScopeEntry;
  readonly reason: string;
}

/**
 * Glob to anchored regex. `**` crosses path separators, `*` and `?` do not.
 * `**\/` also matches zero directories, so `src/**\/x.ts` matches `src/x.ts`.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return new RegExp(`${out}$`);
}

function entryMatches(entry: ScopeEntry, path: string): boolean {
  const normalised = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (entry.kind === "path") return normalised === entry.pattern;
  if (entry.kind === "directory") {
    const prefix = entry.pattern.replace(/\/+$/, "");
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  }
  return globToRegExp(entry.pattern).test(normalised);
}

function intentAllows(entry: ScopeEntry, intent: PathIntent): boolean {
  // A write entry implies read access to the same path; the reverse is not true.
  return entry.intent === "write" || entry.intent === intent;
}

export function decidePath(path: string, intent: PathIntent, scope: Scope): ScopeDecision {
  const excluded = scope.exclude.find((entry) => entryMatches(entry, path));
  if (excluded !== undefined) {
    return {
      allowed: false,
      excludedBy: excluded,
      reason: `"${path}" is excluded by ${excluded.kind} "${excluded.pattern}"`,
    };
  }

  const unknown = scope.unknown.find((pattern) => entryMatchesByPattern(pattern, path));
  const included = scope.include.find(
    (entry) => entryMatches(entry, path) && intentAllows(entry, intent),
  );

  if (included !== undefined) {
    return {
      allowed: true,
      matchedBy: included,
      reason: `"${path}" matches ${included.kind} "${included.pattern}" (${included.intent})`,
    };
  }

  if (unknown !== undefined) {
    return {
      allowed: false,
      reason:
        `"${path}" lies in an area the contract could not resolve (${unknown}); ` +
        "it needs confirmation before it can be touched",
    };
  }

  return {
    allowed: false,
    reason:
      `"${path}" is not covered by the contract scope for ${intent}` +
      (scope.include.length === 0 ? " (the scope includes nothing)" : ""),
  };
}

/**
 * `unknown` entries are free-form patterns rather than scope entries, so they
 * are matched with the same glob rules to keep the two consistent.
 */
function entryMatchesByPattern(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  if (pattern.includes("*") || pattern.includes("?")) {
    return globToRegExp(pattern).test(path.replace(/\\/g, "/"));
  }
  return path === pattern || path.startsWith(`${pattern.replace(/\/+$/, "")}/`);
}

export interface ScopeCheck {
  readonly allowed: readonly string[];
  readonly violations: readonly string[];
  readonly reason: string;
}

export function checkPaths(
  paths: readonly string[],
  intent: PathIntent,
  scope: Scope,
): ScopeCheck {
  const allowed: string[] = [];
  const violations: string[] = [];
  const reasons: string[] = [];

  for (const path of paths) {
    const decision = decidePath(path, intent, scope);
    if (decision.allowed) allowed.push(path);
    else {
      violations.push(path);
      reasons.push(decision.reason);
    }
  }

  return {
    allowed,
    violations,
    reason: reasons.length === 0 ? "all paths are within scope" : reasons.join("; "),
  };
}

/** Digest of a scope, used to detect that a lease was issued for a different scope. */
export function scopeDigest(scope: Scope): Sha256Hex {
  return sha256Hex(
    canonicalJson({
      include: [...scope.include].map((entry) => [entry.kind, entry.pattern, entry.intent]).sort(),
      exclude: [...scope.exclude].map((entry) => [entry.kind, entry.pattern, entry.intent]).sort(),
      unknown: [...scope.unknown].sort(),
    }),
  );
}

/** Path matching for the Autonomy Envelope, which uses plain path patterns. */
export function pathMatchesAny(path: string, patterns: readonly string[]): boolean {
  const normalised = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((pattern) => {
    if (pattern === "**" || pattern === "*") return true;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return normalised === prefix || normalised.startsWith(`${prefix}/`);
    }
    if (pattern.includes("*") || pattern.includes("?")) {
      return globToRegExp(pattern).test(normalised);
    }
    return normalised === pattern || normalised.startsWith(`${pattern.replace(/\/+$/, "")}/`);
  });
}
