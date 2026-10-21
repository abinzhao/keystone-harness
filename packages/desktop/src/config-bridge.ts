/**
 * Desktop onboarding bridge.
 *
 * This is the shell-private API the first-run wizard talks to (ADR-0008,
 * Decision B). It deliberately holds no secrets: it reads and writes the existing
 * `~/.keystone/config.json` (model *references* only) and the 0600 credential
 * store, and never projects a secret back to the page. A saved model appears the
 * way `keystone model add` / `keystone model credential set` would have written it,
 * so a restarted runtime child picks it up unchanged.
 */

import type { KeystonePaths } from "@keystone/kernel";
import {
  FileCredentialStore,
  loadConfig,
  saveConfig,
  type KeystoneConfig,
  type ModelConfigEntry,
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
  /** The credential handle, never the secret. */
  readonly credentialHandle: string | null;
}

export interface ConnectionTest {
  readonly ok: boolean;
  readonly error?: string;
}

export interface SaveModelInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelName: string;
  readonly provider?: string;
  /** Wire protocol; defaults to openai-chat when omitted (ADR-0010). */
  readonly protocol?: string;
}

export interface SaveModelResult {
  readonly ok: boolean;
  readonly modelId: string;
}

export class DesktopConfigBridge {
  private readonly paths: KeystonePaths;

  constructor(options: { readonly paths: KeystonePaths }) {
    this.paths = options.paths;
  }

  private credentials(): FileCredentialStore {
    return new FileCredentialStore({ credentialsDir: this.paths.credentialsDir });
  }

  async bootstrap(): Promise<BootstrapInfo> {
    const config = await loadConfig({ configFile: this.paths.configFile });
    const hasModel = config.models.some((entry) => entry.enabled);
    return { shell: true, hasModel, configured: hasModel };
  }

  async listModels(): Promise<{ models: readonly ModelSummary[] }> {
    const config = await loadConfig({ configFile: this.paths.configFile });
    return {
      models: config.models.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        provider: entry.provider,
        modelName: entry.modelName,
        baseUrl: entry.baseUrl ?? "",
        enabled: entry.enabled,
        credentialHandle: entry.credentialHandle ?? null,
      })),
    };
  }

  /**
   * Validate the endpoint the user typed without persisting anything.
   *
   * An OpenAI-compatible server exposes `GET {baseUrl}/models`; a 2xx means the
   * host is reachable and the key is accepted, a 401 means the key is wrong, and a
   * network error means the host is down or unreachable. We do not run a
   * completion here: that would spend tokens and add latency to a "does it
   * connect?" check.
   */
  async testConnection(input: {
    readonly baseUrl: string;
    readonly apiKey: string;
  }): Promise<ConnectionTest> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: input.apiKey === "" ? {} : { authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "the endpoint rejected the API key (unauthorized)" };
      }
      return { ok: false, error: `the endpoint responded with HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        error: `could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async saveModel(input: SaveModelInput): Promise<SaveModelResult> {
    if (input.baseUrl.trim() === "" || input.modelName.trim() === "") {
      throw new Error("baseUrl and modelName are required");
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const url = new URL(baseUrl);
    const kind: "cloud" | "local" =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "local" : "cloud";
    const provider = input.provider?.trim() || (kind === "local" ? "local" : "openai");
    const slug = slugify(`${provider}-${input.modelName}`);
    const handle = `byok-${slug}`;

    // The secret goes to the 0600 credential store; the config keeps only the
    // handle reference (PRD 11.3, ADR-0008 Decision C).
    await this.credentials().set(handle, input.apiKey);

    const config = await loadConfig({ configFile: this.paths.configFile });
    const entry: ModelConfigEntry = {
      id: slug,
      kind,
      provider,
      modelName: input.modelName.trim(),
      ...(input.protocol === undefined ? {} : { protocol: input.protocol as never }),
      baseUrl,
      endpointHost: url.host,
      credentialHandle: handle,
      enabled: true,
    };
    // `models` is read-only in the parsed shape, so produce a next config object
    // rather than mutating the loaded one.
    const models: ModelConfigEntry[] = [...config.models];
    const index = models.findIndex((existing) => existing.id === entry.id);
    if (index === -1) models.push(entry);
    else models[index] = entry;
    // A single-model first-run routes every role through the new model.
    const next: KeystoneConfig = {
      ...config,
      models,
      routes: { builder: [slug], summarizer: [slug], planner: [slug] },
    };
    await saveConfig({ configFile: this.paths.configFile }, next);
    return { ok: true, modelId: slug };
  }
}

/** Trim a trailing slash so `${baseUrl}/models` never doubles one. */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("baseUrl must start with http:// or https://");
  }
  return trimmed.replace(/\/+$/, "");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "model" : slug;
}
