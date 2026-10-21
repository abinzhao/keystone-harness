/**
 * Offline SBOM generator.
 *
 * Reads only the on-disk workspace (package.json files) and pnpm-lock.yaml. It makes
 * no network calls and no timestamp, so given an identical source tree its output is
 * byte-for-byte deterministic.
 *
 * The output is an internal Keystone SBOM document (`keystone-sbom/1.0`). It is NOT
 * presented as SPDX or CycloneDX: those standards are not conformed to here. Each
 * third-party component carries a PackageURL (`purl`) and the pnpm integrity hash so
 * consumers can still match it against registry metadata offline.
 *
 * Usage:
 *   node scripts/release/sbom.ts [--out dist/release/sbom.json]
 *   (no --out writes to stdout)
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkspace } from "./lib/workspace.ts";
import { extractLockedPackages } from "./lib/lockfile.ts";

export interface SbomComponent {
  name: string;
  version: string;
  scope: "workspace" | "runtime" | "dev";
  license: string | null;
  path?: string;
  purl?: string;
  integrity?: string;
}

export interface SbomDocument {
  sbomFormat: "keystone-sbom/1.0";
  note: string;
  offline: true;
  workspaceVersion: string;
  workspaceRootPrivate: boolean;
  componentCount: number;
  components: SbomComponent[];
}

function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name}@${version}`;
}

/**
 * Build the SBOM document from already-read inputs. Pure: same inputs -> same object,
 * and the component array is sorted so serialization is stable.
 */
export function buildSbom(root: string, lockfileText: string): SbomDocument {
  const { root: rootPkg, packages } = loadWorkspace(root);
  const locked = extractLockedPackages(lockfileText);

  const components: SbomComponent[] = [];

  for (const pkg of packages) {
    components.push({
      name: pkg.name,
      version: pkg.version,
      scope: "workspace",
      license: pkg.license,
      path: pkg.dir,
    });
  }

  for (const dep of locked) {
    components.push({
      name: dep.name,
      version: dep.version,
      scope: dep.dev ? "dev" : "runtime",
      license: null,
      purl: npmPurl(dep.name, dep.version),
      integrity: dep.integrity ?? undefined,
    });
  }

  components.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );

  return {
    sbomFormat: "keystone-sbom/1.0",
    note:
      "Offline workspace SBOM derived from package.json and pnpm-lock.yaml. " +
      "Internal format; not an SPDX/CycloneDX document. No timestamp: output is deterministic.",
    offline: true,
    workspaceVersion: rootPkg.version,
    workspaceRootPrivate: rootPkg.private,
    componentCount: components.length,
    components,
  };
}

export function renderSbom(doc: SbomDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function repoRootFromHere(): string {
  // scripts/release/sbom.ts -> <root>/scripts/release -> up two to <root>
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function main(): void {
  const root = repoRootFromHere();
  const lockfileText = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const doc = buildSbom(root, lockfileText);
  const rendered = renderSbom(doc);

  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    const out = process.argv[outIndex + 1]!;
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, rendered, "utf8");
    process.stderr.write(`SBOM written to ${out} (${doc.componentCount} components)\n`);
  } else {
    process.stdout.write(rendered);
  }
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
