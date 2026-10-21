/**
 * `keystone model` — BYOK model configuration (PRD ST-01).
 *
 * Two safety rules are enforced here rather than trusted to the caller:
 *
 *  - The config file stores a credential *handle*, never a secret; a config is
 *    the file users paste into issues and commit to dotfiles.
 *  - `credential set` reads the secret from stdin, never from an argument, so it
 *    cannot land in shell history. The secret is written with mode 0600 and is
 *    never echoed back.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  enabledModels,
  keystoneConfigSchema,
  loadConfig,
  modelConfigEntrySchema,
  MODEL_PROTOCOLS,
  MODEL_ROLES,
  presetFor,
  routeFor,
  saveConfig,
  type KeystoneConfig,
  type ModelConfigEntry,
  type ModelRole,
} from "@keystone/models";

import { getBoolean, getString, parseArgs, requireString, UsageError } from "../args.ts";
import { createOutput } from "../output.ts";
import {
  parsePositiveInt,
  credentialsFor,
  pathsFor,
  translatorForContext,
  type CliContext,
  type CommandModule,
} from "./shared.ts";

function isRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

async function readConfig(context: CliContext): Promise<KeystoneConfig> {
  return loadConfig({ configFile: pathsFor(context).configFile });
}

async function runList(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, { flags: { json: "boolean", verbose: "boolean" } });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const config = await readConfig(context);
  const paths = pathsFor(context);
  const store = credentialsFor(context);
  const stored = new Set(
    (await store.listHandles()).filter((entry) => entry.present).map((entry) => entry.handle),
  );

  output.section(t("Models"));
  if (config.models.length === 0) output.line(`  ${t("none configured")}`);
  for (const model of config.models) {
    output.line(
      `  ${model.enabled ? `${t("[enabled]")} ` : t("[disabled]")} ${model.id} — ${model.kind} ` +
        `${model.provider}/${model.modelName} @ ${model.endpointHost}`,
    );
    const credential =
      model.credentialHandle === undefined
        ? t("(none)")
        : `${model.credentialHandle} ${
            stored.has(model.credentialHandle) ? t("(stored)") : t("(MISSING)")
          }`;
    output.line(`      ${t("credential:")} ${credential}`);
    output.detail(
      `protocol: ${model.protocol ?? "openai-chat"}; baseUrl: ${model.baseUrl ?? t("(none)")}; contextTokens: ${model.contextTokens ?? t("(default)")}`,
    );
  }

  output.section(t("Routes"));
  for (const role of MODEL_ROLES) {
    const ids = routeFor(config, role);
    output.line(`  ${role}: ${ids.length > 0 ? ids.join(" > ") : t("(none configured)")}`);
  }

  const local = config.models.filter((model) => model.kind === "local");
  const outbound = config.models.filter((model) => model.kind !== "local");
  output.section(t("Data egress"));
  output.line(
    `  ${t("stays on this machine (local):")} ${
      local.length > 0 ? local.map((m) => m.id).join(", ") : t("none")
    }`,
  );
  output.line(
    `  ${t("sends data out (cloud):")} ${
      outbound.length > 0 ? outbound.map((m) => `${m.id} -> ${m.endpointHost}`).join(", ") : t("none")
    }`,
  );

  output.json({
    models: config.models,
    routes: Object.fromEntries(MODEL_ROLES.map((role) => [role, routeFor(config, role)])),
    credentials: [...stored].sort(),
    egress: {
      local: local.map((model) => model.id),
      outbound: outbound.map((model) => ({ id: model.id, host: model.endpointHost })),
    },
  });
  return 0;
}

async function runAdd(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    flags: {
      id: "string",
      kind: "string",
      provider: "string",
      model: "string",
      protocol: "string",
      "base-url": "string",
      "endpoint-host": "string",
      "credential-handle": "string",
      "context-tokens": "string",
      json: "boolean",
      verbose: "boolean",
    },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const kind = requireString(args, "kind");
  if (kind !== "cloud" && kind !== "local") {
    throw new UsageError(`--kind must be "cloud" or "local", received "${kind}"`);
  }
  const credentialHandle = getString(args, "credential-handle");
  const contextTokens = parsePositiveInt(getString(args, "context-tokens"), "context-tokens");

  // A provider preset fills in the wire protocol, default base URL and host when
  // the user does not override them (ADR-0010 §2).
  const protocolRaw = getString(args, "protocol");
  if (protocolRaw !== undefined && !(MODEL_PROTOCOLS as readonly string[]).includes(protocolRaw)) {
    throw new UsageError(
      `--protocol must be one of ${MODEL_PROTOCOLS.join(" | ")}, received "${protocolRaw}"`,
    );
  }
  const protocol = protocolRaw;
  const preset = protocolRaw === undefined ? undefined : presetFor(protocolRaw);
  const provider = getString(args, "provider") ?? preset?.provider;
  if (provider === undefined) {
    throw new UsageError("--provider is required (or pass --protocol to use a provider preset)");
  }
  const baseUrl = getString(args, "base-url") ?? preset?.defaultBaseUrl;
  const endpointHost = getString(args, "endpoint-host") ?? preset?.endpointHost;
  if (baseUrl === undefined || endpointHost === undefined) {
    throw new UsageError(
      "--base-url and --endpoint-host are required for a custom provider (or pass --protocol)",
    );
  }

  const entry = modelConfigEntrySchema.parse({
    id: requireString(args, "id"),
    kind,
    provider,
    modelName: requireString(args, "model"),
    ...(protocol === undefined ? {} : { protocol }),
    baseUrl,
    endpointHost,
    ...(credentialHandle === undefined ? {} : { credentialHandle }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    enabled: true,
  }) as ModelConfigEntry;

  const config = await readConfig(context);
  const models = [...config.models.filter((model) => model.id !== entry.id), entry];
  const updated = keystoneConfigSchema.parse({ ...config, models }) as KeystoneConfig;
  await saveConfig({ configFile: pathsFor(context).configFile }, updated);

  output.line(
    t('Added model "{id}" ({kind} {provider}/{modelName} via {protocol}).', {
      id: entry.id,
      kind: entry.kind,
      provider: entry.provider,
      modelName: entry.modelName,
      protocol: entry.protocol ?? "openai-chat",
    }),
  );
  if (entry.kind !== "local") {
    output.line(t("Note: prompts and context will be sent to {host}.", { host: entry.endpointHost }));
  }
  output.json(entry);
  return 0;
}

async function runRoute(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["role", "modelId"],
    variadic: true,
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const role = args.positionals[0];
  const ids = args.positionals.slice(1);
  if (role === undefined || !isRole(role)) {
    throw new UsageError(`role must be one of ${MODEL_ROLES.join("|")}, received "${role ?? ""}"`);
  }
  if (ids.length === 0) throw new UsageError("at least one model id is required");

  const config = await readConfig(context);
  const known = new Set(enabledModels(config).map((model) => model.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new UsageError(`unknown or disabled model id(s): ${unknown.join(", ")}`);
  }

  const routes: Record<string, readonly string[]> = { ...(config.routes ?? {}) };
  routes[role] = [...ids];
  const updated = keystoneConfigSchema.parse({ ...config, routes }) as KeystoneConfig;
  await saveConfig({ configFile: pathsFor(context).configFile }, updated);

  output.line(t("route {role} = {models}", { role, models: ids.join(" > ") }));
  output.json({ role, models: ids });
  return 0;
}

async function readSecret(context: CliContext): Promise<string> {
  const source = context.stdin ?? process.stdin;
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("").replace(/\r?\n$/, "").trim();
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

async function runCredential(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const sub = argv[0];
  const rest = argv.slice(1);
  const paths = pathsFor(context);
  const store = credentialsFor(context);

  if (sub === "list") {
    const args = parseArgs(rest, { flags: { json: "boolean", verbose: "boolean" } });
    const output = createOutput({
      stdout: context.stdout,
      stderr: context.stderr,
      json: getBoolean(args, "json"),
      verbose: getBoolean(args, "verbose"),
    });
    const handles = await store.listHandles();
    output.section(t("Credentials"));
    if (handles.length === 0) output.line(`  ${t("none stored")}`);
    for (const entry of handles) {
      output.line(`  ${entry.handle} — ${entry.present ? t("stored") : t("unreadable")}`);
    }
    output.json(handles);
    return 0;
  }

  if (sub === "set") {
    const args = parseArgs(rest, {
      positionals: ["handle"],
      flags: { json: "boolean", verbose: "boolean" },
    });
    const output = createOutput({
      stdout: context.stdout,
      stderr: context.stderr,
      json: getBoolean(args, "json"),
      verbose: getBoolean(args, "verbose"),
    });
    const handle = args.positionals[0];
    if (handle === undefined) return 2;
    const secret = await readSecret(context);
    if (secret === "") {
      output.error(
        t("No secret was received on stdin. Pipe one in, e.g.: `echo -n $KEY | keystone model credential set <handle>`."),
      );
      return 1;
    }
    await store.set(handle, secret);
    const file = join(paths.credentialsDir, `${handle}.json`);
    const info = await stat(file).catch(() => undefined);
    const mode = info === undefined ? "broker" : modeString(info.mode);
    // Never echo the secret: only the handle and the file's permissions.
    output.line(
      t('Stored credential "{handle}" (file mode {mode}). The secret is never printed.', { handle, mode }),
    );
    output.json({ handle, stored: true, fileMode: mode });
    return 0;
  }

  throw new UsageError(`unknown subcommand "model credential ${sub ?? ""}"; expected "set" or "list"`);
}

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "list":
      return runList(rest, context);
    case "add":
      return runAdd(rest, context);
    case "route":
      return runRoute(rest, context);
    case "credential":
      return runCredential(rest, context);
    default:
      throw new UsageError(
        `unknown subcommand "model ${sub ?? ""}"; expected one of list, add, route, credential`,
      );
  }
}

export const command: CommandModule = {
  name: "model",
  summary: (t) => t("Configure BYOK models, routes and credentials"),
  usage: "keystone model <list|add|route|credential> ...",
  help: [
    "keystone model list",
    "  Show configured models, role routing and where data would be sent.",
    "",
    "keystone model add --id <id> --kind <cloud|local> --provider <p> --model <name> \\",
    "    [--protocol <openai-chat|openai-responses|anthropic-messages|gemini-generate>] \\",
    "    [--base-url <url> --endpoint-host <host>] [--credential-handle <h>] [--context-tokens <n>]",
    "  --protocol selects the provider wire surface and fills default base URL/host.",
    "",
    "keystone model route <builder|summarizer|planner> <modelId> [<modelId> ...]",
    "  Set the ordered fallback list for a role.",
    "",
    "keystone model credential set <handle>   # the secret is read from stdin",
    "keystone model credential list",
    "  macOS uses the native Keychain broker; other platforms use the private file",
    "  broker. Secrets are never printed. Legacy files require explicit migration.",
  ].join("\n"),
  run,
};
