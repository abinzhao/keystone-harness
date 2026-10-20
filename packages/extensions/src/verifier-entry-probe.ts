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
 * The kit does not know how to load a `.ts` entry in this host, so the host
 * supplies a `loadEntry` function. That keeps this module side-effect-free and
 * generic — it is not tied to any single extension.
 */

import { EVIDENCE_LEVELS, VERIFIER_KINDS, levelCanStandAlone } from "@keystone/schemas";
import type { EvidenceLevel, VerifierKind } from "@keystone/schemas";

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
