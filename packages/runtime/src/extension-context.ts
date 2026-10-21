import {
  canonicalJson, contextPlanSchema, derivedIdBody, nowIso, provenanceRefSchema, sha256Hex,
  type ContextExclusion,
} from "@keystone/schemas";
import type { SkillContextFragment } from "@keystone/extensions";
import type { RuntimeExtensionObservation, RuntimeExtensionSkill, SkillLoadRequest } from "./extension-integration.ts";
import {
  ContextBudgetError, planContext,
  type InstructionCandidate, type PlanContextInput, type PlanContextResult,
} from "./context/planner.ts";

export interface ExtensionContextOptions {
  /** Includes identity, provenance and planner wrappers, not just frontmatter. */
  readonly metadataTokenBudget: number;
  /** Only explicit requests (or previously loaded text) disclose body/resources. */
  readonly requests?: readonly { readonly name: string; readonly request: SkillLoadRequest }[];
  /** Obtain through integration.contextObservations(), which rechecks lifecycle. */
  readonly observations?: readonly RuntimeExtensionObservation[];
}

export type ExtensionTaskInput = NonNullable<PlanContextInput["taskInputs"]>[number] & {
  readonly mandatory?: boolean;
};

export interface ExtensionContextResult extends PlanContextResult {
  readonly taskInputs: readonly ExtensionTaskInput[];
  readonly extensionAccounting: {
    readonly kind: "character_estimate";
    readonly metadataEstimatedTokens: number;
    readonly contentEstimatedTokens: number;
    readonly measuredTokens: null;
  };
}

/** Text stays data: no executable entry, command inference or trust promotion. */
export function skillInstructionCandidate(
  skill: RuntimeExtensionSkill, request: SkillLoadRequest, fragment: SkillContextFragment,
  observedAt: string = nowIso(),
): InstructionCandidate {
  const identity = canonicalJson([skill.name, skill.version, skill.reviewHash, request]);
  const content = canonicalJson({
    name: skill.name, version: skill.version, reviewHash: skill.reviewHash, request,
    sourcePath: skill.sourcePath, content: fragment.content,
  });
  const provenance = provenanceRefSchema.parse({
    provenanceId: `prov_${derivedIdBody(canonicalJson([identity, fragment.provenance, content]))}`,
    sourceKind: "extension", trustLevel: "untrusted", locator: fragment.provenance.source,
    derivedFrom: fragment.provenance.derivedFrom.map((source) => `prov_${derivedIdBody(source)}`),
    invalidatedBy: [
      `extension.unavailable:${skill.name}`, `extension.review.changed:${skill.name}`,
      `extension.source.changed:${fragment.provenance.source}`,
    ],
    observedAt,
    transformation: "skill-text-disclosure",
    extended: { sourcePath: skill.sourcePath, sourceDigest: fragment.provenance.digest,
      source: fragment.provenance.source, derivedFrom: fragment.provenance.derivedFrom,
      reviewHash: skill.reviewHash, request },
  });
  return {
    path: `extensions/skill-${sha256Hex(identity).slice(0, 32)}/${request.kind}.json`,
    scope: "**", content, sourceHash: sha256Hex(content), provenance,
  };
}

/**
 * Main's buildPlan can call this in place of planContext. Trial plans account
 * for the exact complete rendered capsule; extension text is optional here,
 * so a rejected disclosure cannot displace mandatory Contract/repository rules.
 * Ordinary FileCandidates and their provenance are passed through unchanged.
 */
export async function buildExtensionContext(
  input: PlanContextInput, skills: readonly RuntimeExtensionSkill[], options: ExtensionContextOptions,
): Promise<ExtensionContextResult> {
  if (!Number.isSafeInteger(options.metadataTokenBudget) || options.metadataTokenBudget < 0) {
    throw new RangeError("invalid Skill metadata token budget");
  }
  let taskInputs: ExtensionTaskInput[] = [...(input.taskInputs ?? [])];
  let result = planContext(input);
  const observedAt = input.now ?? result.plan.createdAt;
  const exclusions: ContextExclusion[] = [];
  const metadataRefs = new Set<string>();
  const contentRefs = new Set<string>();
  const reject = (ref: string, reason: string): void => {
    exclusions.push({ ref, reason, apparentRelevance: "medium" });
  };
  const tokensFor = (plan: PlanContextResult, refs: ReadonlySet<string>): number =>
    plan.plan.items.filter((item) => refs.has(item.ref)).reduce((total, item) => total + item.tokens, 0);
  const admitInput = (candidate: ExtensionTaskInput, metadata: boolean): void => {
    const nextInputs = [...taskInputs, candidate];
    let next: PlanContextResult;
    try { next = planContext({ ...input, taskInputs: nextInputs }); }
    catch (error) {
      if (!(error instanceof ContextBudgetError)) throw error;
      reject(candidate.ref, "Extension disclosure would exceed the complete rendered capsule budget");
      return;
    }
    if (!next.plan.items.some((item) => item.ref === candidate.ref)) {
      exclusions.push(...next.excluded.filter((item) => item.ref === candidate.ref));
      return;
    }
    const nextMetadata = new Set(metadataRefs);
    if (metadata) nextMetadata.add(candidate.ref);
    if (metadata && tokensFor(next, nextMetadata) > options.metadataTokenBudget) {
      reject(candidate.ref, "Skill metadata would exceed its explicit rendered metadata budget");
      return;
    }
    taskInputs = nextInputs;
    result = next;
    (metadata ? metadataRefs : contentRefs).add(candidate.ref);
  };
  const admit = (candidate: InstructionCandidate, metadata: boolean): void => {
    admitInput({ ref: candidate.path, content: candidate.content, provenance: candidate.provenance, mandatory: false }, metadata);
  };

  const names = new Set(skills.map((skill) => skill.name));
  for (const request of options.requests ?? []) {
    if (!names.has(request.name)) throw new Error("requested Skill is not assembled for this task");
  }
  for (const skill of [...skills].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    // Never reuse the assembly-time metadata after disable, upgrade or byte changes.
    const metadata = await skill.load({ kind: "metadata" });
    admit(skillInstructionCandidate(skill, { kind: "metadata" }, metadata, observedAt), true);
    const requests = [
      ...skill.loaded,
      ...(options.requests ?? []).filter((entry) => entry.name === skill.name).map((entry) => entry.request),
    ];
    const seen = new Set<string>();
    for (const request of requests) {
      const key = canonicalJson(request);
      if (request.kind === "metadata" || seen.has(key)) continue;
      seen.add(key);
      const fragment = await skill.load(request);
      admit(skillInstructionCandidate(skill, request, fragment, observedAt), false);
    }
  }
  for (const observation of options.observations ?? []) {
    admitInput({
      ref: `extension-output:${observation.proposalId}`,
      content: canonicalJson({ proposalId: observation.proposalId, tool: observation.tool,
        parameters: observation.parameters, result: observation.result }),
      provenance: provenanceRefSchema.parse({ ...observation.provenance, sourceKind: "extension", trustLevel: "untrusted" }),
      mandatory: false,
    }, false);
  }
  return {
    ...result,
    plan: contextPlanSchema.parse({ ...result.plan, exclusions: [...result.excluded, ...exclusions] }),
    excluded: [...result.excluded, ...exclusions], taskInputs,
    extensionAccounting: {
      kind: "character_estimate", metadataEstimatedTokens: tokensFor(result, metadataRefs),
      contentEstimatedTokens: tokensFor(result, contentRefs), measuredTokens: null,
    },
  };
}
