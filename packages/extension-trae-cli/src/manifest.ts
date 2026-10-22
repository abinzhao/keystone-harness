import { TraeCliError } from "./errors.ts";
import { safeHost } from "./gateway.ts";

export const TRAE_CLI_EXTENSION_NAME = "keystone-trae-cli";
export const TRAE_CLI_EXTENSION_VERSION = "1.0.0";

export function createTraeCliManifest(input: { digest: string; egressHosts: readonly string[] }) {
  if (!/^[a-f0-9]{64}$/.test(input.digest) || /^0+$/.test(input.digest) || !input.egressHosts.length ||
      input.egressHosts.length > 10 || input.egressHosts.some((host) => !safeHost(host))) throw new TraeCliError("configuration");
  return {
    name: TRAE_CLI_EXTENSION_NAME, version: TRAE_CLI_EXTENSION_VERSION, publisher: "Keystone",
    integrity: { algorithm: "sha256" as const, digest: input.digest }, kind: "model" as const, apiVersion: "1.6",
    capabilities: ["model.invoke", "cmd.exec"] as const,
    sideEffects: [
      { kind: "fs_read" as const, scope: "Public executable and isolated per-call data only; no project or user home." },
      { kind: "fs_write" as const, scope: "Private transport setup and cleanup only." },
      { kind: "process_spawn" as const, scope: "Exact parameter-bound macOS sandbox launcher and CLI." },
      { kind: "network" as const, scope: "Explicit public HTTPS DNS destinations through bounded CONNECT/SNI gateway." },
    ],
    reversibility: "reversible" as const, egressHosts: [...input.egressHosts], credentialHandles: [],
    dataClassification: {
      reads: "sensitive" as const,
      egress: input.egressHosts.flatMap((host) => (["public", "internal", "sensitive"] as const)
        .map((dataClass) => ({ dataClass, destination: host, purpose: "User-authorized model context." }))),
    },
    produces: { observations: ["model.response", "model.usage", "transport.compatibility"], evidenceTypes: [] },
    execution: { replayable: false, idempotent: false }, dependencies: [], conflicts: [],
    uninstall: "safe" as const, entry: { module: "./src/index.ts", export: "createTraeCliAdapter" },
    description: "Inactive until reviewed. No credentials are copied. Authentication and live generation remain separate checks; unsupported versions and confinement fail closed.",
  };
}
