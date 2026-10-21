/**
 * Version-consistency and release-readiness check.
 *
 * This script NEVER bumps a version and NEVER publishes. It only answers two things:
 *
 *   1. Version consistency (hard failure): does every workspace package.json carry the
 *      exact same version as the root package.json, and is it valid semver?
 *   2. Release readiness (read-only report): a conservative checklist with TWO
 *      channels. A prerelease such as `1.0.0-rc.1` is allowed to pass as a local
 *      RC artifact build — it does NOT publish, sign, or notarize, and it is not a
 *      stable release. A plain `1.0.0` on the stable channel must be explicitly
 *      blessed via `--allow-1.0`; absent that, attempting to release 1.0.0 fails,
 *      because the 1.0.0 release gates have not yet been closed.
 *
 * Exit codes: 0 = consistent and report printed; 1 = inconsistency, an invalid
 * version, or an unblessed 1.0.0. Nothing here signs, notarizes, tags, or
 * publishes. See docs/adr/0012-release-candidate-boundary.md.
 *
 * Usage:
 *   node scripts/release/version-check.ts [--allow-1.0]
 */

import { loadWorkspace, type WorkspacePackage } from "./lib/workspace.ts";
import { isPrereleaseVersion } from "./bump-version.ts";

export interface VersionMismatch {
  name: string;
  expected: string;
  actual: string;
  path: string;
}

export interface ConsistencyResult {
  rootVersion: string;
  validSemver: boolean;
  mismatches: VersionMismatch[];
}

export function checkConsistency(rootPkg: WorkspacePackage, packages: WorkspacePackage[]): ConsistencyResult {
  const expected = rootPkg.version;
  const mismatches: VersionMismatch[] = [];
  for (const pkg of packages) {
    if (pkg.version !== expected) {
      mismatches.push({ name: pkg.name, expected, actual: pkg.version, path: pkg.dir });
    }
  }
  return {
    rootVersion: expected,
    validSemver: /^\d+\.\d+\.\d+([-][0-9A-Za-z.-]+)?$/.test(expected),
    mismatches,
  };
}

export interface ReadinessGate {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessReport {
  version: string;
  rootPrivate: boolean;
  /** "rc" for a prerelease such as 1.0.0-rc.1; "stable" for a plain 1.0.0. */
  channel: "rc" | "stable";
  gates: ReadinessGate[];
  ready: boolean;
}

/**
 * Conservative readiness gates. These deliberately do NOT auto-promote: they are a
 * checklist a human reads before cutting a release. A future release scorecard owns
 * the real acceptance gates (see ROADMAP); here we only block dangerous mistakes.
 *
 * Two channels:
 *   - prerelease (`1.0.0-rc.1` …) → passes as a local RC artifact build. The RC
 *     boundary gate below states explicitly what this does NOT authorize (publish,
 *     sign, notarize, or be treated as a stable release).
 *   - stable (`1.0.0`) → additionally requires the explicit `--allow-1.0` blessing.
 */
export function evaluateReadiness(
  rootPkg: WorkspacePackage,
  consistency: ConsistencyResult,
  packageCount: number,
  allow1Point0: boolean,
): ReadinessReport {
  const channel: "rc" | "stable" = isPrereleaseVersion(rootPkg.version) ? "rc" : "stable";
  const gates: ReadinessGate[] = [
    {
      id: "versions_in_sync",
      ok: consistency.mismatches.length === 0,
      detail:
        consistency.mismatches.length === 0
          ? `all ${packageCount} workspace packages match ${rootPkg.version}`
          : `${consistency.mismatches.length} package(s) differ from root`,
    },
    {
      id: "valid_semver",
      ok: consistency.validSemver,
      detail: rootPkg.version,
    },
    {
      id: "stays_private_until_published",
      ok: rootPkg.private,
      detail: rootPkg.private ? "root package.json is private (not publishable)" : "root is NOT private",
    },
    {
      id: "rc_boundary",
      ok: true,
      detail:
        channel === "rc"
          ? `prerelease ${rootPkg.version}: allowed to produce a local RC artifact build only; NOT a stable release — publishing, signing, and notarization remain forbidden, and graduating to 1.0.0 still requires --allow-1.0 once the release gates close`
          : `stable channel at ${rootPkg.version}: admission is governed by the explicit --allow-1.0 gate below`,
    },
    {
      id: "no_1_0_0_without_blessing",
      ok: rootPkg.version !== "1.0.0" || allow1Point0,
      detail:
        rootPkg.version === "1.0.0"
          ? allow1Point0
            ? "1.0.0 explicitly allowed via --allow-1.0"
            : "refusing 1.0.0: release gates not met and not explicitly blessed"
          : `current version is ${rootPkg.version} (not stable 1.0.0)`,
    },
  ];

  return {
    version: rootPkg.version,
    rootPrivate: rootPkg.private,
    channel,
    gates,
    ready: gates.every((g) => g.ok),
  };
}

export function repoRootFromArg(): string {
  // Default to the repo root two levels up from this file; tests pass an explicit cwd.
  return process.cwd();
}

function main(): void {
  const root = repoRootFromArg();
  const { root: rootPkg, packages } = loadWorkspace(root);
  const consistency = checkConsistency(rootPkg, packages);
  const allow1Point0 = process.argv.includes("--allow-1.0");
  const report = evaluateReadiness(rootPkg, consistency, packages.length, allow1Point0);

  const lines: string[] = [];
  lines.push(`Version consistency: ${consistency.rootVersion} (channel: ${report.channel})`);
  for (const m of consistency.mismatches) {
    lines.push(`  MISMATCH ${m.name} (${m.path}): ${m.actual} !== root ${m.expected}`);
  }
  lines.push("Readiness gates:");
  for (const g of report.gates) {
    lines.push(`  [${g.ok ? " OK " : "FAIL"}] ${g.id} — ${g.detail}`);
  }
  lines.push(`Release-ready: ${report.ready ? "yes" : "no"}`);

  const hardFail = consistency.mismatches.length > 0 || !consistency.validSemver;
  if (hardFail || !report.ready) {
    process.stderr.write(lines.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("version-check.ts");
if (invokedDirectly) main();
