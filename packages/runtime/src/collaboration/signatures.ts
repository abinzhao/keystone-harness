import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  arrayOf, bool, canonicalJson, contentHash, defineSchema, int, jsonValue, lit,
  nonEmptyStr, objectOf, optional, provenanceRefSchema, runEventSchema, sha256Hex, str,
  type InferSchema, type RunEvent,
} from "@keystone/schemas";

export const COLLABORATION_VERSION = "keystone.collaboration/1" as const;
const digest = str({ pattern: /^[0-9a-f]{64}$/ });
const timestamp = str({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ });
export const bindingSchema = defineSchema("keystone.collaboration.binding", "1.0.0", objectOf({
  purpose: nonEmptyStr(), taskId: nonEmptyStr(), contractDigest: digest,
  conditionIds: arrayOf(nonEmptyStr(), { maxItems: 256 }),
  environmentDigest: digest, issuedAt: timestamp, expiresAt: timestamp,
}));
export type SignatureBinding = InferSchema<typeof bindingSchema>;
export type ExpectedBinding = Omit<SignatureBinding, "issuedAt" | "expiresAt">;
export interface PeerIdentity { readonly identityId: string; readonly publicKey: string; readonly revoked: boolean }
const envelopeSchema = defineSchema("keystone.collaboration.signature", "1.0.0", objectOf({
  version: lit(COLLABORATION_VERSION), algorithm: lit("Ed25519"), identityId: nonEmptyStr(),
  publicKey: str({ maxLength: 1024 }), keyDigest: digest, documentDigest: digest,
  binding: bindingSchema.validator, signature: str({ pattern: /^[A-Za-z0-9+/]{86}==$/ }),
}));
export type SignatureEnvelope = InferSchema<typeof envelopeSchema>;
export interface SignedDocument { readonly document: unknown; readonly envelope: SignatureEnvelope }
const signedSchema = defineSchema("keystone.collaboration.signedDocument", "1.0.0", objectOf({
  document: jsonValue(), envelope: envelopeSchema.validator,
}));

/** Conservative export filter, not a guarantee that arbitrary source text contains no secrets. */
export function rejectSecrets(value: unknown): void {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error("document nesting limit");
    if (typeof item === "string" && /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(item)) {
      throw new Error("secret material is not portable");
    }
    if (typeof item === "string" &&
        /(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret)\s*[:=]\s*\S+|\bBearer\s+\S+|:\/\/[^/\s:@]+:[^/\s@]+@)/i.test(item)) {
      throw new Error("secret-shaped text is not portable");
    }
    if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (/^(?:password|passwd|token|accessToken|refreshToken|apiKey|secret|privateKey|credentials|authorization|cookie)$/i.test(key)) {
          throw new Error("secret fields are not portable");
        }
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}

/**
 * Run events use `task.started.payload.authorization` for a closed policy enum,
 * not an HTTP credential. Validate the event first, then exclude only that
 * protocol field from the generic arbitrary-document secret-key filter.
 */
export function rejectRunEventSecrets(value: unknown): RunEvent {
  const event = runEventSchema.parse(value) as RunEvent;
  if (event.type !== "task.started") {
    rejectSecrets(event);
    return event;
  }
  const { authorization, ...payload } = event.payload;
  if (!["policy_default", "user_approved_contract", "autonomy_credit"].includes(String(authorization))) {
    throw new Error("task authorization mode is not portable");
  }
  rejectSecrets({ ...event, payload });
  return event;
}

export function publicKeyDigest(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 key required");
  return sha256Hex(key.export({ type: "spki", format: "der" }).toString("hex"));
}

export function signDocument(
  document: unknown, binding: SignatureBinding, identityId: string, privateKey: KeyObject,
): SignedDocument {
  rejectSecrets(document);
  const parsed = bindingSchema.parse(binding);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 private key required");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const unsigned = {
    version: COLLABORATION_VERSION, algorithm: "Ed25519" as const, identityId, publicKey,
    keyDigest: publicKeyDigest(publicKey), documentDigest: contentHash(document), binding: parsed,
  };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64");
  return { document: JSON.parse(canonicalJson(document)), envelope: envelopeSchema.parse({ ...unsigned, signature }) };
}

export function verifyDocument(input: unknown, options: {
  readonly peers: readonly PeerIdentity[]; readonly expected: ExpectedBinding; readonly now?: Date;
}): { readonly ok: boolean; readonly authority: "integrity_only"; readonly reason?: string } {
  try {
    rejectSecrets(input);
    const { document, envelope } = signedSchema.parse(input);
    const peer = options.peers.find((entry) => entry.identityId === envelope.identityId);
    if (peer === undefined || peer.revoked) throw new Error("unknown or revoked identity");
    if (publicKeyDigest(peer.publicKey) !== envelope.keyDigest ||
        publicKeyDigest(envelope.publicKey) !== envelope.keyDigest) throw new Error("wrong identity key");
    const { issuedAt, expiresAt, ...bound } = envelope.binding;
    const at = (options.now ?? new Date()).getTime();
    if (!Number.isFinite(at) || !Number.isFinite(Date.parse(issuedAt)) || !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(issuedAt) > at || Date.parse(expiresAt) <= at || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw new Error("signature expired or not yet valid");
    }
    if (canonicalJson(bound) !== canonicalJson(options.expected)) throw new Error("signature binding mismatch");
    if (contentHash(document) !== envelope.documentDigest) throw new Error("document digest mismatch");
    const { signature, ...unsigned } = envelope;
    if (!verify(null, Buffer.from(canonicalJson(unsigned)), peer.publicKey, Buffer.from(signature, "base64"))) {
      throw new Error("invalid signature");
    }
    return { ok: true, authority: "integrity_only" };
  } catch {
    // Do not reflect imported data or parsing errors that might contain credentials.
    return { ok: false, authority: "integrity_only", reason: "signature, identity, digest or binding rejected" };
  }
}

export const sharedInputSchema = defineSchema("keystone.collaboration.shared", "1.0.0", objectOf({
  kind: str({ pattern: /^(fact|experience)$/ }), key: nonEmptyStr(), statement: str({ maxLength: 4000 }),
  source: provenanceRefSchema.validator, sourceIdentity: nonEmptyStr(), sourceDigest: digest,
}));
export type SharedInput = InferSchema<typeof sharedInputSchema>;

export const bundleManifestSchema = defineSchema("keystone.collaboration.bundle", "1.1.0", objectOf({
  version: lit("keystone.task-bundle/1"), taskId: nonEmptyStr(), branchId: nonEmptyStr(),
  environmentDigest: digest,
  includesRecoveryWorkspace: optional(bool()),
  ledger: objectOf({ path: nonEmptyStr(), sha256: digest, tipHash: digest, eventCount: int({ min: 1, max: 100_000 }) }),
  artifacts: arrayOf(objectOf({
    artifactId: str({ pattern: /^art_[0-9a-f]{64}$/ }), path: nonEmptyStr(), sha256: digest,
    bytes: int({ min: 0, max: 32 * 1024 * 1024 }),
  }), { maxItems: 4096 }),
}));
