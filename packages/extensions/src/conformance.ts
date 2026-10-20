/**
 * Conformance Kit.
 *
 * An extension is activated only after a conformance run, and the run is
 * recorded in the registry so that "this extension was checked" is a fact rather
 * than a memory. Checks split into blocking (the extension cannot be trusted to
 * behave as declared) and advisory (the user should know, but nothing is broken).
 */

import {
  conformanceReportSchema,
  sha256Hex,
  canonicalJson,
  nowIso,
  type ConformanceReport,
  type ExtensionManifest,
} from "@keystone/schemas";

import { checkDeclarations, type DeclarationCheck } from "./manifest.ts";
import { verifierEntryShapeProbe } from "./verifier-entry-probe.ts";

/** The Runtime protocol version this build implements. */
export const SUPPORTED_API_VERSION = "1.0";

export interface ConformanceProbe {
  readonly checkId: string;
  readonly blocking: boolean;
  readonly detail: string;
  run(): Promise<{ passed: boolean; detail: string }>;
}

export interface ConformanceContext {
  readonly manifest: ExtensionManifest;
  readonly integrityVerified: boolean;
  readonly apiVersionSupported?: string;
  /** Behavioural probes supplied by the extension host, when it has one. */
  readonly probes?: readonly ConformanceProbe[];
  /**
   * How the host loads a manifest's declared entry. When provided for a
   * `kind: "verifier"` extension, the kit automatically runs the generic
   * verifier-entry shape probe against the real export — a manifest that merely
   * *says* it exports a verifier is not conformance until the loaded entry looks
   * like one (and does not over-claim its evidence level).
   */
  readonly entryLoader?: (
    modulePath: string,
    exportName: string,
  ) => Promise<unknown>;
}

interface CheckResult {
  readonly checkId: string;
  readonly passed: boolean;
  readonly blocking: boolean;
  readonly detail: string;
}

function check(
  checkId: string,
  passed: boolean,
  blocking: boolean,
  detail: string,
): CheckResult {
  return { checkId, passed, blocking, detail };
}

/**
 * A semver range this build can resolve. Deliberately a syntax check, not a
 * solver: resolving ranges is the registry's job, and pretending to resolve them
 * here would produce a conformance report that says more than it verified.
 */
export function isPlausibleRange(range: string): boolean {
  const trimmed = range.trim();
  // An empty range is not "anything" — it is a missing declaration, and it must
  // be reported rather than accepted as a wildcard.
  if (trimmed === "") return false;
  if (trimmed === "*" || trimmed === "latest") return true;
  return trimmed
    .split("||")
    .map((part) => part.trim())
    .every(
      (part) =>
        part !== "" &&
        (/^(\^|~|>=|<=|>|<|=)?\d+(\.\d+)?(\.\d+)?(-[0-9A-Za-z.-]+)?$/.test(part) ||
          /^\d+(\.\d+)?\.x$/.test(part)),
    );
}

function apiVersionCompatible(declared: string, supported: string): boolean {
  const declaredMajor = declared.split(".")[0];
  const supportedMajor = supported.split(".")[0];
  return declaredMajor !== undefined && declaredMajor === supportedMajor;
}

export async function runConformance(context: ConformanceContext): Promise<ConformanceReport> {
  const { manifest } = context;
  const supported = context.apiVersionSupported ?? SUPPORTED_API_VERSION;
  const results: CheckResult[] = [];

  results.push(
    check(
      "manifest.schema_valid",
      true,
      true,
      "the manifest matches the published schema and was parsed before this run",
    ),
  );

  results.push(
    check(
      "manifest.integrity",
      context.integrityVerified,
      true,
      context.integrityVerified
        ? "the package digest matches the manifest"
        : "the package digest does not match the manifest; the package may have been altered",
    ),
  );

  results.push(
    check(
      "api.version",
      apiVersionCompatible(manifest.apiVersion, supported),
      true,
      apiVersionCompatible(manifest.apiVersion, supported)
        ? `built against API ${manifest.apiVersion}, runtime supports ${supported}`
        : `built against API ${manifest.apiVersion}, but this runtime implements ${supported}`,
    ),
  );

  for (const declaration of checkDeclarations(manifest)) {
    results.push(toResult(declaration));
  }

  const dependencyOk = manifest.dependencies.every((dependency) =>
    isPlausibleRange(dependency.range),
  );
  results.push(
    check(
      "dependencies.range_syntax",
      dependencyOk,
      true,
      dependencyOk
        ? "every declared dependency range is syntactically resolvable"
        : `unresolvable dependency range in ${manifest.dependencies
            .filter((dependency) => !isPlausibleRange(dependency.range))
            .map((dependency) => `${dependency.name}@${dependency.range}`)
            .join(", ")}`,
    ),
  );

  if (manifest.kind === "verifier") {
    results.push(
      check(
        "execution.replayable_verifier",
        manifest.execution.replayable,
        false,
        manifest.execution.replayable
          ? "the verifier declares itself replayable"
          : "the verifier does not declare itself replayable, so its evidence cannot be re-checked by re-running it",
      ),
    );
  }

  // The generic verifier-entry probe runs automatically when the host can load
  // entries and the manifest declares a verifier. Host-supplied probes still run
  // afterwards, in the order they were given.
  const autoProbes: ConformanceProbe[] =
    manifest.kind === "verifier" && context.entryLoader !== undefined
      ? [verifierEntryShapeProbe({ manifest, loadEntry: context.entryLoader })]
      : [];

  for (const probe of [...autoProbes, ...(context.probes ?? [])]) {
    const outcome = await probe.run();
    results.push(check(probe.checkId, outcome.passed, probe.blocking, outcome.detail));
  }

  const passed = results.every((result) => result.passed || !result.blocking);
  const report = {
    extensionName: manifest.name,
    extensionVersion: manifest.version,
    apiVersion: manifest.apiVersion,
    passed,
    checks: results,
    at: nowIso(),
  };

  return conformanceReportSchema.parse({
    ...report,
    reportHash: sha256Hex(canonicalJson(report)),
  }) as ConformanceReport;
}

function toResult(declaration: DeclarationCheck): CheckResult {
  return {
    checkId: declaration.checkId,
    passed: declaration.passed,
    blocking: declaration.blocking,
    detail: declaration.detail,
  };
}

/** Human-readable summary of a failed conformance run. */
export function summarizeConformance(report: ConformanceReport): string {
  const blocking = report.checks.filter((entry) => entry.blocking && !entry.passed);
  if (blocking.length === 0) {
    return `${report.extensionName}@${report.extensionVersion} passed conformance`;
  }
  return [
    `${report.extensionName}@${report.extensionVersion} failed conformance:`,
    ...blocking.map((entry) => `- ${entry.checkId}: ${entry.detail}`),
  ].join("\n");
}
