/**
 * How a verifier decides *which* command to run.
 *
 * The rule is deliberately narrow: use a command the contract named, or a
 * script the project already declares — never invent one. A guessed command
 * would produce evidence about something the user never asked to check, which
 * PRD PI-01 (item 4) forbids ("未识别的命令标记为未识别，不使用猜测值替代").
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CompletionCondition } from "@keystone/schemas";

import type { VerifierContext } from "./types.ts";

export type PackageManager = "pnpm" | "yarn" | "npm";

/** Lockfile presence is the only signal used; each maps to its runner. */
const LOCKFILE_MANAGERS: readonly (readonly [string, PackageManager])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * Returns the package manager the project uses, or `undefined` when no known
 * lockfile exists. `undefined` means "could not determine", and callers must
 * treat that as blocked rather than defaulting to a guess.
 */
export function detectPackageManager(rootPath: string): PackageManager | undefined {
  for (const [file, manager] of LOCKFILE_MANAGERS) {
    if (existsSync(join(rootPath, file))) return manager;
  }
  return undefined;
}

/** Read one entry from `package.json#scripts`. Missing files are not an error. */
export async function readPackageScript(
  rootPath: string,
  scriptName: string,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, "package.json"), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;

  const value = (scripts as Record<string, unknown>)[scriptName];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function runScriptCommand(manager: PackageManager, scriptName: string): string {
  return `${manager} run ${scriptName}`;
}

/**
 * The command a condition asked for, when it named one. Only the first
 * condition that supplies a command is used; a later one would be a second,
 * unreported command.
 */
export function conditionCommand(
  conditions: readonly CompletionCondition[],
): string | undefined {
  for (const condition of conditions) {
    const params = condition.verifier.params as Record<string, unknown> | undefined;
    if (params === undefined) continue;
    const command = params["command"];
    if (typeof command === "string" && command.trim() !== "") return command;
  }
  return undefined;
}

/**
 * Shared resolution for the script-backed verifiers (test / lint / build): an
 * explicit command named by the contract, then a declared npm script run
 * through the project's own manager, then nothing. Never a guessed command.
 */
export async function resolveScriptCommand(
  ctx: VerifierContext,
  scriptName: string,
): Promise<string | undefined> {
  const explicit = conditionCommand(ctx.conditions);
  if (explicit !== undefined) return explicit;

  const script = await readPackageScript(ctx.rootPath, scriptName);
  if (script === undefined) return undefined;
  const manager = detectPackageManager(ctx.rootPath);
  if (manager === undefined) return undefined;
  return runScriptCommand(manager, scriptName);
}
