/**
 * The extension's declaration.
 *
 * Copied from the sibling reference extension: the manifest states what the
 * extension may touch *before* it runs, and this one asks for the least it can —
 * read-only file access, no network, no credentials (PRD PL-01, 11.4). The
 * integrity digest is computed from the entry module's bytes rather than typed
 * by hand, so the manifest cannot describe a different file than the one that
 * will run (NFR-COMP-05).
 */

import { readFile } from "node:fs/promises";

import { extensionManifestSchema, sha256Bytes, type ExtensionManifest } from "@keystone/schemas";

export const REFERENCE_EXTENSION = {
  name: "keystone-extension-localization-placeholders",
  version: "1.0.0",
  entryModule: "src/index.ts",
  entryExport: "localizationPlaceholdersVerifier",
} as const;

/** Build the manifest for a specific entry module, digest included. */
export function buildManifest(entryModuleBytes: Uint8Array): ExtensionManifest {
  return extensionManifestSchema.parse({
    name: REFERENCE_EXTENSION.name,
    version: REFERENCE_EXTENSION.version,
    publisher: "keystone",
    integrity: { algorithm: "sha256", digest: sha256Bytes(entryModuleBytes) },
    kind: "verifier",
    apiVersion: "1.0",
    capabilities: ["fs.read"],
    sideEffects: [
      { kind: "fs_read", scope: "reads the source catalog and the changed locale files only" },
    ],
    reversibility: "reversible",
    egressHosts: [],
    credentialHandles: [],
    dataClassification: { reads: "internal", egress: [] },
    produces: {
      observations: ["localization_placeholder_parity"],
      evidenceTypes: ["project_rule_check"],
    },
    execution: { replayable: true, idempotent: true },
    dependencies: [],
    conflicts: [],
    uninstall: "safe",
    entry: { module: REFERENCE_EXTENSION.entryModule, export: REFERENCE_EXTENSION.entryExport },
    description:
      "Fails a task whose changed locale catalog drops a source placeholder or invents one.",
  }) as ExtensionManifest;
}

/**
 * Load the declaration from a checkout of this package.
 *
 * Reading the entry file to hash it is what makes `integrityVerified` mean
 * something: the digest describes bytes that exist, not a value someone typed.
 */
export async function loadDeclaration(packageRoot: string): Promise<{
  readonly manifest: ExtensionManifest;
  readonly integrityVerified: boolean;
}> {
  const bytes = await readFile(new URL(REFERENCE_EXTENSION.entryModule, `file://${packageRoot}/`));
  return { manifest: buildManifest(bytes), integrityVerified: true };
}
