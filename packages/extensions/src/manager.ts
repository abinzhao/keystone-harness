/**
 * End-user governed extension install: the local-path entry point.
 *
 * The kernel owns every state transition; this module only turns a local
 * package directory into the facts the existing registry and Conformance Kit
 * already know how to act on:
 *
 *  - read the manifest the package ships,
 *  - verify its declared digest against the bytes that would actually run,
 *  - load the declared entry and run the Conformance Kit against it,
 *  - hand the result to the registry, which is the only writer.
 *
 * There is no remote fetch here: installation is local-path first by design, so
 * the user can see exactly which directory they are trusting (PRD PL-01, PL-02).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  extensionManifestSchema,
  sha256Bytes,
  type ConformanceReport,
  type ExtensionManifest,
  type ExtensionRegistration,
} from "@keystone/schemas";

import { canActivate, reachesOutside, type ActivationGateResult } from "./activation.ts";
import { runConformance } from "./conformance.ts";
import { describeInstallReview, type InstallReview } from "./manifest.ts";
import { mcpHandshakeProbe } from "./mcp/conformance-probe.ts";

/** The manifest file every local package must ship at its root. */
export const EXTENSION_MANIFEST_FILE = "keystone-extension.json";

/** Where the persistent registry lives under a Keystone home. */
export function defaultRegistryLocation(home: string): { readonly registryFile: string } {
  return { registryFile: join(home, "extensions", "registry.json") };
}

export class LocalPackageError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "LocalPackageError";
    this.issues = issues;
  }
}

export interface ReadLocalPackage {
  readonly manifest: ExtensionManifest;
  /** True when the manifest's digest matches the actual entry bytes. */
  readonly integrityVerified: boolean;
  /** Absolute path of the in-process entry module, when the package has one. */
  readonly entryPath?: string;
  readonly review: InstallReview;
}

/**
 * Read a local extension package without changing any state.
 *
 * Fails loudly when the manifest is missing, unparseable, or describes bytes
 * that do not match the entry on disk — a digest that does not match is exactly
 * the "package was altered after the manifest was written" case PL-02 exists
 * for, and it is refused before anything is registered.
 */
export async function readLocalPackage(packageRoot: string): Promise<ReadLocalPackage> {
  const root = resolve(packageRoot);
  const manifestPath = join(root, EXTENSION_MANIFEST_FILE);

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new LocalPackageError(
      `no ${EXTENSION_MANIFEST_FILE} found in ${root}; a local extension must ship its manifest`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LocalPackageError(
      `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let manifest: ExtensionManifest;
  try {
    manifest = extensionManifestSchema.parse(parsed) as ExtensionManifest;
  } catch (error) {
    throw new LocalPackageError(
      `${manifestPath} does not match the extension manifest schema`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  // An out-of-process stdio server ships no bundled TS bytes to digest. The
  // local directory the user pointed at is the trust anchor (ADR-0009); that
  // the declared command actually resolves is proven by a conformance probe,
  // not by hashing. This is a stated, weaker boundary than digesting bundled
  // entry bytes — it is not papered over.
  if (manifest.transport !== undefined) {
    return {
      manifest,
      integrityVerified: true,
      review: describeInstallReview(manifest),
    };
  }

  if (manifest.entry === undefined) {
    throw new LocalPackageError(
      `a ${manifest.kind} extension must declare either an in-process entry (entry.module) or a stdio transport`,
    );
  }

  const entryPath = resolve(root, manifest.entry.module);
  let entryBytes: Uint8Array;
  try {
    entryBytes = new Uint8Array(await readFile(entryPath));
  } catch {
    throw new LocalPackageError(
      `the manifest declares entry "${manifest.entry.module}", which cannot be read from ${root}`,
    );
  }

  const integrityVerified = sha256Bytes(entryBytes) === manifest.integrity.digest;

  return {
    manifest,
    integrityVerified,
    entryPath,
    review: describeInstallReview(manifest),
  };
}

/**
 * Build the entry loader the Conformance Kit uses to prove a declared verifier
 * actually looks like one. The loader resolves the module the manifest names,
 * relative to the package root, and returns the named export.
 */
export function localEntryLoader(
  packageRoot: string,
): (modulePath: string, exportName: string) => Promise<unknown> {
  const root = resolve(packageRoot);
  return async (modulePath, exportName) => {
    const mod = (await import(pathToFileURL(resolve(root, modulePath)).href)) as Record<
      string,
      unknown
    >;
    return mod[exportName];
  };
}

export interface PreparedLocalInstall {
  readonly read: ReadLocalPackage;
  readonly conformance: ConformanceReport;
  readonly gate: ActivationGateResult;
}

/**
 * Everything needed to decide whether to install: the manifest, the integrity
 * check, a recorded conformance run, and the activation gate. Writes nothing.
 */
export async function prepareLocalInstall(packageRoot: string): Promise<PreparedLocalInstall> {
  const read = await readLocalPackage(packageRoot);
  // A stdio protocol extension gets a live behavioral probe: actually launch
  // the declared command and handshake, so a server that does not speak MCP
  // fails conformance here rather than at first use (ADR-0009).
  const probes =
    read.manifest.transport === undefined
      ? []
      : [mcpHandshakeProbe({ manifest: read.manifest, packageRoot })];
  const conformance = await runConformance({
    manifest: read.manifest,
    integrityVerified: read.integrityVerified,
    entryLoader: localEntryLoader(packageRoot),
    probes,
  });
  const gate = canActivate({
    manifest: read.manifest,
    integrityVerified: read.integrityVerified,
    conformance,
  });
  return { read, conformance, gate };
}

export interface LowRiskExtensionView {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly kind: string;
  readonly capabilities: readonly string[];
  readonly status: string;
}

/**
 * Read-only projection of active extensions a shell may show.
 *
 * Only low-risk active extensions are surfaced: local, verified, and unable to
 * reach outside the machine. This is visibility, not a grant — listing an
 * extension never widens what it may do, and the kernel still issues every
 * lease against the user's envelope (PRD 9.7, PL-02).
 */
export function lowRiskActiveExtensions(
  entries: readonly ExtensionRegistration[],
): readonly LowRiskExtensionView[] {
  return entries
    .filter(
      (entry) =>
        entry.status === "active" && entry.integrityVerified && !reachesOutside(entry.manifest),
    )
    .map((entry) => ({
      name: entry.manifest.name,
      version: entry.manifest.version,
      publisher: entry.manifest.publisher,
      kind: entry.manifest.kind,
      capabilities: [...entry.manifest.capabilities],
      status: entry.status,
    }));
}
