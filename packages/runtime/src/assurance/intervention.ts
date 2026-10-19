/**
 * When to ask the user, and what to ask.
 *
 * The product's promise is that routine work does not interrupt (PRD HI-02 lists
 * the only six reasons to ask). So this module is a *gate*, not a heuristic: each
 * trigger has an explicit condition, and an intervention is only built when one
 * of them applies.
 *
 * Every request it builds answers the four questions the PRD requires, without
 * the user having to open a log: why they are needed, what happens if they do
 * nothing, what the system recommends, and what each option would change.
 */

import {
  interventionRequestSchema,
  newId,
  nowIso,
  type Capability,
  type InterventionRequest,
  type InterventionTrigger,
  type OutcomeContract,
  type TaskStatus,
} from "@keystone/schemas";

import type { LeaseDenial } from "@keystone/kernel";

export interface InterventionAssessmentInput {
  readonly denial?: LeaseDenial;
  /** Capabilities the refused action wanted, so the options can name them. */
  readonly refusedCapabilities?: readonly Capability[];
  readonly refusedPaths?: readonly string[];
  readonly proposalReversibility?: "reversible" | "compensable" | "irreversible";
  readonly budgetExhausted?: boolean;
  readonly budgetExplanation?: string;
  readonly openUncertainties?: readonly { uncertaintyId: string; question: string; affects: string }[];
  readonly conflictingConstraints?: readonly string[];
  /** A verifier that could not decide, with no alternative available. */
  readonly undecidableReason?: string;
}

export interface InterventionAssessment {
  readonly needed: boolean;
  readonly trigger?: InterventionTrigger;
  readonly detail?: string;
}

/** Deterministic order: the most dangerous reason wins when several apply. */
export function assessInterventionNeed(
  input: InterventionAssessmentInput,
): InterventionAssessment {
  if (input.proposalReversibility === "irreversible") {
    return {
      needed: true,
      trigger: "irreversible_action",
      detail: "the proposed action cannot be undone",
    };
  }

  const denial = input.denial;
  if (denial !== undefined) {
    switch (denial.code) {
      case "out_of_contract_scope":
        return {
          needed: true,
          trigger: "scope_expansion",
          detail: denial.detail,
        };
      case "capability_outside_envelope":
      case "command_not_permitted":
      case "network_host_not_permitted":
      case "credential_not_permitted":
      case "external_system_not_permitted":
        return {
          needed: true,
          trigger: "scope_expansion",
          detail: denial.detail,
        };
      case "untrusted_content_cannot_authorize":
        return {
          needed: true,
          trigger: "conflicting_constraints",
          detail: denial.detail,
        };
      case "irreversible_requires_confirmation":
        return {
          needed: true,
          trigger: "irreversible_action",
          detail: denial.detail,
        };
      default:
        break;
    }
  }

  if (input.conflictingConstraints !== undefined && input.conflictingConstraints.length > 0) {
    return {
      needed: true,
      trigger: "conflicting_constraints",
      detail: input.conflictingConstraints.join("; "),
    };
  }

  if (input.openUncertainties !== undefined && input.openUncertainties.length > 0) {
    const first = input.openUncertainties[0];
    return {
      needed: true,
      trigger: "ambiguity",
      detail: `${String(first?.question)} (affects ${String(first?.affects)})`,
    };
  }

  if (input.budgetExhausted === true) {
    return {
      needed: true,
      trigger: "budget_exhausted",
      detail: input.budgetExplanation ?? "the task budget is exhausted",
    };
  }

  if (input.undecidableReason !== undefined) {
    return {
      needed: true,
      trigger: "undecidable",
      detail: input.undecidableReason,
    };
  }

  return { needed: false };
}

export interface BuildInterventionInput {
  readonly taskId: string;
  readonly branchId: string;
  readonly trigger: InterventionTrigger;
  readonly contract: OutcomeContract;
  readonly question: string;
  readonly whyUserNeeded: string;
  readonly ifIgnoredImpact: string;
  /** The option the system would choose, and why. */
  readonly recommended: { readonly label: string; readonly rationale: string };
  /** Additional options beyond the recommendation. */
  readonly alternatives?: readonly {
    readonly label: string;
    readonly effectOnScope: string;
    readonly effectOnBudget: string;
    readonly widensEnvelope: boolean;
    readonly grants?: readonly Capability[];
  }[];
  readonly blockingActionRefs?: readonly string[];
  readonly contextSummary: string;
  readonly relatedEvidenceIds?: readonly string[];
}

