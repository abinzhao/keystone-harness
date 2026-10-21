/**
 * Minimal extractor for the `packages:` section of a pnpm v6 lockfile.
 *
 * This is deliberately NOT a general YAML parser. It understands the narrow,
 * regular shape pnpm uses in its resolved-package block:
 *
 *   packages:
 *
 *     /@types/node@22.20.5:
 *       resolution: {integrity: sha512-...}
 *       dependencies:
 *         undici-types: 6.21.0
 *       dev: true
 *
 * An entry header is a line two spaces deep that starts with "/" and ends with ":";
 * the entry body is deeper-indented until the next header. We only need the
 * identity (name@version), the integrity hash, and whether it is a dev-only dep.
 * Everything else in the lockfile (importers, workspace links) is ignored here;
 * workspace identity comes from package.json in ./workspace.ts.
 */

export interface LockedPackage {
  name: string;
  version: string;
  integrity: string | null;
  dev: boolean;
}

/** Split a lockfile key such as "@types/node@22.20.5" or "typescript@5.9.3". */
export function splitLockName(key: string): { name: string; version: string } {
  // Strip a leading "/" if present.
  const rest = key.startsWith("/") ? key.slice(1) : key;
  if (rest.startsWith("@")) {
    // Scoped package: the version delimiter is the first "@" after the scope name.
    const at = rest.indexOf("@", 1);
    if (at === -1) return { name: rest, version: "" };
    return { name: rest.slice(0, at), version: rest.slice(at + 1) };
  }
  const at = rest.indexOf("@");
  if (at === -1) return { name: rest, version: "" };
  return { name: rest.slice(0, at), version: rest.slice(at + 1) };
}

/**
 * Extract the resolved third-party packages from the text of pnpm-lock.yaml.
 * Workspace `link:` entries never appear in the `packages:` section, so every
 * result here is an external dependency.
 */
export function extractLockedPackages(lockfileText: string): LockedPackage[] {
  const lines = lockfileText.split(/\r?\n/);
  const packages: LockedPackage[] = [];

  let inPackagesSection = false;
  let current: LockedPackage | null = null;

  const headerRe = /^  \/(.+):\s*$/;

  for (const line of lines) {
    // Top-level "packages:" (no indent) opens the resolved-package section.
    if (/^packages:\s*$/.test(line)) {
      inPackagesSection = true;
      continue;
    }
    // A new zero-indent, non-empty, non-comment line ends the section.
    if (inPackagesSection && line.length > 0 && !line.startsWith(" ")) {
      inPackagesSection = false;
      current = null;
      continue;
    }
    if (!inPackagesSection) continue;

    const header = line.match(headerRe);
    if (header && header[1]) {
      if (current) packages.push(current);
      const { name, version } = splitLockName(header[1]);
      current = { name, version, integrity: null, dev: false };
      continue;
    }

    if (current) {
      const integrity = line.match(/integrity:\s*([^\s}]+)/);
      if (integrity && integrity[1]) current.integrity = integrity[1];
      if (/^\s+dev:\s*true\s*$/.test(line)) current.dev = true;
    }
  }
  if (current) packages.push(current);

  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return packages;
}
