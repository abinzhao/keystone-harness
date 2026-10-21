import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withLock, writeFileAtomic, type KeystonePaths } from "@keystone/kernel";
import {
  buildAdapter, createCredentialBroker, validateConfigUpdate, loadConfig, saveConfig,
  type KeystoneConfig, type CredentialResolver,
} from "@keystone/models";
import { bool, contentHash, defineSchema, enumOf, int, objectOf, optional, type InferSchema } from "@keystone/schemas";

const presentationSchema = defineSchema("keystone.workbench.presentation", "1.0.0", objectOf({
  theme: enumOf(["system", "light", "dark"] as const),
  density: enumOf(["comfortable", "compact"] as const),
  notifications: optional(bool()),
  retentionDays: optional(int({ min: 1, max: 3650 })),
}));
type Presentation = InferSchema<typeof presentationSchema>;

export class SettingsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "SettingsError"; this.status = status; }
}

export interface SettingsProjection {
  readonly revision: string;
  readonly config: KeystoneConfig;
  readonly presentation: Presentation;
  readonly source: string;
  readonly effective: { readonly models: "subsequent_tasks"; readonly execution: "task_contract"; readonly credentials: "write_only_broker"; readonly isolation: "application_guards" };
}

export class SettingsStore {
  private readonly paths: KeystonePaths;
  constructor(paths: KeystonePaths) { this.paths = paths; }
  private preferencesFile(): string { return join(this.paths.home, "presentation.json"); }
  async read(): Promise<SettingsProjection> {
    const config = await loadConfig(this.paths);
    let presentation: Presentation = { theme: "system", density: "comfortable", notifications: false, retentionDays: 90 };
    try { presentation = presentationSchema.parse(JSON.parse(await readFile(this.preferencesFile(), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return {
      revision: contentHash({ config, presentation }), config, presentation, source: this.paths.configFile,
      effective: { models: "subsequent_tasks", execution: "task_contract", credentials: "write_only_broker", isolation: "application_guards" },
    };
  }
  async save(input: { revision: string; config?: unknown; presentation?: unknown }): Promise<SettingsProjection> {
    return withLock(join(this.paths.home, "settings.lock"), {}, async () => {
      const current = await this.read();
      if (input.revision !== current.revision) throw new SettingsError(409, "settings changed; reload before saving");
      let config: KeystoneConfig;
      let presentation: Presentation;
      try {
        rejectSecretFields(input.config);
        config = input.config === undefined ? current.config : validateConfigUpdate(input.config);
        const ids = config.models.map((entry) => entry.id);
        if (new Set(ids).size !== ids.length) throw new Error("duplicate model IDs");
        for (const role of Object.values(config.routes ?? {})) {
          if (role?.some((id) => !ids.includes(id))) throw new Error("route names an unknown model");
        }
        presentation = input.presentation === undefined ? current.presentation : presentationSchema.parse({
          ...current.presentation, ...input.presentation as object,
        });
      } catch {
        throw new SettingsError(400, "invalid settings; credentials must use the write-only broker");
      }
      await saveConfig(this.paths, config);
      await writeFileAtomic(this.preferencesFile(), JSON.stringify(presentation));
      return this.read();
    });
  }
  async probe(input: { id: string; kind: string }, credentials?: CredentialResolver): Promise<Record<string, unknown>> {
    const config = (await this.read()).config;
    const entry = config.models.find((model) => model.id === input.id);
    if (entry === undefined || entry.baseUrl === undefined) throw new SettingsError(404, "configured model not found");
    if (!["discovery", "connection", "generation"].includes(input.kind)) throw new SettingsError(400, "unknown probe kind");
    const broker = credentials ?? createCredentialBroker({ credentialsDir: this.paths.credentialsDir });
    try {
      if (input.kind === "generation") {
        const response = await buildAdapter(entry, broker).complete({
          messages: [{ role: "user", content: "Reply with OK." }], tools: [], jsonMode: false,
          maxTokens: 32, signal: AbortSignal.timeout(15_000),
        });
        return { ok: true, kind: input.kind, modelId: entry.id, endpointHost: entry.endpointHost, usage: response.usage, finishReason: response.finishReason };
      }
      const secret = entry.credentialHandle === undefined ? undefined : await broker.resolve(entry.credentialHandle);
      const headers: Record<string, string> = {};
      if (entry.protocol === "anthropic-messages") {
        headers["anthropic-version"] = "2023-06-01";
        if (secret) headers["x-api-key"] = secret;
      } else if (entry.protocol === "gemini-generate") {
        if (secret) headers["x-goog-api-key"] = secret;
      } else if (secret) headers["authorization"] = `Bearer ${secret}`;
      const response = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/models`, {
        headers, signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      return { ok: response.ok, kind: input.kind, status: response.status, modelId: entry.id, endpointHost: entry.endpointHost,
        ...(response.ok ? {} : { error: `discovery returned HTTP ${response.status}; generation was not tested` }) };
    } catch {
      // Provider errors may echo headers/prompts. Projections never include them.
      return { ok: false, kind: input.kind, modelId: entry.id, endpointHost: entry.endpointHost, error: "probe failed; check protocol, endpoint and credential availability" };
    }
  }
}

function rejectSecretFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(apiKey|accessToken|refreshToken|password|secret|privateKey)$/i.test(key)) throw new Error("secret in config");
    rejectSecretFields(item);
  }
}
