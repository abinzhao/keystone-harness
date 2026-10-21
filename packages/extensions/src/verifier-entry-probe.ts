/**
 * Generic verifier-entry shape / behavioural probe.
 *
 * A manifest that says `entry.export` names a verifier is, by itself, only a
 * promise. This probe loads the real entry the host points at and checks the
 * promise holds: the export exists, it looks like a `Verifier`, and its
 * descriptor does not over-claim. The most important over-claim it blocks is the
 * one PRD VF-02 exists to prevent: a same-process E1 scan declaring
 * `canSatisfyRequiredCondition: true`, which would let a weak check masquerade as
 * enough to call a task done.
 *
 * Trusted fixtures may supply a loader. Local installation uses the separate
 * bounded child probe below; unknown code never runs in the trusted host.
 */

import { EVIDENCE_LEVELS, VERIFIER_KINDS, levelCanStandAlone } from "@keystone/schemas";
import type { EvidenceLevel, VerifierKind } from "@keystone/schemas";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ConformanceProbe } from "./conformance.ts";

export interface VerifierEntryInspection {
  readonly passed: boolean;
  readonly detail: string;
}

const EVIDENCE_LEVEL_SET = new Set<string>(EVIDENCE_LEVELS);
const VERIFIER_KIND_SET = new Set<string>(VERIFIER_KINDS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure shape check of a loaded verifier entry.
 *
 * Deliberately narrow: it checks structure and the one honesty rule that turns a
 * weak verifier into a dangerous one. It does not run the verifier against a
 * fixture — that is the host's job, and doing it here would make conformance
 * depend on a project filesystem.
 */
export function inspectVerifierEntry(value: unknown): VerifierEntryInspection {
  if (value === undefined || value === null) {
    return { passed: false, detail: "the declared entry export is undefined" };
  }
  if (!isObject(value)) {
    return { passed: false, detail: "the declared entry export is not an object" };
  }

  if (typeof value.run !== "function") {
    return { passed: false, detail: "the verifier entry has no callable run() method" };
  }

  const descriptor = value.descriptor;
  if (!isObject(descriptor)) {
    return { passed: false, detail: "the verifier entry has no descriptor object" };
  }

  if (typeof descriptor.id !== "string" || descriptor.id.trim() === "") {
    return { passed: false, detail: "the verifier descriptor has no non-empty id" };
  }
  if (typeof descriptor.version !== "string" || descriptor.version.trim() === "") {
    return { passed: false, detail: `verifier ${descriptor.id} has no non-empty version` };
  }

  const kind = descriptor.kind;
  if (typeof kind !== "string" || !VERIFIER_KIND_SET.has(kind as VerifierKind)) {
    return {
      passed: false,
      detail: `verifier ${descriptor.id} declares unknown kind "${String(kind)}"`,
    };
  }

  const level = descriptor.evidenceLevel;
  if (typeof level !== "string" || !EVIDENCE_LEVEL_SET.has(level as EvidenceLevel)) {
    return {
      passed: false,
      detail: `verifier ${descriptor.id} declares unknown evidence level "${String(level)}"`,
    };
  }

  if (typeof descriptor.canSatisfyRequiredCondition !== "boolean") {
    return {
      passed: false,
      detail: `verifier ${descriptor.id} must declare canSatisfyRequiredCondition as a boolean`,
    };
  }

  // VF-02: a level that cannot stand alone (E0 model claim, E1 tool record) may
  // never be advertised as enough for a required condition. Conformance refuses
  // the over-declaration rather than trusting it.
  if (!levelCanStandAlone(level as EvidenceLevel) && descriptor.canSatisfyRequiredCondition) {
    return {
      passed: false,
      detail:
        `verifier ${descriptor.id} only produces ${level} evidence but claims it can satisfy ` +
        "a required condition; non-stand-alone levels may never stand alone",
    };
  }

  const independence = descriptor.independence;
  if (!isObject(independence) || !Array.isArray(independence.independentOf)) {
    return {
      passed: false,
      detail: `verifier ${descriptor.id} must declare an independence block with independentOf`,
    };
  }

  // Independence honesty (VF-01, VF-04). A verifier that runs in the same process
  // as the Builder Loop cannot simultaneously claim to be independent of that
  // process, its workspace, or its data source — the proof gate would ignore such
  // a claim anyway, so a descriptor that makes it is over-declaring and refused.
  // (Claiming to be independent of the *model's text* — builder_loop_model — is
  // allowed: deterministic code is not the model's say-so even in-process.)
  if (independence.mode === "same_process") {
    const shared = (independence.independentOf as readonly string[]).filter((target) =>
      target === "builder_loop_process" ||
      target === "builder_loop_workspace" ||
      target === "builder_loop_datasource",
    );
    if (shared.length > 0) {
      return {
        passed: false,
        detail:
          `verifier ${descriptor.id} declares independence.mode "same_process" yet claims ` +
          `independence of ${shared.join(", ")}; a process cannot be independent of itself`,
      };
    }
  }

  return {
    passed: true,
    detail: `entry ${descriptor.id}@${descriptor.version} is a well-formed ${kind} verifier (${level})`,
  };
}

/**
 * Build the blocking conformance probe a host runs for a `kind: "verifier"`
 * extension. The probe loads the entry named by the manifest and inspects it.
 */
export function verifierEntryShapeProbe(options: {
  readonly manifest: { readonly entry: { readonly module: string; readonly export: string } };
  readonly loadEntry: (modulePath: string, exportName: string) => Promise<unknown>;
}): ConformanceProbe {
  const { manifest, loadEntry } = options;
  return {
    checkId: "entry.verifier_shape",
    blocking: true,
    detail: `loads ${manifest.entry.module}#${manifest.entry.export} and checks it is a Verifier`,
    async run() {
      let loaded: unknown;
      try {
        loaded = await loadEntry(manifest.entry.module, manifest.entry.export);
      } catch (error) {
        return {
          passed: false,
          detail: `could not load ${manifest.entry.module}#${manifest.entry.export}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      return inspectVerifierEntry(loaded);
    },
  };
}

export interface IsolatedProbeLimits {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

/** Fixed upper bounds cannot be enlarged by a manifest or caller. */
export function probeLimits(options: IsolatedProbeLimits): {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
} {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("probe limits must be positive safe integers");
  }
  return {
    timeoutMs: Math.min(timeoutMs, 5_000),
    maxOutputBytes: Math.min(maxOutputBytes, 64 * 1024),
  };
}

/** No inherited credentials, NODE_OPTIONS, preload hooks, or user HOME. */
export function probeEnvironment(workspace: string): Record<string, string> {
  return {
    PATH: dirname(process.execPath),
    HOME: workspace,
    TMPDIR: workspace,
    TEMP: workspace,
    TMP: workspace,
    NODE_NO_WARNINGS: "1",
    ...(process.platform === "win32" && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

/** This is process/Node-permission isolation, not a network or OS sandbox. */
export function isolatedVerifierEntryShapeProbe(options: IsolatedProbeLimits & {
  readonly workspace: string;
  readonly entry: { readonly module: string; readonly export: string };
}): ConformanceProbe {
  return {
    checkId: "entry.verifier_shape",
    blocking: true,
    detail: "inspects the copied verifier export in a bounded child, never in the host",
    async run() {
      options.signal?.throwIfAborted();
      const limits = probeLimits(options);
      const here = dirname(fileURLToPath(import.meta.url));
      const packages = resolve(here, "../..");
      const inspectUrl = import.meta.url;
      const entryUrl = pathToFileURL(resolve(options.workspace, options.entry.module)).href;
      const script = [
        "import { writeFileSync } from 'node:fs';",
        `import { inspectVerifierEntry } from ${JSON.stringify(inspectUrl)};`,
        "let result;",
        "try {",
        `  const entry = await import(${JSON.stringify(entryUrl)});`,
        `  result = inspectVerifierEntry(entry[${JSON.stringify(options.entry.export)}]);`,
        "} catch { result = { passed: false, detail: 'could not load or inspect the copied verifier entry' }; }",
        "writeFileSync(3, JSON.stringify(result));",
      ].join("\n");
      return await new Promise<VerifierEntryInspection>((complete) => {
        const child = spawn(process.execPath, [
          "--experimental-permission",
          `--allow-fs-read=${options.workspace}`,
          `--allow-fs-write=${options.workspace}`,
          `--allow-fs-read=${fileURLToPath(import.meta.url)}`,
          `--allow-fs-read=${resolve(here, "../node_modules/@keystone/schemas")}`,
          ...["schemas", "kernel", "verifiers", "spawn"].map((name) =>
            `--allow-fs-read=${resolve(packages, name)}`),
          "--input-type=module", "--eval", script,
        ], {
          cwd: options.workspace,
          env: probeEnvironment(options.workspace),
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        let bytes = 0;
        let response = "";
        let failure: string | undefined;
        const kill = () => {
          if (child.pid === undefined) return;
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { child.kill("SIGKILL"); }
        };
        const timer = setTimeout(() => {
          failure = "verifier entry probe timed out";
          kill();
        }, limits.timeoutMs);
        const onAbort = () => { failure = "verifier entry probe cancelled"; kill(); };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        for (const [index, stream] of child.stdio.entries()) {
          if (index < 1 || stream === null || stream === undefined) continue;
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > limits.maxOutputBytes) {
              failure = "verifier entry probe exceeded its output limit";
              kill();
            } else if (index === 3) response += chunk.toString("utf8");
          });
        }
        child.on("error", () => { failure = "could not launch verifier entry probe"; });
        child.once("close", (code) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          // Kill any remaining group members before removing the workspace.
          kill();
          if (failure !== undefined || code !== 0) {
            complete({ passed: false, detail: failure ?? "verifier entry probe exited unsuccessfully" });
            return;
          }
          try {
            const result: unknown = JSON.parse(response);
            if (!isObject(result) || typeof result.passed !== "boolean" ||
                typeof result.detail !== "string" || result.detail.length > 1_500) {
              throw new Error("invalid result");
            }
            complete({ passed: result.passed, detail: result.detail });
          } catch {
            complete({ passed: false, detail: "verifier entry probe returned no valid inspection result" });
          }
        });
      });
    },
  };
}
