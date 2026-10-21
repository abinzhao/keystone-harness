/**
 * Workspace package discovery for release tooling.
 *
 * Release tooling is intentionally dependency-free and never imports a @keystone/*
 * package: it must be runnable before the workspace is even built, and its output
 * must be auditable against the raw package.json files on disk. These helpers only
 * read JSON and the directory layout.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/** A workspace package's release-relevant metadata, extracted from its package.json. */
export interface WorkspacePackage {
  name: string;
  version: string;
  private: boolean;
  license: string | null;
  /** Path relative to the repository root, e.g. "packages/kernel". */
  dir: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/** Parse a single package.json file into release metadata, relative to repo root. */
export function parsePackageJson(absFile: string, root: string): WorkspacePackage {
  const json = readJson(absFile);
  const dir = path.relative(root, path.dirname(absFile));
  return {
    name: typeof json.name === "string" ? json.name : "(unnamed)",
    version: typeof json.version === "string" ? json.version : "0.0.0",
    private: json.private === true,
    license: typeof json.license === "string" ? json.license : null,
    dir,
    dependencies: asStringRecord(json.dependencies),
    devDependencies: asStringRecord(json.devDependencies),
  };
}

/** Root package.json plus every package under `packages/*` that has a package.json. */
export interface Workspace {
  root: WorkspacePackage;
  packages: WorkspacePackage[];
}

export function loadWorkspace(root: string): Workspace {
  const rootPkg = parsePackageJson(path.join(root, "package.json"), root);
  const packagesDir = path.join(root, "packages");
  const packages: WorkspacePackage[] = [];
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgFile = path.join(packagesDir, entry.name, "package.json");
      if (existsSync(pkgFile)) packages.push(parsePackageJson(pkgFile, root));
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { root: rootPkg, packages };
}

/** The declared package manager, e.g. "pnpm@8.15.9", straight from the root package.json. */
export function declaredPackageManager(root: string): string | null {
  const json = readJson(path.join(root, "package.json"));
  return typeof json.packageManager === "string" ? json.packageManager : null;
}
