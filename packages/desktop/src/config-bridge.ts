/**
 * Shell-private model settings. Config contains references only; credential
 * writes use fresh handles so active task snapshots retain their old secrets.
 * The runtime applies the latest config on subsequent tasks, never by restart.
 */
import { randomUUID } from "node:crypto";
import type { KeystonePaths } from "@keystone/kernel";
import {
  buildAdapter, ConfigConflictError, createCredentialBroker, FileCredentialStore,
  loadConfigSnapshot, migrateLegacyCredential, normalizeModelEndpoint, presetFor,
  saveConfigSnapshot, stableModelId, validateConfigUpdate,
  type CredentialBroker, type FetchLike, type ModelConfigEntry, type ModelProtocol,
} from "@keystone/models";

export interface BootstrapInfo {
  readonly shell: true;
  readonly hasModel: boolean;
  readonly configured: boolean;
}

export interface ModelSummary {
  readonly id: string;
  readonly kind: "cloud" | "local";
  readonly provider: string;
  readonly modelName: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly protocol: ModelProtocol;
  readonly multimodal: boolean;
  readonly credentialHandle: string | null;
}

export interface ConnectionTest {
  readonly ok: boolean;
  readonly models?: readonly string[];
  readonly error?: string;
}

export interface ConnectionInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly protocol?: ModelProtocol;
}

export interface SaveModelInput extends ConnectionInput {
  readonly modelName: string;
  readonly provider?: string;
  readonly multimodal?: boolean;
  /** File revision from /desktop/config, not the combined /v1/settings revision. */
  readonly revision?: string;
}

export interface SaveModelResult {
  readonly ok: true;
  readonly modelId: string;
  readonly revision: string;
}

export interface DesktopConfigBridgeOptions {
  readonly paths: KeystonePaths;
  readonly credentials?: CredentialBroker;
  readonly legacyCredentials?: CredentialBroker;
  readonly fetchImpl?: FetchLike;
}

export class DesktopConfigBridge {
  private readonly paths: KeystonePaths;
  private readonly credentials: CredentialBroker;
  private readonly legacyCredentials: CredentialBroker;
  private readonly fetchImpl: FetchLike;
  private readonly migrationAvailable: boolean;

  constructor(options: DesktopConfigBridgeOptions) {
    this.paths = options.paths;
    this.credentials = options.credentials ?? createCredentialBroker({ credentialsDir: this.paths.credentialsDir });
    this.legacyCredentials = options.legacyCredentials ?? new FileCredentialStore({ credentialsDir: this.paths.credentialsDir });
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.migrationAvailable = options.legacyCredentials !== undefined || !(this.credentials instanceof FileCredentialStore);
  }

  async bootstrap(): Promise<BootstrapInfo> {
    const { config } = await loadConfigSnapshot(this.paths);
    const hasModel = config.models.some((entry) => entry.enabled);
    return { shell: true, hasModel, configured: hasModel };
  }

  async listModels(): Promise<{ revision: string; models: readonly ModelSummary[] }> {
    const { revision, config } = await loadConfigSnapshot(this.paths);
    return { revision, models: config.models.map((entry) => ({
      id: entry.id, kind: entry.kind, provider: entry.provider, modelName: entry.modelName,
      baseUrl: entry.baseUrl ?? "", enabled: entry.enabled,
      protocol: entry.protocol ?? "openai-chat", multimodal: entry.multimodal ?? false,
      credentialHandle: entry.credentialHandle ?? null,
    })) };
  }

  /** Discovery proves discovery only; it never makes a token-spending completion. */
  async testConnection(input: ConnectionInput): Promise<ConnectionTest> {
    try {
      const baseUrl = normalizeModelEndpoint(input.baseUrl);
      const protocol = presetFor(input.protocol ?? "openai-chat").protocol;
      const headers: Record<string, string> = {};
      if (protocol === "anthropic-messages") {
        headers["anthropic-version"] = "2023-06-01";
        if (input.apiKey) headers["x-api-key"] = input.apiKey;
      } else if (input.apiKey) {
        headers[protocol === "gemini-generate" ? "x-goog-api-key" : "authorization"] =
          protocol === "gemini-generate" ? input.apiKey : `Bearer ${input.apiKey}`;
      }
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: "GET", headers, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { ok: false, error: response.status === 401 || response.status === 403
          ? "the endpoint rejected the API key (unauthorized)"
          : `model discovery responded with HTTP ${response.status}; generation was not tested` };
      }
      const body: unknown = await response.json();
      const values = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)[protocol === "gemini-generate" ? "models" : "data"] : undefined;
      if (!Array.isArray(values)) return { ok: false, error: "unrecognized model discovery response; generation was not tested" };
      const models = values.flatMap((value: unknown) => {
        if (typeof value !== "object" || value === null) return [];
        const name = (value as Record<string, unknown>)[protocol === "gemini-generate" ? "name" : "id"];
        return typeof name === "string" && !(input.apiKey && name.includes(input.apiKey))
          ? [protocol === "gemini-generate" ? name.replace(/^models\//, "") : name] : [];
      });
      return { ok: true, models };
    } catch { return { ok: false, error: "could not discover models; check endpoint, protocol and connectivity" }; }
  }

