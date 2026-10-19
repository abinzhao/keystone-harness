/**
 * Reference extension verifier: no debug statements in the change set.
 *
 * The point of this package is to be the worked example a contributor can copy
 * (PRD 18.2): it implements exactly one extension point, declares what it needs,
 * and passes the conformance kit. It is not part of the kernel and is not
 * loaded unless a user activates it.
 *
 * What it checks is deliberately mundane but real — a change set that leaves
 * `console.log` or `debugger` behind is a change a reviewer would send back, and
 * catching it deterministically is cheaper than catching it in review.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Verifier,
  VerifierContext,
  VerifierOutcome,
} from "@keystone/verifiers";

const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".swift",
  ".kt",
  ".go",
  ".rs",
  ".py",
  ".rb",
  ".java",
]);

const PATTERNS: readonly { readonly id: string; readonly regex: RegExp }[] = [
  { id: "console.log", regex: /\bconsole\.log\s*\(/ },
  { id: "console.debug", regex: /\bconsole\.debug\s*\(/ },
  { id: "debugger", regex: /(^|[^.\w])debugger\b/ },
];

export interface DebugFinding {
  readonly path: string;
  readonly line: number;
  readonly kind: string;
}

/**
 * Pure scan, so it can be tested and reasoned about without a filesystem.
 *
 * Test files are skipped on purpose: a test that prints while diagnosing a
 * failure is normal, and a verifier that fires on it would be turned off.
 */
export function scanForDebugStatements(
  path: string,
  content: string,
): readonly DebugFinding[] {
  if (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path)) {
    return [];
  }
  const findings: DebugFinding[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({ path, line: index + 1, kind: pattern.id });
      }
    }
  }
  return findings;
}

function isScannable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && SCANNED_EXTENSIONS.has(path.slice(dot));
}

export const noDebugStatementsVerifier: Verifier = {
  descriptor: {
    kind: "project_rule",
    id: "extension.no_debug_statements",
    version: "1.0.0",
    // A text scan in this process: it is a real check, but it verifies nothing
    // about behaviour, so it may only serve auxiliary conditions.
    evidenceLevel: "E1",
    canSatisfyRequiredCondition: false,
    independence: {
      mode: "same_process",
      independentOf: ["builder_loop_model", "builder_loop_process"],
    },
    timeoutMs: 10_000,
    requiresCommand: false,
    description: "fails when files in the change set contain console.log, console.debug or debugger",
  },

  async run(context: VerifierContext): Promise<VerifierOutcome> {
    const started = Date.now();
    const scannable = context.changedPaths.filter(isScannable);

    if (context.changedPaths.length === 0) {
      // Reporting "passed" for a change set we never saw would be a false
      // negative dressed as a clean result, so it is also reported as incomplete.
      return {
        status: "passed",
        summary: "no changed paths were observed, so no file was scanned",
        outputBytes: 0,
        truncated: false,
        incomplete: ["no changed paths were observed"],
        durationMs: Date.now() - started,
      };
    }

    const findings: DebugFinding[] = [];
    const unreadable: string[] = [];

    for (const path of scannable) {
      const content = await readFile(join(context.rootPath, path), "utf8").catch(() => undefined);
      if (content === undefined) {
        // Deleted files, binary content, permissions: say so rather than pass.
        unreadable.push(path);
        continue;
      }
      findings.push(...scanForDebugStatements(path, content));
    }

    const summary =
      findings.length === 0
        ? `scanned ${scannable.length} changed file(s); no debug statements found`
        : `found ${findings.length} debug statement(s): ` +
          findings
            .slice(0, 10)
            .map((finding) => `${finding.path}:${finding.line} ${finding.kind}`)
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

export const FINDING_PATTERNS = PATTERNS;
