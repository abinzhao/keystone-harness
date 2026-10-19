/**
 * `keystone doctor` — one screen that answers "why is this not working?".
 *
 * It reports the environment facts the rest of the CLI depends on (Node, the
 * store root, git, models, the tool/verifier registries and the protocol
 * schemas) and, for anything wrong, an executable next step (PRD 12.3). It only
 * fails (exit 1) when a critical prerequisite is missing — an unusable store or
 * an unsupported Node version — so it stays usable as a diagnostic.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { enabledModels, loadConfig } from "@keystone/models";
import { listSchemas } from "@keystone/schemas";
import { TOOL_IDS } from "@keystone/tools";
import { VERIFIER_IDS } from "@keystone/verifiers";

import { getBoolean, parseArgs } from "../args.ts";
import { createOutput } from "../output.ts";
import { pathsFor, translatorForContext, type CliContext, type CommandModule } from "./shared.ts";

const exec = promisify(execFile);

const MIN_NODE = [22, 18, 0] as const;

function parseVersion(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return [0, 0, 0];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function atLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const a = actual[index] ?? 0;
    const b = minimum[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

async function gitVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["--version"]);
    return String(stdout).trim();
  } catch {
    return undefined;
  }
}

async function homeWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function configExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, { flags: { json: "boolean", verbose: "boolean" } });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const paths = pathsFor(context);
  const nodeVersion = process.version;
  const nodeSupported = atLeast(parseVersion(nodeVersion), MIN_NODE);
  const writable = await homeWritable(paths.home);
  const git = await gitVersion();
  const hasConfig = await configExists(paths.configFile);
  const config = await loadConfig({ configFile: paths.configFile });
  const usableModels = enabledModels(config).length;
  const schemaCount = listSchemas().length;

  const homeEnv = context.env["KEYSTONE_HOME"] ?? t("(not set)");

  output.section(t("Environment"));
  output.keyValue({
    [t("node")]: `${nodeVersion} ${
      nodeSupported ? t("(ok)") : t("(requires >= {version})", { version: MIN_NODE.join(".") })
    }`,
    [t("KEYSTONE_HOME")]: homeEnv,
    [t("home")]: paths.home,
    [t("writable")]: writable ? t("yes") : t("no"),
  });
  if (!nodeSupported) {
    output.error(
      t("Node {required} or newer is required; this is {actual}. Upgrade Node, then re-run.", {
        required: MIN_NODE.join("."),
        actual: nodeVersion,
      }),
    );
  }
  if (!writable) {
    output.error(
      t("The store root is not writable: {path}. Fix permissions or set KEYSTONE_HOME to a writable directory.", {
        path: paths.home,
      }),
    );
  }

  output.section(t("Git"));
  output.keyValue({ [t("git")]: git ?? t("not found") });
  if (git === undefined) {
    output.error(
      t("git was not found on PATH. Keystone requires a Git work tree for recovery, branching and evidence."),
    );
  }

  output.section(t("Models"));
  output.keyValue({
    [t("config")]: hasConfig ? paths.configFile : t("(none — run `keystone model add ...`)"),
    [t("usable models")]: usableModels,
  });
  if (usableModels === 0) {
    output.error(
      t("No model is configured. Run `keystone model add ...` then `keystone model credential set <handle>` (BYOK)."),
    );
  }

  output.section(t("Registry"));
  output.keyValue({
    [t("tools")]: TOOL_IDS.length,
    [t("verifiers")]: VERIFIER_IDS.length,
    [t("protocol schemas")]: schemaCount,
  });
  output.detail(t("tools: {list}", { list: TOOL_IDS.join(", ") }));
  output.detail(t("verifiers: {list}", { list: VERIFIER_IDS.join(", ") }));

  output.json({
    node: { version: nodeVersion, supported: nodeSupported, minimum: MIN_NODE.join(".") },
    home: { path: paths.home, writable },
    git: git ?? null,
    models: { configPresent: hasConfig, usable: usableModels },
    registry: { tools: [...TOOL_IDS], verifiers: [...VERIFIER_IDS], schemas: schemaCount },
  });

  return nodeSupported && writable ? 0 : 1;
}

export const command: CommandModule = {
  name: "doctor",
  summary: (t) => t("Diagnose the CLI's environment and configuration"),
  usage: "keystone doctor [--json]",
  help: [
    "keystone doctor",
    "",
    "  Check Node, the store root, git, configured models, the tool/verifier",
    "  registries and the protocol schema count. Any problem comes with a fix.",
  ].join("\n"),
  run,
};
