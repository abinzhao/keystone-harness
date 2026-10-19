/**
 * Run modes and honest degradation.
 *
 * The rule this module exists to enforce is narrow and non-negotiable: a
 * degraded run must say what it lost and what that does to its evidence. Silently
 * continuing in a weaker mode and then claiming the same level of proof is the
 * single most damaging thing a harness can do (PRD EX-05, 9.1).
 */

import type { Capability } from "@keystone/schemas";

export type RunMode = "minimal" | "standard" | "isolated" | "replay";

export interface ModeCapabilities {
  readonly mode: RunMode;
  /** Components of the harness that are available in this mode. */
  readonly usesProjectCognition: boolean;
  readonly usesContextPlanning: boolean;
  readonly usesExperience: boolean;
  readonly usesModel: boolean;
  readonly usesIsolation: boolean;
  readonly usesReplayOnly: boolean;
  /** Highest evidence level this mode can produce on its own. */
  readonly maxEvidenceLevel: "E1" | "E2" | "E3" | "E4";
  readonly description: string;
}

const MODES: Record<RunMode, ModeCapabilities> = {
  minimal: {
    mode: "minimal",
    usesProjectCognition: false,
    usesContextPlanning: false,
    usesExperience: false,
    usesModel: false,
    usesIsolation: false,
    usesReplayOnly: false,
    // Deterministic checks only: no independent re-check, no external proof.
    maxEvidenceLevel: "E2",
    description:
      "basic file access, stand-alone commands and deterministic verification; " +
      "no project cognition, no experience, no model",
  },
  standard: {
    mode: "standard",
    usesProjectCognition: true,
    usesContextPlanning: true,
    usesExperience: true,
    usesModel: true,
    usesIsolation: false,
    usesReplayOnly: false,
    maxEvidenceLevel: "E3",
    description: "project cognition, context planning, tools, verification and experience",
  },
  isolated: {
    mode: "isolated",
    usesProjectCognition: true,
    usesContextPlanning: true,
    usesExperience: true,
    usesModel: true,
    usesIsolation: true,
    usesReplayOnly: false,
    maxEvidenceLevel: "E3",
    description: "as standard, in a workspace separated from the user's working copy",
  },
  replay: {
    mode: "replay",
    usesProjectCognition: true,
    usesContextPlanning: false,
    usesExperience: false,
    usesModel: false,
    usesIsolation: false,
    usesReplayOnly: true,
    maxEvidenceLevel: "E2",
    description: "re-executes recorded state, verification or execution; performs no new work",
  },
};

export function modeCapabilities(mode: RunMode): ModeCapabilities {
  return MODES[mode];
}

export interface DegradationRequest {
  readonly from: RunMode;
  readonly to: RunMode;
  readonly reason: string;
  readonly lostCapabilities: readonly Capability[];
}

export interface DegradationDecision {
  readonly allowed: boolean;
  /** How the loss changes what the task can still prove. Null when nothing is lost. */
  readonly evidenceImpact: string | null;
  readonly explanation: string;
}

/**
 * Judge whether a mode change is safe.
 *
 * `replay` and `minimal` cannot produce external proof, so downgrading into them
 * while the contract requires E4 is a refusal, not a warning — the task would
 * otherwise "finish" with weaker evidence than it promised.
 */
export function evaluateDegradation(
  request: DegradationRequest,
  options: { readonly requiredEvidenceLevel: string },
): DegradationDecision {
  const from = modeCapabilities(request.from);
  const to = modeCapabilities(request.to);

  if (rank(to.maxEvidenceLevel) >= rank(from.maxEvidenceLevel)) {
    return {
      allowed: true,
      evidenceImpact: null,
      explanation: `switching to ${to.mode} (${to.description}) does not reduce the evidence ceiling`,
    };
  }

  const impact =
    `evidence ceiling drops from ${from.maxEvidenceLevel} to ${to.maxEvidenceLevel}: ` +
    `${request.lostCapabilities.length === 0 ? "no capability" : request.lostCapabilities.join(", ")} ` +
    "is no longer available, so conditions requiring a higher level cannot be satisfied in this mode";

  if (rank(to.maxEvidenceLevel) < rank(options.requiredEvidenceLevel)) {
    return {
      allowed: false,
      evidenceImpact: impact,
      explanation:
        `cannot degrade to ${to.mode}: the contract requires ${options.requiredEvidenceLevel} evidence, ` +
        `but ${to.mode} can produce at most ${to.maxEvidenceLevel}. ` +
        "The task must be reported as needing attention rather than completed with weaker proof.",
    };
  }

  return { allowed: true, evidenceImpact: impact, explanation: impact };
}

function rank(level: string): number {
  switch (level) {
    case "E0":
      return 0;
    case "E1":
      return 1;
    case "E2":
      return 2;
    case "E3":
      return 3;
    case "E4":
      return 4;
    default:
      return 0;
  }
}

/** Components that can keep working when every third-party extension is gone. */
export function minimalRuntimeAvailable(available: readonly Capability[]): boolean {
  return available.includes("fs.read") && available.includes("cmd.exec");
}
