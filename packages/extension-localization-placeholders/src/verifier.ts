/**
 * Governed E1 adapter around the pure checker.
 *
 * This is the extension-point half of the reference scenario: the kernel never
 * calls it unless a user activates the extension, and the descriptor is honest
 * about what it can support. A same-process string scan verifies nothing about
 * behaviour, so it is E1 and may never satisfy a required condition on its own
 * (PRD VF-02) — the actual "done" evidence for a localization change still has to
 * come from an E2 check (the project's own parity test run in a child process).
 *
 * Read-only by construction: it only reads the source catalog and the changed
 * locale files, writes nothing, and touches no network.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  Verifier,
  VerifierContext,
  VerifierOutcome,
} from "@keystone/verifiers";

import {
  checkCatalogParity,
  parseCatalog,
  type MessageCatalog,
  type PlaceholderFinding,
} from "./checker.ts";

/** Source catalog: the language translations are measured against. */
const DEFAULT_SOURCE = "locales/en.json";
/** Which changed files this verifier treats as candidate translations. */
const LOCALE_FILE = /^locales\/[a-z]{2}(?:-[A-Z]{2})?\.json$/;

async function readCatalog(path: string): Promise<MessageCatalog | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  return parseCatalog(raw);
}

function isLocaleFile(path: string): boolean {
  return LOCALE_FILE.test(path);
}

export const localizationPlaceholdersVerifier: Verifier = {
  descriptor: {
    kind: "project_rule",
    id: "extension.localization_placeholders",
    version: "1.0.0",
    // A text scan in this process: real, but it verifies nothing about runtime
    // behaviour, so it may only serve auxiliary conditions.
    evidenceLevel: "E1",
    canSatisfyRequiredCondition: false,
    independence: {
      // It runs inside the Builder Loop's process, so it is independent of
      // nothing the proof gate measures: claiming `builder_loop_process` here
      // would contradict `same_process`, and the kernel would ignore the claim
      // anyway. The E2 child-process verifier is what supplies separation.
      mode: "same_process",
      independentOf: [],
    },
    timeoutMs: 10_000,
    requiresCommand: false,
    description:
      "fails when a changed locale catalog drops a source placeholder or invents one",
  },

  async run(context: VerifierContext): Promise<VerifierOutcome> {
    const started = Date.now();

    const source = await readCatalog(join(context.rootPath, DEFAULT_SOURCE));
    if (source === undefined) {
      // Without a source catalog there is nothing to compare against. Say so
      // rather than passing, since "parity holds" was never observed.
      return {
        status: "blocked",
        summary: `could not read the source catalog ${DEFAULT_SOURCE}`,
        outputBytes: 0,
        truncated: false,
        incomplete: [`source catalog ${DEFAULT_SOURCE} could not be read or is not a flat string map`],
        durationMs: Date.now() - started,
      };
    }

    const changedTargets = context.changedPaths.filter(isLocaleFile);
    if (changedTargets.length === 0) {
      return {
        status: "passed",
        summary: "no changed locale files were observed, so no parity check was needed",
        outputBytes: 0,
        truncated: false,
        incomplete: ["no changed locale files were observed"],
        durationMs: Date.now() - started,
      };
    }

    const findings: PlaceholderFinding[] = [];
    const unreadable: string[] = [];

    for (const path of changedTargets) {
      const target = await readCatalog(join(context.rootPath, path));
      if (target === undefined) {
        unreadable.push(path);
        continue;
      }
      for (const finding of checkCatalogParity(source, target)) {
        findings.push({ ...finding, key: `${path}::${finding.key}` });
      }
    }

    const summary =
      findings.length === 0
        ? `parity holds across ${changedTargets.length} changed locale file(s)`
        : `found ${findings.length} placeholder parity issue(s): ` +
          findings
            .slice(0, 10)
            .map((finding) => `${finding.key} (${finding.kind})`)
            .join(", ");

    return {
      status: findings.length === 0 ? "passed" : "failed",
      summary,
      outputBytes: summary.length,
      truncated: false,
      ...(unreadable.length === 0 ? {} : { incomplete: [`could not read: ${unreadable.join(", ")}`] }),
      durationMs: Date.now() - started,
    };
  },
};

/** Exported for the runnable CLI and for tests that name the source file. */
export const SOURCE_CATALOG = DEFAULT_SOURCE;
export function describesLocaleFile(path: string): boolean {
  return isLocaleFile(path);
}
export function localeName(path: string): string {
  return basename(path, ".json");
}