export function buildInterventionRequest(input: BuildInterventionInput): InterventionRequest {
  const recommendedId = "opt.recommended";
  const options = [
    {
      optionId: recommendedId,
      label: input.recommended.label,
      effectOnScope: "as recommended by the system",
      effectOnBudget: "no change beyond the current budget",
      widensEnvelope: input.trigger === "scope_expansion",
      grants: [] as readonly Capability[],
    },
    ...(input.alternatives ?? []).map((alternative, index) => ({
      optionId: `opt.alt${index + 1}`,
      label: alternative.label,
      effectOnScope: alternative.effectOnScope,
      effectOnBudget: alternative.effectOnBudget,
      widensEnvelope: alternative.widensEnvelope,
      grants: alternative.grants ?? ([] as readonly Capability[]),
    })),
  ];

  return interventionRequestSchema.parse({
    interventionId: newId("intr"),
    taskId: input.taskId,
    branchId: input.branchId,
    at: nowIso(),
    trigger: input.trigger,
    question: input.question,
    whyUserNeeded: input.whyUserNeeded,
    ifIgnoredImpact: input.ifIgnoredImpact,
    recommendedAction: { optionId: recommendedId, rationale: input.recommended.rationale },
    options,
    blockingActionRefs: [...(input.blockingActionRefs ?? [])],
    contextSummary: input.contextSummary,
    relatedEvidenceIds: [...(input.relatedEvidenceIds ?? [])],
  }) as InterventionRequest;
}

/** Turn a lease refusal into a ready-to-show request, including the cost of saying no. */
export function interventionForDenial(options: {
  readonly taskId: string;
  readonly branchId: string;
  readonly contract: OutcomeContract;
  readonly denial: LeaseDenial;
  readonly refusedCapabilities: readonly Capability[];
  readonly refusedPaths: readonly string[];
  readonly blockingActionRefs?: readonly string[];
  readonly contextSummary: string;
}): InterventionRequest | undefined {
  const assessment = assessInterventionNeed({
    denial: options.denial,
    refusedCapabilities: options.refusedCapabilities,
    refusedPaths: options.refusedPaths,
  });
  if (!assessment.needed || assessment.trigger === undefined) return undefined;

  const target =
    options.refusedPaths.length > 0
      ? options.refusedPaths.join(", ")
      : options.refusedCapabilities.join(", ");

  return buildInterventionRequest({
    taskId: options.taskId,
    branchId: options.branchId,
    trigger: assessment.trigger,
    contract: options.contract,
    question: `Keystone needs to ${target} to continue, which is outside what this task is allowed to touch. Allow it?`,
    whyUserNeeded: options.denial.detail,
    ifIgnoredImpact: `the task will stop or look for an alternative that keeps ${options.contract.goal} achievable without this change`,
    recommended: {
      label: `Allow ${target}`,
      rationale: options.denial.suggestedOption ?? "this is the smallest change that unblocks the task",
    },
    alternatives: [
      {
        label: "Find an alternative inside the current scope",
        effectOnScope: `no change; Keystone will stay within ${options.contract.scope.include.length} declared pattern(s)`,
        effectOnBudget: "may consume additional retries",
        widensEnvelope: false,
      },
      {
        label: "Stop and hand back what has been verified so far",
        effectOnScope: "no change",
        effectOnBudget: "stops spending immediately",
        widensEnvelope: false,
      },
    ],
    ...(options.blockingActionRefs === undefined
      ? {}
      : { blockingActionRefs: options.blockingActionRefs }),
    contextSummary: options.contextSummary,
  });
}

/**
 * What the user's decision does to the task. Returning this separately keeps the
 * "allow once" from being silently interpreted as "allow always" (PRD HI-03).
 */
export interface DecisionEffect {
  readonly scopeWidened: boolean;
  readonly envelopeWidened: boolean;
  readonly resumeStatus: TaskStatus;
  readonly note: string;
}

export function decisionEffect(options: {
  readonly decision: "allow" | "deny" | "modify" | "expire";
  readonly widensEnvelope: boolean;
}): DecisionEffect {
  switch (options.decision) {
    case "allow":
      return {
        scopeWidened: true,
        envelopeWidened: options.widensEnvelope,
        resumeStatus: "executing",
        note: options.widensEnvelope
          ? "the project boundary was widened by this decision and the widening is recorded against it"
          : "the task scope was extended for this task only",
      };
    case "modify":
      return {
        scopeWidened: true,
        envelopeWidened: false,
        resumeStatus: "executing",
        note: "the decision was amended; Keystone continues with the amended constraints",
      };
    case "deny":
      return {
        scopeWidened: false,
        envelopeWidened: false,
        resumeStatus: "executing",
        note: "the refusal is recorded and Keystone will look for a path that does not need this permission",
      };
    case "expire":
      return {
        scopeWidened: false,
        envelopeWidened: false,
        resumeStatus: "needs_attention",
        note: "the request expired without a decision",
      };
  }
}
