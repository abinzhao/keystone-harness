/**
 * Provenance records and trust propagation.
 *
 * Every derived artifact (summary, cache entry, sub-agent return, Skill output,
 * Evidence, Proof) must keep the source and trust of what it came from, and a
 * transformation may only *add* restrictions, never silently upgrade trust
 * (PRD 9.4, 11.2; kernel invariant 4). The rules are implemented here so that
 * "where did this come from, and can it still be trusted?" has one answer.
 */

import {
  effectiveTrust,
  newId,
  nowIso,
  provenanceRefSchema,
  type IsoTimestamp,
  type ProvenanceRef,
  type SourceKind,
  type TrustLevel,
} from "@keystone/schemas";

export interface CreateProvenanceInput {
  readonly sourceKind: SourceKind;
  readonly trustLevel: TrustLevel;
  readonly locator: string;
  readonly applicableSnapshot?: string;
  readonly derivedFrom?: readonly ProvenanceRef[];
  readonly invalidatedBy?: readonly string[];
  readonly transformation?: string;
  readonly observedAt: IsoTimestamp;
}

/**
 * Create a first-hand provenance record. Constructed through the schema so the
 * branded `provenanceId` and the enum members are validated at creation time
 * rather than trusted later.
 */
export function createProvenance(input: CreateProvenanceInput): ProvenanceRef {
  const derivedFrom = dedupeSorted((input.derivedFrom ?? []).map((parent) => parent.provenanceId));
  return provenanceRefSchema.parse({
    provenanceId: newId("prov"),
    sourceKind: input.sourceKind,
    trustLevel: input.trustLevel,
    locator: input.locator,
    ...(input.applicableSnapshot === undefined
      ? {}
      : { applicableSnapshot: input.applicableSnapshot }),
    derivedFrom,
    invalidatedBy: mergeInvalidators(input.invalidatedBy ?? []),
    ...(input.transformation === undefined ? {} : { transformation: input.transformation }),
    observedAt: input.observedAt,
  }) as ProvenanceRef;
}

export interface DeriveProvenanceInput {
  readonly sourceKind: SourceKind;
  readonly locator: string;
  readonly transformation: string;
  readonly trustLevel?: TrustLevel;
  readonly invalidatedBy?: readonly string[];
}

/**
 * Derive a record from one or more parents.
 *
 * Trust can only fall: the result is `effectiveTrust(requested, parentLevels)`,
 * so a summary of an `untrusted` web page can never come out `verified`. An
 * omitted `trustLevel` is treated as "as high as allowed", i.e. the minimum of
 * the parents — never higher than what it was derived from.
 */
export function deriveProvenance(
  parents: readonly ProvenanceRef[],
  input: DeriveProvenanceInput,
): ProvenanceRef {
  const requested: TrustLevel = input.trustLevel ?? "authoritative";
  const trustLevel = effectiveTrust(
    requested,
    parents.map((parent) => parent.trustLevel),
  );
  const applicableSnapshot = consistentSnapshot(parents);

  return provenanceRefSchema.parse({
    provenanceId: newId("prov"),
    sourceKind: input.sourceKind,
    trustLevel,
    locator: input.locator,
    ...(applicableSnapshot === undefined ? {} : { applicableSnapshot }),
    derivedFrom: dedupeSorted(parents.map((parent) => parent.provenanceId)),
    invalidatedBy: mergeInvalidators(
      ...parents.map((parent) => parent.invalidatedBy),
      input.invalidatedBy ?? [],
    ),
    observedAt: nowIso(),
    transformation: input.transformation,
  }) as ProvenanceRef;
}

/** Union of invalidation tokens, de-duplicated and sorted for stable hashes. */
export function mergeInvalidators(...lists: readonly (readonly string[])[]): string[] {
  const merged = new Set<string>();
  for (const list of lists) {
    for (const token of list) {
      if (token !== "") merged.add(token);
    }
  }
  return [...merged].sort();
}

/**
 * A record is poisoned when it is untrusted or has been invalidated. Poisoned
 * content may still be reasoned about, but may not become policy, a capability
 * lease, a completion condition, or long-term experience (PRD 9.4).
 */
export function isPoisoned(record: ProvenanceRef): boolean {
  return record.trustLevel === "untrusted" || record.invalidatedBy.length > 0;
}

/**
 * The snapshot a derived record applies to: the single snapshot shared by all
 * parents that named one. Disagreement (two different snapshots) means the
 * derivation spans snapshot boundaries, so no single snapshot can be claimed.
 */
function consistentSnapshot(parents: readonly ProvenanceRef[]): string | undefined {
  const snapshots = new Set<string>();
  for (const parent of parents) {
    if (parent.applicableSnapshot !== undefined) snapshots.add(parent.applicableSnapshot);
  }
  if (snapshots.size !== 1) return undefined;
  return [...snapshots][0];
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
