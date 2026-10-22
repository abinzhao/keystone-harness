/**
 * The model- and tool-facing boundary: action proposals, descriptors,
 * intervention requests, and user decisions.
 *
 * The theme is one-directional authority. A model may *propose*; only the kernel
 * authorises. A user may *decide*; a model may not fabricate a decision — hence
 * `UserDecision.recordedBy` is a literal (PRD EX-01, HI-01..HI-03, 11.2).
 */

import {
  artifactIdValidator,
  branchIdValidator,
  decisionIdValidator,
  interventionIdValidator,
  leaseIdValidator,
  localIdValidator,
  proposalIdValidator,
  taskIdValidator,
  isoTimestampValidator,
} from "./ids.ts";
import { CAPABILITIES } from "./capability.ts";
import { INTERVENTION_TRIGGERS } from "./contract.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  int,
  lit,
  looseObject,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

export const ACTION_INTENTS = [
  "read",
  "search",
  "write",
  "delete",
  "execute",
  "network",
  "git",
  "ask_user",
  "finish",
] as const;
export type ActionIntent = (typeof ACTION_INTENTS)[number];

export const EFFECT_KINDS = [
  "file_create",
  "file_modify",
  "file_delete",
  "command",
  "network",
  "git",
  "none",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const REVERSIBILITY_CLASSES = ["reversible", "compensable", "irreversible"] as const;
export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

/**
 * What a model asks for. A proposal is inert: it has no effect until the kernel
 * checks scope, checks the envelope, and issues a lease (PRD EX-01, 9.5).
 *
 * `rationale` is a short stated intent, not chain-of-thought — chain-of-thought
 * is never stored as evidence or shown as a deliverable (PRD 4.4).
 */
export const actionProposalSchema = defineSchema(
  "keystone.agent.actionProposal",
  "1.0.0",
  objectOf({
    proposalId: proposalIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    /** Step this proposal belongs to, matching the Context Plan's stepId. */
    stepId: localIdValidator,
    at: isoTimestampValidator,

    modelRef: objectOf({
      id: nonEmptyStr(),
      provider: nonEmptyStr(),
      modelName: nonEmptyStr(),
    }),

    intent: enumOf(ACTION_INTENTS),
    tool: objectOf({
      id: nonEmptyStr(),
      version: nonEmptyStr(),
    }),
    /** Tool-specific arguments; validated by the tool's own input schema. */
    parameters: looseObject(),
    /** Short stated reason, safe to display. Not the model's hidden reasoning. */
    rationale: str({ maxLength: 2000 }),

    expectedEffects: arrayOf(
      objectOf({
        kind: enumOf(EFFECT_KINDS),
        target: nonEmptyStr(),
        description: str({ maxLength: 1000 }),
      }),
      { maxItems: 64 },
    ),
    reversibility: enumOf(REVERSIBILITY_CLASSES),
    /** Capabilities the model believes it needs. The kernel decides the rest. */
    requestedCapabilities: arrayOf(enumOf(CAPABILITIES), { maxItems: 16 }),
    /** Conditions this action is expected to produce evidence for. */
    producesEvidenceFor: arrayOf(localIdValidator, { maxItems: 32 }),
    /** Raw provider payload, kept for diagnostics only if policy allows. */
    rawOutputArtifactId: optional(artifactIdValidator),
  }),
);

export type ActionProposal = InferSchema<typeof actionProposalSchema>;

/**
 * A model endpoint Keystone can use. Credentials are referenced by handle; the
 * secret never appears here, in the ledger, or in a prompt (PRD ST-01, 11.3).
 *
 * v1.1.0 renames the capability block after ADR-0010: `tools -> nativeTools` and
 * `jsonMode -> structuredOutput`, and adds `multimodal`. A capability is declared
 * true only when the adapter implements it and a test proves the mapping — the
 * block is the contract, never an aspiration. `streaming`/`multimodal` are false
 * for every v1 adapter.
 */
export const modelDescriptorSchema = defineSchema(
  "keystone.agent.modelDescriptor",
  "1.2.0",
  objectOf({
    id: nonEmptyStr(),
    kind: enumOf(["cloud", "local"] as const),
    provider: nonEmptyStr(),
    modelName: nonEmptyStr(),
    /** Host only, so the user can see where data would go (PRD 11.4). */
    endpointHost: nonEmptyStr(),
    /**
     * Which provider wire protocol this adapter speaks. Drives capability
     * negotiation and the request/response mapping; see ADR-0010 §2.
     */
    protocol: enumOf([
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "gemini-generate",
      "trae-cli-exec",
    ] as const),
    capabilities: objectOf({
      /** Accepts provider-native tool definitions and returns structured calls. */
      nativeTools: bool(),
      /** Sends a provider-native constraint that the output be JSON/schema. */
      structuredOutput: bool(),
      /** Consumes a streaming response incrementally. v1: always false. */
      streaming: bool(),
      /** Accepts non-text content parts. v1: always false. */
      multimodal: bool(),
      contextTokens: int({ min: 1 }),
    }),
    credentialHandle: optional(nonEmptyStr()),
    dataEgress: objectOf({
      /** Classes that would be sent to this endpoint by default. */
      classes: arrayOf(enumOf(["public", "internal", "sensitive", "secret"] as const), {
        maxItems: 4,
      }),
      /** True when the endpoint is on the local machine or the user's network. */
      local: bool(),
    }),
  }),
);

export type ModelDescriptor = InferSchema<typeof modelDescriptorSchema>;

/**
 * A tool's declared contract. `idempotent` and `replayable` are not decoration:
 * the runner uses them to decide whether a retry is safe and whether a replay
 * of the run graph is meaningful (PRD PL-01, EX-04).
 */
export const toolDescriptorSchema = defineSchema(
  "keystone.agent.toolDescriptor",
  "1.0.0",
  objectOf({
    id: nonEmptyStr(),
    version: nonEmptyStr(),
    description: str({ maxLength: 2000 }),
    capabilities: arrayOf(enumOf(CAPABILITIES), { minItems: 1, maxItems: 16 }),
    sideEffects: arrayOf(enumOf(EFFECT_KINDS), { maxItems: 16 }),
    reversibility: enumOf(REVERSIBILITY_CLASSES),
    idempotent: bool(),
    replayable: bool(),
    /** Schema ids for the tool's arguments and result, resolved at call time. */
    inputSchemaId: nonEmptyStr(),
    outputSchemaId: nonEmptyStr(),
    /** Base timeout; a lease may shorten it but never lengthen it. */
    defaultTimeoutMs: int({ min: 1 }),
    maxOutputBytes: int({ min: 1 }),
  }),
);

export type ToolDescriptor = InferSchema<typeof toolDescriptorSchema>;

/**
 * Why the system stopped and what it wants. Every request must state what
 * happens if the user does nothing, and what the system would choose — an
 * intervention without a recommendation pushes the work back to the user
 * (PRD HI-01).
 */
export const interventionRequestSchema = defineSchema(
  "keystone.agent.interventionRequest",
  "1.0.0",
  objectOf({
    interventionId: interventionIdValidator,
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    at: isoTimestampValidator,
    trigger: enumOf(INTERVENTION_TRIGGERS),

    question: nonEmptyStr(),
    whyUserNeeded: nonEmptyStr(),
    ifIgnoredImpact: nonEmptyStr(),
    recommendedAction: objectOf({
      optionId: nonEmptyStr(),
      rationale: nonEmptyStr(),
    }),

    options: arrayOf(
      objectOf({
        optionId: nonEmptyStr(),
        label: nonEmptyStr(),
        /** What choosing this does to scope, budget and reversibility. */
        effectOnScope: str({ maxLength: 1000 }),
        effectOnBudget: str({ maxLength: 1000 }),
        /** Set when the option would widen the Autonomy Envelope. */
        widensEnvelope: bool(),
        /** Capabilities the option would unlock. */
        grants: arrayOf(enumOf(CAPABILITIES), { maxItems: 16 }),
      }),
      { minItems: 1, maxItems: 8 },
    ),

    /** Actions that are paused until this is resolved. */
    blockingActionRefs: arrayOf(localIdValidator, { maxItems: 64 }),
    /** Everything the user needs to decide, without opening a log file. */
    contextSummary: str({ maxLength: 4000 }),
    /** Evidence that raised the question, when there is any. */
    relatedEvidenceIds: arrayOf(nonEmptyStr(), { maxItems: 64 }),
  }),
);

export type InterventionRequest = InferSchema<typeof interventionRequestSchema>;

export const USER_DECISIONS = ["allow", "deny", "modify", "expire"] as const;
export type UserDecisionKind = (typeof USER_DECISIONS)[number];

/**
 * The record of a human decision. `recordedBy` is a literal `user`: a model,
 * extension or project file can never produce one, which is what makes
 * "a decision was made" trustworthy (PRD HI-03, 9.5, 11.2).
 */
export const userDecisionSchema = defineSchema(
  "keystone.agent.userDecision",
  "1.0.0",
  objectOf({
    decisionId: decisionIdValidator,
    interventionId: optional(interventionIdValidator),
    taskId: taskIdValidator,
    branchId: branchIdValidator,
    at: isoTimestampValidator,
    decision: enumOf(USER_DECISIONS),
    optionId: optional(nonEmptyStr()),
    /** Structured amendments the user made, e.g. a narrowed path list. */
    modifications: optional(looseObject()),
    rationale: str({ maxLength: 2000 }),

    /** What this decision authorises. Scope-limited and time-limited by design. */
    appliesTo: objectOf({
      capability: optional(enumOf(CAPABILITIES)),
      resources: arrayOf(nonEmptyStr(), { maxItems: 64 }),
      expiresAt: optional(isoTimestampValidator),
    }),
    /** Lease issued from this decision, when one was issued immediately. */
    issuedLeaseId: optional(leaseIdValidator),
    recordedBy: lit("user"),
  }),
);

export type UserDecision = InferSchema<typeof userDecisionSchema>;

/** True when a decision may still authorise a new lease. */
export function decisionIsLive(
  decision: UserDecision,
  now: Date,
): boolean {
  if (decision.decision !== "allow" && decision.decision !== "modify") return false;
  const expiresAt = decision.appliesTo.expiresAt;
  if (expiresAt === undefined) return true;
  return Date.parse(expiresAt) > now.getTime();
}
