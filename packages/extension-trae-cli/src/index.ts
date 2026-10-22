export { createTraeCliAdapter, probeTraeCli, discoverTraeCliModels } from "./adapter.ts";
export type { TraeCliAdapter } from "./adapter.ts";
export { createTraeCliManifest, TRAE_CLI_EXTENSION_NAME, TRAE_CLI_EXTENSION_VERSION } from "./manifest.ts";
export { TraeCliError } from "./errors.ts";
export type { TraeCliErrorCode } from "./errors.ts";
export { transportPolicy } from "./transport.ts";
export type {
  AuthorizeTransport, CompatibilityResult, ProbeOptions, TraeCliModelOptions,
  TraeCliOptions, TraeCliRequest, TraeCliResponse, TransportLease, TransportLimits, TransportParameters,
  TransportPolicy, TransportProposal,
} from "./types.ts";
export type { DiscoveredModel, MeasuredUsage } from "./codec.ts";
