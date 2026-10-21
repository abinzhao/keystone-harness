/**
 * Shared plumbing for the CLI commands.
 *
 * Everything here is a thin adapter over the kernel and the runtime: resolving
 * the store root, reading a task's workspace, and normalising `git status`.
 * The CLI holds no state of its own — these helpers are the only places that
 * reach the filesystem on a command's behalf.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DEFAULT_LANGUAGE, translatorFor, type Language, type Translator } from "@keystone/i18n";
import {
  KEYSTONE_HOME_ENV,
  readTextFile,
  resolveKeystonePaths,
  type KeystonePaths,
} from "@keystone/kernel";
import type { Budget, ProjectId, RunEvent, TaskId } from "@keystone/schemas";
import { createCredentialBroker, type CredentialBroker, type KeystoneConfig } from "@keystone/models";

import { UsageError } from "../args.ts";

const exec = promisify(execFile);

export interface WriteStream {
  write(chunk: string): unknown;
}

/**
 * What a command is given to run against. `stdin` is optional so tests can
 * inject input for `credential set` without a pseudo-terminal; when absent the
 * command falls back to `process.stdin`.
 */
export interface CliContext {
  readonly stdout: WriteStream;
  readonly stderr: WriteStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** True only when the caller has an interactive terminal. */
  readonly isTTY: boolean;
  readonly stdin?: AsyncIterable<string | Uint8Array>;
  readonly credentials?: CredentialBroker;
  /**
   * The presentation language, resolved once by `runCli` from `--lang`,
   * `KEYSTONE_LANG` and `config.json`. Optional so tests and embedders can omit
   * it; when absent, output falls back to the shipped default (Chinese).
   */
  readonly language?: Language;
}

/** The translator a command should word its output with. */
export function translatorForContext(context: CliContext): Translator {
  return translatorFor(context.language ?? DEFAULT_LANGUAGE);
}

export interface CommandModule {
  readonly name: string;
  /** One line shown in `keystone --help`, localised. */
  readonly summary: (t: Translator) => string;
  /** A machine-shaped synopsis; not shown to users, so it stays English. */
  readonly usage: string;
  /**
   * The `--help` body. Left in English on purpose: it documents flags and syntax
   * whose names are English identifiers, in aligned columns that translation
   * would misalign. Runtime output is localised; the flag reference is not.
   */
  readonly help: string;
  readonly run: (argv: readonly string[], context: CliContext) => Promise<number>;
}

export function pathsFor(context: CliContext): KeystonePaths {
  const override = context.env[KEYSTONE_HOME_ENV];
  return resolveKeystonePaths(override === undefined || override === "" ? undefined : override);
}

export function credentialsFor(context: CliContext): CredentialBroker {
  return context.credentials ?? createCredentialBroker({ credentialsDir: pathsFor(context).credentialsDir });
}

/**
 * The workspace a task was attached to. Read from the project record rather than
 * guessed, so `resume`/`proof` compare against the same directory the run used.
 */
export async function readWorkspaceRoot(
  paths: KeystonePaths,
  projectId: ProjectId,
): Promise<string | undefined> {
  const text = await readTextFile(paths.projectFile(projectId));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { rootPath?: unknown };
    return typeof parsed.rootPath === "string" && parsed.rootPath !== "" ? parsed.rootPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Changed paths from `git status --porcelain`, or `undefined` when git is not
 * available in that workspace. `undefined` is distinct from `[]`: the caller
 * must say "changes could not be detected", not "nothing changed".
 */
export async function gitChangedPaths(rootPath: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", rootPath, "status", "--porcelain"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return parsePorcelain(String(stdout));
  } catch {
    return undefined;
  }
}

function parsePorcelain(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    // `XY path`, except renames/copies which are `XY old -> new`.
    const rest = line.slice(3);
    const arrow = rest.lastIndexOf(" -> ");
    const path = arrow === -1 ? rest : rest.slice(arrow + 4);
    const cleaned = path.trim().replace(/^"|"$/g, "");
    if (cleaned !== "") paths.add(cleaned);
  }
  return [...paths].sort();
}

/** Paths the run actually changed, folded from its ledger events. */
export function collectChangedPaths(events: readonly RunEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "action.executed") continue;
    const changed = event.payload["changedPaths"];
    if (!Array.isArray(changed)) continue;
    for (const path of changed) if (typeof path === "string") paths.add(path);
  }
  return [...paths].sort();
}

export function budgetFrom(config: KeystoneConfig): Budget {
  const defaults = config.defaults;
  return {
    maxTokens: defaults?.maxTokens ?? 300_000,
    maxWallClockMs: defaults?.maxWallClockMs ?? 7_200_000,
    maxRetries: defaults?.maxRetries ?? 3,
    ...(defaults?.maxCostUsd === undefined ? {} : { maxCostUsd: defaults.maxCostUsd }),
  };
}

export function toTaskId(value: string): TaskId {
  return value as TaskId;
}

export function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${flag} must be a positive integer, received "${value}"`);
  }
  return parsed;
}