  /** A separate, explicit user action; output is not projected back as trusted text. */
  async testGeneration(input: SaveModelInput): Promise<ConnectionTest> {
    try {
      const entry = modelEntry(input);
      const adapter = buildAdapter({ ...entry, credentialHandle: "connection-test" },
        { async resolve() { return input.apiKey ?? ""; } }, { fetchImpl: this.fetchImpl, timeoutMs: 20_000 });
      const response = await adapter.complete({ messages: [{ role: "user", content: "Reply with OK." }],
        tools: [], jsonMode: false, maxTokens: 16 });
      if (response.text.trim() === "") return { ok: false, error: "generation returned no text; capability was not verified" };
      return { ok: true };
    } catch { return { ok: false, error: "generation failed; check model, endpoint, protocol and credential" }; }
  }

  async saveModel(input: SaveModelInput): Promise<SaveModelResult> {
    const proposed = modelEntry(input);
    const current = await loadConfigSnapshot(this.paths);
    if (input.revision !== undefined && input.revision !== current.revision) {
      throw new ConfigConflictError(current.revision);
    }
    const existing = current.config.models.find((entry) => entry.baseUrl !== undefined &&
      stableModelId({ ...entry, baseUrl: entry.baseUrl }) === proposed.id);
    const id = existing?.id ?? proposed.id;
    const replaceSecret = input.apiKey !== undefined || existing?.credentialHandle === undefined;
    const handle = replaceSecret ? `byok-${randomUUID()}` : existing!.credentialHandle!;
    const entry: ModelConfigEntry = { ...existing, ...proposed, id, credentialHandle: handle,
      ...(input.multimodal === undefined && existing ? { multimodal: existing.multimodal ?? false } : {}) };
    const models = [...current.config.models];
    const index = models.findIndex((value) => value.id === id);
    if (index < 0) models.push(entry); else models[index] = entry;
    const config = validateConfigUpdate({ ...current.config, schemaVersion: "keystone.config@2.1.0", models,
      routes: current.config.models.length === 0
        ? { builder: [id], summarizer: [id], planner: [id] } : current.config.routes });
    if (replaceSecret) await this.credentials.set(handle, input.apiKey ?? "");
    try {
      const saved = await saveConfigSnapshot(this.paths, { revision: current.revision, config });
      return { ok: true, modelId: id, revision: saved.revision };
    } catch (error) {
      // Fresh handles are not referenced by active tasks or another config.
      if (replaceSecret) await this.credentials.delete(handle);
      throw error;
    }
  }

  async migrateCredential(input: {
    readonly handle: string; readonly confirmed: boolean; readonly removeSource?: boolean;
  }): Promise<{ ok: true }> {
    if (input.confirmed !== true) throw new Error("legacy credential migration requires explicit confirmation");
    if (!this.migrationAvailable) throw new Error("credential migration is unavailable for the default file-backed store");
    await migrateLegacyCredential(this.legacyCredentials, this.credentials, input.handle, input);
    return { ok: true };
  }
}

function modelEntry(input: SaveModelInput): ModelConfigEntry {
  const baseUrl = normalizeModelEndpoint(input.baseUrl);
  const protocol = presetFor(input.protocol ?? "openai-chat").protocol;
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return {
    id: stableModelId({ ...input, baseUrl, protocol }), baseUrl, protocol,
    kind: local ? "local" : "cloud", endpointHost: url.host,
    provider: input.provider?.trim() || (local ? "local" : presetFor(protocol).provider),
    modelName: input.modelName.trim(), enabled: true, multimodal: input.multimodal ?? false,
  };
}
