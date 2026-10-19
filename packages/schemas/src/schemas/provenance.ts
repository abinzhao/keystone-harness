/**
 * Provenance and trust.
 *
 * Every piece of information that can influence a task — repository content,
 * web pages, issues, tool output, plugins, model output, user statements, past
 * experience — carries a source kind and a trust level. Transformations
 * (summarisation, compression, caching, sub-agent return, skill output, format
 * conversion) must preserve them and may only *add* restrictions, never
 * silently upgrade trust (PRD 9.4, 11.2).
 */

import { provenanceIdValidator, isoTimestampValidator, snapshotIdValidator } from "./ids.ts";
import {
  arrayOf,
  defineSchema,
  enumOf,
  jsonValue,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

/**
 * Where a statement came from. Kept distinct on purpose: a web page and the
 * local repository must never be blurred together, even when their text is
 * identical (PRD 9.4).
 */
export const SOURCE_KINDS = [
  "repository",
  "user",
  "model",
  "tool",
  "verifier",
  "web",
  "issue",
  "extension",
  "experience",
  "imported_contract",
  "system",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Trust ladder. `untrusted` content can be read and reasoned about, but can
 * never become policy, a capability lease, a completion condition, or long-term
 * experience (PRD 9.4, 11.2).
 */
export const TRUST_LEVELS = [
  "untrusted",
  "observed",
  "verified",
  "user_confirmed",
  "authoritative",
] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

const TRUST_ORDER: Record<TrustLevel, number> = {
  untrusted: 0,
  observed: 1,
  verified: 2,
  user_confirmed: 3,
  authoritative: 4,
};

export function trustRank(level: TrustLevel): number {
  return TRUST_ORDER[level];
}

/**
 * Trust never increases along a derivation chain. A summariser may downgrade a
 * `verified` tool result to `observed` when it cannot guarantee fidelity, but
 * it may not promote untrusted web text to `observed`.
 */
export function effectiveTrust(derived: TrustLevel, upstream: readonly TrustLevel[]): TrustLevel {
  if (upstream.length === 0) return derived;
  let ceiling: TrustLevel = "authoritative";
  for (const level of upstream) {
    if (trustRank(level) < trustRank(ceiling)) ceiling = level;
  }
  return trustRank(derived) <= trustRank(ceiling) ? derived : ceiling;
}

export function isUntrusted(level: TrustLevel): boolean {
  return trustRank(level) < TRUST_ORDER.observed;
}

/**
 * Whether content at this trust level may influence authoritative decisions
 * (scope, completion conditions, leases, long-term experience).
 */
export function mayAuthorPolicy(level: TrustLevel): boolean {
  return trustRank(level) >= TRUST_ORDER.user_confirmed;
}

export const provenanceRefSchema = defineSchema(
  "keystone.provenance.ref",
  "1.0.0",
  objectOf({
    provenanceId: provenanceIdValidator,
    sourceKind: enumOf(SOURCE_KINDS),
    trustLevel: enumOf(TRUST_LEVELS),
    /** Human-readable locator, e.g. `src/auth/session.ts:42` or a URL host. */
    locator: str({ maxLength: 512 }),
    /** Snapshot the statement was observed against, when applicable. */
    applicableSnapshot: optional(snapshotIdValidator),
    /** Upstream records this one was derived from. */
    derivedFrom: arrayOf(provenanceIdValidator, { maxItems: 64 }),
    /** Conditions that invalidate the statement (PRD PI-04). */
    invalidatedBy: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    observedAt: isoTimestampValidator,
    /** Non-zero when the record was produced by a chain of transformations. */
    transformation: optional(str({ maxLength: 128 })),
    extended: optional(jsonValue()),
  }),
);

export type ProvenanceRef = InferSchema<typeof provenanceRefSchema>;
