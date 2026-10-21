/**
 * Provider presets and the capability matrix (ADR-0010 §2).
 *
 * This is the single source that says, for each wire protocol, which base URL to
 * default to and which capabilities the adapter actually implements. The CLI and
 * desktop onboarding both read it so a user picking "Anthropic" gets the right
 * host, auth header, and an honest capability block — not a guessed OpenAI shape.
 */

import type { ModelDescriptor } from "@keystone/schemas";

export const MODEL_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate",
] as const;

export type ProviderPreset = {
  readonly protocol: (typeof MODEL_PROTOCOLS)[number];
  /** Short provider label used as the default `provider` field. */
  readonly provider: string;
  readonly defaultBaseUrl: string;
  readonly endpointHost: string;
  readonly kind: "cloud" | "local";
  readonly capabilities: ModelDescriptor["capabilities"];
};

function caps(cap: {
  readonly nativeTools: boolean;
  readonly structuredOutput: boolean;
  readonly contextTokens: number;
}): ModelDescriptor["capabilities"] {
  return {
    nativeTools: cap.nativeTools,
    structuredOutput: cap.structuredOutput,
    streaming: false,
    multimodal: false,
    contextTokens: cap.contextTokens,
  };
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    protocol: "openai-chat",
    provider: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    endpointHost: "api.openai.com",
    kind: "cloud",
    capabilities: caps({ nativeTools: false, structuredOutput: true, contextTokens: 128_000 }),
  },
  {
    protocol: "openai-responses",
    provider: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    endpointHost: "api.openai.com",
    kind: "cloud",
    capabilities: caps({ nativeTools: true, structuredOutput: true, contextTokens: 128_000 }),
  },
  {
    protocol: "anthropic-messages",
    provider: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    endpointHost: "api.anthropic.com",
    kind: "cloud",
    capabilities: caps({ nativeTools: true, structuredOutput: false, contextTokens: 200_000 }),
  },
  {
    protocol: "gemini-generate",
    provider: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    endpointHost: "generativelanguage.googleapis.com",
    kind: "cloud",
    capabilities: caps({ nativeTools: true, structuredOutput: true, contextTokens: 1_000_000 }),
  },
];

export function presetFor(protocol: string): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((entry) => entry.protocol === protocol);
  if (preset === undefined) {
    throw new Error(`unknown model protocol "${protocol}"`);
  }
  return preset;
}
