/**
 * Model configuration.
 *
 * Stored at `~/.keystone/config.json`. It contains *references* to credentials,
 * never secrets: a config file is the thing users paste into issues and commit
 * to dotfiles, so a key in here is a key on the internet (PRD 11.3, ST-01).
 */

import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  nonEmptyStr,
  num,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "@keystone/schemas";

import { createOpenAiCompatibleAdapter } from "./openai.ts";
import type { CredentialResolver, ModelAdapter, ModelRole } from "./types.ts";

export const modelConfigEntrySchema = defineSchema(
  "keystone.config.model",
  "1.0.0",
  objectOf({
    id: str({ pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }),
    kind: enumOf(["cloud", "local"] as const),
    provider: nonEmptyStr(),
    modelName: nonEmptyStr(),
    /** Base URL including the version segment. Required for HTTP models. */
    baseUrl: optional(nonEmptyStr()),
    /** Handle of the credential in the credential store. Never the secret. */
    credentialHandle: optional(str({ pattern: /^[a-z0-9][a-z0-9._-]{1,63}$/ })),
    endpointHost: nonEmptyStr(),
    contextTokens: optional(int({ min: 1 })),
    /** Enabled by default; a disabled entry stays visible but is not routed. */
    enabled: bool(),
  }),
);

export const keystoneConfigSchema = defineSchema(
  "keystone.config",
  "1.0.0",
  objectOf({
    schemaVersion: nonEmptyStr(),
    /**
     * Presentation language ("zh-CN" | "en"). Optional and validated leniently
     * as a plain string: an unknown value falls through to the default rather
     * than making the whole config unreadable.
     */
    language: optional(str()),
    models: arrayOf(modelConfigEntrySchema.validator, { maxItems: 64 }),
    /** Role name -> ordered model ids. Unknown ids are dropped on load. */
    routes: optional(
      objectOf({
        builder: optional(arrayOf(nonEmptyStr(), { maxItems: 16 })),
        summarizer: optional(arrayOf(nonEmptyStr(), { maxItems: 16 })),
        planner: optional(arrayOf(nonEmptyStr(), { maxItems: 16 })),
      }),
    ),
    defaults: optional(
      objectOf({
        maxTokens: optional(int({ min: 1 })),
        maxWallClockMs: optional(int({ min: 1 })),
        maxRetries: optional(int({ min: 0 })),
        maxCostUsd: optional(num({ min: 0 })),
      }),
    ),
  }),
);

export type ModelConfigEntry = InferSchema<typeof modelConfigEntrySchema>;
export type KeystoneConfig = InferSchema<typeof keystoneConfigSchema>;

export function defaultConfig(): KeystoneConfig {
  return keystoneConfigSchema.parse({
    schemaVersion: "keystone.config@1.0.0",
    models: [],
    routes: {},
    defaults: { maxTokens: 300_000, maxWallClockMs: 7_200_000, maxRetries: 3 },
  });
}

export interface ConfigLocation {
  readonly configFile: string;
}

export async function loadConfig(location: ConfigLocation): Promise<KeystoneConfig> {
  const { readFile } = await import("node:fs/promises");
  try {
    const text = await readFile(location.configFile, "utf8");
    return keystoneConfigSchema.parse(JSON.parse(text));
  } catch (error) {
    if (isMissing(error)) return defaultConfig();
    throw error;
  }
}

export async function saveConfig(
  location: ConfigLocation,
  config: KeystoneConfig,
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(location.configFile), { recursive: true, mode: 0o700 });
  await writeFile(location.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Build a runtime adapter for a configured model.
 *
 * Both cloud and local HTTP endpoints go through the same OpenAI-compatible
 * client, because that is the interface local runtimes actually expose. A
 * genuinely offline model is injected by the caller instead (see
 * `createScriptedAdapter`), which keeps "fully offline" an explicit choice
 * rather than a mode that silently degrades.
 */
export function buildAdapter(
  entry: ModelConfigEntry,
  credentials: CredentialResolver,
): ModelAdapter {
  if (entry.baseUrl === undefined) {
    throw new Error(
      `model "${entry.id}" has no baseUrl; HTTP-served models must configure one`,
    );
  }
  return createOpenAiCompatibleAdapter({
    descriptor: {
      id: entry.id,
      kind: entry.kind,
      provider: entry.provider,
      modelName: entry.modelName,
      endpointHost: entry.endpointHost,
      capabilities: {
        tools: true,
        jsonMode: true,
        streaming: false,
        contextTokens: entry.contextTokens ?? 128_000,
      },
      ...(entry.credentialHandle === undefined ? {} : { credentialHandle: entry.credentialHandle }),
      dataEgress: {
        classes: entry.kind === "local" ? [] : ["internal"],
        local: entry.kind === "local",
      },
    },
    credentials,
    baseUrl: entry.baseUrl,
  });
}

/** Enabled entries only, in configuration order. */
export function enabledModels(config: KeystoneConfig): readonly ModelConfigEntry[] {
  return config.models.filter((entry) => entry.enabled);
}

export function routeFor(config: KeystoneConfig, role: ModelRole): readonly string[] {
  // `routes` is a plain record of role name -> ids; typed as a record here so a
  // future role cannot silently fall through to the default ordering unnoticed.
  const routes = config.routes as Record<string, readonly string[]> | undefined;
  const configured = routes?.[role] ?? [];
  const known = new Set(config.models.filter((entry) => entry.enabled).map((entry) => entry.id));
  const filtered = configured.filter((id: string) => known.has(id));
  if (filtered.length > 0) return filtered;
  // No explicit route: use enabled models in configuration order so a
  // single-model setup works without extra ceremony.
  return enabledModels(config).map((entry) => entry.id);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
