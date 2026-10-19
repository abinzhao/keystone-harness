/**
 * A tiny hand-written argument parser.
 *
 * The CLI has no runtime dependencies on purpose, so this replaces a library.
 * The one behaviour that matters for safety is that an *unknown* flag is a
 * usage error (exit code 2) rather than being silently ignored: a misspelled
 * `--write-path` must never turn into "no write scope declared", because that
 * would quietly change the task's boundary.
 */

/** A usage error maps to exit code 2 — the caller's invocation was wrong. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type FlagKind = "boolean" | "string" | "repeat";

export interface ArgSpec {
  /** Names of the positional arguments, in order. */
  readonly positionals?: readonly string[];
  /** When true, extra positionals beyond the named ones are accepted. */
  readonly variadic?: boolean;
  readonly flags?: Readonly<Record<string, FlagKind>>;
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly named: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const flags = spec.flags ?? {};
  const names = spec.positionals ?? [];
  const positionals: string[] = [];
  const named: Record<string, string | boolean | readonly string[]> = {};

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;

    if (token === "--") {
      // Everything after a bare `--` is positional, even if it looks like a flag.
      index += 1;
      for (; index < argv.length; index += 1) {
        const rest = argv[index];
        if (rest !== undefined) positionals.push(rest);
      }
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      const kind = flags[name];
      if (kind === undefined) throw new UsageError(`unknown flag "--${name}"`);

      if (kind === "boolean") {
        if (inlineValue !== undefined) {
          throw new UsageError(`flag "--${name}" does not take a value`);
        }
        named[name] = true;
        index += 1;
        continue;
      }

      let value = inlineValue;
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UsageError(`flag "--${name}" requires a value`);
        }
        value = next;
        index += 1;
      }

      if (kind === "string") {
        named[name] = value;
      } else {
        const existing = named[name];
        const list = Array.isArray(existing) ? [...existing] : [];
        list.push(value);
        named[name] = list;
      }
      index += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      throw new UsageError(`unknown flag "${token}"`);
    }

    positionals.push(token);
    index += 1;
  }

  if (positionals.length < names.length) {
    throw new UsageError(
      `expected ${names.length} argument(s) (${names.join(", ")}), received ${positionals.length}`,
    );
  }
  if (spec.variadic !== true && positionals.length > names.length) {
    throw new UsageError(`unexpected extra argument "${positionals[names.length] ?? ""}"`);
  }

  return { positionals, named };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.named[name];
  return typeof value === "string" ? value : undefined;
}

export function getBoolean(args: ParsedArgs, name: string): boolean {
  return args.named[name] === true;
}

export function getList(args: ParsedArgs, name: string): readonly string[] {
  const value = args.named[name];
  return Array.isArray(value) ? value : [];
}

/** A required string flag: missing or empty is a usage error, not a default. */
export function requireString(args: ParsedArgs, name: string): string {
  const value = getString(args, name);
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`flag "--${name}" is required`);
  }
  return value;
}
