/**
 * Reproducible build-info generator.
 *
 * Records the exact facts a release needs to be traceable and reproducible:
 *   - Node.js version and pnpm version (the environment it was built in),
 *   - sha256 of pnpm-lock.yaml (the exact dependency graph),
 *   - source commit and a dirty flag (which source tree produced it).
 *
 * Determinism model:
 *   - The `fingerprint` is a sha256 over every stable field EXCEPT `generatedAt`.
 *     On the same machine and commit, running this twice yields the SAME fingerprint.
 *   - `generatedAt` is wall-clock and changes every run; it is listed explicitly in
 *     `nonDeterministicFields` and is excluded from the fingerprint. It is provenance,
 *     not a reproducibility claim.
 *   - Environment fields (node/pnpm versions) vary by host by nature; they are
 *     recorded faithfully rather than hidden.
 *
 * Usage:
 *   node scripts/release/build-info.ts [--out dist/release/build-info.json]
 */

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { declaredPackageManager } from "./lib/workspace.ts";

export interface BuildInfoInputs {
  nodeVersion: string;
  pnpmVersion: string;
  packageManagerDeclared: string | null;
  lockfileSha256: string;
  sourceCommit: string;
  sourceDirty: boolean;
  platform: string;
}

export interface BuildInfo extends BuildInfoInputs {
  generatedAt: string;
  nonDeterministicFields: ["generatedAt"];
  fingerprint: string;
}

/** Fields that go into the reproducibility fingerprint (everything except generatedAt). */
export function fingerprintInputs(inputs: BuildInfoInputs): string {
  const stable = {
    nodeVersion: inputs.nodeVersion,
    pnpmVersion: inputs.pnpmVersion,
    packageManagerDeclared: inputs.packageManagerDeclared,
    lockfileSha256: inputs.lockfileSha256,
    sourceCommit: inputs.sourceCommit,
    sourceDirty: inputs.sourceDirty,
    platform: inputs.platform,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** Assemble the document. Pure: inputs are injected so tests avoid touching git. */
export function assembleBuildInfo(inputs: BuildInfoInputs, generatedAtIso: string): BuildInfo {
  return {
    ...inputs,
    generatedAt: generatedAtIso,
    nonDeterministicFields: ["generatedAt"],
    fingerprint: fingerprintInputs(inputs),
  };
}

export function sha256File(absFile: string): string {
  return createHash("sha256").update(readFileSync(absFile)).digest("hex");
}

function git(args: string[], root: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function collectInputs(root: string): BuildInfoInputs {
  const lockfileSha256 = sha256File(path.join(root, "pnpm-lock.yaml"));
  let sourceCommit = "unknown";
  let sourceDirty = false;
  try {
    sourceCommit = git(["rev-parse", "HEAD"], root);
    sourceDirty = git(["status", "--porcelain"], root).length > 0;
  } catch {
    sourceCommit = "no-git";
  }
  let pnpmVersion = "unknown";
  try {
    pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    pnpmVersion = "pnpm-not-on-path";
  }
  return {
    nodeVersion: process.versions.node,
    pnpmVersion,
    packageManagerDeclared: declaredPackageManager(root),
    lockfileSha256,
    sourceCommit,
    sourceDirty,
    platform: process.platform,
  };
}

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function main(): void {
  const root = repoRootFromHere();
  const inputs = collectInputs(root);
  const doc = assembleBuildInfo(inputs, new Date().toISOString());
  const rendered = JSON.stringify(doc, null, 2) + "\n";

  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    const out = process.argv[outIndex + 1]!;
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, rendered, "utf8");
    process.stderr.write(`build-info written to ${out} (fingerprint ${doc.fingerprint.slice(0, 12)}…)\n`);
  } else {
    process.stdout.write(rendered);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
